import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';

type CacheRow = {
  instrumentKey: string;
  timeframe: string;
  candleTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: bigint;
  openInterest: bigint | null;
};

class MemoryRepository {
  readonly rows: CacheRow[] = [];

  async findRange(instrumentKey: string, timeframe: string, from: Date, to: Date): Promise<CacheRow[]> {
    return this.rows
      .filter((row) => row.instrumentKey === instrumentKey && row.timeframe === timeframe && row.candleTime >= from && row.candleTime <= to)
      .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
      .map((row) => ({ ...row, candleTime: new Date(row.candleTime.getTime()) }));
  }

  async bulkUpsert(inputs: Array<{ instrumentKey: string; timeframe: string; candleTime: Date; open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal; volume: bigint; openInterest?: bigint | null }>): Promise<CacheRow[]> {
    inputs.forEach((input) => {
      const index = this.rows.findIndex((row) => row.instrumentKey === input.instrumentKey && row.timeframe === input.timeframe && row.candleTime.getTime() === input.candleTime.getTime());
      const row: CacheRow = { ...input, candleTime: new Date(input.candleTime.getTime()), openInterest: input.openInterest ?? null };
      if (index === -1) this.rows.push(row); else this.rows[index] = row;
    });
    return this.rows;
  }

  async count(): Promise<number> { return this.rows.length; }
}

class FakeCandleClient {
  calls = 0;
  constructor(private readonly response: (instrumentKey: string, date: string) => Promise<ExpiredOptionCandleDto[]>) {}
  async fetchCandles(instrumentKey: string, fromDate: string): Promise<ExpiredOptionCandleDto[]> { this.calls += 1; return this.response(instrumentKey, fromDate); }
}

function sessionCandles(instrumentKey: string, date: string, base = 100): ExpiredOptionCandleDto[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => ({
    instrumentKey,
    candleTime: new Date(start + index * 60_000),
    open: base + index / 10,
    high: base + index / 10 + 1,
    low: base + index / 10 - 1,
    close: base + index / 10 + 0.5,
    volume: BigInt(index + 1),
    openInterest: index % 2 === 0 ? BigInt(index) : undefined,
  }));
}

function createService(response: (instrumentKey: string, date: string) => Promise<ExpiredOptionCandleDto[]>): { service: HistoricalOptionCandleCacheService; repository: MemoryRepository; client: FakeCandleClient } {
  const repository = new MemoryRepository();
  const client = new FakeCandleClient(response);
  return {
    service: new HistoricalOptionCandleCacheService(repository as unknown as HistoricalOptionCandleRepository, client as unknown as UpstoxExpiredOptionCandleClient),
    repository,
    client,
  };
}

test('cache miss downloads, persists, and later returns the stored option candles without Upstox', async () => {
  const instrumentKey = 'NSE_FO|CACHE-ONE';
  const source = sessionCandles(instrumentKey, '2026-07-15');
  const { service, repository, client } = createService(async () => source);

  const first = await service.getCandles(instrumentKey, '2026-07-15', { tradingSymbol: 'NIFTY CE', optionType: 'CE', strikePrice: 25000, expiry: new Date('2026-07-16T00:00:00.000Z') });
  const second = await service.getCandles(instrumentKey, '2026-07-15');

  assert.equal(client.calls, 1);
  assert.equal(repository.rows.length, 375);
  assert.deepEqual(first, second);
  assert.deepEqual(service.getStats(), { hits: 1, misses: 1, stored: 375 });
});

test('upserts prevent duplicate rows and isolate cached option candles by instrument and date', async () => {
  const { service, repository, client } = createService(async (instrumentKey, date) => sessionCandles(instrumentKey, date, date === '2026-07-15' ? 100 : 200));

  await service.getCandles('NSE_FO|ONE', '2026-07-15');
  await service.getCandles('NSE_FO|ONE', '2026-07-16');
  await service.getCandles('NSE_FO|TWO', '2026-07-15');
  await service.getCandles('NSE_FO|ONE', '2026-07-15');

  assert.equal(client.calls, 3);
  assert.equal(repository.rows.length, 1_125);
  assert.equal((await repository.findRange('NSE_FO|ONE', '1minute', new Date('2026-07-14T18:30:00.000Z'), new Date('2026-07-15T18:29:59.999Z'))).length, 375);
});

test('concurrent same-key requests share one Upstox download and preserve exact candle values', async () => {
  const instrumentKey = 'NSE_FO|CONCURRENT';
  const source = sessionCandles(instrumentKey, '2026-07-15', 321.25);
  const sourceSnapshot = source.map((candle) => ({ ...candle, candleTime: candle.candleTime.getTime() }));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { service, repository, client } = createService(async () => { await gate; return source; });

  const first = service.getCandles(instrumentKey, '2026-07-15');
  const second = service.getCandles(instrumentKey, '2026-07-15');
  release?.();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(client.calls, 1);
  assert.equal(repository.rows.length, 375);
  assert.deepEqual(left, right);
  assert.equal(left[0].open, source[0].open);
  assert.equal(left[374].close, source[374].close);
  assert.deepEqual(source.map((candle) => ({ ...candle, candleTime: candle.candleTime.getTime() })), sourceSnapshot);
});

test('rejects an empty Upstox result and does not persist fabricated candles', async () => {
  const { service, repository } = createService(async () => []);
  await assert.rejects(() => service.getCandles('NSE_FO|EMPTY', '2026-07-15'), /returned no option candles/);
  assert.equal(repository.rows.length, 0);
});
