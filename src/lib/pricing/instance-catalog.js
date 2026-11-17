const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateCatalog } = require('./catalog');
async function loadInstanceCatalog({ configPath, cachePath, fetchImpl = fetch }) {
  let config;
  try { config = JSON.parse(await fs.readFile(configPath,'utf8')); } catch { return null; }
  if (!config.baseUrl) return null;
  let url;
  try {
    const base = new URL(config.baseUrl);
    if (base.username || base.password || (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname)))) return null;
    if (base.hostname.endsWith('.insforge.app') || base.hostname === 'www.tokentracker.cc') return null;
    url = new URL('/functions/tokentracker-pricing',base).toString();
  } catch { return null; }
  const filename = cachePath+'.'+createHash('sha256').update(url).digest('hex').slice(0,16)+'.catalog';
  try {
    const response = await fetchImpl(url,{ headers: config.anonKey ? { apikey:config.anonKey } : {}, signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('Instance pricing unavailable');
    const text = await response.text(); if (text.length > 12*1024*1024) throw Error('Catalog too large');
    const catalog = await validateCatalog(JSON.parse(text));
    await fs.mkdir(path.dirname(filename),{recursive:true});
    const temporary=filename+'.'+randomUUID()+'.tmp';
    try { await fs.writeFile(temporary,JSON.stringify(catalog),{mode:0o600});await fs.rename(temporary,filename); }
    finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
    return { catalog, instance:url, stale:false };
  } catch {
    try { return { catalog:await validateCatalog(JSON.parse(await fs.readFile(filename,'utf8'))),instance:url,stale:true }; }
    catch { return { instance:url, stale:true, catalog:null }; }
  }
}
module.exports={loadInstanceCatalog};
