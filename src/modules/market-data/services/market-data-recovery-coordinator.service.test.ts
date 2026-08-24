import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService, { MarketDataInitialReadinessTimeoutError, MarketSessionNotActiveError, NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE } from './market-data-recovery-coordinator.service';
import { nifty1mSourceCompletionBoundary } from '../../historical-candles/utils/historical-session-completeness.util';

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

// ---- A7-H1: cold-start REST->Live continuity reconciliation ----
//
// A7-H2 note: handleInitialConnected/handleReconnected now ALSO require the source minute
// that was still forming at the instant of connect to be excluded from live construction
// and (when not already covered) reconciled via REST before granting backfillReady -- see
// the "A7-H2: complete-bucket handoff" block below. That forming-minute requirement is
// orthogonal to the pre-existing-gap scenarios these three tests exercise, so they now
// connect EXACTLY on a clean minute boundary (:00.000) -- the one case where "the minute
// forming at connect" and "the ordinary expectedCompleted minute" coincide and no
// additional wait is introduced -- to keep isolating the pre-existing-gap behavior they were
// written for.

test('A7-H1-1: cold start with continuous warmup (lastSeeded >= expectedCompleted) does not trigger backfill and becomes READY on first live tick',async()=>{
  let backfillCount=0;
  const events:string[]=[];
  const tSeeded=new Date('2026-08-24T05:03:00.000Z'); // 10:33 IST
  const coordinator=new MarketDataRecoveryCoordinatorService({
    isMarketSession:()=>true,
    nowMs:()=>new Date('2026-08-24T05:04:00.000Z').getTime(), // 10:34:00 IST exactly (expectedCompleted is 10:33)
    getLastSeededCompletedMinute:()=>tSeeded,
    backfill:async()=>{ backfillCount++; return {ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}; },
    onEvent:(event)=>events.push(event),
  });
  coordinator.handleInitialConnected({generationId:1,connectedAt:new Date('2026-08-24T05:04:00.000Z')});
  assert.equal(backfillCount,0,'expected no backfill when warmup already covers expected completed minute');
  assert.equal(coordinator.getState(),'AWAITING_LIVE_TICK');
  coordinator.handleLiveTick({sourceTimestamp:new Date('2026-08-24T05:04:31.000Z'),receivedAt:new Date('2026-08-24T05:04:31.000Z'),generationId:1});
  assert.equal(coordinator.isEvaluationReady(),true);
  assert.equal(coordinator.getState(),'READY');
  assert.deepEqual(events,['MARKET_DATA_FRESH_TICK_CONFIRMED','MARKET_DATA_READY']);
});

test('A7-H1-2: cold start with 1-minute gap (lastSeeded=10:33, handoff at 10:35:00 expectedCompleted=10:34) triggers backfill, invokes onRecovered, and becomes READY on fresh live tick',async()=>{
  let backfillCount=0;
  const recoveredData:Array<{gen:number;data:string|undefined}>=[];
  const events:string[]=[];
  const tSeeded=new Date('2026-08-24T05:03:00.000Z'); // 10:33 IST
  const handoffTime=new Date('2026-08-24T05:05:00.000Z'); // 10:35:00 IST exactly (expectedCompleted is 10:34)
  const coordinator=new MarketDataRecoveryCoordinatorService<string>({
    isMarketSession:()=>true,
    nowMs:()=>handoffTime.getTime(),
    getLastSeededCompletedMinute:()=>tSeeded,
    backfill:async()=>{
      backfillCount++;
      return {ready:true,reason:'FRESH_CURRENT_DAY_HISTORY',missingMinutes:0,duplicateMinutes:0,recoveryData:'BRIDGED_10_34'};
    },
    onRecovered:(gen,data)=>{ recoveredData.push({gen,data}); return undefined; },
    onEvent:(event)=>events.push(event),
  });
  coordinator.handleInitialConnected({generationId:1,connectedAt:handoffTime});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(backfillCount,1,'expected backfill to be triggered for missing 10:34 IST minute');
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  assert.deepEqual(recoveredData,[{gen:1,data:'BRIDGED_10_34'}]);
  assert.ok(events.includes('MARKET_DATA_BACKFILL_STARTED'));
  assert.ok(events.includes('MARKET_DATA_BACKFILL_COMPLETED'));
  assert.equal(coordinator.isEvaluationReady(),false);
  // Live tick received after handoff completes readiness
  coordinator.handleLiveTick({sourceTimestamp:new Date('2026-08-24T05:05:01.000Z'),receivedAt:new Date('2026-08-24T05:05:01.000Z'),generationId:1});
  assert.equal(coordinator.isEvaluationReady(),true);
  assert.equal(coordinator.getState(),'READY');
  assert.ok(events.includes('MARKET_DATA_READY'));
});

test('A7-H1-3: cold start with multi-minute gap triggers backfill and seals readiness',async()=>{
  let backfilled=false;
  const tSeeded=new Date('2026-08-24T05:00:00.000Z'); // 10:30 IST
  const handoffTime=new Date('2026-08-24T05:05:00.000Z'); // 10:35:00 IST exactly (expectedCompleted is 10:34)
  const coordinator=new MarketDataRecoveryCoordinatorService({
    isMarketSession:()=>true,
    nowMs:()=>handoffTime.getTime(),
    getLastSeededCompletedMinute:()=>tSeeded,
    backfill:async()=>{ backfilled=true; return {ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}; },
  });
  coordinator.handleInitialConnected({generationId:1,connectedAt:handoffTime});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.ok(backfilled);
  assert.equal(coordinator.getState(),'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick({sourceTimestamp:new Date('2026-08-24T05:05:06.000Z'),receivedAt:new Date('2026-08-24T05:05:06.000Z'),generationId:1});
  assert.equal(coordinator.isEvaluationReady(),true);
});

test('A7-H1-4: cold start backfill failure transitions coordinator to FAULTED and waitUntilReady rejects',async()=>{
  const tSeeded=new Date('2026-08-24T05:03:00.000Z');
  const handoffTime=new Date('2026-08-24T05:05:00.000Z');
  const coordinator=new MarketDataRecoveryCoordinatorService({
    isMarketSession:()=>true,
    nowMs:()=>handoffTime.getTime(),
    getLastSeededCompletedMinute:()=>tSeeded,
    backfill:async()=>({ready:false,reason:'UPSTOX_API_ERROR',missingMinutes:1,duplicateMinutes:0}),
  });
  const waiting=coordinator.waitUntilReady(1_000);
  coordinator.handleInitialConnected({generationId:1,connectedAt:handoffTime});
  await assert.rejects(()=>waiting,/FAULTED/);
  assert.equal(coordinator.getState(),'FAULTED');
  assert.equal(coordinator.isEvaluationReady(),false);
});

test('A7-H1-5: unexpected disconnect during cold-start backfill discards stale recovery result on generation change',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number;recoveryData?:string};
  let pendingBackfillResolve:((res:Result)=>void)|undefined;
  const recoveredData:Array<{gen:number;data:string|undefined}>=[];
  const tSeeded=new Date('2026-08-24T05:03:00.000Z');
  const handoffTime=new Date('2026-08-24T05:05:00.000Z');
  const coordinator=new MarketDataRecoveryCoordinatorService<string>({
    isMarketSession:()=>true,
    nowMs:()=>handoffTime.getTime(),
    getLastSeededCompletedMinute:()=>tSeeded,
    backfill:()=>new Promise<Result>((resolve)=>{ pendingBackfillResolve=resolve; }),
    onRecovered:(gen,data)=>{ recoveredData.push({gen,data}); return undefined; },
  });
  coordinator.handleInitialConnected({generationId:1,connectedAt:handoffTime});
  assert.equal(coordinator.getState(),'BACKFILLING');
  // Disconnect arrives while backfill is running
  coordinator.handleUnexpectedDisconnect({generationId:1});
  assert.equal(coordinator.getState(),'RECONNECTING');
  // Initial backfill settles late
  pendingBackfillResolve!({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0,recoveryData:'STALE'});
  await new Promise((r)=>setImmediate(r));
  assert.equal(recoveredData.length,0,'stale onRecovered must not run after generation invalidation');
});

test('A7-H1-6: pre-market cold start (expectedCompleted is null) does not trigger backfill',async()=>{
  let backfills=0;
  const preMarket=new Date('2026-08-24T03:40:00.000Z'); // 09:10 IST
  const coordinator=new MarketDataRecoveryCoordinatorService({
    isMarketSession:()=>true,
    nowMs:()=>preMarket.getTime(),
    getLastSeededCompletedMinute:()=>null,
    backfill:async()=>{ backfills++; return {ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0}; },
  });
  coordinator.handleInitialConnected({generationId:1,connectedAt:preMarket});
  assert.equal(backfills,0);
  assert.equal(coordinator.getState(),'AWAITING_LIVE_TICK');
});

// ---- A7-H2: complete-bucket handoff (forming-minute-at-connect boundary protection) ----
//
// Blocker 1 root cause: A7-H1 only ever reconciled minutes that were ALREADY complete by
// wall-clock time at the instant of connect (expectedCompleted = floor(connectedAt) - 1
// minute). The minute a WebSocket connects (or reconnects) IN THE MIDDLE OF -- the "forming"
// minute -- was never reconciled at all and was left to LiveCandleBuilderService to build
// from whatever live ticks happened to arrive after the mid-minute connect, silently
// producing a timestamp-contiguous but incomplete candle once it later "completed". These
// tests prove the coordinator now (a) excludes that forming minute from live construction
// via onLiveConstructionBoundary, and (b) reconciles it through the exact same REST backfill
// pipeline, deferred until real wall-clock time has actually passed it, before ever granting
// backfillReady.

test('A7-H2-1: a mid-minute cold-start connect defers the forming-minute reconciliation until wall-clock time actually passes it, and publishes the correct live-construction boundary immediately', async () => {
  const boundaries: Date[] = [];
  let backfillCount = 0;
  const tSeeded = new Date('2026-08-24T05:03:00.000Z'); // 10:33 IST
  const connectedAt = new Date('2026-08-24T05:05:23.000Z'); // 10:35:23 IST -- mid-minute connect
  const coordinator = new MarketDataRecoveryCoordinatorService<string>({
    isMarketSession: () => true,
    nowMs: () => connectedAt.getTime(), // frozen at connect until advanced below
    getLastSeededCompletedMinute: () => tSeeded,
    backfill: async () => { backfillCount++; return { ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 0, duplicateMinutes: 0, recoveryData: 'BRIDGED_10_34_AND_10_35' }; },
    onLiveConstructionBoundary: (boundary) => boundaries.push(boundary),
  });
  coordinator.handleInitialConnected({ generationId: 1, connectedAt });
  // The boundary is published synchronously and immediately -- 10:36:00 IST, the start of the
  // first minute guaranteed observable from its very start on this connection -- regardless
  // of when (or whether) reconciliation itself completes.
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].toISOString(), new Date('2026-08-24T05:06:00.000Z').toISOString());
  assert.equal(backfillCount, 0, 'reconciliation must not fire before wall-clock time reaches the boundary');
  assert.equal(coordinator.getState(), 'AWAITING_LIVE_TICK', 'no BACKFILLING transition while merely waiting for the forming minute to complete');
  assert.equal(coordinator.isEvaluationReady(), false);
  // A live tick received BEFORE the boundary proves the feed is alive, but must not itself
  // substitute for the still-forming (not-yet-reconciled) 10:35 minute.
  coordinator.handleLiveTick({ sourceTimestamp: new Date('2026-08-24T05:05:30.000Z'), receivedAt: new Date('2026-08-24T05:05:30.000Z'), generationId: 1 });
  assert.equal(backfillCount, 0);
  assert.equal(coordinator.isEvaluationReady(), false);
  // A live tick received AT/AFTER the boundary proves wall-clock time has passed it and fires
  // the deferred reconciliation.
  coordinator.handleLiveTick({ sourceTimestamp: new Date('2026-08-24T05:06:05.000Z'), receivedAt: new Date('2026-08-24T05:06:05.000Z'), generationId: 1 });
  assert.equal(backfillCount, 1);
  assert.equal(coordinator.getState(), 'BACKFILLING');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.isEvaluationReady(), true, 'freshness was already proven by the earlier live tick; the forming-minute reconciliation was the only remaining gate');
});

test('A7-H2-2: the forming-minute reconciliation is awaited correctly even when the REST backfill call itself takes a while (publication latency) -- the coordinator does not misfire or time out early', async () => {
  let resolveBackfill: ((value: { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number }) => void) | undefined;
  const tSeeded = new Date('2026-08-24T05:03:00.000Z');
  const connectedAt = new Date('2026-08-24T05:05:23.000Z'); // 10:35:23 IST
  const coordinator = new MarketDataRecoveryCoordinatorService({
    isMarketSession: () => true,
    nowMs: () => new Date('2026-08-24T05:06:10.000Z').getTime(), // wall-clock already past the 10:36 boundary
    getLastSeededCompletedMinute: () => tSeeded,
    backfill: () => new Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number }>((resolve) => { resolveBackfill = resolve; }),
  });
  coordinator.handleInitialConnected({ generationId: 1, connectedAt });
  assert.equal(coordinator.getState(), 'BACKFILLING', 'nowMs is already past the boundary, so reconciliation fires immediately at connect');
  assert.equal(coordinator.isEvaluationReady(), false);
  resolveBackfill!({ ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 0, duplicateMinutes: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getState(), 'WAITING_FOR_FRESH_TICK');
  coordinator.handleLiveTick({ sourceTimestamp: new Date('2026-08-24T05:06:11.000Z'), receivedAt: new Date('2026-08-24T05:06:11.000Z'), generationId: 1 });
  assert.equal(coordinator.isEvaluationReady(), true);
});

test('A7-H2-3: a backfill failure at the forming-minute boundary faults the coordinator closed -- RUNNING is never granted with a permanently unresolved partial bucket', async () => {
  const tSeeded = new Date('2026-08-24T05:03:00.000Z');
  const connectedAt = new Date('2026-08-24T05:05:23.000Z');
  const coordinator = new MarketDataRecoveryCoordinatorService({
    isMarketSession: () => true,
    nowMs: () => new Date('2026-08-24T05:06:05.000Z').getTime(), // already past the boundary
    getLastSeededCompletedMinute: () => tSeeded,
    backfill: async () => ({ ready: false, reason: 'STALE_CURRENT_DAY_HISTORY', missingMinutes: 1, duplicateMinutes: 0 }),
  });
  coordinator.handleInitialConnected({ generationId: 1, connectedAt });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getState(), 'FAULTED');
  assert.equal(coordinator.isEvaluationReady(), false);
});

test('A7-H2-4: a disconnect that arrives WHILE STILL WAITING for the forming-minute boundary (before wall-clock reaches it) discards the pending reconciliation -- it never fires for the old generation', async () => {
  let backfillCount = 0;
  const tSeeded = new Date('2026-08-24T05:03:00.000Z');
  const connectedAt = new Date('2026-08-24T05:05:23.000Z');
  let now = connectedAt.getTime();
  const coordinator = new MarketDataRecoveryCoordinatorService({
    isMarketSession: () => true,
    nowMs: () => now,
    getLastSeededCompletedMinute: () => tSeeded,
    backfill: async () => { backfillCount++; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }; },
  });
  coordinator.handleInitialConnected({ generationId: 1, connectedAt });
  assert.equal(backfillCount, 0);
  coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  assert.equal(coordinator.getState(), 'RECONNECTING');
  // Wall-clock now genuinely passes the boundary that would have applied to generation 1, but
  // no tick for generation 1 can ever arrive again -- the stale pending reconciliation must
  // never fire.
  now = new Date('2026-08-24T05:07:00.000Z').getTime();
  coordinator.handleLiveTick({ sourceTimestamp: new Date(now), receivedAt: new Date(now), generationId: 1 });
  assert.equal(backfillCount, 0, 'a pending reconciliation discarded by a disconnect must never be resurrected by wall-clock time later reaching its boundary');
});

test('A7-H2-5: reconnecting mid-minute is protected exactly like a mid-minute cold-start connect -- the boundary applies and the forming minute at reconnect is reconciled before readiness', async () => {
  let backfillCount = 0;
  const boundaries: Date[] = [];
  const tSeeded = new Date('2026-08-24T05:03:00.000Z'); // 10:33 IST
  let now = new Date('2026-08-24T05:04:00.000Z').getTime(); // 10:34:00 IST exactly, cold start with zero gap
  const coordinator = new MarketDataRecoveryCoordinatorService({
    isMarketSession: () => true,
    nowMs: () => now,
    getLastSeededCompletedMinute: () => tSeeded,
    backfill: async () => { backfillCount++; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }; },
    onLiveConstructionBoundary: (boundary) => boundaries.push(boundary),
  });
  coordinator.handleInitialConnected({ generationId: 1, connectedAt: new Date(now) });
  assert.equal(coordinator.getState(), 'AWAITING_LIVE_TICK', 'exact-boundary cold start with zero gap needs no backfill');
  coordinator.handleLiveTick({ sourceTimestamp: new Date(now + 1000), receivedAt: new Date(now + 1000), generationId: 1 });
  assert.equal(coordinator.isEvaluationReady(), true);
  assert.equal(backfillCount, 0);
  // A disconnect/reconnect cycle later, landing mid-minute this time.
  coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  now = new Date('2026-08-24T05:12:45.000Z').getTime(); // 10:42:45 IST -- mid-minute reconnect
  coordinator.handleReconnected({ generationId: 2 });
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[1].toISOString(), new Date('2026-08-24T05:13:00.000Z').toISOString(), 'reconnect boundary is 10:43:00 IST, the minute after the one reconnect landed inside');
  assert.equal(backfillCount, 0, 'reconciliation for the reconnect must also wait for the new boundary, not fire immediately mid-minute');
  assert.equal(coordinator.isEvaluationReady(), false);
  now = new Date('2026-08-24T05:13:05.000Z').getTime();
  coordinator.handleLiveTick({ sourceTimestamp: new Date(now), receivedAt: new Date(now), generationId: 2 });
  assert.equal(backfillCount, 1, 'reconciliation for the new generation fires once wall-clock passes the reconnect boundary');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getState(), 'WAITING_FOR_FRESH_TICK', 'the boundary-crossing tick itself arrived while recover() was already synchronously in BACKFILLING, so it could not also supply the required fresh-tick evidence');
  coordinator.handleLiveTick({ sourceTimestamp: new Date(now + 1000), receivedAt: new Date(now + 1000), generationId: 2 });
  assert.equal(coordinator.isEvaluationReady(), true);
});

test('A7-H2-6: a reconnect without cold-start-continuity configured (no getLastSeededCompletedMinute) keeps the prior unconditional-immediate-recover behavior exactly -- legacy callers are unaffected', async () => {
  let backfillCount = 0;
  const coordinator = new MarketDataRecoveryCoordinatorService({
    backfill: async () => { backfillCount++; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }; },
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  coordinator.handleReconnected({ generationId: 2 });
  assert.equal(backfillCount, 1, 'immediate, synchronous recover() on reconnect -- unchanged for legacy callers');
  assert.equal(coordinator.getState(), 'BACKFILLING');
});

test('A7-H2-R2: V2 alignment defers a 14:08:xx handoff to 14:10 and requires authoritative coverage through 14:09', async () => {
  let now = new Date('2026-08-24T14:08:23+05:30').getTime();
  const boundaries: Date[] = [];
  const required: Date[] = [];
  const recovered = { latest: new Date('2026-08-24T14:09:00+05:30') };
  const coordinator = new MarketDataRecoveryCoordinatorService<typeof recovered>({
    isMarketSession: () => true,
    nowMs: () => now,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:07:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (target) => {
      if (target) required.push(target);
      return { ready:true, reason:'FRESH_CURRENT_DAY_HISTORY', missingMinutes:0, duplicateMinutes:0, recoveryData:recovered };
    },
    onLiveConstructionBoundary: (boundary) => boundaries.push(boundary),
  });
  coordinator.handleInitialConnected({ generationId:1, connectedAt:new Date(now) });
  assert.equal(boundaries[0]?.toISOString(), new Date('2026-08-24T14:10:00+05:30').toISOString());
  coordinator.handleLiveTick({ sourceTimestamp:new Date(now), receivedAt:new Date(now), generationId:1 });
  assert.equal(required.length, 0);
  now = new Date('2026-08-24T14:10:00+05:30').getTime();
  coordinator.handleLiveTick({ sourceTimestamp:new Date(now), receivedAt:new Date(now), generationId:1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(required[0]?.toISOString(), new Date('2026-08-24T14:09:00+05:30').toISOString());
  assert.equal(coordinator.isEvaluationReady(), true);
});

test('A7-H2-R2: an exact aligned connection advances to the next strictly-future strategy boundary', () => {
  const boundaries: Date[] = [];
  const connectedAt = new Date('2026-08-24T14:10:00+05:30');
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    isMarketSession: () => true,
    nowMs: () => connectedAt.getTime(),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:09:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => ({ ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date('2026-08-24T14:14:00+05:30') } }),
    onLiveConstructionBoundary: (boundary) => boundaries.push(boundary),
  });
  coordinator.handleInitialConnected({ generationId:1, connectedAt });
  assert.equal(boundaries[0]?.toISOString(), new Date('2026-08-24T14:15:00+05:30').toISOString());
  assert.equal(coordinator.isEvaluationReady(), false);
});

test('A7-H2-R2: an exact 09:15 session-open connection is also gated to the next aligned boundary', () => {
  const boundaries: Date[] = [];
  const connectedAt = new Date('2026-08-24T09:15:00+05:30');
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest:Date }>({
    isMarketSession: () => true,
    nowMs: () => connectedAt.getTime(),
    getLastSeededCompletedMinute: () => null,
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => ({ ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date('2026-08-24T09:19:00+05:30') } }),
    onLiveConstructionBoundary: (boundary) => boundaries.push(boundary),
  });
  coordinator.handleInitialConnected({ generationId:1, connectedAt });
  assert.equal(boundaries[0]?.toISOString(), new Date('2026-08-24T09:20:00+05:30').toISOString());
  assert.equal(coordinator.isEvaluationReady(), false);
});

test('A7-H2-R2: READY fails closed when backfill does not reach boundary minus one minute', async () => {
  let now = new Date('2026-08-24T14:08:23+05:30').getTime();
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    isMarketSession: () => true,
    nowMs: () => now,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:07:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => ({ ready:true, reason:'FRESH_CURRENT_DAY_HISTORY', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date('2026-08-24T14:08:00+05:30') } }),
  });
  coordinator.handleInitialConnected({ generationId:1, connectedAt:new Date(now) });
  now = new Date('2026-08-24T14:10:00+05:30').getTime();
  coordinator.handleLiveTick({ sourceTimestamp:new Date(now), receivedAt:new Date(now), generationId:1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getState(), 'FAULTED');
  assert.equal(coordinator.isEvaluationReady(), false);
});

test('A7-H2-R2: a stale aligned-boundary tick cannot start recovery after generation invalidation', async () => {
  let now = new Date('2026-08-24T14:08:23+05:30').getTime();
  let backfills = 0;
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    isMarketSession: () => true,
    nowMs: () => now,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:07:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => { backfills += 1; return { ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date('2026-08-24T14:09:00+05:30') } }; },
  });
  coordinator.handleInitialConnected({ generationId:1, connectedAt:new Date(now) });
  coordinator.handleUnexpectedDisconnect({ generationId:1 });
  now = new Date('2026-08-24T14:10:00+05:30').getTime();
  coordinator.handleLiveTick({ sourceTimestamp:new Date(now), receivedAt:new Date(now), generationId:1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backfills, 0);
  assert.equal(coordinator.getState(), 'RECONNECTING');
});

test('A7-H2-R3: V4 reconnects at 15:30:00, 15:33 and 15:39:59 fail closed instead of waiting for an unaligned 15:45 handoff', async () => {
  for (const time of ['15:30:00', '15:33:00', '15:39:59']) {
    let now = new Date(`2026-08-24T${time}+05:30`).getTime();
    let backfills = 0;
    const handoffs: Date[] = [];
    const blockedThrough: Date[] = [];
    const failures: string[] = [];
    const coordinator = new MarketDataRecoveryCoordinatorService<{ latest:Date }>({
      nowMs: () => now,
      getLastSeededCompletedMinute: () => new Date('2026-08-24T15:29:00+05:30'),
      liveConstructionAlignmentMinutes: 15,
      getRecoveredCompletedMinute: (data) => data?.latest,
      backfill: async () => { backfills += 1; return { ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date(now) } }; },
      onLiveConstructionBoundary: (boundary) => handoffs.push(boundary),
      onLiveConstructionUnavailable: (close) => blockedThrough.push(close),
      onEvent: (event, details) => { if (event === 'MARKET_DATA_RECOVERY_FAILED') failures.push(String(details.reason)); },
    });
    coordinator.handleUnexpectedDisconnect({ generationId:0 });
    coordinator.handleReconnected({ generationId:1 });
    assert.equal(coordinator.getState(), 'FAULTED', time);
    assert.equal(coordinator.isEvaluationReady(), false, time);
    assert.equal(handoffs.length, 0, `${time}: 15:40 must not be fabricated as a V4 handoff`);
    assert.equal(blockedThrough[0]?.toISOString(), new Date('2026-08-24T15:40:00+05:30').toISOString());
    assert.deepEqual(failures, [NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE]);
    now = new Date('2026-08-24T15:45:00+05:30').getTime();
    coordinator.handleLiveTick(liveTick(new Date(now), 1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(backfills, 0, `${time}: no post-close pending reconciliation may survive`);
  }
});

test('A7-H2-R3: V8 reconnects at 15:39:00 or 15:39:59 fail closed instead of waiting for 15:41', () => {
  for (const time of ['15:39:00', '15:39:59']) {
    const now = new Date(`2026-08-24T${time}+05:30`);
    const handoffs: Date[] = [];
    const blockedThrough: Date[] = [];
    const coordinator = new MarketDataRecoveryCoordinatorService<{ latest:Date }>({
      nowMs: () => now.getTime(),
      getLastSeededCompletedMinute: () => new Date('2026-08-24T15:38:00+05:30'),
      liveConstructionAlignmentMinutes: 2,
      getRecoveredCompletedMinute: (data) => data?.latest,
      backfill: async () => ({ ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:now } }),
      onLiveConstructionBoundary: (boundary) => handoffs.push(boundary),
      onLiveConstructionUnavailable: (close) => blockedThrough.push(close),
    });
    coordinator.handleUnexpectedDisconnect({ generationId:0 });
    coordinator.handleReconnected({ generationId:1 });
    assert.equal(coordinator.getState(), 'FAULTED', time);
    assert.equal(handoffs.length, 0, `${time}: 15:40 must not be fabricated as a V8 handoff`);
    assert.equal(blockedThrough[0]?.toISOString(), new Date('2026-08-24T15:40:00+05:30').toISOString());
  }
});

// ---- A7-H4: NIFTY_INDEX source horizon (09:15-15:29) is independent of, and narrower than,
// TradeMind's own 15:40 operational EOD/grace boundary. A live-construction boundary
// requiring REST coverage past 15:29 is never usable, even when it is still before 15:40.
// H3 wrongly clamped V2's canonical-close handoff to accept a fabricated "15:39 candle";
// there is no NIFTY_INDEX candle after 15:29, so that boundary must fail closed instead,
// exactly like V4/V8 already do near close.

test('A7-H4: V2 reconnecting near 15:40 now exceeds the NIFTY source horizon and fails closed exactly like V4/V8 -- no fabricated 15:39 candle', async () => {
  for (const time of ['15:30:00', '15:37:00', '15:39:59']) {
    const now = new Date(`2026-08-24T${time}+05:30`);
    const handoffs: Date[] = [];
    const blockedThrough: Date[] = [];
    const failures: string[] = [];
    let backfills = 0;
    const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
      nowMs: () => now.getTime(),
      getLastSeededCompletedMinute: () => new Date('2026-08-24T15:24:00+05:30'),
      liveConstructionAlignmentMinutes: 5,
      getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
      getRecoveredCompletedMinute: (data) => data?.latest,
      backfill: async () => { backfills += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: now } }; },
      onLiveConstructionBoundary: (boundary) => handoffs.push(boundary),
      onLiveConstructionUnavailable: (close) => blockedThrough.push(close),
      onEvent: (event, details) => { if (event === 'MARKET_DATA_RECOVERY_FAILED') failures.push(String(details.reason)); },
    });
    coordinator.handleUnexpectedDisconnect({ generationId: 0 });
    coordinator.handleReconnected({ generationId: 1 });
    assert.equal(coordinator.getState(), 'FAULTED', time);
    assert.equal(coordinator.isEvaluationReady(), false, time);
    assert.equal(handoffs.length, 0, `${time}: a boundary requiring REST coverage past 15:29 must never be published as a live-construction handoff`);
    assert.equal(blockedThrough[0]?.toISOString(), new Date('2026-08-24T15:40:00+05:30').toISOString(), time);
    assert.deepEqual(failures, [NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE], time);
    assert.equal(backfills, 0, `${time}: no REST call may ever request a NIFTY 1m minute beyond 15:29`);
  }
});

test('A7-H4: V2 reconnecting just before the source horizon establishes a safe 15:30 handoff (target 15:29), not a fabricated later one', () => {
  const now = new Date('2026-08-24T15:27:30+05:30');
  const handoffs: Date[] = [];
  const required: Date[] = [];
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    nowMs: () => now.getTime(),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:24:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (target) => { if (target) required.push(target); return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T15:29:00+05:30') } }; },
    onLiveConstructionBoundary: (boundary) => handoffs.push(boundary),
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });
  assert.equal(coordinator.getState(), 'CONNECTED');
  assert.equal(handoffs[0]?.toISOString(), new Date('2026-08-24T15:30:00+05:30').toISOString());
});

// ---- A7-H3/H4: the source-horizon-safe (<=15:30) boundary must not depend solely on a live
// tick -- NIFTY_INDEX itself stops ticking at/around real market close, so a live tick with
// receivedAt >= the boundary may simply never arrive. completePendingBoundaryReconciliation()
// is the EOD-time-independent mechanism that resolves it regardless.

test('A7-H4: a reconnect-established 15:30 boundary that never sees a qualifying live tick (NIFTY stopped ticking) still resolves via completePendingBoundaryReconciliation() before stop()', async () => {
  let now = new Date('2026-08-24T15:27:30+05:30').getTime();
  const required: Date[] = [];
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    nowMs: () => now,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:24:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (target) => { if (target) required.push(target); return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T15:29:00+05:30') } }; },
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });
  now = new Date('2026-08-24T15:40:00+05:30').getTime(); // TradeMind's own operational EOD -- well after NIFTY_INDEX stopped ticking at 15:30
  // No handleLiveTick call here: NIFTY_INDEX genuinely stops publishing after the source
  // horizon, so nothing would ever call recovery.handleLiveTick() for it again this session.
  assert.equal(coordinator.getState(), 'CONNECTED', 'the boundary is due but nothing has triggered it yet');
  const result = await coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(required[0]?.toISOString(), new Date('2026-08-24T15:29:00+05:30').toISOString());
  assert.equal(coordinator.getState(), 'WAITING_FOR_FRESH_TICK');
  coordinator.stop();
  assert.equal(coordinator.getState(), 'STOPPED');
});

test('A7-H4: completePendingBoundaryReconciliation() is a safe no-op when no aligned boundary is outstanding', async () => {
  const coordinator = new MarketDataRecoveryCoordinatorService({
    backfill: async () => ({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }),
  });
  const result = await coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NONE_PENDING');
  assert.equal(coordinator.getState(), 'AWAITING_LIVE_TICK');
});

// ---- A7-H4 Blocker 2: positive recovery-success contract -----------------------------------
// SUCCESS ('RECOVERED') must require positive, owned proof -- never merely "the coordinator
// did not end up FAULTED". Each test below drives one specific race the naive
// `state !== 'FAULTED'` contract would have misreported as success.

function raceHarness(overrides: { backfill?: (target?: Date) => Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: { latest: Date } }> } = {}) {
  let now = new Date('2026-08-24T14:08:23+05:30').getTime();
  let backfills = 0;
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    nowMs: () => now,
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:07:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: overrides.backfill ?? (async () => { backfills += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } }; }),
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });
  now = new Date('2026-08-24T14:10:00+05:30').getTime(); // boundary due
  return { coordinator, setNow: (d: Date) => { now = d.getTime(); }, getBackfills: () => backfills };
}

function controllableBackfill() {
  let calls = 0;
  let resolve!: (value: { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: { latest: Date } }) => void;
  let reject!: (error: Error) => void;
  const backfill = async (): Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: { latest: Date } }> => {
    calls += 1;
    return new Promise((res, rej) => { resolve = res; reject = rej; });
  };
  return { backfill, resolve: () => resolve, reject: () => reject, getCalls: () => calls };
}

test('A7-H4 race 1: a successful owned recovery reports RECOVERED', async () => {
  const harness = raceHarness();
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(harness.getBackfills(), 1);
});

test('A7-H4 race 2: a disconnect landing while the barrier awaits an in-flight recovery reports NOT_RECOVERED, never RECOVERED', async () => {
  const controllable = controllableBackfill();
  const harness = raceHarness({ backfill: controllable.backfill });
  const completion = harness.coordinator.completePendingBoundaryReconciliation();
  await new Promise((r) => setImmediate(r));
  assert.equal(controllable.getCalls(), 1);
  harness.coordinator.handleUnexpectedDisconnect({ generationId: 1 }); // races the still-pending backfill
  controllable.resolve()({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } });
  const result = await completion;
  assert.notEqual(result.outcome, 'RECOVERED');
  assert.equal(result.outcome, 'NOT_RECOVERED');
});

test('A7-H4 race 3: the generation advancing (a completed reconnect to a new generation) while the barrier awaits reports NOT_RECOVERED', async () => {
  const controllable = controllableBackfill();
  const harness = raceHarness({ backfill: controllable.backfill });
  const completion = harness.coordinator.completePendingBoundaryReconciliation();
  await new Promise((r) => setImmediate(r));
  harness.coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  harness.coordinator.handleReconnected({ generationId: 2 }); // establishes its own (not-yet-due) pending reconciliation for gen 2; does not itself call backfill
  assert.equal(harness.coordinator.getGenerationId(), 2);
  controllable.resolve()({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } }); // the STALE gen-1 backfill finally settles
  const result = await completion;
  assert.notEqual(result.outcome, 'RECOVERED');
  assert.equal(result.reason, 'RECOVERY_GENERATION_OR_TOKEN_SUPERSEDED');
});

test('A7-H4 race 4: stop() landing while the barrier awaits an in-flight recovery reports NOT_RECOVERED with a COORDINATOR_STOPPED reason', async () => {
  const controllable = controllableBackfill();
  const harness = raceHarness({ backfill: controllable.backfill });
  const completion = harness.coordinator.completePendingBoundaryReconciliation();
  await new Promise((r) => setImmediate(r));
  harness.coordinator.stop();
  controllable.resolve()({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } });
  const result = await completion;
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(result.reason, 'COORDINATOR_STOPPED');
});

test('A7-H4 race 5: a stale completion (an unrelated fault() supersedes the token while the barrier awaits) reports NOT_RECOVERED, never RECOVERED', async () => {
  const controllable = controllableBackfill();
  const harness = raceHarness({ backfill: controllable.backfill });
  const completion = harness.coordinator.completePendingBoundaryReconciliation();
  await new Promise((r) => setImmediate(r));
  harness.coordinator.fault('UNRELATED_FAULT'); // bumps recoveryToken without changing generation or stopping
  controllable.resolve()({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } });
  const result = await completion;
  assert.notEqual(result.outcome, 'RECOVERED');
});

test('A7-H4 race 6: the exact required completed minute not being recovered reports NOT_RECOVERED with its own specific reason, not a generic supersession label', async () => {
  const harness = raceHarness({ backfill: async () => ({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:08:00+05:30') } }) }); // wrong minute
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(result.reason, 'REQUIRED_COMPLETED_MINUTE_NOT_RECOVERED', 'fail() bumps recoveryToken as a side effect of this exact attempt failing -- that must never be mistaken for an external supersession');
});

test('A7-H4 race 7: backfill throwing reports NOT_RECOVERED with the thrown error message, not a generic supersession label', async () => {
  const harness = raceHarness({ backfill: async () => { throw new Error('UPSTOX_INTRADAY_FETCH_FAILED'); } });
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'NOT_RECOVERED');
  assert.equal(result.reason, 'UPSTOX_INTRADAY_FETCH_FAILED');
});

test('A7-H4 race 8: calling completePendingBoundaryReconciliation() again after an already-completed owned recovery is idempotently RECOVERED without a second backfill call', async () => {
  const harness = raceHarness();
  const first = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(first.outcome, 'RECOVERED');
  const second = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(second.outcome, 'RECOVERED');
  assert.equal(harness.getBackfills(), 1, 'the already-owned success must not be re-fetched');
});

test('A7-H4 race 9: two concurrent barrier callers trigger exactly one recovery and receive an identical safe result', async () => {
  const harness = raceHarness();
  const [first, second] = await Promise.all([
    harness.coordinator.completePendingBoundaryReconciliation(),
    harness.coordinator.completePendingBoundaryReconciliation(),
  ]);
  assert.equal(harness.getBackfills(), 1, 'two concurrent callers must not trigger two recoveries');
  assert.deepEqual(first, second);
  assert.equal(first.outcome, 'RECOVERED');
});

test('A7-H4 race 10: a new generation cannot inherit a prior generation\'s success, even if the stale attempt\'s own backfill eventually "succeeds"', async () => {
  const controllable = controllableBackfill();
  const harness = raceHarness({ backfill: controllable.backfill });
  const completion = harness.coordinator.completePendingBoundaryReconciliation(); // gen 1, still in flight
  await new Promise((r) => setImmediate(r));
  harness.coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  harness.coordinator.handleReconnected({ generationId: 2 });
  // The stale gen-1 backfill now resolves with data that would, on its own, look like success.
  controllable.resolve()({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date('2026-08-24T14:09:00+05:30') } });
  const result = await completion;
  assert.notEqual(result.outcome, 'RECOVERED', 'a stale generation-1 attempt must never be reported as success for generation 2');
  assert.equal(harness.coordinator.getGenerationId(), 2);
});

test('A7-H5 obligation 1: disconnect before pending recovery starts cannot erase the requirement into NONE_PENDING', async () => {
  const harness = raceHarness();
  harness.coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.deepEqual(result, { outcome: 'NOT_RECOVERED', reason: 'REQUIRED_RECOVERY_INVALIDATED_BY_DISCONNECT' });
  assert.equal(harness.getBackfills(), 0);
});

test('A7-H5 obligation 2: fault before pending recovery starts remains a failed requirement at the barrier', async () => {
  const harness = raceHarness();
  harness.coordinator.fault('RECOVERY_FAULT_BEFORE_BOUNDARY');
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.deepEqual(result, { outcome: 'NOT_RECOVERED', reason: 'RECOVERY_FAULT_BEFORE_BOUNDARY' });
  assert.equal(harness.getBackfills(), 0);
});

test('A7-H5 obligation 3: stop before pending recovery starts cannot become a benign no-op', async () => {
  const harness = raceHarness();
  harness.coordinator.stop();
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.deepEqual(result, { outcome: 'NOT_RECOVERED', reason: 'COORDINATOR_STOPPED' });
  assert.equal(harness.getBackfills(), 0);
});

test('A7-H5 obligation 4: a reconnect creates a new generation-owned requirement rather than inheriting the old generation disposition', async () => {
  let calls = 0;
  const harness = raceHarness({ backfill: async (target) => {
    calls += 1;
    return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: new Date(target!.getTime()) } };
  } });
  harness.coordinator.handleUnexpectedDisconnect({ generationId: 1 });
  harness.coordinator.handleReconnected({ generationId: 2 });
  const result = await harness.coordinator.completePendingBoundaryReconciliation();
  assert.equal(result.outcome, 'RECOVERED');
  assert.equal(harness.coordinator.getGenerationId(), 2);
  assert.equal(calls, 1, 'generation 2 must prove its own recovery instead of inheriting generation 1');
});

test('A7-H5 obligation 7: a no-safe-boundary fault is NOT_RECOVERED, never benign NONE_PENDING', async () => {
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest: Date }>({
    nowMs: () => new Date('2026-08-24T15:30:00+05:30').getTime(),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:29:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => ({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }),
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });
  assert.equal(coordinator.getState(), 'FAULTED');
  const result = await coordinator.completePendingBoundaryReconciliation();
  assert.deepEqual(result, { outcome: 'NOT_RECOVERED', reason: NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE });
});

test('A7-H2-R3: a no-safe-boundary fault is generation-terminal and stale reconnect/tick callbacks cannot reopen it', async () => {
  let backfills = 0;
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latest:Date }>({
    nowMs: () => new Date('2026-08-24T15:39:59+05:30').getTime(),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:38:00+05:30'),
    liveConstructionAlignmentMinutes: 2,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async () => { backfills += 1; return { ready:true, reason:'OK', missingMinutes:0, duplicateMinutes:0, recoveryData:{ latest:new Date() } }; },
  });
  coordinator.handleUnexpectedDisconnect({ generationId:0 });
  coordinator.handleReconnected({ generationId:1 });
  coordinator.handleReconnected({ generationId:2 });
  coordinator.handleLiveTick(liveTick(new Date('2026-08-24T15:41:00+05:30'), 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getState(), 'FAULTED');
  assert.equal(coordinator.getGenerationId(), 1);
  assert.equal(backfills, 0);
});
