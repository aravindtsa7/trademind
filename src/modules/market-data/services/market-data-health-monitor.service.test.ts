import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ConnectionState, ReconnectCircuitSnapshot } from '../managers/connection.manager';
import MarketDataHealthMonitorService from './market-data-health-monitor.service';

class FakeConnection extends EventEmitter {
  state = ConnectionState.CONNECTED;
  generation = 1;
  reconnects = 0;
  confirmations = 0;
  attempts = 0;
  lastReason: string | null = null;
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  reconnectForHealth(reason: string, generationId: number): boolean { if(this.state!==ConnectionState.CONNECTED||generationId!==this.generation)return false;this.reconnects+=1;this.attempts+=1;this.lastReason=reason;this.state=ConnectionState.RECONNECTING;return true; }
  confirmRecoveryReady(generationId: number): boolean { if(this.state!==ConnectionState.CONNECTED||generationId!==this.generation)return false;this.confirmations+=1;this.attempts=0;this.lastReason=null;return true; }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot { return {state:'CLOSED',attempts:this.attempts,lastFailureReason:this.lastReason,activeGenerationId:this.generation,pendingRecoveryGenerationId:null,reconnectEpisodeActive:this.state===ConnectionState.RECONNECTING,nextRetryAtMs:null}; }
}

function setup(): {connection:FakeConnection;monitor:MarketDataHealthMonitorService;setNow:(value:number)=>void} {
  const connection=new FakeConnection();let now=0;const monitor=new MarketDataHealthMonitorService(connection as never,{stallMs:100,generationGraceMs:100,heartbeatCheckMs:1_000,now:()=>now,isMarketSession:()=>true});
  return {connection,monitor,setNow:(value)=>{now=value;}};
}

test('repeated health polls inside generation grace remain recovering and do not reconnect',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(99);monitor.checkNow();monitor.checkNow();
  assert.equal(connection.reconnects,0);assert.equal(monitor.isHealthy(),false);assert.equal(monitor.getSnapshot().insideGrace,true);assert.equal(monitor.getSnapshot().healthState,'GRACE');
});

test('current-generation required data and recovery confirmation end grace and reset breaker',()=>{
  const {connection,monitor,setNow}=setup();connection.attempts=2;connection.emit('connected',{generationId:1});setNow(20);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1),true);assert.equal(monitor.isHealthy(),true);assert.equal(connection.confirmations,1);assert.equal(connection.attempts,0);assert.equal(monitor.getSnapshot().insideGrace,false);
});

test('grace expiry without sufficient current-generation data triggers one counted recovery',()=>{
  const {connection,monitor,setNow}=setup();let stalls=0;monitor.on('stalled',()=>{stalls+=1;});connection.emit('connected',{generationId:1});setNow(101);monitor.checkNow();monitor.checkNow();
  assert.equal(connection.reconnects,1);assert.equal(connection.attempts,1);assert.equal(stalls,1);assert.equal(monitor.getSnapshot().healthState,'UNHEALTHY');assert.equal(connection.lastReason,'HEALTH_GRACE_EXPIRED');
});

test('raw and valid non-NIFTY traffic cannot falsely complete grace',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(10);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmRecoveryReady(1),false);setNow(101);monitor.checkNow();assert.equal(connection.reconnects,1);
});

test('fresh traffic cannot extend grace indefinitely without explicit recovery confirmation',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(99);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  setNow(101);monitor.checkNow();assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'HEALTH_GRACE_EXPIRED');assert.equal(monitor.isHealthy(),false);
});

test('an old generation deadline cannot stall a newer generation',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(90);connection.generation=2;connection.emit('connected',{generationId:2});setNow(150);monitor.checkNow();
  assert.equal(connection.reconnects,0);assert.equal(monitor.getSnapshot().generationId,2);assert.equal(monitor.getSnapshot().insideGrace,true);
});

test('a pre-session connection begins grace only when in-session monitoring starts',()=>{
  const connection=new FakeConnection();let now=0;let inSession=false;const monitor=new MarketDataHealthMonitorService(connection as never,{stallMs:100,generationGraceMs:100,now:()=>now,isMarketSession:()=>inSession});
  connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);assert.equal(monitor.confirmRecoveryReady(1),false);now=1_000;monitor.checkNow();assert.equal(connection.reconnects,0);assert.equal(monitor.getSnapshot().graceRemainingMs,null);
  inSession=true;monitor.checkNow();assert.equal(monitor.getSnapshot().insideGrace,true);now=1_099;monitor.checkNow();assert.equal(connection.reconnects,0);
});

test('stale generation events never refresh or confirm active health',()=>{
  const {connection,monitor,setNow}=setup();connection.generation=2;connection.emit('connected',{generationId:2});setNow(10);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1),false);assert.equal(monitor.getSnapshot().lastRawMessageAgeMs,null);assert.equal(monitor.getSnapshot().lastValidMarketEventAgeMs,null);assert.equal(monitor.getSnapshot().lastNiftyTickAgeMs,null);
});

test('after grace confirmation normal freshness monitoring includes the required NIFTY tick',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(101);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.checkNow();assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'STALL');
});

test('invalid health timing configuration fails closed',()=>{
  const connection=new FakeConnection();assert.throws(()=>new MarketDataHealthMonitorService(connection as never,{generationGraceMs:Number.NaN}),/positive finite/);assert.throws(()=>new MarketDataHealthMonitorService(connection as never,{stallMs:0}),/positive finite/);
});
