import { createClient } from "npm:@insforge/sdk";
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"}});
export default async function(req:Request):Promise<Response>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*"}});
  if(req.method!=='GET')return json({error:'method_not_allowed'},405);
  if(Deno.env.get('TOKENTRACKER_PUBLIC_PROFILES_ENABLED')!=='1')return json({error:'not_found'},404);
  const owner=Deno.env.get('TOKENTRACKER_OWNER_ID');
  if(!owner || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner))return json({error:'not_found'},404);
  const client=createClient({baseUrl:Deno.env.get('INSFORGE_BASE_URL')!,edgeFunctionToken:Deno.env.get('INSFORGE_SERVICE_ROLE_KEY'),anonKey:Deno.env.get('ANON_KEY')});
  const {data,error}=await client.database.from('tokentracker_user_settings').select('user_id').eq('user_id',owner).eq('leaderboard_public',true).maybeSingle();
  if(error)return json({error:'profile_unavailable'},503);
  return data?json({user_id:data.user_id}):json({error:'not_found'},404);
}
