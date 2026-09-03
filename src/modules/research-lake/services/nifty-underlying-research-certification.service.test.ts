import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  DatasetManifest,
  HEALTH_SEMANTICS_VERSION,
  MANIFEST_SCHEMA_VERSION,
  ManifestDatasetKind,
  SessionManifest,
  UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  UnderlyingSessionIdentity,
  computeDatasetChecksum,
  deriveDatasetId,
} from '../domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import { ImputationReason, ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { AuthorizedDerivedImputedSessionSourceSelection, RealCanonicalSessionSourceSelection, ResearchSessionSourceSelection } from '../domain/research-session-source-selection';
import { buildResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION, RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION, storeResearchUnderlyingDatasetAssembly } from '../domain/research-underlying-assembly.types';
import { storeCanonicalDatasetManifestArtifact } from '../domain/canonical-dataset-manifest-artifact-store';
import { ParquetCompressionCodec, ParquetDatasetStorageDescriptor, ParquetVerificationRunResult, ParquetWriterFormat, PARQUET_STORAGE_SCHEMA_VERSION, parquetStorageManifestRelativePath } from '../domain/parquet-storage.types';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION } from '../domain/research-underlying-resampled-candle.types';
import {
  buildResearchUnderlyingResamplingManifest,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestSessionEntry,
  storeResearchUnderlyingResamplingManifest,
} from '../domain/research-underlying-resampling-manifest.types';
import { readResearchUnderlyingYearCertification } from '../domain/research-underlying-year-certification.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ResolvedResearchRowSourceKind, ResolvedResearchSessionRow, ResolveResearchSessionRowsOutcome } from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplerService from './research-underlying-resampler.service';
import ResearchUnderlyingResampledSessionReaderService from './research-underlying-resampled-session-reader.service';
import NiftyUnderlyingResearchCertificationService, {
  CalendarSessionsResolver,
  CertificationCanonicalStorageUnverifiedError,
  CertificationOneMinuteVerificationError,
  CertificationSourceBindingError,
  ParquetVerifier,
  SessionRowsResolver,
} from './nifty-underlying-research-certification.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const YEAR = 2022;
const REGULAR_WINDOW = regularSessionWindow();
const TIER1_DATE = '2022-01-03';
const TIER3_DATE = '2022-03-07';
const IMPUTED_MINUTES = [622, 623, 624]; // 10:22, 10:23, 10:24 IST
const resampler = new ResearchUnderlyingResamplerService();

function dayStartMs(tradingDate: string): number {
  return new Date(`${tradingDate}T00:00:00+05:30`).getTime();
}
function timeAtMinute(tradingDate: string, minuteOfDay: number): Date {
  return new Date(dayStartMs(tradingDate) + minuteOfDay * 60_000);
}

function realCanonicalRow(tradingDate: string, minuteOfDay: number): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: null,
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL },
  };
}

function derivedObservedRow(tradingDate: string, minuteOfDay: number): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: null,
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.DERIVED, derivedRowProvenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: 'a'.repeat(64) } },
  };
}

function derivedImputedRow(tradingDate: string, minuteOfDay: number, availableAtIso: string): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price),
    low: String(price),
    close: String(price),
    volume: '0',
    openInterest: null,
    availableAt: availableAtIso,
    provenance: {
      sourceKind: ResolvedResearchRowSourceKind.DERIVED,
      derivedRowProvenance: {
        kind: ResearchRowProvenanceKind.IMPUTED,
        method: 'LINEAR_BOUNDARY_INTERPOLATION',
        policyVersion: 1,
        authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
        reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
        leftAnchor: { candleTime: timeAtMinute(tradingDate, minuteOfDay - 1).toISOString(), field: 'CLOSE', contentChecksum: 'b'.repeat(64) },
        rightAnchor: { candleTime: timeAtMinute(tradingDate, minuteOfDay + 4).toISOString(), field: 'OPEN', contentChecksum: 'c'.repeat(64) },
        sourceSnapshotChecksum: 'a'.repeat(64),
      },
    },
  };
}

function fullRealCanonicalSession(tradingDate: string): ResolvedResearchSessionRow[] {
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) rows.push(realCanonicalRow(tradingDate, minute));
  return rows;
}

function march7ShapedSession(tradingDate: string): ResolvedResearchSessionRow[] {
  const availableAtIso = timeAtMinute(tradingDate, 626).toISOString();
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) {
    rows.push(IMPUTED_MINUTES.includes(minute) ? derivedImputedRow(tradingDate, minute, availableAtIso) : derivedObservedRow(tradingDate, minute));
  }
  return rows;
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
}

function healthySession(tradingDate: string): SessionManifest {
  return {
    identity: identityFor(tradingDate),
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    contentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
    calendarSessionWindows: [REGULAR_WINDOW],
  };
}

/**
 * B-M8-HIGH-03: the correct currently-PERSISTED canonical state for an
 * authorized-derived tier-3 date -- zero HistoricalCandle rows, which the
 * existing, unmodified `DatasetHealthValidatorService` classifies as
 * `PROVIDER_UNAVAILABLE` (never `INCOMPLETE`). This certification service
 * never reads `persistedCanonicalHealthStatus` itself (it trusts the
 * already-verified canonical manifest artifact + B-F6 descriptor + B-M7.2
 * assembly instead), so this fixture's exact status label does not affect
 * this test suite's pass/fail behavior -- it is corrected here purely so the
 * fixture accurately reflects real persisted-canonical semantics.
 */
function providerUnavailableSession(tradingDate: string): SessionManifest {
  return { ...healthySession(tradingDate), canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE, contentChecksum: 'i'.repeat(64) };
}

function buildCanonicalManifest(sessions: readonly SessionManifest[]): DatasetManifest {
  const sorted = [...sessions].sort((a, b) => (a.identity.tradingDate < b.identity.tradingDate ? -1 : 1));
  const datasetChecksum = computeDatasetChecksum(sorted.map((s) => ({ identity: s.identity, canonicalizationVersion: s.canonicalizationVersion, healthSemanticsVersion: s.healthSemanticsVersion, contentChecksum: s.contentChecksum })));
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    datasetChecksum,
    datasetId: deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, datasetChecksum),
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: `${YEAR}-01-01`, requestedToDate: `${YEAR}-12-31`, acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
    generatedAt: '2026-01-01T00:00:00.000Z',
    sessions: sorted,
    sessionCounts: { requested: sorted.length, included: sorted.length, healthy: 1, incomplete: 1, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
  };
}

function tier1Selection(tradingDate: string, session: SessionManifest): RealCanonicalSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    calendarSessionWindows: session.calendarSessionWindows,
    canonicalContentChecksum: session.contentChecksum,
    canonicalRowCount: session.canonicalRowCount,
  };
}

function tier3Selection(tradingDate: string): AuthorizedDerivedImputedSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    tradingDate,
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    derivedContentChecksum: 'd'.repeat(64),
    derivedArtifactRelativePath: `derived-imputed-sessions/${'d'.repeat(64)}.json`,
    sourceSnapshotChecksum: 'e'.repeat(64),
    sourceSnapshotProviderId: 'UPSTOX',
    realRowCount: 372,
    imputedRowCount: 3,
  };
}

class FakeSessionRowsResolver implements SessionRowsResolver {
  constructor(private readonly rowsByDate: Record<string, ResolvedResearchSessionRow[] | Error>) {}
  async resolveSessionRows(_instrumentKey: string, _timeframe: string, selection: ResearchSessionSourceSelection): Promise<ResolveResearchSessionRowsOutcome> {
    const outcome = this.rowsByDate[selection.tradingDate];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) return { kind: 'UNAVAILABLE' };
    return { kind: 'RESOLVED', rows: outcome };
  }
}

class FakeCalendarResolver implements CalendarSessionsResolver {
  constructor(
    private readonly tradingDates: string[],
    private readonly windowsByDate: Record<string, readonly SessionWindow[]>
  ) {}
  async resolveRequestedSessions() {
    return { tradingDates: this.tradingDates, calendarSessionWindows: this.windowsByDate };
  }
  async resolveSessionWindowsForDates(dates: readonly string[]) {
    const result: Record<string, readonly SessionWindow[]> = {};
    for (const date of dates) result[date] = this.windowsByDate[date] ?? [REGULAR_WINDOW];
    return result;
  }
}

class FakeParquetVerifier implements ParquetVerifier {
  constructor(private readonly result: ParquetVerificationRunResult) {}
  async verifyStorageDescriptor() {
    return this.result;
  }
}

function writeParquetDescriptor(root: string, manifest: DatasetManifest, dates: readonly string[], overrides: Partial<ParquetDatasetStorageDescriptor> = {}): void {
  const descriptor: ParquetDatasetStorageDescriptor = {
    storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
    datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum,
    datasetKind: manifest.datasetKind,
    writerFormat: ParquetWriterFormat.PARQUET,
    writerLibrary: 'hyparquet-writer',
    writerLibraryVersion: '0.16.6',
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sessions: dates.map((date) => ({ tradingDate: date, sessionContentChecksum: 'c'.repeat(64), relativePath: `sessions/${date}.parquet`, canonicalRowCount: 375, fileSizeBytes: 1000, physicalFileChecksum: 'p'.repeat(64) })),
    ...overrides,
  };
  const path = join(root, parquetStorageManifestRelativePath(manifest.datasetKind, manifest.datasetChecksum));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(descriptor, null, 2));
}

function verifiedResult(manifest: DatasetManifest, dates: readonly string[]): ParquetVerificationRunResult {
  return {
    verified: true,
    datasetId: manifest.datasetId,
    datasetKind: manifest.datasetKind,
    datasetLinkageMatches: true,
    sessionResults: dates.map((date) => ({ tradingDate: date, verified: true, physicalFileExists: true, physicalChecksumMatches: true, parquetParsed: true, rowCountMatches: true, logicalContentChecksumMatches: true, detail: null })),
    mismatchedTradingDates: [],
  };
}

function resamplingDescriptorFor(assemblyChecksum: string, selection: ResearchSessionSourceSelection, sourceContentChecksum: string, target: ResampleTargetTimeframe, rows: readonly ResolvedResearchSessionRow[]) {
  return resampler.resampleSession({
    sourceAssemblyChecksum: assemblyChecksum,
    tradingDate: selection.tradingDate,
    sourcePrecedenceTier: selection.precedenceTier,
    sourceContentChecksum,
    targetTimeframe: target,
    sessionWindows: [REGULAR_WINDOW],
    sourceRows: rows,
  }).descriptor;
}

interface Fixture {
  readonly canonicalManifest: DatasetManifest;
  readonly canonicalManifestRoot: string;
  readonly parquetOutputRoot: string;
  readonly assembly: ReturnType<typeof buildResearchUnderlyingDatasetAssembly>;
  readonly assemblyRoot: string;
  readonly resamplingManifestChecksum: string;
  readonly resamplingManifestRoot: string;
  readonly rowsByDate: Record<string, ResolvedResearchSessionRow[]>;
}

function buildFixture(): Fixture {
  const tier1Session = healthySession(TIER1_DATE);
  const tier3Session = providerUnavailableSession(TIER3_DATE);
  const canonicalManifest = buildCanonicalManifest([tier1Session, tier3Session]);

  const tier1Sel = tier1Selection(TIER1_DATE, tier1Session);
  const tier3Sel = tier3Selection(TIER3_DATE);

  const assembly = buildResearchUnderlyingDatasetAssembly({
    schemaVersion: RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
    assemblySemanticsVersion: RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: YEAR },
    canonicalManifest: { datasetKind: canonicalManifest.datasetKind, datasetId: canonicalManifest.datasetId, datasetChecksum: canonicalManifest.datasetChecksum, manifestSchemaVersion: canonicalManifest.manifestSchemaVersion, canonicalizationVersion: canonicalManifest.canonicalizationVersion, healthSemanticsVersion: canonicalManifest.healthSemanticsVersion },
    sessions: [tier1Sel, tier3Sel],
  });

  const rowsByDate: Record<string, ResolvedResearchSessionRow[]> = { [TIER1_DATE]: fullRealCanonicalSession(TIER1_DATE), [TIER3_DATE]: march7ShapedSession(TIER3_DATE) };

  const sessionEntries: ResearchUnderlyingResamplingManifestSessionEntry[] = [
    {
      tradingDate: TIER1_DATE,
      targets: {
        [ResampleTargetTimeframe.TWO_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.TWO_MINUTE, rowsByDate[TIER1_DATE]),
        [ResampleTargetTimeframe.THREE_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.THREE_MINUTE, rowsByDate[TIER1_DATE]),
        [ResampleTargetTimeframe.FIVE_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.FIVE_MINUTE, rowsByDate[TIER1_DATE]),
      },
    },
    {
      tradingDate: TIER3_DATE,
      targets: {
        [ResampleTargetTimeframe.TWO_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier3Sel, tier3Sel.derivedContentChecksum, ResampleTargetTimeframe.TWO_MINUTE, rowsByDate[TIER3_DATE]),
        [ResampleTargetTimeframe.THREE_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier3Sel, tier3Sel.derivedContentChecksum, ResampleTargetTimeframe.THREE_MINUTE, rowsByDate[TIER3_DATE]),
        [ResampleTargetTimeframe.FIVE_MINUTE]: resamplingDescriptorFor(assembly.assemblyContentChecksum, tier3Sel, tier3Sel.derivedContentChecksum, ResampleTargetTimeframe.FIVE_MINUTE, rowsByDate[TIER3_DATE]),
      },
    },
  ];

  const resamplingManifest = buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
    sourceAssemblyChecksum: assembly.assemblyContentChecksum,
    identity: { instrumentKey: INSTRUMENT_KEY, sourceTimeframe: TIMEFRAME, year: YEAR },
    targetTimeframes: RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
    sourceSessionCounts: { expectedSessions: 2, unavailableSessions: 0 },
    sessions: sessionEntries,
  });

  const canonicalManifestRoot = tempRoot('cert-canonical-manifest-');
  const parquetOutputRoot = tempRoot('cert-parquet-');
  const assemblyRoot = tempRoot('cert-assembly-');
  const resamplingManifestRoot = tempRoot('cert-resampling-');

  storeCanonicalDatasetManifestArtifact(canonicalManifestRoot, canonicalManifest);
  writeParquetDescriptor(parquetOutputRoot, canonicalManifest, [TIER1_DATE]);
  storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);
  storeResearchUnderlyingResamplingManifest(resamplingManifestRoot, resamplingManifest);

  return { canonicalManifest, canonicalManifestRoot, parquetOutputRoot, assembly, assemblyRoot, resamplingManifestChecksum: resamplingManifest.manifestContentChecksum, resamplingManifestRoot, rowsByDate };
}

function cleanupFixture(fixture: Fixture): void {
  for (const root of [fixture.canonicalManifestRoot, fixture.parquetOutputRoot, fixture.assemblyRoot, fixture.resamplingManifestRoot]) {
    rmSync(root, { recursive: true, force: true });
  }
}

function buildService(fixture: Fixture, overrides: { parquetVerifyService?: ParquetVerifier; sessionRowsResolver?: SessionRowsResolver } = {}): NiftyUnderlyingResearchCertificationService {
  const rowsResolver = overrides.sessionRowsResolver ?? new FakeSessionRowsResolver(fixture.rowsByDate);
  return new NiftyUnderlyingResearchCertificationService({
    sessionRowsResolver: rowsResolver,
    resampledSessionReader: new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver }),
    calendarSessionsResolver: new FakeCalendarResolver([TIER1_DATE, TIER3_DATE], { [TIER1_DATE]: [REGULAR_WINDOW], [TIER3_DATE]: [REGULAR_WINDOW] }),
    parquetVerifyService: overrides.parquetVerifyService ?? new FakeParquetVerifier(verifiedResult(fixture.canonicalManifest, [TIER1_DATE])),
    canonicalManifestArtifactRoot: fixture.canonicalManifestRoot,
    parquetOutputRoot: fixture.parquetOutputRoot,
    sourceAssemblyRoot: fixture.assemblyRoot,
    resamplingManifestRoot: fixture.resamplingManifestRoot,
  });
}

// ============================================================================
// happy path
// ============================================================================

test('happy path: certifies 2/2 sessions, exact March-7 no-lookahead proof, coherent summary', async () => {
  const fixture = buildFixture();
  try {
    const service = buildService(fixture);
    const result = await service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum });

    assert.equal(result.certification.sessions.length, 2);
    assert.equal(result.certification.summary.verifiedSessions, 2);
    assert.equal(result.certification.summary.realCanonicalSessions, 1);
    assert.equal(result.certification.summary.authorizedDerivedSessions, 1);

    const march7 = result.certification.march7Proof;
    assert.equal(march7.tradingDate, TIER3_DATE);
    assert.deepEqual(march7.imputedMinutesIst, ['10:22', '10:23', '10:24']);
    assert.equal(march7.leftRealAnchorIst, '10:21');
    assert.equal(march7.rightRealAnchorIst, '10:25');
    assert.equal(march7.entries.length, 5);
    assert.ok(march7.entries.every((entry) => entry.verified));

    const threeMinuteEntry = march7.entries.find((entry) => entry.target === ResampleTargetTimeframe.THREE_MINUTE && entry.bucketStartIst === '10:24');
    assert.equal(threeMinuteEntry?.expectedAvailableAtIst, '10:27');

    const march7Session = result.certification.sessions.find((s) => s.tradingDate === TIER3_DATE);
    assert.equal(march7Session?.derivedImputedRowCount, 3);
    assert.equal(march7Session?.derivedObservedRowCount, 372);
    assert.ok(march7Session?.targets.every((t) => t.noLookaheadVerified));
  } finally {
    cleanupFixture(fixture);
  }
});

test('persistCertification writes to the configured root and re-reads cleanly', async () => {
  const fixture = buildFixture();
  const certRoot = tempRoot('cert-artifact-');
  try {
    const service = new NiftyUnderlyingResearchCertificationService({
      sessionRowsResolver: new FakeSessionRowsResolver(fixture.rowsByDate),
      resampledSessionReader: new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver(fixture.rowsByDate) }),
      calendarSessionsResolver: new FakeCalendarResolver([TIER1_DATE, TIER3_DATE], { [TIER1_DATE]: [REGULAR_WINDOW], [TIER3_DATE]: [REGULAR_WINDOW] }),
      parquetVerifyService: new FakeParquetVerifier(verifiedResult(fixture.canonicalManifest, [TIER1_DATE])),
      canonicalManifestArtifactRoot: fixture.canonicalManifestRoot,
      parquetOutputRoot: fixture.parquetOutputRoot,
      sourceAssemblyRoot: fixture.assemblyRoot,
      resamplingManifestRoot: fixture.resamplingManifestRoot,
      certificationArtifactRoot: certRoot,
    });
    const result = await service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum });
    const stored = service.persistCertification(result.certification);
    assert.equal(stored.wasNewlyWritten, true);
    const readBack = readResearchUnderlyingYearCertification(certRoot, result.certification.certificationContentChecksum);
    assert.equal(readBack.certificationContentChecksum, result.certification.certificationContentChecksum);
  } finally {
    cleanupFixture(fixture);
    rmSync(certRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// canonical manifest / Parquet storage gating
// ============================================================================

test('missing canonical manifest artifact fails closed', async () => {
  const fixture = buildFixture();
  try {
    const missingRoot = tempRoot('cert-missing-manifest-');
    try {
      const service = buildService({ ...fixture, canonicalManifestRoot: missingRoot });
      await assert.rejects(() => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }));
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('missing Parquet storage descriptor fails closed with CertificationCanonicalStorageUnverifiedError', async () => {
  const fixture = buildFixture();
  try {
    const emptyParquetRoot = tempRoot('cert-no-parquet-');
    try {
      const service = buildService({ ...fixture, parquetOutputRoot: emptyParquetRoot });
      await assert.rejects(
        () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
        CertificationCanonicalStorageUnverifiedError
      );
    } finally {
      rmSync(emptyParquetRoot, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('Parquet verify not fully verified fails closed', async () => {
  const fixture = buildFixture();
  try {
    const badVerify: ParquetVerificationRunResult = { ...verifiedResult(fixture.canonicalManifest, [TIER1_DATE]), verified: false, mismatchedTradingDates: [TIER1_DATE] };
    const service = buildService(fixture, { parquetVerifyService: new FakeParquetVerifier(badVerify) });
    await assert.rejects(
      () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
      CertificationCanonicalStorageUnverifiedError
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('a Parquet descriptor date set that does not exactly equal the B-M7.2 real-canonical date set fails closed', async () => {
  const fixture = buildFixture();
  try {
    // Overwrite the descriptor with an orphan date instead of the real tier-1 date.
    writeParquetDescriptor(fixture.parquetOutputRoot, fixture.canonicalManifest, [TIER3_DATE]);
    const service = buildService(fixture, { parquetVerifyService: new FakeParquetVerifier(verifiedResult(fixture.canonicalManifest, [TIER3_DATE])) });
    await assert.rejects(
      () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
      CertificationCanonicalStorageUnverifiedError
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// ============================================================================
// binding checks
// ============================================================================

test('wrong expected canonical checksum fails closed', async () => {
  const fixture = buildFixture();
  try {
    const service = buildService(fixture);
    await assert.rejects(() => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: '0'.repeat(64), sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }));
  } finally {
    cleanupFixture(fixture);
  }
});

test('B-M7.3 resampling manifest whose sourceAssemblyChecksum does not match the requested B-M7.2 checksum fails closed', async () => {
  const fixture = buildFixture();
  try {
    const wrongResamplingRoot = tempRoot('cert-wrong-resampling-');
    try {
      // Build a resampling manifest bound to a DIFFERENT (fake) source assembly checksum.
      const tier1Session = healthySession(TIER1_DATE);
      const tier1Sel = tier1Selection(TIER1_DATE, tier1Session);
      const badAssemblyChecksum = '9'.repeat(64);
      const badEntries: ResearchUnderlyingResamplingManifestSessionEntry[] = [
        {
          tradingDate: TIER1_DATE,
          targets: {
            [ResampleTargetTimeframe.TWO_MINUTE]: resamplingDescriptorFor(badAssemblyChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.TWO_MINUTE, fixture.rowsByDate[TIER1_DATE]),
            [ResampleTargetTimeframe.THREE_MINUTE]: resamplingDescriptorFor(badAssemblyChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.THREE_MINUTE, fixture.rowsByDate[TIER1_DATE]),
            [ResampleTargetTimeframe.FIVE_MINUTE]: resamplingDescriptorFor(badAssemblyChecksum, tier1Sel, tier1Sel.canonicalContentChecksum, ResampleTargetTimeframe.FIVE_MINUTE, fixture.rowsByDate[TIER1_DATE]),
          },
        },
      ];
      const badManifest = buildResearchUnderlyingResamplingManifest({
        schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
        resamplingSemanticsVersion: RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
        sourceAssemblyChecksum: badAssemblyChecksum,
        identity: { instrumentKey: INSTRUMENT_KEY, sourceTimeframe: TIMEFRAME, year: YEAR },
        targetTimeframes: RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
        sourceSessionCounts: { expectedSessions: 1, unavailableSessions: 0 },
        sessions: badEntries,
      });
      storeResearchUnderlyingResamplingManifest(wrongResamplingRoot, badManifest);

      const service = buildService({ ...fixture, resamplingManifestRoot: wrongResamplingRoot, resamplingManifestChecksum: badManifest.manifestContentChecksum });
      await assert.rejects(
        () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: badManifest.manifestContentChecksum }),
        CertificationSourceBindingError
      );
    } finally {
      rmSync(wrongResamplingRoot, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('a certified-calendar date set that does not match the B-M7.2 assembly date set fails closed', async () => {
  const fixture = buildFixture();
  try {
    const service = new NiftyUnderlyingResearchCertificationService({
      sessionRowsResolver: new FakeSessionRowsResolver(fixture.rowsByDate),
      resampledSessionReader: new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver(fixture.rowsByDate) }),
      calendarSessionsResolver: new FakeCalendarResolver([TIER1_DATE], { [TIER1_DATE]: [REGULAR_WINDOW] }), // missing TIER3_DATE
      parquetVerifyService: new FakeParquetVerifier(verifiedResult(fixture.canonicalManifest, [TIER1_DATE])),
      canonicalManifestArtifactRoot: fixture.canonicalManifestRoot,
      parquetOutputRoot: fixture.parquetOutputRoot,
      sourceAssemblyRoot: fixture.assemblyRoot,
      resamplingManifestRoot: fixture.resamplingManifestRoot,
    });
    await assert.rejects(
      () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
      CertificationSourceBindingError
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// ============================================================================
// 1m certification fail-closed propagation
// ============================================================================

test('a 1m reader error (canonical DB drift / corrupted derived artifact) propagates fail closed', async () => {
  const fixture = buildFixture();
  try {
    const service = buildService(fixture, { sessionRowsResolver: new FakeSessionRowsResolver({ [TIER1_DATE]: new Error('canonical content drift detected'), [TIER3_DATE]: fixture.rowsByDate[TIER3_DATE] }) });
    await assert.rejects(
      () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
      /canonical content drift detected/
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('a missing expected 1m minute fails 1m certification closed', async () => {
  const fixture = buildFixture();
  try {
    const brokenRows = fixture.rowsByDate[TIER1_DATE].filter((row) => row.candleTime !== timeAtMinute(TIER1_DATE, 700).toISOString());
    const service = buildService(fixture, { sessionRowsResolver: new FakeSessionRowsResolver({ [TIER1_DATE]: brokenRows, [TIER3_DATE]: fixture.rowsByDate[TIER3_DATE] }) });
    await assert.rejects(
      () => service.certifyYear({ year: YEAR, expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum, sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum, resamplingManifestChecksum: fixture.resamplingManifestChecksum }),
      CertificationOneMinuteVerificationError
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// ============================================================================
// B-M8-HIGH-01: physical storage identity is fully bound (real B-F6 descriptor -> certification integration)
// ============================================================================

async function certifyWithDescriptorOverrides(overrides: Partial<ParquetDatasetStorageDescriptor>): Promise<string> {
  const fixture = buildFixture();
  try {
    writeParquetDescriptor(fixture.parquetOutputRoot, fixture.canonicalManifest, [TIER1_DATE], overrides);
    const service = buildService(fixture);
    const result = await service.certifyYear({
      year: YEAR,
      expectedCanonicalDatasetChecksum: fixture.canonicalManifest.datasetChecksum,
      sourceAssemblyChecksum: fixture.assembly.assemblyContentChecksum,
      resamplingManifestChecksum: fixture.resamplingManifestChecksum,
    });
    return result.certification.certificationContentChecksum;
  } finally {
    cleanupFixture(fixture);
  }
}

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor datasetId changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ datasetId: 'FORGED_DATASET_ID' });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor datasetKind changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor writerFormat changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ writerFormat: 'FORGED_FORMAT' as unknown as ParquetWriterFormat });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor writerLibrary changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ writerLibrary: 'forged-writer-lib' });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor writerLibraryVersion changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ writerLibraryVersion: '999.999.999' });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering only the real B-F6 descriptor compressionCodec changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({ compressionCodec: 'GZIP' as unknown as ParquetCompressionCodec });
  assert.notEqual(baseline, tampered);
});

test('B-M8-HIGH-01 integration: altering ONLY the real B-F6 descriptor generatedAt leaves the certification checksum UNCHANGED', async () => {
  const a = await certifyWithDescriptorOverrides({ generatedAt: '2020-01-01T00:00:00.000Z' });
  const b = await certifyWithDescriptorOverrides({ generatedAt: '2030-06-15T12:34:56.000Z' });
  assert.equal(a, b);
});

test('B-M8-HIGH-01 integration: altering one physical session physicalFileChecksum still changes the certification checksum', async () => {
  const baseline = await certifyWithDescriptorOverrides({});
  const tampered = await certifyWithDescriptorOverrides({
    sessions: [{ tradingDate: TIER1_DATE, sessionContentChecksum: 'c'.repeat(64), relativePath: `sessions/${TIER1_DATE}.parquet`, canonicalRowCount: 375, fileSizeBytes: 1000, physicalFileChecksum: 'F'.repeat(64) }],
  });
  assert.notEqual(baseline, tampered);
});
