const {buildSync}=require('esbuild');
const Module=require('node:module');
const path=require('node:path');
let cached;
module.exports=function cloudPricing(){
  if(cached)return cached;
  const file=path.resolve(__dirname,'../../dashboard/edge-patches/cloud/pricing.ts');
  const result=buildSync({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs',external:['npm:@insforge/sdk'],logLevel:'silent'});
  const compiled=new Module(file,module);
  compiled.require=name=>name==='npm:@insforge/sdk'?{createClient:()=>{throw Error('Pricing unit fixture cannot access a server');}}:require(name);
  compiled._compile(result.outputFiles[0].text,file);
  cached=compiled.exports;return cached;
};
