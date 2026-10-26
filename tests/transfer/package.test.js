'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const { makeBrowserHarness } = require('./helpers');
const ROOT = path.resolve(__dirname, '../..');
const CHECKER = path.join(ROOT, 'tools/check-transfer-package.js');
const ASAR = path.join(ROOT, 'node_modules/@electron/asar/bin/asar.js');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-package-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app'); await fs.mkdir(app);
  for (const name of ['src', 'assets', 'package.json']) await fs.cp(path.join(ROOT, name), path.join(app, name), { recursive: true });
  for (const name of ['map-transfers.md']) {
    try { await fs.mkdir(path.join(app, 'docs'), { recursive: true }); await fs.copyFile(path.join(ROOT, 'docs', name), path.join(app, 'docs', name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { dir, app };
}
function check(app) {
  const result = spawnSync(process.execPath, [CHECKER, ...(app ? [app] : [])], { cwd: ROOT, encoding: 'utf8' });
  let body; try { body = JSON.parse(result.stdout); } catch { body = null; }
  return { status: result.status, body, stderr: result.stderr };
}
async function capability(app, provider, value) {
  await fs.writeFile(path.join(app, 'src/transfer/providers', provider, 'capability.json'), JSON.stringify(value));
}

test('checker accepts the offline payload and ten reproducible scripts without provider implementations', async t => {
  const { app } = await fixture(t); const result = check(app);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.body.ok, true);
  assert.equal(result.body.scripts, 10); assert.equal(result.body.providers.length, 5);
  assert.equal(result.body.providers.every(p => p.status !== 'supported' && p.reasonCode), true);
});

test('missing script has a stable diagnostic before any package code executes', async t => {
  const { app } = await fixture(t); await fs.unlink(path.join(app, 'src/transfer/scripts/bwiki-import.js'));
  const result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'missing-transfer-script');
});

test('unproved variant cannot advertise support', async t => {
  const { app } = await fixture(t); const value = makeBrowserHarness({ provider: 'appsample' }).adapter.capability;
  value.variants[0].evidence.reload = false; await capability(app, 'appsample', value);
  const result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'invalid-capability');
});

for (const [provider, missing] of [['appsample', 'adapter.js'], ['hoyolab', 'normalize.js'], ['mapgenie', 'mapping.json']]) {
  test(`advertised ${provider} support requires ${missing} before accepting self-declared evidence`, async t => {
    const { app } = await fixture(t); await capability(app, provider, makeBrowserHarness({ provider }).adapter.capability);
    const base = path.join(app, 'src/transfer/providers', provider);
    if (missing !== 'adapter.js') await fs.writeFile(path.join(base, 'adapter.js'), 'throw new Error("never execute packaged adapters");');
    if (missing === 'mapping.json') await fs.writeFile(path.join(base, 'normalize.js'), 'throw new Error("never execute packaged normalizers");');
    const result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'missing-provider-asset');
    assert.equal(result.body?.file, `src/transfer/providers/${provider}/${missing}`);
  });
}

test('a structurally invalid mapping pack cannot satisfy advertised cross-provider support', async t => {
  const { app } = await fixture(t); await capability(app, 'mapgenie', makeBrowserHarness({ provider: 'mapgenie' }).adapter.capability);
  const base = path.join(app, 'src/transfer/providers/mapgenie');
  for (const file of ['adapter.js', 'normalize.js']) await fs.writeFile(path.join(base, file), 'throw new Error("never execute this");');
  await fs.writeFile(path.join(base, 'mapping.json'), '{}');
  assert.equal(check(app).body?.code, 'invalid-mapping-pack');
});

test('exact AppSample identity needs no fabricated cross-provider pack but still requires reviewed implementation bytes', async t => {
  const { app } = await fixture(t); await capability(app, 'appsample', makeBrowserHarness({ provider: 'appsample' }).adapter.capability);
  const base = path.join(app, 'src/transfer/providers/appsample');
  for (const name of ['adapter.js', 'normalize.js']) await fs.writeFile(path.join(base, name), 'module.exports = {};');
  const result = check(app); assert.equal(result.status, 1);
  // Structurally valid made-up proof is not the curated capability in this checkout.
  assert.equal(result.body?.code, 'transfer-asset-mismatch'); assert.equal(result.body?.file, 'src/transfer/providers/appsample/capability.json');
});

test('changed bundle bytes fail deterministic comparison', async t => {
  const { app } = await fixture(t); await fs.appendFile(path.join(app, 'src/transfer/scripts/appsample-export.js'), '\n/* stale release */\n');
  const result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'transfer-script-mismatch');
});

for (const name of ['src/transfer/attachments.js', 'src/progress/backup.js', 'src/settings/settings.css', 'src/shared/i18n.js', 'assets/icon.png', 'docs/map-transfers.md']) {
  test(`missing delivery asset ${name} fails before package acceptance`, async t => {
    const { app } = await fixture(t); await fs.rm(path.join(app, name), { force: true });
    const result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'missing-transfer-asset');
  });
}

test('checker never executes packaged JavaScript or follows a packaged symlink', async t => {
  const { dir, app } = await fixture(t); const marker = path.join(dir, 'executed');
  await fs.writeFile(path.join(app, 'src/transfer/capabilities.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  let result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'transfer-asset-mismatch');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await fs.copyFile(path.join(ROOT, 'src/transfer/capabilities.js'), path.join(app, 'src/transfer/capabilities.js'));
  await fs.unlink(path.join(app, 'src/transfer/scripts/appsample-export.js'));
  await fs.symlink(path.join(ROOT, 'src/transfer/scripts/appsample-export.js'), path.join(app, 'src/transfer/scripts/appsample-export.js'));
  result = check(app); assert.equal(result.status, 1); assert.equal(result.body?.code, 'unsafe-package-path');
});

test('missing CLI path fails with a usable JSON diagnostic', () => {
  const result = check(); assert.equal(result.status, 1); assert.equal(result.body?.code, 'usage');
});

test('release globs include delivery assets and exclude developer fixtures, caches and credentials', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const filter = new FileMatcher(ROOT, '/unused-output', value => value, pkg.build.files).createFilter();
  const file = { isDirectory: () => false };
  for (const name of ['src/main.js', 'src/transfer/envelope.js', 'src/transfer/providers/hoyolab/capability.json', 'src/transfer/scripts/bwiki-import.js', 'assets/icon.png', 'src/settings/index.html', 'docs/map-transfers.md']) assert.equal(filter(path.join(ROOT, name), file), true, name);
  for (const name of ['tests/transfer/fixtures/hoyolab/progress.json', 'tools/build-transfer-scripts.js', '.superpowers/sdd/task.md', 'server/cache/transfer/catalog.json', 'found.json', 'settings.json', 'progress/local/state.json', '.env', '.aws/credentials', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron']) assert.equal(filter(path.join(ROOT, name), file), false, name);
});

test('fresh real ASAR pack/extract retains a checkable offline payload', async t => {
  const { dir, app } = await fixture(t); const archive = path.join(dir, 'app.asar'); const extracted = path.join(dir, 'extracted');
  for (const args of [['pack', app, archive], ['extract', archive, extracted]]) {
    const result = spawnSync(process.execPath, [ASAR, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  const result = check(extracted); assert.equal(result.status, 0, result.stderr); assert.equal(result.body.scripts, 10);
});
