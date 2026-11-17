// Local catalog loader. The pure engine is also bundled into self-hosted functions.
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { createPricingEngine } = require("./core");
const { loadLitellmData } = require("./litellm-fetcher");
const { loadInstanceCatalog } = require("./instance-catalog");
const curated = require("./curated-overrides.json");
const seed = require("./seed-snapshot.json");
const engine = createPricingEngine();
const state = engine.__getStateForTests();
function defaultCachePath() { return path.join(os.homedir(), ".tokentracker", "cache", "pricing.json"); }
async function ensurePricingLoaded(opts = {}) {
  const configPath = opts.configPath || (!opts.cachePath && !opts.fetchImpl
    ? path.join(os.homedir(), ".tokentracker", "tracker", "config.json") : null);
  const signature = configPath ? await fs.stat(configPath).then(s=>`${configPath}:${s.mtimeMs}:${s.size}`).catch(()=>configPath+":missing") : null;
  if (state.loaded && state.configSignature === signature && (!state.instance || Date.now() - (state.checkedAt || 0) < 300000)) return state;
  if (state.loadingPromise) {
    await state.loadingPromise;
    return ensurePricingLoaded(opts);
  }
  state.loadingPromise = (async () => {
    try {
      const cachePath = opts.cachePath || (opts.configPath ? path.join(path.dirname(opts.configPath), "cache", "pricing.json") : defaultCachePath());
      const instance = configPath ? await loadInstanceCatalog({ configPath, cachePath, fetchImpl: opts.catalogFetchImpl }) : null;
      const previousInstance = state.instance;
      state.instance = instance?.instance || null;
      if (instance) {
        if (instance.catalog) engine.setCatalog(instance.catalog, instance.stale ? "instance-cache" : "instance");
        else engine.setCatalog({curated,litellm:seed},"bundled");
        state.catalog = instance.catalog ? { version: instance.catalog.version, updatedAt: instance.catalog.updatedAt,
          source: instance.catalog.source, stale: instance.stale } : { version: null, updatedAt: null, source: "bundled", stale: true };
      } else if (opts.instanceOnly) {
        if (previousInstance) engine.setCatalog({curated,litellm:seed},"bundled");
        state.catalog = null;
      } else {
        const { data, source } = await loadLitellmData({ ...opts, cachePath });
        engine.setCatalog({ curated, litellm: data || {} }, source);
        state.catalog = null;
      }
      state.configSignature = signature;
      state.checkedAt = Date.now();
      state.loaded = true;
      return state;
    } finally { state.loadingPromise = null; }
  })();
  return state.loadingPromise;
}
function resetPricingForTests() {
  state.loaded = false;
  state.loadingPromise = null;
  state.instance = null;
  state.catalog = null;
  state.checkedAt = 0;
  engine.setCatalog({ curated, litellm: seed }, "seed-snapshot:sync");
}
module.exports = { ...engine, ensurePricingLoaded, resetPricingForTests, getPricingCatalogInfo: () => state.catalog };
