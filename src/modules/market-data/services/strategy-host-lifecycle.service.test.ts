import assert from 'node:assert/strict';import test from 'node:test';import { StrategyHostLifecycle } from './strategy-host-lifecycle.service';import { NseSessionClock, NseSessionEodCoordinator } from './nse-session-calendar.service';
test('strategy host has deterministic warmup, recovery, EOD and shutdown transitions',async()=>{const events:string[]=[];const push=(value:string):void=>{events.push(value);};const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>push('warmup'),onDegraded:()=>push('degraded'),onRecovered:()=>push('recovered'),onEod:()=>push('eod'),onShutdown:()=>push('shutdown')}});await host.start();assert.equal(host.getState(),'RUNNING');await host.degrade();assert.equal(host.canEvaluate(),false);await host.recovered();assert.equal(host.canEvaluate(),true);await host.eod();await host.eod();assert.equal(host.getState(),'STOPPED');assert.deepEqual(events,['warmup','degraded','recovered','eod','shutdown']);});
test('strategy host faults closed and rejects illegal transitions',async()=>{const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{throw new Error('warmup');},onEod:()=>{},onShutdown:()=>{}}});await host.start();assert.equal(host.getState(),'FAULTED');assert.throws(()=>host.transition('RUNNING','bad'));});
test('strategy host fault reason extraction survives a hostile Error.message getter -- FAULTED is reached, never left RUNNING',async()=>{const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:()=>{},onShutdown:()=>{}}});await host.start();const hostile=new Error('original');Object.defineProperty(hostile,'message',{get(){throw new Error('MESSAGE_GETTER_FAILED');}});await assert.doesNotReject(()=>host.fault(hostile));assert.equal(host.getState(),'FAULTED');assert.equal(host.canEvaluate(),false);});
test('strategy host fault reason extraction falls back to UNKNOWN_FAULT for a hostile non-Error whose instanceof check throws',async()=>{const reasons:string[]=[];const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:()=>{},onShutdown:()=>{}},log:(e)=>{if(e.state==='FAULTED')reasons.push(e.reason);}});await host.start();const hostileProxy=new Proxy({},{getPrototypeOf(){throw new Error('PROXY_TRAP_FAILED');}});await assert.doesNotReject(()=>host.fault(hostileProxy));assert.deepEqual(reasons,['UNKNOWN_FAULT']);assert.equal(host.getState(),'FAULTED');});
test('strategy host fault reason extraction leaves an ordinary Error.message unchanged',async()=>{const reasons:string[]=[];const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:()=>{},onShutdown:()=>{}},log:(e)=>{if(e.state==='FAULTED')reasons.push(e.reason);}});await host.start();await host.fault(new Error('NORMAL_FAULT'));assert.deepEqual(reasons,['NORMAL_FAULT']);});
test('strategy host reaches FAULTED and stays non-evaluable even when eodCoordinator.cancelScheduled() throws -- cancellation failure can never leave the host RUNNING',async()=>{
  const hostileClock:NseSessionClock={now:()=>new Date(),setTimeout:(callback,delayMs)=>setTimeout(callback,delayMs),clearTimeout:()=>{throw new Error('CANCEL_FAILED');}};
  const eodCoordinator=new NseSessionEodCoordinator(undefined,hostileClock);
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',eodCoordinator,hooks:{warmup:()=>{},onEod:()=>{},onShutdown:()=>{}}});
  await host.start();
  assert.equal(host.getState(),'RUNNING'); // schedule() ran during start(), so a real timer now exists for cancelScheduled() to fail on
  const unhandled:unknown[]=[];const captureUnhandled=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',captureUnhandled);
  let faultRejection:unknown;
  try{
    await host.fault(new Error('EVALUATOR_FAILED')).catch((error)=>{faultRejection=error;});
    await new Promise((resolve)=>setImmediate(resolve));
  }finally{process.off('unhandledRejection',captureUnhandled);}
  assert.deepEqual(unhandled,[]);
  assert.equal(host.getState(),'FAULTED');
  assert.equal(host.canEvaluate(),false);
  assert.ok(faultRejection instanceof Error);
  assert.equal((faultRejection as Error).message,'CANCEL_FAILED'); // the cancellation failure remains observable via fault()'s own rejection, exactly like an onFault rejection
});
test('strategy host repeated fault() calls remain idempotent even after a cancelScheduled() failure',async()=>{
  const hostileClock:NseSessionClock={now:()=>new Date(),setTimeout:(callback,delayMs)=>setTimeout(callback,delayMs),clearTimeout:()=>{throw new Error('CANCEL_FAILED');}};
  const eodCoordinator=new NseSessionEodCoordinator(undefined,hostileClock);
  let onFaultCalls=0;
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',eodCoordinator,hooks:{warmup:()=>{},onEod:()=>{},onShutdown:()=>{},onFault:()=>{onFaultCalls+=1;}}});
  await host.start();
  await host.fault(new Error('FIRST_FAULT')).catch(()=>undefined);
  assert.equal(host.getState(),'FAULTED');
  assert.equal(onFaultCalls,0); // cancelScheduled() threw before onFault ran -- deterministic, no new aggregate-error architecture
  await host.fault(new Error('SECOND_FAULT'));
  assert.equal(host.getState(),'FAULTED');
  assert.equal(onFaultCalls,0); // idempotency guard: a repeated fault() call after FAULTED is a pure no-op
});

// ============================================================
// B2: fault vs EOD/shutdown terminal-race arbitration.
// A racing fault() transitions to FAULTED synchronously and is the sole
// authoritative terminal outcome from that point on. An already-started onEod
// or onShutdown call cannot be un-run, but the *other* half of the EOD/shutdown
// terminal-hook family must never fire afterward.
// ============================================================
function deferredBarrier<T = void>():{promise:Promise<T>;resolve:(value:T)=>void}{
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>((res)=>{resolve=res;});
  return {promise,resolve};
}

test('B2-A: a fault arriving while onEod is still blocked wins -- FAULTED is final, onShutdown never runs, no duplicate terminal hook family',async()=>{
  const calls:string[]=[];
  const eodStarted=deferredBarrier<void>();
  const eodGate=deferredBarrier<void>();
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{
    warmup:()=>{},
    onEod:async()=>{calls.push('onEod:start');eodStarted.resolve();await eodGate.promise;calls.push('onEod:end');},
    onShutdown:async()=>{calls.push('onShutdown');},
    onFault:async()=>{calls.push('onFault');},
  }});
  await host.start();
  const eodPromise=host.eod('WALL_CLOCK_EOD');
  await eodStarted.promise; // onEod is now genuinely blocked mid-flight
  assert.equal(host.getState(),'EOD');
  await host.fault(new Error('RACE_FAULT'));
  assert.equal(host.getState(),'FAULTED');
  assert.equal(host.canEvaluate(),false);
  eodGate.resolve(); // let the already-started onEod finish -- it cannot be un-run
  await eodPromise;
  assert.deepEqual(calls,['onEod:start','onFault','onEod:end']); // onShutdown never runs: no duplicate terminal hook family
  assert.equal(host.getState(),'FAULTED'); // no valid clean-EOD outcome survives
});

test('B2-B: fault arriving before eod() leaves FAULTED authoritative; EOD cannot replace it',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await host.fault(new Error('FAULT_FIRST'));
  assert.equal(host.getState(),'FAULTED');
  await host.eod('WALL_CLOCK_EOD');
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onFault']);
});

test('B2-C: fault arriving while a manual shutdown is in flight still ends FAULTED with exactly one authoritative terminalization',async()=>{
  const calls:string[]=[];
  const shutdownStarted=deferredBarrier<void>();
  const shutdownGate=deferredBarrier<void>();
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{
    warmup:()=>{},
    onEod:async()=>{calls.push('onEod');},
    onShutdown:async()=>{calls.push('onShutdown:start');shutdownStarted.resolve();await shutdownGate.promise;calls.push('onShutdown:end');},
    onFault:async()=>{calls.push('onFault');},
  }});
  await host.start();
  const shutdownPromise=host.shutdown('SIGINT');
  await shutdownStarted.promise; // onShutdown is now genuinely blocked mid-flight
  await host.fault(new Error('RACE_FAULT'));
  assert.equal(host.getState(),'FAULTED');
  shutdownGate.resolve();
  await shutdownPromise;
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onShutdown:start','onFault','onShutdown:end']);
});

test('B2-D: Promise.all([eod(), fault()]) deterministically resolves FAULTED with no duplicate terminal hooks',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await Promise.all([host.eod('WALL_CLOCK_EOD'),host.fault(new Error('RACE_FAULT'))]);
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onEod','onFault']);
});

test('B2-E: reverse-order Promise.all([fault(), eod()]) still leaves FAULTED authoritative and EOD a no-op',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await Promise.all([host.fault(new Error('RACE_FAULT')),host.eod('WALL_CLOCK_EOD')]);
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onFault']);
});

test('B2-F: concurrent repeated fault() calls are idempotent -- exactly one onFault finalization',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{},onShutdown:async()=>{},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await Promise.all([host.fault(new Error('A')),host.fault(new Error('B')),host.fault(new Error('C'))]);
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onFault']);
});

test('B2-G: normal EOD positive control -- no racing fault -- still runs onEod then onShutdown exactly once and reaches STOPPED',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await host.eod('WALL_CLOCK_EOD');
  assert.equal(host.getState(),'STOPPED');
  assert.deepEqual(calls,['onEod','onShutdown']);
});

test('B2-H: SIGINT racing EOD joins the single terminal path -- exactly one cleanup, STOPPED',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await Promise.all([host.eod('WALL_CLOCK_EOD'),host.shutdown('SIGINT')]);
  assert.equal(host.getState(),'STOPPED');
  assert.deepEqual(calls,['onEod','onShutdown']);
});

test('B2-I: SIGTERM racing a genuinely blocked in-flight EOD still joins the single terminal path exactly once',async()=>{
  const calls:string[]=[];
  const eodStarted=deferredBarrier<void>();
  const eodGate=deferredBarrier<void>();
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{
    warmup:()=>{},
    onEod:async()=>{calls.push('onEod:start');eodStarted.resolve();await eodGate.promise;calls.push('onEod:end');},
    onShutdown:async()=>{calls.push('onShutdown');},
    onFault:async()=>{calls.push('onFault');},
  }});
  await host.start();
  const eodPromise=host.eod('WALL_CLOCK_EOD');
  await eodStarted.promise;
  const shutdownPromise=host.shutdown('SIGTERM'); // genuinely concurrent: fires while onEod is mid-flight, not sequentially awaited
  eodGate.resolve();
  await Promise.all([eodPromise,shutdownPromise]);
  assert.equal(host.getState(),'STOPPED');
  assert.deepEqual(calls,['onEod:start','onEod:end','onShutdown']); // shutdown() joined the same single-flight; onShutdown ran exactly once
});

test('B2-J: onEod rejecting is contained and escalates to FAULTED without recursion or deadlock',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');throw new Error('EOD_HOOK_FAILED');},onShutdown:async()=>{calls.push('onShutdown');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await host.eod('WALL_CLOCK_EOD');
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onEod','onFault']); // onShutdown never runs; fault() is not re-entered recursively
  assert.equal(host.canEvaluate(),false);
});

test('B2-K: onShutdown rejecting after onEod succeeds is contained and escalates to FAULTED without recursion or deadlock',async()=>{
  const calls:string[]=[];
  const host=new StrategyHostLifecycle({strategyId:'test',runtimeId:'r',hooks:{warmup:()=>{},onEod:async()=>{calls.push('onEod');},onShutdown:async()=>{calls.push('onShutdown');throw new Error('SHUTDOWN_HOOK_FAILED');},onFault:async()=>{calls.push('onFault');}}});
  await host.start();
  await host.eod('WALL_CLOCK_EOD');
  assert.equal(host.getState(),'FAULTED');
  assert.deepEqual(calls,['onEod','onShutdown','onFault']);
});
