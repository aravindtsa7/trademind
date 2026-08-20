import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
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
