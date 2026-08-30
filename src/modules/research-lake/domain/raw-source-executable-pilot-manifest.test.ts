import assert from 'node:assert/strict';
import test from 'node:test';
import manifestJson from './data/nse-2024-source-manifest.json';
import { validateReviewedRawSourceManifest, RawSourceUrlReviewStatus, ReviewedRawSourceManifestEntry } from './raw-source-archive.types';
import { EXPECTED_2024_PILOT_REFERENCES, RawSourceManifestValidationError } from './raw-source-archive.types';
import { assertExecutable2024PilotManifestComplete, assertExecutableManifestComplete, ExecutablePilotManifestValidationError } from './raw-source-executable-pilot-manifest';
import { assertUrlBindsToReference } from './raw-source-manifest-url-binding';

function withEntry(manifest: ReturnType<typeof validateReviewedRawSourceManifest>, reference: string, overrides: Partial<ReviewedRawSourceManifestEntry>) {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.reference === reference ? { ...entry, ...overrides } : entry)),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected ExecutablePilotManifestValidationError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof ExecutablePilotManifestValidationError, `Expected ExecutablePilotManifestValidationError, got ${error}`);
    assert.equal((error as ExecutablePilotManifestValidationError).code, code);
  }
}

test('(1) the real checked-in 2024 manifest is a complete, executable pilot manifest', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  assert.doesNotThrow(() => assertExecutable2024PilotManifestComplete(manifest));
});

test('(2) all 16 source URLs are non-null and REVIEWED', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    assert.equal(entry.urlReviewStatus, RawSourceUrlReviewStatus.REVIEWED);
    assert.ok(typeof entry.sourceUrl === 'string' && entry.sourceUrl.length > 0);
  }
});

test('(3) every URL binds to its declared reference (via the real production binding rule -- accepts either the direct .pdf form or, for NSE/CMTR/60338, the real official .zip form)', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    assert.doesNotThrow(() => assertUrlBindsToReference(entry.reference, entry.sourceUrl!), `Entry '${entry.reference}' URL '${entry.sourceUrl}' must bind to its own reference.`);
  }
});

test('(B-F7A-SOURCE-EVIDENCE-FIX-1 Terra Defect D) NSE/CMTR/60338 declares its real official .zip URL, not the never-live-verified .pdf guess', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const entry = manifest.entries.find((candidate) => candidate.reference === 'NSE/CMTR/60338')!;
  assert.equal(entry.sourceUrl, 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip');
});

test('(5) all primaryDepartment values are populated', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    assert.ok(entry.primaryDepartment && entry.primaryDepartment.trim().length > 0, `Entry '${entry.reference}' must have a non-empty primaryDepartment.`);
  }
});

test('(6) exact Jan-22 subjects are preserved on both accepted entries', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const expected = 'Trading Holiday on January 22, 2024 on account of Holiday declared under Negotiable Instrument Act';
  const cmtr = manifest.entries.find((entry) => entry.reference === 'NSE/CMTR/60338')!;
  const faop = manifest.entries.find((entry) => entry.reference === 'NSE/FAOP/60337')!;
  assert.equal(cmtr.subject, expected);
  assert.equal(faop.subject, expected);
});

test('(4) a URL/reference mismatch is rejected', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const mismatched = withEntry(manifest, 'NSE/MSD/60340', { sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60318.pdf' });
  expectCode(() => assertExecutable2024PilotManifestComplete(mismatched), 'URL_REFERENCE_MISMATCH');
});

test('(7) reviewed pilot validation fails on a null/PENDING URL', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const pending = withEntry(manifest, 'NSE/MSD/60340', { urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT, sourceUrl: null });
  expectCode(() => assertExecutable2024PilotManifestComplete(pending), 'ENTRY_NOT_REVIEWED');
});

test('(8) reviewed pilot validation fails on a missing primaryDepartment', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const missingDept = withEntry(manifest, 'NSE/CMTR/60338', { primaryDepartment: null });
  expectCode(() => assertExecutable2024PilotManifestComplete(missingDept), 'MISSING_PRIMARY_DEPARTMENT');
});

test('(B-F7A-SOURCE-EVIDENCE-1) assertExecutableManifestComplete is a generic gate that accepts an arbitrary expected reference set, not just the hardcoded 2024 pilot list', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  assert.doesNotThrow(() => assertExecutableManifestComplete(manifest, EXPECTED_2024_PILOT_REFERENCES, 'generic-form 2024 pilot'));
  assert.throws(
    () => assertExecutableManifestComplete(manifest, ['NSE/CMTR/59722'], 'wrong expected set'),
    (error: unknown) => error instanceof RawSourceManifestValidationError && error.code === 'INVALID_MANIFEST_SHAPE'
  );
});

test('the generic schema validator still legitimately accepts a PENDING draft entry (executable-pilot completeness is a separate, stricter gate)', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const draftLike = withEntry(manifest, 'NSE/MSD/60340', { urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT, sourceUrl: null });
  assert.doesNotThrow(() => validateReviewedRawSourceManifest(draftLike));
  assert.throws(() => assertExecutable2024PilotManifestComplete(draftLike), ExecutablePilotManifestValidationError);
});
