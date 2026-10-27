'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = require.resolve('../../src/config');
  const loaded = new Module(filename, module);
  loaded.require = name => name === 'electron'
    ? { app: { getPath: () => path.join(root, 'userData') } } : require(name);
  loaded._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

test('opening settings after a preserving fresh-install read creates valid defaults', async t => {
  const config = await setup(t);
  const defaults = config.load({ preserveMalformed: true });
  await assert.rejects(fs.stat(config.filePath()), { code: 'ENOENT' });
  assert.equal(config.ensureFile(), config.filePath());
  assert.equal(await fs.readFile(config.filePath(), 'utf8'), '{}');
  assert.deepEqual(config.load({ preserveMalformed: true }), defaults);
});

for (const bytes of ['{"hotkeys":{"toggleOverlay":"F6"}}', '{broken\r\n']) {
  test(`opening settings preserves ${bytes.startsWith('{broken') ? 'malformed' : 'custom'} existing bytes`, async t => {
    const config = await setup(t);
    await fs.mkdir(path.dirname(config.filePath()), { recursive: true });
    await fs.writeFile(config.filePath(), bytes);
    config.ensureFile();
    assert.equal(await fs.readFile(config.filePath(), 'utf8'), bytes);
  });
}
