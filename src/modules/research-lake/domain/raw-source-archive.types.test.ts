import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_2024_PILOT_REFERENCES,
  RawSourceApplicabilityBasis,
  RawSourceApplicabilityDomain,
  RawSourceLifecycleStatus,
  RawSourceManifestValidationError,
  RawSourceRole,
  RawSourceUrlReviewStatus,
  ReviewedRawSourceManifestEntry,
  assertExact2024PilotReferenceSet,
  assertExactReferenceSet,
  isValidRawSourceReference,
  validateReviewedRawSourceManifest,
} from './raw-source-archive.types';

function baseEntry(overrides: Partial<ReviewedRawSourceManifestEntry> = {}): ReviewedRawSourceManifestEntry {
  return {
    reference: 'NSE/CMTR/59722',
    urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT,
    sourceUrl: null,
    primaryDepartment: 'Capital Market Segment',
    circularReference: '154/2023',
    publicationDate: '2023-12-12',
    subject: 'Trading holidays for the calendar year 2024',
    applicableSegments: [{ domain: RawSourceApplicabilityDomain.EQUITY, basis: RawSourceApplicabilityBasis.DIRECT }],
    sourceRole: RawSourceRole.ANNUAL_HOLIDAY_CIRCULAR,
    lifecycleStatus: RawSourceLifecycleStatus.FINAL,
    withdraws: [],
    withdrawnBy: null,
    supersedes: [],
    supersededBy: null,
    notes: null,
    ...overrides,
  };
}

function baseManifest(entries: ReviewedRawSourceManifestEntry[] = [baseEntry()]) {
  return { manifestSchemaVersion: 1, pilotId: 'TEST-PILOT', calendarYear: 2024, entries };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected RawSourceManifestValidationError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof RawSourceManifestValidationError, `Expected RawSourceManifestValidationError, got ${error}`);
    assert.equal((error as RawSourceManifestValidationError).code, code);
  }
}

test('isValidRawSourceReference accepts the expected shape and rejects malformed strings', () => {
  assert.equal(isValidRawSourceReference('NSE/MSD/60340'), true);
  assert.equal(isValidRawSourceReference('NSE/msd/60340'), false);
  assert.equal(isValidRawSourceReference('MSD/60340'), false);
  assert.equal(isValidRawSourceReference('NSE/MSD/'), false);
  assert.equal(isValidRawSourceReference(''), false);
  assert.equal(isValidRawSourceReference(42), false);
});

test('(33) reference/path sanitization: a path-traversal-shaped reference is rejected, never sanitized/accepted', () => {
  assert.equal(isValidRawSourceReference('NSE/../../etc/passwd'), false);
  assert.equal(isValidRawSourceReference('NSE/MSD/../60340'), false);
  assert.equal(isValidRawSourceReference('NSE/MSD/60340/../../secret'), false);
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ reference: 'NSE/../../etc/passwd' })])), 'INVALID_REFERENCE');
});

test('a valid manifest parses successfully', () => {
  const manifest = validateReviewedRawSourceManifest(baseManifest());
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].reference, 'NSE/CMTR/59722');
});

test('rejects an unsupported schema version', () => {
  expectCode(() => validateReviewedRawSourceManifest({ ...baseManifest(), manifestSchemaVersion: 99 }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('rejects a malformed reference', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ reference: 'BAD-REF' })])), 'INVALID_REFERENCE');
});

test('rejects a duplicate reference', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry(), baseEntry()])), 'DUPLICATE_REFERENCE');
});

test('a PENDING entry with a non-null sourceUrl is rejected', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf' })])), 'PENDING_ENTRY_WITH_URL');
});

test('a REVIEWED entry without a sourceUrl is rejected', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ urlReviewStatus: RawSourceUrlReviewStatus.REVIEWED, sourceUrl: null })])), 'REVIEWED_ENTRY_WITHOUT_URL');
});

test('a REVIEWED entry with a sourceUrl parses successfully', () => {
  const manifest = validateReviewedRawSourceManifest(
    baseManifest([baseEntry({ urlReviewStatus: RawSourceUrlReviewStatus.REVIEWED, sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf' })])
  );
  assert.equal(manifest.entries[0].sourceUrl, 'https://nsearchives.nseindia.com/content/circulars/x.pdf');
});

test('rejects an invalid publicationDate format', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ publicationDate: '12-12-2023' })])), 'INVALID_PUBLICATION_DATE');
});

test('rejects an empty subject', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ subject: '' })])), 'INVALID_SUBJECT');
});

test('rejects an unrecognized sourceRole/lifecycleStatus', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ sourceRole: 'NOT_A_ROLE' as RawSourceRole })])), 'INVALID_SOURCE_ROLE');
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ lifecycleStatus: 'NOT_A_STATUS' as RawSourceLifecycleStatus })])), 'INVALID_LIFECYCLE_STATUS');
});

test('rejects an empty applicableSegments array', () => {
  expectCode(() => validateReviewedRawSourceManifest(baseManifest([baseEntry({ applicableSegments: [] })])), 'INVALID_APPLICABILITY');
});

test('assertExact2024PilotReferenceSet accepts exactly the 16 expected references and rejects any deviation', () => {
  assert.equal(EXPECTED_2024_PILOT_REFERENCES.length, 16);

  const fullManifest = validateReviewedRawSourceManifest(baseManifest(EXPECTED_2024_PILOT_REFERENCES.map((reference) => baseEntry({ reference }))));
  assert.doesNotThrow(() => assertExact2024PilotReferenceSet(fullManifest));

  const missingOne = validateReviewedRawSourceManifest(baseManifest(EXPECTED_2024_PILOT_REFERENCES.slice(1).map((reference) => baseEntry({ reference }))));
  assert.throws(() => assertExact2024PilotReferenceSet(missingOne), RawSourceManifestValidationError);

  const extraOne = validateReviewedRawSourceManifest(
    baseManifest([...EXPECTED_2024_PILOT_REFERENCES.map((reference) => baseEntry({ reference })), baseEntry({ reference: 'NSE/CMTR/99999' })])
  );
  assert.throws(() => assertExact2024PilotReferenceSet(extraOne), RawSourceManifestValidationError);
});

test('(B-F7A-SOURCE-EVIDENCE-1) assertExactReferenceSet is the generic form -- works against an arbitrary expected set, not just the 2024 pilot list', () => {
  const expected = ['NSE/CMTR/50560', 'NSE/CMTR/54023'];
  const exact = validateReviewedRawSourceManifest(baseManifest(expected.map((reference) => baseEntry({ reference }))));
  assert.doesNotThrow(() => assertExactReferenceSet(exact, expected, '2022 EQUITY manifest'));

  const missingOne = validateReviewedRawSourceManifest(baseManifest([baseEntry({ reference: 'NSE/CMTR/50560' })]));
  assert.throws(() => assertExactReferenceSet(missingOne, expected, '2022 EQUITY manifest'), RawSourceManifestValidationError);

  const extraOne = validateReviewedRawSourceManifest(baseManifest([...expected.map((reference) => baseEntry({ reference })), baseEntry({ reference: 'NSE/CMTR/99999' })]));
  assert.throws(() => assertExactReferenceSet(extraOne, expected, '2022 EQUITY manifest'), RawSourceManifestValidationError);
});
