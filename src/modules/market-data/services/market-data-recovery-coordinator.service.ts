import { EventEmitter } from 'events';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';
import { isCurrentLiveGeneration } from '../utils/live-generation';

export type MarketDataRecoveryState = 'DISCONNECTED'|'CONNECTING'|'CONNECTED'|'DEGRADED'|'RECONNECTING'|'BACKFILLING'|'WAITING_FOR_FRESH_TICK'|'READY'|'STOPPING'|'STOPPED'|'FAULTED'|'AWAITING_LIVE_TICK'|'FAIL_CLOSED';
export interface MarketDataRecoveryResult { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; }
export interface MarketDataRecoveryDetails { generationId?: number; attempt?: number; reason?: string; code?: number; disconnectClean?: boolean; lastMessageAgeMs?: number | null; lastTickAgeMs?: number | null; durationMs?: number; missingMinutes?: number; }
export interface MarketDataRecoveryCallbacks {
  backfill: () => Promise<MarketDataRecoveryResult>;
  /** Injectable for deterministic replay; live callers retain Date.now(). */
  nowMs?: () => number;
  onRecovered?: () => Promise<void> | void;
  onEvent?: (event: 'RECONNECT_STARTED'|'RECONNECT_SUCCEEDED'|'DATA_GAP_DETECTED'|'DATA_GAP_RECOVERED'|'DATA_GAP_UNRECOVERABLE'|'MARKET_DATA_DEGRADED'|'MARKET_DATA_BACKFILL_STARTED'|'MARKET_DATA_BACKFILL_COMPLETED'|'MARKET_DATA_FRESH_TICK_CONFIRMED'|'MARKET_DATA_READY'|'MARKET_DATA_RECOVERY_FAILED', details: Record<string, string|number|boolean|null>) => void;
}

/** Runtime-level safety gate shared by paper, shadow and collector hosts. */
export default class MarketDataRecoveryCoordinatorService extends EventEmitter {
  private state: MarketDataRecoveryState = 'READY';
  private recoveryStartedAt = 0;
  private backfillReady = false;
  private freshLiveTick = false;
  private recoveryPromise?: Promise<void>;
  private activeGenerationId = 0;
  private stopping = false;
  constructor(private readonly callbacks: MarketDataRecoveryCallbacks) { super(); }
  isEvaluationReady(): boolean { return this.state === 'READY'; }
  getState(): MarketDataRecoveryState { return this.state; }
  getGenerationId(): number { return this.activeGenerationId; }
  handleUnexpectedDisconnect(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state === 'FAULTED' || this.state === 'FAIL_CLOSED' || this.state === 'STOPPED' || this.state === 'STOPPING') return;
    if (details.generationId !== undefined && details.generationId < this.activeGenerationId) return;
    if (this.state !== 'READY' && this.state !== 'CONNECTED') return;
    this.recoveryStartedAt = this.nowMs(); this.backfillReady = false; this.freshLiveTick = false;
    this.setState('DEGRADED'); this.emitEvent('MARKET_DATA_DEGRADED', details); this.setState('RECONNECTING');
    this.emitEvent('RECONNECT_STARTED', details); this.emitEvent('DATA_GAP_DETECTED', details);
  }
  handleReconnected(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state !== 'RECONNECTING' || this.recoveryPromise) return;
    if (details.generationId !== undefined && details.generationId <= this.activeGenerationId) return;
    this.activeGenerationId = details.generationId ?? this.activeGenerationId + 1;
    this.setState('CONNECTED'); this.emitEvent('RECONNECT_SUCCEEDED', details);
    this.recoveryPromise = this.recover().finally(() => { this.recoveryPromise = undefined; });
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
  stop(): void { if (this.stopping || this.state === 'STOPPED') return; this.stopping = true; recordMarketReplayEvent('EOD', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} }); this.setState('STOPPING'); this.setState('STOPPED'); }
  fault(reason = 'RECOVERY_EXHAUSTED'): void { if (this.stopping) return; this.fail(reason, { ready:false, reason, missingMinutes:0, duplicateMinutes:0 }); }
  private async recover(): Promise<void> {
    if (this.stopping) return; recordMarketReplayEvent('BACKFILL_STARTED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} }); this.setState('BACKFILLING'); this.emitEvent('MARKET_DATA_BACKFILL_STARTED', { generationId: this.activeGenerationId });
    try {
      const result = await this.callbacks.backfill();
      if (this.stopping) return;
      if (!result.ready) { this.fail(result.reason, result); return; }
      await this.callbacks.onRecovered?.(); if (this.stopping) return;
      this.backfillReady = true; recordMarketReplayEvent('BACKFILL_COMPLETED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{ missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes } }); this.emitEvent('MARKET_DATA_BACKFILL_COMPLETED', { generationId:this.activeGenerationId, missingMinutes:result.missingMinutes });
      this.setState('WAITING_FOR_FRESH_TICK'); this.tryBecomeReady();
    } catch (error) { this.fail(error instanceof Error ? error.message : 'BACKFILL_FAILED', { ready:false, reason:'BACKFILL_FAILED', missingMinutes:0, duplicateMinutes:0 }); }
  }
  private tryBecomeReady(): void {
    if ((this.state === 'WAITING_FOR_FRESH_TICK' || this.state === 'AWAITING_LIVE_TICK') && this.backfillReady && this.freshLiveTick) {
      this.setState('READY'); this.emitEvent('DATA_GAP_RECOVERED', { generationId:this.activeGenerationId, durationMs:this.nowMs()-this.recoveryStartedAt }); this.emitEvent('MARKET_DATA_READY', { generationId:this.activeGenerationId });
    }
  }
  private fail(reason: string, result: MarketDataRecoveryResult): void { if (this.stopping) return; this.setState('FAULTED'); const details={ reason, missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes, generationId:this.activeGenerationId }; this.emitEvent('DATA_GAP_UNRECOVERABLE', details); this.emitEvent('MARKET_DATA_RECOVERY_FAILED', details); }
  private nowMs(): number { return this.callbacks.nowMs?.() ?? Date.now(); }
  private emitEvent(event: Parameters<NonNullable<MarketDataRecoveryCallbacks['onEvent']>>[0], details: MarketDataRecoveryDetails | Record<string, string|number|boolean|null>): void { this.callbacks.onEvent?.(event, Object.fromEntries(Object.entries(details).map(([key,value])=>[key,value ?? null]))); }
  private setState(state: MarketDataRecoveryState): void { if (this.state === state) return; const previousState=this.state; this.state=state; this.emit('stateChanged', state, previousState); }
}
