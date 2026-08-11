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

  await assert.rejects(() => cache.getCandles('NSE_FO|TEST|04-08-2026', '2026-08-04'), /Upstox returned incomplete option candles/);
  assert.equal(upserts, 0);
  assert.deepEqual(cache.getSessionResults(), [{ instrumentKey: 'NSE_FO|TEST|04-08-2026', tradingDate: '2026-08-04', status: 'failed', downloadedCandleCount: 1, storedCandleCount: 0, error: 'Upstox returned incomplete option candles for NSE_FO|TEST|04-08-2026 on 2026-08-04; expected 375 continuous 1minute candles from 09:15 through 15:29 IST, received 1.' }]);
});
