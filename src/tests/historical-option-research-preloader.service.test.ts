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

test('diagnostics deduplicates exact sessions and reports local completeness without touching the option cache', async () => {
  const complete = stored(candles('COMPLETE', '2026-07-15')); const incomplete = stored(candles('INCOMPLETE', '2026-07-16').slice(0, 12)); let bulkRequests: readonly HistoricalOptionCandleSessionRange[] = [];
  const repository = { findByInstrumentDateSessions: async (requests: readonly HistoricalOptionCandleSessionRange[]) => { bulkRequests = requests; return [...complete, ...incomplete]; } } as unknown as HistoricalOptionCandleRepository;
  const cache = { getCandles: async () => { throw new Error('Diagnostics must not access the option cache.'); } } as unknown as HistoricalOptionCandleCacheService;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, cache, false);

  const inspection = await service.inspectLocalOptionSessions([
    { instrumentKey: 'COMPLETE', tradingDate: '2026-07-15' },
    { instrumentKey: 'COMPLETE', tradingDate: '2026-07-15' },
    { instrumentKey: 'INCOMPLETE', tradingDate: '2026-07-16' },
    { instrumentKey: 'MISSING', tradingDate: '2026-07-17' },
  ]);

  assert.deepEqual(bulkRequests, [{ instrumentKey: 'COMPLETE', tradingDate: '2026-07-15' }, { instrumentKey: 'INCOMPLETE', tradingDate: '2026-07-16' }, { instrumentKey: 'MISSING', tradingDate: '2026-07-17' }]);
  assert.deepEqual(inspection, {
    uniqueRequiredSessions: 3,
    completeLocalSessions: 1,
    incompleteLocalSessions: 1,
    missingLocalSessions: 1,
    sessions: [
      { instrumentKey: 'COMPLETE', tradingDate: '2026-07-15', locallyAvailableCandleCount: 375, complete: true },
      { instrumentKey: 'INCOMPLETE', tradingDate: '2026-07-16', locallyAvailableCandleCount: 12, complete: false },
      { instrumentKey: 'MISSING', tradingDate: '2026-07-17', locallyAvailableCandleCount: 0, complete: false },
    ],
  });
});

test('verified cleanup deletes only ten out-of-session rows and leaves the complete 375-minute window intact', async () => {
  const instrumentKey = 'OVERFULL'; const tradingDate = '2026-08-04'; const base = candles(instrumentKey, tradingDate); const extras = Array.from({ length: 10 }, (_, index) => ({ ...base[374], candleTime: new Date(`${tradingDate}T15:${String(30 + index).padStart(2, '0')}:00+05:30`) })); let rows = stored([...base, ...extras]); let deleted: Date[] = [];
  const repository = {
    findByInstrumentDateSessions: async () => rows,
    findRange: async () => rows,
    deleteExactCandleTimes: async (_instrument: string, _timeframe: string, candleTimes: readonly Date[]) => { deleted = [...candleTimes]; const timestamps = new Set(candleTimes.map((candleTime) => candleTime.getTime())); const before = rows.length; rows = rows.filter((row) => !timestamps.has(row.candleTime.getTime())); return before - rows.length; },
  } as unknown as HistoricalOptionCandleRepository;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, {} as HistoricalOptionCandleCacheService, false);

  const cleaned = await service.removeVerifiedOutOfSessionRows([{ instrumentKey, tradingDate }]);

  assert.equal(cleaned.length, 1); assert.equal(cleaned[0].removedCandleTimes.length, 10); assert.equal(rows.length, 375); assert.equal(deleted.length, 10);
  assert.ok(rows.every((row) => row.candleTime.getTime() >= new Date(`${tradingDate}T09:15:00+05:30`).getTime() && row.candleTime.getTime() <= new Date(`${tradingDate}T15:29:00+05:30`).getTime()));
});

test('verified cleanup refuses sessions with a missing expected minute', async () => {
  const instrumentKey = 'GAPPED'; const tradingDate = '2026-08-04'; const rows = stored([...candles(instrumentKey, tradingDate).slice(1), ...Array.from({ length: 10 }, (_, index) => ({ ...candles(instrumentKey, tradingDate)[374], candleTime: new Date(`${tradingDate}T15:${String(30 + index).padStart(2, '0')}:00+05:30`) }))]); let deletes = 0;
  const repository = { findByInstrumentDateSessions: async () => rows, deleteExactCandleTimes: async () => { deletes += 1; return 0; } } as unknown as HistoricalOptionCandleRepository;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, {} as HistoricalOptionCandleCacheService, false);

  await assert.rejects(() => service.removeVerifiedOutOfSessionRows([{ instrumentKey, tradingDate }]), /Refusing out-of-session cleanup/);
  assert.equal(deletes, 0);
});

test('non-local preload fills only the missing sessions and reuses already complete sessions', async () => {
  const completeRows = stored(candles('COMPLETE', '2026-07-15')); const downloadedRows = candles('MISSING', '2026-07-16'); let cacheRequests: Array<{ instrumentKey: string; tradingDate: string }> = [];
  const repository = {
    findByInstrumentDateSessions: async () => completeRows,
    findRange: async () => [],
  } as unknown as HistoricalOptionCandleRepository;
  const cache = {
    getStats: () => ({ hits: 0, misses: cacheRequests.length, stored: cacheRequests.length * 375 }),
    getCandles: async (instrumentKey: string, tradingDate: string) => { cacheRequests.push({ instrumentKey, tradingDate }); return downloadedRows.map((row) => ({ ...row })); },
  } as unknown as HistoricalOptionCandleCacheService;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, cache, false);

  await service.preloadOptionSessions([{ instrumentKey: 'COMPLETE', tradingDate: '2026-07-15' }, { instrumentKey: 'MISSING', tradingDate: '2026-07-16' }]);

  assert.deepEqual(cacheRequests, [{ instrumentKey: 'MISSING', tradingDate: '2026-07-16' }]);
  assert.equal((await service.getOptionSession({ instrumentKey: 'COMPLETE', tradingDate: '2026-07-15' })).length, 375);
  assert.equal((await service.getOptionSession({ instrumentKey: 'MISSING', tradingDate: '2026-07-16' })).length, 375);
});

test('non-local preload attempts every required missing session before reporting fill failures', async () => {
  const attempted: string[] = [];
  const repository = { findByInstrumentDateSessions: async () => [], findRange: async () => [] } as unknown as HistoricalOptionCandleRepository;
  const cache = {
    getStats: () => ({ hits: 0, misses: attempted.length, stored: 0 }),
    getCandles: async (instrumentKey: string, tradingDate: string) => { attempted.push(`${instrumentKey}|${tradingDate}`); if (instrumentKey === 'FAIL') throw new Error('authoritative response was invalid'); return candles(instrumentKey, tradingDate); },
  } as unknown as HistoricalOptionCandleCacheService;
  const service = new HistoricalOptionResearchPreloaderService(underlying(), repository, cache, false);

  await assert.rejects(() => service.preloadOptionSessions([{ instrumentKey: 'FAIL', tradingDate: '2026-07-15' }, { instrumentKey: 'SUCCESS', tradingDate: '2026-07-16' }]), /Historical option cache fill failed for 1 required session/);
  assert.deepEqual(attempted.sort(), ['FAIL|2026-07-15', 'SUCCESS|2026-07-16']);
  assert.equal((await service.getOptionSession({ instrumentKey: 'SUCCESS', tradingDate: '2026-07-16' })).length, 375);
});
