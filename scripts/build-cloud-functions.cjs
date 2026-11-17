// Personal instances use one deterministic, payment-free function builder.
const path=require("node:path");
const {buildFunctions}=require("./self-host/build-functions.cjs");
async function buildCloudFunctions(options={}) {
  if(options.sandbox || options.accessSandbox || options.giftSandbox)throw Error("Hosted payment sandbox builds are retired in the personal edition");
  const output=path.resolve(__dirname,"../.tmp/cloud-functions");
  const manifest=await buildFunctions(output,{publicProfiles:true});
  return {output,functions:manifest.functions.map(item=>item.slug)};
}
if(require.main===module)buildCloudFunctions().then(result=>console.log(`Built ${result.functions.length} personal functions`)).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={buildCloudFunctions};
