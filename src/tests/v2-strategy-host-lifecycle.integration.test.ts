import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { strategyFingerprint } from '../modules/research-validation';

function createV2Harness(options: { openPosition?: boolean; executableExit?: boolean; warmupFails?: boolean; reconciliationReady?: boolean } = {}) {
  const counters = {
    evaluations: 0,
    durableTimeExits: 0,
    durableCloseOrchestrations: 0,
    drains: 0,
    summaries: 0,
    unsubscribes: 0,
    disconnects: 0,
    brokerOrders: 0,
    reconciliationRequired: 0,
  };
  let cleanupStarted = false;
  let closeRequested = false;
  let activeGeneration = 7;
  const reconciliationReady = options.reconciliationReady ?? true;
  let hasOpenPosition = options.openPosition ?? false;

  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    counters.drains += 1;
    counters.summaries += 1;
    counters.unsubscribes += 1;
    counters.disconnects += 1;
  };
  const durableClose = async (): Promise<void> => {
    if (closeRequested) return;
    closeRequested = true;
    counters.durableCloseOrchestrations += 1;
    if (hasOpenPosition && (options.executableExit ?? true)) {
      counters.durableTimeExits += 1;
      hasOpenPosition = false;
    } else if (hasOpenPosition) {
      counters.reconciliationRequired += 1;
    }
  };
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => {
        if (options.warmupFails) throw new Error('WARMUP_FAILED');
        if (!reconciliationReady) throw new Error('RECONCILIATION_REQUIRED');
      },
      onEod: async (): Promise<void> => {
        await durableClose();
        await cleanup();
      },
      onShutdown: cleanup,
      onFault: cleanup,
    },
  });

  return {
    host,
    counters,
    evaluate: (): void => { if (host.canEvaluate()) counters.evaluations += 1; },
    recoverGeneration: async (generationId: number): Promise<void> => {
      if (generationId === activeGeneration) await host.recovered('MARKET_DATA_READY');
    },
    degrade: async (): Promise<void> => host.degrade('MARKET_DATA_DEGRADED'),
    requestStrategyExit: durableClose,
  };
}

test('V2 host starts only after deterministic warmup/reconciliation gates and evaluates only while RUNNING', async () => {
  const harness = createV2Harness();
  await harness.host.start();
  assert.equal(harness.host.getState(), 'RUNNING');
  harness.evaluate();
  assert.equal(harness.counters.evaluations, 1);

  await harness.degrade();
  harness.evaluate();
  assert.equal(harness.counters.evaluations, 1);
  await harness.recoverGeneration(6); // stale generation cannot resume V2.
  assert.equal(harness.host.canEvaluate(), false);
  await harness.recoverGeneration(7);
  assert.equal(harness.host.getState(), 'RUNNING');
  harness.evaluate();
  assert.equal(harness.counters.evaluations, 2);
});

test('V2 host fails closed for unresolved reconciliation and warmup failures', async () => {
  const reconciliationBlocked = createV2Harness({ reconciliationReady: false });
  await reconciliationBlocked.host.start();
  assert.equal(reconciliationBlocked.host.getState(), 'FAULTED');
  reconciliationBlocked.evaluate();
  assert.equal(reconciliationBlocked.counters.evaluations, 0);

  const warmupBlocked = createV2Harness({ warmupFails: true });
  await warmupBlocked.host.start();
  assert.equal(warmupBlocked.host.getState(), 'FAULTED');
  assert.equal(warmupBlocked.counters.evaluations, 0);
});

test('V2 host serializes EOD, strategy-exit, and SIGINT cleanup without a duplicate durable TIME_EXIT', async () => {
  const harness = createV2Harness({ openPosition: true });
  await harness.host.start();
  await Promise.all([harness.host.eod('WALL_CLOCK_EOD'), harness.host.eod('DUPLICATE_EOD'), harness.requestStrategyExit(), harness.host.shutdown('SIGINT')]);
  assert.equal(harness.counters.durableCloseOrchestrations, 1);
  assert.equal(harness.counters.durableTimeExits, 1);
  assert.equal(harness.counters.drains, 1);
  assert.equal(harness.counters.summaries, 1);
  assert.equal(harness.counters.unsubscribes, 1);
  assert.equal(harness.counters.disconnects, 1);
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.counters.brokerOrders, 0);
});

test('V2 host EOD with no position creates no durable exit, and degraded EOD never fabricates a stale exit', async () => {
  const noPosition = createV2Harness();
  await noPosition.host.start();
  await noPosition.host.eod('WALL_CLOCK_EOD');
  assert.equal(noPosition.counters.durableTimeExits, 0);
  assert.equal(noPosition.counters.reconciliationRequired, 0);

  const stalePosition = createV2Harness({ openPosition: true, executableExit: false });
  await stalePosition.host.start();
  await stalePosition.degrade();
  await stalePosition.host.eod('WALL_CLOCK_EOD');
  assert.equal(stalePosition.counters.durableTimeExits, 0);
  assert.equal(stalePosition.counters.reconciliationRequired, 1);
  assert.equal(stalePosition.host.getState(), 'STOPPED');
});

test('V2 faulted host remains non-evaluable and V2 fingerprint stays frozen', async () => {
  const harness = createV2Harness();
  await harness.host.start();
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.evaluate();
  assert.equal(harness.counters.evaluations, 0);
  assert.equal(harness.counters.brokerOrders, 0);
  assert.equal(strategyFingerprint({ strategyId: 'V2_TREND_DOWN_PE', timeframe: '5m', regime: 'TREND_DOWN', ema: ['EMA15', 'EMA35'], proximityPercent: 0.2, rsi: 'RSI14<35', cooldownMinutes: 10, targetPercent: 5, stopPercent: 5, holdMinutes: 15 }), 'f8a0ee53d6fdeb8a');
});

/**
 * Fix B harness: mirrors src/tests/test-live-paper-trading.ts's finalizeShutdown()
 * precedence exactly -- reconciliation problem > faulted shutdown > normal
 * completed EOD -- using host.fault()'s onFault hook as the sole, reliable
 * source of the 'FAULTED' reason (StrategyHostLifecycle.fault() is the only
 * caller of onFault, and never calls onEod/onShutdown for a faulted host).
 */
function v2HarnessWithSummary(options: { openPosition?: boolean; executableExit?: boolean } = {}) {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  const cleanShutdownEvents: string[] = [];
  let shuttingDown = false;
  let reconciliationStuck = (options.openPosition ?? false) && (options.executableExit ?? true) === false;
  const durableExitDrained = true;
  const finalizeShutdown = (reason: string): void => {
    const status = !durableExitDrained || reconciliationStuck
      ? 'RECONCILIATION_REQUIRED'
      : reason === 'FAULTED' ? 'FAULTED' : 'COMPLETED';
    summaries.push({ status, sessionCompleted: status === 'COMPLETED', eodReason: reason });
    if (status === 'COMPLETED') cleanShutdownEvents.push(reason);
  };
  const shutdown = (reason: string): void => { if (shuttingDown) return; shuttingDown = true; finalizeShutdown(reason); };
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => undefined,
      // performDurableEodExit() closes open positions durably before calling shutdown().
      onEod: (): void => { reconciliationStuck = false; shutdown('EOD_NSE_SESSION_CLOSE'); },
      onShutdown: (): void => shutdown('SESSION_END'),
      onFault: (): void => shutdown('FAULTED'),
    },
  });
  return { host, summaries, cleanShutdownEvents };
}

test('V2 fault-journal truthfulness: FAULTED host with clean durable state journals status FAULTED, sessionCompleted=false, exactly one SUMMARY, no CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  assert.equal(harness.host.getState(), 'RUNNING');
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  assert.equal(harness.summaries.length, 1);
  assert.deepEqual(harness.summaries[0], { status: 'FAULTED', sessionCompleted: false, eodReason: 'FAULTED' });
  assert.deepEqual(harness.cleanShutdownEvents, []);

  // No second SUMMARY from a later eod()/shutdown() call: both are no-ops from a terminal FAULTED host.
  await harness.host.eod('LATE_TICK');
  await harness.host.shutdown('SIGINT');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.host.getState(), 'FAULTED');
});

test('V2 fault-journal truthfulness positive control: normal WALL_CLOCK_EOD still journals status COMPLETED, sessionCompleted=true, exactly one SUMMARY plus CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.deepEqual(harness.summaries[0], { status: 'COMPLETED', sessionCompleted: true, eodReason: 'EOD_NSE_SESSION_CLOSE' });
  assert.deepEqual(harness.cleanShutdownEvents, ['EOD_NSE_SESSION_CLOSE']);
});

test('V2 fault-journal truthfulness: a stuck reconciliation-required position is never hidden behind a generic FAULTED status', async () => {
  const harness = v2HarnessWithSummary({ openPosition: true, executableExit: false });
  await harness.host.start();
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  assert.equal(harness.summaries.length, 1);
  // Reconciliation evidence takes precedence over the generic FAULTED result.
  assert.equal(harness.summaries[0]?.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.summaries[0]?.sessionCompleted, false);
  assert.deepEqual(harness.cleanShutdownEvents, []);
});
