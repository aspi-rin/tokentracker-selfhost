'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const local=require('../src/lib/pricing/core').createPricingEngine();
const cloud=require('./helpers/cloud-pricing.cjs')();
const curated=require('../src/lib/pricing/curated-overrides.json');
const consumers=['leaderboard-refresh','account-daily','account-summary','account-model-breakdown','leaderboard-profile'];
test('all five cloud cost consumers import the portable engine',()=>{
  for(const name of consumers){
    const text=fs.readFileSync(path.join(__dirname,'../dashboard/edge-patches/tokentracker-'+name+'.ts'),'utf8');
    assert.match(text,/from "\.\/cloud\/pricing\.ts"/);
    assert.doesNotMatch(text,/const MODEL_PRICING|function computeRowCost/);
  }
});
test('bundled cloud engine resolves all curated exact and source-specific models identically',()=>{
  const rows=Object.keys(curated.exact).map(model=>({model}));
  for(const [source,models]of Object.entries(curated.source_exact||{}))for(const model of Object.keys(models))rows.push({source,model});
  for(const row of rows){
    assert.deepEqual(cloud.getModelPricing(row.model,row.source),local.getModelPricing(row.model,row.source),JSON.stringify(row));
    assert.equal(cloud.computeRowCost({...row,input_tokens:1e6,output_tokens:1e6,cached_input_tokens:1e6,cache_creation_input_tokens:1e6}),
      local.computeRowCost({...row,input_tokens:1e6,output_tokens:1e6,cached_input_tokens:1e6,cache_creation_input_tokens:1e6}));
  }
});
test('golden costs cover cache, tier, disjoint reasoning, free and authoritative totals',()=>{
  const cases=[
    [{source:'antigravity',model:'gemini-4-hydrogen',input_tokens:5000,output_tokens:14000},0.1125],
    [{source:'antigravity',model:'gemini-4-hydrogen',input_tokens:5000,output_tokens:14000,cached_input_tokens:1000},0.112575],
    [{source:'grok',model:'unpublished-probe',total_cost_usd:2.5},2.5],
    [{source:'command-code',model:'unpublished-probe',total_cost_usd:2.5},0],
    [{source:'cline',model:'deepseek/deepseek-r1:free',input_tokens:1e6},0],
    [{source:'opencode',model:'deepseek-v4.1-flash-free',input_tokens:1e6},0],
    [{source:'lmstudio',model:'claude-sonnet-4-6',input_tokens:1e6},0],
  ];
  for(const [row,expected]of cases){assert.ok(Math.abs(cloud.computeRowCost(row)-expected)<1e-12,JSON.stringify(row));assert.equal(cloud.computeRowCost(row),local.computeRowCost(row));}
  for(const source of ['claude','codex','cursor','acode','omo','command-code','unsloth'])for(const pricing_tier of ['standard','priority','ultrafast','off_peak']){
    const row={source,pricing_tier,model:'gpt-6-sol',input_tokens:300000,output_tokens:500,reasoning_output_tokens:100,cached_input_tokens:20000,cache_creation_input_tokens:50};
    assert.equal(cloud.computeRowCost(row),local.computeRowCost(row));
  }
});
test('unpriced and malicious model keys remain zero with explicit status',()=>{
  for(const model of ['constructor','prototype','__proto__','unknown-hydrogen-model']){
    assert.equal(cloud.getModelPricingInfo(model).status,'unpriced');
    assert.equal(cloud.computeRowCost({model,input_tokens:1e6}),0);
  }
});
