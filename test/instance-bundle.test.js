const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('fresh installers select their public instance and preserve configured instance identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-instance-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/tracker.js'), '');
  fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/lib/runtime-config.js'), path.join(root, 'src/lib/runtime-config.js'));
  const env = { ...process.env, VITE_INSFORGE_BASE_URL: 'https://personal.example', VITE_INSFORGE_ANON_KEY: 'anon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/configure-instance-bundle.cjs'), root], { env });
  const { resolveRuntimeConfig } = require(path.join(root, 'src/lib/runtime-config.js'));
  const fresh = resolveRuntimeConfig({ env: {} });
  assert.equal(fresh.baseUrl, 'https://personal.example');
  assert.equal(fresh.anonKey, env.VITE_INSFORGE_ANON_KEY);
  assert.equal(fresh.configurationError, null);
  assert.equal(fresh.deviceToken, null);
  const previous = resolveRuntimeConfig({ env: {}, config: {
    baseUrl: 'https://previous.example', anonKey: 'anon_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    deviceToken: 'synthetic-device', deviceTokenBaseUrl: 'https://previous.example',
  } });
  assert.equal(previous.baseUrl, 'https://previous.example');
  assert.equal(previous.anonKey, 'anon_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(previous.deviceToken, 'synthetic-device');
  const changed = resolveRuntimeConfig({ env: {}, cli: { baseUrl: 'https://other.example' }, config: {
    baseUrl: fresh.baseUrl, anonKey: fresh.anonKey, deviceToken: 'synthetic-device', deviceTokenBaseUrl: fresh.baseUrl,
  } });
  assert.equal(changed.deviceToken, null);
  assert.equal(changed.configurationError, 'custom_insforge_anon_key_required');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'instance-defaults.json')))).sort(), ['anonKey', 'baseUrl', 'dashboardUrl']);
});

test('installer configuration rejects a privileged key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-instance-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/tracker.js'), '');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/configure-instance-bundle.cjs'), root], {
    env: { ...process.env, VITE_INSFORGE_BASE_URL: 'https://personal.example', VITE_INSFORGE_ANON_KEY: 'ik_synthetic_admin' },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'instance-defaults.json')), false);
});
