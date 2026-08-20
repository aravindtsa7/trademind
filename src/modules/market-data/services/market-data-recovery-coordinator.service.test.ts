import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from './market-data-recovery-coordinator.service';

test('1006 recovery stays gated until backfill continuity and a fresh live tick', async () => {
  const events: string[]=[]; let recovered=0;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'FRESH',missingMinutes:0,duplicateMinutes:0}),onRecovered:()=>{recovered+=1;return undefined;},onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect({generationId:1}); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleReconnected({generationId:2}); await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(new Date(),2); assert.equal(coordinator.isEvaluationReady(),true); assert.equal(recovered,1);
  assert.deepEqual(events,['MARKET_DATA_DEGRADED','RECONNECT_STARTED','DATA_GAP_DETECTED','RECONNECT_SUCCEEDED','MARKET_DATA_BACKFILL_STARTED','MARKET_DATA_BACKFILL_COMPLETED','MARKET_DATA_FRESH_TICK_CONFIRMED','DATA_GAP_RECOVERED','MARKET_DATA_READY']);
});
test('unrecoverable current-day gap fails closed and never becomes evaluation-ready',async()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:false,reason:'MISSING_MINUTE',missingMinutes:1,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});await new Promise((resolve)=>setImmediate(resolve));coordinator.handleLiveTick(new Date(),2);
  assert.equal(coordinator.getState(),'FAULTED');assert.equal(coordinator.isEvaluationReady(),false);assert.ok(events.includes('DATA_GAP_UNRECOVERABLE'));
});
test('EOD stop cancels an in-flight recovery and never returns READY', async()=>{
  let resolve!: (value: {ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number})=>void;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise<{ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number}>((r)=>{resolve=r;})});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});coordinator.stop();resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});
  await new Promise((r)=>setImmediate(r));assert.equal(coordinator.getState(),'STOPPED');assert.equal(coordinator.isEvaluationReady(),false);
});
test('a tick received before continuity backfill cannot make recovery ready', async()=>{
  let resolve!: (value: {ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number})=>void;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise<{ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number}>((r)=>{resolve=r;})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); coordinator.handleReconnected({generationId:2}); coordinator.handleLiveTick(new Date(),2);
  resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}); await new Promise((r)=>setImmediate(r));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK'); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(new Date(),2); assert.equal(coordinator.isEvaluationReady(),true);
});
test('only a present current-generation live tick can complete recovery', async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); coordinator.handleReconnected({generationId:2});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(new Date(), 1);
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(new Date());
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(new Date(), 2);
  assert.equal(coordinator.isEvaluationReady(),true);
});
test('duplicate disconnect and reconnect callbacks do not start two recovery loops',async()=>{
  let backfills=0;const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>{backfills+=1;return {ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0};}});
  coordinator.handleUnexpectedDisconnect();coordinator.handleUnexpectedDisconnect();coordinator.handleReconnected();coordinator.handleReconnected();await new Promise((resolve)=>setImmediate(resolve));assert.equal(backfills,1);
});

test('a newer generation is retained while stale backfill is in flight and stale success cannot become READY',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number;recoveryData?:string};
  const resolvers:Array<(value:Result)=>void>=[];const recovered:Array<{generationId:number;data:string|undefined}>=[];let calls=0;
  const coordinator=new MarketDataRecoveryCoordinatorService<string>({backfill:async()=>{calls+=1;return new Promise<Result>((resolve)=>resolvers.push(resolve));},onRecovered:(generationId,data)=>{recovered.push({generationId,data});return undefined;}});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});assert.equal(calls,1);assert.equal(coordinator.getState(),'BACKFILLING');
  coordinator.handleUnexpectedDisconnect({generationId:2});coordinator.handleReconnected({generationId:3});assert.equal(coordinator.getGenerationId(),3);assert.equal(calls,2);
  resolvers[1]({ready:true,reason:'CURRENT_G3',missingMinutes:0,duplicateMinutes:0,recoveryData:'G3'});await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');assert.deepEqual(recovered,[{generationId:3,data:'G3'}]);
  resolvers[0]({ready:true,reason:'STALE_G2',missingMinutes:0,duplicateMinutes:0,recoveryData:'G2'});await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');coordinator.handleLiveTick(new Date(),2);assert.equal(coordinator.isEvaluationReady(),false);coordinator.handleLiveTick(new Date(),3);assert.equal(coordinator.isEvaluationReady(),true);assert.deepEqual(recovered,[{generationId:3,data:'G3'}]);
});

test('stale backfill failure cannot fault a newer recovery generation',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  const pending:Array<{resolve:(value:Result)=>void;reject:(error:Error)=>void}>=[];
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise<Result>((resolve,reject)=>pending.push({resolve,reject}))});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});coordinator.handleUnexpectedDisconnect({generationId:2});coordinator.handleReconnected({generationId:3});
  assert.equal(pending.length,2);pending[0].reject(new Error('stale G2 failure'));await new Promise((resolve)=>setImmediate(resolve));assert.equal(coordinator.getState(),'BACKFILLING');
  pending[1].resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});await new Promise((resolve)=>setImmediate(resolve));assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');assert.notEqual(coordinator.getState(),'FAULTED');
});

test('a superseding disconnect resets the fresh-tick timestamp boundary',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};let now=100;const resolvers:Array<(value:Result)=>void>=[];
  const coordinator=new MarketDataRecoveryCoordinatorService({nowMs:()=>now,backfill:async()=>new Promise<Result>((resolve)=>resolvers.push(resolve))});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});now=200;coordinator.handleUnexpectedDisconnect({generationId:2});coordinator.handleReconnected({generationId:3});resolvers[1]({ready:true,reason:'CURRENT',missingMinutes:0,duplicateMinutes:0});await new Promise((resolve)=>setImmediate(resolve));resolvers[0]({ready:true,reason:'STALE',missingMinutes:0,duplicateMinutes:0});await new Promise((resolve)=>setImmediate(resolve));
  coordinator.handleLiveTick(new Date(150),3);assert.equal(coordinator.isEvaluationReady(),false);coordinator.handleLiveTick(new Date(201),3);assert.equal(coordinator.isEvaluationReady(),true);
});

test('a synchronous fault raised by a READY listener suppresses recovered and ready events',async()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.on('stateChanged',(state)=>{if(state==='READY')coordinator.fault('NESTED_READY_FAILURE');});coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});await new Promise((resolve)=>setImmediate(resolve));coordinator.handleLiveTick(new Date(),2);
  assert.equal(coordinator.getState(),'FAULTED');assert.equal(coordinator.isEvaluationReady(),false);assert.equal(events.includes('DATA_GAP_RECOVERED'),false);assert.equal(events.includes('MARKET_DATA_READY'),false);
});
