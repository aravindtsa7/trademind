import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { CausalWindowAggregator, V12Aggregate, V12AggregationInput } from './order-flow-features';

export interface V12RawDepthRecord extends V12AggregationInput {
  eventId: string; sessionId: string; tradingDate: string; receivedAt: string; exchangeTimestamp: string | null;
  expiry: string | null; strike: number | null; optionType: 'CE' | 'PE' | null; ltp: number | null;
  levels: unknown[]; underlyingSpot: number | null; quoteAgeMs: number | null; flags: string[];
  [key: string]: unknown;
}
export interface V12SessionManifest {
  version: 'V12_ORDER_FLOW_V1'; sessionId: string; tradingDate: string; runtimeStartedAt: string; runtimeEndedAt?: string;
  restartCount: number; reconnectCount: number; universeRotations: number; instrumentsObserved: string[];
  rawDepthObservations: number; aggregationCounts: Record<string, number>; bidAskSnapshots: number; staleQuotes: number; wideSpreads: number;
  dataGapCount: number; longestGapMs: number; firstUsableTimestamp?: string; lastUsableTimestamp?: string; flags: string[]; qualityVerdict?: 'GOOD'|'USABLE_WITH_GAPS'|'BAD_SESSION'; recentEventIds: string[];
}
const windows = [5,15,30,60] as const;
export function deterministicV12EventId(record: Pick<V12RawDepthRecord,'instrumentKey'|'exchangeTimestamp'|'receivedAt'|'levels'|'ltp'>): string {
  return createHash('sha256').update(JSON.stringify([record.instrumentKey,record.exchangeTimestamp ?? record.receivedAt,record.ltp,record.levels])).digest('hex');
}

/** Append-only session storage. The manifest is the only checkpoint file and retains a bounded restart dedupe tail. */
export class V12OrderFlowJournal {
  readonly directory: string; readonly manifest: V12SessionManifest; private readonly seen = new Set<string>();
  private readonly aggregators = new Map<number,CausalWindowAggregator>(windows.map((window)=>[window,new CausalWindowAggregator(window)]));
  private previousTimestampMs?: number; private finalized = false;
  constructor(root: string, tradingDate: string, now = new Date()) {
    this.directory=join(root,tradingDate); mkdirSync(this.directory,{recursive:true}); const path=join(this.directory,'session-manifest.json');
    if(existsSync(path)) { const existing=JSON.parse(readFileSync(path,'utf8')) as V12SessionManifest; this.manifest={...existing,restartCount:existing.restartCount+1,runtimeEndedAt:undefined,flags:[...new Set([...existing.flags,'MANUAL_RESTART'])]}; for(const id of existing.recentEventIds ?? []) this.seen.add(id); }
    else this.manifest={version:'V12_ORDER_FLOW_V1',sessionId:`V12_ORDER_FLOW|${tradingDate}`,tradingDate,runtimeStartedAt:now.toISOString(),restartCount:0,reconnectCount:0,universeRotations:0,instrumentsObserved:[],rawDepthObservations:0,aggregationCounts:{'5':0,'15':0,'30':0,'60':0},bidAskSnapshots:0,staleQuotes:0,wideSpreads:0,dataGapCount:0,longestGapMs:0,flags:[],recentEventIds:[]};
    this.persistManifest();
  }
  append(record: V12RawDepthRecord): boolean {
    if(this.seen.has(record.eventId)) return false; this.seen.add(record.eventId); this.manifest.recentEventIds=[...this.manifest.recentEventIds,record.eventId].slice(-2000);
    appendFileSync(join(this.directory,'raw-depth.jsonl'),`${JSON.stringify(record)}\n`); this.manifest.rawDepthObservations++; this.manifest.instrumentsObserved=[...new Set([...this.manifest.instrumentsObserved,record.instrumentKey])];
    if(record.levels.length) this.manifest.bidAskSnapshots++; if(record.flags.includes('STALE_QUOTE')) this.manifest.staleQuotes++; if(record.flags.includes('WIDE_SPREAD')) this.manifest.wideSpreads++;
    const timestampMs=record.timestampMs; if(this.previousTimestampMs!==undefined && timestampMs>this.previousTimestampMs){const gap=timestampMs-this.previousTimestampMs;if(gap>10_000){this.manifest.dataGapCount++;this.manifest.longestGapMs=Math.max(this.manifest.longestGapMs,gap);}} this.previousTimestampMs=timestampMs;
    this.manifest.firstUsableTimestamp ??= new Date(timestampMs).toISOString(); this.manifest.lastUsableTimestamp=new Date(timestampMs).toISOString();
    for(const [window,aggregator] of this.aggregators) this.writeAggregates(window,aggregator.push(record));
    return true;
  }
  recordEvent(flag: string): void { this.manifest.flags=[...new Set([...this.manifest.flags,flag])]; if(flag==='WEBSOCKET_RECONNECT') this.manifest.reconnectCount++; if(flag==='OPTION_UNIVERSE_ROTATION') this.manifest.universeRotations++; this.persistManifest(); }
  finalize(reason='EOD'): void { if(this.finalized)return; this.finalized=true; for(const [window,aggregator] of this.aggregators) this.writeAggregates(window,aggregator.flush()); this.recordEvent(reason); this.manifest.runtimeEndedAt=new Date().toISOString(); const unusable=this.manifest.rawDepthObservations===0||this.manifest.dataGapCount>10; this.manifest.qualityVerdict=unusable?'BAD_SESSION':this.manifest.dataGapCount?'USABLE_WITH_GAPS':'GOOD'; this.persistManifest(); }
  private writeAggregates(window: number, rows: V12Aggregate[]): void { if(!rows.length)return; const path=join(this.directory,`aggregated-${window}s.jsonl`); for(const row of rows)appendFileSync(path,`${JSON.stringify({...row,sessionId:this.manifest.sessionId})}\n`); this.manifest.aggregationCounts[String(window)]=(this.manifest.aggregationCounts[String(window)]??0)+rows.length; }
  private persistManifest(): void { const bytes = Object.values(this.manifest.aggregationCounts).reduce((sum)=>sum,0); void bytes; writeFileSync(join(this.directory,'session-manifest.json'),JSON.stringify({...this.manifest,storageBytes:this.storageBytes()},null,2)); }
  private storageBytes(): number { try{return ['raw-depth.jsonl','aggregated-5s.jsonl','aggregated-15s.jsonl','aggregated-30s.jsonl','aggregated-60s.jsonl'].reduce((total,file)=>{const path=join(this.directory,file);return total+(existsSync(path)?statSync(path).size:0);},0);}catch{return 0;} }
}
