import { EventEmitter } from 'events';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';
import { isCurrentLiveGeneration } from '../utils/live-generation';
import { isWithinNseSession } from './nse-session-calendar.service';

export type MarketDataRecoveryState = 'DISCONNECTED'|'CONNECTING'|'CONNECTED'|'DEGRADED'|'RECONNECTING'|'BACKFILLING'|'WAITING_FOR_FRESH_TICK'|'READY'|'STOPPING'|'STOPPED'|'FAULTED'|'AWAITING_LIVE_TICK'|'FAIL_CLOSED';
export interface MarketDataRecoveryResult<TRecoveryData = undefined> { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: TRecoveryData; }
export interface MarketDataRecoveryDetails { generationId?: number; attempt?: number; reason?: string; code?: number; disconnectClean?: boolean; lastMessageAgeMs?: number | null; lastTickAgeMs?: number | null; durationMs?: number; missingMinutes?: number; }
export interface MarketDataRecoveryCallbacks<TRecoveryData = undefined> {
  backfill: () => Promise<MarketDataRecoveryResult<TRecoveryData>>;
  /** Injectable for deterministic replay; live callers retain Date.now(). */
  nowMs?: () => number;
  /** Injectable for tests; live callers retain the canonical NSE derivatives calendar. */
  isMarketSession?: (value: Date) => boolean;
  onRecovered?: (generationId: number, recoveryData: TRecoveryData | undefined) => undefined;
  onEvent?: (event: 'RECONNECT_STARTED'|'RECONNECT_SUCCEEDED'|'DATA_GAP_DETECTED'|'DATA_GAP_RECOVERED'|'DATA_GAP_UNRECOVERABLE'|'MARKET_DATA_DEGRADED'|'MARKET_DATA_BACKFILL_STARTED'|'MARKET_DATA_BACKFILL_COMPLETED'|'MARKET_DATA_FRESH_TICK_CONFIRMED'|'MARKET_DATA_READY'|'MARKET_DATA_RECOVERY_FAILED', details: Record<string, string|number|boolean|null>) => void;
}

/**
 * Timeout diagnostic for `waitUntilReady()`: initial startup never observed a
 * usable current-generation market event within the bound, while the NSE
 * derivatives session was active throughout the wait.
 */
export class MarketDataInitialReadinessTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Initial current-generation market-data readiness was not observed within ${timeoutMs}ms.`);
    this.name = 'MarketDataInitialReadinessTimeoutError';
  }
}

/**
 * `waitUntilReady()` diagnostic: the wait could not (or could no longer)
 * observe a live tick because the NSE derivatives session is not active --
 * either it had not started yet at call time, or it ended while the wait was
 * still pending. This is distinct from a genuinely dead feed during an active
 * session, which raises `MarketDataInitialReadinessTimeoutError` instead.
 */
export class MarketSessionNotActiveError extends Error {
  constructor() {
    super('Initial current-generation market-data readiness cannot be observed outside an active NSE derivatives session.');
    this.name = 'MarketSessionNotActiveError';
  }
}

/** Runtime-level safety gate shared by paper, shadow and collector hosts. */
export default class MarketDataRecoveryCoordinatorService<TRecoveryData = undefined> extends EventEmitter {
  // Cold start must never be evaluation-ready by default -- only a real
  // disconnect/reconnect cycle (handleUnexpectedDisconnect/handleReconnected)
  // or a proven initial connection (handleInitialConnected) may move the
  // coordinator toward READY. AWAITING_LIVE_TICK is already declared in
  // MarketDataRecoveryState for exactly this "connected but unproven" shape
  // and was previously unused.
  private state: MarketDataRecoveryState = 'AWAITING_LIVE_TICK';
  private recoveryStartedAt = 0;
  private backfillReady = false;
  private freshLiveTick = false;
  private recoveryToken = 0;
  private activeGenerationId = 0;
  private stopping = false;
  // True only once a real disconnect has ever been handled; distinguishes a
  // genuine gap-recovery READY transition (emits DATA_GAP_RECOVERED, as
  // before) from the very first cold-start READY transition (which recovered
  // from nothing and must not claim to).
  private recoveringFromDisconnect = false;
  private readonly isMarketSession: (value: Date) => boolean;
  constructor(private readonly callbacks: MarketDataRecoveryCallbacks<TRecoveryData>) { super(); this.isMarketSession = callbacks.isMarketSession ?? isWithinNseSession; }
  isEvaluationReady(): boolean { return this.state === 'READY'; }
  getState(): MarketDataRecoveryState { return this.state; }
  getGenerationId(): number { return this.activeGenerationId; }
  /**
   * Seeds the coordinator with the real, authoritative generation from
   * ConnectionManager's very first successful 'connected' event. Idempotent
   * and safe to wire directly to every 'connected' event for the lifetime of
   * the connection (cold start AND every reconnect emit 'connected'): it
   * only has an effect the first time it is called while the coordinator is
   * still in its untouched construction state (activeGenerationId===0 and
   * state==='AWAITING_LIVE_TICK'), so it can never reset or overwrite
   * DEGRADED/RECONNECTING/BACKFILLING/WAITING_FOR_FRESH_TICK/FAULTED/STOPPED
   * or the generation ownership handleReconnected() establishes on a real
   * reconnect. A first connection has no gap to backfill, so continuity is
   * vacuously satisfied here; only a proven current-generation live tick
   * (handleLiveTick) can still complete readiness.
   */
  handleInitialConnected(details: { generationId: number; connectedAt?: Date }): void {
    if (this.stopping || this.state !== 'AWAITING_LIVE_TICK' || this.activeGenerationId !== 0) return;
    const { generationId } = details;
    if (typeof generationId !== 'number' || !Number.isFinite(generationId) || generationId <= this.activeGenerationId) return;
    this.activeGenerationId = generationId;
    this.recoveryStartedAt = details.connectedAt ? details.connectedAt.getTime() : this.nowMs();
    this.backfillReady = true;
    this.freshLiveTick = false;
  }
  /**
   * Race-safe wait for the coordinator's first READY: checks current state,
   * registers a one-shot listener, re-checks (in case READY/FAULTED/STOPPED
   * happened between the two checks), and always removes the listener and
   * timer exactly once, however the wait settles. Rejects on FAULTED/STOPPED,
   * with `MarketSessionNotActiveError` if the NSE session is not (or is no
   * longer) active, or otherwise after `timeoutMs` with
   * `MarketDataInitialReadinessTimeoutError`.
   */
  waitUntilReady(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number.');
    return new Promise((resolve, reject) => {
      let settled = false;
      // Boxed (rather than a plain `let`) so `finish` can unconditionally
      // reference and clear it, however the wait settles -- including the
      // immediate-return paths below, which settle before a timer is ever
      // created.
      const timerBox: { current?: ReturnType<typeof setTimeout> } = {};
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        this.off('stateChanged', onStateChanged);
        if (timerBox.current !== undefined) clearTimeout(timerBox.current);
        run();
      };
      const terminalRejection = (): Error => new Error(`MarketDataRecoveryCoordinator is ${this.state}; cannot become ready.`);
      // Distinguishes "the bound elapsed because the feed is genuinely silent
      // during an active session" from "the bound elapsed only because the
      // NSE session is not (or no longer) active" -- the caller must not be
      // told a live feed failed when the exchange was simply shut for all or
      // part of the wait.
      const sessionOrTimeoutRejection = (): Error => this.isMarketSession(new Date(this.nowMs()))
        ? new MarketDataInitialReadinessTimeoutError(timeoutMs)
        : new MarketSessionNotActiveError();
      const onStateChanged = (state: MarketDataRecoveryState): void => {
        if (state === 'READY') finish(resolve);
        else if (state === 'FAULTED' || state === 'STOPPED') finish(() => reject(terminalRejection()));
      };
      if (this.isEvaluationReady()) { finish(resolve); return; }
      if (this.state === 'FAULTED' || this.state === 'STOPPED') { finish(() => reject(terminalRejection())); return; }
      // A normal pre-open (or post-close) launch must not be classified as a
      // dead feed merely because there cannot yet be a market tick: fail
      // explicitly and immediately with the session-inactive reason instead
      // of waiting out the full bound first.
      if (!this.isMarketSession(new Date(this.nowMs()))) { finish(() => reject(new MarketSessionNotActiveError())); return; }
      this.on('stateChanged', onStateChanged);
      const recheckState = this.getState();
      if (this.isEvaluationReady()) { finish(resolve); return; }
      if (recheckState === 'FAULTED' || recheckState === 'STOPPED') { finish(() => reject(terminalRejection())); return; }
      timerBox.current = setTimeout(() => finish(() => reject(sessionOrTimeoutRejection())), timeoutMs);
      timerBox.current.unref?.();
    });
  }
  handleUnexpectedDisconnect(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state === 'FAULTED' || this.state === 'FAIL_CLOSED' || this.state === 'STOPPED' || this.state === 'STOPPING') return;
    if (details.generationId !== undefined && details.generationId < this.activeGenerationId) return;
    if (this.state === 'RECONNECTING' || this.state === 'DEGRADED') return;
    this.recoveringFromDisconnect = true;
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
      this.setState('READY'); if(!this.isReadyState())return; if(this.recoveringFromDisconnect)this.emitEvent('DATA_GAP_RECOVERED', { generationId:this.activeGenerationId, durationMs:this.nowMs()-this.recoveryStartedAt }); if(this.isReadyState())this.emitEvent('MARKET_DATA_READY', { generationId:this.activeGenerationId });
    }
  }
  private fail(reason: string, result: MarketDataRecoveryResult<TRecoveryData>): void { if (this.stopping) return; this.recoveryToken+=1;this.setState('FAULTED'); const details={ reason, missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes, generationId:this.activeGenerationId }; this.emitEvent('DATA_GAP_UNRECOVERABLE', details); this.emitEvent('MARKET_DATA_RECOVERY_FAILED', details); }
  private isCurrentRecovery(generationId:number,token:number):boolean{return !this.stopping&&generationId===this.activeGenerationId&&token===this.recoveryToken&&this.state!=='FAULTED'&&this.state!=='STOPPED'&&this.state!=='STOPPING';}
  private isReadyState():boolean{return this.state==='READY';}
  private nowMs(): number { return this.callbacks.nowMs?.() ?? Date.now(); }
  private emitEvent(event: Parameters<NonNullable<MarketDataRecoveryCallbacks['onEvent']>>[0], details: MarketDataRecoveryDetails | Record<string, string|number|boolean|null>): void { this.callbacks.onEvent?.(event, Object.fromEntries(Object.entries(details).map(([key,value])=>[key,value ?? null]))); }
  private setState(state: MarketDataRecoveryState): void { if (this.state === state) return; const previousState=this.state; this.state=state; this.emit('stateChanged', state, previousState); }
}
