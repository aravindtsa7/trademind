import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { StrategyTerminalOutcomeArbiter } from '../modules/market-data/services/strategy-terminal-outcome-arbiter.service';
import { resolveSessionOutcome, strategyFingerprint } from '../modules/research-validation';

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
    const outcome = resolveSessionOutcome({
      reason,
      reconciliationRequired: reconciliationStuck,
      durableExitDrained,
    });
    summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: reason });
    if (outcome.status === 'VALID_COMPLETED') cleanShutdownEvents.push(reason);
  };
  const shutdown = (reason: string): void => { if (shuttingDown) return; shuttingDown = true; finalizeShutdown(reason); };
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => undefined,
      // performDurableEodExit() closes open positions durably before calling shutdown().
      onEod: (reason): void => { reconciliationStuck = false; shutdown(reason ?? 'EOD_NSE_SESSION_CLOSE'); },
      onShutdown: (reason): void => shutdown(reason ?? 'SESSION_END'),
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

test('V2 outcome truthfulness positive control: normal WALL_CLOCK_EOD journals status VALID_COMPLETED, sessionCompleted=true, exactly one SUMMARY plus CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.deepEqual(harness.summaries[0], { status: 'VALID_COMPLETED', sessionCompleted: true, eodReason: 'WALL_CLOCK_EOD' });
  assert.deepEqual(harness.cleanShutdownEvents, ['WALL_CLOCK_EOD']);
});

test('V2 manual stop: SIGINT while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  assert.equal(harness.host.getState(), 'RUNNING');
  await harness.host.shutdown('SIGINT');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.deepEqual(harness.summaries[0], { status: 'MANUAL_STOP', sessionCompleted: false, eodReason: 'SIGINT' });
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2 manual stop: SIGTERM while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  assert.equal(harness.host.getState(), 'RUNNING');
  await harness.host.shutdown('SIGTERM');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.deepEqual(harness.summaries[0], { status: 'MANUAL_STOP', sessionCompleted: false, eodReason: 'SIGTERM' });
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2 late SIGINT after EOD finalization has already started does not replace VALID_COMPLETED with MANUAL_STOP', async () => {
  const harness = v2HarnessWithSummary();
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  await harness.host.shutdown('SIGINT');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
  assert.equal(harness.summaries[0]?.sessionCompleted, true);
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

test('V2 manual stop truthfulness: a stuck reconciliation-required position is never hidden behind a MANUAL_STOP status', async () => {
  const harness = v2HarnessWithSummary({ openPosition: true, executableExit: false });
  await harness.host.start();
  await harness.host.shutdown('SIGINT');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.summaries[0]?.sessionCompleted, false);
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2 startup warmup failure blocks startup and records INVALID_DATA', () => {
  const outcome = resolveSessionOutcome({ reason: 'WARMUP_NOT_READY', invalidData: true });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});

// A10 blocker B2 (third correction): the real production terminal-outcome arbiter
// (StrategyTerminalOutcomeArbiter, imported and used by the actual test-live-paper-trading.ts
// entrypoint) replaces the earlier ad hoc "check host.getState() at write time" harness
// prototype. Every test below drives the REAL StrategyHostLifecycle + the REAL arbiter,
// wired exactly like the production script: propose() before any close-out work, commit()
// after it, so a racing fault can escalate the outcome for as long as commit() has not run.
function deferredBarrier<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Mirrors performDurableEodExit(): EOD-specific durable close-out (and its reconciliation
 * clearing) happens BEFORE the shared shutdown()/commit() path, giving a racing fault a real
 * window in which reconciliationStuck has not yet been cleared. */
function v2HarnessWithBlockingEod(options: { openPosition?: boolean; executableExit?: boolean } = {}) {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  let shuttingDown = false;
  let reconciliationStuck = (options.openPosition ?? false) && (options.executableExit ?? true) === false;
  const durableExitDrained = true;
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const finalizeShutdown = async (): Promise<void> => {
    await arbiter.commit((finalReason) => {
      const outcome = resolveSessionOutcome({ reason: finalReason, reconciliationRequired: reconciliationStuck, durableExitDrained });
      summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason });
    });
  };
  const shutdown = async (reason: string): Promise<void> => {
    arbiter.propose(reason, resolveSessionOutcome({ reason }).status);
    if (shuttingDown) return;
    shuttingDown = true;
    await finalizeShutdown();
  };
  const eodStarted = deferredBarrier<void>();
  const eodBlocker = deferredBarrier<void>();
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => undefined,
      onEod: async (reason): Promise<void> => { eodStarted.resolve(); await eodBlocker.promise; reconciliationStuck = false; await shutdown(reason ?? 'EOD_NSE_SESSION_CLOSE'); },
      onShutdown: (reason): Promise<void> => shutdown(reason ?? 'SESSION_END'),
      onFault: (): Promise<void> => shutdown('FAULTED'),
    },
  });
  return { host, summaries, eodStarted, eodBlocker, arbiter };
}

/** Mirrors shutdown()'s own shared drain step: any terminal trigger (EOD, manual, fault) can
 * be genuinely blocked here, between propose() and commit(), regardless of which one owns it. */
function v2HarnessWithBlockingDrain() {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  const cleanShutdownEvents: string[] = [];
  let shuttingDown = false;
  const durableExitDrained = true;
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const drainStarted = deferredBarrier<void>();
  const drainBlocker = deferredBarrier<void>();
  const shutdown = async (reason: string): Promise<void> => {
    arbiter.propose(reason, resolveSessionOutcome({ reason }).status);
    if (shuttingDown) return;
    shuttingDown = true;
    drainStarted.resolve(); await drainBlocker.promise; // the shared drain step, common to every trigger
    await arbiter.commit((finalReason) => {
      const outcome = resolveSessionOutcome({ reason: finalReason, durableExitDrained });
      summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason });
      if (outcome.status === 'VALID_COMPLETED') cleanShutdownEvents.push(finalReason);
    });
  };
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => undefined,
      onEod: (reason): Promise<void> => shutdown(reason ?? 'EOD_NSE_SESSION_CLOSE'),
      onShutdown: (reason): Promise<void> => shutdown(reason ?? 'SESSION_END'),
      onFault: (): Promise<void> => shutdown('FAULTED'),
    },
  });
  return { host, summaries, cleanShutdownEvents, drainStarted, drainBlocker, arbiter };
}

test('V2-A: EOD proposed, durable close-out latch owned, paused before commit, fault arrives, resumed -> FAULTED, exactly one SUMMARY, no VALID_COMPLETED/CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithBlockingEod();
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.eodStarted.promise; // paused exactly after close-out ownership, before any commit
  assert.equal(harness.host.getState(), 'EOD');
  assert.equal(harness.arbiter.isCommitted(), false);
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.eodBlocker.resolve(); // resume -- the already-started onEod finishes, but its own shutdown() call is now a no-op
  await eodPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.notEqual(harness.summaries[0]?.status, 'VALID_COMPLETED');
  assert.equal(harness.arbiter.getCommittedReason(), 'FAULTED');
});

test('V2-K: a stuck reconciliation-required position racing a fault during an in-flight EOD is never hidden behind FAULTED or duplicated by the resumed EOD path', async () => {
  const harness = v2HarnessWithBlockingEod({ openPosition: true, executableExit: false });
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.eodStarted.promise; // onEod is genuinely mid-flight; reconciliationStuck is still true
  assert.equal(harness.host.getState(), 'EOD');
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.eodBlocker.resolve(); // let the already-started onEod finish -- its own shutdown() call is now a no-op
  await eodPromise;
  assert.equal(harness.summaries.length, 1); // exactly one authoritative outcome, not two
  assert.equal(harness.summaries[0]?.status, 'RECONCILIATION_REQUIRED'); // reconciliation uncertainty outranks the generic FAULTED result
  assert.equal(harness.summaries[0]?.sessionCompleted, false);
  assert.equal(harness.host.getState(), 'FAULTED');
});

test('V2-E: SIGINT proposed, paused in the shared drain step before commit, fault arrives -> FAULTED, not MANUAL_STOP', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const shutdownPromise = harness.host.shutdown('SIGINT');
  await harness.drainStarted.promise;
  await harness.host.fault(new Error('EVALUATOR_CRASHED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.drainBlocker.resolve();
  await shutdownPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2-F: SIGTERM proposed, paused in the shared drain step before commit, fault arrives -> FAULTED, not MANUAL_STOP', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const shutdownPromise = harness.host.shutdown('SIGTERM');
  await harness.drainStarted.promise;
  await harness.host.fault(new Error('EVALUATOR_CRASHED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.drainBlocker.resolve();
  await shutdownPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2-G: fault arriving before EOD/manual-stop leaves FAULTED authoritative regardless of what arrives afterward', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const faultPromise = harness.host.fault(new Error('RECONNECT_FAILED'));
  await harness.drainStarted.promise;
  harness.drainBlocker.resolve();
  await faultPromise;
  assert.equal(harness.host.getState(), 'FAULTED');
  await harness.host.eod('WALL_CLOCK_EOD');
  await harness.host.shutdown('SIGINT');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.equal(harness.host.getState(), 'FAULTED');
});

test('V2-I: normal EOD (no racing fault) commits VALID_COMPLETED exactly once with exactly one CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const shutdownPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.drainStarted.promise;
  harness.drainBlocker.resolve(); // no fault races in -- resume immediately
  await shutdownPromise;
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
  assert.deepEqual(harness.cleanShutdownEvents, ['WALL_CLOCK_EOD']);
});

test('V2-J: normal manual SIGINT (no racing fault) commits MANUAL_STOP exactly once with no CLEAN_SHUTDOWN', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const shutdownPromise = harness.host.shutdown('SIGINT');
  await harness.drainStarted.promise;
  harness.drainBlocker.resolve();
  await shutdownPromise;
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'MANUAL_STOP');
  assert.deepEqual(harness.cleanShutdownEvents, []);
});

test('V2-L: a fault proposed immediately before commit still wins the race', async () => {
  const harness = v2HarnessWithBlockingDrain();
  await harness.host.start();
  const shutdownPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.drainStarted.promise;
  void harness.host.fault(new Error('RECONNECT_FAILED')); // proposes FAULTED immediately, does not itself win the drain latch
  harness.drainBlocker.resolve();
  await shutdownPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
});

test('V2-M: fault arriving after EOD close-out and commit already completed leaves the committed outcome unchanged -- the session was genuinely completed, and the post-commit fault is a benign no-op, never an illegal STOPPED->FAULTED transition', async () => {
  const harness = v2HarnessWithBlockingEod();
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.eodStarted.promise;
  harness.eodBlocker.resolve(); // let onEod run straight through to commit with nothing racing
  await eodPromise;
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
  assert.equal(harness.arbiter.isCommitted(), true);
  assert.equal(harness.arbiter.getCommittedReason(), 'WALL_CLOCK_EOD');
  // A post-session fault must not rewrite the committed outcome, must not attempt an illegal
  // STOPPED->FAULTED transition, and must leave host state and the committed journal outcome
  // in agreement.
  await assert.doesNotReject(() => harness.host.fault(new Error('POST_SESSION_FAULT')));
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.arbiter.getCommittedReason(), 'WALL_CLOCK_EOD');
});

// A10 final correction: drives sealAfterCloseOut() -- the real production
// finalization seam used verbatim by test-live-paper-trading.ts's shutdown()
// -- directly, rather than a hand-rolled propose()/commit() sequence, and
// proves the isSealing() gate an external fault trigger (e.g. reconnectFailed)
// must consult before calling host.fault() directly.
function v2HarnessWithSealAfterCloseOut(options: { closeOutBlocks?: boolean; closeOutThrows?: boolean } = {}) {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  const cleanShutdownEvents: string[] = [];
  let shuttingDown = false;
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const closeOutStarted = deferredBarrier<void>();
  const closeOutBlocker = deferredBarrier<void>();
  // Mirrors the real reconnectFailed handler: an external trigger that must not
  // flip the host's own state once the arbiter has started (or finished) sealing.
  const externalFaultTrigger = (host: StrategyHostLifecycle): void => {
    if (!arbiter.isSealing()) void host.fault(new Error('RECONNECT_FAILED_EXTERNAL'));
  };
  const shutdown = async (reason: string): Promise<void> => {
    arbiter.propose(reason, resolveSessionOutcome({ reason }).status);
    if (shuttingDown) return;
    shuttingDown = true;
    await arbiter.sealAfterCloseOut(
      async () => {
        if (options.closeOutBlocks) { closeOutStarted.resolve(); await closeOutBlocker.promise; }
        if (options.closeOutThrows) throw new Error('CLOSE_OUT_FAILED');
      },
      (finalReason) => {
        const outcome = resolveSessionOutcome({ reason: finalReason });
        summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason });
        if (outcome.status === 'VALID_COMPLETED') cleanShutdownEvents.push(finalReason);
      },
    );
  };
  const host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    hooks: {
      warmup: (): void => undefined,
      onEod: (reason): Promise<void> => shutdown(reason ?? 'EOD_NSE_SESSION_CLOSE'),
      onShutdown: (reason): Promise<void> => shutdown(reason ?? 'SESSION_END'),
      onFault: (): Promise<void> => shutdown('FAULTED'),
    },
  });
  return { host, summaries, cleanShutdownEvents, closeOutStarted, closeOutBlocker, arbiter, externalFaultTrigger };
}

test('V2 real seam: an external fault trigger racing WHILE close-out is genuinely in flight is suppressed by isSealing(), so host and journal never disagree', async () => {
  const harness = v2HarnessWithSealAfterCloseOut({ closeOutBlocks: true });
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.closeOutStarted.promise; // close-out is genuinely mid-flight; isSealing() is still false here
  assert.equal(harness.arbiter.isSealing(), false);
  harness.externalFaultTrigger(harness.host); // races in before close-out finishes -- allowed to win
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.closeOutBlocker.resolve();
  await eodPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.equal(harness.host.getState(), 'FAULTED'); // host state and the committed journal outcome agree
});

test('V2 real seam: an external fault trigger arriving AFTER the seal has started never flips host state, leaving it consistent with the already-sealed VALID_COMPLETED outcome', async () => {
  const harness = v2HarnessWithSealAfterCloseOut();
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.arbiter.isSealing(), true);
  harness.externalFaultTrigger(harness.host); // gated no-op: isSealing() is already true
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.getState(), 'STOPPED'); // never flipped to FAULTED -- no host/journal disagreement
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
});

test('V2 real seam: close-out throwing before the seal still escalates to FAULTED, seals exactly one SUMMARY, and StrategyHostLifecycle itself reaches FAULTED', async () => {
  const harness = v2HarnessWithSealAfterCloseOut({ closeOutThrows: true });
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD'); // finish() catches the rethrown close-out error and calls fault()
  assert.equal(harness.host.getState(), 'FAULTED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.deepEqual(harness.cleanShutdownEvents, []);
  assert.equal(harness.arbiter.getCommittedReason(), 'CLOSE_OUT_FAILED');
});

test('V2-N: fault during onEod escalates to FAULTED via the real StrategyTerminalOutcomeArbiter, even though EOD would otherwise have won the drain latch', async () => {
  const harness = v2HarnessWithBlockingEod();
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.eodStarted.promise;
  assert.equal(harness.host.getState(), 'EOD');
  await harness.host.fault(new Error('EVALUATOR_CRASHED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  assert.equal(harness.summaries.length, 1); // onFault's shutdown() won the latch
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.equal(harness.summaries[0]?.sessionCompleted, false);
  assert.equal(harness.arbiter.getCommittedReason(), 'FAULTED');
  harness.eodBlocker.resolve(); // let onEod finish -- its shutdown() is a no-op
  await eodPromise;
  assert.equal(harness.summaries.length, 1); // still exactly one outcome
});
