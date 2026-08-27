import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import DatasetManifestService from './dataset-manifest.service';
import { ManifestDatasetKind, SourceAcquisitionEvidenceAvailability } from '../domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const OPTION_CONTRACT_ID = 'NSE-NIFTY-06Jan22-17200-PE';

interface FakeRow {
  candleTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: bigint;
  openInterest: bigint | null;
}

function makeRow(candleTime: Date, overrides: Partial<FakeRow> = {}): FakeRow {
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

function normalSessionRows(tradingDate: string): FakeRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

/** Only implements `findRange` -- the only method `DatasetManifestService` ever calls (task section 16.W: "no provider API request during manifest generation/verification"; here, no OTHER repository method is called either). */
class FakeHistoricalCandleRepository {
  rows: FakeRow[] = [];
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<FakeRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

class FakeHistoricalOptionCandleLakeRepository {
  rows: FakeRow[] = [];
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<FakeRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

function newService(): { service: DatasetManifestService; candleRepo: FakeHistoricalCandleRepository; optionRepo: FakeHistoricalOptionCandleLakeRepository } {
  const candleRepo = new FakeHistoricalCandleRepository();
  const optionRepo = new FakeHistoricalOptionCandleLakeRepository();
  const service = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
  });
  return { service, candleRepo, optionRepo };
}

test('(I) generatedAt changes between two runs, but dataset identity (checksum/id) stays the same for unchanged content', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });

  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.datasetChecksum, second.datasetChecksum);
  assert.equal(first.datasetId, second.datasetId);
});

test('(J) same sessions requested in a different order -> same dataset ID', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const forward = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  const reversed = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-04', '2022-01-03'] });

  assert.equal(forward.datasetId, reversed.datasetId);
  assert.deepEqual(forward.sessions.map((s) => s.identity.tradingDate), ['2022-01-03', '2022-01-04']); // sessions are stored sorted regardless of request order
});

test('(K)/(L) adding or removing a session changes the dataset ID', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const oneSession = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  const twoSessions = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });

  assert.notEqual(oneSession.datasetId, twoSessions.datasetId);
});

test('(M) a duplicate logical session (same trading date requested twice) is rejected', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');

  await assert.rejects(
    () => service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-03'] }),
    /duplicates/
  );
});

test('rejects an empty tradingDates list -- never defaults to a bulk scan', async () => {
  const { service } = newService();
  await assert.rejects(() => service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [] }), /non-empty tradingDates/);
});

test('(W) manifest generation never calls anything beyond findRange on the repository (no provider API request)', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  assert.equal(candleRepo.findRangeCallCount, 1);
});

test('generates a manifest for the EXPIRED_OPTION_1M dataset kind, keyed by providerContractId', async () => {
  const { service, optionRepo } = newService();
  optionRepo.rows = [makeRow(new Date('2022-01-03T09:15:00+05:30'), { openInterest: 500n })];

  const manifest = await service.generateOptionManifest({
    provider: HistoricalProviderId.GROWW,
    providerContractId: OPTION_CONTRACT_ID,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-01-06T00:00:00+05:30'),
    timeframe: '1minute',
    tradingDates: ['2022-01-03'],
  });

  assert.equal(manifest.datasetKind, ManifestDatasetKind.EXPIRED_OPTION_1M);
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].rowsWithOi, 1);
});

test('(R) verification succeeds against unchanged persisted data', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, true);
  assert.equal(result.datasetChecksumMatches, true);
  assert.deepEqual(result.mismatchedTradingDates, []);
});

test('(S) a mutated persisted row causes verification to fail closed, identifying the affected trading date', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows[10] = { ...candleRepo.rows[10], close: new Prisma.Decimal(9999) };
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

test('(T) a missing persisted row causes verification to fail closed', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows.splice(10, 1);
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

test('(U) an extra persisted row causes verification to fail closed', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows.push(makeRow(new Date('2022-01-03T04:20:00.000Z')));
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

// ---- Root-defect correction regression tests (independent review) --------

test('(REVIEW-K) generation never fabricates source-acquisition evidence, and verification preserves the same persisted-content/source-evidence distinction', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.excludedRowCount, null);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.sourceOrderAnomalyCount, null);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.sourceHealthStatus, null);

  const result = await service.verifyManifest(manifest);
  assert.equal(result.verified, true);
  assert.equal(result.sessionResults[0].originalPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(result.sessionResults[0].recomputedPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  // Verify never introduces or asserts a source-acquisition health value anywhere in its result -- there is no such field to fabricate.
  assert.ok(!('sourceHealthStatus' in result.sessionResults[0]));
});

test('(REVIEW-L) manifest generation remains deterministic after the correction -- datasetChecksum/datasetId are unaffected by the source-acquisition-evidence rename', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-04', '2022-01-03'] });

  assert.equal(first.datasetChecksum, second.datasetChecksum);
  assert.equal(first.datasetId, second.datasetId);
  assert.equal(first.sessionCounts.healthy, 2);
  assert.equal(first.sessionCounts.incomplete, 0);
  assert.equal(first.sessionCounts.invalid, 0);
});
