/**
 * B-F7A-ARCHIVE-1 source-discovery closure snapshot metadata (task section
 * 14). This models the AGGREGATE audit result of the prior source-discovery
 * gate ("GPT-5.6 Sol final source-closure gate" -- see the task prompt's
 * section 1), not a re-derivation of it: this implementation was never
 * handed the underlying 2,896-reference identity list, only its summary
 * counts and combined digest, so `identityListAvailability` is always
 * `UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE` here (never fabricated as if
 * the list were present -- task section 14: "Do not pretend the complete
 * 2,896 identity list exists locally unless it actually does").
 */

/** Whether the full per-reference identity list backing this snapshot's counts is available as a local artifact. Mirrors the existing `SourceAcquisitionEvidenceAvailability` convention in `dataset-manifest.types.ts` -- an explicit "unknown/unavailable" tag rather than a fabricated zero-length or complete list. */
export enum ClosureSnapshotIdentityListAvailability {
  UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE = 'UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE',
  AVAILABLE_LOCAL_ARTIFACT = 'AVAILABLE_LOCAL_ARTIFACT',
}

/**
 * `circDisplayNo -> deduplicate -> ordinal ascending sort -> LF join -> UTF-8
 * -> SHA-256` (task section 14). Versioned so a future canonicalization
 * change is an explicit, additive version bump, never a silent redefinition
 * of what `combinedSha256` means for snapshot V1.
 */
export const CLOSURE_SNAPSHOT_CANONICALIZATION_ALGORITHM_V1 = 'circDisplayNo-dedupe-ordinal-ascending-sort-lf-join-utf8-sha256-v1';

export interface ClosureSnapshotV1 {
  readonly snapshotId: 'CLOSURE_SNAPSHOT_V1';
  /** ISO 8601 date the audit was performed, in the timezone the audit itself was stated in (task section 14: "2026-08-30 IST"). */
  readonly auditDate: string;
  readonly rawBucketOccurrences: number;
  readonly uniqueReferences: number;
  readonly crossBucketDuplicateOccurrences: number;
  readonly combinedSha256: string;
  readonly canonicalizationAlgorithmVersion: string;
  /** Candidate-screen/disposition method version -- no such version identifier was provided to this milestone beyond "the accepted closure snapshot"; `null` rather than fabricated. */
  readonly candidateScreenDispositionMethodVersion: string | null;
  readonly identityListAvailability: ClosureSnapshotIdentityListAvailability;
  /** The exact 15 requests behind this snapshot. `null` under `UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE` -- never a fabricated placeholder list. */
  readonly exactRequests: readonly string[] | null;
  /** Per-bucket occurrence counts. `null` under `UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE`. */
  readonly perBucketCounts: Readonly<Record<string, number>> | null;
  /** Per-bucket digest. `null` under `UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE`. */
  readonly perBucketDigests: Readonly<Record<string, string>> | null;
}

const HEX64_PATTERN = /^[a-f0-9]{64}$/;

export class ClosureSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosureSnapshotValidationError';
  }
}

/**
 * The exact accepted V1 snapshot (task section 14's literal values). A
 * constant, not a parsed/loaded artifact -- there is nothing to load: this
 * milestone was handed the aggregate summary directly in its instructions,
 * not a separate reviewable file, so the constant IS the reviewed record.
 */
export const CLOSURE_SNAPSHOT_V1: ClosureSnapshotV1 = Object.freeze({
  snapshotId: 'CLOSURE_SNAPSHOT_V1',
  auditDate: '2026-08-30T00:00:00+05:30',
  rawBucketOccurrences: 3433,
  uniqueReferences: 2896,
  crossBucketDuplicateOccurrences: 537,
  combinedSha256: 'a75232d2ce258fd0bce136459254075236ce0d9b73decb07270a1274e03cd6ed',
  canonicalizationAlgorithmVersion: CLOSURE_SNAPSHOT_CANONICALIZATION_ALGORITHM_V1,
  candidateScreenDispositionMethodVersion: null,
  identityListAvailability: ClosureSnapshotIdentityListAvailability.UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE,
  exactRequests: null,
  perBucketCounts: null,
  perBucketDigests: null,
});

/**
 * Validates internal arithmetic/shape consistency of a closure snapshot
 * (task section 17/24-style "gate", applied here rather than left informal):
 * `uniqueReferences + crossBucketDuplicateOccurrences === rawBucketOccurrences`,
 * a well-formed `combinedSha256`, and that every "unavailable" field is
 * actually `null` when `identityListAvailability` says so (never a fabricated
 * non-null value masquerading as proof the list exists).
 */
export function validateClosureSnapshotV1(snapshot: ClosureSnapshotV1): void {
  if (snapshot.snapshotId !== 'CLOSURE_SNAPSHOT_V1') {
    throw new ClosureSnapshotValidationError(`snapshotId must be 'CLOSURE_SNAPSHOT_V1', got '${String(snapshot.snapshotId)}'.`);
  }
  if (!HEX64_PATTERN.test(snapshot.combinedSha256)) {
    throw new ClosureSnapshotValidationError(`combinedSha256 '${snapshot.combinedSha256}' is not a lowercase 64-character hex SHA-256 digest.`);
  }
  if (snapshot.uniqueReferences + snapshot.crossBucketDuplicateOccurrences !== snapshot.rawBucketOccurrences) {
    throw new ClosureSnapshotValidationError(
      `uniqueReferences (${snapshot.uniqueReferences}) + crossBucketDuplicateOccurrences (${snapshot.crossBucketDuplicateOccurrences}) must equal rawBucketOccurrences (${snapshot.rawBucketOccurrences}).`
    );
  }
  if (snapshot.identityListAvailability === ClosureSnapshotIdentityListAvailability.UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE) {
    if (snapshot.exactRequests !== null || snapshot.perBucketCounts !== null || snapshot.perBucketDigests !== null) {
      throw new ClosureSnapshotValidationError(
        'identityListAvailability is UNAVAILABLE_NOT_PROVIDED_TO_THIS_MILESTONE but exactRequests/perBucketCounts/perBucketDigests are not all null.'
      );
    }
  }
}
