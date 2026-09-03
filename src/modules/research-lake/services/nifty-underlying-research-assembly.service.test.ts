import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import {
  DatasetManifest,
  MANIFEST_SCHEMA_VERSION,
  ManifestDatasetKind,
  SessionManifest,
  SourceAcquisitionEvidenceAvailability,
  SourceAcquisitionProvenanceComposition,
  UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  UnderlyingSessionIdentity,
} from '../domain/dataset-manifest.types';
import { DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION, DerivedImputedResearchSessionV1, DerivedResearchSessionRowV1, ImputationReason, ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ResearchSessionCompositeRepairProvenanceKind, ResearchSessionSourceSelectionInvariantViolationError, ResearchSessionUnavailableReason } from '../domain/research-session-source-selection';
import { readResearchUnderlyingDatasetAssembly } from '../domain/research-underlying-assembly.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { GenerateUnderlyingDatasetManifestRequest } from './dataset-manifest.service';
import { ManifestRequestedSessions } from './manifest-calendar-session-resolver.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';
import NiftyUnderlyingResearchAssemblyService, { UnderlyingManifestGenerator, RequestedSessionsResolver } from './nifty-underlying-research-assembly.service';

const INSTRUMENT_KEY = NIFTY_INDEX_INSTRUMENT_KEY;
const TIMEFRAME = NIFTY_UNDERLYING_TIMEFRAME;
const TRADING_DATE_MARCH_7 = '2022-03-07';
const AUTHORIZATION_ID = 'NIFTY_2022_03_07_INDEX_GAP_V1';

// ---- Fixtures ---------------------------------------------------------------

function fakeCanonicalSession(tradingDate: string, overrides: Partial<SessionManifest> = {}): SessionManifest {
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
  return {
    identity,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    contentChecksum: `checksum-${tradingDate}`,
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: {
      ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
      availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
      provider: HistoricalProviderId.UPSTOX,
      provenanceComposition: SourceAcquisitionProvenanceComposition.PRIMARY_ONLY,
    },
    calendarSessionWindows: [],
    ...overrides,
  };
}

function march7IncompleteSession(): SessionManifest {
  return fakeCanonicalSession(TRADING_DATE_MARCH_7, {
    canonicalRowCount: 0,
    persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE,
    sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  });
}

function fakeCanonicalManifest(sessions: readonly SessionManifest[]): DatasetManifest {
  const tradingDates = sessions.map((s) => s.identity.tradingDate);
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    datasetChecksum: 'fake-dataset-checksum',
    datasetId: 'UNDERLYING_1M_fake',
    provenance: {
      provider: HistoricalProviderId.UPSTOX,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      instrumentDescriptor: INSTRUMENT_KEY,
      requestedFromDate: tradingDates[0] ?? '2022-01-01',
      requestedToDate: tradingDates[tradingDates.length - 1] ?? '2022-12-31',
      acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION',
      gitRevision: null,
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    sessions,
    sessionCounts: {
      requested: sessions.length,
      included: sessions.length,
      healthy: sessions.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.HEALTHY).length,
      incomplete: sessions.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.INCOMPLETE).length,
      invalid: 0,
      byPersistedCanonicalHealthStatus: {
        [DatasetHealthStatus.HEALTHY]: sessions.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.HEALTHY).length,
        [DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS]: 0,
        [DatasetHealthStatus.INCOMPLETE]: sessions.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.INCOMPLETE).length,
        [DatasetHealthStatus.INVALID]: 0,
        [DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED]: 0,
        [DatasetHealthStatus.PROVIDER_UNAVAILABLE]: 0,
        [DatasetHealthStatus.METADATA_INCOMPLETE]: 0,
      },
    },
  };
}

class FakeManifestGenerator implements UnderlyingManifestGenerator {
  public callCount = 0;
  public lastRequest: GenerateUnderlyingDatasetManifestRequest | null = null;
  constructor(private readonly manifest: DatasetManifest) {}
  async generateUnderlyingManifest(request: GenerateUnderlyingDatasetManifestRequest): Promise<DatasetManifest> {
    this.callCount += 1;
    this.lastRequest = request;
    return this.manifest;
  }
}

class FakeCalendarResolver implements RequestedSessionsResolver {
  public callCount = 0;
  public lastRequest: { fromDate: string; toDate: string } | null = null;
  constructor(private readonly result: ManifestRequestedSessions) {}
  async resolveRequestedSessions(request: { fromDate: string; toDate: string }): Promise<ManifestRequestedSessions> {
    this.callCount += 1;
    this.lastRequest = request;
    return this.result;
  }
}

function requestedSessions(tradingDates: readonly string[]): ManifestRequestedSessions {
  return { tradingDates: [...tradingDates], calendarSessionWindows: {} };
}

function buildService(sessions: readonly SessionManifest[], derivedArtifactRoot: string, archiveRoot: string): { service: NiftyUnderlyingResearchAssemblyService; manifestGenerator: FakeManifestGenerator; calendarResolver: FakeCalendarResolver } {
  const manifest = fakeCanonicalManifest(sessions);
  const manifestGenerator = new FakeManifestGenerator(manifest);
  const calendarResolver = new FakeCalendarResolver(requestedSessions(sessions.map((s) => s.identity.tradingDate)));
  const service = new NiftyUnderlyingResearchAssemblyService({
    manifestService: manifestGenerator,
    calendarSessionResolverService: calendarResolver,
    derivedArtifactRoot,
    archiveRoot,
    persistArtifactsToDisk: true,
  });
  return { service, manifestGenerator, calendarResolver };
}

// ---- Real committed B-M7.1 artifact + corrupted-artifact fixtures ---------

const REAL_DERIVED_ARTIFACT_ROOT = 'artifacts/research-lake';

let tempArchiveRoot: string;
let tempDerivedRoot: string;

test.beforeEach(() => {
  tempArchiveRoot = mkdtempSync(join(tmpdir(), 'research-assembly-archive-test-'));
  tempDerivedRoot = mkdtempSync(join(tmpdir(), 'research-assembly-derived-test-'));
});

test.afterEach(() => {
  rmSync(tempArchiveRoot, { recursive: true, force: true });
  rmSync(tempDerivedRoot, { recursive: true, force: true });
});

function fixtureDerivedRow(index: number, sourceSnapshotChecksum: string): DerivedResearchSessionRowV1 {
  const baseMs = Date.UTC(2022, 2, 7, 3, 45, 0);
  return {
    candleTime: new Date(baseMs + index * 60_000).toISOString(),
    open: '17000.00',
    high: '17000.50',
    low: '16999.50',
    close: '17000.10',
    volume: '1000',
    openInterest: null,
    availableAt: new Date(baseMs + index * 60_000 + 60_000).toISOString(),
    provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum },
  };
}

function fixtureImputedRows(sourceSnapshotChecksum: string): DerivedResearchSessionRowV1[] {
  const availableAt = new Date('2022-03-07T10:26:00+05:30').toISOString();
  return ['10:22:00', '10:23:00', '10:24:00'].map((time) => ({
    candleTime: new Date(`2022-03-07T${time}+05:30`).toISOString(),
    open: '17024.10',
    high: '17024.20',
    low: '17024.00',
    close: '17024.15',
    volume: '0',
    openInterest: null,
    availableAt,
    provenance: {
      kind: ResearchRowProvenanceKind.IMPUTED,
      method: 'LINEAR_BOUNDARY_INTERPOLATION',
      policyVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
      leftAnchor: { candleTime: new Date('2022-03-07T10:21:00+05:30').toISOString(), field: 'CLOSE', contentChecksum: 'a'.repeat(64) },
      rightAnchor: { candleTime: new Date('2022-03-07T10:25:00+05:30').toISOString(), field: 'OPEN', contentChecksum: 'b'.repeat(64) },
      sourceSnapshotChecksum,
    },
  }));
}

/** Writes a CORRUPTED artifact directly at the REAL production pinned checksum path -- proves fail-hard behavior without touching the real committed artifact. */
function writeCorruptedArtifactAtPinnedPath(root: string): void {
  const pinnedChecksum = '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf';
  const sourceSnapshotChecksum = 'c'.repeat(64);
  const rows = [...Array.from({ length: 372 }, (_, i) => fixtureDerivedRow(i, sourceSnapshotChecksum)), ...fixtureImputedRows(sourceSnapshotChecksum)];
  const payload: Omit<DerivedImputedResearchSessionV1, 'derivedContentChecksum'> = {
    schemaVersion: DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
    imputationSemanticsVersion: 1,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate: TRADING_DATE_MARCH_7 },
    authorizationId: AUTHORIZATION_ID,
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    sourceSnapshotChecksum,
    rows,
    realRowCount: 372,
    imputedRowCount: 3,
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
  };
  // Corrupt AFTER assigning the pinned checksum -- content no longer self-consistent.
  const corrupted = { ...payload, realRowCount: 999, derivedContentChecksum: pinnedChecksum };
  const dir = join(root, 'derived-imputed-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pinnedChecksum}.json`), JSON.stringify(corrupted, null, 2));
}

// ---- 1: 247 real + March-7 incomplete + 1 valid authorized derived -> 248 research-ready ----

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

test('1. 247 valid real canonical sessions + March-7 incomplete + one valid authorized derived -> 248 research-ready (against the REAL committed B-M7.1 artifact)', async () => {
  const realDates = sequentialDates(247, '2020-01-01'); // 247 guaranteed-unique dates -- content, not real calendar semantics, is what this test exercises
  const sessions = [...realDates.map((d) => fakeCanonicalSession(d)), march7IncompleteSession()];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assembly.sessionCounts.expectedSessions, 248);
  assert.equal(result.assembly.sessionCounts.researchReadySessions, 248);
  assert.equal(result.assembly.sessionCounts.realCanonicalSessions, 247);
  assert.equal(result.assembly.sessionCounts.authorizedDerivedSessions, 1);
  assert.equal(result.assembly.sessionCounts.unavailableSessions, 0);
});

// ---- 2: canonical March-7 entry itself remains INCOMPLETE and unchanged ----

test('2. March-7 canonical manifest entry remains INCOMPLETE and untouched by the overlay (no mutation-by-reference bug)', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), march7IncompleteSession()];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);

  const beforeHealth = sessions.find((s) => s.identity.tradingDate === TRADING_DATE_MARCH_7)?.persistedCanonicalHealthStatus;
  const result = await service.assembleYear({ year: 2022 });
  const afterHealth = result.canonicalManifest.sessions.find((s) => s.identity.tradingDate === TRADING_DATE_MARCH_7)?.persistedCanonicalHealthStatus;

  assert.equal(beforeHealth, DatasetHealthStatus.INCOMPLETE);
  assert.equal(afterHealth, DatasetHealthStatus.INCOMPLETE);
  assert.equal(result.canonicalManifest.sessions.find((s) => s.identity.tradingDate === TRADING_DATE_MARCH_7)?.canonicalRowCount, 0);
});

// ---- 3/4/5/6: March-7 selection facts ----

test('3-6. March-7 selected source is tier 3 with exact authorizationId/checksums/counts', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), march7IncompleteSession()];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  const march7 = result.assembly.sessions.find((s) => s.tradingDate === TRADING_DATE_MARCH_7);
  assert.equal(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
  if (march7?.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
    assert.equal(march7.authorizationId, AUTHORIZATION_ID);
    assert.equal(march7.derivedContentChecksum, '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf');
    assert.equal(march7.sourceSnapshotChecksum, 'ed869ef97d6c34d38249c820e36bb01ba4a5e5a7331262ff7c31c83969dea0c1');
    assert.equal(march7.realRowCount, 372);
    assert.equal(march7.imputedRowCount, 3);
  }
});

// ---- 7: missing derived artifact -> UNAVAILABLE, never falsely COMPLETE ----

test('7. missing derived artifact fails closed to UNAVAILABLE for that one session, assembly still completes', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), march7IncompleteSession()];
  const { service } = buildService(sessions, tempDerivedRoot, tempArchiveRoot); // empty temp root -- nothing committed there
  const result = await service.assembleYear({ year: 2022 });
  const march7 = result.assembly.sessions.find((s) => s.tradingDate === TRADING_DATE_MARCH_7);
  assert.equal(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  assert.equal(result.assembly.sessionCounts.unavailableSessions, 1);
  assert.equal(result.assembly.sessionCounts.researchReadySessions, 1);
});

// ---- 8/9: corrupted derived artifact fails HARD (never becomes ordinary unavailable) ----

test('8-9. corrupted derived artifact (wrong checksum/content) fails the WHOLE assembly hard, never silently unavailable', async () => {
  writeCorruptedArtifactAtPinnedPath(tempDerivedRoot);
  const sessions = [fakeCanonicalSession('2022-01-03'), march7IncompleteSession()];
  const { service } = buildService(sessions, tempDerivedRoot, tempArchiveRoot);
  await assert.rejects(() => service.assembleYear({ year: 2022 }));
});

// ---- 10/11/12/13/14: wrong instrument/timeframe/date/authorization/tier all handled by the registry reader (already covered directly); here we prove the SERVICE surfaces the failure rather than swallowing it ----

test('10-14. any registry-level integrity violation propagates out of assembleYear as a thrown error (never downgraded to a successful assembly)', async () => {
  writeCorruptedArtifactAtPinnedPath(tempDerivedRoot); // one representative corruption case; field-level coverage lives in trusted-authorized-derived-session-registry.test.ts
  const sessions = [march7IncompleteSession()];
  const { service } = buildService(sessions, tempDerivedRoot, tempArchiveRoot);
  await assert.rejects(() => service.assembleYear({ year: 2022 }));
});

// ---- 15/16: future real precedence -----------------------------------------

test('15. a future HEALTHY real canonical March-7 overrides the derived artifact (even though a valid one exists)', async () => {
  const sessions = [fakeCanonicalSession(TRADING_DATE_MARCH_7, { canonicalRowCount: 375, persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  const march7 = result.assembly.sessions.find((s) => s.tradingDate === TRADING_DATE_MARCH_7);
  assert.equal(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
});

test('16. an accepted COMPOSITE_REPAIRED canonical March-7 overrides the derived artifact', async () => {
  const compositeRepair = { primaryProvider: HistoricalProviderId.UPSTOX, primaryRetrievalId: 'r1', repairProvider: HistoricalProviderId.GROWW, repairRetrievalId: 'r2', repairEvidenceId: 'e1', repairedMinuteCount: 3, repairPolicyVersion: 1 };
  const sessions = [
    fakeCanonicalSession(TRADING_DATE_MARCH_7, {
      canonicalRowCount: 375,
      persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
      sourceAcquisitionEvidence: { ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE, availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE, provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair },
    }),
  ];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  const march7 = result.assembly.sessions.find((s) => s.tradingDate === TRADING_DATE_MARCH_7);
  assert.equal(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION);
  if (march7?.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION) {
    assert.deepEqual(march7.repairProvenance, { kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED, primaryProvider: HistoricalProviderId.UPSTOX, repairProvider: HistoricalProviderId.GROWW, repairedMinuteCount: 3, repairPolicyVersion: 1 });
    assert.equal(/retrieval|evidence-1|Id"/i.test(JSON.stringify(march7.repairProvenance)), false, 'no persistence UUID may ever appear in the assembled selection');
  }
});

// ---- BLOCKER-01: unavailable/placeholder evidence never reaches tier 1, at the full-service level ----

test('BLOCKER-01: a complete canonical session with UNAVAILABLE_FROM_PERSISTED_STORE + placeholder PRIMARY_ONLY is NEVER tier 1 -- falls to tier 3 when an authorized derived source genuinely exists for that same date', async () => {
  const sessions = [fakeCanonicalSession(TRADING_DATE_MARCH_7, { canonicalRowCount: 375, persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY, sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  const march7 = result.assembly.sessions.find((s) => s.tradingDate === TRADING_DATE_MARCH_7);
  assert.notEqual(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
  assert.equal(march7?.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
});

test('BLOCKER-01: a complete canonical session with UNAVAILABLE_FROM_PERSISTED_STORE + placeholder PRIMARY_ONLY and no authorized derived for that date -> tier 4 UNAVAILABLE with CANONICAL_PROVENANCE_UNAVAILABLE reason, never tier 1', async () => {
  const sessions = [fakeCanonicalSession('2022-05-09', { canonicalRowCount: 375, persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY, sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  const session = result.assembly.sessions[0];
  assert.equal(session.precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (session.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(session.reason, ResearchSessionUnavailableReason.CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED);
  }
});

test('a COMPOSITE_REPAIRED claim with compositeRepair=null propagates ResearchSessionSourceSelectionInvariantViolationError out of assembleYear, failing the whole assembly closed', async () => {
  const sessions = [
    fakeCanonicalSession('2022-05-10', {
      sourceAcquisitionEvidence: { ...UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE, availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE, provenanceComposition: SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED, compositeRepair: null },
    }),
  ];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  await assert.rejects(() => service.assembleYear({ year: 2022 }), ResearchSessionSourceSelectionInvariantViolationError);
});

// ---- 17/18: incomplete without authorization / unauthorized derived cannot fill a date ----

test('17. incomplete canonical without any authorized derived -> UNAVAILABLE', async () => {
  const sessions = [fakeCanonicalSession('2022-05-05', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assembly.sessions[0].precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
});

test('18. an unauthorized date cannot be filled even if a (hypothetical) derived artifact happened to exist for it -- the registry has no entry, so it is never even looked up', async () => {
  const sessions = [fakeCanonicalSession('2022-05-06', { canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assembly.sessions[0].precedenceTier, ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
  if (result.assembly.sessions[0].precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
    assert.equal(result.assembly.sessions[0].reason, 'CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED');
  }
});

// ---- 19/20: INVALID/PROVIDER_UNAVAILABLE canonical can never be tier 1 -----

test('19. INVALID canonical can never be tier 1', async () => {
  const sessions = [fakeCanonicalSession('2022-05-07', { persistedCanonicalHealthStatus: DatasetHealthStatus.INVALID })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.notEqual(result.assembly.sessions[0].precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
});

test('20. PROVIDER_UNAVAILABLE canonical can never be tier 1', async () => {
  const sessions = [fakeCanonicalSession('2022-05-08', { persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE })];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.notEqual(result.assembly.sessions[0].precedenceTier, ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION);
});

// ---- 21: duplicate logical trading-date selection fails closed ------------

test('21. a duplicated tradingDate from the calendar resolver fails the assembly closed', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), fakeCanonicalSession('2022-01-03')];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  await assert.rejects(() => service.assembleYear({ year: 2022 }));
});

// ---- 25: canonical manifest checksum/reference included ------------------

test('25. the canonical manifest checksum/identity is embedded in the assembly as an explicit reference', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03')];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assembly.canonicalManifest.datasetChecksum, result.canonicalManifest.datasetChecksum);
  assert.equal(result.assembly.canonicalManifest.datasetId, result.canonicalManifest.datasetId);
  assert.equal(result.assembly.canonicalManifest.manifestSchemaVersion, result.canonicalManifest.manifestSchemaVersion);
});

// ---- persistence -------------------------------------------------------

test('assembly artifact is written content-addressed and round-trips', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03')];
  const { service } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const result = await service.assembleYear({ year: 2022 });
  assert.ok(result.assemblyStorage);
  assert.equal(result.assemblyStorage?.wasNewlyWritten, true);
  const onDisk = JSON.parse(readFileSync(result.assemblyStorage!.absolutePath, 'utf8'));
  assert.equal(onDisk.assemblyContentChecksum, result.assembly.assemblyContentChecksum);
});

test('persistArtifactsToDisk=false performs zero filesystem writes', async () => {
  const manifest = fakeCanonicalManifest([fakeCanonicalSession('2022-01-03')]);
  const manifestGenerator = new FakeManifestGenerator(manifest);
  const calendarResolver = new FakeCalendarResolver(requestedSessions(['2022-01-03']));
  const service = new NiftyUnderlyingResearchAssemblyService({
    manifestService: manifestGenerator,
    calendarSessionResolverService: calendarResolver,
    derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT,
    archiveRoot: tempArchiveRoot,
    persistArtifactsToDisk: false,
  });
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assemblyStorage, null);
});

// ---- BLOCKER-04 support: assembleYear + explicit persistAssembly() is the exact two-step flow the 2022 CLI relies on ----

test('BLOCKER-04 support: persistArtifactsToDisk=false builds without writing, and an explicit persistAssembly() call afterwards writes the SAME content-addressed artifact', async () => {
  const manifest = fakeCanonicalManifest([fakeCanonicalSession('2022-01-03')]);
  const manifestGenerator = new FakeManifestGenerator(manifest);
  const calendarResolver = new FakeCalendarResolver(requestedSessions(['2022-01-03']));
  const service = new NiftyUnderlyingResearchAssemblyService({
    manifestService: manifestGenerator,
    calendarSessionResolverService: calendarResolver,
    derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT,
    archiveRoot: tempArchiveRoot,
    persistArtifactsToDisk: false,
  });
  const result = await service.assembleYear({ year: 2022 });
  assert.equal(result.assemblyStorage, null);

  const storage = service.persistAssembly(result.assembly);
  assert.equal(storage.wasNewlyWritten, true);
  const onDisk = JSON.parse(readFileSync(storage.absolutePath, 'utf8'));
  assert.equal(onDisk.assemblyContentChecksum, result.assembly.assemblyContentChecksum);
});

// ---- HIGH-06: Terra's adversarial "Run A at T1, Run B at T2" reproduction -------------

test('HIGH-06: two independent assembleYear runs over identical semantic input, genuinely separated by real wall-clock time, produce byte-identical stored artifacts and a clean idempotent second write', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), fakeCanonicalSession('2022-01-04')];

  // Run A ("T1").
  const { service: serviceA } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const resultA = await serviceA.assembleYear({ year: 2022 });

  // A real, non-simulated wall-clock gap before Run B ("T2") -- neither the service constructor
  // nor `assembleYear`/`buildResearchUnderlyingDatasetAssembly` accepts any clock/time value any
  // more, so this alone genuinely reproduces Terra's two-different-wall-clock-times scenario.
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Run B ("T2") -- a SECOND, independent service instance and a SECOND, independent build.
  const { service: serviceB } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  const resultB = await serviceB.assembleYear({ year: 2022 });

  // A. checksums identical.
  assert.equal(resultA.assembly.assemblyContentChecksum, resultB.assembly.assemblyContentChecksum);
  // B. serialized deterministic assembly identical (byte-for-byte, not just checksum-equal).
  assert.equal(JSON.stringify(resultA.assembly), JSON.stringify(resultB.assembly));
  // C. content-addressed relative path identical.
  assert.equal(resultA.assemblyStorage?.relativePath, resultB.assemblyStorage?.relativePath);
  // D. first store (Run A, via buildService's default persistArtifactsToDisk:true) was newly written.
  assert.equal(resultA.assemblyStorage?.wasNewlyWritten, true);
  // E. second store (Run B) reused the existing file rather than writing a new one.
  assert.equal(resultB.assemblyStorage?.wasNewlyWritten, false);
  // F. Run B did not throw a content conflict (assembleYear/persistAssembly completed normally, proven by reaching this line).
  // G. reading the artifact back returns the exact same deterministic semantic content.
  const reread = readResearchUnderlyingDatasetAssembly(tempArchiveRoot, resultA.assembly.assemblyContentChecksum);
  assert.deepEqual(reread, resultA.assembly);
  // H. no generatedAt key anywhere in the stored bytes.
  const onDisk = readFileSync(resultA.assemblyStorage!.absolutePath, 'utf8');
  assert.equal(/"generatedAt"/.test(onDisk), false);
  // I. no other current-time/wall-clock field anywhere in the stored bytes.
  for (const forbidden of ['createdAt', 'updatedAt', 'runStartedAt', 'completedAt', 'timestamp']) {
    assert.equal(onDisk.includes(`"${forbidden}"`), false, `'${forbidden}' must never appear in the stored B-M7.2 assembly artifact`);
  }
});

// ---- 30/31/32/33: zero provider/DB-write/repair-service/B-M7.1-capture calls (structural) ----

test('30-33. this service source file never imports a provider client, Prisma write path, NiftyUnderlyingGapRepairService, or the B-M7.1 capture service', () => {
  const source = readFileSync(join(__dirname, 'nifty-underlying-research-assembly.service.ts'), 'utf8');
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false, 'must never import an Upstox provider module');
  assert.equal(/from\s+['"][^'"]*groww[^'"]*['"]/i.test(source), false, 'must never import a Groww provider module');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false, 'must never import a Prisma client directly');
  assert.equal(/NiftyUnderlyingGapRepairService/.test(source), false, 'must never reference the canonical repair service');
  assert.equal(/NiftyIndexGapImputationService/.test(source), false, 'must never reference/re-invoke the B-M7.1 capture service');
});

test('30-33 (runtime): only the two injected fake services are ever called -- zero real DB/provider access happens in these tests', async () => {
  const sessions = [fakeCanonicalSession('2022-01-03'), march7IncompleteSession()];
  const { service, manifestGenerator, calendarResolver } = buildService(sessions, REAL_DERIVED_ARTIFACT_ROOT, tempArchiveRoot);
  await service.assembleYear({ year: 2022 });
  assert.equal(manifestGenerator.callCount, 1);
  assert.equal(calendarResolver.callCount, 1);
});
