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
