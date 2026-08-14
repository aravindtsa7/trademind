import { EventEmitter } from 'events';

export type MarketDataRecoveryState = 'READY' | 'RECONNECTING' | 'BACKFILLING' | 'AWAITING_LIVE_TICK' | 'FAIL_CLOSED';
export interface MarketDataRecoveryResult { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; }
export interface MarketDataRecoveryCallbacks {
  backfill: () => Promise<MarketDataRecoveryResult>;
  onRecovered?: () => Promise<void> | void;
  onEvent?: (event: 'RECONNECT_STARTED'|'RECONNECT_SUCCEEDED'|'DATA_GAP_DETECTED'|'DATA_GAP_RECOVERED'|'DATA_GAP_UNRECOVERABLE', details: Record<string, string|number|boolean|null>) => void;
}

/** Shared runtime gate: restored subscriptions are necessary but insufficient; no evaluation resumes until current-day continuity and one fresh tick exist. */
export default class MarketDataRecoveryCoordinatorService extends EventEmitter {
  private state: MarketDataRecoveryState = 'READY';
  private recoveryStartedAt = 0;
  private backfillReady = false;
  private freshLiveTick = false;
  private recoveryPromise?: Promise<void>;
  constructor(private readonly callbacks: MarketDataRecoveryCallbacks) { super(); }
  isEvaluationReady(): boolean { return this.state === 'READY'; }
  getState(): MarketDataRecoveryState { return this.state; }
  handleUnexpectedDisconnect(): void {
    if (this.state !== 'READY') return;
    this.recoveryStartedAt = Date.now(); this.backfillReady = false; this.freshLiveTick = false;
    this.setState('RECONNECTING');
    this.callbacks.onEvent?.('RECONNECT_STARTED', {}); this.callbacks.onEvent?.('DATA_GAP_DETECTED', {});
  }
  handleReconnected(): void {
    if (this.state !== 'RECONNECTING' || this.recoveryPromise) return;
    this.callbacks.onEvent?.('RECONNECT_SUCCEEDED', {});
    this.recoveryPromise = this.recover().finally(() => { this.recoveryPromise = undefined; });
  }
  handleLiveTick(timestamp: Date): void {
    if (timestamp.getTime() >= this.recoveryStartedAt) this.freshLiveTick = true;
    this.tryBecomeReady();
  }
  private async recover(): Promise<void> {
    this.setState('BACKFILLING');
    try {
      const result = await this.callbacks.backfill();
      if (!result.ready) { this.fail(result.reason, result); return; }
      await this.callbacks.onRecovered?.();
      this.backfillReady = true;
      this.setState('AWAITING_LIVE_TICK');
      this.tryBecomeReady();
    } catch (error) { this.fail(error instanceof Error ? error.message : 'BACKFILL_FAILED', { ready:false, reason:'BACKFILL_FAILED', missingMinutes:0, duplicateMinutes:0 }); }
  }
  private tryBecomeReady(): void {
    if (this.state === 'AWAITING_LIVE_TICK' && this.backfillReady && this.freshLiveTick) {
      this.setState('READY'); this.callbacks.onEvent?.('DATA_GAP_RECOVERED', {});
    }
  }
  private fail(reason: string, result: MarketDataRecoveryResult): void {
    this.setState('FAIL_CLOSED');
    this.callbacks.onEvent?.('DATA_GAP_UNRECOVERABLE', { reason, missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes });
  }
  private setState(state: MarketDataRecoveryState): void { if (this.state === state) return; this.state = state; this.emit('stateChanged', state); }
}
