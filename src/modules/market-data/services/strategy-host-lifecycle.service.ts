import { NseSessionEodCoordinator, NseSessionClock } from './nse-session-calendar.service';

/**
 * Never throws. A hostile error (a genuine Error whose `message` accessor
 * throws, a Proxy whose `instanceof`/getPrototypeOf trap throws, etc.) must
 * never be able to prevent the FAULTED transition -- it falls back to the
 * same UNKNOWN_FAULT reason already used for non-Error values.
 */
function strategyHostFaultReason(error:unknown):string{try{return error instanceof Error?error.message:'UNKNOWN_FAULT';}catch{return 'UNKNOWN_FAULT';}}

export type StrategyHostState = 'BOOTING'|'WARMING'|'READY'|'RUNNING'|'DEGRADED'|'EOD'|'STOPPED'|'FAULTED';
export interface StrategyHostHooks { initialize?:()=>Promise<void>|void; warmup:()=>Promise<void>|void; onReady?:()=>Promise<void>|void; onDegraded?:()=>Promise<void>|void; onRecovered?:()=>Promise<void>|void; onEod:(reason?:string)=>Promise<void>|void; onShutdown:(reason?:string)=>Promise<void>|void; onFault?:(error:unknown)=>Promise<void>|void; }
export interface StrategyHostOptions { strategyId:string; runtimeId:string; hooks:StrategyHostHooks; eodCoordinator?:NseSessionEodCoordinator; clock?:NseSessionClock; log?:(event:{strategyId:string;runtimeId:string;previous:StrategyHostState;state:StrategyHostState;reason:string})=>void; }

/** Lifecycle coordinator only: strategy rules, execution, and recovery mechanics stay in their adapters. */
export class StrategyHostLifecycle {
  private state:StrategyHostState='BOOTING'; private stopping?:Promise<void>;
  constructor(private readonly options:StrategyHostOptions) {}
  getState():StrategyHostState{return this.state;}
  canEvaluate():boolean{return this.state==='RUNNING';}
  async start():Promise<void>{try{await this.options.hooks.initialize?.();this.transition('WARMING','INITIALIZED');await this.options.hooks.warmup();this.transition('READY','WARMUP_READY');await this.options.hooks.onReady?.();this.transition('RUNNING','MARKET_DATA_READY');this.options.eodCoordinator?.schedule(()=>this.eod('WALL_CLOCK_EOD'));}catch(error){await this.fault(error);}}
  async degrade(reason='MARKET_DATA_UNSAFE'):Promise<void>{if(this.state==='RUNNING'||this.state==='READY'){this.transition('DEGRADED',reason);await this.options.hooks.onDegraded?.();}}
  async recovered(reason='RECOVERY_READY'):Promise<void>{if(this.state!=='DEGRADED')return;await this.options.hooks.onRecovered?.();this.transition('RUNNING',reason);}
  async eod(reason='EOD'):Promise<void>{if(this.state==='STOPPED'||this.state==='FAULTED')return;this.options.eodCoordinator?.cancelScheduled();if(this.state!=='EOD')this.transition('EOD',reason);await this.finish(reason);}
  async shutdown(reason='SIGINT'):Promise<void>{if(this.state==='STOPPED'||this.state==='FAULTED')return;this.options.eodCoordinator?.cancelScheduled();await this.finish(reason);}
  // STOPPED and FAULTED are this host's only two terminal states (both have an empty allowed-transitions
  // list in transition()'s table below) -- once either is reached, the session's outcome is committed and
  // final. A fault arriving before either is reached may still win the race (see finish()'s stateAfterEod
  // guard and StrategyTerminalOutcomeArbiter, which callers use to arbitrate which reason gets journaled),
  // but a fault arriving AFTER STOPPED must be a benign no-op here, exactly like a repeated fault() call
  // after FAULTED already is -- never an illegal STOPPED->FAULTED transition that would leave the host's
  // own state contradicting an already-committed durable outcome.
  async fault(error:unknown):Promise<void>{if(this.state==='FAULTED'||this.state==='STOPPED')return;this.transition('FAULTED',strategyHostFaultReason(error));this.options.eodCoordinator?.cancelScheduled();await this.options.hooks.onFault?.(error);}
  transition(next:StrategyHostState,reason:string):void{const allowed:Record<StrategyHostState,readonly StrategyHostState[]>={BOOTING:['WARMING','FAULTED'],WARMING:['READY','FAULTED'],READY:['RUNNING','DEGRADED','EOD','FAULTED'],RUNNING:['DEGRADED','EOD','STOPPED','FAULTED'],DEGRADED:['RUNNING','EOD','STOPPED','FAULTED'],EOD:['STOPPED','FAULTED'],STOPPED:[],FAULTED:[]};if(!allowed[this.state].includes(next))throw new Error(`Illegal strategy-host transition ${this.state}->${next}.`);const previous=this.state;this.state=next;this.options.log?.({strategyId:this.options.strategyId,runtimeId:this.options.runtimeId,previous,state:next,reason});}
  // A racing fault() transitions to FAULTED synchronously (see fault()) and is the sole
  // authoritative terminal outcome once it does. If it lands while onEod is still in flight here,
  // that already-started onEod call cannot be un-run, but onShutdown -- the other half of the
  // EOD/shutdown terminal-hook family -- must never fire afterward: it would be a second terminal
  // hook family executing for one session, and a caller-owned outcome (e.g. a durable summary)
  // written from it could contradict the FAULTED result this host is about to report.
  private async finish(reason:string):Promise<void>{if(!this.stopping)this.stopping=(async()=>{try{if(this.state==='EOD')await this.options.hooks.onEod?.(reason);const stateAfterEod:StrategyHostState=this.state;if(stateAfterEod==='FAULTED')return;await this.options.hooks.onShutdown?.(reason);if(this.state!=='FAULTED')this.transition('STOPPED',reason);}catch(error){await this.fault(error);}})();await this.stopping;}
}
