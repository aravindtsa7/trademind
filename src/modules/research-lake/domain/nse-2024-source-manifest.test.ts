import assert from 'node:assert/strict';
import test from 'node:test';
import manifestJson from './data/nse-2024-source-manifest.json';
import { EXPECTED_2024_PILOT_REFERENCES, RawSourceLifecycleStatus, RawSourceUrlReviewStatus, validateReviewedRawSourceManifest } from './raw-source-archive.types';
import { validateRawSourceLifecycleGraph } from './raw-source-lifecycle-graph';
import { buildProposed2024DraftCalendarMappingOutline } from './proposed-2024-draft-calendar-mapping';

/**
 * End-to-end tests for the actual checked-in reviewed 2024 pilot manifest
 * (task section 17 tests 1-5, 21, 27-30). Loads the real JSON artifact --
 * never a synthetic stand-in -- so a future accidental edit to the manifest
 * is caught here.
 */

test('(1) the reviewed 2024 manifest parses successfully', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  assert.equal(manifest.pilotId, 'B-F7A-ARCHIVE-1-2024-PILOT');
  assert.equal(manifest.calendarYear, 2024);
});

test('(2) exactly 16 source entries exist', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  assert.equal(manifest.entries.length, 16);
});

test('(3) all references are unique', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const references = manifest.entries.map((entry) => entry.reference);
  assert.equal(new Set(references).size, references.length);
});

test('(4) all expected source refs are present', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const references = new Set(manifest.entries.map((entry) => entry.reference));
  for (const expected of EXPECTED_2024_PILOT_REFERENCES) {
    assert.ok(references.has(expected), `Expected reference '${expected}' to be present in the manifest.`);
  }
});

test('(21) the Jan-20 lifecycle graph embedded in the real manifest validates', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  assert.doesNotThrow(() => validateRawSourceLifecycleGraph(manifest.entries));
});

test('(27/28/29) MSD/60340 withdraws exactly the three Jan-20 predecessors, which remain present and it alone is FINAL', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const byReference = new Map(manifest.entries.map((entry) => [entry.reference, entry]));

  const finalEntry = byReference.get('NSE/MSD/60340')!;
  assert.equal(finalEntry.lifecycleStatus, RawSourceLifecycleStatus.FINAL);
  assert.deepEqual([...finalEntry.withdraws].sort(), ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318']);

  for (const predecessor of ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318']) {
    const entry = byReference.get(predecessor);
    assert.ok(entry, `Expected withdrawn predecessor '${predecessor}' to remain present in the manifest.`);
    assert.equal(entry!.lifecycleStatus, RawSourceLifecycleStatus.WITHDRAWN);
    assert.equal(entry!.withdrawnBy, 'NSE/MSD/60340');
  }
});

test('(30) the raw manifest never reuses/aliases a normalized sourceBundleChecksum-shaped field as a raw PDF hash', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    assert.ok(!('sourceBundleChecksum' in entry), `Entry '${entry.reference}' must not carry a sourceBundleChecksum field.`);
    assert.ok(!('contentChecksumSha256' in entry), `Entry '${entry.reference}' must not carry the normalized layer's contentChecksumSha256 field.`);
  }
});

test('(FIX-1 Defect A) every entry is now REVIEWED with a non-null sourceUrl -- the pilot manifest is executable', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    assert.equal(entry.urlReviewStatus, RawSourceUrlReviewStatus.REVIEWED);
    assert.ok(typeof entry.sourceUrl === 'string' && entry.sourceUrl.startsWith('https://nsearchives.nseindia.com/content/circulars/'));
  }
});

test('(31) the static reviewed manifest carries no runtime retrieval timestamp field -- re-validating it is byte-for-byte deterministic', () => {
  const raw = JSON.stringify(manifestJson);
  assert.ok(!/retrievedAt|generatedAt|archivedAt/i.test(raw), 'The static reviewed manifest must never embed a runtime retrieval/generation timestamp.');

  const first = validateReviewedRawSourceManifest(manifestJson);
  const second = validateReviewedRawSourceManifest(manifestJson);
  assert.deepEqual(first, second);
});

test('the proposed DRAFT calendar mapping builds cleanly from the real manifest and cites only FINAL references', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const proposal = buildProposed2024DraftCalendarMappingOutline(manifest);
  assert.equal(proposal.annualHolidays.length, 13);
  assert.equal(proposal.exceptionalClosures.length, 3);
  assert.equal(proposal.specialSessions.length, 4);
  const jan20 = proposal.specialSessions.find((session) => session.tradingDate === '2024-01-20')!;
  assert.deepEqual(jan20.supportingReferences, ['NSE/MSD/60340']);
  assert.deepEqual([...jan20.historicalReferences].sort(), ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318']);
});
