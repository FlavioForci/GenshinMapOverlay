'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTransfer } = require('./helpers');
const { parseTransfer, validateTransfer, serializeTransfer, digestTransfer, TransferValidationError } = require('../../src/transfer/envelope');
const row = (id = 'opaque/42') => ({ id, map: 'appsample:gim:2', category: null, level: null, state: true, position: null });
const envelope = () => makeTransfer({ records: [row()] });
const bytes = value => new TextEncoder().encode(JSON.stringify(value));

test('codec detaches data, accepts Uint8Arrays and collapses only identical duplicates', () => {
  const value = envelope(); value.records.push(row());
  const valid = validateTransfer(value);
  assert.equal(valid.records.length, 1);
  value.records[0].state = false;
  assert.equal(valid.records[0].state, true);
  assert.deepEqual(parseTransfer(serializeTransfer(valid)), valid);
  assert.deepEqual(parseTransfer(bytes(valid)), valid);
});

test('conflicting duplicate identity invalidates its records atomically', () => {
  const value = envelope(); value.records.push({ ...row(), state: false });
  assert.throws(() => validateTransfer(value), error => error instanceof TransferValidationError && error.code === 'invalid-transfer' && error.invalidCount === 2);
});

test('distinct invalid records aggregate with at most 100 safe issues', () => {
  const value = envelope(); value.records = Array.from({ length: 150 }, (_, i) => ({ ...row(String(i)), state: 'secret input' }));
  assert.throws(() => validateTransfer(value), error => {
    assert.equal(error.invalidCount, 150); assert.ok(error.issues.length <= 100);
    assert.ok(error.issues.every(issue => Number.isInteger(issue.recordIndex) && typeof issue.code === 'string'));
    assert.equal(JSON.stringify(error).includes('secret input'), false); return true;
  });
});

for (const [label, mutate] of [
  ['nonboolean', e => { e.records[0].state = 1; }],
  ['NaN', e => { e.records[0].position = { x: NaN, y: 0, space: 'world' }; }],
  ['infinity', e => { e.records[0].position = { x: 0, y: Infinity, space: 'world' }; }],
  ['coordinate magnitude', e => { e.records[0].position = { x: 1e12 + 1, y: 0, space: 'world' }; }],
  ['wrong record scope', e => { e.records[0].map = 'other'; }],
  ['missing category', e => { delete e.records[0].category; }],
  ['token', e => { e.records[0].token = 'private'; }],
  ['path', e => { e.path = '/private/save'; }],
  ['nested extra evidence', e => { e.records[0].mappingEvidence = { namespace: 'appsample:gim:2', id: '42', mappingVersion: '1', token: 'x'.repeat(10000) }; }],
  ['wrong evidence namespace', e => { e.records[0].mappingEvidence = { namespace: 'other', id: '42', mappingVersion: '1' }; }],
  ['evidence version limit', e => { e.records[0].mappingEvidence = { namespace: 'appsample:gim:2', id: '42', mappingVersion: 'x'.repeat(257) }; }],
  ['prototype key', e => { e.records[0] = JSON.parse('{"__proto__":{},"id":"42"}'); }],
  ['newer version', e => { e.version = 2; }],
  ['invalid timestamp', e => { e.exportedAt = 'yesterday'; }],
  ['empty string', e => { e.records[0].id = ''; }],
]) test(`strict validation rejects ${label}`, () => { const value = envelope(); mutate(value); assert.throws(() => validateTransfer(value), { code: 'invalid-transfer' }); });

test('root errors fail before record accessors and record accessors never execute', () => {
  let calls = 0; const value = envelope();
  Object.defineProperty(value.records[0], 'id', { enumerable: true, get() { calls++; throw Error('untrusted getter'); } });
  assert.throws(() => validateTransfer(value), { code: 'invalid-transfer' });
  value.version = 2;
  assert.throws(() => validateTransfer(value), error => error.invalidCount === 1 && error.issues[0].recordIndex === null);
  assert.equal(calls, 0);
});

test('UTF-8, JSON and input byte limits reject before inspecting any records', () => {
  for (const input of [new Uint8Array([255]), new TextEncoder().encode('{'), '{}']) assert.throws(() => parseTransfer(input), { code: 'invalid-transfer' });
  assert.throws(() => parseTransfer(new Uint8Array(64 * 1024 * 1024 + 1)), { code: 'transfer-too-large' });
  const input = new Uint8Array(64 * 1024 * 1024).fill(32); input.set(bytes(envelope()));
  assert.equal(parseTransfer(input).records[0].id, 'opaque/42');
});

test('declared text, coordinates and coverage limits accept boundary and reject one over', () => {
  const value = envelope(); const r = value.records[0];
  r.id = '🐉'.repeat(128); r.category = 'c'.repeat(128); r.level = 'l'.repeat(128);
  r.position = { x: 1e12, y: -1e12, space: 's'.repeat(128) };
  r.mappingEvidence = { namespace: 'appsample:gim:2', id: '9'.repeat(128), mappingVersion: 'v'.repeat(256) };
  value.producer.name = 'n'.repeat(256); value.producer.version = 'v'.repeat(256); value.adapterVersion = 'a'.repeat(256);
  value.catalog = { generation: 'g'.repeat(256), fingerprint: 'f'.repeat(256) };
  value.coverage = { categories: Array.from({ length: 4096 }, (_, i) => String(i)), levels: Array.from({ length: 4096 }, (_, i) => String(i)), complete: true };
  assert.equal(validateTransfer(value).records[0].id, r.id);
  for (const field of ['id', 'category', 'level']) { const bad = structuredClone(value); bad.records[0][field] += 'a'; assert.throws(() => validateTransfer(bad)); }
  for (const field of ['categories', 'levels']) { const bad = structuredClone(value); bad.coverage[field].push('extra'); assert.throws(() => validateTransfer(bad)); }
  const bad = structuredClone(value); bad.producer.name += 'a'; assert.throws(() => validateTransfer(bad));
});

test('record bound counts source entries before duplicate collapse', () => {
  const value = makeTransfer({ records: Array(250000).fill(row()) });
  assert.equal(validateTransfer(value).records.length, 1);
  value.records.push(row()); assert.throws(() => validateTransfer(value), { code: 'invalid-transfer' });
});

test('digest ignores time, producer, record and coverage ordering but includes scope and observations', async () => {
  const a = envelope(); a.records.push(row('other')); a.coverage.categories = ['b', 'a'];
  const b = structuredClone(a); b.records.reverse(); b.coverage.categories.reverse(); b.exportedAt = '2020-01-01T00:00:00.000Z'; b.producer.name = 'another';
  assert.match(await digestTransfer(a), /^[0-9a-f]{64}$/);
  assert.equal(await digestTransfer(a), await digestTransfer(b));
  b.records[0].state = false; assert.notEqual(await digestTransfer(a), await digestTransfer(b));
});

test('duplicate counts survive validation without adding fields to serialized envelopes', () => {
  const { getTransferDuplicateCount } = require('../../src/transfer/envelope');
  const value = envelope(); value.records.push(row(), row(), row('other'));
  const parsed = parseTransfer(bytes(value));
  assert.equal(getTransferDuplicateCount(parsed), 2);
  assert.equal(getTransferDuplicateCount(validateTransfer(parsed)), 2);
  assert.equal(getTransferDuplicateCount(value), 2);
  assert.equal(getTransferDuplicateCount(parseTransfer(serializeTransfer(parsed))), 0);
  assert.equal(Object.keys(parsed).includes('duplicates'), false);
});

for (const [label, read, write, maximum] of [
  ['record ID', e => e.records[0].id, (e, v) => { e.records[0].id = v; }, 128],
  ['map scope', e => e.map, (e, v) => { e.map = v; e.records[0].map = v; }, 128],
  ['category', e => e.records[0].category, (e, v) => { e.records[0].category = v; }, 128],
  ['level', e => e.records[0].level, (e, v) => { e.records[0].level = v; }, 128],
  ['space', e => e.records[0].position.space, (e, v) => { e.records[0].position.space = v; }, 128],
  ['evidence ID', e => e.records[0].mappingEvidence.id, (e, v) => { e.records[0].mappingEvidence.id = v; }, 128],
  ['evidence version', e => e.records[0].mappingEvidence.mappingVersion, (e, v) => { e.records[0].mappingEvidence.mappingVersion = v; }, 256],
  ['producer name', e => e.producer.name, (e, v) => { e.producer.name = v; }, 256],
  ['producer version', e => e.producer.version, (e, v) => { e.producer.version = v; }, 256],
  ['adapter version', e => e.adapterVersion, (e, v) => { e.adapterVersion = v; }, 256],
  ['catalog generation', e => e.catalog.generation, (e, v) => { e.catalog.generation = v; }, 256],
  ['catalog fingerprint', e => e.catalog.fingerprint, (e, v) => { e.catalog.fingerprint = v; }, 256],
]) test(`${label} counts Unicode code points and rejects empty or one over`, () => {
  const value = envelope(); value.records[0].position = { x: 0, y: 0, space: 'world' };
  value.records[0].mappingEvidence = { namespace: 'appsample:gim:2', id: '42', mappingVersion: '1' };
  write(value, '🐉'.repeat(maximum)); assert.equal(read(validateTransfer(value)), '🐉'.repeat(maximum));
  for (const invalid of ['', '🐉'.repeat(maximum + 1)]) { write(value, invalid); assert.throws(() => validateTransfer(value), { code: 'invalid-transfer' }); }
});

test('a deceptive evidence ID is preserved as a hint and cannot alter source identity', () => {
  const value = envelope(); value.records[0].mappingEvidence = { namespace: 'appsample:gim:2', id: '999', mappingVersion: 'forged-current' };
  const valid = validateTransfer(value);
  assert.equal(valid.records[0].id, 'opaque/42'); assert.equal(valid.records[0].mappingEvidence.id, '999');
  assert.equal(Object.hasOwn(valid.records[0], 'canonicalId'), false);
});

test('serialization rejects a valid-shape transfer whose encoded body exceeds 64 MiB', () => {
  const text = '🐉'.repeat(128);
  const value = makeTransfer({ records: Array.from({ length: 45000 }, (_, i) => ({ ...row(String(i)), category: text, level: text, position: { x: 0, y: 0, space: text } })) });
  assert.throws(() => serializeTransfer(value), { code: 'transfer-too-large' });
});

test('conflicting duplicate groups count every original observation once', () => {
  const value = makeTransfer({ records: Array.from({ length: 10000 }, (_, i) => ({ ...row('same'), state: i === 0 })) });
  assert.throws(() => validateTransfer(value), error => error.invalidCount === 10000 && error.issues.length === 100);
});

test('timestamps require real calendar dates and accept explicit ISO offsets', () => {
  const value = envelope(); value.exportedAt = '2026-02-30T12:00:00.000Z';
  assert.throws(() => validateTransfer(value), { code: 'invalid-transfer' });
  value.exportedAt = '2026-10-25T12:00:00+02:00'; assert.equal(validateTransfer(value).exportedAt, value.exportedAt);
});
