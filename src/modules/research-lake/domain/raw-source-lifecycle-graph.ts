import { ReviewedRawSourceManifestEntry, RawSourceLifecycleStatus } from './raw-source-archive.types';

/**
 * Cross-entry lifecycle-graph invariants (task section 8). Pure/synchronous;
 * never called as part of single-entry field validation
 * (`validateReviewedRawSourceManifest` runs both, in sequence) so this stays
 * independently testable against hand-built entry sets.
 */
export type RawSourceLifecycleGraphErrorCode =
  | 'DANGLING_REFERENCE'
  | 'SELF_WITHDRAWAL'
  | 'SELF_SUPERSESSION'
  | 'DUPLICATE_LIFECYCLE_EDGE'
  | 'CONTRADICTORY_LIFECYCLE_STATUS'
  | 'INVERSE_LIFECYCLE_MISMATCH'
  | 'LIFECYCLE_CYCLE_DETECTED';

export class RawSourceLifecycleGraphError extends Error {
  constructor(public readonly code: RawSourceLifecycleGraphErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceLifecycleGraphError';
  }
}

function fail(code: RawSourceLifecycleGraphErrorCode, message: string): never {
  throw new RawSourceLifecycleGraphError(code, message);
}

/**
 * Validates the FULL lifecycle graph across every entry in one manifest.
 * Rejects (task section 8's exact list):
 *  - a dangling reference (`withdraws`/`withdrawnBy`/`supersedes`/
 *    `supersededBy` naming a reference not present in `entries`)
 *  - self-withdrawal/self-supersession
 *  - a duplicate lifecycle edge (two different FINAL entries both claiming
 *    to withdraw/supersede the same predecessor)
 *  - contradictory lifecycle status (a FINAL entry with a non-null
 *    `withdrawnBy`/`supersededBy`; a WITHDRAWN entry without `withdrawnBy`;
 *    a SUPERSEDED entry without `supersededBy`)
 *  - an inverse mismatch (`A.withdrawnBy = B` without `B.withdraws`
 *    containing `A`, or vice versa; same for supersedes/supersededBy)
 *  - a cycle in the `withdrawnBy`/`supersededBy` chain
 */
export function validateRawSourceLifecycleGraph(entries: readonly ReviewedRawSourceManifestEntry[]): void {
  const byReference = new Map(entries.map((entry) => [entry.reference, entry]));

  const assertKnown = (reference: string, label: string, owner: string): void => {
    if (!byReference.has(reference)) {
      fail('DANGLING_REFERENCE', `Entry '${owner}': ${label} references '${reference}', which is not present in this manifest.`);
    }
  };

  for (const entry of entries) {
    for (const withdrawn of entry.withdraws) {
      if (withdrawn === entry.reference) fail('SELF_WITHDRAWAL', `Entry '${entry.reference}' lists itself in withdraws.`);
      assertKnown(withdrawn, 'withdraws', entry.reference);
    }
    for (const superseded of entry.supersedes) {
      if (superseded === entry.reference) fail('SELF_SUPERSESSION', `Entry '${entry.reference}' lists itself in supersedes.`);
      assertKnown(superseded, 'supersedes', entry.reference);
    }
    if (entry.withdrawnBy !== null) {
      if (entry.withdrawnBy === entry.reference) fail('SELF_WITHDRAWAL', `Entry '${entry.reference}' names itself as withdrawnBy.`);
      assertKnown(entry.withdrawnBy, 'withdrawnBy', entry.reference);
    }
    if (entry.supersededBy !== null) {
      if (entry.supersededBy === entry.reference) fail('SELF_SUPERSESSION', `Entry '${entry.reference}' names itself as supersededBy.`);
      assertKnown(entry.supersededBy, 'supersededBy', entry.reference);
    }

    const status = entry.lifecycleStatus;
    if (status === RawSourceLifecycleStatus.FINAL && (entry.withdrawnBy !== null || entry.supersededBy !== null)) {
      fail('CONTRADICTORY_LIFECYCLE_STATUS', `Entry '${entry.reference}' is FINAL but carries a withdrawnBy/supersededBy pointer.`);
    }
    if (status === RawSourceLifecycleStatus.WITHDRAWN && (entry.withdrawnBy === null || entry.supersededBy !== null)) {
      fail('CONTRADICTORY_LIFECYCLE_STATUS', `Entry '${entry.reference}' is WITHDRAWN but withdrawnBy is null or supersededBy is set.`);
    }
    if (status === RawSourceLifecycleStatus.SUPERSEDED && (entry.supersededBy === null || entry.withdrawnBy !== null)) {
      fail('CONTRADICTORY_LIFECYCLE_STATUS', `Entry '${entry.reference}' is SUPERSEDED but supersededBy is null or withdrawnBy is set.`);
    }
  }

  // Duplicate-edge + inverse-consistency: build the observed inverse map from
  // every FINAL entry's withdraws/supersedes arrays, then prove it agrees
  // exactly with every predecessor's own withdrawnBy/supersededBy pointer.
  const withdrawnByObserved = new Map<string, string>(); // predecessor -> withdrawer
  for (const entry of entries) {
    for (const withdrawn of entry.withdraws) {
      const existingWithdrawer = withdrawnByObserved.get(withdrawn);
      if (existingWithdrawer !== undefined && existingWithdrawer !== entry.reference) {
        fail('DUPLICATE_LIFECYCLE_EDGE', `'${withdrawn}' is listed in withdraws by both '${existingWithdrawer}' and '${entry.reference}'.`);
      }
      withdrawnByObserved.set(withdrawn, entry.reference);
    }
  }
  const supersededByObserved = new Map<string, string>();
  for (const entry of entries) {
    for (const superseded of entry.supersedes) {
      const existingSuperseder = supersededByObserved.get(superseded);
      if (existingSuperseder !== undefined && existingSuperseder !== entry.reference) {
        fail('DUPLICATE_LIFECYCLE_EDGE', `'${superseded}' is listed in supersedes by both '${existingSuperseder}' and '${entry.reference}'.`);
      }
      supersededByObserved.set(superseded, entry.reference);
    }
  }

  for (const entry of entries) {
    const observedWithdrawer = withdrawnByObserved.get(entry.reference) ?? null;
    if (observedWithdrawer !== entry.withdrawnBy) {
      fail(
        'INVERSE_LIFECYCLE_MISMATCH',
        `Entry '${entry.reference}' has withdrawnBy=${JSON.stringify(entry.withdrawnBy)}, but the withdraws graph says its withdrawer is ${JSON.stringify(observedWithdrawer)}.`
      );
    }
    const observedSuperseder = supersededByObserved.get(entry.reference) ?? null;
    if (observedSuperseder !== entry.supersededBy) {
      fail(
        'INVERSE_LIFECYCLE_MISMATCH',
        `Entry '${entry.reference}' has supersededBy=${JSON.stringify(entry.supersededBy)}, but the supersedes graph says its superseder is ${JSON.stringify(observedSuperseder)}.`
      );
    }
  }

  assertNoCycle(entries, byReference, (entry) => entry.withdrawnBy, 'withdrawnBy');
  assertNoCycle(entries, byReference, (entry) => entry.supersededBy, 'supersededBy');
}

/**
 * Follows `pointer(entry)` from every entry up to `entries.length` hops. A
 * well-formed graph always reaches a `null` pointer (a FINAL node) within
 * that many hops; visiting the same reference twice on one chain proves a
 * cycle (task section 8: "lifecycle cycles where invalid").
 */
function assertNoCycle(
  entries: readonly ReviewedRawSourceManifestEntry[],
  byReference: ReadonlyMap<string, ReviewedRawSourceManifestEntry>,
  pointer: (entry: ReviewedRawSourceManifestEntry) => string | null,
  label: string
): void {
  const maxHops = entries.length;
  for (const start of entries) {
    const visited = new Set<string>([start.reference]);
    let current: ReviewedRawSourceManifestEntry | undefined = start;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const next = pointer(current!);
      if (next === null) break;
      if (visited.has(next)) {
        fail('LIFECYCLE_CYCLE_DETECTED', `Cycle detected in ${label} chain starting at '${start.reference}' (revisits '${next}').`);
      }
      visited.add(next);
      current = byReference.get(next);
      if (current === undefined) break; // dangling ref already reported by the earlier pass
    }
  }
}
