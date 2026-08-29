import assert from 'node:assert/strict';
import test from 'node:test';
import { RawSourceLifecycleGraphError, validateRawSourceLifecycleGraph } from './raw-source-lifecycle-graph';
import { RawSourceApplicabilityBasis, RawSourceApplicabilityDomain, RawSourceLifecycleStatus, RawSourceRole, RawSourceUrlReviewStatus, ReviewedRawSourceManifestEntry } from './raw-source-archive.types';

function entry(overrides: Partial<ReviewedRawSourceManifestEntry>): ReviewedRawSourceManifestEntry {
  return {
    reference: 'NSE/MSD/1',
    urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT,
    sourceUrl: null,
    primaryDepartment: null,
    circularReference: 'X/2024',
    publicationDate: '2024-01-01',
    subject: 'Synthetic',
    applicableSegments: [{ domain: RawSourceApplicabilityDomain.EQUITY, basis: RawSourceApplicabilityBasis.DIRECT }],
    sourceRole: RawSourceRole.SPECIAL_SESSION_NOTICE,
    lifecycleStatus: RawSourceLifecycleStatus.FINAL,
    withdraws: [],
    withdrawnBy: null,
    supersedes: [],
    supersededBy: null,
    notes: null,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected RawSourceLifecycleGraphError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof RawSourceLifecycleGraphError, `Expected RawSourceLifecycleGraphError, got ${error}`);
    assert.equal((error as RawSourceLifecycleGraphError).code, code);
  }
}

/** The exact mandatory Jan-20 lineage graph from task section 8. */
function jan20Lineage(): ReviewedRawSourceManifestEntry[] {
  const withdrawnBy = 'NSE/MSD/60340';
  return [
    entry({ reference: 'NSE/MSD/59999', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy }),
    entry({ reference: 'NSE/MSD/60300', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy }),
    entry({ reference: 'NSE/MSD/60318', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy }),
    entry({ reference: 'NSE/MSD/60340', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdraws: ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318'] }),
  ];
}

test('(21) the mandatory Jan-20 lifecycle graph validates without throwing', () => {
  assert.doesNotThrow(() => validateRawSourceLifecycleGraph(jan20Lineage()));
});

test('(27) MSD/60340 withdraws exactly the three Jan-20 predecessors', () => {
  const lineage = jan20Lineage();
  const finalEntry = lineage.find((e) => e.reference === 'NSE/MSD/60340')!;
  assert.deepEqual([...finalEntry.withdraws].sort(), ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318']);
});

test('(28) withdrawn Jan-20 predecessors remain present in the entry set (never dropped)', () => {
  const lineage = jan20Lineage();
  const references = lineage.map((e) => e.reference);
  assert.ok(references.includes('NSE/MSD/59999'));
  assert.ok(references.includes('NSE/MSD/60300'));
  assert.ok(references.includes('NSE/MSD/60318'));
});

test('(29) MSD/60340 is marked FINAL', () => {
  const lineage = jan20Lineage();
  assert.equal(lineage.find((e) => e.reference === 'NSE/MSD/60340')!.lifecycleStatus, RawSourceLifecycleStatus.FINAL);
});

test('(22) a missing withdrawnBy target is rejected as a dangling reference', () => {
  const entries = [entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/999' })];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'DANGLING_REFERENCE');
});

test('(23) an inverse lifecycle mismatch is rejected', () => {
  // A claims to be withdrawn by B, but B does not list A in its withdraws array.
  const entries = [
    entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/2' }),
    entry({ reference: 'NSE/MSD/2', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdraws: [] }),
  ];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'INVERSE_LIFECYCLE_MISMATCH');
});

test('(24) self-withdrawal is rejected', () => {
  const entries = [entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/1' })];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'SELF_WITHDRAWAL');
});

test('(25) a lifecycle cycle is rejected', () => {
  // A withdrawn-by B (with matching inverse B.withdraws=[A]) and B withdrawn-by A (with matching inverse A.withdraws=[B]):
  // both sides are individually inverse-consistent, but the chain never terminates at a FINAL node.
  const entries = [
    entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/2', withdraws: ['NSE/MSD/2'] }),
    entry({ reference: 'NSE/MSD/2', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/1', withdraws: ['NSE/MSD/1'] }),
  ];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'LIFECYCLE_CYCLE_DETECTED');
});

test('(26) a duplicate lifecycle edge (two different FINAL entries claiming the same predecessor) is rejected', () => {
  const entries = [
    entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: 'NSE/MSD/2' }),
    entry({ reference: 'NSE/MSD/2', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdraws: ['NSE/MSD/1'] }),
    entry({ reference: 'NSE/MSD/3', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdraws: ['NSE/MSD/1'] }),
  ];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'DUPLICATE_LIFECYCLE_EDGE');
});

test('contradictory status: FINAL entry carrying a withdrawnBy pointer is rejected', () => {
  const entries = [entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdrawnBy: 'NSE/MSD/2' }), entry({ reference: 'NSE/MSD/2' })];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'CONTRADICTORY_LIFECYCLE_STATUS');
});

test('contradictory status: WITHDRAWN entry without a withdrawnBy pointer is rejected', () => {
  const entries = [entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.WITHDRAWN, withdrawnBy: null })];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'CONTRADICTORY_LIFECYCLE_STATUS');
});

test('a referenced source not present in the manifest is rejected (withdraws pointing outside the entry set)', () => {
  const entries = [entry({ reference: 'NSE/MSD/1', lifecycleStatus: RawSourceLifecycleStatus.FINAL, withdraws: ['NSE/MSD/GHOST'] })];
  expectCode(() => validateRawSourceLifecycleGraph(entries), 'DANGLING_REFERENCE');
});

test('a manifest with no lifecycle relationships at all validates cleanly', () => {
  const entries = [entry({ reference: 'NSE/CMTR/1' }), entry({ reference: 'NSE/FAOP/1' })];
  assert.doesNotThrow(() => validateRawSourceLifecycleGraph(entries));
});
