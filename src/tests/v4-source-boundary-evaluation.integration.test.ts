import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import V4NiftyMomentumShadowEvaluatorService, { v4MomentumShadowConfig } from '../modules/adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service';
import { SourceBoundaryEvaluationCoverageTracker } from '../modules/market-data/services/source-boundary-evaluation-coverage';
import { Candle } from '../modules/indicators/types';
import { resolveSessionOutcome } from '../modules/research-validation';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';

/**
 * A7-H6 production-composition regression for V4: proves the source-boundary completion
 * trigger delivers the final completed-3m opportunity (15:27, using the completed 15:25-15:29
 * 5m regime state) through evaluateCompletedThreeMinute() exactly once, complementing
 * v4-source-horizon-recovery.integration.test.ts (A7-H5), which deliberately proves the
 * opposite half: that generic recovery alone seeds history without ever evaluating.
 *
 * Mirrors that test's harness composition (real MarketDataRecoveryCoordinatorService,
 * LiveCandleBuilderService, V4NiftyMomentumShadowEvaluatorService), extended with
 * SourceBoundaryEvaluationCoverageTracker and a reproduction of
 * performSourceBoundaryEvaluation()'s essential logic from test-live-v4-nifty-momentum-shadow.ts.
 */

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

/**
 * Enough prior same-day 1m history (well past ATR14's and the 5m regime EMA35's warm-up
 * floors) for evaluateCompletedThreeMinute() to compute real indicators rather than throwing
 * an insufficient-history error. Contiguous through 15:14 (no gap) so it aggregates cleanly
 * against allRows.slice(0, 6), which starts at 15:15 -- the aggregator throws on any interior
 * (non-leading/non-trailing) incomplete bucket regardless of discard options.
 */
function priorWarmupRows(): Candle[] {
  const rows: Candle[] = [];
  const start = new Date('2026-08-24T11:00:00+05:30').getTime();
  const end = new Date('2026-08-24T15:14:00+05:30').getTime();
  for (let timestamp = start, index = 0; timestamp <= end; timestamp += 60_000, index += 1) {
    const open = 100 + Math.sin(index / 5) * 2;
    rows.push({ timestamp: new Date(timestamp), open, high: open + 3, low: open - 2, close: open + 1, volume: 10 });
  }
  return rows;
}

interface RecoveryData { rows: Candle[]; latestMinute: Date; }

function createHarness(options: { ready?: boolean } = {}) {
  const allRows = sourceRows();
  const evaluator = new V4NiftyMomentumShadowEvaluatorService();
  // authoritative warmup through 15:20, with enough prior same-day history for ATR14 to be ready.
  evaluator.seedHistoricalOneMinute([...priorWarmupRows(), ...allRows.slice(0, 6)]);
  const liveCandleBuilder = new LiveCandleBuilderService();
  const coverage = new SourceBoundaryEvaluationCoverageTracker('shadow:v4:momentum', 'V4_NIFTY_MOMENTUM_PE_SHADOW');
  let pendingSourceBoundaryCandle: Candle | undefined;
  let now = new Date('2026-08-24T15:27:30+05:30').getTime();
  let backfillCalls = 0;
  let evaluationCalls = 0;
  const backfillReady = options.ready ?? true;

  const isNiftyFinalSourceMinute = (candidate: Date | null | undefined): boolean =>
    candidate != null && candidate.getTime() === nifty1mSourceCompletionBoundary(candidate).getTime() - 60_000;

  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => now,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    liveConstructionAlignmentMinutes: 15,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async () => {
      backfillCalls += 1;
      if (!backfillReady) return { ready: false, reason: 'SOURCE_HORIZON_INCOMPLETE', missingMinutes: 1, duplicateMinutes: 0 };
      return { ready: true, reason: 'FRESH', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { rows: allRows, latestMinute: allRows.at(-1)!.timestamp } };
    },
    onRecovered: (_generationId, data) => {
      if (data) {
        const isTerminalRecovery = isNiftyFinalSourceMinute(data.latestMinute);
        const finalThreeMinuteBucketStart = isTerminalRecovery ? new Date(nifty1mSourceCompletionBoundary(data.latestMinute).getTime() - v4MomentumShadowConfig.timeframeMinutes * 60_000) : undefined;
        evaluator.recoverHistoricalOneMinute(data.rows, finalThreeMinuteBucketStart);
        if (finalThreeMinuteBucketStart) pendingSourceBoundaryCandle = evaluator.getReconstructedThreeMinuteBucket(finalThreeMinuteBucketStart);
      }
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });

  let eodStarted = false; let closing = false; let hostRunning = true; let currentGenerationId = 2;

  const performSourceBoundaryEvaluation = async (): Promise<void> => {
    if (eodStarted || closing) return;
    const generationId = currentGenerationId;
    const boundaryAt = nifty1mSourceCompletionBoundary(new Date(now));
    const finalBucketStart = new Date(boundaryAt.getTime() - v4MomentumShadowConfig.timeframeMinutes * 60_000);
    coverage.require(generationId, boundaryAt);

    let candle: Candle | undefined;
    const active = liveCandleBuilder.getActiveCandle(NIFTY, '3m');
    if (active && active.candleTime.getTime() === finalBucketStart.getTime()) {
      candle = { timestamp: new Date(active.candleTime.getTime()), open: active.open, high: active.high, low: active.low, close: active.close, volume: 0 };
      liveCandleBuilder.reset(NIFTY, '3m');
    } else {
      const result = await recovery.completePendingBoundaryReconciliation();
      if (eodStarted || closing || currentGenerationId !== generationId) { coverage.markLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_DURING_RECOVERY'); return; }
      if (result.outcome !== 'RECOVERED') { coverage.markLost(generationId, result.reason); return; }
      candle = pendingSourceBoundaryCandle;
      pendingSourceBoundaryCandle = undefined;
      if (!candle) { coverage.markLost(generationId, 'TERMINAL_CANDLE_NOT_RECONSTRUCTED'); return; }
    }

    if (eodStarted || closing || currentGenerationId !== generationId || !hostRunning) { coverage.markLost(generationId, 'TERMINALIZED_OR_HOST_NOT_RUNNING'); return; }
    try {
      evaluationCalls += 1;
      evaluator.evaluateCompletedThreeMinute(candle);
      coverage.markEvaluated(generationId, candle.timestamp, 'SOURCE_BOUNDARY_EVALUATION_COMPLETED');
    } catch (error) {
      coverage.markLost(generationId, error instanceof Error ? error.message : 'SOURCE_BOUNDARY_EVALUATION_FAILED');
    }
  };

  return {
    recovery, evaluator, liveCandleBuilder, coverage, performSourceBoundaryEvaluation,
    getBackfillCalls: () => backfillCalls,
    getEvaluationCalls: () => evaluationCalls,
    setNow: (date: Date): void => { now = date.getTime(); },
    beginTerminalization: (): void => { eodStarted = true; },
    disconnectGeneration: (): void => { currentGenerationId += 1; },
    getGenerationId: (): number => currentGenerationId,
  };
}

test('A7-H6 V4 happy path: source-boundary trigger reconstructs complete 3m/5m state and invokes the EXACT 15:27 completed-3m evaluation exactly once, using the final 15:25-15:29 5m regime state', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 0 });
  value.recovery.handleReconnected({ generationId: 1 });
  value.disconnectGeneration(); // keep the harness's own generation counter aligned with recovery's (starts at 2)

  value.setNow(new Date('2026-08-24T15:30:00+05:30'));
  await value.performSourceBoundaryEvaluation();

  assert.equal(value.getBackfillCalls(), 1);
  assert.equal(value.getEvaluationCalls(), 1, 'evaluateCompletedThreeMinute must run exactly once for the final source-boundary opportunity');
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'EVALUATED');
  assert.equal(value.coverage.getRecord()?.completedCandleTime?.toISOString(), new Date('2026-08-24T15:27:00+05:30').toISOString());

  // The final 15:25-15:29 5m regime bucket must have been seeded (unaffected by the 3m exclusion).
  const frames = value.evaluator as unknown as { fiveMinute: Candle[] };
  assert.equal(frames.fiveMinute.some((row) => row.timestamp.toISOString() === new Date('2026-08-24T15:25:00+05:30').toISOString()), true);

  // No retroactive evaluation at 15:40: a second call (mirroring finishEod's own barrier call)
  // must not re-run backfill or re-evaluate.
  value.beginTerminalization();
  const second = await value.recovery.completePendingBoundaryReconciliation();
  assert.equal(second.outcome, 'RECOVERED');
  assert.equal(value.getBackfillCalls(), 1);
  assert.equal(value.getEvaluationCalls(), 1);
});

test('A7-H6 V4 failure: recovery failure loses coverage and the session fails closed, never VALID_COMPLETED', async () => {
  const value = createHarness({ ready: false });
  value.recovery.handleUnexpectedDisconnect({ generationId: 0 });
  value.recovery.handleReconnected({ generationId: 1 });
  value.disconnectGeneration();
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));

  await value.performSourceBoundaryEvaluation();
  assert.equal(value.getEvaluationCalls(), 0);
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'LOST');

  const outcome = resolveSessionOutcome({ reason: 'VALID_COMPLETED', invalidData: !value.coverage.isSatisfiedFor(value.getGenerationId()) });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});

test('A7-H6 V4: source-boundary trigger never fires -- 15:40 terminal recovery seeds history only, never evaluates, and fails closed truthfully', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 0 });
  value.recovery.handleReconnected({ generationId: 1 });
  value.disconnectGeneration();
  value.beginTerminalization();
  value.setNow(new Date('2026-08-24T15:40:00+05:30'));

  const result = await value.recovery.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(value.getEvaluationCalls(), 0, 'terminal-only recovery must never evaluate the final 3m opportunity');

  value.coverage.require(value.getGenerationId(), new Date('2026-08-24T15:30:00+05:30'));
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), false);
  const outcome = resolveSessionOutcome({ reason: 'VALID_COMPLETED', invalidData: !value.coverage.isSatisfiedFor(value.getGenerationId()) });
  assert.equal(outcome.status, 'INVALID_DATA');
});
