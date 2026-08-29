import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOSURE_SNAPSHOT_V1, ClosureSnapshotIdentityListAvailability, ClosureSnapshotValidationError, validateClosureSnapshotV1 } from './nse-2024-closure-snapshot.types';

test('the accepted V1 snapshot constant validates without throwing', () => {
  assert.doesNotThrow(() => validateClosureSnapshotV1(CLOSURE_SNAPSHOT_V1));
});

test('carries the exact accepted aggregate values from the task', () => {
  assert.equal(CLOSURE_SNAPSHOT_V1.snapshotId, 'CLOSURE_SNAPSHOT_V1');
  assert.equal(CLOSURE_SNAPSHOT_V1.rawBucketOccurrences, 3433);
  assert.equal(CLOSURE_SNAPSHOT_V1.uniqueReferences, 2896);
  assert.equal(CLOSURE_SNAPSHOT_V1.crossBucketDuplicateOccurrences, 537);
  assert.equal(CLOSURE_SNAPSHOT_V1.combinedSha256, 'a75232d2ce258fd0bce136459254075236ce0d9b73decb07270a1274e03cd6ed');
  assert.equal(CLOSURE_SNAPSHOT_V1.combinedSha256.length, 64);
});

test('never fabricates the missing 2,896-reference identity list', () => {
  assert.equal(CLOSURE_SNAPSHOT_V1.identityListAvailability, ClosureSnapshotIdentityListAvailability.UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE);
  assert.equal(CLOSURE_SNAPSHOT_V1.exactRequests, null);
  assert.equal(CLOSURE_SNAPSHOT_V1.perBucketCounts, null);
  assert.equal(CLOSURE_SNAPSHOT_V1.perBucketDigests, null);
});

test('rejects arithmetic inconsistency between raw/unique/duplicate counts', () => {
  assert.throws(() => validateClosureSnapshotV1({ ...CLOSURE_SNAPSHOT_V1, rawBucketOccurrences: 9999 }), ClosureSnapshotValidationError);
});

test('rejects a malformed combinedSha256', () => {
  assert.throws(() => validateClosureSnapshotV1({ ...CLOSURE_SNAPSHOT_V1, combinedSha256: 'not-a-hash' }), ClosureSnapshotValidationError);
});

test('rejects a fabricated identity list claimed alongside UNAVAILABLE availability', () => {
  assert.throws(
    () => validateClosureSnapshotV1({ ...CLOSURE_SNAPSHOT_V1, exactRequests: ['fabricated'] }),
    ClosureSnapshotValidationError
  );
});

test('an AVAILABLE_LOCAL_ARTIFACT snapshot may legitimately carry a non-null identity list', () => {
  const withArtifact = {
    ...CLOSURE_SNAPSHOT_V1,
    identityListAvailability: ClosureSnapshotIdentityListAvailability.AVAILABLE_LOCAL_ARTIFACT,
    exactRequests: ['req-1'],
    perBucketCounts: { bucketA: 10 },
    perBucketDigests: { bucketA: 'a'.repeat(64) },
  };
  assert.doesNotThrow(() => validateClosureSnapshotV1(withArtifact));
});
