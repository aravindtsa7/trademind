import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from './market-data-recovery-coordinator.service';

test('1006 recovery stays gated until backfill continuity and a fresh live tick', async () => {
  const events: string[]=[]; let recovered=0;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'FRESH',missingMinutes:0,duplicateMinutes:0}),onRecovered:()=>{recovered+=1;},onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect(); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleReconnected(); await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(new Date()); assert.equal(coordinator.isEvaluationReady(),true); assert.equal(recovered,1);
  assert.deepEqual(events,['MARKET_DATA_DEGRADED','RECONNECT_STARTED','DATA_GAP_DETECTED','RECONNECT_SUCCEEDED','MARKET_DATA_BACKFILL_STARTED','MARKET_DATA_BACKFILL_COMPLETED','MARKET_DATA_FRESH_TICK_CONFIRMED','DATA_GAP_RECOVERED','MARKET_DATA_READY']);
});
test('unrecoverable current-day gap fails closed and never becomes evaluation-ready',async()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:false,reason:'MISSING_MINUTE',missingMinutes:1,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect();coordinator.handleReconnected();await new Promise((resolve)=>setImmediate(resolve));coordinator.handleLiveTick(new Date());
  assert.equal(coordinator.getState(),'FAULTED');assert.equal(coordinator.isEvaluationReady(),false);assert.ok(events.includes('DATA_GAP_UNRECOVERABLE'));
});
test('EOD stop cancels an in-flight recovery and never returns READY', async()=>{
  let resolve!: (value: {ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number})=>void;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise((r)=>{resolve=r;})});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});coordinator.stop();resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});
  await new Promise((r)=>setImmediate(r));assert.equal(coordinator.getState(),'STOPPED');assert.equal(coordinator.isEvaluationReady(),false);
});
test('a tick received before continuity backfill cannot make recovery ready', async()=>{
  let resolve!: (value: {ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number})=>void;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise((r)=>{resolve=r;})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); coordinator.handleReconnected({generationId:2}); coordinator.handleLiveTick(new Date(),2);
  resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}); await new Promise((r)=>setImmediate(r));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK'); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(new Date(),2); assert.equal(coordinator.isEvaluationReady(),true);
});
test('duplicate disconnect and reconnect callbacks do not start two recovery loops',async()=>{
  let backfills=0;const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>{backfills+=1;return {ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0};}});
  coordinator.handleUnexpectedDisconnect();coordinator.handleUnexpectedDisconnect();coordinator.handleReconnected();coordinator.handleReconnected();await new Promise((resolve)=>setImmediate(resolve));assert.equal(backfills,1);
});
