import assert from 'node:assert/strict';
import test from 'node:test';
import { DatasetHealthStatus } from './dataset-health.types';
import {
  ManifestDatasetKind,
  SessionManifest,
  SourceAcquisitionEvidence,
  SourceAcquisitionEvidenceAvailability,
  SourceAcquisitionProvenanceComposition,
  UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  UnderlyingSessionIdentity,
} from './dataset-manifest.types';
import { DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION, DerivedImputedResearchSessionV1, ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import {
  ResearchSessionCompositeRepairProvenanceKind,
  ResearchSessionSourceSelectionInvariantViolationError,
  ResearchSessionUnavailableReason,
  selectResearchSessionSource,
} from './research-session-source-selection';
import { TrustedDerivedSessionLookupOutcome, TrustedDerivedSessionRegistryEntry } from './trusted-authorized-derived-session-registry';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const NOT_AUTHORIZED: TrustedDerivedSessionLookupOutcome = { kind: 'NOT_AUTHORIZED' };

function evidence(overrides: Partial<SourceAcquisitionEvidence> = {}): SourceAcquisitionEvidence {
  return { ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE, availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE, provider: HistoricalProviderId.UPSTOX, ...overrides };
}

function canonicalSession(tradingDate: string, overrides: Partial<SessionManifest> = {}): SessionManifest {
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
  return {
    identity,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    contentChecksum: `content-checksum-${tradingDate}`,
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.PRIMARY_ONLY }),
    calendarSessionWindows: [],
    ...overrides,
  };
}

function derivedSession(overrides: Partial<DerivedImputedResearchSessionV1> = {}): DerivedImputedResearchSessionV1 {
  return {
    schemaVersion: DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
    imputationSemanticsVersion: 1,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate: '2022-03-07' },
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    sourceSnapshotChecksum: 'source-snapshot-checksum',
    rows: [],
    realRowCount: 372,
    imputedRowCount: 3,
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    derivedContentChecksum: 'derived-content-checksum',
    ...overrides,
  };
}

function registryEntry(overrides: Partial<TrustedDerivedSessionRegistryEntry> = {}): TrustedDerivedSessionRegistryEntry {
  return {
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    instrumentKey: INSTRUMENT_KEY,
    timeframe: TIMEFRAME,
    tradingDate: '2022-03-07',
    derivedContentChecksum: 'derived-content-checksum',
    sourceSnapshotChecksum: 'source-snapshot-checksum',
    expectedTotalRowCount: 375,
    expectedRealRowCount: 372,
    expectedImputedRowCount: 3,
    ...overrides,
  };
}

function availableOutcome(overrides: Partial<DerivedImputedResearchSessionV1> = {}): TrustedDerivedSessionLookupOutcome {
  const session = derivedSession(overrides);
  return { kind: 'AVAILABLE', entry: registryEntry(), session, relativePath: `derived-imputed-sessions/${session.derivedContentChecksum}.json` };
}

/** A thunk that records how many times it was invoked -- proves the lazy-lookup skip contract (BLOCKER-01/BLOCKER-03 correction). */
function countingLookup(outcome: TrustedDerivedSessionLookupOutcome): { resolveDerivedLookup: () => TrustedDerivedSessionLookupOutcome; callCount: () => number } {
  let calls = 0;
  return {
    resolveDerivedLookup: () => {
      calls += 1;
      return outcome;
    },
    callCount: () => calls,
  };
}

// ---- Tier 1: healthy real primary canonical with POSITIVE durable evidence -----------

test('healthy + PRIMARY_ONLY + positive durable evidence -> tier 1 (HEALTHY_REAL_CANONICAL_SESSION)', () => {
  const selection = selectResearchSessionSource({ canonicalSession: canonicalSession('2022-06-01'), resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION) {
    assert.equal(selection.tradingDate, '2022-06-01');
    assert.equal(selection.canonicalContentChecksum, 'content-checksum-2022-06-01');
    assert.equal(selection.canonicalRowCount, 375);
    assert.equal(selection.canonicalizationVersion, 1);
    assert.equal(selection.healthSemanticsVersion, 1);
    assert.deepEqual(selection.identity, canonicalSession('2022-06-01').identity);
  }
});

test('NORMALIZED_WITH_EXCLUSIONS + PRIMARY_ONLY + positive evidence also -> tier 1 (matches DatasetManifestService.sessionCounts.healthy rollup)', () => {
  const session = canonicalSession('2022-06-02', { persistedCanonicalHealthStatus: DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
});

test('tier 1/2 canonical never even invokes the derived lookup (lazy skip, not merely an ignored result)', () => {
  const { resolveDerivedLookup, callCount } = countingLookup(availableOutcome());
  selectResearchSessionSource({ canonicalSession: canonicalSession('2022-06-01'), resolveDerivedLookup });
  assert.equal(callCount(), 0);
});

// ---- BLOCKER-01: unavailable/placeholder evidence is NOT proof -- never tier 1 --------

test('BLOCKER-01: healthy + PRIMARY_ONLY but UNAVAILABLE_FROM_PERSISTED_STORE (the placeholder default) -> NEVER tier 1; falls through to tier 3 when a derived source is available', () => {
  const session = canonicalSession('2022-03-07', { sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => availableOutcome() });
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
});

test('BLOCKER-01: healthy + PRIMARY_ONLY but UNAVAILABLE_FROM_PERSISTED_STORE + no authorized derived -> tier 4 UNAVAILABLE, reason=CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED (never tier 1)', () => {
  const session = canonicalSession('2022-06-03', { sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(selection.reason, ResearchSessionUnavailableReason.CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED);
    assert.equal(selection.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  }
});

test('BLOCKER-01: healthy + PRIMARY_ONLY but UNAVAILABLE evidence + authorized but NOT_YET_CAPTURED -> tier 4, reason=CANONICAL_PROVENANCE_UNAVAILABLE_DERIVED_NOT_YET_CAPTURED', () => {
  const session = canonicalSession('2022-03-07', { sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => ({ kind: 'NOT_YET_CAPTURED', entry: registryEntry() }) });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(selection.reason, ResearchSessionUnavailableReason.CANONICAL_PROVENANCE_UNAVAILABLE_DERIVED_NOT_YET_CAPTURED);
  }
});

test('BLOCKER-01: this is exactly the scenario Terra rejected -- a complete session with UNAVAILABLE_FROM_PERSISTED_STORE + placeholder PRIMARY_ONLY must NEVER be classified tier 1, under any derived-lookup outcome', () => {
  for (const outcome of [NOT_AUTHORIZED, { kind: 'NOT_YET_CAPTURED', entry: registryEntry() } as TrustedDerivedSessionLookupOutcome, availableOutcome()]) {
    const session = canonicalSession('2022-03-07', { sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE });
    const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => outcome });
    assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  }
});

// ---- Tier 2: healthy composite-repaired / legacy-ambiguous canonical, WITH positive evidence ------

test('healthy + COMPOSITE_REPAIRED + positive evidence -> tier 2, repairProvenance FULLY_PROVENANCED with UUID-free semantic facts only', () => {
  const compositeRepair = {
    primaryProvider: HistoricalProviderId.UPSTOX,
    primaryRetrievalId: 'retrieval-1',
    repairProvider: HistoricalProviderId.GROWW,
    repairRetrievalId: 'retrieval-2',
    repairEvidenceId: 'evidence-1',
    repairedMinuteCount: 3,
    repairPolicyVersion: 1,
  };
  const session = canonicalSession('2022-06-04', { sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair }) });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION) {
    assert.deepEqual(selection.repairProvenance, {
      kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED,
      primaryProvider: HistoricalProviderId.UPSTOX,
      repairProvider: HistoricalProviderId.GROWW,
      repairedMinuteCount: 3,
      repairPolicyVersion: 1,
    });
    const serialized = JSON.stringify(selection.repairProvenance);
    assert.equal(/retrievalId|evidenceId|retrieval-1|retrieval-2|evidence-1/i.test(serialized), false, 'no persistence UUID field name/value may ever appear in the B-M7.2 selection');
  }
});

test('HIGH-02: two canonical sessions that are semantically identical composites but differ ONLY in primaryRetrievalId/repairRetrievalId/repairEvidenceId produce a BYTE-IDENTICAL selection', () => {
  const baseRepair = { primaryProvider: HistoricalProviderId.UPSTOX, repairProvider: HistoricalProviderId.GROWW, repairedMinuteCount: 3, repairPolicyVersion: 1 };
  const sessionA = canonicalSession('2022-06-04', {
    sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair: { ...baseRepair, primaryRetrievalId: 'retrieval-AAAA', repairRetrievalId: 'retrieval-BBBB', repairEvidenceId: 'evidence-CCCC' } }),
  });
  const sessionB = canonicalSession('2022-06-04', {
    sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair: { ...baseRepair, primaryRetrievalId: 'retrieval-ZZZZ-different', repairRetrievalId: 'retrieval-YYYY-different', repairEvidenceId: 'evidence-XXXX-different' } }),
  });
  const selectionA = selectResearchSessionSource({ canonicalSession: sessionA, resolveDerivedLookup: () => NOT_AUTHORIZED });
  const selectionB = selectResearchSessionSource({ canonicalSession: sessionB, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.deepEqual(selectionA, selectionB);
  assert.equal(JSON.stringify(selectionA), JSON.stringify(selectionB));
});

test('COMPOSITE_REPAIRED with UNAVAILABLE evidence (a claim without positive backing) fails closed as an invariant violation, never silently reclassified', () => {
  const session = canonicalSession('2022-06-04', {
    sourceAcquisitionEvidence: { ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE, provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair: { primaryProvider: HistoricalProviderId.UPSTOX, primaryRetrievalId: 'r1', repairProvider: HistoricalProviderId.GROWW, repairRetrievalId: 'r2', repairEvidenceId: 'e1', repairedMinuteCount: 3, repairPolicyVersion: 1 } },
  });
  assert.throws(() => selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED }), ResearchSessionSourceSelectionInvariantViolationError);
});

test('COMPOSITE_REPAIRED with compositeRepair=null fails closed as an invariant violation (task: "fail closed as an invariant violation")', () => {
  const session = canonicalSession('2022-06-04', { sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair: null }) });
  assert.throws(() => selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED }), ResearchSessionSourceSelectionInvariantViolationError);
});

test('healthy + UNKNOWN_LEGACY_REPAIR_PROVENANCE + positive evidence -> tier 2 (known composite, never falsely promoted to tier 1), repairProvenance is the truthful UNKNOWN_LEGACY_REPAIR_PROVENANCE variant', () => {
  const session = canonicalSession('2022-06-05', { sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE, compositeRepair: null }) });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION) {
    assert.deepEqual(selection.repairProvenance, { kind: ResearchSessionCompositeRepairProvenanceKind.UNKNOWN_LEGACY_REPAIR_PROVENANCE });
  }
});

test('UNKNOWN_LEGACY_REPAIR_PROVENANCE is never returned as tier 1', () => {
  const session = canonicalSession('2022-06-05', { sourceAcquisitionEvidence: evidence({ provenanceComposition: SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE, compositeRepair: null }) });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
});

test('UNKNOWN_LEGACY_REPAIR_PROVENANCE with UNAVAILABLE evidence fails closed as an invariant violation (a "known composite" claim needs positive evidence too)', () => {
  const session = canonicalSession('2022-06-05', { sourceAcquisitionEvidence: { ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE, provenanceComposition: SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE, compositeRepair: null } });
  assert.throws(() => selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED }), ResearchSessionSourceSelectionInvariantViolationError);
});

// ---- Not-complete canonical: INCOMPLETE/INVALID/PROVIDER_UNAVAILABLE never tier 1/2 --------

test('INVALID canonical is never tier 1/2 (rows existing is irrelevant)', () => {
  const session = canonicalSession('2022-06-06', { persistedCanonicalHealthStatus: DatasetHealthStatus.INVALID });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
});

test('PROVIDER_UNAVAILABLE canonical is never tier 1/2', () => {
  const session = canonicalSession('2022-06-07', { persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  assert.notEqual(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
});

// ---- Tier 3: authorized derived, only when canonical is not complete ------

test('INCOMPLETE canonical + AVAILABLE trusted derived -> tier 3 with exact derived facts carried through', () => {
  const session = canonicalSession('2022-03-07', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => availableOutcome() });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
    assert.equal(selection.tradingDate, '2022-03-07');
    assert.equal(selection.authorizationId, 'NIFTY_2022_03_07_INDEX_GAP_V1');
    assert.equal(selection.derivedContentChecksum, 'derived-content-checksum');
    assert.equal(selection.sourceSnapshotChecksum, 'source-snapshot-checksum');
    assert.equal(selection.sourceSnapshotProviderId, HistoricalProviderId.UPSTOX);
    assert.equal(selection.realRowCount, 372);
    assert.equal(selection.imputedRowCount, 3);
    assert.equal(selection.derivedArtifactRelativePath, 'derived-imputed-sessions/derived-content-checksum.json');
  }
});

// ---- Tier 4: unavailable ----------------------------------------------------

test('INCOMPLETE canonical + no authorization for this date -> tier 4 UNAVAILABLE, reason=NO_AUTHORIZED_DERIVED', () => {
  const session = canonicalSession('2022-06-08', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(selection.reason, ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED);
  }
});

test('INCOMPLETE canonical + authorized but NOT_YET_CAPTURED -> tier 4 UNAVAILABLE, reason=DERIVED_NOT_YET_CAPTURED, never falsely COMPLETE', () => {
  const session = canonicalSession('2022-03-07', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => ({ kind: 'NOT_YET_CAPTURED', entry: registryEntry() }) });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(selection.reason, ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_DERIVED_NOT_YET_CAPTURED);
  }
});

// ---- Future real precedence: real/composite canonical always outranks derived --------

test('future real precedence: healthy real canonical (positive evidence) + a valid authorized derived both exist for the SAME date -> REAL CANONICAL wins, derived lookup never invoked', () => {
  const session = canonicalSession('2022-03-07', { persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY, canonicalRowCount: 375 });
  const { resolveDerivedLookup, callCount } = countingLookup(availableOutcome());
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  assert.equal(callCount(), 0);
});

test('future real precedence: accepted composite-repaired canonical (positive evidence) + a valid authorized derived both exist for the SAME date -> COMPOSITE_REPAIRED wins', () => {
  const session = canonicalSession('2022-03-07', {
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    canonicalRowCount: 375,
    sourceAcquisitionEvidence: evidence({
      provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED,
      compositeRepair: { primaryProvider: HistoricalProviderId.UPSTOX, primaryRetrievalId: 'r1', repairProvider: HistoricalProviderId.GROWW, repairRetrievalId: 'r2', repairEvidenceId: 'e1', repairedMinuteCount: 3, repairPolicyVersion: 1 },
    }),
  });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => availableOutcome() });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
});

test('a corrupted derived artifact registered for a date whose canonical content already qualifies tier 1 never fails selection -- the lookup that would throw is never invoked', () => {
  const session = canonicalSession('2022-03-07', { persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY, canonicalRowCount: 375 });
  const resolveDerivedLookup = (): TrustedDerivedSessionLookupOutcome => {
    throw new Error('this must never be called when canonical already qualifies for tier 1/2');
  };
  assert.doesNotThrow(() => selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup }));
});

test('an UNAVAILABLE outcome always carries the true persistedCanonicalHealthStatus for observability', () => {
  const session = canonicalSession('2022-06-09', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE });
  const selection = selectResearchSessionSource({ canonicalSession: session, resolveDerivedLookup: () => NOT_AUTHORIZED });
  assert.equal(selection.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(selection.persistedCanonicalHealthStatus, DatasetHealthStatus.PROVIDER_UNAVAILABLE);
  }
});
