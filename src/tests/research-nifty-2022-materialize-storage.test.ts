import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  DatasetManifest,
  HEALTH_SEMANTICS_VERSION,
  MANIFEST_SCHEMA_VERSION,
  ManifestDatasetKind,
  UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  UnderlyingSessionIdentity,
  computeDatasetChecksum,
  deriveDatasetId,
} from '../modules/research-lake/domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../modules/research-lake/domain/dataset-health.types';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { ParquetCompressionCodec, ParquetExportRunResult, ParquetSessionExportResult, ParquetSessionExportStatus, ParquetVerificationRunResult, ParquetWriterFormat, PARQUET_STORAGE_SCHEMA_VERSION } from '../modules/research-lake/domain/parquet-storage.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { MaterializeCanonicalStorage, RunMaterializeStorageOptions, runNifty2022MaterializeStorage } from './research-nifty-2022-materialize-storage';
import { MaterializeCanonicalStorageRequest, MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

const LOCKED_CANONICAL_DATASET_CHECKSUM = '1a7cf5e2f88a0f6bee8b687f92c80c291a8a7bcb15184b986639f431a76e5870';
const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const MARCH_7_DATE = '2022-03-07';

function captureOutput() {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { lines, errorLines, output: (line: string) => lines.push(line), errorOutput: (line: string) => errorLines.push(line) };
}

class FakeMaterializer implements MaterializeCanonicalStorage {
  public callCount = 0;
  constructor(private readonly resultOrError: MaterializeCanonicalStorageResult | Error) {}
  async materialize(_request: MaterializeCanonicalStorageRequest): Promise<MaterializeCanonicalStorageResult> {
    this.callCount += 1;
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return this.resultOrError;
  }
}

function fakeDatasetManifest(datasetChecksumOverride?: string): DatasetManifest {
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2022-01-03' };
  const datasetChecksum = datasetChecksumOverride ?? computeDatasetChecksum([{ identity, canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION, healthSemanticsVersion: HEALTH_SEMANTICS_VERSION, contentChecksum: 'c'.repeat(64) }]);
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    datasetChecksum,
    datasetId: deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, datasetChecksum),
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: 'NSE_INDEX|Nifty 50', requestedFromDate: '2022-01-01', requestedToDate: '2022-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
    generatedAt: '2026-01-01T00:00:00.000Z',
    sessions: [
      {
        identity,
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
        calendarSessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
      },
    ],
    sessionCounts: { requested: 1, included: 1, healthy: 1, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
  };
}

function fakeSourceAssembly(checksumOverride?: string): ResearchUnderlyingDatasetAssemblyV1 {
  return {
    schemaVersion: 1,
    assemblySemanticsVersion: 1,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', year: 2022 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'x', datasetChecksum: LOCKED_CANONICAL_DATASET_CHECKSUM, manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions: [],
    sessionCounts: { expectedSessions: 248, researchReadySessions: 248, realCanonicalSessions: 247, compositeRepairedSessions: 0, authorizedDerivedSessions: 1, unavailableSessions: 0 },
    assemblyContentChecksum: checksumOverride ?? LOCKED_SOURCE_ASSEMBLY_CHECKSUM,
  };
}

function realCanonicalExportSessions(count: number, includeMarch7Status: ParquetSessionExportStatus | null): ParquetSessionExportResult[] {
  const sessions: ParquetSessionExportResult[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = `2022-01-${String(3 + i).padStart(2, '0')}`;
    sessions.push({ tradingDate: date, status: ParquetSessionExportStatus.WRITTEN, rowCount: 375, logicalContentChecksum: 'c'.repeat(64), physicalFileChecksum: 'p'.repeat(64), fileSizeBytes: 1000, relativePath: `sessions/${date}.parquet`, detail: null });
  }
  if (includeMarch7Status) {
    sessions.push({
      tradingDate: MARCH_7_DATE,
      status: includeMarch7Status,
      rowCount: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? 375 : null,
      logicalContentChecksum: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? 'c'.repeat(64) : null,
      physicalFileChecksum: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? 'p'.repeat(64) : null,
      fileSizeBytes: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? 1000 : null,
      relativePath: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? `sessions/${MARCH_7_DATE}.parquet` : null,
      detail: includeMarch7Status === ParquetSessionExportStatus.WRITTEN ? null : 'excluded',
    });
  }
  return sessions;
}

function fullyValidResult(overrides: Partial<MaterializeCanonicalStorageResult> = {}): MaterializeCanonicalStorageResult {
  const manifest = fakeDatasetManifest(LOCKED_CANONICAL_DATASET_CHECKSUM);
  const exportResult: ParquetExportRunResult = {
    datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum,
    datasetKind: manifest.datasetKind,
    storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    sessionsRequested: 248,
    sessionsWritten: 247,
    sessionsSkippedVerified: 0,
    sessionsFailed: 1,
    sessions: realCanonicalExportSessions(247, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY),
    descriptor: {
      storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
      datasetId: manifest.datasetId,
      datasetChecksum: manifest.datasetChecksum,
      datasetKind: manifest.datasetKind,
      writerFormat: ParquetWriterFormat.PARQUET,
      writerLibrary: 'hyparquet-writer',
      writerLibraryVersion: '0.16.6',
      compressionCodec: ParquetCompressionCodec.SNAPPY,
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
    },
    descriptorPath: 'artifacts/research-lake/parquet/UNDERLYING_1M/x/storage-manifest.json',
  };
  const verifyResult: ParquetVerificationRunResult = {
    verified: true,
    datasetId: manifest.datasetId,
    datasetKind: manifest.datasetKind,
    datasetLinkageMatches: true,
    sessionResults: Array.from({ length: 247 }, (_, i) => ({
      tradingDate: `2022-01-${String(3 + i).padStart(2, '0')}`,
      verified: true,
      physicalFileExists: true,
      physicalChecksumMatches: true,
      parquetParsed: true,
      rowCountMatches: true,
      logicalContentChecksumMatches: true,
      detail: null,
    })),
    mismatchedTradingDates: [],
  };
  return {
    canonicalManifest: manifest,
    manifestArtifact: { relativePath: `UNDERLYING_1M/${manifest.datasetId}.json`, absolutePath: `/tmp/UNDERLYING_1M/${manifest.datasetId}.json`, wasNewlyWritten: true },
    exportResult,
    verifyResult,
    sourceAssembly: fakeSourceAssembly(),
    ...overrides,
  };
}

async function run(materializer: MaterializeCanonicalStorage): Promise<{ success: boolean; lines: string[]; errorLines: string[] }> {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2022MaterializeStorage({ buildService: () => materializer, output, errorOutput } as RunMaterializeStorageOptions);
  return { success, lines, errorLines };
}

// ---- happy path ----

test('A. fully valid result -> SUCCESS', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  const { success, lines, errorLines } = await run(materializer);
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(materializer.callCount, 1);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('realCanonicalSessionsExported=247'));
  assert.ok(summary.includes('march7Excluded=true'));
});

// ---- checksum mismatches ----

test('B. wrong canonical datasetChecksum -> FAILED', async () => {
  const materializer = new FakeMaterializer(fullyValidResult({ canonicalManifest: fakeDatasetManifest('0'.repeat(64)) }));
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_CANONICAL_CHECKSUM'));
});

test('C. wrong B-M7.2 source assembly checksum -> FAILED', async () => {
  const materializer = new FakeMaterializer(fullyValidResult({ sourceAssembly: fakeSourceAssembly('9'.repeat(64)) }));
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- shape/count violations ----

test('D. wrong real-canonical session count -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: realCanonicalExportSessions(246, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_REAL_CANONICAL_COUNT'));
});

test('E. March-7 present in the exported WRITTEN set -> FAILED', async () => {
  const base = fullyValidResult();
  // 246 ordinary + March-7 WRITTEN = 247 total WRITTEN entries, so the count check passes and this isolates the March-7-specific check.
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: realCanonicalExportSessions(246, ParquetSessionExportStatus.WRITTEN) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_IN_EXPORT'));
});

test('F. March-7 export status is not REJECTED_HEALTH_POLICY -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: realCanonicalExportSessions(247, ParquetSessionExportStatus.FAILED_WRITE_ERROR) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_NOT_EXCLUDED'));
});

test('G. verify.verified=false -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, verified: false, mismatchedTradingDates: ['2022-01-03'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=VERIFY_NOT_VERIFIED'));
});

test('H. mismatchedTradingDates non-empty -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, mismatchedTradingDates: ['2022-01-03'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MISMATCHED_DATES'));
});

test('I. March-7 present in the verified storage descriptor -> FAILED', async () => {
  const base = fullyValidResult();
  // Drop one ordinary date and add March-7 instead, so the total stays at 247 and this isolates the March-7-specific check.
  const materializer = new FakeMaterializer({
    ...base,
    verifyResult: {
      ...base.verifyResult,
      sessionResults: [...base.verifyResult.sessionResults.slice(0, 246), { tradingDate: MARCH_7_DATE, verified: true, physicalFileExists: true, physicalChecksumMatches: true, parquetParsed: true, rowCountMatches: true, logicalContentChecksumMatches: true, detail: null }],
    },
  });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_IN_VERIFY'));
});

// ---- exceptions ----

test('J. materialize() throws -> FAILED, non-zero, no SUCCESS output', async () => {
  const materializer = new FakeMaterializer(new Error('canonical checksum mismatch'));
  const { success, lines, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.ok(errorLines.join('\n').includes('code=MATERIALIZE_FAILED'));
  assert.ok(errorLines.join('\n').includes('canonical checksum mismatch'));
});

// ---- structural ----

test('structural: this CLI never reads process.env and never imports a provider client', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-materialize-storage.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: this CLI never imports ResearchYearRunnerService', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-materialize-storage.ts'), 'utf8');
  assert.equal(/ResearchYearRunnerService/.test(source), false);
});

test('the service is called exactly once per run', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  await run(materializer);
  assert.equal(materializer.callCount, 1);
});
