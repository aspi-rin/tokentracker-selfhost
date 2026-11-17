const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimeConfig, assertInsforgeRuntime } = require('../src/lib/runtime-config');

// Only public connection settings belong in an installer. Never copy a user's
// config, device token or session into the application bundle.
const directory = process.argv[2];
if (!directory || !fs.existsSync(path.join(directory, 'bin/tracker.js'))) {
  throw new Error('Expected the bundled tokentracker directory');
}
const baseUrl = process.env.VITE_INSFORGE_BASE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
if (!baseUrl || !anonKey) throw new Error('Explicit public instance URL and anonymous key are required');
const runtime = resolveRuntimeConfig({
  cli: { baseUrl, anonKey, dashboardUrl: baseUrl }, config: {}, env: {}, defaults: {},
});
assertInsforgeRuntime(runtime);
const config = { baseUrl: runtime.baseUrl, anonKey: runtime.anonKey, dashboardUrl: runtime.dashboardUrl };
fs.writeFileSync(path.join(directory, 'instance-defaults.json'), JSON.stringify(config, null, 2) + '\n');
console.log('Bundled public instance:', new URL(runtime.baseUrl).host);
