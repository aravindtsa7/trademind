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
