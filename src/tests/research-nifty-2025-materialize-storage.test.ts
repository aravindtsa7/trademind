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
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResearchSessionCompositeRepairProvenanceKind, ResearchSessionSourceSelection } from '../modules/research-lake/domain/research-session-source-selection';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { ParquetCompressionCodec, ParquetExportRunResult, ParquetSessionExportResult, ParquetSessionExportStatus, ParquetVerificationRunResult, ParquetWriterFormat, PARQUET_STORAGE_SCHEMA_VERSION } from '../modules/research-lake/domain/parquet-storage.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { MaterializeCanonicalStorage, RunNifty2025MaterializeStorageOptions, runNifty2025MaterializeStorage } from './research-nifty-2025-materialize-storage';
import { MaterializeCanonicalStorageRequest, MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

const VALID_CANONICAL_CHECKSUM = 'a'.repeat(64);
const VALID_SOURCE_ASSEMBLY_CHECKSUM = 'b'.repeat(64);
const FEB1_DATE = '2025-02-01';
const OCT21_DATE = '2025-10-21';
const COMPOSITE_REPAIRED_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];
const SPECIAL_ROW_COUNTS: Readonly<Record<string, number>> = { [OCT21_DATE]: 60 };

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

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

/** 244 ordinary regular dates + Feb-1 + Oct-21 + the three composite-repaired dates = 249. */
function allDates(): string[] {
  return [...sequentialDates(244, '2020-01-01'), FEB1_DATE, OCT21_DATE, ...COMPOSITE_REPAIRED_DATES];
}

function fakeDatasetManifest(datasetChecksumOverride?: string): DatasetManifest {
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2025-01-02' };
  const datasetChecksum = datasetChecksumOverride ?? computeDatasetChecksum([{ identity, canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION, healthSemanticsVersion: HEALTH_SEMANTICS_VERSION, contentChecksum: 'c'.repeat(64) }]);
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    datasetChecksum,
    datasetId: deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, datasetChecksum),
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: 'NSE_INDEX|Nifty 50', requestedFromDate: '2025-01-01', requestedToDate: '2025-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
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

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate };
}

function realSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: SPECIAL_ROW_COUNTS[tradingDate] ?? 375,
  };
}

function compositeRepairedSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
    repairProvenance: { kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED, primaryProvider: HistoricalProviderId.UPSTOX, repairProvider: 'GROWW' as HistoricalProviderId, repairedMinuteCount: 1, repairPolicyVersion: 1 },
  };
}

function fakeSourceAssembly(overrides: { checksum?: string; sessions?: ResearchSessionSourceSelection[] } = {}): ResearchUnderlyingDatasetAssemblyV1 {
  const sessions = overrides.sessions ?? allDates().map((d) => (COMPOSITE_REPAIRED_DATES.includes(d) ? compositeRepairedSelection(d) : realSelection(d)));
  return {
    schemaVersion: 1,
    assemblySemanticsVersion: 1,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', year: 2025 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'x', datasetChecksum: VALID_CANONICAL_CHECKSUM, manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions,
    sessionCounts: { expectedSessions: 249, researchReadySessions: 249, realCanonicalSessions: 246, compositeRepairedSessions: 3, authorizedDerivedSessions: 0, unavailableSessions: 0 },
    assemblyContentChecksum: overrides.checksum ?? VALID_SOURCE_ASSEMBLY_CHECKSUM,
  };
}

function exportSessionsForAll(rowCountOverrides: Readonly<Record<string, number>> = {}, statusOverrides: Readonly<Record<string, ParquetSessionExportStatus>> = {}, datesOverride?: readonly string[]): ParquetSessionExportResult[] {
  const dates = datesOverride ?? allDates();
  return dates.map((date) => {
    const status = statusOverrides[date] ?? ParquetSessionExportStatus.WRITTEN;
    const written = status === ParquetSessionExportStatus.WRITTEN;
    const rowCount = rowCountOverrides[date] ?? SPECIAL_ROW_COUNTS[date] ?? 375;
    return {
      tradingDate: date,
      status,
      rowCount: written ? rowCount : null,
      logicalContentChecksum: written ? 'c'.repeat(64) : null,
      physicalFileChecksum: written ? 'p'.repeat(64) : null,
      fileSizeBytes: written ? 1000 : null,
      relativePath: written ? `sessions/${date}.parquet` : null,
      detail: written ? null : 'excluded',
    };
  });
}

function verifySessionsForAll(datesOverride?: readonly string[]): ParquetVerificationRunResult['sessionResults'] {
  const dates = datesOverride ?? allDates();
  return dates.map((date) => ({ tradingDate: date, verified: true, physicalFileExists: true, physicalChecksumMatches: true, parquetParsed: true, rowCountMatches: true, logicalContentChecksumMatches: true, detail: null }));
}

function fullyValidResult(overrides: Partial<MaterializeCanonicalStorageResult> = {}): MaterializeCanonicalStorageResult {
  const manifest = fakeDatasetManifest(VALID_CANONICAL_CHECKSUM);
  const exportResult: ParquetExportRunResult = {
    datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum,
    datasetKind: manifest.datasetKind,
    storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    sessionsRequested: 249,
    sessionsWritten: 249,
    sessionsSkippedVerified: 0,
    sessionsFailed: 0,
    sessions: exportSessionsForAll(),
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
    sessionResults: verifySessionsForAll(),
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
  const success = await runNifty2025MaterializeStorage({
    canonicalManifestChecksum: 'canonical' in checksums ? checksums.canonical : VALID_CANONICAL_CHECKSUM,
    sourceAssemblyChecksum: 'assembly' in checksums ? checksums.assembly : VALID_SOURCE_ASSEMBLY_CHECKSUM,
    buildService: () => materializer,
    output,
    errorOutput,
  } as RunNifty2025MaterializeStorageOptions);
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
  assert.ok(summary.includes('realCanonicalOrCompositeRepairedSessionsExported=249'));
  assert.ok(summary.includes(`compositeRepairedTradingDates=${[...COMPOSITE_REPAIRED_DATES].sort().join(',')}`));
  assert.ok(summary.includes('parquetVerified=true'));
  assert.ok(summary.includes('parquetVerifiedSessionCount=249'));
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
  const materializer = new FakeMaterializer(fullyValidResult({ sourceAssembly: fakeSourceAssembly({ checksum: '9'.repeat(64) }) }));
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- shape/count violations ----

test('H. any REJECTED_HEALTH_POLICY session present -> FAILED (2025 has no exclusion; zero rejections are expected)', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsForAll({}, { [OCT21_DATE]: ParquetSessionExportStatus.REJECTED_HEALTH_POLICY }) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_REJECTED_HEALTH_POLICY_SESSION'));
});

test('I. wrong exported session count (248 instead of 249) -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsForAll({}, {}, allDates().slice(0, 248)) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPORTED_SESSION_COUNT'));
});

test('J. Oct-21 exported rowCount is not 60 -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsForAll({ [OCT21_DATE]: 61 }) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=SESSION_WRONG_ROW_COUNT'));
});

test('K. a regular session exported rowCount is not 375 -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsForAll({ '2020-01-01': 200 }) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=SESSION_WRONG_ROW_COUNT'));
});

test('L. a composite-repaired session exported rowCount is not 375 -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, exportResult: { ...base.exportResult, sessions: exportSessionsForAll({ [COMPOSITE_REPAIRED_DATES[0]]: 374 }) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=SESSION_WRONG_ROW_COUNT'));
});

// ---- composite-repair provenance cross-check ----

test('M1. composite-repaired count is 2 in the trusted B-M7.2 selections (one repair downgraded to real-canonical) -> FAILED', async () => {
  const base = fullyValidResult();
  const sessions = allDates().map((d) => (d === COMPOSITE_REPAIRED_DATES[0] ? realSelection(d) : COMPOSITE_REPAIRED_DATES.includes(d) ? compositeRepairedSelection(d) : realSelection(d)));
  const materializer = new FakeMaterializer({ ...base, sourceAssembly: fakeSourceAssembly({ sessions }) });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
});

test('M2. a composite-repaired tier is present but at the wrong date (count still exactly 3) -> FAILED', async () => {
  const base = fullyValidResult();
  const sessions = allDates().map((d) => {
    if (d === COMPOSITE_REPAIRED_DATES[0]) return realSelection(d);
    if (d === '2020-01-02') return compositeRepairedSelection(d);
    if (COMPOSITE_REPAIRED_DATES.includes(d)) return compositeRepairedSelection(d);
    return realSelection(d);
  });
  const materializer = new FakeMaterializer({ ...base, sourceAssembly: fakeSourceAssembly({ sessions }) });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
});

test('O. verify.verified=false -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, verified: false, mismatchedTradingDates: ['2020-01-01'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=VERIFY_NOT_VERIFIED'));
});

test('P. mismatchedTradingDates non-empty -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, mismatchedTradingDates: ['2020-01-01'] } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MISMATCHED_DATES'));
});

test('Q. wrong verified session count -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, sessionResults: verifySessionsForAll(allDates().slice(0, 248)) } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_VERIFY_COUNT'));
});

test('R. dataset linkage mismatch -> FAILED', async () => {
  const base = fullyValidResult();
  const materializer = new FakeMaterializer({ ...base, verifyResult: { ...base.verifyResult, datasetLinkageMatches: false } });
  const { success, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=DATASET_LINKAGE_MISMATCH'));
});

// ---- exceptions ----

test('S. materialize() throws -> FAILED, non-zero, no SUCCESS output', async () => {
  const materializer = new FakeMaterializer(new Error('canonical checksum mismatch'));
  const { success, lines, errorLines } = await run(materializer);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.ok(errorLines.join('\n').includes('code=MATERIALIZE_FAILED'));
  assert.ok(errorLines.join('\n').includes('canonical checksum mismatch'));
});

// ---- structural ----

test('structural: this CLI reads exactly two environment variables (the year-specific checksum handoff) and never invents a placeholder checksum constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-materialize-storage.ts'), 'utf8');
  const envMatches = source.match(/process\.env\[/g) ?? [];
  assert.equal(envMatches.length, 2);
  assert.ok(source.includes('RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM'));
  assert.ok(source.includes('RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM'));
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: this CLI never imports ResearchYearRunnerService, never introduces a new Parquet exporter/verifier class', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-materialize-storage.ts'), 'utf8');
  assert.equal(/ResearchYearRunnerService/.test(source), false);
  assert.equal(/class\s+\w*Parquet(Export|Verif)/.test(source), false);
});

test('structural: the CLI validates checksum inputs BEFORE calling the materializer -- in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-materialize-storage.ts'), 'utf8');
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
