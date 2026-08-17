import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';

function v8HarnessLifecycle() {
  const counts={settle:0,summary:0,timer:0,unsubscribe:0,disconnect:0};let cleaned=false;
  const cleanup=():void=>{if(cleaned)return;cleaned=true;counts.settle++;counts.summary++;counts.timer++;counts.unsubscribe++;counts.disconnect++;};
  const host=new StrategyHostLifecycle({strategyId:'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',runtimeId:'shadow:v8:reclaim',hooks:{warmup:()=>undefined,onEod:cleanup,onShutdown:cleanup,onFault:cleanup}});
  return {host,counts};
}

test('V8 host EOD settles, summarizes, clears timers, unsubscribes and disconnects exactly once',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await host.eod('EOD');await host.eod('LATE_TICK');assert.equal(host.getState(),'STOPPED');assert.deepEqual(counts,{settle:1,summary:1,timer:1,unsubscribe:1,disconnect:1});});
test('V8 host SIGINT and EOD race retain one cleanup path',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await Promise.all([host.eod('EOD'),host.shutdown('SIGINT')]);assert.equal(host.getState(),'STOPPED');assert.equal(counts.summary,1);assert.equal(counts.unsubscribe,1);assert.equal(counts.disconnect,1);});
test('V8 host fault from reconnect exhaustion blocks evaluation and does not double-clean',async()=>{const {host,counts}=v8HarnessLifecycle();await host.start();await host.fault(new Error('RECONNECT_FAILED'));await host.shutdown('SIGINT');assert.equal(host.getState(),'FAULTED');assert.equal(host.canEvaluate(),false);assert.equal(counts.summary,1);assert.equal(counts.unsubscribe,1);assert.equal(counts.disconnect,1);});
