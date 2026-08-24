import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { SourceBoundaryEvaluationCoverageTracker } from '../modules/market-data/services/source-boundary-evaluation-coverage';
import LivePaperStrategyAdapterService from '../modules/paper-trading/services/live-paper-strategy-adapter.service';
import { LivePaperOrchestrator } from '../modules/paper-trading/dto/live-paper-strategy.dto';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { resolveSessionOutcome } from '../modules/research-validation';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';

/**
 * A7-H6 production-composition regression: proves the SOURCE-BOUNDARY COMPLETION TRIGGER --
 * the piece that fills the gap A7-H4/H5 deliberately left open (REST recovery reconstructs the
 * final 15:25-15:29 5m bar but never evaluates it) -- delivers that bar through V2's actual
 * actionable processCompletedCandle() path exactly once, and that a lost/never-run trigger
 * correctly fails the session closed rather than silently completing it.
 *
 * Drives the REAL MarketDataRecoveryCoordinatorService, LiveCandleBuilderService,
 * CandleTimeframeAggregatorService, LivePaperStrategyAdapterService, and
 * SourceBoundaryEvaluationCoverageTracker -- the same classes test-live-paper-trading.ts wires
 * in production. The harness below reproduces performSourceBoundaryEvaluation()'s and
 * applyRecoveredHistoricalCandles()'s essential logic exactly as implemented there, mirroring
 * the existing v2-source-horizon-recovery.integration.test.ts (A7-H4) convention of composing
 * real production services rather than importing the live entrypoint script directly.
 */

const NIFTY = 'NSE_INDEX|Nifty 50';
const openAt = new Date('2026-08-24T09:15:00+05:30');
const closeAt = new Date('2026-08-24T15:40:00+05:30');
const alignmentMinutes = 5;

interface RecoveryData { rows: Candle[]; latestMinute: Date; }

function oneMinuteRows(): Candle[] {
  const rows: Candle[] = [];
  const start = new Date('2026-08-24T15:15:00+05:30').getTime();
  for (let index = 0; index < 15; index += 1) {
    const open = 100 + index;
    rows.push({ timestamp: new Date(start + index * 60_000), open, high: open + 3, low: open - 2, close: open + 1, volume: 10 + index });
  }
  return rows;
}

class EngineStub {
  calculate(candles: readonly Candle[]): IndicatorEngineResult {
    const previous = candles[candles.length - 2]; const current = candles[candles.length - 1];
    return {
      indicators: [
        { config: { type: IndicatorType.EMA, period: 15 }, result: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 11 }] } },
        { config: { type: IndicatorType.EMA, period: 35 }, result: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 10 }] } },
        { config: { type: IndicatorType.RSI, period: 14 }, result: { type: IndicatorType.RSI, period: 14, values: [{ timestamp: current.timestamp, value: 50 }] } },
      ],
    } as IndicatorEngineResult;
  }
}
class CrossStub { evaluate() { return { signal: StrategySignal.NO_TRADE, confidence: 0, reasons: ['no crossover'] }; } }
class OrchestratorSpy implements LivePaperOrchestrator {
  calls = 0;
  async createFromSignal(): ReturnType<LivePaperOrchestrator['createFromSignal']> { this.calls += 1; return { order: { id: `order-${this.calls}` } } as Awaited<ReturnType<LivePaperOrchestrator['createFromSignal']>>; }
}

function createHarness(options: { backfillReady?: boolean; withPriorHistory?: boolean } = {}) {
  const liveCandleBuilder = new LiveCandleBuilderService();
  const orchestrator = new OrchestratorSpy();
  const strategyAdapter = new LivePaperStrategyAdapterService(orchestrator, new EngineStub(), new CrossStub());
  const coverage = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  let pendingSourceBoundaryCandle: Candle | undefined;
  let backfillCalls = 0;
  let evaluationCalls = 0;
  let now = new Date('2026-08-24T15:27:30+05:30').getTime();
  const backfillReady = options.backfillReady ?? true;

  if (options.withPriorHistory !== false) {
    // Enough warm-up history for LivePaperStrategyAdapterService's minimumHistory gate (36).
    for (let index = 40; index > 0; index -= 1) {
      const timestamp = new Date(new Date('2026-08-24T15:15:00+05:30').getTime() - index * 5 * 60_000);
      strategyAdapter.recoverHistoricalCandles([{ timestamp, open: 100, high: 105, low: 99, close: 102, volume: 1 }]);
    }
  }

  const isNiftyFinalSourceMinute = (candidate: Date | null | undefined): boolean =>
    candidate != null && candidate.getTime() === nifty1mSourceCompletionBoundary(candidate).getTime() - 60_000;

  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => now,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    liveConstructionAlignmentMinutes: alignmentMinutes,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
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
      const isTerminalRecovery = isNiftyFinalSourceMinute(data.latestMinute);
      const toSeed = isTerminalRecovery && completed.length > 0 ? completed.slice(0, -1) : completed;
      strategyAdapter.recoverHistoricalCandles(toSeed);
      if (isTerminalRecovery && completed.length > 0) pendingSourceBoundaryCandle = completed.at(-1);
      liveCandleBuilder.reset(NIFTY);
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });

  let shuttingDown = false; let eodRequested = false; let hostRunning = true;
  let currentGenerationId = 1;

  const performSourceBoundaryEvaluation = async (): Promise<void> => {
    if (shuttingDown || eodRequested) return;
    const generationId = currentGenerationId;
    const boundaryAt = nifty1mSourceCompletionBoundary(new Date(now));
    const finalBucketStart = new Date(boundaryAt.getTime() - alignmentMinutes * 60_000);
    coverage.require(generationId, boundaryAt);

    let candle: Candle | undefined;
    const active = liveCandleBuilder.getActiveCandle(NIFTY, '5m');
    if (active && active.candleTime.getTime() === finalBucketStart.getTime()) {
      candle = { timestamp: new Date(active.candleTime.getTime()), open: active.open, high: active.high, low: active.low, close: active.close, volume: 0 };
      liveCandleBuilder.reset(NIFTY, '5m');
    } else {
      const result = await recovery.completePendingBoundaryReconciliation();
      if (shuttingDown || eodRequested || currentGenerationId !== generationId) { coverage.markLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_DURING_RECOVERY'); return; }
      if (result.outcome !== 'RECOVERED') { coverage.markLost(generationId, result.reason); return; }
      candle = pendingSourceBoundaryCandle;
      pendingSourceBoundaryCandle = undefined;
      if (!candle) { coverage.markLost(generationId, 'TERMINAL_CANDLE_NOT_RECONSTRUCTED'); return; }
    }

    if (shuttingDown || eodRequested || currentGenerationId !== generationId || !hostRunning) { coverage.markLost(generationId, 'TERMINALIZED_OR_HOST_NOT_RUNNING'); return; }
    try {
      const evalResult = await strategyAdapter.processCompletedCandle({ candle, completed: true, contracts: [] });
      evaluationCalls += 1;
      coverage.markEvaluated(generationId, candle.timestamp, evalResult.processed ? 'SOURCE_BOUNDARY_EVALUATION_COMPLETED' : 'SOURCE_BOUNDARY_EVALUATION_DUPLICATE_IGNORED');
    } catch (error) {
      coverage.markLost(generationId, error instanceof Error ? error.message : 'SOURCE_BOUNDARY_EVALUATION_FAILED');
    }
  };

  return {
    recovery, liveCandleBuilder, coverage, strategyAdapter, orchestrator,
    performSourceBoundaryEvaluation,
    getBackfillCalls: () => backfillCalls,
    getEvaluationCalls: () => evaluationCalls,
    setNow: (date: Date): void => { now = date.getTime(); },
    beginTerminalization: (): void => { eodRequested = true; },
    disconnectGeneration: (): void => { currentGenerationId += 1; },
    getGenerationId: (): number => currentGenerationId,
    stopHost: (): void => { hostRunning = false; },
  };
}

test('A7-H6 V2 scenario A: happy path -- source-boundary trigger reconstructs and evaluates the final 5m candle exactly once through the actionable path; EVALUATED coverage permits VALID_COMPLETED', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });

  // NIFTY_INDEX stops ticking after 15:29 -- no live tick ever fires the pending reconciliation.
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));
  await value.performSourceBoundaryEvaluation();

  assert.equal(value.getBackfillCalls(), 1);
  assert.equal(value.getEvaluationCalls(), 1, 'the final 5m candle must be evaluated exactly once through processCompletedCandle');
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'EVALUATED');
  assert.equal(value.coverage.getRecord()?.completedCandleTime?.toISOString(), new Date('2026-08-24T15:25:00+05:30').toISOString());

  // 15:40 terminal barrier: DATA complete + EVALUATION complete -> eligible for VALID_COMPLETED.
  value.beginTerminalization();
  const boundaryReconciliation = await value.recovery.completePendingBoundaryReconciliation();
  assert.equal(boundaryReconciliation.outcome, 'RECOVERED');
  value.coverage.require(value.getGenerationId(), new Date('2026-08-24T15:30:00+05:30'));
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), true);
  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE' });
  assert.equal(outcome.status, 'VALID_COMPLETED');
});

test('A7-H6 V2 scenario B: recovery failure -- evaluation is never invoked, coverage is LOST, and the terminal session cannot be VALID_COMPLETED', async () => {
  const value = createHarness({ backfillReady: false });
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));

  await value.performSourceBoundaryEvaluation();
  assert.equal(value.getEvaluationCalls(), 0);
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'LOST');

  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE', invalidData: !value.coverage.isSatisfiedFor(value.getGenerationId()) });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});

test('A7-H6 V2 scenario C: the source-boundary trigger never executes -- 15:40 terminal recovery may reconstruct candles, but evaluation MUST NOT run at 15:40, and the terminal result fails closed', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  // The 15:30 trigger is deliberately never called here -- simulating it never firing.
  value.beginTerminalization();
  value.setNow(new Date('2026-08-24T15:40:00+05:30'));

  const boundaryReconciliation = await value.recovery.completePendingBoundaryReconciliation();
  assert.equal(boundaryReconciliation.outcome, 'RECOVERED', 'terminal-only DATA recovery may still succeed');
  assert.equal(value.getEvaluationCalls(), 0, 'evaluation must never run at the 15:40 terminal barrier');

  // require() called fresh at 15:40 (mirrors performDurableEodExit) establishes REQUIRED_PENDING
  // because the trigger never ran -- never NOT_REQUIRED, and never satisfied by DATA alone.
  value.coverage.require(value.getGenerationId(), new Date('2026-08-24T15:30:00+05:30'));
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'REQUIRED_PENDING');
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), false);

  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE', invalidData: !value.coverage.isSatisfiedFor(value.getGenerationId()) });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});

test('A7-H6 V2 scenario D: a duplicate trigger firing produces exactly one evaluation', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));

  await value.performSourceBoundaryEvaluation();
  await value.performSourceBoundaryEvaluation(); // defensive duplicate call
  assert.equal(value.getBackfillCalls(), 1);
  assert.equal(value.getEvaluationCalls(), 1, 'the duplicate call must observe the already-consumed pendingSourceBoundaryCandle and never re-evaluate');
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'EVALUATED');
});

test('A7-H6 V2 scenario E: disconnect/stale generation -- a superseded generation can never evaluate, and the terminal session fails closed', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));

  // Disconnect races the trigger: a NEW generation supersedes the one performSourceBoundaryEvaluation captured.
  value.recovery.handleUnexpectedDisconnect({ generationId: 2 });
  value.disconnectGeneration();
  await value.performSourceBoundaryEvaluation();

  assert.equal(value.getEvaluationCalls(), 0, 'a stale/superseded generation must never evaluate');
  // The now-stale generation-2 record (captured before the disconnect) is LOST; it can never be
  // read back as satisfied for the new, current generation.
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), false);

  const outcome = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE', invalidData: !value.coverage.isSatisfiedFor(value.getGenerationId()) });
  assert.equal(outcome.status, 'INVALID_DATA');
});

test('A7-H6 V2: successful evaluation is sticky -- a later disconnect/fault cannot erase already-recorded EVALUATED coverage for the same generation', async () => {
  const value = createHarness();
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));
  await value.performSourceBoundaryEvaluation();
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'EVALUATED');

  // A stale/late failure report for the SAME generation must not downgrade it.
  value.coverage.markLost(value.getGenerationId(), 'LATE_FAULT_AFTER_SUCCESS');
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'EVALUATED');
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), true);
});

test('A7-H6 V2: stop() before evaluation retains LOST, never silently re-labelled as satisfied', async () => {
  const value = createHarness({ backfillReady: false });
  value.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  value.recovery.handleReconnected({ generationId: 2 });
  value.setNow(new Date('2026-08-24T15:30:00+05:30'));
  await value.performSourceBoundaryEvaluation();
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'LOST');

  value.beginTerminalization();
  value.recovery.stop();
  // Terminalization must never erase the pending/lost evidence already on record.
  assert.equal(value.coverage.disposition(value.getGenerationId()), 'LOST');
  assert.equal(value.coverage.isSatisfiedFor(value.getGenerationId()), false);
});
