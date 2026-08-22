import assert from 'node:assert/strict';import test from 'node:test';import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
function v4(){const c={evaluate:0,settle:0,summary:0,timers:0,unsubscribe:0,disconnect:0};let done=false;const clean=()=>{if(done)return;done=true;c.settle++;c.summary++;c.timers++;c.unsubscribe++;c.disconnect++;};const host=new StrategyHostLifecycle({strategyId:'V4_NIFTY_MOMENTUM_PE_SHADOW',runtimeId:'shadow:v4:momentum',hooks:{warmup:()=>undefined,onEod:clean,onShutdown:clean,onFault:clean}});const candle=()=>{if(host.canEvaluate())c.evaluate++;};return{host,c,candle};}
test('V4 host EOD is exactly once',async()=>{const x=v4();await x.host.start();x.candle();await x.host.eod('EOD');await x.host.eod('LATE');assert.equal(x.host.getState(),'STOPPED');assert.equal(x.c.evaluate,1);assert.equal(x.c.settle,1);assert.equal(x.c.summary,1);assert.equal(x.c.timers,1);assert.equal(x.c.unsubscribe,1);assert.equal(x.c.disconnect,1);});
test('V4 host blocks evaluation degraded, resumes recovered, and SIGINT/EOD cleanup races once',async()=>{const x=v4();await x.host.start();await x.host.degrade('GAP');x.candle();assert.equal(x.c.evaluate,0);await x.host.recovered('FRESH_TICK');x.candle();assert.equal(x.c.evaluate,1);await Promise.all([x.host.eod('EOD'),x.host.shutdown('SIGINT')]);assert.equal(x.host.getState(),'STOPPED');assert.equal(x.c.summary,1);assert.equal(x.c.unsubscribe,1);assert.equal(x.c.disconnect,1);});
test('V4 host faults closed and remains orderless',async()=>{const x=v4();await x.host.start();await x.host.fault(new Error('RECONNECT_FAILED'));x.candle();assert.equal(x.host.getState(),'FAULTED');assert.equal(x.host.canEvaluate(),false);assert.equal(x.c.evaluate,0);assert.equal(x.c.summary,1);});

/**
 * Fix B harness: mirrors src/tests/test-live-v4-nifty-momentum-shadow.ts's
 * shutdown() exactly -- onEod/onShutdown call shutdown() with its default
 * reason, onFault calls shutdown('FAULTED') (StrategyHostLifecycle.fault()
 * is the only caller of onFault, and never calls onEod/onShutdown for a
 * faulted host, so 'FAULTED' is a reliable signal, not string-sniffing).
 */
function v4WithSummary(){
  const summaries:Array<{status:string;sessionCompleted:boolean;eodReason:string}>=[];
  const cleanShutdownEvents:string[]=[];
  let closing=false;
  const shutdown=(reason='SESSION_END'):void=>{if(closing)return;closing=true;const faulted=reason==='FAULTED';summaries.push({status:faulted?'FAULTED':'COMPLETED',sessionCompleted:!faulted,eodReason:reason});if(!faulted)cleanShutdownEvents.push(reason);};
  const host=new StrategyHostLifecycle({strategyId:'V4_NIFTY_MOMENTUM_PE_SHADOW',runtimeId:'shadow:v4:momentum',hooks:{warmup:()=>undefined,onEod:()=>shutdown(),onShutdown:()=>shutdown(),onFault:()=>shutdown('FAULTED')}});
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

test('V4 fault-journal truthfulness positive control: normal EOD still journals status COMPLETED, sessionCompleted=true, exactly one SUMMARY plus CLEAN_SHUTDOWN',async()=>{
  const x=v4WithSummary();
  await x.host.start();
  await x.host.eod('WALL_CLOCK_EOD');
  assert.equal(x.host.getState(),'STOPPED');
  assert.equal(x.summaries.length,1);
  assert.deepEqual(x.summaries[0],{status:'COMPLETED',sessionCompleted:true,eodReason:'SESSION_END'});
  assert.deepEqual(x.cleanShutdownEvents,['SESSION_END']);
});
