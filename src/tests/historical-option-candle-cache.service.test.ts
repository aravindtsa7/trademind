import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';

test('rejects an incomplete historical option response before any upsert', async () => {
  let upserts = 0;
  const repository = {
    findRange: async () => [],
    bulkUpsert: async () => { upserts += 1; return []; },
  } as unknown as HistoricalOptionCandleRepository;
  const client = {
    fetchCandles: async () => [{ candleTime: new Date('2026-08-04T09:15:00+05:30'), open: 100, high: 101, low: 99, close: 100.5, volume: 1n }],
  } as never;
  const cache = new HistoricalOptionCandleCacheService(repository, client);

  await assert.rejects(() => cache.getCandles('NSE_FO|TEST|04-08-2026', '2026-08-04'), /Upstox returned incomplete or malformed option candles/);
  assert.equal(upserts, 0);
  assert.deepEqual(cache.getSessionResults(), [{ instrumentKey: 'NSE_FO|TEST|04-08-2026', tradingDate: '2026-08-04', status: 'failed', downloadedCandleCount: 1, storedCandleCount: 0, error: 'Upstox returned incomplete or malformed option candles for NSE_FO|TEST|04-08-2026 on 2026-08-04; expected 375 continuous valid 1minute candles from 09:15 through 15:29 IST, received 1.' }]);
});

test('reports a valid session with only post-close rows as overfull without storing any candles', async () => {
  let upserts = 0;
  const tradingDate = '2026-08-04';
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  const regular = Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000), open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: BigInt(index + 1) }));
  const extras = Array.from({ length: 10 }, (_, index) => ({ ...regular[374], candleTime: new Date(`${tradingDate}T15:${String(30 + index).padStart(2, '0')}:00+05:30`) }));
  const repository = { findRange: async () => [], bulkUpsert: async () => { upserts += 1; return []; } } as unknown as HistoricalOptionCandleRepository;
  const client = { fetchCandles: async () => [...regular, ...extras] } as never;
  const cache = new HistoricalOptionCandleCacheService(repository, client);

  await assert.rejects(() => cache.getCandles('NSE_FO|OVERFULL|04-08-2026', tradingDate), /refusing to store until guarded cleanup is authorized/);
  assert.equal(upserts, 0);
  assert.deepEqual(cache.getSessionResults(), [{ instrumentKey: 'NSE_FO|OVERFULL|04-08-2026', tradingDate, status: 'overfull', downloadedCandleCount: 385, storedCandleCount: 0, extraCandleTimes: extras.map((candle) => candle.candleTime.toISOString()), error: 'Upstox returned 375 valid in-session option candles plus 10 out-of-session rows for NSE_FO|OVERFULL|04-08-2026 on 2026-08-04; refusing to store until guarded cleanup is authorized.' }]);
});

test('normalizes only an explicitly authorized 15:30-15:39 overfull response and preserves its regular-session OHLC', async () => {
  const instrumentKey = 'NSE_FO|65867|04-08-2026'; const tradingDate = '2026-08-03'; const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  const regular = Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000), open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: BigInt(index + 1), openInterest: index % 2 === 0 ? BigInt(index + 10) : undefined }));
  const extras = Array.from({ length: 10 }, (_, index) => ({ ...regular[374], candleTime: new Date(`${tradingDate}T15:${String(30 + index).padStart(2, '0')}:00+05:30`) })); let upserted: unknown[] = []; let reads = 0;
  const persisted = regular.map((candle) => ({ instrumentKey, ...candle, open: { toString: () => String(candle.open) }, high: { toString: () => String(candle.high) }, low: { toString: () => String(candle.low) }, close: { toString: () => String(candle.close) }, openInterest: candle.openInterest ?? null }));
  const repository = { findRange: async () => { reads += 1; return reads === 1 ? [] : persisted; }, bulkUpsert: async (rows: unknown[]) => { upserted = rows; return rows; } } as unknown as HistoricalOptionCandleRepository;
  const client = { fetchCandles: async () => [...regular, ...extras] } as never;
  const cache = new HistoricalOptionCandleCacheService(repository, client, [{ instrumentKey, tradingDate }]);

  const result = await cache.getCandles(instrumentKey, tradingDate);

  assert.equal(upserted.length, 375); assert.equal(result.length, 375); assert.deepEqual(result[0], { instrumentKey, ...regular[0] }); assert.deepEqual(result[374], { instrumentKey, ...regular[374] });
  assert.deepEqual(cache.getSessionResults(), [{ instrumentKey, tradingDate, status: 'normalized', downloadedCandleCount: 385, storedCandleCount: 375, excludedCandleCount: 10, extraCandleTimes: extras.map((candle) => candle.candleTime.toISOString()) }]);
});

test('rejects an authorized session when its extra-row pattern differs from 15:30-15:39', async () => {
  const instrumentKey = 'BSE_FO|840209|06-08-2026'; const tradingDate = '2026-08-03'; const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  const regular = Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000), open: 100, high: 101, low: 99, close: 100.5, volume: 1n }));
  const extras = Array.from({ length: 10 }, (_, index) => ({ ...regular[374], candleTime: new Date(`${tradingDate}T15:${String(index === 9 ? 40 : 30 + index).padStart(2, '0')}:00+05:30`) }));
  let upserts = 0;
  const repository = { findRange: async () => [], bulkUpsert: async () => { upserts += 1; return []; } } as unknown as HistoricalOptionCandleRepository;
  const cache = new HistoricalOptionCandleCacheService(repository, { fetchCandles: async () => [...regular, ...extras] } as never, [{ instrumentKey, tradingDate }]);

  await assert.rejects(() => cache.getCandles(instrumentKey, tradingDate), /refusing to store until guarded cleanup is authorized/);
  assert.equal(upserts, 0);
  assert.equal(cache.getSessionResults()[0].status, 'overfull');
});

test('reuses a complete normalized session without a second remote fetch or upsert', async () => {
  const instrumentKey = 'BSE_FO|840341|06-08-2026'; const tradingDate = '2026-08-03'; const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  const persisted = Array.from({ length: 375 }, (_, index) => ({ instrumentKey, candleTime: new Date(start + index * 60_000), open: { toString: () => '100' }, high: { toString: () => '101' }, low: { toString: () => '99' }, close: { toString: () => '100.5' }, volume: 1n, openInterest: null }));
  let fetches = 0; let upserts = 0;
  const repository = { findRange: async () => persisted, bulkUpsert: async () => { upserts += 1; return []; } } as unknown as HistoricalOptionCandleRepository;
  const cache = new HistoricalOptionCandleCacheService(repository, { fetchCandles: async () => { fetches += 1; return []; } } as never, [{ instrumentKey, tradingDate }]);

  const candles = await cache.getCandles(instrumentKey, tradingDate);
  assert.equal(candles.length, 375); assert.equal(fetches, 0); assert.equal(upserts, 0);
  assert.equal(cache.getSessionResults()[0].status, 'hit');
});
