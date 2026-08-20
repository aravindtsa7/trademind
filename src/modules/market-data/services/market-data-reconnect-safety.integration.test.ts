import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ConnectionManager, { ConnectionManagerScheduler } from '../managers/connection.manager';
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
const flush=async()=>{await Promise.resolve();await Promise.resolve();};

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
  connection.emit('message',Buffer.alloc(0),{generationId:2});health.noteValidMarketEvent(2);health.noteNiftyTick(2);recovery.handleLiveTick(new Date(clock.now),2);await flush();
  assert.equal(recovery.getState(),'READY');assert.equal(health.isHealthy(),true);assert.equal(host.getState(),'RUNNING');assert.equal(connection.getReconnectCircuitSnapshot().attempts,0);
});
