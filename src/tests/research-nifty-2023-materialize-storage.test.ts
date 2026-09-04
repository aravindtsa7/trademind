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
import { MaterializeCanonicalStorage, RunNifty2023MaterializeStorageOptions, runNifty2023MaterializeStorage } from './research-nifty-2023-materialize-storage';
import { MaterializeCanonicalStorageRequest, MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

const VALID_CANONICAL_CHECKSUM = 'a'.repeat(64);
const VALID_SOURCE_ASSEMBLY_CHECKSUM = 'b'.repeat(64);
const MUHURAT_DATE = '2023-11-12';

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
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2023-01-02' };
  const datasetChecksum = datasetChecksumOverride ?? computeDatasetChecksum([{ identity, canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION, healthSemanticsVersion: HEALTH_SEMANTICS_VERSION, contentChecksum: 'c'.repeat(64) }]);
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    datasetChecksum,
    datasetId: deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, datasetChecksum),
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: 'NSE_INDEX|Nifty 50', requestedFromDate: '2023-01-01', requestedToDate: '2023-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
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
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', year: 2023 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'x', datasetChecksum: VALID_CANONICAL_CHECKSUM, manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions: [],
    sessionCounts: { expectedSessions: 246, researchReadySessions: 246, realCanonicalSessions: 246, compositeRepairedSessions: 0, authorizedDerivedSessions: 0, unavailableSessions: 0 },
    assemblyContentChecksum: checksumOverride ?? VALID_SOURCE_ASSEMBLY_CHECKSUM,
  };
}

function exportSessionsFor(count: number, includeMuhurat: boolean, muhuratStatus: ParquetSessionExportStatus = ParquetSessionExportStatus.WRITTEN): ParquetSessionExportResult[] {
  const sessions: ParquetSessionExportResult[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = `2023-01-${String(2 + i).padStart(2, '0')}`;
    sessions.push({ tradingDate: date, status: ParquetSessionExportStatus.WRITTEN, rowCount: 375, logicalContentChecksum: 'c'.repeat(64), physicalFileChecksum: 'p'.repeat(64), fileSizeBytes: 1000, relativePath: `sessions/${date}.parquet`, detail: null });
  }
  if (includeMuhurat) {
    const written = muhuratStatus === ParquetSessionExportStatus.WRITTEN;
    sessions.push({
      tradingDate: MUHURAT_DATE,
      status: muhuratStatus,
      rowCount: written ? 60 : null,
      logicalContentChecksum: written ? 'c'.repeat(64) : null,
      physicalFileChecksum: written ? 'p'.repeat(64) : null,
      fileSizeBytes: written ? 500 : null,
      relativePath: written ? `sessions/${MUHURAT_DATE}.parquet` : null,
      detail: written ? null : 'excluded',
    });
  }
  return sessions;
}

function verifySessionsFor(count: number, includeMuhurat: boolean): ParquetVerificationRunResult['sessionResults'] {
  const results = Array.from({ length: count }, (_, i) => ({
    tradingDate: `2023-01-${String(2 + i).padStart(2, '0')}`,
    verified: true,
    physicalFileExists: true,
    physicalChecksumMatches: true,
    parquetParsed: true,
    rowCountMatches: true,
    logicalContentChecksumMatches: true,
    detail: null,
  }));
  if (includeMuhurat) {
    results.push({ tradingDate: MUHURAT_DATE, verified: true, physicalFileExists: true, physicalChecksumMatches: true, parquetParsed: true, rowCountMatches: true, logicalContentChecksumMatches: true, detail: null });
  }
  return results;
}

function fullyValidResult(overrides: Partial<MaterializeCanonicalStorageResult> = {}): MaterializeCanonicalStorageResult {
  const manifest = fakeDatasetManifest(VALID_CANONICAL_CHECKSUM);
  const exportResult: ParquetExportRunResult = {
    datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum,
    datasetKind: manifest.datasetKind,
    storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    sessionsRequested: 246,
    sessionsWritten: 246,
    sessionsSkippedVerified: 0,
    sessionsFailed: 0,
    sessions: exportSessionsFor(245, true),
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
    sessionResults: verifySessionsFor(245, true),
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

async function run(materializer: MaterializeCanonicalStorage, checksums: { canonical?: string | undefined; assembly?: string | undefined } = {}): Promise<{ success: boolean; lines: string[]; errorLines: string[] }> {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2023MaterializeStorage({
    canonicalManifestChecksum: 'canonical' in checksums ? checksums.canonical : VALID_CANONICAL_CHECKSUM,
    sourceAssemblyChecksum: 'assembly' in checksums ? checksums.assembly : VALID_SOURCE_ASSEMBLY_CHECKSUM,
    buildService: () => materializer,
    output,
    errorOutput,
  } as RunNifty2023MaterializeStorageOptions);
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
  assert.ok(summary.includes('realCanonicalSessionsExported=246'));
  assert.ok(summary.includes('parquetVerified=true'));
  assert.ok(summary.includes('parquetVerifiedSessionCount=246'));
});

// ---- checksum handoff ----

test('B. missing canonicalManifestChecksum input -> FAILED, materializer never called', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  const { success, errorLines } = await run(materializer, { canonical: undefined });
  assert.equal(success, false);
  assert.equal(materializer.callCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CANONICAL_MANIFEST_CHECKSUM'));
});

test('C. malformed canonicalManifestChecksum input -> FAILED, materializer never called', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  const { success, errorLines } = await run(materializer, { canonical: 'not-hex' });
  assert.equal(success, false);
  assert.equal(materializer.callCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MALFORMED_CANONICAL_MANIFEST_CHECKSUM'));
});

test('D. missing sourceAssemblyChecksum input -> FAILED, materializer never called', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  const { success, errorLines } = await run(materializer, { assembly: undefined });
  assert.equal(success, false);
  assert.equal(materializer.callCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MISSING_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('E. malformed sourceAssemblyChecksum input -> FAILED, materializer never called', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  const { success, errorLines } = await run(materializer, { assembly: 'zzz' });
  assert.equal(success, false);
  assert.equal(materializer.callCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MALFORMED_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- checksum mismatches (well-formed input, materializer's own result diverges) ----

test('F. wrong canonical datasetChecksum in the result -> FAILED before write is trusted', async () => {
  const materializer = new FakeMaterializer(fullyValidResult({ canonicalManifest: fakeDatasetManifest('0'.repeat(64)) }));
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_CANONICAL_CHECKSUM'));
});

test('G. wrong B-M7.2 source assembly checksum in the result -> FAILED', async () => {
  const materializer = new FakeMaterializer(fullyValidResult({ sourceAssembly: fakeSourceAssembly('9'.repeat(64)) }));
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- shape/count violations ----

test('H. any REJECTED_HEALTH_POLICY session present -> FAILED (2023 has no exclusion; unlike 2022, zero rejections are expected)', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsFor(245, true, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_REJECTED_HEALTH_POLICY_SESSION'));
});

test('I. wrong exported session count (245 instead of 246) -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsFor(245, false) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPORTED_SESSION_COUNT'));
});

test('J. Muhurat exported rowCount is not 60 -> FAILED', async () => {
  const base = fullyValidResult();
  const sessions = base.exportResult.sessions.map((s) => (s.tradingDate === MUHURAT_DATE ? { ...s, rowCount: 61 } : s));
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_WRONG_ROW_COUNT'));
});

test('K. a regular session exported rowCount is not 375 -> FAILED', async () => {
  const base = fullyValidResult();
  const sessions = base.exportResult.sessions.map((s, i) => (i === 0 ? { ...s, rowCount: 200 } : s));
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=REGULAR_SESSION_WRONG_ROW_COUNT'));
});

test('L. verify.verified=false -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, verified: false, mismatchedTradingDates: ['2023-01-02'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=VERIFY_NOT_VERIFIED'));
});

test('M. mismatchedTradingDates non-empty -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, mismatchedTradingDates: ['2023-01-02'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MISMATCHED_DATES'));
});

test('N. wrong verified session count -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, sessionResults: verifySessionsFor(245, false) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_VERIFY_COUNT'));
});

test('O. dataset linkage mismatch -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, datasetLinkageMatches: false } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=DATASET_LINKAGE_MISMATCH'));
});

// ---- exceptions ----

test('P. materialize() throws -> FAILED, non-zero, no SUCCESS output', async () => {
  const materializer = new FakeMaterializer(new Error('canonical checksum mismatch'));
  const { success, lines, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.ok(errorLines.join('\n').includes('code=MATERIALIZE_FAILED'));
  assert.ok(errorLines.join('\n').includes('canonical checksum mismatch'));
});

// ---- structural ----

test('structural: this CLI reads exactly two environment variables (the year-specific checksum handoff) and never invents a placeholder checksum constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-materialize-storage.ts'), 'utf8');
  const envMatches = source.match(/process\.env\[/g) ?? [];
  assert.equal(envMatches.length, 2);
  assert.ok(source.includes('RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM'));
  assert.ok(source.includes('RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM'));
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: this CLI never imports ResearchYearRunnerService, never introduces a new Parquet exporter/verifier class', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-materialize-storage.ts'), 'utf8');
  assert.equal(/ResearchYearRunnerService/.test(source), false);
  assert.equal(/class\s+\w*Parquet(Export|Verif)/.test(source), false);
});

test('structural: the CLI validates checksum inputs BEFORE calling the materializer -- in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-materialize-storage.ts'), 'utf8');
  const validateIndex = source.indexOf('validateChecksumInputs(rawCanonicalChecksum, rawAssemblyChecksum)');
  const materializeIndex = source.indexOf('service.materialize({');
  assert.ok(validateIndex > 0 && materializeIndex > 0);
  assert.ok(validateIndex < materializeIndex);
});

test('the service is called exactly once per run', async () => {
  const materializer = new FakeMaterializer(fullyValidResult());
  await run(materializer);
  assert.equal(materializer.callCount, 1);
});
