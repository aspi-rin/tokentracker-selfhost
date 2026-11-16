import { createClient } from "npm:@insforge/sdk";
import { computeRowCost, fetchDailyGroupedRows, windowBoundsForPeriod } from "./tokentracker-leaderboard-profile.ts";

const sourceColumns: Record<string,string> = {
  antigravity:"antigravity_tokens",codex:"gpt_tokens",claude:"claude_tokens",gemini:"gemini_tokens",cursor:"cursor_tokens",
  opencode:"opencode_tokens",openclaw:"openclaw_tokens",hermes:"hermes_tokens",kiro:"kiro_tokens",
  copilot:"copilot_tokens","pi-github-copilot":"copilot_tokens","pi-copilot":"copilot_tokens",
  "pi-anthropic":"claude_tokens",kimi:"kimi_tokens",
};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
export default async function(req:Request):Promise<Response>{
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  if(Deno.env.get("TOKENTRACKER_PUBLIC_PROFILES_ENABLED")!=="1")return json({error:"Not found"},404);
  const secret=Deno.env.get("TOKENTRACKER_PUBLIC_REFRESH_SECRET");
  if(!secret||secret.length<32)return json({error:"Refresh secret is not configured"},503);
  if(req.headers.get("Authorization")!=="Bearer "+secret)return json({error:"Unauthorized"},401);
  const client=createClient({baseUrl:Deno.env.get("INSFORGE_BASE_URL")!,edgeFunctionToken:Deno.env.get("INSFORGE_SERVICE_ROLE_KEY"),anonKey:Deno.env.get("ANON_KEY")});
  try{
    const users:Array<{user_id:string}>=[];
    for(let offset=0;;offset+=100){
      const {data,error}=await client.database.from("tokentracker_user_settings").select("user_id").eq("leaderboard_public",true).order("user_id").range(offset,offset+99);
      if(error)throw Error("Consent lookup failed");
      users.push(...(data||[]) as Array<{user_id:string}>);
      if(!data||data.length<100)break;
      if(users.length>=1000)throw Error("Public instance user limit exceeded");
    }
    const generated=new Date(),today=generated.toISOString().slice(0,10),periods=[];
    for(const period of ["week","month","total"]){
      const bounds=period==="total"?{from_day:"1970-01-01",to_day:today}:windowBoundsForPeriod(period,today);
      const until=new Date(bounds.to_day+"T00:00:00Z");until.setUTCDate(until.getUTCDate()+1);
      const rows=[];
      for(const user of users){
        const groups=await fetchDailyGroupedRows(client,user.user_id,bounds.from_day+"T00:00:00Z",until.toISOString(),"UTC",0);
        const row:Record<string,string|number>={user_id:user.user_id,total_tokens:0,estimated_cost_usd:0};
        for(const group of groups){
          const n=Number(group.total_tokens)||0,column=sourceColumns[group.source]||"other_tokens";
          row[column]=Number(row[column]||0)+n;row.total_tokens=Number(row.total_tokens)+n;
          row.estimated_cost_usd=Number(row.estimated_cost_usd)+computeRowCost(group);
        }
        if(Number(row.total_tokens)>0)rows.push(row);
      }
      // SQL rechecks current consent while holding the same lock as opt-out.
      const {data,error}=await client.database.rpc("self_host_publish_snapshots",{p_period:period,p_from:bounds.from_day,p_to:bounds.to_day,p_rows:rows,p_generated_at:generated.toISOString()});
      if(error)throw Error("Publication failed");
      periods.push({period,...data as Record<string,unknown>});
    }
    return json({ok:true,periods,generated_at:generated.toISOString()});
  }catch{return json({error:"Public snapshot refresh failed"},500);}
}
