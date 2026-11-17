const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createCatalog,validateCatalog,fetchRates}=require('../src/lib/pricing/catalog');
const {loadInstanceCatalog}=require('../src/lib/pricing/instance-catalog');
const pricing=require('../src/lib/pricing');
const raw={ 'fresh-fixture-model':{input_cost_per_token:0.000002,output_cost_per_token:0.000008,cache_read_input_token_cost:0.0000002} };
const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
test('catalog survives JSONB reordering, detects tampering and validates input rates',async()=>{
  const c=await createCatalog(raw);assert.equal((await validateCatalog(reverse(c))).version,c.version);
  await assert.rejects(validateCatalog({...c,litellm:{"changed-model":{input_cost_per_token:0.000002}}}),/checksum/);
  await assert.rejects(createCatalog({broken:{input_cost_per_token:-1}}),/rate/);
  await assert.rejects(createCatalog({}),/Empty/);
  await assert.rejects(createCatalog(raw,{curated:{exact:{constructor:{input:1}},alias:{},fuzzy:[]}}),/override/);
});
test('a new catalog invalidates model misses while keeping known source-specific rules',async()=>{
  const e=require('../src/lib/pricing/core').createPricingEngine();
  assert.equal(e.getModelPricingInfo('fresh-fixture-model').status,'unpriced');
  const c=await createCatalog(raw);e.setCatalog(c);
  assert.equal(e.getModelPricingInfo('fresh-fixture-model').status,'priced');
  assert.equal(e.computeRowCost({model:'fresh-fixture-model',input_tokens:1000,output_tokens:100,cached_input_tokens:100}),0.00282);
  assert.equal(e.computeRowCost({model:'fresh-fixture-model',source:'lmstudio',input_tokens:1000}),0);
});
test('instance cache retains last good prices offline and isolates a switched backend',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'personal-catalog-'));
  const configPath=path.join(dir,'config.json'),cachePath=path.join(dir,'prices.json');
  const good=await createCatalog(raw),fetchImpl=async()=>Response.json(good);
  try {
    await fs.writeFile(configPath,JSON.stringify({baseUrl:'https://one.example.test',anonKey:'public-fixture'}));
    const first=await loadInstanceCatalog({configPath,cachePath,fetchImpl});assert.equal(first.stale,false);
    const offline=async()=>{throw Error('offline')};
    assert.equal((await loadInstanceCatalog({configPath,cachePath,fetchImpl:offline})).catalog.version,good.version);
    await fs.writeFile(configPath,JSON.stringify({baseUrl:'https://two.example.test'}));
    assert.equal((await loadInstanceCatalog({configPath,cachePath,fetchImpl:offline})).catalog,null);
    await fs.writeFile(configPath,JSON.stringify({baseUrl:'https://one.example.test'}));
    const corrupt=await loadInstanceCatalog({configPath,cachePath,fetchImpl:async()=>Response.json({...good,version:'0'.repeat(64)})});
    assert.equal(corrupt.stale,true);assert.equal(corrupt.catalog.version,good.version);
    assert.equal((await fs.readdir(dir)).some(n=>n.endsWith('.tmp')),false);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('concurrent loader calls finish on the current instance after config changes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pricing-switch-')),configPath=path.join(dir,'config.json');
  pricing.resetPricingForTests();let release;
  const first=await createCatalog(raw),second=await createCatalog({'fresh-fixture-model':{input_cost_per_token:0.000003}});
  const fetchImpl=async url=>url.includes('one.example')?new Promise(r=>{release=()=>r(Response.json(first));}):Response.json(second);
  try {
    await fs.writeFile(configPath,JSON.stringify({baseUrl:'https://one.example'}));
    const a=pricing.ensurePricingLoaded({configPath,catalogFetchImpl:fetchImpl});
    while(!release)await new Promise(r=>setImmediate(r));
    await fs.writeFile(configPath,JSON.stringify({baseUrl:'https://two.example'}));
    const b=pricing.ensurePricingLoaded({configPath,catalogFetchImpl:fetchImpl});release();await Promise.all([a,b]);
    assert.equal(pricing.getPricingCatalogInfo().version,second.version);
    assert.equal(pricing.getModelPricing('fresh-fixture-model').input,3);
  } finally {pricing.resetPricingForTests();await fs.rm(dir,{recursive:true,force:true});}
});
test('upstream fetch rejects oversized and malformed responses before publication',async()=>{
  assert.deepEqual(Object.keys(await fetchRates(async()=>Response.json(raw))),['fresh-fixture-model']);
  await assert.rejects(fetchRates(async()=>new Response('x'.repeat(12*1024*1024+1))),/large/);
  await assert.rejects(fetchRates(async()=>Response.json({broken:{input_cost_per_token:'2'}})),/rate/);
});
