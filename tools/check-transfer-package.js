'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Only reviewed tools/modules in THIS checkout run. Never require/import a file
// from the extracted app: its JS is untrusted data, including package.json.main.
const { PROVIDER_IDS, validateCapability } = require('../src/transfer/capabilities');
const { validateMappingPack } = require('../src/transfer/mapping');
const { buildTransferScripts } = require('./build-transfer-scripts');
const ROOT = path.resolve(__dirname, '..');
const ASSETS = Object.freeze([
  'src/main.js', 'src/config.js', 'src/shared/i18n.js', 'src/overlay/overlay.css', 'assets/icon.png',
  ...['index.html', 'preload.js', 'settings.js', 'settings.css', 'window.js'].map(name => 'src/settings/' + name),
  ...['schema', 'atomic-file', 'repository', 'merge', 'profiles', 'migration', 'backup', 'service', 'runtime', 'ipc', 'client-barrier', 'app-lifecycle'].map(name => 'src/progress/' + name + '.js'),
  ...['envelope', 'attachments', 'catalog', 'mapping', 'spatial-index', 'capabilities', 'registry', 'planner', 'controller', 'ipc', 'runtime', 'browser/runtime', 'browser/ui'].map(name => 'src/transfer/' + name + '.js'),
  'docs/map-transfers.md',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, file) { throw Object.assign(new Error(code), { code, ...(file ? { file } : {}) }); }

/** Read a fixed relative file, rejecting symlinks at every path component. No
 * path in package JSON, capability JSON or a mapping file is followed. */
async function readFixed(root, file, missing) {
  let current = root;
  try {
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]); const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) fail('unsafe-package-path', file);
      if (i === parts.length - 1 && info.size > 4 * 1024 * 1024) fail('oversized-package-asset', file);
    }
    return await fs.readFile(current);
  } catch (error) { if (error.code === 'ENOENT') fail(missing, file); throw error; }
}
function json(bytes, code, file) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code, file); } }
async function reviewed(file, bytes) {
  const expected = await readFixed(ROOT, file, 'missing-reviewed-asset');
  if (hash(expected) !== hash(bytes)) fail('transfer-asset-mismatch', file);
}

/** Check an extracted app against this checkout. A pass proves delivery bytes
 * and curated offline capability consistency, never live browser acceptance.
 * The temporary rebuild uses reviewed code and only fixed copied inputs.
 * @param {string} directory @returns {Promise<object>}
 */
async function checkTransferPackage(directory) {
  if (typeof directory !== 'string' || !directory.length) fail('usage');
  const root = path.resolve(directory);
  let info; try { info = await fs.lstat(root); } catch { fail('invalid-package-directory'); }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('invalid-package-directory');
  const scripts = new Map();
  for (const provider of PROVIDER_IDS) for (const direction of ['export', 'import']) {
    const file = `src/transfer/scripts/${provider}-${direction}.js`;
    scripts.set(file, await readFixed(root, file, 'missing-transfer-script'));
  }
  const inputs = new Map(); const providers = [];
  for (const provider of PROVIDER_IDS) {
    const base = `src/transfer/providers/${provider}/`; const file = base + 'capability.json';
    const bytes = await readFixed(root, file, 'missing-transfer-asset');
    let capability;
    try { capability = validateCapability(json(bytes, 'invalid-capability', file)); }
    catch { fail('invalid-capability', file); }
    if (capability.provider !== provider) fail('invalid-capability', file);
    inputs.set(file, bytes);
    if (capability.status === 'supported') {
      for (const name of ['adapter.js', 'normalize.js', ...(provider === 'appsample' ? [] : ['mapping.json'])]) {
        const asset = base + name; const content = await readFixed(root, asset, 'missing-provider-asset'); inputs.set(asset, content);
        if (name === 'mapping.json') {
          try {
            const pack = validateMappingPack(json(content, 'invalid-mapping-pack', asset));
            if (pack.provider !== provider || !/^[a-f0-9]{64}$/.test(pack.canonicalCatalogFingerprint) || !capability.variants.some(v => v.evidence.pairAccepted && v.map === pack.map && v.catalogFingerprint === pack.sourceCatalogFingerprint)) fail('invalid-mapping-pack', asset);
          } catch { fail('invalid-mapping-pack', asset); }
        }
      }
    }
    providers.push({ provider, status: capability.status, reasonCode: capability.reasonCode });
  }
  for (const file of ASSETS) inputs.set(file, await readFixed(root, file, 'missing-transfer-asset'));
  // Validate package identity as JSON only. Electron-builder may prune dev-only
  // fields; do not run its main, npm scripts, dependencies or lifecycle hooks.
  const pkg = json(await readFixed(root, 'package.json', 'missing-transfer-asset'), 'invalid-package', 'package.json');
  const expectedPkg = json(await readFixed(ROOT, 'package.json', 'missing-reviewed-asset'), 'invalid-package', 'package.json');
  if (!pkg || ['name', 'version', 'main'].some(key => pkg[key] !== expectedPkg[key])) fail('invalid-package', 'package.json');
  for (const [file, bytes] of inputs) await reviewed(file, bytes);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-package-rebuild-'));
  try {
    for (const [file, bytes] of inputs) {
      const target = path.join(temporary, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
    await buildTransferScripts({ root: temporary });
    for (const [file, bytes] of scripts) if (hash(bytes) !== hash(await fs.readFile(path.join(temporary, file)))) fail('transfer-script-mismatch', file);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return { ok: true, scripts: scripts.size, assets: inputs.size, providers };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => { if (args.length !== 1) fail('usage'); return checkTransferPackage(args[0]); })
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => {
      // Never echo package-supplied text or arbitrary exception messages.
      const known = new Set(['usage', 'invalid-package-directory', 'missing-transfer-script', 'missing-transfer-asset', 'missing-provider-asset', 'missing-reviewed-asset', 'invalid-capability', 'invalid-mapping-pack', 'unsafe-package-path', 'oversized-package-asset', 'transfer-asset-mismatch', 'transfer-script-mismatch', 'invalid-package']);
      const code = known.has(error.code) ? error.code : 'package-check-failed';
      process.stdout.write(JSON.stringify({ ok: false, code, ...(known.has(error.code) && error.file ? { file: error.file } : {}) }) + '\n'); process.exitCode = 1;
    });
}
module.exports = { checkTransferPackage };
