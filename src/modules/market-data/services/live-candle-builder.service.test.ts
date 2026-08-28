import assert from 'node:assert/strict';
import test from 'node:test';
import { NormalizedLiveTickDto } from '../dto/live-candle.dto';
import LiveCandleBuilderService from './live-candle-builder.service';

function ist(hour: number, minute: number, second = 0, day = 10): Date {
  return new Date(Date.UTC(2026, 7, day, hour, minute, second) - (5 * 60 + 30) * 60_000);
}

function tick(instrumentKey: string, hour: number, minute: number, ltp: number, second = 0, day = 10): NormalizedLiveTickDto {
  return { instrumentKey, timestamp: ist(hour, minute, second, day), ltp };
}

test('first tick creates an active 1m candle', () => {
  const builder = new LiveCandleBuilderService(); const result = builder.processTick(tick('NIFTY', 9, 15, 100), '1m');
  assert.equal(result.completedCandle, undefined); assert.equal(result.activeCandle?.open, 100); assert.equal(result.activeCandle?.completed, false);
});

test('multiple ticks update OHLC within a bucket', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 15, 100), '1m'); builder.processTick(tick('NIFTY', 9, 15, 110, 10), '1m'); const result = builder.processTick(tick('NIFTY', 9, 15, 90, 20), '1m');
  assert.deepEqual([result.activeCandle?.open, result.activeCandle?.high, result.activeCandle?.low, result.activeCandle?.close], [100, 110, 90, 90]);
});

test('a new 1m bucket finalizes the previous candle', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 15, 100), '1m'); const result = builder.processTick(tick('NIFTY', 9, 16, 105), '1m');
  assert.equal(result.completedCandle?.completed, true); assert.equal(result.completedCandle?.candleTime.getTime(), ist(9, 15).getTime()); assert.equal(result.activeCandle?.candleTime.getTime(), ist(9, 16).getTime());
});

test('anchors five-minute candles to 09:15 IST rather than first tick', () => {
  const builder = new LiveCandleBuilderService(); const result = builder.processTick(tick('NIFTY', 9, 17, 100), '5m');
  assert.equal(result.activeCandle?.candleTime.getTime(), ist(9, 15).getTime());
});

test('uses the 09:19 to 09:20 five-minute boundary', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 19, 100), '5m'); const result = builder.processTick(tick('NIFTY', 9, 20, 101), '5m');
  assert.equal(result.completedCandle?.candleTime.getTime(), ist(9, 15).getTime()); assert.equal(result.activeCandle?.candleTime.getTime(), ist(9, 20).getTime());
});

test('keeps different instruments isolated', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 15, 100), '1m'); const result = builder.processTick(tick('BANKNIFTY', 9, 15, 200), '1m');
  assert.equal(result.completedCandle, undefined); assert.equal(builder.getActiveCandle('NIFTY', '1m')?.close, 100); assert.equal(builder.getActiveCandle('BANKNIFTY', '1m')?.close, 200);
});

test('never aggregates across trading dates', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 15, 29, 100, 0, 10), '5m'); const result = builder.processTick(tick('NIFTY', 9, 15, 200, 0, 11), '5m');
  assert.equal(result.completedCandle?.close, 100); assert.equal(result.completedCandle?.candleTime.getTime(), ist(15, 25, 0, 10).getTime()); assert.equal(result.activeCandle?.candleTime.getTime(), ist(9, 15, 0, 11).getTime());
});

test('ignores a duplicate tick timestamp without changing OHLC', () => {
  const builder = new LiveCandleBuilderService(); const first = tick('NIFTY', 9, 15, 100); builder.processTick(first, '1m'); const result = builder.processTick({ ...first, ltp: 200 }, '1m');
  assert.equal(result.ignoreReason, 'DUPLICATE_TICK'); assert.equal(builder.getActiveCandle('NIFTY', '1m')?.close, 100);
});

test('ignores out-of-order ticks without rewriting active or completed candles', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 16, 100), '1m'); const result = builder.processTick(tick('NIFTY', 9, 15, 200), '1m');
  assert.equal(result.ignoreReason, 'OUT_OF_ORDER_TICK'); assert.equal(builder.getActiveCandle('NIFTY', '1m')?.candleTime.getTime(), ist(9, 16).getTime());
});

test('uses the shared 09:15-15:40 IST derivatives boundary for live candle acceptance', () => {
  const builder = new LiveCandleBuilderService(); const before = builder.processTick(tick('NIFTY', 9, 14, 100), '1m'); const within = builder.processTick(tick('NIFTY', 15, 39, 100), '1m'); const after = builder.processTick(tick('NIFTY', 15, 40, 101), '1m');
  assert.equal(before.ignoreReason, 'OUTSIDE_MARKET_SESSION'); assert.equal(within.ignored, false); assert.equal(after.ignoreReason, 'OUTSIDE_MARKET_SESSION');
});

test('active candles are never reported as completed', () => {
  const builder = new LiveCandleBuilderService(); builder.processTick(tick('NIFTY', 9, 15, 100), '5m');
  assert.equal(builder.getActiveCandle('NIFTY', '5m')?.completed, false);
});

test('does not mutate tick input or returned active snapshots', () => {
  const builder = new LiveCandleBuilderService(); const input = tick('NIFTY', 9, 15, 100); const original = structuredClone(input); const result = builder.processTick(input, '1m');
  result.activeCandle?.candleTime.setTime(0); assert.deepEqual(input, original); assert.equal(builder.getActiveCandle('NIFTY', '1m')?.candleTime.getTime(), ist(9, 15).getTime());
});

// ---- A7-H2: live construction boundary (mid-bucket connect/reconnect protection) ----

test('A7-H2: a tick whose bucket starts before the live construction boundary is ignored and never seeds an active candle, on every timeframe', () => {
  const builder = new LiveCandleBuilderService();
  builder.setLiveConstructionBoundary('NIFTY', ist(9, 21).getTime()); // mid-connect at 09:20:xx -> boundary is 09:21
  const oneMinute = builder.processTick(tick('NIFTY', 9, 20, 100), '1m');
  const fiveMinute = builder.processTick(tick('NIFTY', 9, 20, 100), '5m');
  assert.equal(oneMinute.ignored, true); assert.equal(oneMinute.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY'); assert.equal(oneMinute.activeCandle, undefined);
  assert.equal(fiveMinute.ignored, true); assert.equal(fiveMinute.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');
  assert.equal(builder.getActiveCandle('NIFTY', '1m'), undefined);
  assert.equal(builder.getActiveCandle('NIFTY', '5m'), undefined);
});

test('A7-H2: a partial bucket suppressed by the boundary can never later be reported as completed once a clean tick arrives', () => {
  const builder = new LiveCandleBuilderService();
  builder.setLiveConstructionBoundary('NIFTY', ist(9, 21).getTime());
  builder.processTick(tick('NIFTY', 9, 20, 30), '1m'); // pre-boundary -- suppressed
  const clean = builder.processTick(tick('NIFTY', 9, 21, 100), '1m'); // exactly at the boundary -- clean
  assert.equal(clean.ignored, false);
  assert.equal(clean.completedCandle, undefined, 'no partial 09:20 candle may ever be emitted as completed');
  assert.equal(clean.activeCandle?.candleTime.getTime(), ist(9, 21).getTime());
  assert.equal(clean.activeCandle?.open, 100, 'the clean active candle must not have absorbed the suppressed pre-boundary tick');
  const rollover = builder.processTick(tick('NIFTY', 9, 22, 105), '1m');
  assert.equal(rollover.completedCandle?.candleTime.getTime(), ist(9, 21).getTime());
  assert.equal(rollover.completedCandle?.open, 100, 'the completed candle reflects only clean, post-boundary ticks');
});

test('A7-H2: ticks at or after the boundary build normally', () => {
  const builder = new LiveCandleBuilderService();
  builder.setLiveConstructionBoundary('NIFTY', ist(9, 21).getTime());
  const result = builder.processTick(tick('NIFTY', 9, 21, 100), '1m'); // exactly on the boundary
  assert.equal(result.ignored, false); assert.equal(result.activeCandle?.candleTime.getTime(), ist(9, 21).getTime());
});

test('A7-H2: the boundary is scoped per instrument and does not gate an unrelated instrument', () => {
  const builder = new LiveCandleBuilderService();
  builder.setLiveConstructionBoundary('NIFTY', ist(9, 21).getTime());
  const other = builder.processTick(tick('BANKNIFTY', 9, 20, 100), '1m');
  assert.equal(other.ignored, false);
});

test('A7-H2: reset() does not implicitly clear a live construction boundary -- a stale, more-restrictive boundary is safe; silently reopening it is not', () => {
  const builder = new LiveCandleBuilderService();
  builder.setLiveConstructionBoundary('NIFTY', ist(9, 21).getTime());
  builder.reset('NIFTY');
  const result = builder.processTick(tick('NIFTY', 9, 20, 100), '1m');
  assert.equal(result.ignored, true); assert.equal(result.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');
});

test('A7-H2: without a configured boundary, behavior is unchanged (no gating)', () => {
  const builder = new LiveCandleBuilderService();
  const result = builder.processTick(tick('NIFTY', 9, 20, 100), '1m');
  assert.equal(result.ignored, false);
});

test('A7-H2-R3: a no-safe-handoff session block cannot emit a partial pre-close strategy bucket', () => {
  const builder = new LiveCandleBuilderService();
  builder.blockLiveConstructionForSession('NIFTY', ist(15, 40).getTime());
  for (const timeframe of ['1m', '2m', '3m', '5m'] as const) {
    const result = builder.processTick(tick('NIFTY', 15, 39, 100), timeframe);
    assert.equal(result.ignored, true, timeframe);
    assert.equal(result.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY', timeframe);
    assert.equal(builder.getActiveCandle('NIFTY', timeframe), undefined, timeframe);
  }
  assert.equal(builder.finishSession('NIFTY').length, 0, 'no suppressed partial bucket can be flushed at EOD');
});

// ---- Post-close candle gating: NIFTY_INDEX 15:30 IST source-completion boundary ----
// Distinct from the 09:15-15:40 operational session boundary above (unchanged): the NIFTY_INDEX
// underlying source itself stops publishing new 1-minute prints at 15:30 IST, well before the
// wider 15:40 operational close. A tick at/after that instrument-scoped boundary must never
// contribute its LTP to OHLC or open a new active candle, but still finalizes -- exactly once --
// any already-active candle whose own bucket lies entirely within the horizon, and discards
// (never completes) one that doesn't.

test('SOURCE-BOUNDARY-A: a tick strictly before the source-completion boundary is accepted and builds normally', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  const result = builder.processTick(tick('NIFTY', 15, 29, 100, 59), '1m');
  assert.equal(result.ignored, false);
});

test('SOURCE-BOUNDARY-C: a >=15:30 tick finalizes an active 1m 15:29 candle exactly once, using only its accumulated OHLC', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 29, 100), '1m');
  builder.processTick(tick('NIFTY', 15, 29, 105, 30), '1m');
  const boundaryTick = builder.processTick(tick('NIFTY', 15, 30, 9_999), '1m');
  assert.equal(boundaryTick.ignored, true);
  assert.equal(boundaryTick.ignoreReason, 'AFTER_SOURCE_COMPLETION_BOUNDARY');
  assert.equal(boundaryTick.completedCandle?.candleTime.getTime(), ist(15, 29).getTime());
  assert.equal(boundaryTick.completedCandle?.close, 105, 'the fabricated post-boundary LTP must never enter OHLC');
  assert.equal(boundaryTick.completedCandle?.high, 105);
  assert.equal(builder.getActiveCandle('NIFTY', '1m'), undefined, 'no candle may remain open at/after the boundary');
});

test('SOURCE-BOUNDARY-D: a >=15:30 tick finalizes an active 3m 15:27 candle exactly once', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 27, 200), '3m');
  builder.processTick(tick('NIFTY', 15, 29, 210, 30), '3m');
  const boundaryTick = builder.processTick(tick('NIFTY', 15, 30, 1), '3m');
  assert.equal(boundaryTick.completedCandle?.candleTime.getTime(), ist(15, 27).getTime());
  assert.equal(boundaryTick.completedCandle?.close, 210);
  assert.equal(builder.getActiveCandle('NIFTY', '3m'), undefined);
});

test('SOURCE-BOUNDARY-E: a >=15:30 tick finalizes an active 5m 15:25 candle exactly once', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 25, 300), '5m');
  builder.processTick(tick('NIFTY', 15, 29, 310, 30), '5m');
  const boundaryTick = builder.processTick(tick('NIFTY', 15, 30, 2), '5m');
  assert.equal(boundaryTick.completedCandle?.candleTime.getTime(), ist(15, 25).getTime());
  assert.equal(boundaryTick.completedCandle?.close, 310);
  assert.equal(builder.getActiveCandle('NIFTY', '5m'), undefined);
});

test('SOURCE-BOUNDARY-F: a >=15:30 tick discards (never completes) the 2m 15:29 partial tail -- its bucket would need a source minute that never exists', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 27, 400), '2m');
  const rollover = builder.processTick(tick('NIFTY', 15, 29, 410), '2m');
  assert.equal(rollover.completedCandle?.candleTime.getTime(), ist(15, 27).getTime(), 'the prior 15:27-15:28 bucket completes normally, in-session');
  assert.equal(builder.getActiveCandle('NIFTY', '2m')?.candleTime.getTime(), ist(15, 29).getTime());
  const boundaryTick = builder.processTick(tick('NIFTY', 15, 30, 99_999), '2m');
  assert.equal(boundaryTick.ignored, true);
  assert.equal(boundaryTick.ignoreReason, 'AFTER_SOURCE_COMPLETION_BOUNDARY');
  assert.equal(boundaryTick.completedCandle, undefined, 'the 15:29 2m tail must never be fabricated as completed');
  assert.equal(builder.getActiveCandle('NIFTY', '2m'), undefined, 'the discarded tail must not remain open');
});

test('SOURCE-BOUNDARY-G: repeated post-boundary ticks never open a new active candle, on any timeframe', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  for (const timeframe of ['1m', '2m', '3m', '5m'] as const) {
    for (let minute = 30; minute <= 39; minute += 1) {
      builder.processTick(tick('NIFTY', 15, minute, 100 + minute), timeframe);
    }
    assert.equal(builder.getActiveCandle('NIFTY', timeframe), undefined, timeframe);
  }
});

test('SOURCE-BOUNDARY-H: repeated 15:30-15:39 ticks produce no additional completed candles after the boundary trigger', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 29, 500), '1m');
  const first = builder.processTick(tick('NIFTY', 15, 30, 501), '1m');
  assert.equal(first.completedCandle?.candleTime.getTime(), ist(15, 29).getTime());
  for (let minute = 31; minute <= 39; minute += 1) {
    const result = builder.processTick(tick('NIFTY', 15, minute, 999), '1m');
    assert.equal(result.completedCandle, undefined, `minute ${minute}`);
  }
});

test('SOURCE-BOUNDARY-I: an extreme boundary-tick LTP never enters the finalized candle open/high/low/close', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 29, 100), '1m');
  builder.processTick(tick('NIFTY', 15, 29, 95, 20), '1m');
  builder.processTick(tick('NIFTY', 15, 29, 105, 40), '1m');
  const boundaryTick = builder.processTick(tick('NIFTY', 15, 30, 1_000_000), '1m');
  assert.deepEqual(
    [boundaryTick.completedCandle?.open, boundaryTick.completedCandle?.high, boundaryTick.completedCandle?.low, boundaryTick.completedCandle?.close],
    [100, 105, 95, 105],
  );
});

test('SOURCE-BOUNDARY-J: with no post-close tick ever arriving, finishSession flushes valid 1m/3m/5m tails but discards the partial 2m tail', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 29, 100), '1m');
  builder.processTick(tick('NIFTY', 15, 27, 200), '3m');
  builder.processTick(tick('NIFTY', 15, 25, 300), '5m');
  builder.processTick(tick('NIFTY', 15, 27, 400), '2m');
  builder.processTick(tick('NIFTY', 15, 29, 410), '2m'); // rolls into the 15:29 partial tail bucket
  const completed = builder.finishSession('NIFTY');
  assert.equal(completed.find((candle) => candle.timeframe === '1m')?.candleTime.getTime(), ist(15, 29).getTime());
  assert.equal(completed.find((candle) => candle.timeframe === '3m')?.candleTime.getTime(), ist(15, 27).getTime());
  assert.equal(completed.find((candle) => candle.timeframe === '5m')?.candleTime.getTime(), ist(15, 25).getTime());
  assert.equal(completed.find((candle) => candle.timeframe === '2m'), undefined, 'the 15:29 2m tail must never be flushed at EOD');
  assert.equal(builder.getActiveCandle('NIFTY', '2m'), undefined);
});

test('SOURCE-BOUNDARY-K: finishSession remains idempotent once a source-completion boundary is configured', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY', 15, 29, 100), '1m');
  builder.processTick(tick('NIFTY', 15, 29, 410), '2m');
  const first = builder.finishSession('NIFTY');
  const second = builder.finishSession('NIFTY');
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('SOURCE-BOUNDARY-O: an instrument with no registered boundary is unaffected -- ticks past 15:30 continue building normally (e.g. an option contract)', () => {
  const builder = new LiveCandleBuilderService();
  builder.setSourceCompletionBoundary('NIFTY', ist(15, 30).getTime());
  builder.processTick(tick('NIFTY_CE_OPTION', 15, 29, 100), '1m');
  const result = builder.processTick(tick('NIFTY_CE_OPTION', 15, 30, 105), '1m');
  assert.equal(result.ignored, false);
  assert.equal(result.completedCandle?.close, 100);
  assert.equal(builder.getActiveCandle('NIFTY_CE_OPTION', '1m')?.candleTime.getTime(), ist(15, 30).getTime());
  assert.equal(builder.getActiveCandle('NIFTY_CE_OPTION', '1m')?.open, 105);
});
