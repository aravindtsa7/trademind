import assert from 'node:assert/strict';
import test from 'node:test';
import { Candle } from '../../indicators/types';
import {
  HistoricalCandleWarmupRecord,
  PaperStrategyWarmupRepository,
  PaperStrategyWarmupTarget,
} from '../dto/paper-strategy-warmup.dto';
import PaperStrategyWarmupService from './paper-strategy-warmup.service';

function records(count: number): HistoricalCandleWarmupRecord[] {
  const start = new Date('2026-08-03T09:15:00+05:30').getTime();
  return Array.from({ length: count }, (_, index) => ({
    candleTime: new Date(start + index * 60_000),
    open: 24_000 + index,
    high: 24_002 + index,
    low: 23_999 + index,
    close: 24_001 + index,
    volume: 10n,
  }));
}

class RepositoryMock implements PaperStrategyWarmupRepository {
  constructor(private readonly rows: readonly HistoricalCandleWarmupRecord[]) {}
  async findByInstrumentAndTimeframe(): Promise<readonly HistoricalCandleWarmupRecord[]> {
    return this.rows;
  }
}

class StrategyAdapterMock implements PaperStrategyWarmupTarget {
  readonly seeded: Candle[] = [];
  seedCalls = 0;

  seedHistoricalCandles(candles: readonly Candle[]): void {
    this.seedCalls += 1;
    this.seeded.push(...candles.map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp.getTime()) })));
  }

  isWarmupReady(): boolean {
    return this.seeded.length >= 36;
  }
}

test('warms the live strategy with the latest preferred 50 completed five-minute candles', async () => {
  const target = new StrategyAdapterMock();
  const result = await new PaperStrategyWarmupService(new RepositoryMock(records(300)), target).warmUp();

  assert.equal(result.oneMinuteCandlesLoaded, 300);
  assert.equal(result.fiveMinuteCandlesProduced, 50);
  assert.equal(result.warmupReady, true);
  assert.equal(target.seedCalls, 1);
  assert.equal(target.seeded.length, 50);
  assert.equal(target.seeded[0].timestamp.toISOString(), '2026-08-03T04:35:00.000Z');
  assert.equal(target.seeded[49].timestamp.toISOString(), '2026-08-03T08:40:00.000Z');
});

test('fails clearly when fewer than 36 completed five-minute candles are available', async () => {
  await assert.rejects(
    () => new PaperStrategyWarmupService(new RepositoryMock(records(175)), new StrategyAdapterMock()).warmUp(),
    /Insufficient completed NIFTY 5-minute candle history.*35\/36/
  );
});

test('sorts repository rows chronologically before seeding', async () => {
  const target = new StrategyAdapterMock();
  const result = await new PaperStrategyWarmupService(new RepositoryMock([...records(180)].reverse()), target).warmUp();

  assert.equal(result.fiveMinuteCandlesProduced, 36);
  assert.ok(target.seeded.every((candle, index) => index === 0 || candle.timestamp > target.seeded[index - 1].timestamp));
});

test('rejects duplicate historical one-minute timestamps deterministically', async () => {
  const rows = records(180);
  rows.push(structuredClone(rows[0]));
  await assert.rejects(
    () => new PaperStrategyWarmupService(new RepositoryMock(rows), new StrategyAdapterMock()).warmUp(),
    /Duplicate historical one-minute candle timestamp/
  );
});

test('does not mutate repository records or evaluate/orchestrate historical candles', async () => {
  const rows = records(180);
  const original = structuredClone(rows);
  const target = new StrategyAdapterMock();
  await new PaperStrategyWarmupService(new RepositoryMock(rows), target).warmUp();

  assert.deepEqual(rows, original);
  assert.equal(target.seedCalls, 1);
  assert.equal(target.seeded.length, 36);
});
