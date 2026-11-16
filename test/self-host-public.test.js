const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./helpers/self-host-fixture.cjs');
let instance;
test.before(async()=>{instance=await fixture({publicProfiles:true});});
test.after(async()=>{await instance?.close();});
test.beforeEach(async()=>{await instance.db.query('DELETE FROM auth.users');});
const visibility=(owner,body)=>instance.request('tokentracker-public-visibility',body,owner);
const refresh=()=>instance.request('tokentracker-self-host-leaderboard-refresh',{},instance.env.TOKENTRACKER_PUBLIC_REFRESH_SECRET);
const profile=owner=>instance.request('tokentracker-leaderboard-profile?user_id='+owner+'&period=total');
async function upload(owner,n){
 const device=await instance.request('tokentracker-device-token-issue',{device_name:'Public fixture',platform:'test',machine_id:randomUUID()},owner);
 assert.equal(device.response.status,200);
 const r=await instance.request('tokentracker-ingest',{buckets:[{hour_start:new Date().toISOString().slice(0,13)+':00:00Z',source:'codex',model:'unpriced-fixture',input_tokens:n,output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0,total_tokens:n,billable_total_tokens:n,total_cost_usd:0,conversation_count:1}]},device.data.token);
 assert.equal(r.response.status,200);
}
test('public publishing requires verified user identity; anonymous defaults remain private',async()=>{
 assert.equal((await visibility(undefined,{enabled:true})).response.status,401);
 const owner=await instance.user();await upload(owner,123);
 assert.equal((await visibility(owner)).data.enabled,false);
 assert.equal((await refresh()).response.status,200);
 assert.equal((await profile(owner)).response.status,404);
 const list=await instance.request('tokentracker-leaderboard?period=total');
 assert.equal(list.response.status,200);assert.equal(list.data.entries.length,0);
});
test('only opted-in owners publish; disabling immediately hides stale and delayed snapshots',async()=>{
 const owner=await instance.user(),other=await instance.user();await upload(owner,123);await upload(other,999);
 assert.equal((await visibility(owner,{enabled:true,display_name:'Synthetic public'})).response.status,200);
 assert.equal((await refresh()).response.status,200);
 const list=await instance.request('tokentracker-leaderboard?period=total');
 assert.deepEqual(list.data.entries.map(x=>x.user_id),[owner]);assert.equal(Number(list.data.entries[0].total_tokens),123);
 assert.equal((await profile(other)).response.status,404);
 assert.equal((await profile(owner)).data.totals.total_tokens,123);
 const saved=(await instance.db.query('SELECT * FROM tokentracker_leaderboard_snapshots WHERE user_id=$1',[owner])).rows;
 assert.equal((await visibility(owner,{enabled:false})).response.status,200);
 assert.equal((await profile(owner)).response.status,404);
 // A delayed writer carries an earlier aggregation; the publish RPC rechecks consent.
 const row=saved.find(x=>x.period==='total');
 await instance.db.query('SELECT self_host_publish_snapshots($1,$2,$3,$4::jsonb,$5)',[row.period,row.from_day,row.to_day,JSON.stringify([row]),new Date().toISOString()]);
 assert.equal((await instance.db.query('SELECT count(*)::int n FROM tokentracker_leaderboard_snapshots')).rows[0].n,0);
 assert.equal((await instance.request('tokentracker-leaderboard?period=total')).data.entries.length,0);
 // Even a stale row inserted by a privileged administrator cannot bypass a live consent read.
 await instance.db.query('INSERT INTO tokentracker_leaderboard_snapshots(user_id,period,from_day,to_day,rank,total_tokens,is_public) VALUES($1,$2,$3,$4,1,123,true)',[owner,row.period,row.from_day,row.to_day]);
 assert.equal((await instance.request('tokentracker-leaderboard?period=total')).data.entries.length,0);
 assert.equal((await profile(owner)).response.status,404);
});
test('private aggregation and public metadata mutation remain inaccessible to client DB roles',async()=>{
 const owner=await instance.user();
 for(const role of ['anon','authenticated']){
  for(const signature of ['public.self_host_set_public_profile(uuid,jsonb)','public.self_host_publish_snapshots(text,date,date,jsonb,timestamp with time zone)']) {
   const result=await instance.db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,signature]);
   assert.equal(result.rows[0].allowed,false,role+' must lack EXECUTE on '+signature);
  }
  await assert.rejects(instance.db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query('SELECT * FROM tokentracker_hourly');}));
  await assert.rejects(instance.db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query('SELECT self_host_set_public_profile($1,$2::jsonb)',[owner,'{"enabled":true}']);}));
 }
 assert.equal((await instance.request('tokentracker-self-host-leaderboard-refresh',{},instance.token(owner))).response.status,401);
 assert.equal((await instance.request('tokentracker-self-host-leaderboard-refresh',{},instance.token(owner,'anon'))).response.status,401);
});

test('only the signed-in owner changes consent; malformed, expired and anonymous claims fail',async()=>{
 const owner=await instance.user(),other=await instance.user();
 for(const token of [instance.token(owner,'anon'),instance.token(owner,'service_role'),instance.token(owner,'authenticated',1),'forged.payload.signature']){
  assert.equal((await visibility(token,{enabled:true})).response.status,401);
  assert.equal((await instance.request('tokentracker-leaderboard-profile?user_id='+owner,undefined,token)).response.status,404);
 }
 assert.equal((await visibility(owner,{enabled:'true'})).response.status,400);
 assert.equal((await visibility(owner,{enabled:true,user_id:other})).response.status,200);
 assert.equal((await visibility(other)).data.enabled,false);
 assert.equal((await visibility(owner)).data.enabled,true);
});
test('anonymous publication masks identities and opt-out blocks cached readers',async()=>{
 const owner=await instance.user();await upload(owner,321);
 await visibility(owner,{enabled:true,anonymous:true,display_name:'Secret synthetic name',github_url:'synthetic',show_github_url:true});
 await refresh();
 const list=await instance.request('tokentracker-leaderboard?period=total');
 assert.equal(list.data.entries[0].display_name,'Anonymous');
 assert.equal(list.data.entries[0].github_url,null);
 const details=await profile(owner);
 assert.equal(details.data.user.display_name,'Anonymous');assert.equal(details.data.user.github_url,null);
 assert.equal(details.response.headers.get('cache-control'),'no-store');
 await visibility(owner,{enabled:false});
 assert.equal((await profile(owner)).response.status,404);
 // The owner keeps private profile access after opting out.
 assert.equal((await instance.request('tokentracker-leaderboard-profile?user_id='+owner+'&view=badges',undefined,owner)).response.status,200);
});
test('public tables and views deny client roles; addon reinstall preserves consent and free policy',async()=>{
 const owner=await instance.user();await visibility(owner,{enabled:true});
 for(const role of ['anon','authenticated'])for(const table of ['tokentracker_user_settings','tokentracker_user_profiles','tokentracker_leaderboard_snapshots','tokentracker_public_leaderboard']){
  await assert.rejects(instance.db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query('SELECT * FROM '+table);}));
 }
 await require('../scripts/self-host/install-public.cjs').install(instance.db);
 assert.equal((await visibility(owner)).data.enabled,true);
 assert.equal((await instance.db.query('SELECT hosting_mode FROM tokentracker_cloud_policy')).rows[0].hosting_mode,'self_hosted');
});
test('generated public handlers fail closed when the feature flag is removed',async()=>{
 const owner=await instance.user();
 delete instance.env.TOKENTRACKER_PUBLIC_PROFILES_ENABLED;
 try{
  for(const slug of ['tokentracker-public-visibility','tokentracker-leaderboard','tokentracker-leaderboard-profile'])
   assert.equal((await instance.request(slug,undefined,owner)).response.status,503);
 }finally{instance.env.TOKENTRACKER_PUBLIC_PROFILES_ENABLED='1';}
});
test('generated standalone addon SQL installs atomically and repeats with the same ledger entry',async()=>{
 const db=await require('./helpers/self-host-fixture.cjs').platform();
 try{
  await require('../scripts/self-host/install.cjs').install(db);
  const sql=require('../scripts/self-host/install-public.cjs').buildSql();
  await db.exec(sql);
  const before=(await db.query("SELECT * FROM tokentracker_self_host_installations WHERE step='public-profiles-v1'")).rows;
  await db.exec(sql);
  assert.deepEqual((await db.query("SELECT * FROM tokentracker_self_host_installations WHERE step='public-profiles-v1'")).rows,before);
  await db.query("UPDATE tokentracker_self_host_installations SET checksum='changed' WHERE step='public-profiles-v1'");
  await assert.rejects(db.exec(sql),/Installed public addon changed/);
 }finally{await db.close();}
});

test('owner settings retain an unset name while public readers use their anonymous fallback',async()=>{
 const owner=await instance.user();
 await visibility(owner,{enabled:true});
 assert.equal((await visibility(owner)).data.display_name,null);
 await visibility(owner,{display_name:'Explicit synthetic name'});
 assert.equal((await visibility(owner)).data.display_name,'Explicit synthetic name');
 await visibility(owner,{display_name:'  '});
 assert.equal((await visibility(owner)).data.display_name,null);
 await upload(owner,111);await refresh();
 assert.equal((await profile(owner)).data.user.display_name,'Anonymous');
});
