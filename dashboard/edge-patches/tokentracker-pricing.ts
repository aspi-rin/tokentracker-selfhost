import { billingUserId } from "./cloud/auth.ts";
import { BillingError } from "./cloud/contracts.ts";
import { loadPricing, refreshPricing, publishPricing } from "./cloud/pricing.ts";
const cors = {"Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:cors});
export default async function(req:Request):Promise<Response>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(!['GET','POST'].includes(req.method))return json({error:'method_not_allowed'},405);
  try{
    if(req.method==='GET')return json(await loadPricing());
    const user=await billingUserId(req.headers.get('authorization'),{jwtSecret:Deno.env.get('JWT_SECRET'),jwtPublicKey:Deno.env.get('JWT_PUBLIC_KEY')});
    const owner=Deno.env.get('TOKENTRACKER_OWNER_ID');
    if(!owner)return json({error:'owner_not_configured'},503);
    if(user!==owner)return json({error:'forbidden'},403);
    const text=await req.text();if(text.length>12*1024*1024)return json({error:'catalog_too_large'},413);
    let body:any;
    try{body=text?JSON.parse(text):{};}catch{return json({error:'invalid_catalog'},400);}
    if(body.catalog){
      try{return json(await publishPricing(body.catalog,body.expectedVersion));}
      catch(error){return json({error:error instanceof Error && error.message==='catalog_changed'?'catalog_changed':'invalid_catalog'},error instanceof Error && error.message==='catalog_changed'?409:400);}
    }
    return json(await refreshPricing(true));
  }catch(error){return error instanceof BillingError?json({error:error.code},error.status):json({error:'pricing_update_unavailable'},503);}
}
