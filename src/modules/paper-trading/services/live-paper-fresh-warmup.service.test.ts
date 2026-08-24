import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalCandleWarmupRecord, PaperStrategyWarmupTarget } from '../dto/paper-strategy-warmup.dto';
import LivePaperFreshWarmupService from './live-paper-fresh-warmup.service';
import { Candle } from '../../indicators/types';
import LivePaperStrategyAdapterService from './live-paper-strategy-adapter.service';
import V4NiftyMomentumShadowEvaluatorService from '../../adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service';

function rows(date: string, count: number): HistoricalCandleWarmupRecord[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: count }, (_, index) => ({ candleTime: new Date(start + index * 60_000), open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1n }));
}
function dto(row: HistoricalCandleWarmupRecord) { return { candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: BigInt(row.volume as bigint) }; }
class Target implements PaperStrategyWarmupTarget { seeded: Candle[] = []; seedHistoricalCandles(candles: readonly Candle[]): void { this.seeded = [...candles]; } isWarmupReady(): boolean { return this.seeded.length >= 36; } }
const prior = () => rows('2026-08-07', 375);
const at1240 = new Date('2026-08-12T12:40:12+05:30');

test('stale Aug-07-style warmup cannot become ready on Aug 12, even with an old five-minute seed', async () => {
  const target = new Target(); const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => [] }, { maxIntradayAttempts: 1 }).warmUp(at1240);
  assert.equal(result.ready, false); assert.match(result.freshnessReason, /STALE_CURRENT_DAY_HISTORY/); assert.equal(result.warmupReady, true); assert.equal(result.currentDaySource, 'INTRADAY'); assert.equal(result.currentDayMissingMinuteCount, 205); assert.equal(result.latestCompletedFiveMinuteAvailable?.toISOString(), '2026-08-07T09:55:00.000Z');
});

test('retries a single newest-minute intraday publication lag, then rebuilds a fresh current-day five-minute seed', async () => {
  const target = new Target(); const behind = rows('2026-08-12', 204).map(dto); const current = rows('2026-08-12', 205).map(dto); let calls = 0; let waits = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => (++calls === 1 ? behind : current) }, { maxIntradayAttempts: 2, intradayRetryIntervalMs: 0, wait: async () => { waits += 1; } }).warmUp(at1240);
  assert.equal(result.ready, true); assert.equal(calls, 2); assert.equal(waits, 1); assert.equal(result.intradayBackfillAttempts, 2); assert.equal(result.currentDayLagMinutes, 0); assert.equal(result.intradayRetryReason, 'NEWEST_COMPLETED_MINUTE_NOT_PUBLISHED'); assert.equal(result.currentDayMissingMinuteCount, 0);
  assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T07:09:00.000Z'); assert.equal(result.latestCompletedFiveMinuteAvailable?.toISOString(), '2026-08-12T07:05:00.000Z'); assert.equal(result.lastFiveMinuteTimestamp.toISOString(), '2026-08-12T07:05:00.000Z'); assert.equal(target.seeded.at(-1)?.timestamp.toISOString(), '2026-08-12T07:05:00.000Z'); assert.equal(result.seededOneMinuteCandles.at(-1)?.timestamp.toISOString(), '2026-08-12T07:09:00.000Z');
});

test('bounded retry timeout leaves the freshness gate closed when the newest minute remains unpublished', async () => {
  const target = new Target(); const behind = rows('2026-08-12', 204).map(dto); let calls = 0; let waits = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => { calls += 1; return behind; } }, { maxIntradayAttempts: 2, intradayRetryIntervalMs: 0, wait: async () => { waits += 1; } }).warmUp(at1240);
  assert.equal(result.ready, false); assert.equal(calls, 2); assert.equal(waits, 1); assert.equal(result.currentDayMissingMinuteCount, 1); assert.equal(result.currentDayLagMinutes, 1); assert.equal(result.intradayRetryReason, 'NEWEST_COMPLETED_MINUTE_NOT_PUBLISHED');
});

test('an earlier current-day historical gap is never treated as an acceptable publication lag', async () => {
  const target = new Target(); const gapped = rows('2026-08-12', 205).filter((_, index) => index !== 50).map(dto); let calls = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => { calls += 1; return gapped; } }, { maxIntradayAttempts: 3, intradayRetryIntervalMs: 0, wait: async () => assert.fail('an arbitrary historical gap must not retry') }).warmUp(at1240);
  assert.equal(result.ready, false); assert.equal(calls, 1); assert.equal(result.currentDayMissingMinuteCount, 1); assert.equal(result.intradayRetryReason, null); assert.match(result.freshnessReason, /STALE_CURRENT_DAY_HISTORY/);
});

test('merge remains timestamp-deduplicated and excludes a forming minute from one-minute and five-minute warm-up state', async () => {
  const target = new Target(); const current = [...rows('2026-08-12', 205), rows('2026-08-12', 205)[0], ...rows('2026-08-12', 206).slice(-1)].map(dto); let writes = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => [...prior(), ...rows('2026-08-12', 204)], bulkUpsert: async (inputs) => { writes += inputs.length; } }, target, { fetchCurrentDayOneMinuteCandles: async () => current }, { maxIntradayAttempts: 1 }).warmUp(at1240);
  assert.equal(result.ready, true); assert.equal(result.currentDayDuplicateCount, 1); assert.equal(result.currentDayRowsReturned, 207); assert.equal(result.lastCurrentDayCandle?.toISOString(), '2026-08-12T07:09:00.000Z'); assert.equal(result.latestCompletedFiveMinuteAvailable?.toISOString(), '2026-08-12T07:05:00.000Z'); assert.equal(new Set(result.seededOneMinuteCandles.map((candle) => candle.timestamp.getTime())).size, result.seededOneMinuteCandles.length); assert.equal(writes, 205);
});

test('excludes the current incomplete five-minute bucket while retaining the latest fully completed bucket', async () => {
  const target = new Target(); const now = new Date('2026-08-12T12:39:12+05:30');
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 204).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(now);
  assert.equal(result.ready, true); assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T07:08:00.000Z'); assert.equal(result.latestCompletedFiveMinuteAvailable?.toISOString(), '2026-08-12T07:00:00.000Z'); assert.equal(result.lastFiveMinuteTimestamp.toISOString(), '2026-08-12T07:00:00.000Z');
});

// TEST-ONLY ACCEPTANCE GAP: an intraday fetch throwing (e.g. a network/API
// failure, not a soft "newest minute not yet published" gap) must fail closed
// to CURRENT_DAY_BACKFILL_FAILED, never a stale-looking or ready result, and
// must not blindly retry a hard failure the way the soft publication-lag path does.
test('GAP-4: an intraday backfill fetch throwing fails closed to CURRENT_DAY_BACKFILL_FAILED without retrying a hard failure', async () => {
  const target = new Target(); let calls = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => { calls += 1; throw new Error('UPSTOX_INTRADAY_FETCH_FAILED'); } }, { maxIntradayAttempts: 5 }).warmUp(at1240);
  assert.equal(result.ready, false);
  assert.equal(result.freshnessReason, 'CURRENT_DAY_BACKFILL_FAILED: UPSTOX_INTRADAY_FETCH_FAILED');
  assert.equal(calls, 1); // a hard fetch failure is not retried like a soft publication-lag gap
  assert.equal(result.intradayBackfillAttempts, 1);
  assert.equal(result.currentDayRowsReturned, 0);
});

// ---- A7-H4: NIFTY_INDEX source horizon (09:15-15:29 IST, 375 rows) semantics ----
// The authoritative NIFTY_INDEX 1-minute source horizon ends at 15:29 IST -- 375 candles,
// the same contract isCompleteHistoricalSession() enforces for a closed session
// (historical-session-completeness.util.ts). There is no NIFTY_INDEX candle at 15:30, let
// alone through 15:39: the underlying cash-market index simply stops publishing prints at
// 15:29, ten minutes before TradeMind's own, wholly independent, 15:40 operational
// EOD/grace boundary. An earlier version of this file wrongly clamped this function's
// canonical-close target to a fabricated 15:39 "candle"; these tests pin the corrected
// contract instead. Safety against an ordinary NEW post-close cold startup lives one layer
// up, in the runtime's own isLikelyMarketSession gate (src/tests/test-live-paper-trading.ts),
// which never calls warmUp() at all once the NSE session has closed -- this function's own
// contract is exclusively about what an already-active session's source-horizon recovery may
// still require, which is why it does not itself reject a reference time after 15:30.
const at1529_59 = new Date('2026-08-12T15:29:59+05:30');
const at1530_00 = new Date('2026-08-12T15:30:00+05:30');

test('A7-H4: 15:29:59 still treats 15:29 as forming -- expected completed 1m is 15:28', async () => {
  const target = new Target();
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 374).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(at1529_59);
  assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T09:58:00.000Z');
  assert.equal(result.ready, true);
});

test('A7-H4: exactly 15:30:00 (source horizon) expects completed 1m 15:29 -- the session\'s actual last candle, never the boundary minute itself', async () => {
  const target = new Target();
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 375).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(at1530_00);
  assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T09:59:00.000Z');
  assert.equal(result.ready, true);
  assert.equal(result.currentDaySource, 'INTRADAY');
});

test('A7-H4: 15:30 is never treated as a completed market-data minute, at any reference time at or after the source horizon -- including TradeMind\'s own 15:40 operational EOD', async () => {
  const target = new Target();
  for (const now of [at1530_00, new Date('2026-08-12T15:40:00+05:30'), new Date('2026-08-12T16:30:00+05:30')]) {
    const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 375).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(now);
    assert.notEqual(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T10:00:00.000Z', `${now.toISOString()}: 15:30 must never be the expected completed minute`);
    assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T09:59:00.000Z', `${now.toISOString()}: this recovery purpose's only meaningful target is 15:29, never a fabricated 15:30-15:39 candle`);
  }
});

test('A7-H4: source-horizon recovery retries a single newest-minute (15:29) publication lag, then succeeds', async () => {
  const target = new Target(); const behind = rows('2026-08-12', 374).map(dto); const current = rows('2026-08-12', 375).map(dto); let calls = 0; let waits = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => (++calls === 1 ? behind : current) }, { maxIntradayAttempts: 2, intradayRetryIntervalMs: 0, wait: async () => { waits += 1; } }).warmUp(at1530_00);
  assert.equal(result.ready, true); assert.equal(calls, 2); assert.equal(waits, 1);
  assert.equal(result.intradayRetryReason, 'NEWEST_COMPLETED_MINUTE_NOT_PUBLISHED');
  assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T09:59:00.000Z');
});

test('A7-H4: an incomplete 15:29 at the source horizon fails closed instead of silently completing the session', async () => {
  const target = new Target(); const behind = rows('2026-08-12', 374).map(dto); let calls = 0; let waits = 0;
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => { calls += 1; return behind; } }, { maxIntradayAttempts: 2, intradayRetryIntervalMs: 0, wait: async () => { waits += 1; } }).warmUp(at1530_00);
  assert.equal(result.ready, false); assert.equal(calls, 2); assert.equal(waits, 1);
  assert.equal(result.currentDayMissingMinuteCount, 1);
  assert.equal(result.intradayRetryReason, 'NEWEST_COMPLETED_MINUTE_NOT_PUBLISHED');
});

test('A7-H4: a late startup reference time after the source horizon does not become a valid completed session merely because warmup can read complete historical data', async () => {
  // "Complete" 375-row historical data existing does not, by itself, prove the strategy had a
  // genuine real-time evaluation opportunity for it -- see LivePaperStrategyAdapterService's
  // recoverHistoricalCandles(), which seeds indicator history without ever evaluating a signal
  // for recovered candles. This test only pins expectedNifty1mCompletedMinute's own contract:
  // a late reference time still resolves the source horizon correctly (15:29), it just never
  // authorizes trading on its own -- that guarantee lives in recoverHistoricalCandles/the live
  // candle builder's session-boundary gate, exercised directly in the coordinator's own tests.
  const target = new Target();
  const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, target, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 375).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(new Date('2026-08-12T18:00:00+05:30'));
  assert.equal(result.latestCompletedOneMinuteExpected?.toISOString(), '2026-08-12T09:59:00.000Z');
  assert.equal(result.ready, true);
});

test('fresh warm-up supplies current-day five-minute indicators to V2 and current-day one-minute regime/ATR state to V4', async () => {
  const originalVersion = process.env.TRADING_STRATEGY_VERSION; const originalPaperOnly = process.env.PAPER_TRADING_ONLY;
  process.env.TRADING_STRATEGY_VERSION = 'V2'; process.env.PAPER_TRADING_ONLY = 'true';
  try {
    const v2 = new LivePaperStrategyAdapterService({ createFromSignal: async () => ({ order: { id: 'unused' } } as never) });
    const result = await new LivePaperFreshWarmupService({ findByInstrumentAndTimeframe: async () => prior() }, v2, { fetchCurrentDayOneMinuteCandles: async () => rows('2026-08-12', 205).map(dto) }, { maxIntradayAttempts: 1 }).warmUp(at1240);
    assert.equal(result.ready, true); assert.equal(v2.isWarmupReady(), true); assert.equal(result.lastFiveMinuteTimestamp.toISOString(), '2026-08-12T07:05:00.000Z');
    const v4 = new V4NiftyMomentumShadowEvaluatorService(); v4.seedHistoricalOneMinute(result.seededOneMinuteCandles);
    const decision = v4.evaluateCompletedThreeMinute({ timestamp: new Date('2026-08-12T07:09:00.000Z'), open: 305, high: 306, low: 290, close: 292, volume: 3 });
    assert.notEqual(decision.rejectionReason, 'INSUFFICIENT_CURRENT_SESSION_COMPRESSION_HISTORY'); assert.notEqual(decision.atr, null);
  } finally {
    if (originalVersion === undefined) delete process.env.TRADING_STRATEGY_VERSION; else process.env.TRADING_STRATEGY_VERSION = originalVersion;
    if (originalPaperOnly === undefined) delete process.env.PAPER_TRADING_ONLY; else process.env.PAPER_TRADING_ONLY = originalPaperOnly;
  }
});
