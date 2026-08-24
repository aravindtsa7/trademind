import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { Candle } from '../modules/indicators/types';
import { resolveSessionOutcome } from '../modules/research-validation';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';

/**
 * A7-H4 production-composition regression: a V2 (5-minute-aligned) reconnect that lands its
 * live-construction handoff boundary at 15:30 IST -- the authoritative NIFTY_INDEX 1-minute
 * source horizon (09:15-15:29 IST), which is independent of, and ten minutes before,
 * TradeMind's own 15:40 operational EOD/grace boundary. There is no NIFTY_INDEX candle at
 * 15:30 or later; the final genuine V2 5m source bucket for this scenario is 15:25-15:29.
 *
 * Drives the REAL MarketDataRecoveryCoordinatorService, the REAL LiveCandleBuilderService, and
 * the REAL CandleTimeframeAggregatorService together -- the same composition
 * src/tests/test-live-paper-trading.ts wires in production -- rather than a coordinator-only
 * mock. Supersedes the earlier v2-canonical-close-recovery.integration.test.ts, which wrongly
 * fabricated a 15:35-15:39 NIFTY_INDEX 5m candle that the authoritative source contract does
 * not support.
 */

const NIFTY = 'NSE_INDEX|Nifty 50';
const openAt = new Date('2026-08-24T09:15:00+05:30');
const closeAt = new Date('2026-08-24T15:40:00+05:30');

interface RecoveryData { rows: Candle[]; latestMinute: Date; }

function oneMinuteRows(): Candle[] {
  return [
    { timestamp: new Date('2026-08-24T15:25:00+05:30'), open: 100, high: 105, low: 99, close: 102, volume: 10 },
    { timestamp: new Date('2026-08-24T15:26:00+05:30'), open: 102, high: 106, low: 101, close: 104, volume: 10 },
    { timestamp: new Date('2026-08-24T15:27:00+05:30'), open: 104, high: 108, low: 103, close: 107, volume: 10 },
    { timestamp: new Date('2026-08-24T15:28:00+05:30'), open: 107, high: 107, low: 95, close: 106, volume: 10 },
    { timestamp: new Date('2026-08-24T15:29:00+05:30'), open: 106, high: 110, low: 104, close: 109, volume: 10 },
  ];
}

function createHarness(options: { backfillReady?: boolean } = {}) {
  const liveCandleBuilder = new LiveCandleBuilderService();
  const reconstructedCandles: Candle[] = [];
  let backfillCalls = 0;
  let nowMs = new Date('2026-08-24T15:27:30+05:30').getTime();
  const backfillReady = options.backfillReady ?? true;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => nowMs,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    // Warmup only covers up to 15:20 -- the reconnect must prove REST coverage through 15:29
    // before any live construction at/after the 15:30 handoff boundary is permitted.
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async () => {
      backfillCalls += 1;
      if (!backfillReady) return { ready: false, reason: 'STALE_CURRENT_DAY_HISTORY', missingMinutes: 1, duplicateMinutes: 0 };
      const rows = oneMinuteRows();
      return { ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { rows, latestMinute: rows.at(-1)!.timestamp } };
    },
    onRecovered: (_generationId, data) => {
      if (!data) return undefined;
      const completed = new CandleTimeframeAggregatorService().aggregate(data.rows, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
      completed.forEach((candle) => reconstructedCandles.push(candle));
      liveCandleBuilder.reset(NIFTY);
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });
  return {
    recovery,
    liveCandleBuilder,
    reconstructedCandles,
    getBackfillCalls: () => backfillCalls,
    setNow: (date: Date): void => { nowMs = date.getTime(); },
  };
}

test('A7-H4: recovery becomes due and reconstructs the complete 15:25-15:29 5m candle exactly once, even though NIFTY_INDEX stops ticking before the 15:30 boundary is ever reached by a live tick', async () => {
  const harness = createHarness();

  // Reconnect at 15:27:30 -- establishes boundary=15:30, required completed minute=15:29.
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  harness.recovery.handleReconnected({ generationId: 2 });
  assert.equal(harness.recovery.getState(), 'CONNECTED');

  // A live tick inside the still-pending 15:25 bucket (before the 15:30 boundary) must never
  // build or complete a partial live candle for it.
  const preBoundary = harness.liveCandleBuilder.processTick({ instrumentKey: NIFTY, timestamp: new Date('2026-08-24T15:28:10+05:30'), ltp: 123 }, '5m');
  assert.equal(preBoundary.ignored, true);
  assert.equal(preBoundary.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');

  // NIFTY_INDEX genuinely stops publishing after the source horizon -- no live tick with
  // receivedAt >= 15:30 will ever arrive to trigger recovery.handleLiveTick(). Simulate that
  // exactly: advance wall clock to (and past) the boundary without ever calling handleLiveTick.
  harness.setNow(new Date('2026-08-24T15:40:00+05:30'));
  assert.equal(harness.recovery.getState(), 'CONNECTED', 'nothing has triggered the due boundary yet');

  const result = await harness.recovery.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(harness.getBackfillCalls(), 1);
  assert.equal(harness.recovery.getState(), 'WAITING_FOR_FRESH_TICK', 'a terminally safe, non-faulted state -- no more live ticks are expected once NIFTY_INDEX has stopped');

  assert.equal(harness.reconstructedCandles.length, 1, 'the final bar is reconstructed exactly once');
  const bar = harness.reconstructedCandles[0];
  assert.equal(bar.timestamp.toISOString(), new Date('2026-08-24T15:25:00+05:30').toISOString());
  assert.equal(bar.open, 100); assert.equal(bar.high, 110); assert.equal(bar.low, 95); assert.equal(bar.close, 109);

  // Calling the barrier again (mirroring a defensive double-call) must not re-run backfill or
  // duplicate the reconstructed candle.
  const second = await harness.recovery.completePendingBoundaryReconciliation();
  assert.equal(second.outcome, 'RECOVERED');
  assert.equal(harness.getBackfillCalls(), 1);
  assert.equal(harness.reconstructedCandles.length, 1);

  // No 15:40+ candle may ever be evaluated: the live candle builder itself enforces
  // TradeMind's own operational session boundary, independent of the source horizon.
  const postClose = harness.liveCandleBuilder.processTick({ instrumentKey: NIFTY, timestamp: new Date('2026-08-24T15:40:05+05:30'), ltp: 111 }, '5m');
  assert.equal(postClose.ignored, true);
  assert.equal(postClose.ignoreReason, 'OUTSIDE_MARKET_SESSION');

  // Only now -- after the barrier has resolved -- may EOD safely call stop().
  harness.recovery.stop();
  assert.equal(harness.recovery.getState(), 'STOPPED');

  // This is exactly the routing test-live-paper-trading.ts's performDurableEodExit() uses:
  // a successful source-horizon recovery permits the existing legitimate completed-session path.
  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE' });
  assert.equal(outcome.status, 'VALID_COMPLETED');
  assert.equal(outcome.sessionCompleted, true);
});

test('A7-H4: a failed source-horizon recovery fails closed -- no VALID_COMPLETED, sessionCompleted=false -- and is never discarded by stop()', async () => {
  const harness = createHarness({ backfillReady: false });
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  harness.recovery.handleReconnected({ generationId: 2 });
  harness.setNow(new Date('2026-08-24T15:40:00+05:30'));

  const result = await harness.recovery.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(harness.reconstructedCandles.length, 0, 'no 5m candle may be published from an incomplete recovery');

  // This is exactly the routing test-live-paper-trading.ts's performDurableEodExit() uses:
  // a failed source-horizon recovery must route through the existing INVALID_DATA fail-closed
  // outcome, never VALID_COMPLETED, even though the trigger was the canonical EOD close.
  const outcome = resolveSessionOutcome({ reason: 'INVALID_DATA' });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);

  harness.recovery.stop();
  assert.equal(harness.recovery.isEvaluationReady(), false, 'a failed source-horizon recovery can never become READY, whatever stop() does to the state label afterward');
});

test('A7-H4: stop() called before the barrier silently discards an unresolved recovery -- the regression this barrier exists to prevent', async () => {
  const harness = createHarness();
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  harness.recovery.handleReconnected({ generationId: 2 });
  harness.setNow(new Date('2026-08-24T15:40:00+05:30'));

  // The pre-fix production bug: EOD called recovery.stop() directly, without ever awaiting
  // completePendingBoundaryReconciliation() first.
  harness.recovery.stop();
  assert.equal(harness.recovery.getState(), 'STOPPED');
  assert.equal(harness.getBackfillCalls(), 0, 'the pending reconciliation was silently discarded, never attempted');
  assert.equal(harness.reconstructedCandles.length, 0, 'the final 15:25-15:29 bar was never reconstructed -- exactly the defect this barrier fixes');
});

test('A7-H4: a reconnect landing at/after 15:30 has no safe same-session handoff -- the source horizon is already gone, so recovery must fail closed rather than wait for a boundary that can never be proven', () => {
  const liveCandleBuilder = new LiveCandleBuilderService();
  const blockedThrough: Date[] = [];
  const handoffs: Date[] = [];
  let backfillCalls = 0;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => new Date('2026-08-24T15:30:00+05:30').getTime(),
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async () => { backfillCalls += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { rows: [], latestMinute: new Date() } }; },
    onLiveConstructionBoundary: (boundary) => handoffs.push(boundary),
    onLiveConstructionUnavailable: (close) => { blockedThrough.push(close); liveCandleBuilder.blockLiveConstructionForSession(NIFTY, close.getTime()); },
  });
  recovery.handleUnexpectedDisconnect({ generationId: 1 });
  recovery.handleReconnected({ generationId: 2 });
  assert.equal(recovery.getState(), 'FAULTED');
  assert.equal(handoffs.length, 0, 'the next aligned boundary (15:35, requiring REST through 15:34) is beyond the source horizon and must never be published');
  assert.equal(blockedThrough[0]?.toISOString(), closeAt.toISOString());
  assert.equal(backfillCalls, 0, 'no REST call may ever request a NIFTY 1m minute beyond 15:29');
});

test('A7-H5 V2: disconnect before the 15:30 recovery starts preserves the unresolved obligation and forces INVALID_DATA', async () => {
  const harness = createHarness();
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  harness.recovery.handleReconnected({ generationId: 2 });
  harness.recovery.handleUnexpectedDisconnect({ generationId: 2 });
  harness.setNow(new Date('2026-08-24T15:40:00+05:30'));

  const result = await harness.recovery.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(result.reason, 'REQUIRED_RECOVERY_INVALIDATED_BY_DISCONNECT');
  assert.equal(harness.getBackfillCalls(), 0);
  assert.equal(harness.reconstructedCandles.length, 0);

  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE', invalidData: true });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});
