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
