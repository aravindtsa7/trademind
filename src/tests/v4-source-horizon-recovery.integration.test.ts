import assert from 'node:assert/strict';
import test from 'node:test';
import V4NiftyMomentumShadowEvaluatorService from '../modules/adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service';
import { Candle } from '../modules/indicators/types';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';
import { resolveSessionOutcome } from '../modules/research-validation';

const NIFTY = 'NSE_INDEX|Nifty 50';
const openAt = new Date('2026-08-24T09:15:00+05:30');
const closeAt = new Date('2026-08-24T15:40:00+05:30');

function sourceRows(): Candle[] {
  const rows: Candle[] = [];
  const start = new Date('2026-08-24T15:15:00+05:30').getTime();
  for (let index = 0; index < 15; index += 1) {
    const open = 100 + index;
    rows.push({ timestamp: new Date(start + index * 60_000), open, high: open + 3, low: open - 2, close: open + 1, volume: 10 + index });
  }
  return rows;
}

interface RecoveryData { rows: Candle[]; latestMinute: Date; }
interface EvaluatorFrames { oneMinute: Candle[]; threeMinute: Candle[]; fiveMinute: Candle[]; }

function harness(options: { ready?: boolean } = {}) {
  const allRows = sourceRows();
  const evaluator = new V4NiftyMomentumShadowEvaluatorService();
  evaluator.seedHistoricalOneMinute(allRows.slice(0, 6)); // authoritative warmup through 15:20
  const builder = new LiveCandleBuilderService();
  let now = new Date('2026-08-24T15:27:30+05:30').getTime();
  let deliveries = 0;
  let backfills = 0;
  let liveStarts = 0;
  let terminalizing = false;
  const requiredTargets: Date[] = [];
  const coordinator = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => now,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    liveConstructionAlignmentMinutes: 15,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async (target) => {
      backfills += 1;
      if (target) requiredTargets.push(new Date(target.getTime()));
      if (options.ready === false) return { ready: false, reason: 'SOURCE_HORIZON_INCOMPLETE', missingMinutes: 1, duplicateMinutes: 0 };
      return { ready: true, reason: 'FRESH', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { rows: allRows, latestMinute: allRows.at(-1)!.timestamp } };
    },
    onRecovered: (_generationId, data) => {
      if (data) {
        deliveries += 1;
        evaluator.recoverHistoricalOneMinute(data.rows);
        if (!terminalizing) liveStarts += 1;
      }
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => builder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });
  return {
    coordinator,
    evaluator,
    builder,
    setNow: (value: Date) => { now = value.getTime(); },
    beginTerminalization: () => { terminalizing = true; },
    getBackfills: () => backfills,
    getDeliveries: () => deliveries,
    getLiveStarts: () => liveStarts,
    getRequiredTargets: () => requiredTargets,
  };
}

test('A7-H5 V4 source close: 15:30 barrier reconstructs complete 3m/5m history exactly once without a post-15:29 tick or retroactive evaluation', async () => {
  const value = harness();
  value.coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  value.coordinator.handleReconnected({ generationId: 1 });

  const preBoundary3m = value.builder.processTick({ instrumentKey: NIFTY, timestamp: new Date('2026-08-24T15:29:30+05:30'), ltp: 120 }, '3m');
  const preBoundary5m = value.builder.processTick({ instrumentKey: NIFTY, timestamp: new Date('2026-08-24T15:29:31+05:30'), ltp: 120 }, '5m');
  assert.equal(preBoundary3m.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');
  assert.equal(preBoundary5m.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');

  // NIFTY emits no source candle after 15:29, so production EOD invokes the barrier without
  // manufacturing a post-horizon tick. Recovered history is seeded only; no evaluator call is made.
  value.beginTerminalization();
  value.setNow(new Date('2026-08-24T15:40:00+05:30'));
  const result = await value.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(value.getRequiredTargets()[0]?.toISOString(), new Date('2026-08-24T15:29:00+05:30').toISOString());
  assert.equal(value.getRequiredTargets().every((target) => target < new Date('2026-08-24T15:30:00+05:30')), true);
  assert.equal(value.getBackfills(), 1);
  assert.equal(value.getDeliveries(), 1);
  assert.equal(value.getLiveStarts(), 0, 'terminal recovery must not restart live candle delivery');

  const frames = value.evaluator as unknown as EvaluatorFrames;
  assert.deepEqual(frames.threeMinute.filter((row) => row.timestamp >= new Date('2026-08-24T15:15:00+05:30')).map((row) => row.timestamp.toISOString()),
    ['15:15', '15:18', '15:21', '15:24', '15:27'].map((time) => new Date(`2026-08-24T${time}:00+05:30`).toISOString()));
  assert.deepEqual(frames.fiveMinute.filter((row) => row.timestamp >= new Date('2026-08-24T15:15:00+05:30')).map((row) => row.timestamp.toISOString()),
    ['15:15', '15:20', '15:25'].map((time) => new Date(`2026-08-24T${time}:00+05:30`).toISOString()));

  const second = await value.coordinator.completePendingBoundaryReconciliation();
  assert.equal(second.outcome, 'RECOVERED');
  assert.equal(value.getBackfills(), 1);
  assert.equal(value.getDeliveries(), 1);
  value.coordinator.stop();
});

test('A7-H5 V4 source close: failed exact-target recovery produces INVALID_DATA, never VALID_COMPLETED', async () => {
  const value = harness({ ready: false });
  value.coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  value.coordinator.handleReconnected({ generationId: 1 });
  value.beginTerminalization();
  value.setNow(new Date('2026-08-24T15:40:00+05:30'));
  const result = await value.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  const outcome = resolveSessionOutcome({ reason: 'MARKET_EOD', invalidData: true });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
  assert.equal(value.getDeliveries(), 0);
  value.coordinator.stop();
});

test('A7-H5 V4 source close: disconnect before recovery starts remains NOT_RECOVERED and cannot become NONE_PENDING', async () => {
  const value = harness();
  value.coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  value.coordinator.handleReconnected({ generationId: 1 });
  value.coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  value.beginTerminalization();
  value.setNow(new Date('2026-08-24T15:40:00+05:30'));
  const result = await value.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(value.getBackfills(), 0);
  assert.equal(resolveSessionOutcome({ reason: 'MARKET_EOD', invalidData: true }).sessionCompleted, false);
});
