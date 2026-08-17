import { NseSessionEodCoordinator, NseSessionClock } from './nse-session-calendar.service';

export type StrategyHostState = 'BOOTING'|'WARMING'|'READY'|'RUNNING'|'DEGRADED'|'EOD'|'STOPPED'|'FAULTED';
export interface StrategyHostHooks { initialize?:()=>Promise<void>|void; warmup:()=>Promise<void>|void; onReady?:()=>Promise<void>|void; onDegraded?:()=>Promise<void>|void; onRecovered?:()=>Promise<void>|void; onEod:()=>Promise<void>|void; onShutdown:()=>Promise<void>|void; onFault?:(error:unknown)=>Promise<void>|void; }
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
  async eod(reason='EOD'):Promise<void>{if(this.state==='STOPPED'||this.state==='FAULTED')return;this.options.eodCoordinator?.cancelScheduled();if(this.state!=='EOD')this.transition('EOD',reason);await this.finish('EOD');}
  async shutdown(reason='SIGINT'):Promise<void>{if(this.state==='STOPPED'||this.state==='FAULTED')return;this.options.eodCoordinator?.cancelScheduled();await this.finish(reason);}
  async fault(error:unknown):Promise<void>{if(this.state==='FAULTED')return;this.options.eodCoordinator?.cancelScheduled();this.transition('FAULTED',error instanceof Error?error.message:'UNKNOWN_FAULT');await this.options.hooks.onFault?.(error);}
  transition(next:StrategyHostState,reason:string):void{const allowed:Record<StrategyHostState,readonly StrategyHostState[]>={BOOTING:['WARMING','FAULTED'],WARMING:['READY','FAULTED'],READY:['RUNNING','DEGRADED','EOD','FAULTED'],RUNNING:['DEGRADED','EOD','STOPPED','FAULTED'],DEGRADED:['RUNNING','EOD','STOPPED','FAULTED'],EOD:['STOPPED','FAULTED'],STOPPED:[],FAULTED:[]};if(!allowed[this.state].includes(next))throw new Error(`Illegal strategy-host transition ${this.state}->${next}.`);const previous=this.state;this.state=next;this.options.log?.({strategyId:this.options.strategyId,runtimeId:this.options.runtimeId,previous,state:next,reason});}
  private async finish(reason:string):Promise<void>{if(!this.stopping)this.stopping=(async()=>{try{if(this.state==='EOD')await this.options.hooks.onEod();await this.options.hooks.onShutdown();if(this.state!=='FAULTED')this.transition('STOPPED',reason);}catch(error){await this.fault(error);}})();await this.stopping;}
}
