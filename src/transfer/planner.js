'use strict';
const { validateTransfer, getTransferDuplicateCount, TRANSFER_LIMITS } = require('./envelope');
const { validateAttachments } = require('./attachments');
const { matchRecords, reverseIds } = require('./mapping');
const NAMESPACE = 'appsample:gim:2';
/** @typedef {{matched:number,alreadyFound:number,ambiguous:number,unsupported:number,unknown:number,invalid:number,ignoredNotFound:number,duplicates:number}} Counts */
/** @typedef {{format:'genshin-map-overlay.transfer-report',version:1,provider:string,map:string,counts:Counts,coverage:import('./envelope').TransferEnvelope['coverage'],decisions:import('./mapping').MappingDecision[]}} TransferReport */
const counts = () => ({ matched: 0, alreadyFound: 0, ambiguous: 0, unsupported: 0, unknown: 0, invalid: 0, ignoredNotFound: 0, duplicates: 0 });
const rejected = (sourceId, reason) => ({ sourceId, status: 'unsupported', canonicalId: null, confidence: null, mappingVersion: null, reason });
function authorized(record, mapping, decision) {
  const evidence = record.mappingEvidence;
  if (evidence && (decision.status !== 'matched' || evidence.namespace !== NAMESPACE || evidence.id !== decision.canonicalId || evidence.mappingVersion !== decision.mappingVersion)) return false;
  return !mapping || (decision.status === 'matched' && mapping.canonicalId === decision.canonicalId && mapping.confidence === decision.confidence && mapping.mappingVersion === decision.mappingVersion);
}
function envelopeFor(provider, map, catalog, records, metadata) {
  return { format: 'genshin-map-overlay.transfer', version: 1, ...metadata, provider, map, catalog, coverage: { categories: [], levels: [], complete: false }, records };
}
/** Pure additive import plan. False/missing observations never clear a register.
 * @param {import('./envelope').TransferEnvelope} envelope @param {import('../progress/schema').Profile} profile
 * @param {import('./catalog').CanonicalCatalog} catalog @param {import('./mapping').MappingPack|null} pack
 * @returns {{decisions:import('./mapping').MappingDecision[],foundIds:string[],attachment:import('./attachments').ProfileAttachment,counts:Counts}}
 */
function planImport(envelope, profile, catalog, pack) {
  // WeakMap duplicate metadata belongs to the original object, not a structured clone.
  const duplicates = getTransferDuplicateCount(envelope);
  const input = validateTransfer(envelope);
  const matches = matchRecords(input, catalog, pack);
  const totals = counts(); totals.duplicates = duplicates;
  const found = new Set(); const records = [];
  const decisions = matches.map((match, i) => {
    const record = input.records[i];
    const decision = authorized(record, null, match) ? match : rejected(record.id, 'unverified-provenance');
    if (!record.state) totals.ignoredNotFound++;
    else if (decision.status === 'matched') {
      if (profile.markers[decision.canonicalId]?.value === true) totals.alreadyFound++;
      else { totals.matched++; found.add(decision.canonicalId); }
    } else totals[decision.status]++;
    records.push({ provider: input.provider, map: input.map, catalog: input.catalog, record, mapping: decision.status === 'matched' ? { canonicalId: decision.canonicalId, confidence: decision.confidence, mappingVersion: decision.mappingVersion } : null });
    return decision;
  });
  return { decisions, foundIds: [...found].sort(), attachment: { version: 1, records, imports: [] }, counts: totals };
}
/** Export canonical truths using currently authorized original IDs, then reviewed reverse IDs.
 * Reports use canonical decision IDs. Counts additionally include genuinely unmapped retained
 * source observations (unknown/ignoredNotFound), which have no canonical decision identity.
 * @param {import('../progress/schema').Profile} profile @param {import('./attachments').ProfileAttachment|undefined} attachment
 * @param {{provider:string,map:string,catalog:import('./catalog').CanonicalCatalog,pack:import('./mapping').MappingPack|null,metadata:{producer:{name:string,version:string},exportedAt:string,adapterVersion:string}}} options
 * @returns {{envelope:import('./envelope').TransferEnvelope,report:TransferReport}}
 */
function planExport(profile, attachment, { provider, map, catalog, pack, metadata }) {
  const retained = attachment ? validateAttachments({ p: attachment }, ['p']).p.records.filter(row => row.provider === provider && row.map === map) : [];
  const groups = new Map();
  for (const row of retained) {
    const key = JSON.stringify(row.catalog);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const totals = counts(), records = new Map(), originals = new Map(), blocked = new Set();
  // Match each source/catalog group once, including false metadata as hypothetical
  // truths solely for provenance authorization. They remain false observations.
  for (const rows of groups.values()) {
    const matches = matchRecords(envelopeFor(provider, map, rows[0].catalog, rows.map(row => ({ ...row.record, state: true })), metadata), catalog, pack);
    rows.forEach((row, i) => {
      const match = matches[i];
      if (!authorized(row.record, row.mapping, match)) { totals.unsupported++; blocked.add(row.record.id); return; }
      // A later catalog match is not an import or an undo. A genuinely unknown
      // observation stays pass-through until an explicit canonical register exists.
      const canonicalOverride = row.mapping !== null || row.record.mappingEvidence || Object.hasOwn(profile.markers, match.canonicalId);
      if (match.status === 'matched' && canonicalOverride) {
        if (!originals.has(match.canonicalId)) originals.set(match.canonicalId, []);
        originals.get(match.canonicalId).push({ row, match });
        if (!profile.markers[match.canonicalId]?.value && !row.record.state) records.set(row.record.id, row.record);
      } else {
        totals[row.record.state ? 'unknown' : 'ignoredNotFound']++;
        records.set(row.record.id, row.record);
      }
    });
  }
  const found = Object.keys(profile.markers).filter(id => profile.markers[id].value === true).sort();
  const exact = provider === 'appsample' && map === NAMESPACE;
  const compatiblePack = pack && pack.provider === provider && pack.map === map ? pack : null;
  const reverse = compatiblePack && !exact ? reverseIds(found, catalog, compatiblePack).ids : [];
  const sourceById = new Map(compatiblePack?.sourceMarkers.map(row => [row.id, row]) || []);
  const reverseRecords = reverse.map(id => {
    const source = sourceById.get(id);
    return { id, map, category: source?.category ?? null, level: source?.level ?? null, state: true, position: source ? { x: source.x, y: source.y, space: source.space || compatiblePack.sourceCoordinateSpace } : null };
  });
  const targetById = new Map(catalog.markers.map(row => [row.id, row]));
  if (exact) for (const id of found) if (targetById.has(id)) {
    const marker = targetById.get(id);
    reverseRecords.push({ id, map, category: marker.category, level: marker.level, state: true, position: null });
  }
  // 'reviewed-mapping' names app mapping metadata, never a deployed site
  // generation. Without a pack, no native catalog may be inferred from record order.
  const outputCatalog = exact ? { generation: NAMESPACE, fingerprint: catalog.fingerprint }
    : compatiblePack ? { generation: 'reviewed-mapping', fingerprint: compatiblePack.sourceCatalogFingerprint }
      : groups.size === 1 ? { ...retained[0].catalog } : { generation: 'unverified', fingerprint: 'unverified' };
  const reverseMatches = matchRecords(envelopeFor(provider, map, outputCatalog, reverseRecords, metadata), catalog, compatiblePack);
  const reverseByCanonical = new Map();
  reverseMatches.forEach((match, i) => { if (match.status === 'matched' && !blocked.has(reverseRecords[i].id)) reverseByCanonical.set(match.canonicalId, { row: { record: reverseRecords[i] }, match }); });
  const considered = [...new Set([...found, ...originals.keys()])].sort();
  const decisions = considered.map(id => {
    if (profile.markers[id]?.value !== true) {
      totals.ignoredNotFound++;
      return { sourceId: id, status: 'unsupported', canonicalId: id, confidence: null, mappingVersion: null, reason: 'canonical-not-found' };
    }
    const original = originals.get(id)?.sort((a, b) => a.row.record.id.localeCompare(b.row.record.id))[0];
    const selected = original || reverseByCanonical.get(id);
    if (!selected) { totals.unknown++; return { sourceId: id, status: 'unknown', canonicalId: null, confidence: null, mappingVersion: null, reason: 'reverse-mapping-unavailable' }; }
    const { match } = selected;
    records.set(selected.row.record.id, { ...selected.row.record, state: true, mappingEvidence: { namespace: NAMESPACE, id, mappingVersion: match.mappingVersion } });
    totals.matched++;
    return { ...match, sourceId: id };
  });
  const envelope = validateTransfer(envelopeFor(provider, map, outputCatalog, [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), metadata));
  const coverageValues = key => { const values = [...new Set(envelope.records.map(r => r[key]).filter(v => v !== null))].sort(); return values.length <= TRANSFER_LIMITS.COVERAGE ? values : []; };
  envelope.coverage = { categories: coverageValues('category'), levels: coverageValues('level'), complete: false };
  return { envelope: validateTransfer(envelope), report: { format: 'genshin-map-overlay.transfer-report', version: 1, provider, map, counts: totals, coverage: envelope.coverage, decisions } };
}
module.exports = { planImport, planExport };
