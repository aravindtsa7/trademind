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
