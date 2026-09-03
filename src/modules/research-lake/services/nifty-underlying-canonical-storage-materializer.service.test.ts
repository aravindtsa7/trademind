import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { sha256Hex } from '../domain/dataset-manifest-canonical-json';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { RealCanonicalSessionSourceSelection, AuthorizedDerivedImputedSessionSourceSelection, ResearchSessionSourceSelection } from '../domain/research-session-source-selection';
import { buildResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION, RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION, storeResearchUnderlyingDatasetAssembly } from '../domain/research-underlying-assembly.types';
import { readCanonicalDatasetManifestArtifact } from '../domain/canonical-dataset-manifest-artifact-store';
import { ParquetCompressionCodec, ParquetDatasetStorageDescriptor, ParquetExportRunResult, ParquetSessionExportStatus, ParquetVerificationRunResult, ParquetWriterFormat, PARQUET_STORAGE_SCHEMA_VERSION } from '../domain/parquet-storage.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ExportDatasetRequest } from './research-lake-parquet-export.service';
import { VerifyStorageDescriptorRequest } from './research-lake-parquet-verify.service';
import NiftyUnderlyingCanonicalStorageMaterializerService, {
  CalendarSessionsResolver,
  CanonicalManifestChecksumMismatchError,
  CanonicalStorageExportShapeError,
  CanonicalStoragePreflightError,
  CanonicalStorageVerificationError,
  ParquetExporter,
  ParquetVerifier,
  UnderlyingManifestGenerator,
} from './nifty-underlying-canonical-storage-materializer.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const YEAR = 2022;
const REGULAR_WINDOW = regularSessionWindow();
const TIER1_DATES = ['2022-01-03', '2022-01-04', '2022-01-05'];
const TIER3_DATE = '2022-03-07';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
}

function contentChecksumFor(tradingDate: string): string {
  return sha256Hex(`session-content:${tradingDate}`);
}

function healthySession(tradingDate: string, windows: readonly SessionWindow[] = [REGULAR_WINDOW]): SessionManifest {
  return {
    identity: identityFor(tradingDate),
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    contentChecksum: contentChecksumFor(tradingDate),
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
    calendarSessionWindows: windows,
  };
}

/**
 * B-M8-HIGH-03: used ONLY to build an adversarial fixture proving INCOMPLETE
 * correctly fails tier-3 preflight. Under the existing, UNMODIFIED
 * `DatasetHealthValidatorService` rule (`sourceRowCount === 0` ->
 * `PROVIDER_UNAVAILABLE`, checked and returned BEFORE the code path that
 * could ever produce `INCOMPLETE`), a real zero-row reconstructed session can
 * NEVER actually be INCOMPLETE -- this fixture intentionally constructs an
 * otherwise-impossible combination purely to prove the materializer's OWN
 * preflight guard independently rejects it, never to model real data.
 */
function incompleteSession(tradingDate: string, windows: readonly SessionWindow[] = [REGULAR_WINDOW]): SessionManifest {
  return { ...healthySession(tradingDate, windows), canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE, contentChecksum: contentChecksumFor(`incomplete:${tradingDate}`) };
}

/**
 * B-M8-HIGH-03: the CORRECT currently-PERSISTED canonical state for an
 * authorized-derived tier-3 date (e.g. March-7 2022) -- zero HistoricalCandle
 * rows are currently persisted, which the existing, unmodified
 * `DatasetHealthValidatorService` classifies as `PROVIDER_UNAVAILABLE` (its
 * `sourceRowCount === 0` rule), NEVER `INCOMPLETE`. This describes PERSISTED
 * canonical content only -- it says nothing about the ORIGINAL Upstox
 * acquisition, which the trusted B-M7.2 authorized-derived selection
 * separately tracks (sourceSnapshotChecksum/realRowCount/imputedRowCount).
 */
function providerUnavailableTier3Session(tradingDate: string, windows: readonly SessionWindow[] = [REGULAR_WINDOW]): SessionManifest {
  return { ...healthySession(tradingDate, windows), canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE, contentChecksum: contentChecksumFor(`provider-unavailable:${tradingDate}`) };
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
    sessionCounts: { requested: sorted.length, included: sorted.length, healthy: sorted.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.HEALTHY).length, incomplete: sorted.filter((s) => s.persistedCanonicalHealthStatus === DatasetHealthStatus.INCOMPLETE).length, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
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

function writeAssembly(root: string, canonicalManifest: DatasetManifest, sessions: readonly ResearchSessionSourceSelection[], canonicalManifestChecksumOverride?: string) {
  return buildResearchUnderlyingDatasetAssembly({
    schemaVersion: RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
    assemblySemanticsVersion: RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: YEAR },
    canonicalManifest: {
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      datasetId: canonicalManifest.datasetId,
      datasetChecksum: canonicalManifestChecksumOverride ?? canonicalManifest.datasetChecksum,
      manifestSchemaVersion: canonicalManifest.manifestSchemaVersion,
      canonicalizationVersion: canonicalManifest.canonicalizationVersion,
      healthSemanticsVersion: canonicalManifest.healthSemanticsVersion,
    },
    sessions,
  });
}

function fullTopology(): { manifest: DatasetManifest; sessions: SessionManifest[]; tier1: RealCanonicalSessionSourceSelection[]; tier3: AuthorizedDerivedImputedSessionSourceSelection } {
  const tier1Sessions = TIER1_DATES.map((d) => healthySession(d));
  const tier3Session = providerUnavailableTier3Session(TIER3_DATE);
  const manifest = buildCanonicalManifest([...tier1Sessions, tier3Session]);
  return { manifest, sessions: [...tier1Sessions, tier3Session], tier1: TIER1_DATES.map((d, i) => tier1Selection(d, tier1Sessions[i])), tier3: tier3Selection(TIER3_DATE) };
}

class FakeCalendarResolver implements CalendarSessionsResolver {
  async resolveRequestedSessions() {
    return { tradingDates: [...TIER1_DATES, TIER3_DATE], calendarSessionWindows: Object.fromEntries([...TIER1_DATES, TIER3_DATE].map((d) => [d, [REGULAR_WINDOW]])) };
  }
}

class FakeManifestGenerator implements UnderlyingManifestGenerator {
  constructor(private readonly manifest: DatasetManifest) {}
  async generateUnderlyingManifest() {
    return this.manifest;
  }
}

class FakeParquetExporter implements ParquetExporter {
  public calls: ExportDatasetRequest[] = [];
  constructor(private readonly build: (request: ExportDatasetRequest) => ParquetExportRunResult) {}
  async exportDataset(request: ExportDatasetRequest) {
    this.calls.push(request);
    return this.build(request);
  }
}

class FakeParquetVerifier implements ParquetVerifier {
  public calls: VerifyStorageDescriptorRequest[] = [];
  constructor(private readonly result: ParquetVerificationRunResult) {}
  async verifyStorageDescriptor(request: VerifyStorageDescriptorRequest) {
    this.calls.push(request);
    return this.result;
  }
}

function exportResultFor(manifest: DatasetManifest, realDates: readonly string[], excludedDates: readonly string[]): ParquetExportRunResult {
  const sessions = manifest.sessions.map((session) => {
    const date = session.identity.tradingDate;
    if (realDates.includes(date)) {
      return { tradingDate: date, status: ParquetSessionExportStatus.WRITTEN, rowCount: session.canonicalRowCount, logicalContentChecksum: session.contentChecksum, physicalFileChecksum: sha256Hex(date), fileSizeBytes: 1000, relativePath: `sessions/${date}.parquet`, detail: null };
    }
    return { tradingDate: date, status: ParquetSessionExportStatus.REJECTED_HEALTH_POLICY, rowCount: null, logicalContentChecksum: null, physicalFileChecksum: null, fileSizeBytes: null, relativePath: null, detail: 'excluded' };
  });
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
    sessions: sessions
      .filter((s) => s.status === ParquetSessionExportStatus.WRITTEN)
      .map((s) => ({ tradingDate: s.tradingDate, sessionContentChecksum: s.logicalContentChecksum as string, relativePath: s.relativePath as string, canonicalRowCount: s.rowCount as number, fileSizeBytes: s.fileSizeBytes as number, physicalFileChecksum: s.physicalFileChecksum as string })),
  };
  void excludedDates;
  return {
    datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum,
    datasetKind: manifest.datasetKind,
    storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    sessionsRequested: manifest.sessions.length,
    sessionsWritten: realDates.length,
    sessionsSkippedVerified: 0,
    sessionsFailed: manifest.sessions.length - realDates.length,
    sessions,
    descriptor,
    descriptorPath: null,
  };
}

function verifiedResultFor(manifest: DatasetManifest, realDates: readonly string[]): ParquetVerificationRunResult {
  return {
    verified: true,
    datasetId: manifest.datasetId,
    datasetKind: manifest.datasetKind,
    datasetLinkageMatches: true,
    sessionResults: realDates.map((date) => ({ tradingDate: date, verified: true, physicalFileExists: true, physicalChecksumMatches: true, parquetParsed: true, rowCountMatches: true, logicalContentChecksumMatches: true, detail: null })),
    mismatchedTradingDates: [],
  };
}

// ============================================================================
// happy path
// ============================================================================

test('happy path: reconstructs canonical manifest, validates checksum, preflights, persists manifest artifact, exports+verifies Parquet', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE]));
    const verifier = new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: verifier,
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    const result = await service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum });

    assert.equal(result.canonicalManifest.datasetChecksum, manifest.datasetChecksum);
    assert.equal(result.manifestArtifact.wasNewlyWritten, true);
    assert.equal(exporter.calls.length, 1);
    assert.equal(verifier.calls.length, 1);
    assert.equal(result.verifyResult.verified, true);

    // B-M8-HIGH-03: the tier-3 (March-7-shaped) date -- currently-PERSISTED canonicalRowCount=0 /
    // persistedCanonicalHealthStatus=PROVIDER_UNAVAILABLE -- is correctly ACCEPTED by preflight (no throw
    // above) yet still correctly EXCLUDED from canonical Parquet by B-F6's own unmodified health policy.
    const march7Export = result.exportResult.sessions.find((s) => s.tradingDate === TIER3_DATE);
    assert.equal(march7Export?.status, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY);

    const readBack = readCanonicalDatasetManifestArtifact(manifestRoot, manifest.datasetKind, manifest.datasetId);
    assert.equal(readBack.datasetChecksum, manifest.datasetChecksum);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// checksum validation
// ============================================================================

test('wrong expected canonical checksum fails closed BEFORE any write (no manifest artifact, no export, no verify)', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE]));
    const verifier = new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: verifier,
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: '0'.repeat(64), sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalManifestChecksumMismatchError);
    assert.equal(exporter.calls.length, 0);
    assert.equal(verifier.calls.length, 0);
    assert.throws(() => readCanonicalDatasetManifestArtifact(manifestRoot, manifest.datasetKind, manifest.datasetId));
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('B-M7.2 assembly canonicalManifest.datasetChecksum mismatch fails closed before any write', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3], '9'.repeat(64));
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE]));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }));
    assert.equal(exporter.calls.length, 0);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// preflight
// ============================================================================

test('tier1 canonical content drift (B-M7.2-recorded checksum no longer matches) fails closed before Parquet export', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const driftedTier1 = tier1.map((s, i) => (i === 0 ? { ...s, canonicalContentChecksum: 'f'.repeat(64) } : s));
    const assembly = writeAssembly(assemblyRoot, manifest, [...driftedTier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE]));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStoragePreflightError);
    assert.equal(exporter.calls.length, 0);
    assert.throws(() => readCanonicalDatasetManifestArtifact(manifestRoot, manifest.datasetKind, manifest.datasetId));
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('a missing B-M7.2-selected date in the reconstructed manifest fails closed', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const extraSelection = tier1Selection('2022-01-06', healthySession('2022-01-06'));
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3, extraSelection]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE])),
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStoragePreflightError);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// B-M8-HIGH-03: tier-3 (authorized-derived) preflight -- correct zero-row
// semantic is PROVIDER_UNAVAILABLE (never INCOMPLETE), reproducing and fixing
// the real B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION preflight failure.
// ============================================================================

/** Builds a full topology whose tier-3 (March-7-shaped) canonical session is REPLACED by `tier3Session`, then asserts `materialize()` rejects with `CanonicalStoragePreflightError`. */
async function tier3PreflightRejects(tier3Session: SessionManifest): Promise<void> {
  const tier1Sessions = TIER1_DATES.map((d) => healthySession(d));
  const manifest = buildCanonicalManifest([...tier1Sessions, tier3Session]);
  const tier1 = TIER1_DATES.map((d, i) => tier1Selection(d, tier1Sessions[i]));
  const tier3 = tier3Selection(TIER3_DATE);
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE])),
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStoragePreflightError);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
}

test('B-M8-HIGH-03 REAL FAILURE REPRO (now fixed): tier-3 canonicalRowCount=0 / persistedCanonicalHealthStatus=PROVIDER_UNAVAILABLE is ACCEPTED by preflight', async () => {
  // fullTopology() now builds March-7 with the CORRECT persisted state -- this is exactly the state the
  // real `npm run research:nifty-2022:materialize-storage` run observed and, before this fix, wrongly rejected.
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE])),
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    const tier3Session = manifest.sessions.find((s) => s.identity.tradingDate === TIER3_DATE);
    assert.equal(tier3Session?.canonicalRowCount, 0);
    assert.equal(tier3Session?.persistedCanonicalHealthStatus, DatasetHealthStatus.PROVIDER_UNAVAILABLE);

    // Must NOT throw -- this is the exact scenario that previously threw CanonicalStoragePreflightError.
    await service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum });
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('B-M8-HIGH-03 adversarial 1: tier3 canonicalRowCount > 0 (even labeled PROVIDER_UNAVAILABLE) fails closed', async () => {
  await tier3PreflightRejects({ ...providerUnavailableTier3Session(TIER3_DATE), canonicalRowCount: 1 });
});

test('B-M8-HIGH-03 adversarial 2: tier3 persisted status HEALTHY (with rows) fails closed', async () => {
  await tier3PreflightRejects(healthySession(TIER3_DATE));
});

test('B-M8-HIGH-03 adversarial 3: tier3 persisted status NORMALIZED_WITH_EXCLUSIONS fails closed', async () => {
  await tier3PreflightRejects({ ...healthySession(TIER3_DATE), persistedCanonicalHealthStatus: DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS });
});

test('B-M8-HIGH-03 adversarial 4: tier3 persisted status INCOMPLETE fails closed -- INCOMPLETE is impossible for a real zero-row session under the current, unmodified DatasetHealthValidatorService rule (sourceRowCount===0 always yields PROVIDER_UNAVAILABLE before INCOMPLETE could ever be computed), so this must remain rejected, never re-accepted', async () => {
  await tier3PreflightRejects(incompleteSession(TIER3_DATE));
});

test('B-M8-HIGH-03 adversarial 5: tier3 persisted status INVALID fails closed', async () => {
  await tier3PreflightRejects({ ...healthySession(TIER3_DATE), canonicalRowCount: 0, persistedCanonicalHealthStatus: DatasetHealthStatus.INVALID, contentChecksum: contentChecksumFor(`invalid:${TIER3_DATE}`) });
});

test('B-M8-HIGH-03 adversarial 6: a sourceAssemblyChecksum with no matching stored B-M7.2 assembly fails closed (the tier-3 authorization/identity can only ever reach the materializer bound inside a genuine, content-addressed B-M7.2 assembly)', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE])),
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES)),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });
    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: 'f'.repeat(64) }));
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('B-M8-HIGH-03: persistedCanonicalHealthStatus does not participate in computeDatasetChecksum -- correcting the March-7 status label from INCOMPLETE to PROVIDER_UNAVAILABLE cannot change the trusted canonical dataset identity/checksum', () => {
  const checksumInput = (s: SessionManifest) => ({ identity: s.identity, canonicalizationVersion: s.canonicalizationVersion, healthSemanticsVersion: s.healthSemanticsVersion, contentChecksum: s.contentChecksum });
  const incompleteLabeled = incompleteSession(TIER3_DATE);
  const providerUnavailableLabeled = { ...incompleteLabeled, persistedCanonicalHealthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE };
  const checksumWithIncompleteLabel = computeDatasetChecksum([checksumInput(incompleteLabeled)]);
  const checksumWithProviderUnavailableLabel = computeDatasetChecksum([checksumInput(providerUnavailableLabeled)]);
  assert.equal(
    checksumWithIncompleteLabel,
    checksumWithProviderUnavailableLabel,
    'computeDatasetChecksum hashes only identity/canonicalizationVersion/healthSemanticsVersion/contentChecksum -- persistedCanonicalHealthStatus and canonicalRowCount are observability fields never bound into dataset identity'
  );
});

// ============================================================================
// export shape (no orphan, no missing real-canonical date, March-7 excluded)
// ============================================================================

test('a missing real-canonical export entry fails final acceptance', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    // Only 2 of the 3 real-canonical dates were actually written.
    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES.slice(0, 2), [TIER3_DATE]));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, TIER1_DATES.slice(0, 2))),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStorageExportShapeError);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('March-7 (a non-real-canonical date) accidentally appearing in the exported/written set is rejected as an orphan', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    // March-7 was (incorrectly) also written.
    const exporter = new FakeParquetExporter(() => exportResultFor(manifest, [...TIER1_DATES, TIER3_DATE], []));
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: exporter,
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, [...TIER1_DATES, TIER3_DATE])),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStorageExportShapeError);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

test('final Parquet verification not fully verified fails closed', async () => {
  const { manifest, tier1, tier3 } = fullTopology();
  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, [...tier1, tier3]);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    const badVerify: ParquetVerificationRunResult = { ...verifiedResultFor(manifest, TIER1_DATES), verified: false, mismatchedTradingDates: [TIER1_DATES[0]] };
    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new FakeCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, TIER1_DATES, [TIER3_DATE])),
      parquetVerifyService: new FakeParquetVerifier(badVerify),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    await assert.rejects(() => service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum }), CanonicalStorageVerificationError);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// special session window is respected (never hardcoded)
// ============================================================================

test('a special-session (60-minute) window is threaded through calendarSessionWindows, never hardcoded to the regular 375-minute window', async () => {
  const specialWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 615 };
  const specialDate = '2022-10-24';
  const specialSession = healthySession(specialDate, [specialWindow]);
  const manifest = buildCanonicalManifest([...TIER1_DATES.map((d) => healthySession(d)), specialSession]);
  const selections = [...TIER1_DATES.map((d, i) => tier1Selection(d, manifest.sessions[i])), tier1Selection(specialDate, specialSession)];

  const assemblyRoot = tempRoot('materializer-assembly-');
  const manifestRoot = tempRoot('materializer-manifest-');
  try {
    const assembly = writeAssembly(assemblyRoot, manifest, selections);
    storeResearchUnderlyingDatasetAssembly(assemblyRoot, assembly);

    class SpecialCalendarResolver implements CalendarSessionsResolver {
      async resolveRequestedSessions() {
        return { tradingDates: [...TIER1_DATES, specialDate], calendarSessionWindows: Object.fromEntries([...TIER1_DATES.map((d) => [d, [REGULAR_WINDOW]]), [specialDate, [specialWindow]]]) };
      }
    }

    const service = new NiftyUnderlyingCanonicalStorageMaterializerService({
      calendarSessionsResolver: new SpecialCalendarResolver(),
      manifestService: new FakeManifestGenerator(manifest),
      parquetExportService: new FakeParquetExporter(() => exportResultFor(manifest, [...TIER1_DATES, specialDate], [])),
      parquetVerifyService: new FakeParquetVerifier(verifiedResultFor(manifest, [...TIER1_DATES, specialDate])),
      sourceAssemblyRoot: assemblyRoot,
      manifestArtifactRoot: manifestRoot,
    });

    const result = await service.materialize({ year: YEAR, expectedCanonicalDatasetChecksum: manifest.datasetChecksum, sourceAssemblyChecksum: assembly.assemblyContentChecksum });
    assert.equal(result.canonicalManifest.sessions.find((s) => s.identity.tradingDate === specialDate)?.calendarSessionWindows[0].closeMinuteIst, 615);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});
