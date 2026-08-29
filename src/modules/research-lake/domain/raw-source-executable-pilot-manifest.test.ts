import assert from 'node:assert/strict';
import test from 'node:test';
import manifestJson from './data/nse-2024-source-manifest.json';
import { validateReviewedRawSourceManifest, RawSourceUrlReviewStatus, ReviewedRawSourceManifestEntry } from './raw-source-archive.types';
import { assertExecutable2024PilotManifestComplete, ExecutablePilotManifestValidationError } from './raw-source-executable-pilot-manifest';

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

test('(3) every URL binds to its declared reference', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  for (const entry of manifest.entries) {
    const basename = entry.sourceUrl!.split('/').pop();
    const [, department, number] = /^NSE\/([A-Z]+)\/(\d+)$/.exec(entry.reference)!;
    assert.equal(basename, `${department}${number}.pdf`);
  }
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

test('the generic schema validator still legitimately accepts a PENDING draft entry (executable-pilot completeness is a separate, stricter gate)', () => {
  const manifest = validateReviewedRawSourceManifest(manifestJson);
  const draftLike = withEntry(manifest, 'NSE/MSD/60340', { urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT, sourceUrl: null });
  assert.doesNotThrow(() => validateReviewedRawSourceManifest(draftLike));
  assert.throws(() => assertExecutable2024PilotManifestComplete(draftLike), ExecutablePilotManifestValidationError);
});
