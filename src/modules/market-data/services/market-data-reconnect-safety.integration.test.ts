import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ConnectionManager, { ConnectionManagerScheduler } from '../managers/connection.manager';
import SubscriptionManager, { MarketDataSubscriptionMode } from '../managers/subscription.manager';
import MarketDataHealthMonitorService from './market-data-health-monitor.service';
import MarketDataRecoveryCoordinatorService from './market-data-recovery-coordinator.service';
import { StrategyHostLifecycle } from './strategy-host-lifecycle.service';

class Clock implements ConnectionManagerScheduler {
  now=0;private id=0;private readonly timers=new Map<number,{at:number;callback:()=>void}>();
  setTimeout(callback:()=>void,delayMs:number):number{const id=++this.id;this.timers.set(id,{at:this.now+delayMs,callback});return id;}
  clearTimeout(handle:unknown):void{this.timers.delete(handle as number);}
  advanceBy(milliseconds:number):void{const target=this.now+milliseconds;let next=[...this.timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=target);while(next){this.timers.delete(next[0]);this.now=next[1].at;next[1].callback();next=[...this.timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=target);}this.now=target;}
}
class Client extends EventEmitter { connects=0;async connect():Promise<void>{this.connects+=1;this.emit('connected');}disconnect():void{}disconnectForRecovery():void{this.emit('disconnected',{code:1006},true);}send():void{} }
/** Mirrors production ConnectionManager.connect() rejecting `failuresRemaining` times (e.g. a transient auth/socket hiccup on the very first cold-start attempt) before a real socket opens. */
class FlakyFirstConnectClient extends EventEmitter {
  connects=0;
  constructor(private failuresRemaining: number){super();}
  async connect():Promise<void>{
    this.connects+=1;
    if(this.failuresRemaining>0){this.failuresRemaining-=1;throw new Error('CONNECT_ERROR');}
    this.emit('connected');
  }
  disconnect():void{}
  disconnectForRecovery():void{this.emit('disconnected',{code:1006},true);}
  send():void{}
}
const flush=async()=>{for(let i=0;i<16;i+=1)await Promise.resolve();};

test('current-generation backfill plus fresh NIFTY data is the only path from DEGRADED back to RUNNING and resets the breaker',async()=>{
  const clock=new Clock();const client=new Client();const connection=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>clock.now,scheduler:clock});
  const health=new MarketDataHealthMonitorService(connection,{stallMs:100,generationGraceMs:100,now:()=>clock.now,isMarketSession:()=>true});
  const recovery=new MarketDataRecoveryCoordinatorService({nowMs:()=>clock.now,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  const host=new StrategyHostLifecycle({strategyId:'TEST',runtimeId:'test',hooks:{warmup:()=>undefined,onEod:()=>undefined,onShutdown:()=>undefined,onFault:()=>undefined}});
  connection.on('unexpectedDisconnect',(details)=>recovery.handleUnexpectedDisconnect(details));connection.on('reconnected',(details)=>recovery.handleReconnected(details));connection.on('reconnectFailed',(details:{reason?:string})=>{recovery.fault(details.reason);void host.fault(new Error(details.reason??'RECONNECT_FAILED'));});
  recovery.on('stateChanged',(state)=>{if(state==='DEGRADED')void host.degrade('MARKET_DATA_DEGRADED');if(state==='READY'&&health.confirmRecoveryReady(recovery.getGenerationId()))void host.recovered('MARKET_DATA_READY');if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');});
  await host.start();await connection.connect();connection.emit('message',Buffer.alloc(0),{generationId:1});health.noteValidMarketEvent(1);health.noteNiftyTick(1);assert.equal(health.confirmRecoveryReady(1),true);
  client.emit('disconnected',{code:1006},true);await flush();assert.equal(host.getState(),'DEGRADED');assert.equal(connection.getReconnectCircuitSnapshot().attempts,1);
  clock.advanceBy(10);await flush();assert.equal(connection.getGenerationId(),2);assert.equal(recovery.getState(),'WAITING_FOR_FRESH_TICK');assert.equal(host.canEvaluate(),false);
  connection.emit('message',Buffer.alloc(0),{generationId:2});health.noteValidMarketEvent(2);health.noteNiftyTick(2);recovery.handleLiveTick({ sourceTimestamp: new Date(clock.now), receivedAt: new Date(clock.now), generationId: 2 });await flush();
  assert.equal(recovery.getState(),'READY');assert.equal(health.isHealthy(),true);assert.equal(host.getState(),'RUNNING');assert.equal(connection.getReconnectCircuitSnapshot().attempts,0);
});

// ---- A6: cold-start current-generation readiness, wired exactly like the live entrypoints ----

function buildStack(readyTimeoutMs=1_000,options:{stallMs?:number;backfillReady?:boolean}={}){
  const clock=new Clock();const client=new Client();
  const connection=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>clock.now,scheduler:clock});
  const health=new MarketDataHealthMonitorService(connection,{stallMs:options.stallMs??100,generationGraceMs:100,now:()=>clock.now,isMarketSession:()=>true});
  const recovery=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,nowMs:()=>clock.now,backfill:async()=>({ready:options.backfillReady??true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  connection.on('connected',(details:{generationId:number})=>recovery.handleInitialConnected({generationId:details.generationId}));
  connection.on('unexpectedDisconnect',(details)=>recovery.handleUnexpectedDisconnect(details));
  connection.on('reconnected',(details)=>recovery.handleReconnected(details));
  const hostRef:{current?:StrategyHostLifecycle}={};
  connection.on('reconnectFailed',(details:{reason?:string})=>{recovery.fault(details.reason);void hostRef.current?.fault(new Error(details.reason??'RECONNECT_FAILED'));});
  // Before host.start() has successfully returned, host.start() itself is the
  // sole owner of the initial RUNNING transition (via onReady ->
  // recovery.waitUntilReady()). Calling host.recovered() here too, while the
  // host is still transiting through READY/DEGRADED during startup, races
  // start()'s own unconditional RUNNING transition and produces an illegal
  // RUNNING->RUNNING transition. See startupComplete / start() below.
  let startupComplete=false;
  recovery.on('stateChanged',(state)=>{
    if(state==='DEGRADED')void hostRef.current?.degrade('MARKET_DATA_DEGRADED');
    if(state==='READY'){
      if(!health.confirmRecoveryReady(recovery.getGenerationId()))connection.failRecovery(recovery.getGenerationId(),'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
      else if(startupComplete)void hostRef.current?.recovered('MARKET_DATA_READY');
    }
    if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');
  });
  const host=new StrategyHostLifecycle({strategyId:'TEST',runtimeId:'test',hooks:{
    warmup:()=>undefined,
    // The live-gate wiring under test: RUNNING must not be granted until recovery proves a current-generation live event was observed.
    onReady:async()=>{const ready=recovery.waitUntilReady(readyTimeoutMs);ready.catch(()=>undefined);await connection.connect();await ready;},
    onEod:()=>undefined,onShutdown:()=>undefined,onFault:()=>undefined,
  }});
  hostRef.current=host;
  const emitNiftyTick=(generationId:number):void=>{connection.emit('message',Buffer.alloc(0),{generationId});health.noteValidMarketEvent(generationId);health.noteNiftyTick(generationId);recovery.handleLiveTick({ sourceTimestamp: new Date(clock.now), receivedAt: new Date(clock.now), generationId: generationId });};
  // Mirrors the live entrypoints: `await host.start(); if (host.getState() !==
  // 'RUNNING') return; startupComplete = true;`. Only marked complete once
  // host.start() has actually succeeded, never before.
  const start=async():Promise<void>=>{await host.start();if(host.getState()==='RUNNING')startupComplete=true;};
  return {clock,client,connection,health,recovery,host,start,emitNiftyTick};
}

test('A6: cold start -- host does not reach RUNNING until an accepted current-generation NIFTY tick arrives, and health confirmation succeeds without opening the circuit',async()=>{
  const {host,recovery,connection,start,emitNiftyTick}=buildStack();
  const starting=start();
  await flush();
  assert.equal(host.getState(),'READY'); // connect is in flight; no tick observed yet
  assert.equal(host.canEvaluate(),false);
  emitNiftyTick(1);
  await starting;
  assert.equal(host.getState(),'RUNNING');
  assert.equal(host.canEvaluate(),true);
  assert.equal(connection.getReconnectCircuitSnapshot().state,'CLOSED'); // health confirmation succeeded on the very first tick; circuit was never opened
  assert.equal(recovery.listenerCount('stateChanged'),1); // only the persistent handler remains; waitUntilReady's one-shot listener is gone
});

test('A6: cold-start readiness timeout faults the host closed and leaks no listener',async()=>{
  const {host,recovery,start}=buildStack(15); // no tick is ever supplied
  await start();
  assert.equal(host.getState(),'FAULTED');
  assert.equal(host.canEvaluate(),false);
  assert.equal(recovery.listenerCount('stateChanged'),1); // only the persistent handler; waitUntilReady's one-shot listener is gone
});

test('A6: an immediate disconnect right after cold-start readiness still degrades RUNNING correctly, and a genuine post-startup recovery reaches RUNNING again via the persistent listener (not onReady, which already ran once)',async()=>{
  const {host,client,clock,connection,recovery,start,emitNiftyTick}=buildStack();
  const starting=start();await flush();emitNiftyTick(1);await starting;
  assert.equal(host.getState(),'RUNNING');
  client.emit('disconnected',{code:1006},true);await flush();
  assert.equal(host.getState(),'DEGRADED');
  assert.equal(host.canEvaluate(),false);
  clock.advanceBy(10);await flush(); // fires the scheduled reconnect
  assert.equal(connection.getGenerationId(),2);
  assert.equal(recovery.getState(),'WAITING_FOR_FRESH_TICK'); // backfill already completed synchronously
  // startupComplete flipped after start() resolved; onReady already ran once
  // and cannot run again, so this genuine post-startup DEGRADED -> RUNNING
  // recovery must be owned by the persistent stateChanged listener.
  emitNiftyTick(2);
  await flush();
  assert.equal(recovery.getState(),'READY');
  assert.equal(host.getState(),'RUNNING');
});

test('A6: V8-style composition -- historical readiness=true does not substitute for live readiness',async()=>{
  const historicalReady=true; // simulates evaluator.checkStartupReadiness(date).ready already having passed
  assert.equal(historicalReady,true);
  const {host,start}=buildStack(15); // no live tick is ever supplied
  await start();
  assert.equal(host.getState(),'FAULTED'); // the live gate alone still blocks RUNNING
  assert.equal(host.canEvaluate(),false);
});

test('A6: race -- readiness already proven before host.start() begins is observed immediately, not missed',async()=>{
  const {host,connection,recovery,start,emitNiftyTick}=buildStack();
  await connection.connect();
  emitNiftyTick(1);
  assert.equal(recovery.isEvaluationReady(),true);
  await start();
  assert.equal(host.getState(),'RUNNING');
});

// ---- A6 correction (BLOCKING-1): startup ownership of the initial RUNNING transition ----
//
// Reproduces the exact production sequence the independent review found: a
// transient failure on the very first connect attempt during onReady, using
// the REAL SubscriptionManager (not a bare connection.connect()) because
// SubscriptionManager.subscribeMany() swallows a connect error while
// ConnectionManager is RECONNECTING (subscription.manager.ts) -- that swallow
// is exactly what lets onReady proceed to `await ready` instead of rejecting,
// which is what exposes the DEGRADED -> RUNNING / RUNNING -> RUNNING race.

function buildSubscriptionManagerStack(readyTimeoutMs=5_000,connectFailures=1){
  const clock=new Clock();const client=new FlakyFirstConnectClient(connectFailures);
  const connection=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>clock.now,scheduler:clock});
  const subscriptions=new SubscriptionManager('token',connection);
  const health=new MarketDataHealthMonitorService(connection,{stallMs:1_000,generationGraceMs:1_000,now:()=>clock.now,isMarketSession:()=>true});
  const recovery=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,nowMs:()=>clock.now,backfill:async()=>({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0})});
  connection.on('connected',(details:{generationId:number})=>recovery.handleInitialConnected({generationId:details.generationId}));
  connection.on('unexpectedDisconnect',(details)=>recovery.handleUnexpectedDisconnect(details));
  connection.on('reconnected',(details)=>recovery.handleReconnected(details));
  const hostRef:{current?:StrategyHostLifecycle}={};
  connection.on('reconnectFailed',(details:{reason?:string})=>{recovery.fault(details.reason);void hostRef.current?.fault(new Error(details.reason??'RECONNECT_FAILED'));});
  let startupComplete=false;
  const transitions:string[]=[];
  recovery.on('stateChanged',(state)=>{
    if(state==='DEGRADED')void hostRef.current?.degrade('MARKET_DATA_DEGRADED');
    if(state==='READY'){
      if(!health.confirmRecoveryReady(recovery.getGenerationId()))connection.failRecovery(recovery.getGenerationId(),'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
      else if(startupComplete)void hostRef.current?.recovered('MARKET_DATA_READY');
    }
    if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');
  });
  const host=new StrategyHostLifecycle({
    strategyId:'TEST',runtimeId:'test',
    hooks:{
      warmup:()=>undefined,
      // Exactly the V4/V8 shape: register the waiter, then subscribe (which
      // owns and may swallow the first connect attempt's failure), then await
      // the waiter.
      onReady:async()=>{const ready=recovery.waitUntilReady(readyTimeoutMs);ready.catch(()=>undefined);await subscriptions.subscribe('NSE_INDEX|Nifty 50',MarketDataSubscriptionMode.FULL);await ready;},
      onEod:()=>undefined,onShutdown:()=>undefined,onFault:()=>undefined,
    },
    log:(event)=>transitions.push(`${event.previous}->${event.state}`),
  });
  hostRef.current=host;
  const emitNiftyTick=(generationId:number):void=>{connection.emit('message',Buffer.alloc(0),{generationId});health.noteValidMarketEvent(generationId);health.noteNiftyTick(generationId);recovery.handleLiveTick({ sourceTimestamp: new Date(clock.now), receivedAt: new Date(clock.now), generationId: generationId });};
  const start=async():Promise<void>=>{await host.start();if(host.getState()==='RUNNING')startupComplete=true;};
  return {clock,client,connection,health,recovery,host,start,transitions,emitNiftyTick};
}

test('A6 correction (BLOCKING-1): a transient failure on the very first connect attempt during onReady, recovered through the real SubscriptionManager path, ends RUNNING exactly once and never FAULTED',async()=>{
  const {host,clock,connection,recovery,start,transitions,emitNiftyTick}=buildSubscriptionManagerStack(5_000,1);
  const starting=start();
  await flush();
  // SubscriptionManager.subscribeMany() swallowed the first connect()
  // rejection because ConnectionManager was already RECONNECTING by the time
  // its catch block ran; onReady is still pending inside `await ready`.
  assert.equal(host.getState(),'DEGRADED');
  assert.equal(host.canEvaluate(),false);
  clock.advanceBy(10); // fires the scheduled reconnect; the second connect() attempt succeeds
  await flush();
  assert.equal(connection.getGenerationId(),1);
  assert.equal(recovery.getState(),'WAITING_FOR_FRESH_TICK'); // continuity/backfill already completed for generation 1
  assert.equal(host.getState(),'DEGRADED'); // still not RUNNING: no accepted current-generation tick yet
  emitNiftyTick(1);
  await starting;
  assert.equal(host.getState(),'RUNNING');
  assert.equal(host.canEvaluate(),true);
  assert.equal(transitions.filter((value)=>value.endsWith('->RUNNING')).length,1); // exactly one RUNNING transition, owned by host.start() itself
  assert.ok(!transitions.includes('RUNNING->FAULTED'));
  assert.equal(recovery.listenerCount('stateChanged'),1); // only the persistent handler; waitUntilReady's one-shot listener is gone
});

test('A6 correction (BLOCKING-1): the same transient-first-connect-failure sequence, with a slower backfill so DEGRADED persists across multiple recovery-coordinator state changes before READY, still ends RUNNING exactly once',async()=>{
  type Result={ready:boolean;reason:string;missingMinutes:number;duplicateMinutes:number};
  let releaseBackfill!:()=>void;
  const clock=new Clock();const client=new FlakyFirstConnectClient(1);
  const connection=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>clock.now,scheduler:clock});
  const subscriptions=new SubscriptionManager('token',connection);
  const health=new MarketDataHealthMonitorService(connection,{stallMs:1_000,generationGraceMs:1_000,now:()=>clock.now,isMarketSession:()=>true});
  const recovery=new MarketDataRecoveryCoordinatorService({isMarketSession:()=>true,nowMs:()=>clock.now,backfill:()=>new Promise<Result>((resolve)=>{releaseBackfill=()=>resolve({ready:true,reason:'OK',missingMinutes:0,duplicateMinutes:0});})});
  connection.on('connected',(details:{generationId:number})=>recovery.handleInitialConnected({generationId:details.generationId}));
  connection.on('unexpectedDisconnect',(details)=>recovery.handleUnexpectedDisconnect(details));
  connection.on('reconnected',(details)=>recovery.handleReconnected(details));
  const hostRef:{current?:StrategyHostLifecycle}={};
  connection.on('reconnectFailed',(details:{reason?:string})=>{recovery.fault(details.reason);void hostRef.current?.fault(new Error(details.reason??'RECONNECT_FAILED'));});
  let startupComplete=false;
  const transitions:string[]=[];
  recovery.on('stateChanged',(state)=>{
    if(state==='DEGRADED')void hostRef.current?.degrade('MARKET_DATA_DEGRADED');
    if(state==='READY'){
      if(!health.confirmRecoveryReady(recovery.getGenerationId()))connection.failRecovery(recovery.getGenerationId(),'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
      else if(startupComplete)void hostRef.current?.recovered('MARKET_DATA_READY');
    }
    if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');
  });
  const host=new StrategyHostLifecycle({
    strategyId:'TEST',runtimeId:'test',
    hooks:{
      warmup:()=>undefined,
      onReady:async()=>{const ready=recovery.waitUntilReady(5_000);ready.catch(()=>undefined);await subscriptions.subscribe('NSE_INDEX|Nifty 50',MarketDataSubscriptionMode.FULL);await ready;},
      onEod:()=>undefined,onShutdown:()=>undefined,onFault:()=>undefined,
    },
    log:(event)=>transitions.push(`${event.previous}->${event.state}`),
  });
  hostRef.current=host;
  const emitNiftyTick=(generationId:number):void=>{connection.emit('message',Buffer.alloc(0),{generationId});health.noteValidMarketEvent(generationId);health.noteNiftyTick(generationId);recovery.handleLiveTick({ sourceTimestamp: new Date(clock.now), receivedAt: new Date(clock.now), generationId: generationId });};
  const starting=(async()=>{await host.start();if(host.getState()==='RUNNING')startupComplete=true;})();
  await flush();
  assert.equal(host.getState(),'DEGRADED');
  clock.advanceBy(10);
  await flush();
  assert.equal(recovery.getState(),'BACKFILLING'); // backfill has not resolved yet -- host must remain DEGRADED, not RUNNING
  assert.equal(host.getState(),'DEGRADED');
  releaseBackfill();
  await flush();
  assert.equal(recovery.getState(),'WAITING_FOR_FRESH_TICK');
  emitNiftyTick(1);
  await starting;
  assert.equal(host.getState(),'RUNNING');
  assert.equal(transitions.filter((value)=>value.endsWith('->RUNNING')).length,1);
  assert.ok(!transitions.includes('RUNNING->FAULTED'));
  assert.equal(recovery.listenerCount('stateChanged'),1);
});
