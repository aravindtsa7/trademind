import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService, { MarketDataInitialReadinessTimeoutError, MarketSessionNotActiveError } from './market-data-recovery-coordinator.service';

/** These tests exercise the RECEIVE_TIME boundary itself, so sourceTimestamp mirrors receivedAt unless a test deliberately needs them to diverge. */
function liveTick(at: Date, generationId?: number): { sourceTimestamp: Date; receivedAt: Date; generationId?: number } { return { sourceTimestamp: at, receivedAt: at, generationId }; }

test('1006 recovery stays gated until backfill continuity and a fresh live tick', async () => {
  const events: string[]=[]; let recovered=0;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'FRESH',missingMinutes:0,duplicateMinutes:0}),onRecovered:()=>{recovered+=1;return undefined;},onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect({generationId:1}); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleReconnected({generationId:2}); await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(liveTick(new Date(), 2)); assert.equal(coordinator.isEvaluationReady(),true); assert.equal(recovered,1);
  assert.deepEqual(events,['MARKET_DATA_DEGRADED','RECONNECT_STARTED','DATA_GAP_DETECTED','RECONNECT_SUCCEEDED','MARKET_DATA_BACKFILL_STARTED','MARKET_DATA_BACKFILL_COMPLETED','MARKET_DATA_FRESH_TICK_CONFIRMED','DATA_GAP_RECOVERED','MARKET_DATA_READY']);
});
test('unrecoverable current-day gap fails closed and never becomes evaluation-ready',async()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:false,reason:'MISSING_MINUTE',missingMinutes:1,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});await new Promise((resolve)=>setImmediate(resolve));coordinator.handleLiveTick(liveTick(new Date(), 2));
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
  coordinator.handleUnexpectedDisconnect({generationId:1}); coordinator.handleReconnected({generationId:2}); coordinator.handleLiveTick(liveTick(new Date(), 2));
  resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}); await new Promise((r)=>setImmediate(r));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK'); assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(liveTick(new Date(), 2)); assert.equal(coordinator.isEvaluationReady(),true);
});
test('only a present current-generation live tick can complete recovery', async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); coordinator.handleReconnected({generationId:2});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(liveTick(new Date(), 1));
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(liveTick(new Date()));
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(liveTick(new Date(), 2));
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
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');coordinator.handleLiveTick(liveTick(new Date(), 2));assert.equal(coordinator.isEvaluationReady(),false);coordinator.handleLiveTick(liveTick(new Date(), 3));assert.equal(coordinator.isEvaluationReady(),true);assert.deepEqual(recovered,[{generationId:3,data:'G3'}]);
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
  coordinator.handleLiveTick(liveTick(new Date(150), 3));assert.equal(coordinator.isEvaluationReady(),false);coordinator.handleLiveTick(liveTick(new Date(201), 3));assert.equal(coordinator.isEvaluationReady(),true);
});

test('a synchronous fault raised by a READY listener suppresses recovered and ready events',async()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.on('stateChanged',(state)=>{if(state==='READY')coordinator.fault('NESTED_READY_FAILURE');});coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});await new Promise((resolve)=>setImmediate(resolve));coordinator.handleLiveTick(liveTick(new Date(), 2));
  assert.equal(coordinator.getState(),'FAULTED');assert.equal(coordinator.isEvaluationReady(),false);assert.equal(events.includes('DATA_GAP_RECOVERED'),false);assert.equal(events.includes('MARKET_DATA_READY'),false);
});

// ---- A2: SOURCE_TIME vs RECEIVE_TIME ----

test('A2-1: broker clock skew -- a tick received after the reconnect boundary still proves freshness even though its own sourceTimestamp lags behind that boundary',async()=>{
  let now=5_500; const coordinator=new MarketDataRecoveryCoordinatorService({nowMs:()=>now,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); // recoveryStartedAt := 5_500 (RECEIVE_TIME)
  coordinator.handleReconnected({generationId:2}); await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  now=6_200; // local time the packet is actually accepted
  coordinator.handleLiveTick({ sourceTimestamp:new Date(5_200), receivedAt:new Date(now), generationId:2 }); // broker sourceTimestamp (5_200) is behind the 5_500 boundary; receivedAt (6_200) is not
  assert.equal(coordinator.isEvaluationReady(),true); // a sourceTime>=boundary comparison would have wrongly rejected this tick
});

test('A2-2: a tick claiming a future sourceTimestamp cannot shortcut readiness unless it was actually received after the reconnect boundary',async()=>{
  const now=5_500; const coordinator=new MarketDataRecoveryCoordinatorService({nowMs:()=>now,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleUnexpectedDisconnect({generationId:1}); // recoveryStartedAt := 5_500
  coordinator.handleReconnected({generationId:2}); await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick({ sourceTimestamp:new Date(9_000), receivedAt:new Date(5_100), generationId:2 }); // sourceTimestamp is well ahead of the boundary, but receivedAt (5_100) is not
  assert.equal(coordinator.isEvaluationReady(),false); // a sourceTime>=boundary comparison would have wrongly accepted this tick
  coordinator.handleLiveTick({ sourceTimestamp:new Date(9_000), receivedAt:new Date(5_600), generationId:2 }); // the same generation's next tick is genuinely received after the boundary
  assert.equal(coordinator.isEvaluationReady(),true);
});

// ---- A6: cold-start current-generation readiness ----

test('A6-1: a freshly constructed coordinator is not evaluation-ready',()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  assert.equal(coordinator.isEvaluationReady(),false);
  assert.equal(coordinator.getState(),'AWAITING_LIVE_TICK');
  assert.equal(coordinator.getGenerationId(),0);
});

test('A6-2: handleInitialConnected seeds the real first generation, not 0, and readiness stays false until a tick arrives',()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date(1_000)});
  assert.equal(coordinator.getGenerationId(),1);
  assert.equal(coordinator.isEvaluationReady(),false);
});

test('A6-3: socket-open/subscribe alone (handleInitialConnected with no live tick) never satisfies readiness',()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.handleInitialConnected({generationId:1});
  assert.equal(coordinator.isEvaluationReady(),false);
  assert.equal(events.includes('MARKET_DATA_READY'),false);
});

test('A6-4: an accepted current-generation NIFTY tick after handleInitialConnected unlocks readiness, and cold start never claims a gap was recovered',()=>{
  const events:string[]=[];const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}),onEvent:(event)=>events.push(event)});
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date(1_000)});
  coordinator.handleLiveTick(liveTick(new Date(2_000), 1));
  assert.equal(coordinator.isEvaluationReady(),true);
  assert.equal(coordinator.getState(),'READY');
  assert.deepEqual(events,['MARKET_DATA_FRESH_TICK_CONFIRMED','MARKET_DATA_READY']); // no DATA_GAP_RECOVERED -- nothing was ever degraded on cold start
});

test('A6-5: a stale/previous-generation tick cannot satisfy initial readiness',()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:2,connectedAt:new Date(1_000)});
  coordinator.handleLiveTick(liveTick(new Date(2_000), 1)); // stale generation 1, current is 2
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(liveTick(new Date(2_000), 2));
  assert.equal(coordinator.isEvaluationReady(),true);
});

test('A6-6: a malformed/non-numeric-generation event cannot satisfy initial readiness',()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date(1_000)});
  coordinator.handleLiveTick(liveTick(new Date(2_000), undefined));
  assert.equal(coordinator.isEvaluationReady(),false);
  coordinator.handleLiveTick(liveTick(new Date(2_000), Number.NaN));
  assert.equal(coordinator.isEvaluationReady(),false);
});

test('A6-7: handleInitialConnected is idempotent and cannot be re-seeded with a different generation',()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date(1_000)});
  coordinator.handleInitialConnected({generationId:5,connectedAt:new Date(9_000)}); // must be ignored
  assert.equal(coordinator.getGenerationId(),1);
  coordinator.handleLiveTick(liveTick(new Date(2_000), 5));
  assert.equal(coordinator.isEvaluationReady(),false); // generation 5 was never actually established
  coordinator.handleLiveTick(liveTick(new Date(2_000), 1));
  assert.equal(coordinator.isEvaluationReady(),true);
});

test('A6-8: handleInitialConnected cannot corrupt an active reconnect episode (DEGRADED/RECONNECTING/BACKFILLING/WAITING_FOR_FRESH_TICK)',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  let backfillResolve!:(value:Result)=>void;
  const coordinator=new MarketDataRecoveryCoordinatorService({backfill:async()=>new Promise<Result>((resolve)=>{backfillResolve=resolve;})});
  coordinator.handleUnexpectedDisconnect({generationId:1});
  assert.equal(coordinator.getState(),'RECONNECTING');
  coordinator.handleInitialConnected({generationId:1}); // must no-op: state is not AWAITING_LIVE_TICK
  assert.equal(coordinator.getState(),'RECONNECTING');
  coordinator.handleReconnected({generationId:2});
  assert.equal(coordinator.getState(),'BACKFILLING');
  coordinator.handleInitialConnected({generationId:2}); // must still no-op mid-backfill
  assert.equal(coordinator.getState(),'BACKFILLING');
  backfillResolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleInitialConnected({generationId:2}); // must still no-op while awaiting the fresh tick
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(liveTick(new Date(), 2));
  assert.equal(coordinator.isEvaluationReady(),true); // the real reconnect invariant still requires its own proof
});

test('A6-9: connected and reconnected both firing for the same reconnect generation does not weaken the reconnect requirement (ConnectionManager always emits connected, even on reconnect)',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  let backfillResolve!:(value:Result)=>void;let backfills=0;let now=1_000;
  const coordinator=new MarketDataRecoveryCoordinatorService({nowMs:()=>now,backfill:async()=>{backfills+=1;return new Promise<Result>((resolve)=>{backfillResolve=resolve;});}});
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date(now)});
  coordinator.handleLiveTick(liveTick(new Date(now), 1));
  assert.equal(coordinator.isEvaluationReady(),true); // cold start completed on generation 1
  now=2_000;
  coordinator.handleUnexpectedDisconnect({generationId:1}); // recoveryStartedAt is reset to now (2_000)
  assert.equal(coordinator.isEvaluationReady(),false);
  // ConnectionManager emits 'connected' before 'reconnected' for every reconnect too.
  coordinator.handleInitialConnected({generationId:2}); // simulated 'connected' handler call -- must no-op
  coordinator.handleReconnected({generationId:2}); // simulated 'reconnected' handler call -- must proceed normally
  assert.equal(coordinator.getState(),'BACKFILLING');
  assert.equal(backfills,1);
  coordinator.handleLiveTick(liveTick(new Date(3_000), 2)); // a tick before backfill completes still cannot shortcut readiness
  assert.equal(coordinator.isEvaluationReady(),false);
  backfillResolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick(liveTick(new Date(4_000), 2)); // 4_000 >= recoveryStartedAt(2_000)
  assert.equal(coordinator.isEvaluationReady(),true);
});

// ---- A6: waitUntilReady() race/timeout behavior ----

test('A6-10: waitUntilReady resolves immediately if already ready',async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:1});coordinator.handleLiveTick(liveTick(new Date(), 1));
  assert.equal(coordinator.isEvaluationReady(),true);
  await coordinator.waitUntilReady(1_000); // must not hang or throw
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-11: waitUntilReady resolves once READY is reached via a later tick, and cannot miss the transition or leak its listener',async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  const waiting=coordinator.waitUntilReady(1_000);
  assert.equal(coordinator.listenerCount('stateChanged'),1);
  coordinator.handleInitialConnected({generationId:1});
  coordinator.handleLiveTick(liveTick(new Date(), 1));
  await waiting;
  assert.equal(coordinator.isEvaluationReady(),true);
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-12: waitUntilReady rejects when the coordinator faults instead of becoming ready',async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>({ready:false,reason:'MISSING_MINUTE',missingMinutes:1,duplicateMinutes:0})});
  const waiting=coordinator.waitUntilReady(1_000);
  coordinator.handleUnexpectedDisconnect({generationId:1});coordinator.handleReconnected({generationId:2});
  await assert.rejects(()=>waiting,/FAULTED/);
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-13: waitUntilReady rejects when the coordinator stops instead of becoming ready',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>new Promise<Result>(()=>{/* never resolves */})});
  const waiting=coordinator.waitUntilReady(1_000);
  coordinator.stop();
  await assert.rejects(()=>waiting,/STOPPED/);
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-14: waitUntilReady fails closed with a clear timeout diagnostic and leaks no listener/timer when nothing ever arrives',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>new Promise<Result>(()=>{/* never resolves */})});
  const waiting=coordinator.waitUntilReady(15);
  await assert.rejects(()=>waiting,(error:unknown)=>{
    assert.ok(error instanceof MarketDataInitialReadinessTimeoutError);
    assert.equal(error.timeoutMs,15);
    return true;
  });
  assert.equal(coordinator.isEvaluationReady(),false);
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-15: waitUntilReady registered before readiness is proven cannot hang and cannot be missed by a synchronous state change',async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  coordinator.handleInitialConnected({generationId:1});
  const waiting=coordinator.waitUntilReady(1_000); // registered while still AWAITING_LIVE_TICK
  coordinator.handleLiveTick(liveTick(new Date(), 1)); // synchronous READY transition happens immediately after registration
  await waiting;
  assert.equal(coordinator.isEvaluationReady(),true);
});

// ---- A6 correction (HIGH-2): waitUntilReady() session-awareness ----

test('A6-16: a pre-open (or post-close) launch fails closed immediately with the explicit session-inactive reason, not a market-data-feed timeout',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>false,backfill:async()=>new Promise<Result>(()=>{/* never resolves */})});
  const started=Date.now();
  await assert.rejects(()=>coordinator.waitUntilReady(60_000),(error:unknown)=>{
    assert.ok(error instanceof MarketSessionNotActiveError);
    assert.ok(!(error instanceof MarketDataInitialReadinessTimeoutError));
    return true;
  });
  assert.ok(Date.now()-started<1_000); // rejected immediately, not after waiting out the 60s bound
  assert.equal(coordinator.listenerCount('stateChanged'),0);
});

test('A6-17: an accepted current-generation NIFTY event still unlocks readiness once the session is active, even though the coordinator itself never inspects wall-clock time outside waitUntilReady',async()=>{
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  const waiting=coordinator.waitUntilReady(1_000);
  coordinator.handleInitialConnected({generationId:1});
  coordinator.handleLiveTick(liveTick(new Date(), 1));
  await waiting; // resolves without ever hitting the session-inactive or timeout path
  assert.equal(coordinator.isEvaluationReady(),true);
});

test('A6-18: the session ending while the wait is still pending rejects with the explicit session-inactive reason instead of the generic feed-timeout reason',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  let sessionActive=true;
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>sessionActive,backfill:async()=>new Promise<Result>(()=>{/* never resolves */})});
  const waiting=coordinator.waitUntilReady(30);
  setTimeout(()=>{sessionActive=false;},10); // session closes partway through the wait, before the 30ms bound elapses
  await assert.rejects(()=>waiting,(error:unknown)=>{
    assert.ok(error instanceof MarketSessionNotActiveError);
    return true;
  });
});

test('A6-19: a genuinely silent feed during an active session still fails closed with the feed-timeout reason, not the session-inactive reason',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  const coordinator=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,backfill:async()=>new Promise<Result>(()=>{/* never resolves */})});
  await assert.rejects(()=>coordinator.waitUntilReady(15),(error:unknown)=>{
    assert.ok(error instanceof MarketDataInitialReadinessTimeoutError);
    assert.ok(!(error instanceof MarketSessionNotActiveError));
    return true;
  });
});
