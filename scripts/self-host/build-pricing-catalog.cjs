// Generate a validated catalog for the owner's authenticated pricing endpoint.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createCatalog,fetchRates}=require('../../src/lib/pricing/catalog');
async function main(){
 const [output,overrides]=process.argv.slice(2);
 if(!output)throw Error('Usage: node scripts/self-host/build-pricing-catalog.cjs output.json [overrides.json]');
 const curated=overrides?JSON.parse(await fs.readFile(path.resolve(overrides),'utf8')):require('../../src/lib/pricing/curated-overrides.json');
 const catalog=await createCatalog(await fetchRates(),{curated,source:'LiteLLM + reviewed personal overrides'});
 await fs.writeFile(path.resolve(output),JSON.stringify(catalog,null,2)+'\n');
 console.log(catalog.version);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
