'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAttachments, mergeAttachment } = require('../../src/transfer/attachments');
const { PROFILE_A, PROFILE_B } = require('../progress/helpers');
const retained = (id = 'absent-from-current-catalog') => ({ provider: 'bwiki', map: 'unsupported-realm', catalog: { generation: 'old', fingerprint: 'opaque' }, record: { id, map: 'unsupported-realm', category: null, level: null, state: true, position: null }, mapping: null });
const attachment = () => ({ version: 1, records: [retained()], imports: [] });
const receipt = () => ({ digest: 'a'.repeat(64), provider: 'bwiki', map: 'unsupported-realm', counts: { matched: 0, alreadyFound: 0, ambiguous: 0, unsupported: 1, unknown: 0, invalid: 0, ignoredNotFound: 0, duplicates: 0 }, createdProfile: false });

test('unknown IDs and realms survive detached attachments without acquiring evidence authority', () => {
  const a = attachment(); a.records[0].record.mappingEvidence = { namespace: 'appsample:gim:2', id: '42', mappingVersion: 'deceptive' };
  const result = validateAttachments({ [PROFILE_A]: a }, [PROFILE_A]);
  assert.equal(result[PROFILE_A].records[0].record.id, 'absent-from-current-catalog');
  assert.equal(result[PROFILE_A].records[0].mapping, null);
  a.records[0].record.id = 'mutated'; assert.equal(result[PROFILE_A].records[0].record.id, 'absent-from-current-catalog');
});

test('merge replaces later source observations and preserves unrelated records without timestamps', () => {
  const previous = attachment(); previous.records.push(retained('other')); previous.imports = [receipt()];
  const incoming = attachment(); incoming.records[0].record.state = false; incoming.records[0].catalog.generation = 'older-looking';
  incoming.imports = [receipt()];
  const merged = mergeAttachment(previous, incoming);
  assert.equal(merged.records.length, 2); assert.equal(merged.records.find(r => r.record.id === 'absent-from-current-catalog').record.state, false);
  assert.equal(previous.records[0].record.state, true);
  assert.equal(mergeAttachment(undefined, incoming).records.length, 1);
});

test('attachment counts, profile membership, versions and exact nested schemas are strict', () => {
  for (const mutate of [a => { a.version = 2; }, a => { a.token = 'x'; }, a => { a.records[0].record.map = 'other'; }, a => { a.records[0].mapping = { canonicalId: '0', confidence: 'exact', mappingVersion: '1' }; }, a => { a.imports = [{ ...receipt(), counts: { ...receipt().counts, matched: -1 } }]; }, a => { a.imports = [{ ...receipt(), path: '/private' }]; }]) {
    const a = attachment(); mutate(a); assert.throws(() => validateAttachments({ [PROFILE_A]: a }, [PROFILE_A]));
  }
  assert.throws(() => validateAttachments({ [PROFILE_B]: attachment() }, [PROFILE_A]));
  assert.throws(() => validateAttachments(JSON.parse('{"__proto__":{}}'), [PROFILE_A]));
});

test('aggregate attachment records and receipts never truncate at their bounds', () => {
  const a = attachment(); a.records = Array(250000).fill(retained()); a.imports = Array(1000).fill(receipt());
  assert.equal(validateAttachments({ [PROFILE_A]: a }, [PROFILE_A])[PROFILE_A].records.length, 1);
  assert.throws(() => validateAttachments({ [PROFILE_A]: a, [PROFILE_B]: attachment() }, [PROFILE_A, PROFILE_B]));
  a.records = [retained()]; a.imports.push(receipt());
  assert.throws(() => validateAttachments({ [PROFILE_A]: a }, [PROFILE_A]));
});

test('conflicting retained duplicates reject while exact duplicates collapse', () => {
  const a = attachment(); a.records.push(retained());
  assert.equal(validateAttachments({ [PROFILE_A]: a }, [PROFILE_A])[PROFILE_A].records.length, 1);
  a.records[1].record.state = false; assert.throws(() => validateAttachments({ [PROFILE_A]: a }, [PROFILE_A]));
});


test('receipts are bounded across profiles and merge rejects overflow without trimming history', () => {
  const a = attachment(); a.imports = Array(1000).fill(receipt());
  const b = attachment(); b.imports = [receipt()];
  assert.throws(() => validateAttachments({ [PROFILE_A]: a, [PROFILE_B]: b }, [PROFILE_A, PROFILE_B]));
  assert.throws(() => mergeAttachment(a, b));
  assert.equal(a.imports.length, 1000);
});
