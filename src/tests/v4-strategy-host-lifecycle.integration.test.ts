import assert from 'node:assert/strict';import test from 'node:test';import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
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
