const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {fixture} = require('./helpers/self-host-fixture.cjs');
let instance;
test.before(async () => { instance = await fixture({publicProfiles:true}); });
test.after(async () => { await instance?.close(); });
test.beforeEach(async () => { await instance.db.query('DELETE FROM auth.users'); });
const visibility = (owner, body) => instance.request('tokentracker-public-visibility', body, owner);
const refresh = () => instance.request('tokentracker-self-host-leaderboard-refresh', {}, instance.env.TOKENTRACKER_PUBLIC_REFRESH_SECRET);
const profile = owner => instance.request('tokentracker-leaderboard-profile?user_id='+owner+'&period=total');
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
async function upload(owner) {
  const device = await instance.request('tokentracker-device-token-issue', {device_name:'Identity fixture',platform:'test',machine_id:randomUUID()}, owner);
  assert.equal(device.response.status,200);
  const result = await instance.request('tokentracker-ingest', {buckets:[{
    hour_start:new Date().toISOString().slice(0,13)+':00:00Z',source:'antigravity',model:'gemini-4-hydrogen',
    input_tokens:5000,output_tokens:2100,cached_input_tokens:0,cache_creation_input_tokens:0,
    reasoning_output_tokens:0,total_tokens:7100,billable_total_tokens:7100,total_cost_usd:0,conversation_count:1,
  }]}, device.data.token);
  assert.equal(result.response.status,200);
}
test('owner nickname and uploaded avatar persist and update public readers immediately', async () => {
  const owner = await instance.user();
  await upload(owner);
  await visibility(owner,{enabled:true,display_name:'Original name'});
  await refresh();
  const saved = await visibility(owner,{display_name:'  Rin  ',avatar_url:avatar});
  assert.equal(saved.response.status,200);
  assert.equal(saved.data.avatar_url,avatar);
  assert.equal((await visibility(owner)).data.avatar_url,avatar);
  const details = await profile(owner);
  assert.equal(details.data.user.display_name,'Rin');
  assert.equal(details.data.user.avatar_url,avatar);
  const list = await instance.request('tokentracker-leaderboard?period=total');
  assert.equal(list.data.entries[0].display_name,'Rin');
  assert.equal(list.data.entries[0].avatar_url,avatar);
  await visibility(owner,{anonymous:true});
  assert.equal((await profile(owner)).data.user.display_name,'Anonymous');
  assert.equal((await profile(owner)).data.user.avatar_url,null);
  assert.equal((await instance.request('tokentracker-leaderboard?period=total')).data.entries[0].avatar_url,null);
  await visibility(owner,{anonymous:false,avatar_url:null});
  assert.equal((await profile(owner)).data.user.avatar_url,null);
});
test('avatars require the owner, a small supported raster and current publication consent',async()=>{
  const owner=await instance.user(),other=await instance.user();
  assert.equal((await visibility(undefined,{avatar_url:avatar})).response.status,401);
  const image=Buffer.from(avatar.split(',')[1],'base64');
  const padded=Buffer.concat([image,Buffer.alloc(65536-image.length)]);
  assert.equal((await visibility(owner,{avatar_url:'data:image/png;base64,'+padded.toString('base64')})).response.status,200);
  const oversized=Buffer.concat([padded,Buffer.alloc(1)]);
  assert.equal((await visibility(owner,{avatar_url:'data:image/png;base64,'+oversized.toString('base64')})).response.status,400);
  const hugeDimensions=Buffer.from(image);hugeDimensions.writeUInt32BE(100000,16);
  assert.equal((await visibility(owner,{avatar_url:'data:image/png;base64,'+hugeDimensions.toString('base64')})).response.status,400);
  for(const value of ['https://example.test/track.png','data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,bm90IGEgcG5n',123,'data:image/png;base64,'+'A'.repeat(90000)]) {
    assert.equal((await visibility(owner,{avatar_url:value})).response.status,400);
  }
  await visibility(owner,{avatar_url:avatar,user_id:other});
  assert.equal((await visibility(other)).data.avatar_url,null);
  await require('../scripts/self-host/install-public.cjs').install(instance.db);
  assert.equal((await visibility(owner)).data.avatar_url,avatar);
  assert.equal((await profile(owner)).response.status,404);
  for(const role of ['anon','authenticated']) {
    await assert.rejects(instance.db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query('SELECT avatar_url FROM tokentracker_user_settings');}));
  }
});
test('Antigravity Gemini tokens retain their provider in leaderboard and public profile', async () => {
  const owner = await instance.user();
  await upload(owner);
  await visibility(owner,{enabled:true,display_name:'Synthetic Rin'});
  await refresh();
  const list = await instance.request('tokentracker-leaderboard?period=month');
  assert.equal(Number(list.data.entries[0].antigravity_tokens),7100);
  assert.equal(Number(list.data.entries[0].other_tokens),0);
  assert.ok(Math.abs(Number(list.data.entries[0].estimated_cost_usd)-0.02325)<1e-12);
  const details = await profile(owner);
  assert.equal(details.data.by_provider[0].source,'antigravity');
  assert.equal(details.data.by_provider[0].total_tokens,7100);
  assert.ok(JSON.stringify(details.data.models).includes('gemini-4-hydrogen'));
});
test('identity upgrade preserves an existing v1 installation and its usage, consent and identity',async()=>{
  const {platform}=require('./helpers/self-host-fixture.cjs');
  const fs=require('node:fs'),{createHash}=require('node:crypto');
  const db=await platform();
  try {
    await require('../scripts/self-host/install.cjs').install(db);
    const sql=fs.readFileSync(require('node:path').join(__dirname,'../scripts/self-host/public-profiles.sql'),'utf8');
    await db.exec(sql);
    await db.query("INSERT INTO tokentracker_self_host_installations(step,checksum) VALUES('public-profiles-v1',$1)",[createHash('sha256').update(sql).digest('hex')]);
    const owner=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[owner]);
    const device=randomUUID();
    await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name) VALUES($1,$2,'Existing device')",[device,owner]);
    await db.query("INSERT INTO tokentracker_hourly(user_id,device_id,hour_start,source,model,input_tokens,output_tokens,cached_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations) VALUES($1,$2,'2026-11-16T00:00:00Z','antigravity','gemini-4-hydrogen',5000,2100,0,0,0,7100,7100,1)",[owner,device]);
    const raw=(await db.query('SELECT * FROM tokentracker_hourly')).rows;
    await db.query("SELECT self_host_set_public_profile($1,$2::jsonb)",[owner,JSON.stringify({enabled:true,display_name:'Existing name'})]);
    const ledger=(await db.query("SELECT checksum FROM tokentracker_self_host_installations WHERE step='public-profiles-v1'")).rows[0].checksum;
    const install=require('../scripts/self-host/install-public.cjs').install;
    await install(db);await install(db);
    const saved=(await db.query('SELECT * FROM tokentracker_user_settings WHERE user_id=$1',[owner])).rows[0];
    assert.equal(saved.display_name,'Existing name');assert.equal(saved.leaderboard_public,true);assert.equal(saved.avatar_url,null);
    assert.deepEqual((await db.query('SELECT * FROM tokentracker_hourly')).rows,raw);
    assert.equal((await db.query("SELECT checksum FROM tokentracker_self_host_installations WHERE step='public-profiles-v1'")).rows[0].checksum,ledger);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_self_host_installations WHERE step='public-profile-identity-v2'")).rows[0].n,1);
  } finally {await db.close();}
});
