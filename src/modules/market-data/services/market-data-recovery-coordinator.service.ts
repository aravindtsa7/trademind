import { EventEmitter } from 'events';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';
import { isCurrentLiveGeneration } from '../utils/live-generation';

export type MarketDataRecoveryState = 'DISCONNECTED'|'CONNECTING'|'CONNECTED'|'DEGRADED'|'RECONNECTING'|'BACKFILLING'|'WAITING_FOR_FRESH_TICK'|'READY'|'STOPPING'|'STOPPED'|'FAULTED'|'AWAITING_LIVE_TICK'|'FAIL_CLOSED';
export interface MarketDataRecoveryResult<TRecoveryData = undefined> { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: TRecoveryData; }
export interface MarketDataRecoveryDetails { generationId?: number; attempt?: number; reason?: string; code?: number; disconnectClean?: boolean; lastMessageAgeMs?: number | null; lastTickAgeMs?: number | null; durationMs?: number; missingMinutes?: number; }
export interface MarketDataRecoveryCallbacks<TRecoveryData = undefined> {
  backfill: () => Promise<MarketDataRecoveryResult<TRecoveryData>>;
  /** Injectable for deterministic replay; live callers retain Date.now(). */
  nowMs?: () => number;
  onRecovered?: (generationId: number, recoveryData: TRecoveryData | undefined) => undefined;
  onEvent?: (event: 'RECONNECT_STARTED'|'RECONNECT_SUCCEEDED'|'DATA_GAP_DETECTED'|'DATA_GAP_RECOVERED'|'DATA_GAP_UNRECOVERABLE'|'MARKET_DATA_DEGRADED'|'MARKET_DATA_BACKFILL_STARTED'|'MARKET_DATA_BACKFILL_COMPLETED'|'MARKET_DATA_FRESH_TICK_CONFIRMED'|'MARKET_DATA_READY'|'MARKET_DATA_RECOVERY_FAILED', details: Record<string, string|number|boolean|null>) => void;
}

/** Runtime-level safety gate shared by paper, shadow and collector hosts. */
export default class MarketDataRecoveryCoordinatorService<TRecoveryData = undefined> extends EventEmitter {
  private state: MarketDataRecoveryState = 'READY';
  private recoveryStartedAt = 0;
  private backfillReady = false;
  private freshLiveTick = false;
  private recoveryToken = 0;
  private activeGenerationId = 0;
  private stopping = false;
  constructor(private readonly callbacks: MarketDataRecoveryCallbacks<TRecoveryData>) { super(); }
  isEvaluationReady(): boolean { return this.state === 'READY'; }
  getState(): MarketDataRecoveryState { return this.state; }
  getGenerationId(): number { return this.activeGenerationId; }
  handleUnexpectedDisconnect(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state === 'FAULTED' || this.state === 'FAIL_CLOSED' || this.state === 'STOPPED' || this.state === 'STOPPING') return;
    if (details.generationId !== undefined && details.generationId < this.activeGenerationId) return;
    if (this.state === 'RECONNECTING' || this.state === 'DEGRADED') return;
    this.recoveryStartedAt = this.nowMs();
    this.recoveryToken += 1; this.backfillReady = false; this.freshLiveTick = false;
    this.setState('DEGRADED'); this.emitEvent('MARKET_DATA_DEGRADED', details); this.setState('RECONNECTING');
    this.emitEvent('RECONNECT_STARTED', details); this.emitEvent('DATA_GAP_DETECTED', details);
  }
  handleReconnected(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state !== 'RECONNECTING') return;
    if (details.generationId !== undefined && details.generationId <= this.activeGenerationId) return;
    this.activeGenerationId = details.generationId ?? this.activeGenerationId + 1;
    this.setState('CONNECTED'); this.emitEvent('RECONNECT_SUCCEEDED', details);
    const token = ++this.recoveryToken; void this.recover(this.activeGenerationId,token);
  }
  handleLiveTick(timestamp: Date, generationId?: number): void {
    if (this.stopping || !isCurrentLiveGeneration(generationId, this.activeGenerationId)) return;
    if ((this.state === 'WAITING_FOR_FRESH_TICK' || this.state === 'AWAITING_LIVE_TICK') && timestamp.getTime() >= this.recoveryStartedAt) {
      this.freshLiveTick = true;
      recordMarketReplayEvent('FRESH_TICK_READY', { instrumentKey:null, sourceTimestamp:timestamp.toISOString(), receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} });
      this.emitEvent('MARKET_DATA_FRESH_TICK_CONFIRMED', { generationId: this.activeGenerationId });
    }
    this.tryBecomeReady();
  }
  stop(): void { if (this.stopping || this.state === 'STOPPED') return; this.stopping = true; this.recoveryToken += 1; recordMarketReplayEvent('EOD', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} }); this.setState('STOPPING'); this.setState('STOPPED'); }
  fault(reason = 'RECOVERY_EXHAUSTED'): void {
    if (this.stopping || this.state === 'FAULTED' || this.state === 'FAIL_CLOSED' || this.state === 'STOPPED' || this.state === 'STOPPING') return;
    this.recoveryToken += 1; this.fail(reason, { ready:false, reason, missingMinutes:0, duplicateMinutes:0 });
  }
  private async recover(generationId: number, token: number): Promise<void> {
    if (!this.isCurrentRecovery(generationId,token)) return; recordMarketReplayEvent('BACKFILL_STARTED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:generationId, payload:{} }); this.setState('BACKFILLING'); this.emitEvent('MARKET_DATA_BACKFILL_STARTED', { generationId });
    try {
      const result = await this.callbacks.backfill();
      if (!this.isCurrentRecovery(generationId,token)) return;
      if (!result.ready) { this.fail(result.reason, result); return; }
      this.callbacks.onRecovered?.(generationId,result.recoveryData); if (!this.isCurrentRecovery(generationId,token)) return;
      this.backfillReady = true; recordMarketReplayEvent('BACKFILL_COMPLETED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:generationId, payload:{ missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes } }); this.emitEvent('MARKET_DATA_BACKFILL_COMPLETED', { generationId, missingMinutes:result.missingMinutes });
      this.setState('WAITING_FOR_FRESH_TICK'); this.tryBecomeReady();
    } catch (error) { if(this.isCurrentRecovery(generationId,token))this.fail(error instanceof Error ? error.message : 'BACKFILL_FAILED', { ready:false, reason:'BACKFILL_FAILED', missingMinutes:0, duplicateMinutes:0 }); }
  }
  private tryBecomeReady(): void {
    if ((this.state === 'WAITING_FOR_FRESH_TICK' || this.state === 'AWAITING_LIVE_TICK') && this.backfillReady && this.freshLiveTick) {
      this.setState('READY'); if(!this.isReadyState())return; this.emitEvent('DATA_GAP_RECOVERED', { generationId:this.activeGenerationId, durationMs:this.nowMs()-this.recoveryStartedAt }); if(this.isReadyState())this.emitEvent('MARKET_DATA_READY', { generationId:this.activeGenerationId });
    }
  }
  private fail(reason: string, result: MarketDataRecoveryResult<TRecoveryData>): void { if (this.stopping) return; this.recoveryToken+=1;this.setState('FAULTED'); const details={ reason, missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes, generationId:this.activeGenerationId }; this.emitEvent('DATA_GAP_UNRECOVERABLE', details); this.emitEvent('MARKET_DATA_RECOVERY_FAILED', details); }
  private isCurrentRecovery(generationId:number,token:number):boolean{return !this.stopping&&generationId===this.activeGenerationId&&token===this.recoveryToken&&this.state!=='FAULTED'&&this.state!=='STOPPED'&&this.state!=='STOPPING';}
  private isReadyState():boolean{return this.state==='READY';}
  private nowMs(): number { return this.callbacks.nowMs?.() ?? Date.now(); }
  private emitEvent(event: Parameters<NonNullable<MarketDataRecoveryCallbacks['onEvent']>>[0], details: MarketDataRecoveryDetails | Record<string, string|number|boolean|null>): void { this.callbacks.onEvent?.(event, Object.fromEntries(Object.entries(details).map(([key,value])=>[key,value ?? null]))); }
  private setState(state: MarketDataRecoveryState): void { if (this.state === state) return; const previousState=this.state; this.state=state; this.emit('stateChanged', state, previousState); }
}
