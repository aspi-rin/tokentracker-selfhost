// Portable catalog format shared by the CLI, edge functions and export files.
const bundledCurated = require('./curated-overrides.json');
const bundledSeed = require('./seed-snapshot.json');
const UPSTREAM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const RATE_FIELDS = ['input_cost_per_token','output_cost_per_token','cache_read_input_token_cost','cache_creation_input_token_cost'];
const forbidden = new Set(['__proto__','constructor','prototype']);
function normalizeRates(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid pricing data');
  const result = Object.create(null);
  for (const name of Object.keys(raw).sort()) {
    if (name === '_meta' || forbidden.has(name)) continue;
    const entry = raw[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = {};
    for (const field of RATE_FIELDS) if (entry[field] !== undefined && entry[field] !== null) {
      if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || entry[field] < 0 || entry[field] > 1000) throw Error('Invalid model rate');
      value[field] = entry[field];
    }
    if (Object.keys(value).length) result[name] = value;
  }
  if (!Object.keys(result).length || Object.keys(result).length > 100000) throw Error('Empty or oversized pricing data');
  return result;
}
async function catalogVersion(curated, litellm) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ curated, litellm })));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
}
function validateCurated(curated) {
  if (!curated || !curated.exact || !curated.alias || !Array.isArray(curated.fuzzy)) throw Error('Invalid overrides');
  function rates(map) {
    if (!map || typeof map!=='object' || Array.isArray(map)) throw Error('Invalid override map');
    for(const [key,value] of Object.entries(map)) {
      if(forbidden.has(key) || !value || typeof value!=='object' || Array.isArray(value)) throw Error('Invalid override');
      for(const field of ['input','output','cache_read','cache_write','priority_multiplier','ultrafast_multiplier']) {
        if(value[field]!==undefined && (typeof value[field]!=='number' || !Number.isFinite(value[field]) || value[field]<0 || value[field]>1e9)) throw Error('Invalid override rate');
      }
    }
  }
  rates(curated.exact);
  for(const map of Object.values(curated.source_exact || {})) rates(map);
  for(const [key,value] of Object.entries(curated.alias)) if(forbidden.has(key) || typeof value!=='string') throw Error('Invalid alias');
  for(const item of curated.fuzzy) if(typeof item?.match!=='string' || typeof item?.ref!=='string') throw Error('Invalid match');
}
async function createCatalog(raw = bundledSeed, { curated = bundledCurated, updatedAt = new Date().toISOString(), source = 'bundled' } = {}) {
  validateCurated(curated);
  const litellm = normalizeRates(raw);
  return { schemaVersion: 1, version: await catalogVersion(curated,litellm), updatedAt, source, curated, litellm };
}
async function validateCatalog(value) {
  if (value?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.version || '') ||
    !Number.isFinite(Date.parse(value.updatedAt)) || !value.curated?.exact ||
    !value.curated.alias || !Array.isArray(value.curated.fuzzy) || typeof value.source !== 'string') throw Error('Invalid catalog');
  const result = await createCatalog(value.litellm, value);
  if (result.version !== value.version) throw Error('Pricing catalog checksum mismatch');
  return result;
}
async function fetchRates(fetchImpl = fetch) {
  const response = await fetchImpl(UPSTREAM_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Pricing source unavailable');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const {value,done} = await reader.read(); if(done) break;
    size += value.byteLength; if(size > 12*1024*1024) throw Error('Pricing response too large'); chunks.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  const joined = new Uint8Array(size); let offset = 0;
  for(const chunk of chunks) { joined.set(chunk,offset); offset+=chunk.byteLength; }
  return normalizeRates(JSON.parse(new TextDecoder().decode(joined)));
}
module.exports = { UPSTREAM_URL, createCatalog, validateCatalog, fetchRates };
