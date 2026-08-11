import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository, { HistoricalOptionCandleSessionRange } from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';

type StoredRow = { instrumentKey: string; candleTime: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: bigint; openInterest: bigint | null; };

function candles(instrumentKey: string, tradingDate: string, base = 100) {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => ({ instrumentKey, candleTime: new Date(start + index * 60_000), open: base + index / 10, high: base + index / 10 + 0.75, low: base + index / 10 - 0.5, close: base + index / 10 + 0.25, volume: BigInt(index + 1), openInterest: index % 2 === 0 ? BigInt(index + 10) : undefined }));
}

function stored(rows: ReturnType<typeof candles>): StoredRow[] {
  return rows.map((row) => ({ ...row, open: { toString: () => String(row.open) }, high: { toString: () => String(row.high) }, low: { toString: () => String(row.low) }, close: { toString: () => String(row.close) }, openInterest: row.openInterest ?? null }));
}

function underlying(): HistoricalCandleRepository { return { findByInstrumentAndTimeframe: async () => [] } as unknown as HistoricalCandleRepository; }

test('deduplicates exact contract/date sessions, bulk-loads and groups rows, and reuses complete sessions from memory', async () => {
  const a = candles('A', '2026-07-15', 100); const b = candles('B', '2026-07-16', 200); let bulkRequests: readonly HistoricalOptionCandleSessionRange[] = []; let fallbackCalls = 0; let upstoxCalls = 0;
  const repository = {
    findByInstrumentDateSessions: async (requests: readonly HistoricalOptionCandleSessionRange[]) => { bulkRequests = requests; return [...stored(a), ...stored(b)]; },
    findRange: async () => { fallbackCalls += 1; return []; },
  } as unknown as HistoricalOptionCandleRepository;
  const cache = { getStats: () => ({ hits: 0, misses: upstoxCalls, stored: 0 }), getCandles: async () => { upstoxCalls += 1; return []; } } as unknown as HistoricalOptionCandleCacheService;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, cache, true);

  await service.preloadOptionSessions([{ instrumentKey: 'A', tradingDate: '2026-07-15' }, { instrumentKey: 'A', tradingDate: '2026-07-15' }, { instrumentKey: 'B', tradingDate: '2026-07-16' }]);
  const loadedA = await service.getOptionSession({ instrumentKey: 'A', tradingDate: '2026-07-15' });
  const loadedB = await service.getOptionSession({ instrumentKey: 'B', tradingDate: '2026-07-16' });
  const loadedAAgain = await service.getOptionSession({ instrumentKey: 'A', tradingDate: '2026-07-15' });
  const stats = service.getStats();

  assert.deepEqual(bulkRequests, [{ instrumentKey: 'A', tradingDate: '2026-07-15' }, { instrumentKey: 'B', tradingDate: '2026-07-16' }]);
  assert.equal(loadedA.length, 375); assert.equal(loadedB.length, 375); assert.equal(loadedA[0].instrumentKey, 'A'); assert.equal(loadedB[0].instrumentKey, 'B');
  assert.deepEqual(loadedA[0], a[0]); assert.deepEqual(loadedB[374], b[374]); assert.deepEqual(loadedAAgain, loadedA);
  assert.equal(fallbackCalls, 0); assert.equal(upstoxCalls, 0); assert.equal(stats.uniqueOptionContractDateSessions, 2); assert.equal(stats.optionSessionsLoadedFromMySql, 2); assert.equal(stats.optionCandlesLoadedFromMySql, 750); assert.equal(stats.completeLocalSessions, 2); assert.equal(stats.incompleteLocalSessions, 0); assert.equal(stats.missingLocalSessions, 0); assert.equal(stats.inMemoryLookupHits, 3); assert.equal(stats.dbFallbackHits, 0); assert.equal(stats.bulkPreloadQueryCount, 1);
});

test('RESEARCH_LOCAL_ONLY reports missing and incomplete exact sessions without calling Upstox', async () => {
  const incomplete = stored(candles('INCOMPLETE', '2026-07-17').slice(0, 12)); let upstoxCalls = 0; let fallbackCalls = 0;
  const repository = {
    findByInstrumentDateSessions: async () => incomplete,
    findRange: async () => { fallbackCalls += 1; return []; },
  } as unknown as HistoricalOptionCandleRepository;
  const cache = { getStats: () => ({ hits: 0, misses: upstoxCalls, stored: 0 }), getCandles: async () => { upstoxCalls += 1; return []; } } as unknown as HistoricalOptionCandleCacheService;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, cache, true);

  await assert.rejects(() => service.preloadOptionSessions([{ instrumentKey: 'INCOMPLETE', tradingDate: '2026-07-17' }, { instrumentKey: 'MISSING', tradingDate: '2026-07-18' }]), /instrumentKey=INCOMPLETE tradingDate=2026-07-17 expected=375 continuous 1minute candles locallyAvailable=12; .*instrumentKey=MISSING tradingDate=2026-07-18 expected=375 continuous 1minute candles locallyAvailable=0/);
  const stats = service.getStats();
  assert.equal(upstoxCalls, 0); assert.equal(fallbackCalls, 0); assert.equal(stats.incompleteLocalSessions, 1); assert.equal(stats.missingLocalSessions, 1); assert.equal(stats.completeLocalSessions, 0); assert.equal(stats.bulkPreloadQueryCount, 1);
});
