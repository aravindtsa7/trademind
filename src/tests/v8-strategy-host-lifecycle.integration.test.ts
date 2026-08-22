import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
import { describeV8ErrorSafely, routeV8CompletedCandleFailure, v8ObserveTerminalFailure } from '../modules/adaptive-intraday/services/v8-bullish-reclaim-shadow.service';
import { EventEmitter } from 'node:events';

function v8HarnessLifecycle() {
  const counts={settle:0,summary:0,timer:0,unsubscribe:0,disconnect:0};let cleaned=false;
  const cleanup=():void=>{if(cleaned)return;cleaned=true;counts.settle++;counts.summary++;counts.timer++;counts.unsubscribe++;counts.disconnect++;};
  const host=new StrategyHostLifecycle({strategyId:'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',runtimeId:'shadow:v8:reclaim',hooks:{warmup:()=>undefined,onEod:cleanup,onShutdown:cleanup,onFault:cleanup}});
  return {host,counts};
}

test('V8 host EOD settles, summarizes, clears timers, unsubscribes and disconnects exactly once',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await host.eod('EOD');await host.eod('LATE_TICK');assert.equal(host.getState(),'STOPPED');assert.deepEqual(counts,{settle:1,summary:1,timer:1,unsubscribe:1,disconnect:1});});
test('V8 host SIGINT and EOD race retain one cleanup path',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await Promise.all([host.eod('EOD'),host.shutdown('SIGINT')]);assert.equal(host.getState(),'STOPPED');assert.equal(counts.summary,1);assert.equal(counts.unsubscribe,1);assert.equal(counts.disconnect,1);});
test('V8 host fault from reconnect exhaustion blocks evaluation and does not double-clean',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await host.fault(new Error('RECONNECT_FAILED'));await host.shutdown('SIGINT');assert.equal(host.getState(),'FAULTED');assert.equal(host.canEvaluate(),false);assert.equal(counts.summary,1);assert.equal(counts.unsubscribe,1);assert.equal(counts.disconnect,1);});

/**
 * Fix B harness: mirrors src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts's
 * shutdown() exactly -- onEod calls shutdown('EOD'), onShutdown calls
 * shutdown('SIGINT'), onFault calls shutdown('FAULTED')
 * (StrategyHostLifecycle.fault() is the only caller of onFault, and never
 * calls onEod/onShutdown for a faulted host, so 'FAULTED' is a reliable
 * signal, not string-sniffing). ZERO_ORDER/SHADOW_ONLY flags are unrelated
 * to this fix and are left untouched in production; this harness omits them
 * since it only proves the status/sessionCompleted branch.
 */
import { resolveSessionOutcome } from '../modules/research-validation';

function v8WithSummary(){
  const summaries:Array<{status:string;sessionCompleted:boolean;eodReason:string}>=[];
  const cleanShutdownEvents:string[]=[];
  let closing=false;
  const shutdown=(reason:string):void=>{
    if(closing)return;closing=true;
    const outcome=resolveSessionOutcome({reason});
    summaries.push({status:outcome.status,sessionCompleted:outcome.sessionCompleted,eodReason:reason});
    if(outcome.status==='VALID_COMPLETED')cleanShutdownEvents.push(reason);
  };
  const host=new StrategyHostLifecycle({strategyId:'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',runtimeId:'shadow:v8:reclaim',hooks:{warmup:()=>undefined,onEod:(reason)=>shutdown(reason??'EOD'),onShutdown:(reason)=>shutdown(reason??'SIGINT'),onFault:()=>shutdown('FAULTED')}});
  return {host,summaries,cleanShutdownEvents};
}

test('V8 fault-journal truthfulness: FAULTED host journals status FAULTED, sessionCompleted=false, exactly one SUMMARY, no CLEAN_SHUTDOWN',async()=>{
  const x=v8WithSummary();
  await x.host.start();
  await x.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(x.host.getState(),'FAULTED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'FAULTED',sessionCompleted:false,eodReason:'FAULTED'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
  // No second SUMMARY from a later eod()/shutdown() call.
  await x.host.eod('LATE_TICK');
  await x.host.shutdown('SIGINT');
  assert.equal(x.summaries.length,1);
});

test('V8 outcome truthfulness positive control: normal EOD still journals status VALID_COMPLETED, sessionCompleted=true, exactly one SUMMARY plus CLEAN_SHUTDOWN',async()=>{
  const x=v8WithSummary();
  await x.host.start();
  await x.host.eod('EOD');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'VALID_COMPLETED',sessionCompleted:true,eodReason:'EOD'});
  assert.deepEqual(x.cleanShutdownEvents,['EOD']);
});

test('V8 manual stop: SIGINT while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN',async()=>{
  const x=v8WithSummary();
  await x.host.start();
  assert.equal(x.host.getState(),'RUNNING');
  await x.host.shutdown('SIGINT');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'MANUAL_STOP',sessionCompleted:false,eodReason:'SIGINT'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
});

test('V8 manual stop: SIGTERM while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN',async()=>{
  const x=v8WithSummary();
  await x.host.start();
  assert.equal(x.host.getState(),'RUNNING');
  await x.host.shutdown('SIGTERM');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'MANUAL_STOP',sessionCompleted:false,eodReason:'SIGTERM'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
});

test('V8 late SIGINT after EOD finalization has already started does not replace VALID_COMPLETED with MANUAL_STOP',async()=>{
  const x=v8WithSummary();
  await x.host.start();
  await x.host.eod('EOD');
  await x.host.shutdown('SIGINT');
  assert.equal(x.summaries.length,1);
  assert.equal(x.summaries[0]?.status,'VALID_COMPLETED');
  assert.equal(x.summaries[0]?.sessionCompleted,true);
});

test('V8 startup warmup and readiness failures record INVALID_DATA', () => {
  const warmupFail = resolveSessionOutcome({ reason: 'WARMUP_NOT_READY', invalidData: true });
  assert.equal(warmupFail.status, 'INVALID_DATA');
  assert.equal(warmupFail.sessionCompleted, false);

  const readinessFail = resolveSessionOutcome({ reason: 'INCOMPLETE_SERIES', invalidData: true });
  assert.equal(readinessFail.status, 'INVALID_DATA');
  assert.equal(readinessFail.sessionCompleted, false);
});

test('F: an evaluator exception thrown while processing a completed candle is contained by the async listener, causes exactly one FAULTED transition, and blocks all later evaluation without leaking an unhandledRejection', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const bus = new EventEmitter();
  let evaluationAttempts = 0;
  // Mirrors the exact containment pattern in src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts:
  // an inner try/catch routes the failure through host.fault(), and the outer
  // `.catch()` on listener registration is a last-resort safety net.
  const handleCandle = async (event: unknown): Promise<void> => {
    try {
      if (!host.canEvaluate()) return;
      evaluationAttempts += 1;
      if ((event as { shouldThrow?: boolean }).shouldThrow) throw new Error('SIMULATED_V8_EVALUATOR_FAILURE');
    } catch (error) {
      await host.fault(error);
    }
  };
  const onCompletedCandle = (event: unknown): void => { handleCandle(event).catch(() => undefined); };
  bus.on('market.candle.completed', onCompletedCandle);

  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    bus.emit('market.candle.completed', { shouldThrow: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
  assert.equal(counts.unsubscribe, 1);
  assert.equal(counts.disconnect, 1);

  bus.emit('market.candle.completed', { shouldThrow: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluationAttempts, 1); // the post-fault event never reaches evaluation: canEvaluate() is now false

  await host.fault(new Error('SECOND_FAULT_ATTEMPT_MUST_NOT_DOUBLE_SHUTDOWN'));
  assert.equal(counts.summary, 1);
  assert.equal(counts.unsubscribe, 1);
  assert.equal(counts.disconnect, 1);
});

test('F: the live V8 script wires handleCandle exceptions through a contained async listener and host.fault, never a bare unhandled listener', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts'), 'utf8');
  const handleCandleBlock = source.slice(source.indexOf('const handleCandle = async'), source.indexOf('const onCompletedCandle'));
  assert.ok(handleCandleBlock.length > 0, 'expected a handleCandle definition');
  assert.ok(handleCandleBlock.includes('await routeV8CompletedCandleFailure('), 'handleCandle must route contained exceptions through the shared fault-routing helper so host.fault() cannot be skipped by a journal failure');
  assert.ok(handleCandleBlock.includes('if (!host) throw new Error(\'V8_HOST_UNAVAILABLE_DURING_ACTIVE_FAULT\');'), 'an undefined host during an active failure must be a thrown defect, never a silent Promise.resolve() no-op');
  assert.ok(handleCandleBlock.includes('return host.fault(faultError);'), 'the fault-routing helper must be wired to the real host.fault(...) path');
  assert.ok(handleCandleBlock.includes('journal: () => journal.appendEvent('), 'the fault-routing helper must be wired to the real journal write, isolated inside the helper');
  assert.ok(handleCandleBlock.includes('describeV8ErrorSafely(error)'), 'journal formatting inside the helper must use the safe, nonthrowing error description');
  assert.ok(source.includes('const onCompletedCandle = (x: unknown): void => {'), 'expected a wrapping listener that cannot leave handleCandle unobserved');
  assert.ok(source.includes('handleCandle(x).catch((error) => v8ObserveTerminalFailure(error, console.error));'), 'the terminal catch must route through the guaranteed-nonthrowing terminal observer, not a raw console.error(String(error))');
  assert.ok(source.includes("eventBus.on('market.candle.completed', onCompletedCandle)"), 'the event must be registered through the contained wrapper');
  assert.ok(source.includes("eventBus.off('market.candle.completed', onCompletedCandle)"), 'shutdown must deregister the same contained wrapper');
  assert.ok(!source.includes("eventBus.on('market.candle.completed', handleCandle)"), 'the raw async handleCandle must never be registered directly as a listener');
});

test('F2: routeV8CompletedCandleFailure guarantees host.fault() even when the journal write throws synchronously (production ordering)', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const logs: string[] = [];
  let faultCalls = 0;
  await routeV8CompletedCandleFailure(new Error('SIMULATED_EVALUATOR_FAILURE'), {
    journal: () => { throw new Error('SIMULATED_JOURNAL_FILESYSTEM_FAILURE'); },
    fault: (error) => { faultCalls += 1; return host.fault(error); },
    log: (message) => { logs.push(message); },
  });
  assert.equal(faultCalls, 1);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
  assert.equal(counts.unsubscribe, 1);
  assert.ok(logs.some((line) => line.includes('SIMULATED_EVALUATOR_FAILURE')), 'the original evaluator failure must remain visible');
  assert.ok(logs.some((line) => line.includes('V8_EVALUATOR_FAULT_JOURNAL_WRITE_FAILED') && line.includes('SIMULATED_JOURNAL_FILESYSTEM_FAILURE')), 'the journal failure itself must be visible, never silently swallowed');
});

test('F3: a journal write that throws never leaks as an unhandledRejection when routed through the production wrapper pattern', async () => {
  const { host } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    const onCompletedCandle = (): void => {
      routeV8CompletedCandleFailure(new Error('SIMULATED_EVALUATOR_FAILURE'), {
        journal: () => { throw new Error('SIMULATED_JOURNAL_FILESYSTEM_FAILURE'); },
        fault: (error) => host.fault(error),
      }).catch(() => undefined);
    };
    onCompletedCandle();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
});

test('F4: if onFault/shutdown rejects after the FAULTED transition, the host still remains FAULTED/non-evaluable and the rejection is observed rather than leaked', async () => {
  let onFaultCalls = 0;
  const host = new StrategyHostLifecycle({
    strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
    runtimeId: 'shadow:v8:reclaim',
    hooks: {
      warmup: () => undefined,
      onEod: () => undefined,
      onShutdown: () => undefined,
      onFault: () => { onFaultCalls += 1; throw new Error('SIMULATED_SHUTDOWN_FAILURE'); },
    },
  });
  await host.start();

  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  let observedRejection: unknown;
  try {
    const onCompletedCandle = (): Promise<void> => routeV8CompletedCandleFailure(new Error('SIMULATED_EVALUATOR_FAILURE'), {
      journal: () => undefined,
      fault: (error) => host.fault(error),
    }).catch((error) => { observedRejection = error; });
    await onCompletedCandle();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.ok(observedRejection instanceof Error);
  assert.equal((observedRejection as Error).message, 'SIMULATED_SHUTDOWN_FAILURE');
  assert.equal(onFaultCalls, 1);
  assert.equal(host.getState(), 'FAULTED'); // set BEFORE awaiting onFault(), so it survives onFault's own failure
  assert.equal(host.canEvaluate(), false);

  // A later completed-candle event still cannot evaluate: the host never reverted to RUNNING.
  assert.equal(host.canEvaluate(), false);
});

// -------------------------------------------------------------------------
// FAULT-FIRST: hooks.fault(error) must be the FIRST safety-critical
// operation in routeV8CompletedCandleFailure -- nothing that can throw
// (formatting, logging, journaling) may run before it or be able to
// prevent it. These reproduce Codex's independently-found sequences:
// initialLog/journalFailureLog/errorFormatting REJECTED while HOST RUNNING.
// -------------------------------------------------------------------------

test('FAULT-FIRST-ORDER: hooks.fault(error) runs before any observability operation', async () => {
  const order: string[] = [];
  const { host } = v8HarnessLifecycle();
  await host.start();
  await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
    fault: (error) => { order.push('fault'); return host.fault(error); },
    journal: () => { order.push('journal'); },
    log: () => { order.push('log'); },
  });
  assert.equal(order[0], 'fault', 'fault must be attempted before any observability operation');
  assert.deepEqual(new Set(order), new Set(['fault', 'journal', 'log']));
  assert.equal(host.getState(), 'FAULTED');
});

test('FAULT-FIRST-A: initial log throwing cannot prevent the fault transition', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: () => undefined,
      fault: (error) => host.fault(error),
      log: () => { throw new Error('LOG_FAILED'); },
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
});

test('FAULT-FIRST-B: journal throwing cannot prevent the fault transition', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: () => { throw new Error('JOURNAL_FAILED'); },
      fault: (error) => host.fault(error),
      log: (message) => void message,
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(counts.summary, 1);
});

test('FAULT-FIRST-C: journal AND journal-failure logging both throwing still cannot prevent the fault transition', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: () => { throw new Error('JOURNAL_FAILED'); },
      fault: (error) => host.fault(error),
      log: () => { throw new Error('LOG_FAILED'); }, // used for both the initial log and the journal-failure log
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
});

test('FAULT-FIRST-D: a hostile error whose toString() throws still reaches fault() unmodified, and observability falls back safely', async () => {
  const hostile = { toString() { throw new Error('FORMAT_FAILED'); } };
  const { host } = v8HarnessLifecycle();
  await host.start();
  let receivedError: unknown;
  const logs: string[] = [];
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(hostile, {
      journal: () => undefined,
      fault: (error) => { receivedError = error; return host.fault(error); },
      log: (message) => { logs.push(message); },
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(receivedError, hostile); // the ORIGINAL value, unnormalized, reached fault()
  assert.equal(host.getState(), 'FAULTED');
  assert.ok(logs.some((line) => line.includes('<unprintable error>')), 'observability must fall back safely instead of throwing');
  assert.equal(describeV8ErrorSafely(hostile), '<unprintable error>');
});

test('FAULT-FIRST-F: the terminal EventEmitter containment observer cannot itself leak an unobserved rejection (synchronous logger throw)', async () => {
  await assert.doesNotReject(() => v8ObserveTerminalFailure(new Error('SOME_FAILURE'), () => { throw new Error('LOG_FAILED'); }));
  await assert.doesNotReject(() => v8ObserveTerminalFailure({ toString() { throw new Error('FORMAT_FAILED'); } }, () => { throw new Error('LOG_FAILED'); }));
  const observed: string[] = [];
  await v8ObserveTerminalFailure(new Error('SOME_FAILURE'), (message) => { observed.push(message); });
  assert.ok(observed[0].includes('SOME_FAILURE'));
});

// -------------------------------------------------------------------------
// ASYNC observability: a callback typed `void | Promise<void>` can still be
// implemented `async` and return a REJECTED Promise. Every V8 best-effort
// helper must observe that rejection (not merely a synchronous throw).
// -------------------------------------------------------------------------

test('ASYNC-A: an async log rejection cannot prevent the fault transition and is not left unobserved', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: () => undefined,
      fault: (error) => host.fault(error),
      log: async () => { throw new Error('ASYNC_LOG_FAILED'); },
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
});

test('ASYNC-B: an async journal rejection is observed and cannot prevent the fault transition', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: async () => { throw new Error('ASYNC_JOURNAL_FAILED'); },
      fault: (error) => host.fault(error),
      log: (message) => { void message; },
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(counts.summary, 1);
});

test('ASYNC-C: async journal rejection AND async journal-failure-logger rejection are both observed', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await routeV8CompletedCandleFailure(new Error('EVALUATOR_FAILURE'), {
      journal: async () => { throw new Error('ASYNC_JOURNAL_FAILED'); },
      fault: (error) => host.fault(error),
      log: async () => { throw new Error('ASYNC_LOG_FAILED'); }, // used for both the initial log and the journal-failure log
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1);
});

test('ASYNC-D: an async terminal logger rejection cannot leak an unhandled Promise rejection', async () => {
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await v8ObserveTerminalFailure(new Error('SOME_FAILURE'), async () => { throw new Error('ASYNC_TERMINAL_LOG_FAILED'); });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('ASYNC-D2: the exact unawaited production wrapper pattern (handleCandle(...).catch(v8ObserveTerminalFailure)) does not leak an unhandled rejection with an async-rejecting logger', async () => {
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    const bus = new EventEmitter();
    const handleCandle = async (): Promise<void> => { throw new Error('SIMULATED_EVALUATOR_FAILURE'); };
    // Mirrors: const onCompletedCandle = (x) => { handleCandle(x).catch((error) => v8ObserveTerminalFailure(error, console.error)); };
    const onCompletedCandle = (): void => {
      handleCandle().catch((error) => v8ObserveTerminalFailure(error, async () => { throw new Error('ASYNC_TERMINAL_LOG_FAILED'); }));
    };
    bus.on('market.candle.completed', onCompletedCandle);
    bus.emit('market.candle.completed', {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

// -------------------------------------------------------------------------
// StrategyHostLifecycle fault-reason extraction: a hostile Error.message
// accessor (or a hostile non-Error `instanceof` target) must never leave
// the REAL host RUNNING.
// -------------------------------------------------------------------------

test('HOSTILE-E: a real Error whose message getter throws cannot leave the real StrategyHostLifecycle host RUNNING', async () => {
  const { host, counts } = v8HarnessLifecycle();
  await host.start();
  const hostile = new Error('original');
  Object.defineProperty(hostile, 'message', { get() { throw new Error('MESSAGE_GETTER_FAILED'); } });

  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  let faultRejected: unknown;
  try {
    await host.fault(hostile).catch((error) => { faultRejected = error; });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(faultRejected, undefined); // fault() itself must not reject because of the hostile message getter
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
  assert.equal(counts.summary, 1); // onFault/shutdown still ran normally, exactly once
});

test('HOSTILE-E positive control: an ordinary Error still uses its own message as the fault transition reason', async () => {
  const reasons: string[] = [];
  const host = new StrategyHostLifecycle({
    strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
    runtimeId: 'shadow:v8:reclaim',
    hooks: { warmup: () => undefined, onEod: () => undefined, onShutdown: () => undefined, onFault: () => undefined },
    log: (event) => { if (event.state === 'FAULTED') reasons.push(event.reason); },
  });
  await host.start();
  await host.fault(new Error('NORMAL_FAULT'));
  assert.deepEqual(reasons, ['NORMAL_FAULT']);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
});

test('HOSTILE-E: a hostile non-Error value (a Proxy whose instanceof trap throws) still reaches FAULTED with the fixed UNKNOWN_FAULT fallback', async () => {
  const hostileProxy = new Proxy({}, { getPrototypeOf() { throw new Error('PROXY_TRAP_FAILED'); } });
  const reasons: string[] = [];
  const host = new StrategyHostLifecycle({
    strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
    runtimeId: 'shadow:v8:reclaim',
    hooks: { warmup: () => undefined, onEod: () => undefined, onShutdown: () => undefined, onFault: () => undefined },
    log: (event) => { if (event.state === 'FAULTED') reasons.push(event.reason); },
  });
  await host.start();
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);
  try {
    await host.fault(hostileProxy);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(reasons, ['UNKNOWN_FAULT']);
  assert.equal(host.getState(), 'FAULTED');
  assert.equal(host.canEvaluate(), false);
});

test('V8 live tick and depth handlers rotate quote state through the strict active-generation cache scope before mutation',()=>{
  assert.equal(isCurrentLiveGeneration(7,7),true);
  assert.equal(isCurrentLiveGeneration(6,7),false);
  assert.equal(isCurrentLiveGeneration(undefined,7),false);
  const source=readFileSync(resolve(process.cwd(),'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts'),'utf8');
  const tick=source.slice(source.indexOf('const handleTick'),source.indexOf('const handleDepth'));
  const depth=source.slice(source.indexOf('const handleDepth'),source.indexOf('const activeIds'));
  assert.ok(tick.indexOf('latestGenerationScope.accept(t.generationId, connection.getGenerationId(), () => latest.clear())') >= 0);
  assert.ok(tick.indexOf('latestGenerationScope.accept(t.generationId, connection.getGenerationId(), () => latest.clear())') < tick.indexOf('latest.set('));
  assert.ok(depth.indexOf('latestGenerationScope.accept(d.generationId, connection.getGenerationId(), () => latest.clear())') >= 0);
  assert.ok(depth.indexOf('latestGenerationScope.accept(d.generationId, connection.getGenerationId(), () => latest.clear())') < depth.indexOf('latest.set('));
});

test('V8 live candle input rejects stale and missing generations before it can become a completed evaluation candle',()=>{
  const bus=new EventEmitter(); const generation=7; const builder=new LiveCandleBuilderService(); const candles=new LiveCandleEventAdapterService(builder,bus,()=>generation); const completed:unknown[]=[];
  bus.on('market.candle.completed',(event)=>completed.push(event)); candles.start();
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:45:00.000Z',ltp:24000,generationId:6});
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:46:00.000Z',ltp:24001});
  assert.equal(completed.length,0); assert.equal(builder.getActiveCandle('NSE_INDEX|Nifty 50','2m'),undefined);
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:45:00.000Z',ltp:24000,generationId:7});
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:47:00.000Z',ltp:24002,generationId:6});
  assert.equal(completed.filter((event:any)=>event.timeframe==='2m').length,0);
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:47:00.000Z',ltp:24002,generationId:7});
  assert.equal(completed.filter((event:any)=>event.timeframe==='2m').length,1);
});

test('V8 first current-generation tick after reconnect cannot complete the prior-generation active candle',()=>{
  const bus=new EventEmitter();let generation=7;const builder=new LiveCandleBuilderService();const candles=new LiveCandleEventAdapterService(builder,bus,()=>generation);const completed:unknown[]=[];
  bus.on('market.candle.completed',(event)=>completed.push(event));candles.start();
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:45:00.000Z',ltp:24000,generationId:7});
  generation=8;
  bus.emit('market.tick',{instrumentKey:'NSE_INDEX|Nifty 50',timestamp:'2026-08-10T03:47:00.000Z',ltp:24100,generationId:8});
  assert.equal(completed.filter((event:any)=>event.timeframe==='2m').length,0);
  const active=builder.getActiveCandle('NSE_INDEX|Nifty 50','2m');assert.equal(active?.open,24100);assert.equal(active?.low,24100);assert.equal(active?.high,24100);
});
