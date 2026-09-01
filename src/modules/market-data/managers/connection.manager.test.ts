import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import MarketDataHealthMonitorService from '../services/market-data-health-monitor.service';
import { StrategyHostLifecycle } from '../services/strategy-host-lifecycle.service';
import { MarketDataWebSocketOpenTimeoutError } from '../client/websocket.client';
import ConnectionManager, { ConnectionEventDetails, ConnectionManagerScheduler, ConnectionState } from './connection.manager';

class FakeScheduler implements ConnectionManagerScheduler {
  now = 0;
  private nextId = 0;
  private readonly active = new Map<number, { at: number; callback: () => void }>();
  private readonly all = new Map<number, () => void>();
  setTimeout(callback: () => void, delayMs: number): number { const id=this.nextId++;this.active.set(id,{at:this.now+delayMs,callback});this.all.set(id,callback);return id; }
  clearTimeout(handle: unknown): void { this.active.delete(handle as number); }
  advanceBy(milliseconds: number): void { const target=this.now+milliseconds; let next=[...this.active].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]).find(([,task])=>task.at<=target);while(next){this.active.delete(next[0]);this.now=next[1].at;next[1].callback();next=[...this.active].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]).find(([,task])=>task.at<=target);}this.now=target; }
  fireEvenIfCleared(id: number): void { this.all.get(id)?.(); }
  callback(id: number): () => void { return this.all.get(id)!; }
  reuseNextHandle(id: number): void { this.nextId=id; }
  activeIds(): number[] { return [...this.active.keys()]; }
}

class FakeClient extends EventEmitter {
  connects = 0;
  failures = 0;
  hangs = 0;
  recoveryDisconnects = 0;
  async connect(): Promise<void> { this.connects+=1;if(this.failures>0){this.failures-=1;throw new Error('connect failed');}if(this.hangs>0){this.hangs-=1;return new Promise<void>(()=>undefined);}this.emit('connected'); }
  disconnect(): void { this.emit('disconnected',{code:1000,intentional:true},true); }
  disconnectForRecovery(): void { this.recoveryDisconnects+=1;this.emit('disconnected',{code:1006,intentional:false},true); }
  send(): void {}
}

/**
 * Models a socket whose disconnectForRecovery() does NOT immediately deliver the actual
 * close/transport-invalidating event -- the current socket remains (per this model) physically
 * open for a measurable interval after invalidation is requested, until finishRecoveryClose() is
 * explicitly invoked. FakeClient's disconnectForRecovery() (above) fires 'disconnected'
 * synchronously and can never exercise this gap.
 */
class DelayedRecoveryClient extends EventEmitter {
  connects = 0;
  recoveryDisconnects = 0;
  private pendingRecoveryClose = false;
  async connect(): Promise<void> { this.connects+=1;this.emit('connected'); }
  disconnect(): void { this.emit('disconnected',{code:1000,intentional:true},true); }
  disconnectForRecovery(): void { this.recoveryDisconnects+=1;this.pendingRecoveryClose=true; }
  finishRecoveryClose(): void { if(!this.pendingRecoveryClose)return;this.pendingRecoveryClose=false;this.emit('disconnected',{code:1006,reason:'STALL_RECOVERY',wasClean:false,intentional:false},true); }
  send(): void {}
}

class CancelableClient extends EventEmitter {
  connects=0;private resolve?:()=>void;private reject?: (error:Error)=>void;
  connect():Promise<void>{this.connects+=1;return new Promise<void>((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}
  succeed():void{const resolve=this.resolve;this.resolve=undefined;this.reject=undefined;this.emit('connected');resolve?.();}
  disconnect():void{const reject=this.reject;this.resolve=undefined;this.reject=undefined;this.emit('disconnected',{code:1000,intentional:true},true);reject?.(new Error('cancelled'));}
  disconnectForRecovery():void{this.disconnect();}
  send():void{}
}

class HandshakeClient extends EventEmitter {
  connects = 0;
  silentAttempts = 0;

  constructor(private readonly scheduler: FakeScheduler, private readonly timeoutMs: number) { super(); }

  connect(): Promise<void> {
    this.connects += 1;
    if (this.silentAttempts > 0) {
      this.silentAttempts -= 1;
      return new Promise<void>((_resolve, reject) => {
        this.scheduler.setTimeout(() => reject(new MarketDataWebSocketOpenTimeoutError(this.timeoutMs)), this.timeoutMs);
      });
    }
    this.emit('connected');
    return Promise.resolve();
  }

  disconnect(): void { this.emit('disconnected', { code:1000, intentional:true }, true); }
  disconnectForRecovery(): void { this.emit('disconnected', { code:1006, intentional:false }, true); }
  send(): void {}
}

function setup(options: Record<string, unknown> = {}): { client: FakeClient; scheduler: FakeScheduler; manager: ConnectionManager } {
  const client=new FakeClient();const scheduler=new FakeScheduler();
  const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler,...options});
  return {client,scheduler,manager};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};

test('unexpected disconnect reconnects once and only recovery-ready resets breaker history',async()=>{
  const {client,scheduler,manager}=setup();let reconnects=0;manager.on('reconnected',()=>{reconnects+=1;});
  await manager.connect();client.emit('disconnected',{code:1006,reason:'stale socket'},true);
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);scheduler.advanceBy(10);await flush();
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),2);assert.equal(reconnects,1);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
  assert.equal(manager.confirmRecoveryReady(2),true);assert.equal(manager.getReconnectCircuitSnapshot().attempts,0);
});

test('intentional disconnect cancels retry ownership and never reconnects',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();client.emit('disconnected',{code:1006},true);const timer=scheduler.activeIds().at(-1)!;manager.disconnect();scheduler.fireEvenIfCleared(timer);await flush();
  assert.equal(manager.getState(),ConnectionState.DISCONNECTED);assert.equal(client.connects,1);
});

test('health, connection error and close notifications create one logical reconnect attempt',async()=>{
  const {client,manager}=setup();let disconnects=0;manager.on('unexpectedDisconnect',()=>{disconnects+=1;});await manager.connect();
  assert.equal(manager.reconnectForHealth('STALL',1),true);client.emit('connectionError',new Error('duplicate'));client.emit('disconnected',{code:1006},true);manager.reconnectForHealth('RECOVERY_TIMEOUT',1);
  assert.equal(disconnects,1);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);assert.equal(client.recoveryDisconnects,1);
});

test('a direct connect call cannot bypass an owned backoff timer',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();client.emit('disconnected',{code:1006},true);await manager.connect();assert.equal(client.connects,1);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
  scheduler.advanceBy(10);await flush();assert.equal(client.connects,2);assert.equal(manager.getGenerationId(),2);
});

test('a cancelled in-flight connect settles before an explicit fresh connect starts',async()=>{
  const client=new CancelableClient();const scheduler=new FakeScheduler();const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler});
  const first=manager.connect();const rejected=assert.rejects(first,/cancelled/);manager.disconnect();const second=manager.connect();await rejected;await flush();assert.equal(client.connects,2);client.succeed();await second;assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),1);
});

test('an owned retry waiting on a superseding connect revalidates state before it resumes',async()=>{
  const client=new CancelableClient();const scheduler=new FakeScheduler();const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler});
  const initial=manager.connect();client.succeed();await initial;manager.disconnect();const current=manager.connect();
  client.emit('disconnected',{code:1006,intentional:false},true);scheduler.advanceBy(10);await flush();assert.equal(client.connects,2);
  client.succeed();await current;await flush();assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),2);assert.equal(client.connects,2);
});

test('connection error on an open socket bypasses health grace and starts recovery immediately',async()=>{
  const {client,scheduler,manager}=setup();const health=new MarketDataHealthMonitorService(manager,{stallMs:100,generationGraceMs:100,now:()=>scheduler.now,isMarketSession:()=>true});await manager.connect();assert.equal(health.getSnapshot().insideGrace,true);client.emit('connectionError',new Error('socket failed'));
  assert.equal(manager.getState(),ConnectionState.RECONNECTING);assert.equal(health.getSnapshot().healthState,'RECOVERING');assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);assert.equal(client.recoveryDisconnects,1);
});

test('failed automatic attempts open the circuit at the configured threshold',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectAttempts:2});client.failures=10;let failures=0;manager.on('reconnectFailed',()=>{failures+=1;});
  await assert.rejects(manager.connect());scheduler.advanceBy(10);await flush();scheduler.advanceBy(20);await flush();
  assert.equal(manager.getState(),ConnectionState.FAULTED);assert.deepEqual(manager.getReconnectCircuitSnapshot(),{state:'OPEN',attempts:2,lastFailureReason:'CONNECT_ERROR',activeGenerationId:0,pendingRecoveryGenerationId:null,reconnectEpisodeActive:false,nextRetryAtMs:null});assert.equal(failures,1);assert.equal(scheduler.activeIds().length,0);
  await assert.rejects(manager.connect(),/circuit is OPEN/);
});

test('a first-ever silent handshake enters the authoritative reconnect episode exactly once',async()=>{
  const scheduler=new FakeScheduler();const client=new HandshakeClient(scheduler,5);client.silentAttempts=1;
  const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler});
  const initial=manager.connect();assert.equal(manager.getState(),ConnectionState.CONNECTING);scheduler.advanceBy(5);await assert.rejects(initial,/did not open/);await flush();
  assert.equal(manager.getState(),ConnectionState.RECONNECTING);assert.deepEqual(manager.getReconnectCircuitSnapshot(),{state:'CLOSED',attempts:1,lastFailureReason:'WEBSOCKET_OPEN_TIMEOUT',activeGenerationId:0,pendingRecoveryGenerationId:null,reconnectEpisodeActive:true,nextRetryAtMs:15});assert.equal(client.connects,1);
});

test('repeated silent handshakes are bounded by the existing attempt breaker',async()=>{
  const scheduler=new FakeScheduler();const client=new HandshakeClient(scheduler,5);client.silentAttempts=10;
  const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:2,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:20,now:()=>scheduler.now,scheduler});
  const initial=manager.connect();scheduler.advanceBy(5);await assert.rejects(initial);await flush();
  scheduler.advanceBy(10);await flush();scheduler.advanceBy(5);await flush();scheduler.advanceBy(20);await flush();scheduler.advanceBy(5);await flush();
  assert.equal(client.connects,3);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.deepEqual(manager.getReconnectCircuitSnapshot(),{state:'OPEN',attempts:2,lastFailureReason:'WEBSOCKET_OPEN_TIMEOUT',activeGenerationId:0,pendingRecoveryGenerationId:null,reconnectEpisodeActive:false,nextRetryAtMs:null});
});

test('a later socket open retains handshake failures until current-generation recovery confirmation',async()=>{
  const scheduler=new FakeScheduler();const client=new HandshakeClient(scheduler,5);client.silentAttempts=1;
  const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler});
  const initial=manager.connect();scheduler.advanceBy(5);await assert.rejects(initial);await flush();scheduler.advanceBy(10);await flush();
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),1);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'WEBSOCKET_OPEN_TIMEOUT');
  assert.equal(manager.confirmRecoveryReady(1),true);assert.equal(manager.getReconnectCircuitSnapshot().attempts,0);assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,null);
});

test('repeated socket opens without market-data recovery retain failures and eventually OPEN',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectAttempts:2});await manager.connect();manager.confirmRecoveryReady(1);
  manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(manager.getGenerationId(),2);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
  manager.reconnectForHealth('HEALTH_GRACE_EXPIRED',2);scheduler.advanceBy(20);await flush();assert.equal(manager.getGenerationId(),3);assert.equal(manager.getReconnectCircuitSnapshot().attempts,2);
  manager.reconnectForHealth('HEALTH_GRACE_EXPIRED',3);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.getReconnectCircuitSnapshot().state,'OPEN');assert.equal(client.connects,3);
});

test('maximum recovery duration spans bare socket opens and cannot restart per generation',async()=>{
  const {scheduler,manager}=setup({maximumReconnectAttempts:10,maximumReconnectDurationMs:15});await manager.connect();manager.confirmRecoveryReady(1);manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();scheduler.advanceBy(6);
  manager.reconnectForHealth('HEALTH_GRACE_EXPIRED',2);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.getReconnectCircuitSnapshot().state,'OPEN');
});

test('a scheduled retry cannot execute beyond the maximum recovery duration',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectAttempts:10,maximumReconnectDurationMs:5});await manager.connect();manager.confirmRecoveryReady(1);manager.reconnectForHealth('STALL',1);
  assert.equal(manager.getReconnectCircuitSnapshot().nextRetryAtMs,5);scheduler.advanceBy(5);await flush();assert.equal(client.connects,1);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');
});

test('the episode deadline opens the breaker while a reconnect promise never settles',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectAttempts:10,maximumReconnectDurationMs:50});await manager.connect();manager.confirmRecoveryReady(1);client.hangs=1;manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(client.connects,2);assert.equal(manager.getState(),ConnectionState.RECONNECTING);
  scheduler.advanceBy(40);await flush();assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');assert.equal(scheduler.activeIds().length,0);
});

test('the episode deadline remains armed after socket open until recovery is confirmed',async()=>{
  const {scheduler,manager}=setup({maximumReconnectAttempts:10,maximumReconnectDurationMs:50});await manager.connect();manager.confirmRecoveryReady(1);manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),2);
  scheduler.advanceBy(40);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.confirmRecoveryReady(2),false);
});

// 2026-09-01 V4 live-incident: PHYSICAL vs LOGICAL clock separation. Terra's independent
// production-safety review rejected an earlier fix (ConnectionManager.confirmSourceDataRecovered())
// that cleared LOGICAL recovery bookkeeping on REST/backfill success -- that could let a socket
// which keeps physically reconnecting without ever getting a fresh live tick reset its own
// fail-closed budget indefinitely. The corrected design instead gives the physical transport
// outage its own independent anchor (transportOutageStartedAt) used ONLY for MARKET_DATA_RECONNECTED
// downtimeMs telemetry; the logical anchor (reconnectStartedAt) is untouched by this class and
// keeps spanning bare reconnects/backfills exactly as before, cleared ONLY by a genuine
// confirmRecoveryReady()/confirmTransportReady() (or a manual disconnect()).

test('MANDATORY ADVERSARIAL: repeated transport flaps without confirmed recovery cannot reset the logical safety budget indefinitely',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectDurationMs:1_000,maximumReconnectAttempts:1_000,maximumReconnectDelayMs:10});
  const downtimes:number[]=[];manager.on('reconnected',(details:ConnectionEventDetails)=>{downtimes.push(details.downtimeMs!);});
  await manager.connect();manager.confirmRecoveryReady(1);
  // Repeated flap cycles: the socket fails, transport reconnects quickly, and (conceptually)
  // REST/backfill/source recovery succeeds each time -- but NO fresh valid live tick ever arrives
  // and confirmRecoveryReady() is deliberately never called again. In the corrected design,
  // REST/backfill success has NO API surface on ConnectionManager at all (that is exactly what
  // made the rejected patch unsafe), so this loop is simulated purely as repeated physical flaps.
  for (let i=0;i<5;i+=1) {
    client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);
    scheduler.advanceBy(10);await flush();
  }
  assert.equal(manager.getGenerationId(),6); // 1 baseline connect + 5 flaps
  assert.equal(manager.getState(),ConnectionState.CONNECTED);
  // Every physical reconnect's downtime reflects only ITS OWN short outage -- never a growing,
  // cumulative logical duration.
  assert.deepEqual(downtimes,[10,10,10,10,10]);
  // The LOGICAL unresolved-recovery clock has been running, uninterrupted, since the very first
  // flap; reconnectAttempts (logical) keeps accumulating rather than resetting per flap.
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,5);
  assert.equal(manager.getReconnectCircuitSnapshot().state,'CLOSED');
  // Advancing to the ORIGINAL logical deadline (measured from the FIRST flap, not the fifth) must
  // still fail closed -- no amount of successful, brief, physical reconnects extends it.
  scheduler.advanceBy(950);
  assert.equal(manager.getState(),ConnectionState.FAULTED);
  assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');
});

test('MANDATORY: after genuine full recovery confirmation, a later independent outage gets a completely fresh physical and logical episode',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectDurationMs:1_000});
  let lastReconnected:ConnectionEventDetails|undefined;manager.on('reconnected',(details:ConnectionEventDetails)=>{lastReconnected=details;});
  await manager.connect();manager.confirmRecoveryReady(1);
  // Episode 1: a real disconnect, a fast transport reconnect, then a long CONNECTED-but-unconfirmed
  // wait -- ended only by the real, unchanged confirmRecoveryReady() path (a genuine current-
  // generation strategy-safe confirmation, e.g. after backfill AND a fresh live tick).
  client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);scheduler.advanceBy(10);await flush();
  assert.equal(manager.getGenerationId(),2);assert.equal(lastReconnected?.downtimeMs,10);
  scheduler.advanceBy(900);
  assert.equal(manager.confirmRecoveryReady(2),true); // genuine full READY -- clears logical bookkeeping
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,0);
  // Episode 2: a wholly independent, fast disconnect/reconnect well afterward.
  client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);scheduler.advanceBy(10);await flush();
  assert.equal(manager.getGenerationId(),3);assert.equal(manager.getState(),ConnectionState.CONNECTED);
  // Fresh physical transport anchor -- not episode 1's stale ~910ms.
  assert.equal(lastReconnected?.downtimeMs,10);
  // No stale deadline from episode 1 (would have fired at t=1000 had confirmRecoveryReady() not
  // cleared it) can fault episode 2.
  scheduler.advanceBy(940);
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),3);
  assert.equal(manager.getReconnectCircuitSnapshot().state,'CLOSED');
});

test('MANDATORY: physical and logical clocks are independent, proven on the exact scaled incident timeline',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectDurationMs:1_000,maximumReconnectDelayMs:10});
  const downtimes:number[]=[];manager.on('reconnected',(details:ConnectionEventDetails)=>{downtimes.push(details.downtimeMs!);});
  await manager.connect();manager.confirmRecoveryReady(1);
  // T=0: logical degradation + physical outage both start together.
  client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);
  // T=10: transport reconnects.
  scheduler.advanceBy(10);await flush();
  assert.equal(manager.getGenerationId(),2);assert.equal(downtimes[0],10); // physical downtime = 10
  // T=910: a long source/backfill wait elapses and "source recovery succeeds" -- by design this has
  // NO effect on ConnectionManager. Only confirmRecoveryReady()/confirmTransportReady() (a fresh
  // live tick's full strategy-safe confirmation) may clear logical bookkeeping, and neither is
  // called here, so the logical episode remains active, unconfirmed, since T=0.
  scheduler.advanceBy(900);
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getReconnectCircuitSnapshot().state,'CLOSED');
  // T=910: a second, independent physical outage begins.
  client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);
  // T=920: transport reconnects again.
  scheduler.advanceBy(10);await flush();
  assert.equal(manager.getGenerationId(),3);assert.equal(downtimes[1],10); // physical downtime = 10 again, not ~910
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,2); // logical attempts still accumulating since T=0
  assert.equal(manager.getState(),ConnectionState.CONNECTED);
  // At the logical max deadline (T=1000, measured from T=0), with no full READY confirmation ever
  // having arrived, the connection must still fail closed.
  scheduler.advanceBy(80);
  assert.equal(manager.getState(),ConnectionState.FAULTED);
  assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');
});

// Terra MEDIUM finding: for a health-driven recovery, the physical clock previously started the
// instant beginReconnect() was entered -- before the current socket was actually invalidated/
// closed -- so physical downtime could include time the socket was still demonstrably open.
// Exercises the real reconnectForHealth()/disconnectForRecovery()/'disconnected' seam (never
// private state) with a client that deliberately withholds the close event for a known interval.
test('MANDATORY: a health-driven recovery anchors physical downtime at actual socket invalidation, not health-stall detection',async()=>{
  const client=new DelayedRecoveryClient();const scheduler=new FakeScheduler();
  const manager=new ConnectionManager('token',client as never,{maximumReconnectAttempts:10,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:110,maximumReconnectDelayMs:110,now:()=>scheduler.now,scheduler});
  let lastReconnected:ConnectionEventDetails|undefined;manager.on('reconnected',(details:ConnectionEventDetails)=>{lastReconnected=details;});
  await manager.connect();manager.confirmRecoveryReady(1);
  // T=0: health stall detected -- logical recovery starts immediately.
  assert.equal(manager.reconnectForHealth('STALL',1),true);
  assert.equal(client.recoveryDisconnects,1); // invalidation was requested...
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
  // T=0..100: the current socket has NOT yet actually closed -- it remains physically open for
  // this modeled interval. Advancing fake time through it must not itself produce a reconnect (the
  // scheduled retry is 110ms out) or any premature physical-downtime accounting.
  scheduler.advanceBy(100);
  assert.equal(manager.getState(),ConnectionState.RECONNECTING);
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1); // no additional attempt yet
  // T=100: actual socket invalidation completes -- the first point with real proof of transport
  // loss. This is where the physical anchor must be set, not T=0.
  client.finishRecoveryClose();
  // T=110: the scheduled retry fires and the new transport connects.
  scheduler.advanceBy(10);await flush();
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),2);
  // Physical downtime = 10 (T=100 to T=110), NOT ~110 (T=0 to T=110): it excludes the pre-close
  // interval where the socket was still physically open and no strategy-safe recovery was ever
  // fabricated from that interval.
  assert.equal(lastReconnected?.downtimeMs,10);
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1); // reconnectAttempts was not reset
  // reconnectStartedAt remains anchored to the original T=0 health degradation, and the logical
  // deadline was never restarted: no confirmRecoveryReady() was ever called, so advancing to the
  // ORIGINAL T=0-based 1000ms budget (890 more, landing at T=1000, not T=1100) must still fail
  // closed.
  scheduler.advanceBy(890);
  assert.equal(manager.getState(),ConnectionState.FAULTED);
  assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');
});

// Terra MEDIUM finding (companion to the health-driven test above): a raw CURRENT connectionError
// was previously routed through the SAME deferred-physical-outage path as a health stall, even
// though a genuine current-generation connectionError whose client contract already proves the
// socket physically CLOSED (transportClosed=true on the 'connectionError' event -- see
// websocket.client.ts's 'error' listener) has no separate close left to wait for: the transport is
// already dead at the error itself. Deferring there would UNDERCOUNT downtime by excluding the
// error-to-close interval even though the socket was unusable throughout it. Exercises the real
// 'connectionError'/'disconnected' seam (never private state) via ConnectionManager's public event
// surface, mirroring the health-driven test's shape so the two prove the intentional split:
//   RAW ERROR (transport already CLOSED): error -> reconnect (physical anchor at the error)
//   HEALTH STALL:                          actual close -> reconnect (physical anchor at the close)
test('MANDATORY: a raw current connectionError with a known-closed transport anchors physical downtime at the error itself, not the later close',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectAttempts:10,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:110,maximumReconnectDelayMs:110});
  let lastReconnected:ConnectionEventDetails|undefined;manager.on('reconnected',(details:ConnectionEventDetails)=>{lastReconnected=details;});
  await manager.connect();manager.confirmRecoveryReady(1);
  // T=0: a genuine raw connectionError fires on the CURRENT socket. The client asserts (second
  // argument) that readyState has already transitioned to CLOSED -- the real contract for a
  // genuine transport failure on the global WebSocket implementation used here. Both logical
  // recovery AND the physical outage must start immediately, together.
  client.emit('connectionError',new Error('econnreset'),true);
  assert.equal(manager.getState(),ConnectionState.RECONNECTING); // logical recovery started at T=0
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
  assert.equal(client.recoveryDisconnects,0); // nothing left to invalidate -- unlike reconnectForHealth(), no disconnectForRecovery() call
  // T=0..100: the close/disconnected callback for this same already-dead socket has not arrived
  // yet. Advancing fake time through it must not itself produce a reconnect (the scheduled retry
  // is 110ms out).
  scheduler.advanceBy(100);
  // T=100: the close/disconnected callback finally arrives for the same outage, followed
  // immediately by a duplicate close signal for good measure -- neither may restart or duplicate
  // the physical anchor already set at T=0.
  client.emit('disconnected',{code:1006,reason:'CONNECTION_ERROR'},true);
  client.emit('disconnected',{code:1006,reason:'DUPLICATE_CLOSE'},true);
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1); // episode was not restarted/duplicated
  // T=110: the scheduled retry fires and the new transport connects.
  scheduler.advanceBy(10);await flush();
  assert.equal(manager.getState(),ConnectionState.CONNECTED);assert.equal(manager.getGenerationId(),2);
  // Physical downtime = 110 (T=0 to T=110) -- the FULL error-to-reconnect interval, NOT 10 (T=100
  // to T=110): the transport was already dead throughout, so the close at T=100 must not restart
  // the physical anchor.
  assert.equal(lastReconnected?.downtimeMs,110);
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1); // reconnectAttempts retained normal semantics, not reset
  // logical reconnectStartedAt remains anchored to the original T=0 error, and the logical deadline
  // was never restarted: no confirmRecoveryReady() was ever called, so advancing to the ORIGINAL
  // T=0-based 1000ms budget (890 more, landing at T=1000, not T=1110) must still fail closed.
  scheduler.advanceBy(890);
  assert.equal(manager.getState(),ConnectionState.FAULTED);
  assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'RECONNECT_DURATION_EXHAUSTED');
});

test('a reconnect attempt failure while already physically down continues from the same physical outage, not a fresh one',async()=>{
  const {client,scheduler,manager}=setup();let lastReconnected:ConnectionEventDetails|undefined;manager.on('reconnected',(details:ConnectionEventDetails)=>{lastReconnected=details;});
  await manager.connect();manager.confirmRecoveryReady(1);
  client.failures=1; // the first scheduled retry attempt fails to even open; the second succeeds
  client.emit('disconnected',{code:1006},true); // T=0: physical outage begins
  scheduler.advanceBy(10);await flush(); // T=10: first retry attempt fails and reschedules
  assert.equal(manager.getGenerationId(),1);assert.equal(manager.getReconnectCircuitSnapshot().attempts,2);
  scheduler.advanceBy(20);await flush(); // T=30: second retry attempt succeeds
  assert.equal(manager.getGenerationId(),2);
  // downtimeMs is measured from the ORIGINAL T=0 outage, not reset by the failed attempt at T=10.
  assert.equal(lastReconnected?.downtimeMs,30);
});

test('synchronous reconnect listeners cannot install work after shutdown',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();manager.once('unexpectedDisconnect',()=>manager.disconnect());client.emit('disconnected',{code:1006},true);assert.equal(manager.getState(),ConnectionState.DISCONNECTED);assert.equal(scheduler.activeIds().length,0);assert.equal(client.connects,1);
});

test('synchronous reconnect-attempt listeners cannot leave an orphan retry timer',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();manager.once('reconnectAttempt',()=>manager.disconnect());client.emit('disconnected',{code:1006},true);assert.equal(manager.getState(),ConnectionState.DISCONNECTED);assert.equal(scheduler.activeIds().length,0);assert.equal(client.connects,1);
});

test('only exact current-generation recovery confirmation resets attempts',async()=>{
  const {scheduler,manager}=setup();await manager.connect();manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();
  assert.equal(manager.confirmRecoveryReady(1),false);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);assert.equal(manager.confirmRecoveryReady(2),true);assert.equal(manager.getReconnectCircuitSnapshot().attempts,0);
});

test('a cleared old-generation retry callback cannot connect or mutate the new generation',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();client.emit('disconnected',{code:1006},true);const oldTimer=scheduler.activeIds().at(-1)!;client.emit('connected');const generation=manager.getGenerationId();scheduler.fireEvenIfCleared(oldTimer);await flush();
  assert.equal(manager.getGenerationId(),generation);assert.equal(client.connects,1);assert.equal(manager.getState(),ConnectionState.CONNECTED);
});

test('a stale callback cannot clear a newer timer when a scheduler reuses its raw handle',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();manager.confirmRecoveryReady(1);manager.reconnectForHealth('STALL',1);const oldId=scheduler.activeIds().at(-1)!;const oldCallback=scheduler.callback(oldId);client.emit('connected');scheduler.reuseNextHandle(oldId);manager.reconnectForHealth('STALL_AGAIN',2);assert.ok(scheduler.activeIds().includes(oldId));oldCallback();assert.ok(scheduler.activeIds().includes(oldId));assert.equal(manager.getState(),ConnectionState.RECONNECTING);manager.disconnect();
});

test('a duplicate socket-open callback cannot advance the active generation',async()=>{
  const {client,manager}=setup();await manager.connect();const generation=manager.getGenerationId();client.emit('connected');
  assert.equal(manager.getGenerationId(),generation);assert.equal(manager.getState(),ConnectionState.CONNECTED);
});

test('a synchronous connected listener can stop recovery without a stale reconnected event',async()=>{
  const {scheduler,manager}=setup();let reconnected=0;manager.on('reconnected',()=>{reconnected+=1;});await manager.connect();manager.confirmRecoveryReady(1);manager.once('connected',()=>manager.disconnect());manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(manager.getState(),ConnectionState.DISCONNECTED);assert.equal(reconnected,0);assert.equal(scheduler.activeIds().length,0);
});

test('an OPEN breaker rejects a delayed retry callback that was already queued',async()=>{
  const {client,scheduler,manager}=setup({maximumReconnectDurationMs:5});await manager.connect();client.emit('disconnected',{code:1006},true);const oldTimer=scheduler.activeIds().at(-1)!;scheduler.now=5;scheduler.fireEvenIfCleared(oldTimer);await flush();
  assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.getReconnectCircuitSnapshot().state,'OPEN');assert.equal(client.connects,1);
});

test('stale recovery success and failure callbacks cannot change current or OPEN state',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(manager.getGenerationId(),2);
  assert.equal(manager.confirmRecoveryReady(1),false);assert.equal(manager.failRecovery(1,'STALE_FAILURE'),false);assert.equal(manager.getState(),ConnectionState.CONNECTED);
  assert.equal(manager.failRecovery(2,'CURRENT_FAILURE'),true);assert.equal(manager.getState(),ConnectionState.FAULTED);assert.equal(manager.confirmRecoveryReady(2),false);assert.equal(manager.getReconnectCircuitSnapshot().lastFailureReason,'CURRENT_FAILURE');client.emit('connected');assert.equal(manager.getGenerationId(),2);assert.equal(manager.getState(),ConnectionState.FAULTED);
});

test('a delayed same-generation recovery failure is rejected after confirmation or disconnect',async()=>{
  const {client,scheduler,manager}=setup();await manager.connect();manager.confirmRecoveryReady(1);manager.reconnectForHealth('STALL',1);scheduler.advanceBy(10);await flush();assert.equal(manager.confirmRecoveryReady(2),true);assert.equal(manager.failRecovery(2,'LATE_AFTER_READY'),false);
  client.emit('disconnected',{code:1006},true);assert.equal(manager.failRecovery(2,'LATE_AFTER_DISCONNECT'),false);assert.notEqual(manager.getState(),ConnectionState.FAULTED);
});

test('reconnect attempt reports deterministic bounded jitter',async()=>{
  const {client,manager}=setup({reconnectJitterMs:100,random:()=>0.5});let attempt:ConnectionEventDetails|undefined;manager.on('reconnectAttempt',(value)=>{attempt=value;});await manager.connect();client.emit('disconnected',{code:1006},true);
  assert.equal(attempt?.baseDelayMs,10);assert.equal(attempt?.jitterMs,50);assert.equal(attempt?.effectiveDelayMs,60);assert.equal(attempt?.attempts,1);
});

test('invalid reconnect bounds fail closed instead of disabling the breaker',()=>{
  const client=new FakeClient();assert.throws(()=>new ConnectionManager('token',client as never,{maximumReconnectAttempts:Number.NaN}),/positive integer/);assert.throws(()=>new ConnectionManager('token',client as never,{maximumReconnectDurationMs:0}),/positive finite/);
});

test('a fresh manager starts with a closed empty circuit',()=>{
  const {manager}=setup();assert.deepEqual(manager.getReconnectCircuitSnapshot(),{state:'CLOSED',attempts:0,lastFailureReason:null,activeGenerationId:0,pendingRecoveryGenerationId:null,reconnectEpisodeActive:false,nextRetryAtMs:null});
});

// TEST-ONLY ACCEPTANCE GAP: a multi-trigger reconnect storm -- a health stall, a
// same-tick socket connectionError, and a duplicate health-stall report all
// landing while a scheduled backoff reconnect is already armed -- must admit
// exactly one active episode, one scheduled attempt, and one generation
// transition; never two overlapping/corrupting reconnect attempts.
test('a multi-trigger reconnect storm racing an armed backoff timer admits exactly one active episode and one generation transition',async()=>{
  const {client,scheduler,manager}=setup();
  await manager.connect(); manager.confirmRecoveryReady(1); // generation 1, healthy
  let episodesStarted=0; manager.on('unexpectedDisconnect',()=>{episodesStarted+=1;});
  assert.equal(manager.reconnectForHealth('STALL',1),true); // opens the one authoritative episode and arms the backoff timer
  client.emit('connectionError',new Error('same-tick socket error')); // a second trigger source, same tick
  assert.equal(manager.reconnectForHealth('STALL_AGAIN',1),false); // a third trigger source -- rejected outright, episode already active
  assert.equal(episodesStarted,1); // exactly one reconnect episode was ever opened by the storm
  assert.equal(manager.getReconnectCircuitSnapshot().attempts,1); // exactly one scheduled backoff attempt, not three
  scheduler.advanceBy(10); await flush();
  assert.equal(manager.getState(),ConnectionState.CONNECTED);
  assert.equal(manager.getGenerationId(),2); // exactly one generation transition survived the storm
  assert.equal(client.connects,2); // exactly one reconnect attempt actually dialed out
});

test('OPEN breaker propagates through the existing host fault path and blocks evaluation',async()=>{
  const {client,scheduler,manager}=setup();const host=new StrategyHostLifecycle({strategyId:'TEST',runtimeId:'test',hooks:{warmup:()=>undefined,onEod:()=>undefined,onShutdown:()=>undefined,onFault:()=>undefined}});let messages=0;manager.on('message',()=>{messages+=1;});await host.start();manager.on('reconnectFailed',(details:{reason?:string})=>{void host.fault(new Error(details.reason??'RECONNECT_FAILED'));});
  await manager.connect();manager.confirmRecoveryReady(1);client.emit('disconnected',{code:1006},true);scheduler.advanceBy(10);await flush();manager.failRecovery(2,'BREAKER_OPEN');client.emit('message',Buffer.alloc(0));assert.throws(()=>manager.send('blocked'),/not available/);await flush();assert.equal(host.getState(),'FAULTED');assert.equal(host.canEvaluate(),false);assert.equal(messages,0);
});
