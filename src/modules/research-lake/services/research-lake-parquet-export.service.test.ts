import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Prisma } from '@prisma/client';
import DatasetManifestService from './dataset-manifest.service';
import DatasetSessionManifestBuilderService, { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import ResearchLakeParquetExportService from './research-lake-parquet-export.service';
import ResearchLakeParquetReaderService, { VerifySessionAgainstLogicalIdentityRequest, VerifySessionAgainstLogicalIdentityResult } from './research-lake-parquet-reader.service';
import { DatasetManifest, ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { ParquetSessionExportStatus, parquetSessionRelativePath } from '../domain/parquet-storage.types';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';

/**
 * B-F2C: `DatasetManifestService` now looks up durable retrieval evidence
 * via `HistoricalDataRetrievalEvidenceService`, which defaults to a real,
 * Prisma-backed instance. Every `DatasetManifestService` constructed in
 * this file is a manifest-generation detail unrelated to what this suite
 * actually tests (Parquet export/publish-order/checksum behavior) -- none
 * of it has genuine B-F2C evidence, so this fake truthfully reports `null`
 * for every lookup without ever touching a database.
 */
const NO_RETRIEVAL_EVIDENCE = { findLatestAvailableSessionEvidence: async () => null } as unknown as HistoricalDataRetrievalEvidenceService;

/** No stray `.tmp` file (from `writeBufferToTempFile`) survives in `directory`, whether or not it exists at all. */
function assertNoStaleTempFiles(directory: string): void {
  if (!existsSync(directory)) return;
  const leftover = readdirSync(directory).filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(leftover, [], `stale temp file(s) left behind in ${directory}: ${leftover.join(', ')}`);
}

/**
 * Wraps a REAL `ResearchLakeParquetReaderService` but records, for every
 * `readAndVerifySession` call, whether `finalPathToWatch` already existed at
 * that moment, and which path was actually read. Used to prove the B-F6
 * correction: verification must happen against a TEMP path, with
 * `finalPath` not yet existing (task: "temp verify before final publish").
 */
class PublishOrderProvingReaderSpy {
  finalPathExistedAtVerifyTime: boolean | null = null;
  observedVerifiedPath: string | null = null;
  private readonly real = new ResearchLakeParquetReaderService();

  constructor(private readonly finalPathToWatch: string) {}

  async readSession(path: string): ReturnType<ResearchLakeParquetReaderService['readSession']> {
    return this.real.readSession(path);
  }

  async readAndVerifySession(request: VerifySessionAgainstLogicalIdentityRequest): Promise<VerifySessionAgainstLogicalIdentityResult> {
    this.observedVerifiedPath = request.parquetFilePath;
    this.finalPathExistedAtVerifyTime = existsSync(this.finalPathToWatch);
    return this.real.readAndVerifySession(request);
  }
}

/** Delegates to a real reader but forces the LOGICAL checksum comparison to fail, simulating a temp file that parses fine but whose content verification legitimately fails for reasons other than the pre-encode drift check (e.g. a hypothetical encoder defect). */
class ForcedLogicalMismatchReaderSpy {
  private readonly real = new ResearchLakeParquetReaderService();
  async readSession(path: string): ReturnType<ResearchLakeParquetReaderService['readSession']> {
    return this.real.readSession(path);
  }
  async readAndVerifySession(request: VerifySessionAgainstLogicalIdentityRequest): Promise<VerifySessionAgainstLogicalIdentityResult> {
    const real = await this.real.readAndVerifySession(request);
    return { ...real, contentChecksumMatches: false };
  }
}

/** Simulates a reader that cannot even parse/verify the temp file at all (e.g. Parquet schema/parse failure, or an unrelated I/O error) -- `readAndVerifySession` throws instead of returning a result. */
class ThrowingVerificationReaderSpy {
  constructor(private readonly message: string) {}
  async readSession(): Promise<never> {
    throw new Error(this.message);
  }
  async readAndVerifySession(): Promise<never> {
    throw new Error(this.message);
  }
}

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const OPTION_CONTRACT_ID = 'NSE-NIFTY-06Jan22-17200-PE';

function makeRow(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(tradingDate: string, count = 375): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: count }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

/** Only implements `findRange` -- matches the B-F5 fake convention in `dataset-manifest.service.test.ts` (task section 22.AG: "no provider API used by export/verify"). */
class FakeHistoricalCandleRepository {
  rows: PersistedManifestCandleRow[] = [];
  findRangeCallCount = 0;
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

class FakeHistoricalOptionCandleLakeRepository {
  rows: PersistedManifestCandleRow[] = [];
  findRangeCallCount = 0;
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf6-parquet-export-'));
}

function newHarness(): {
  manifestService: DatasetManifestService;
  exportService: ResearchLakeParquetExportService;
  candleRepo: FakeHistoricalCandleRepository;
  optionRepo: FakeHistoricalOptionCandleLakeRepository;
} {
  const candleRepo = new FakeHistoricalCandleRepository();
  const optionRepo = new FakeHistoricalOptionCandleLakeRepository();
  const sessionBuilder = new DatasetSessionManifestBuilderService();
  const manifestService = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    sessionBuilder,
    retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE,
  });
  const exportService = new ResearchLakeParquetExportService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
  });
  return { manifestService, exportService, candleRepo, optionRepo };
}

test('(export) writes one Parquet file per healthy session and a storage descriptor with full physical + logical checksums (AA/AB)', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessionsRequested, 1);
    assert.equal(result.sessionsWritten, 1);
    assert.equal(result.sessionsFailed, 0);
    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.WRITTEN);
    assert.ok(result.descriptor);
    assert.equal(result.descriptor?.sessions.length, 1);

    const entry = result.descriptor!.sessions[0];
    assert.equal(entry.sessionContentChecksum, manifest.sessions[0].contentChecksum); // (AB) logical checksum recorded separately
    assert.match(entry.physicalFileChecksum, /^[0-9a-f]{64}$/); // (AA) full SHA-256
    assert.notEqual(entry.physicalFileChecksum, entry.sessionContentChecksum); // physical vs logical stay distinct

    const filePath = join(outputRoot, entry.relativePath);
    assert.ok(existsSync(filePath));

    // (AF) storage success never fabricates/echoes health/provenance material into the descriptor
    const descriptorJson = readFileSync(result.descriptorPath!, 'utf8');
    assert.ok(!descriptorJson.includes('persistedCanonicalHealthStatus'));
    assert.ok(!descriptorJson.includes('sourceAcquisitionEvidence'));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export) option dataset export preserves OI through the storage descriptor linkage', async () => {
  const { manifestService, exportService, optionRepo } = newHarness();
  optionRepo.rows = normalSessionRows('2022-01-03').map((row, index) => ({ ...row, openInterest: BigInt(index) }));
  const manifest = await manifestService.generateOptionManifest({
    provider: HistoricalProviderId.GROWW,
    providerContractId: OPTION_CONTRACT_ID,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-01-06T00:00:00+05:30'),
    timeframe: '1minute',
    tradingDates: ['2022-01-03'],
  });

  const outputRoot = tempDir();
  try {
    const result = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(result.sessionsWritten, 1);
    assert.equal(result.datasetKind, ManifestDatasetKind.EXPIRED_OPTION_1M);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/X) a rerun with an unchanged persisted session skips rewriting the verified file', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const first = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(first.sessions[0].status, ParquetSessionExportStatus.WRITTEN);
    const filePath = join(outputRoot, first.descriptor!.sessions[0].relativePath);
    const firstBytes = readFileSync(filePath);

    const second = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(second.sessions[0].status, ParquetSessionExportStatus.SKIPPED_VERIFIED);
    assert.equal(second.sessionsWritten, 0);
    assert.equal(second.sessionsSkippedVerified, 1);
    const secondBytes = readFileSync(filePath);
    assert.deepEqual(firstBytes, secondBytes); // never rewritten

    // (AC) generatedAt differs between runs, but every session-identity-bearing field is unchanged
    assert.notEqual(first.descriptor!.generatedAt, second.descriptor!.generatedAt);
    assert.equal(first.descriptor!.datasetChecksum, second.descriptor!.datasetChecksum);
    assert.equal(first.descriptor!.sessions[0].sessionContentChecksum, second.descriptor!.sessions[0].sessionContentChecksum);
    assert.equal(first.descriptor!.sessions[0].physicalFileChecksum, second.descriptor!.sessions[0].physicalFileChecksum);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/AD) a session with INVALID persisted-canonical health is rejected under the default fail-closed policy -- no file is written', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03').map((row, index) => (index === 5 ? { ...row, volume: -1n } : row)); // negative volume -> blocking issue -> INVALID
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, 'INVALID');

  const outputRoot = tempDir();
  try {
    const result = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY);
    assert.equal(result.sessionsWritten, 0);
    assert.equal(result.descriptor, null); // storage success is never asserted for a run that produced nothing trustworthy
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/AE) an INCOMPLETE session is rejected by default, but exportable when allowIncompleteSessions is explicitly set', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03', 300); // fewer than the full 375 expected minutes -> INCOMPLETE
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, 'INCOMPLETE');

  const outputRootA = tempDir();
  const outputRootB = tempDir();
  try {
    const rejected = await exportService.exportDataset({ manifest, outputRoot: outputRootA });
    assert.equal(rejected.sessions[0].status, ParquetSessionExportStatus.REJECTED_HEALTH_POLICY);

    const allowed = await exportService.exportDataset({ manifest, outputRoot: outputRootB, allowIncompleteSessions: true });
    assert.equal(allowed.sessions[0].status, ParquetSessionExportStatus.WRITTEN);
    assert.equal(allowed.sessions[0].rowCount, 300);
  } finally {
    rmSync(outputRootA, { recursive: true, force: true });
    rmSync(outputRootB, { recursive: true, force: true });
  }
});

test('(export) currently persisted rows drifting from the manifest\'s recorded contentChecksum are rejected, never silently re-certified', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows[10] = { ...candleRepo.rows[10], close: new Prisma.Decimal(9999) }; // DB drifted after the manifest was generated

  const outputRoot = tempDir();
  try {
    const result = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.REJECTED_CONTENT_CHECKSUM_DRIFT);
    assert.equal(result.descriptor, null);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/Y) a corrupted existing final file fails closed and is never silently overwritten', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const first = await exportService.exportDataset({ manifest, outputRoot });
    const filePath = join(outputRoot, first.descriptor!.sessions[0].relativePath);
    writeFileSync(filePath, Buffer.from('not a real parquet file'));

    const second = await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(second.sessions[0].status, ParquetSessionExportStatus.FAILED_EXISTING_FILE_UNTRUSTED);
    assert.equal(second.sessionsWritten, 0);
    assert.equal(second.sessionsSkippedVerified, 0);

    const bytesAfter = readFileSync(filePath, 'utf8');
    assert.equal(bytesAfter, 'not a real parquet file'); // left untouched, never silently overwritten
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/AG) export never calls the repositories beyond findRange (no provider API request)', async () => {
  const { manifestService, exportService, candleRepo } = newHarness();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  candleRepo.findRangeCallCount = 0;

  const outputRoot = tempDir();
  try {
    await exportService.exportDataset({ manifest, outputRoot });
    assert.equal(candleRepo.findRangeCallCount, 1);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(export/AH) a manifest with zero sessions produces zero requested/written and no descriptor', async () => {
  const { exportService } = newHarness();
  const emptyManifest: DatasetManifest = {
    manifestSchemaVersion: 1,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    datasetChecksum: 'a'.repeat(64),
    datasetId: 'UNDERLYING_1M_aaaaaaaaaaaaaaaa',
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2022-01-03', requestedToDate: '2022-01-03', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
    generatedAt: new Date().toISOString(),
    sessions: [],
    sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
  };

  const outputRoot = tempDir();
  try {
    const result = await exportService.exportDataset({ manifest: emptyManifest, outputRoot });
    assert.equal(result.sessionsRequested, 0);
    assert.equal(result.descriptor, null);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

// ---- B-F6 CORRECTION regression tests (independent review: "temp verify before final publish") ----

test('(publish-order/A,G) a new session is verified at a TEMP path while finalPath does not yet exist; finalPath appears only after verification succeeds, and its bytes/checksum are exactly the verified temp bytes', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const finalPath = join(outputRoot, parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03'));
    const spyReader = new PublishOrderProvingReaderSpy(finalPath);
    const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, reader: spyReader as unknown as ResearchLakeParquetReaderService });

    assert.equal(existsSync(finalPath), false);
    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.WRITTEN);
    // The core proof: finalPath did NOT exist at the moment verification ran.
    assert.equal(spyReader.finalPathExistedAtVerifyTime, false);
    // Verification read a DIFFERENT (temp) path, never finalPath itself.
    assert.notEqual(spyReader.observedVerifiedPath, finalPath);
    assert.match(spyReader.observedVerifiedPath ?? '', /\.tmp$/);
    // Only now does finalPath exist.
    assert.equal(existsSync(finalPath), true);

    // (G) physical checksum recorded matches the EXACT final bytes on disk.
    const finalBytes = readFileSync(finalPath);
    assert.equal(sha256HexOfBuffer(finalBytes), result.sessions[0].physicalFileChecksum);
    assert.equal(finalBytes.byteLength, result.sessions[0].fileSizeBytes);

    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/B) a forced logical-checksum verification failure on the temp file leaves finalPath absent and cleans up the temp file', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const finalPath = join(outputRoot, parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03'));
    const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, reader: new ForcedLogicalMismatchReaderSpy() as unknown as ResearchLakeParquetReaderService });

    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.FAILED_WRITE_ERROR);
    assert.equal(existsSync(finalPath), false);
    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/C) a Parquet parse/schema verification failure on the temp file leaves finalPath absent and cleans up the temp file', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const finalPath = join(outputRoot, parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03'));
    const exportService = new ResearchLakeParquetExportService({
      historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
      reader: new ThrowingVerificationReaderSpy('Unsupported Parquet schema: simulated parse failure for regression test C') as unknown as ResearchLakeParquetReaderService,
    });

    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.FAILED_WRITE_ERROR);
    assert.match(result.sessions[0].detail ?? '', /Unsupported Parquet schema/);
    assert.equal(existsSync(finalPath), false);
    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/D) an unexpected exception during verification (e.g. a simulated I/O error) leaves finalPath absent and cleans up the temp file', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const outputRoot = tempDir();
  try {
    const finalPath = join(outputRoot, parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03'));
    const exportService = new ResearchLakeParquetExportService({
      historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
      reader: new ThrowingVerificationReaderSpy('simulated I/O read failure while verifying temp file') as unknown as ResearchLakeParquetReaderService,
    });

    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.FAILED_WRITE_ERROR);
    assert.match(result.sessions[0].detail ?? '', /simulated I\/O read failure/);
    assert.equal(existsSync(finalPath), false);
    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/E) an existing corrupt final file remains byte-for-byte untouched (FAILED_EXISTING_FILE_UNTRUSTED), with no stray temp file left behind', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository });

  const outputRoot = tempDir();
  try {
    const finalPath = join(outputRoot, parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03'));
    mkdirSync(dirname(finalPath), { recursive: true });
    const corruptBytes = Buffer.from('this is not a valid parquet file');
    writeFileSync(finalPath, corruptBytes);

    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.FAILED_EXISTING_FILE_UNTRUSTED);
    assert.deepEqual(readFileSync(finalPath), corruptBytes); // byte-for-byte untouched
    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/F) an existing, valid, verified final file is skipped (SKIPPED_VERIFIED) and never rewritten, with no stray temp file left behind', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository });

  const outputRoot = tempDir();
  try {
    const first = await exportService.exportDataset({ manifest, outputRoot });
    const finalPath = join(outputRoot, first.sessions[0].relativePath as string);
    const bytesBefore = readFileSync(finalPath);

    const second = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(second.sessions[0].status, ParquetSessionExportStatus.SKIPPED_VERIFIED);
    assert.deepEqual(readFileSync(finalPath), bytesBefore);
    assertNoStaleTempFiles(dirname(finalPath));
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(publish-order/H) an interrupted/failed temporary write (mkdir blocked by a file where a directory is expected) leaves no trusted final file', async () => {
  const candleRepo = new FakeHistoricalCandleRepository();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifestService = new DatasetManifestService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository, sessionBuilder: new DatasetSessionManifestBuilderService(), retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository });

  const outputRoot = tempDir();
  try {
    const relativePath = parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, '2022-01-03');
    const finalPath = join(outputRoot, relativePath);
    const sessionsDir = dirname(finalPath); // '.../sessions' -- block it by pre-creating a FILE at that exact path
    mkdirSync(dirname(sessionsDir), { recursive: true });
    writeFileSync(sessionsDir, 'a file where a directory must go');

    const result = await exportService.exportDataset({ manifest, outputRoot });

    assert.equal(result.sessions[0].status, ParquetSessionExportStatus.FAILED_WRITE_ERROR);
    assert.equal(existsSync(finalPath), false);
    // The blocking file itself must be untouched -- this correction must not have tried to delete/replace it.
    assert.equal(readFileSync(sessionsDir, 'utf8'), 'a file where a directory must go');
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
