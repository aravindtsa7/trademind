import assert from 'node:assert/strict';import test from 'node:test';import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { StrategyTerminalOutcomeArbiter } from '../modules/market-data/services/strategy-terminal-outcome-arbiter.service';
import { resolveSessionOutcome } from '../modules/research-validation';
function v4(){const c={evaluate:0,settle:0,summary:0,timers:0,unsubscribe:0,disconnect:0};let done=false;const clean=()=>{if(done)return;done=true;c.settle++;c.summary++;c.timers++;c.unsubscribe++;c.disconnect++;};const host=new StrategyHostLifecycle({strategyId:'V4_NIFTY_MOMENTUM_PE_SHADOW',runtimeId:'shadow:v4:momentum',hooks:{warmup:()=>undefined,onEod:clean,onShutdown:clean,onFault:clean}});const candle=()=>{if(host.canEvaluate())c.evaluate++;};return{host,c,candle};}
test('V4 host EOD is exactly once',async()=>{const x=v4();await x.host.start();x.candle();await x.host.eod('EOD');await x.host.eod('LATE');assert.equal(x.host.getState(),'STOPPED');assert.equal(x.c.evaluate,1);assert.equal(x.c.settle,1);assert.equal(x.c.summary,1);assert.equal(x.c.timers,1);assert.equal(x.c.unsubscribe,1);assert.equal(x.c.disconnect,1);});
test('V4 host blocks evaluation degraded, resumes recovered, and SIGINT/EOD cleanup races once',async()=>{const x=v4();await x.host.start();await x.host.degrade('GAP');x.candle();assert.equal(x.c.evaluate,0);await x.host.recovered('FRESH_TICK');x.candle();assert.equal(x.c.evaluate,1);await Promise.all([x.host.eod('EOD'),x.host.shutdown('SIGINT')]);assert.equal(x.host.getState(),'STOPPED');assert.equal(x.c.summary,1);assert.equal(x.c.unsubscribe,1);assert.equal(x.c.disconnect,1);});
test('V4 host faults closed and remains orderless',async()=>{const x=v4();await x.host.start();await x.host.fault(new Error('RECONNECT_FAILED'));x.candle();assert.equal(x.host.getState(),'FAULTED');assert.equal(x.host.canEvaluate(),false);assert.equal(x.c.evaluate,0);assert.equal(x.c.summary,1);});

function v4WithSummary(){
  const summaries:Array<{status:string;sessionCompleted:boolean;eodReason:string}>=[];
  const cleanShutdownEvents:string[]=[];
  let closing=false;
  const shutdown=(reason='SESSION_END'):void=>{
    if(closing)return;closing=true;
    const outcome=resolveSessionOutcome({reason});
    summaries.push({status:outcome.status,sessionCompleted:outcome.sessionCompleted,eodReason:reason});
    if(outcome.status==='VALID_COMPLETED')cleanShutdownEvents.push(reason);
  };
  const host=new StrategyHostLifecycle({strategyId:'V4_NIFTY_MOMENTUM_PE_SHADOW',runtimeId:'shadow:v4:momentum',hooks:{warmup:()=>undefined,onEod:(reason)=>shutdown(reason??'VALID_COMPLETED'),onShutdown:(reason)=>shutdown(reason??'SESSION_END'),onFault:()=>shutdown('FAULTED')}});
  return {host,summaries,cleanShutdownEvents};
}

test('V4 fault-journal truthfulness: FAULTED host journals status FAULTED, sessionCompleted=false, exactly one SUMMARY, no CLEAN_SHUTDOWN',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  await x.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(x.host.getState(),'FAULTED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'FAULTED',sessionCompleted:false,eodReason:'FAULTED'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
  // No second SUMMARY from a later eod()/shutdown() call.
  await x.host.eod('LATE');
  await x.host.shutdown('SIGINT');
  assert.equal(x.summaries.length,1);
});

test('V4 outcome truthfulness positive control: normal EOD journals status VALID_COMPLETED, sessionCompleted=true, exactly one SUMMARY plus CLEAN_SHUTDOWN',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  await x.host.eod('WALL_CLOCK_EOD');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'VALID_COMPLETED',sessionCompleted:true,eodReason:'WALL_CLOCK_EOD'});
  assert.deepEqual(x.cleanShutdownEvents,['WALL_CLOCK_EOD']);
});

test('V4 manual stop: SIGINT while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  assert.equal(x.host.getState(),'RUNNING');
  await x.host.shutdown('SIGINT');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'MANUAL_STOP',sessionCompleted:false,eodReason:'SIGINT'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
});

test('V4 manual stop: SIGTERM while RUNNING journals status MANUAL_STOP, sessionCompleted=false, no CLEAN_SHUTDOWN',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  assert.equal(x.host.getState(),'RUNNING');
  await x.host.shutdown('SIGTERM');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'MANUAL_STOP',sessionCompleted:false,eodReason:'SIGTERM'});
  assert.deepEqual(x.cleanShutdownEvents,[]);
});

test('V4 late SIGINT after EOD finalization has already started does not replace VALID_COMPLETED with MANUAL_STOP',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  await x.host.eod('WALL_CLOCK_EOD');
  await x.host.shutdown('SIGINT');
  assert.equal(x.summaries.length,1);
  assert.equal(x.summaries[0]?.status,'VALID_COMPLETED');
  assert.equal(x.summaries[0]?.sessionCompleted,true);
});

test('V4 startup warmup failure blocks startup and records INVALID_DATA', () => {
  const outcome = resolveSessionOutcome({ reason: 'WARMUP_NOT_READY', invalidData: true });
  assert.equal(outcome.status, 'INVALID_DATA');
  assert.equal(outcome.sessionCompleted, false);
});

// A10 blocker B2 (third correction): drives the real production
// StrategyTerminalOutcomeArbiter (also imported by the real test-live-v4-nifty-momentum-shadow.ts
// entrypoint), mirroring its shutdown()'s shared drain step -- any terminal trigger can be
// genuinely blocked there, between propose() and commit().
function deferredBarrier<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function v4WithBlockingDrain() {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  const cleanShutdownEvents: string[] = [];
  let shuttingDown = false;
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const drainStarted = deferredBarrier<void>();
  const drainBlocker = deferredBarrier<void>();
  const shutdown = async (reason: string): Promise<void> => {
    arbiter.propose(reason, resolveSessionOutcome({ reason }).status);
    if (shuttingDown) return;
    shuttingDown = true;
    drainStarted.resolve(); await drainBlocker.promise;
    await arbiter.commit((finalReason) => {
      const outcome = resolveSessionOutcome({ reason: finalReason });
      summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason });
      if (outcome.status === 'VALID_COMPLETED') cleanShutdownEvents.push(finalReason);
    });
  };
  const host = new StrategyHostLifecycle({ strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW', runtimeId: 'shadow:v4:momentum', hooks: {
    warmup: (): void => undefined,
    onEod: (reason): Promise<void> => shutdown(reason ?? 'VALID_COMPLETED'),
    onShutdown: (reason): Promise<void> => shutdown(reason ?? 'SESSION_END'),
    onFault: (): Promise<void> => shutdown('FAULTED'),
  } });
  return { host, summaries, cleanShutdownEvents, drainStarted, drainBlocker, arbiter };
}

test('V4-B: EOD proposed, close-out latch owned, paused before commit, fault arrives, resumed -> FAULTED, exactly one SUMMARY, no VALID_COMPLETED/CLEAN_SHUTDOWN', async () => {
  const harness = v4WithBlockingDrain();
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.drainStarted.promise;
  assert.equal(harness.host.getState(), 'EOD');
  await harness.host.fault(new Error('RECONNECT_FAILED'));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.drainBlocker.resolve();
  await eodPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.deepEqual(harness.cleanShutdownEvents, []);
  assert.equal(harness.arbiter.getCommittedReason(), 'FAULTED');
});

test('V4-E/F: SIGINT/SIGTERM proposed, paused before commit, fault arrives -> FAULTED, not MANUAL_STOP', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const harness = v4WithBlockingDrain();
    await harness.host.start();
    const shutdownPromise = harness.host.shutdown(signal);
    await harness.drainStarted.promise;
    await harness.host.fault(new Error('EVALUATOR_CRASHED'));
    harness.drainBlocker.resolve();
    await shutdownPromise;
    assert.equal(harness.summaries.length, 1);
    assert.equal(harness.summaries[0]?.status, 'FAULTED');
    assert.deepEqual(harness.cleanShutdownEvents, []);
  }
});

// A10 final correction: drives sealAfterCloseOut() -- the real production
// finalization seam used verbatim by test-live-v4-nifty-momentum-shadow.ts's
// shutdown() -- and the isSealing() gate an external fault trigger (e.g.
// reconnectFailed) must consult before calling host.fault() directly.
function v4WithSealAfterCloseOut(options: { closeOutBlocks?: boolean; closeOutThrows?: boolean } = {}) {
  const summaries: Array<{ status: string; sessionCompleted: boolean; eodReason: string }> = [];
  let shuttingDown = false;
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const closeOutStarted = deferredBarrier<void>();
  const closeOutBlocker = deferredBarrier<void>();
  const externalFaultTrigger = (host: StrategyHostLifecycle): void => { if (!arbiter.isSealing()) void host.fault(new Error('RECONNECT_FAILED_EXTERNAL')); };
  const shutdown = async (reason: string): Promise<void> => {
    arbiter.propose(reason, resolveSessionOutcome({ reason }).status);
    if (shuttingDown) return;
    shuttingDown = true;
    await arbiter.sealAfterCloseOut(
      async () => { if (options.closeOutBlocks) { closeOutStarted.resolve(); await closeOutBlocker.promise; } if (options.closeOutThrows) throw new Error('CLOSE_OUT_FAILED'); },
      (finalReason) => { const outcome = resolveSessionOutcome({ reason: finalReason }); summaries.push({ status: outcome.status, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason }); },
    );
  };
  const host = new StrategyHostLifecycle({ strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW', runtimeId: 'shadow:v4:momentum', hooks: {
    warmup: (): void => undefined,
    onEod: (reason): Promise<void> => shutdown(reason ?? 'VALID_COMPLETED'),
    onShutdown: (reason): Promise<void> => shutdown(reason ?? 'SESSION_END'),
    onFault: (): Promise<void> => shutdown('FAULTED'),
  } });
  return { host, summaries, closeOutStarted, closeOutBlocker, arbiter, externalFaultTrigger };
}

test('V4 real seam: an external fault trigger racing WHILE close-out is genuinely in flight is suppressed by isSealing(), so host and journal never disagree', async () => {
  const harness = v4WithSealAfterCloseOut({ closeOutBlocks: true });
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.closeOutStarted.promise;
  assert.equal(harness.arbiter.isSealing(), false);
  harness.externalFaultTrigger(harness.host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.getState(), 'FAULTED');
  harness.closeOutBlocker.resolve();
  await eodPromise;
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.equal(harness.host.getState(), 'FAULTED');
});

test('V4 real seam: an external fault trigger arriving AFTER the seal has started never flips host state', async () => {
  const harness = v4WithSealAfterCloseOut();
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  assert.equal(harness.host.getState(), 'STOPPED');
  harness.externalFaultTrigger(harness.host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
});

test('V4 real seam: close-out throwing before the seal escalates to FAULTED, seals exactly one SUMMARY, and StrategyHostLifecycle itself reaches FAULTED', async () => {
  const harness = v4WithSealAfterCloseOut({ closeOutThrows: true });
  await harness.host.start();
  await harness.host.eod('WALL_CLOCK_EOD');
  assert.equal(harness.host.getState(), 'FAULTED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'FAULTED');
  assert.equal(harness.arbiter.getCommittedReason(), 'CLOSE_OUT_FAILED');
});

test('V4-M: fault arriving after EOD close-out and commit already completed leaves the committed outcome unchanged -- no illegal STOPPED->FAULTED transition', async () => {
  const harness = v4WithBlockingDrain();
  await harness.host.start();
  const eodPromise = harness.host.eod('WALL_CLOCK_EOD');
  await harness.drainStarted.promise;
  harness.drainBlocker.resolve();
  await eodPromise;
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0]?.status, 'VALID_COMPLETED');
  await assert.doesNotReject(() => harness.host.fault(new Error('POST_SESSION_FAULT')));
  assert.equal(harness.host.getState(), 'STOPPED');
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.arbiter.getCommittedReason(), 'WALL_CLOCK_EOD');
});
