import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import DatasetManifestService from './dataset-manifest.service';
import DatasetSessionManifestBuilderService, { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import ResearchLakeParquetExportService from './research-lake-parquet-export.service';
import ResearchLakeParquetVerifyService from './research-lake-parquet-verify.service';
import { ParquetDatasetStorageDescriptor } from '../domain/parquet-storage.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

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

function normalSessionRows(tradingDate: string): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

class FakeHistoricalCandleRepository {
  rows: PersistedManifestCandleRow[] = [];
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf6-parquet-verify-'));
}

async function buildAndExport(tradingDates: string[]): Promise<{ manifest: Awaited<ReturnType<DatasetManifestService['generateUnderlyingManifest']>>; descriptor: ParquetDatasetStorageDescriptor; outputRoot: string }> {
  const candleRepo = new FakeHistoricalCandleRepository();
  for (const date of tradingDates) candleRepo.rows.push(...normalSessionRows(date));
  const manifestService = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: new (class {
      async findRange(): Promise<PersistedManifestCandleRow[]> {
        return [];
      }
    })() as unknown as HistoricalOptionCandleLakeRepository,
    sessionBuilder: new DatasetSessionManifestBuilderService(),
  });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates });

  const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository });
  const outputRoot = tempDir();
  const result = await exportService.exportDataset({ manifest, outputRoot });
  return { manifest, descriptor: result.descriptor!, outputRoot };
}

test('(verify) succeeds against an untouched, correctly exported storage descriptor', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, true);
    assert.equal(result.datasetLinkageMatches, true);
    assert.deepEqual(result.mismatchedTradingDates, []);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/O) physical file byte corruption is detected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const filePath = join(outputRoot, descriptor.sessions[0].relativePath);
    const original = readFileSync(filePath);
    original[10] ^= 0xff; // flip a byte deep in the file body
    writeFileSync(filePath, original);

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalChecksumMatches, false);
    assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/P) valid Parquet bytes with a semantic mutation (physical checksum recomputed to match, content wrong) are detected by logical checksum', async () => {
  const { manifest, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    // Re-export a DIFFERENT session's content under the SAME descriptor entry (simulates a valid-but-wrong-content swap):
    // build a second, mutated dataset, then hand-craft a descriptor pointing at that mutated file while claiming the ORIGINAL checksum.
    const mutatedCandleRepo = new FakeHistoricalCandleRepository();
    mutatedCandleRepo.rows = normalSessionRows('2022-01-03').map((row, index) => (index === 0 ? { ...row, volume: 9_999n } : row)); // still valid OHLC/volume -- stays HEALTHY, only the content checksum differs
    const mutatedManifestService = new DatasetManifestService({
      historicalCandleRepository: mutatedCandleRepo as unknown as HistoricalCandleRepository,
      sessionBuilder: new DatasetSessionManifestBuilderService(),
    });
    const mutatedManifest = await mutatedManifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
    const mutatedExportService = new ResearchLakeParquetExportService({ historicalCandleRepository: mutatedCandleRepo as unknown as HistoricalCandleRepository });
    const mutatedOutputRoot = tempDir();
    const mutatedResult = await mutatedExportService.exportDataset({ manifest: mutatedManifest, outputRoot: mutatedOutputRoot });

    // Craft a descriptor that claims the ORIGINAL session's checksum/rowcount but points at the MUTATED file's physical checksum -- this models "valid Parquet bytes, wrong logical content, physical checksum of the (wrong) bytes still matches the (wrong) descriptor entry".
    const forgedDescriptor: ParquetDatasetStorageDescriptor = {
      ...mutatedResult.descriptor!,
      datasetId: manifest.datasetId,
      datasetChecksum: manifest.datasetChecksum,
      sessions: [{ ...mutatedResult.descriptor!.sessions[0], sessionContentChecksum: manifest.sessions[0].contentChecksum }],
    };

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: forgedDescriptor, manifest, storageRoot: mutatedOutputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalChecksumMatches, true); // bytes match what the (forged) descriptor claims
    assert.equal(result.sessionResults[0].parquetParsed, true);
    assert.equal(result.sessionResults[0].logicalContentChecksumMatches, false); // but the content is wrong
    rmSync(mutatedOutputRoot, { recursive: true, force: true });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/Q) a missing session file is detected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    unlinkSync(join(outputRoot, descriptor.sessions[0].relativePath));

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalFileExists, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/R) an unsupported storage schema version is rejected fail-closed', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, storageSchemaVersion: 999 };
    const verifyService = new ResearchLakeParquetVerifyService();

    await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot }), /Unsupported B-F6 storage schema version/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/T) a wrong datasetChecksum linkage between descriptor and manifest is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, datasetChecksum: 'f'.repeat(64) };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.datasetLinkageMatches, false);
    assert.equal(result.verified, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/U) a wrong session contentChecksum linkage is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [{ ...descriptor.sessions[0], sessionContentChecksum: 'b'.repeat(64) }] };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].logicalContentChecksumMatches, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/V) a duplicate session descriptor entry (same tradingDate twice) is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [descriptor.sessions[0], descriptor.sessions[0]] };
    const verifyService = new ResearchLakeParquetVerifyService();

    await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot }), /Duplicate/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/W) session verification ordering is deterministic regardless of descriptor entry order', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const verifyService = new ResearchLakeParquetVerifyService();
    const first = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });
    const reversed: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [...descriptor.sessions].reverse() };
    const second = await verifyService.verifyStorageDescriptor({ descriptor: reversed, manifest, storageRoot: outputRoot });

    assert.deepEqual(first.mismatchedTradingDates, second.mismatchedTradingDates);
    assert.equal(first.verified, second.verified);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify) an orphaned descriptor session (no corresponding manifest session) is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [{ ...descriptor.sessions[0], tradingDate: '2099-01-01' }] };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.match(result.sessionResults[0].detail ?? '', /orphaned/i);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
