const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./helpers/self-host-fixture.cjs');
const {createCatalog}=require('../src/lib/pricing/catalog');
let f;
before(async()=>{f=await fixture({publicProfiles:true});});after(async()=>f?.close());
test('old and personal device endpoints preserve identity, owner isolation, pause and resume',async()=>{
  const owner=await f.user(),other=await f.user();let machine=randomUUID();
  const issue=await f.request('tokentracker-device-token-issue',{machine_id:machine,device_name:'Personal fixture',platform:'test'},owner);
  assert.equal(issue.response.status,200);
  machine=(await f.request("tokentracker-devices?action=devices",undefined,owner)).data.machines[0].machine_id;
  for(const slug of ['tokentracker-billing','tokentracker-devices']){
    const list=await f.request(slug+'?action=devices',undefined,owner);assert.equal(list.response.status,200);assert.equal(list.data.machines.length,1);
    assert.equal((await f.request(slug+'?action=devices',undefined,other)).data.machines.length,0);
    assert.equal((await f.request(slug+'?action=remove-device',{machine_id:machine},other)).data.ok,false);
    assert.equal((await f.request(slug+'?action=remove-device',{machine_id:machine},owner)).data.ok,true);
    assert.equal((await f.request(slug+'?action=resume-device',{machine_id:machine},owner)).data.ok,true);
    assert.equal((await f.request(slug+'?action=devices',undefined,f.token(owner,'anon'))).response.status,401);
  }
  const account=await f.request('tokentracker-billing',undefined,owner);
  assert.equal(account.data.membership.hosting_mode,'self_hosted');assert.equal(account.data.membership.can_upload_cloud,true);
  for(const action of ['checkout','trial','gift','cancel-subscription','redeem-gift'])assert.equal((await f.request('tokentracker-billing?action='+action,{},owner)).response.status,410);
});
test('catalog publication has client-role restrictions, CAS and read-back checksum; failed refresh keeps last good prices',async()=>{
  const owner=await f.user();f.env.TOKENTRACKER_OWNER_ID=owner;
  const c=await createCatalog({'personal-fixture-model':{input_cost_per_token:0.000003,output_cost_per_token:0.000009}});
  for(const role of ['anon','authenticated'])await assert.rejects(f.db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query('SELECT self_host_publish_pricing($1,$2)',[null,c]);}),/permission denied/);
  await f.db.query('SELECT self_host_publish_pricing($1,$2)',[null,JSON.stringify(c)]);
  const next=await createCatalog({'personal-fixture-model':{input_cost_per_token:0.000004}});
  assert.equal((await f.db.query('SELECT self_host_publish_pricing($1,$2) r',['wrong-version',JSON.stringify(next)])).rows[0].r.ok,false);
  assert.equal((await f.request('tokentracker-pricing')).data.version,c.version);
  assert.equal((await f.request('tokentracker-pricing',{},f.token(owner,'anon'))).response.status,401);
  assert.equal((await f.request('tokentracker-pricing',{},owner)).response.status,503);
  assert.equal((await f.request('tokentracker-pricing')).data.version,c.version);
  assert.equal((await f.request('tokentracker-pricing',{catalog:next,expectedVersion:c.version},await f.user())).response.status,403);
  assert.equal((await f.request('tokentracker-pricing',{catalog:{...next,version:'0'.repeat(64)},expectedVersion:c.version},owner)).response.status,400);
  assert.equal((await f.request('tokentracker-pricing',{catalog:next,expectedVersion:'outdated'},owner)).response.status,409);
  const published=await f.request('tokentracker-pricing',{catalog:next,expectedVersion:c.version},owner);
  assert.equal(published.response.status,200);assert.equal(published.data.version,next.version);
  const device=await f.request('tokentracker-device-token-issue',{device_name:'Catalog propagation fixture',platform:'test',machine_id:randomUUID()},owner);
  const day=new Date().toISOString().slice(0,10);
  await f.request('tokentracker-ingest',{buckets:[{hour_start:day+'T12:00:00Z',source:'codex',model:'personal-fixture-model',input_tokens:1000,output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0,total_tokens:1000,billable_total_tokens:1000,total_cost_usd:0,conversation_count:1}]},device.data.token);
  const summary=await f.request('tokentracker-account-summary?from='+day+'&to='+day+'&tz=UTC',undefined,owner);
  assert.equal(Number(summary.data.totals.total_cost_usd),0.004);
  delete f.env.TOKENTRACKER_OWNER_ID;
  await f.db.exec('DELETE FROM tokentracker_pricing_catalog');
});
test('personal home publishes only the configured owner and respects opt-out and anonymous mode',async()=>{
  const owner=await f.user(),other=await f.user();f.env.TOKENTRACKER_OWNER_ID=owner;
  assert.equal((await f.request('tokentracker-public-home')).response.status,404);
  for(const id of [owner,other]){
    const d=await f.request('tokentracker-device-token-issue',{device_name:'Personal public fixture',platform:'test'},id);
    await f.request('tokentracker-ingest',{buckets:[{hour_start:new Date().toISOString().slice(0,13)+':00:00Z',source:'constructor',model:'unknown',input_tokens:123,output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0,total_tokens:123,billable_total_tokens:123,total_cost_usd:0,conversation_count:1}]},d.data.token);
    await f.request('tokentracker-public-visibility',{enabled:true,display_name:'Public fixture'},id);
  }
  assert.equal((await f.request('tokentracker-public-home')).data.user_id,owner);
  assert.equal((await f.request('tokentracker-self-host-leaderboard-refresh',{},f.env.TOKENTRACKER_PUBLIC_REFRESH_SECRET)).response.status,200);
  const list=await f.request('tokentracker-leaderboard?period=total');assert.deepEqual(list.data.entries.map(x=>x.user_id),[owner]);
  assert.equal(list.data.entries[0].other_tokens,123);assert.equal(list.data.entries[0].total_tokens,123);
  assert.equal((await f.request('tokentracker-leaderboard-profile?user_id='+other)).response.status,404);
  await f.request('tokentracker-public-visibility',{anonymous:true},owner);
  assert.equal((await f.request('tokentracker-leaderboard-profile?user_id='+owner)).data.user.display_name,'Anonymous');
  await f.request('tokentracker-public-visibility',{enabled:false},owner);
  assert.equal((await f.request('tokentracker-public-home')).response.status,404);
  assert.equal((await f.request('tokentracker-leaderboard?period=total')).data.entries.length,0);
  delete f.env.TOKENTRACKER_OWNER_ID;
  assert.equal((await f.request('tokentracker-leaderboard?period=total')).response.status,404);
  assert.equal((await f.request('tokentracker-self-host-leaderboard-refresh',{},f.env.TOKENTRACKER_PUBLIC_REFRESH_SECRET)).response.status,503);
});
