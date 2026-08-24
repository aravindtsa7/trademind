import { EventEmitter } from 'events';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';
import { isCurrentLiveGeneration } from '../utils/live-generation';
import { isWithinNseSession, nseSessionCalendar, NseSessionBoundary } from './nse-session-calendar.service';

export type MarketDataRecoveryState = 'DISCONNECTED'|'CONNECTING'|'CONNECTED'|'DEGRADED'|'RECONNECTING'|'BACKFILLING'|'WAITING_FOR_FRESH_TICK'|'READY'|'STOPPING'|'STOPPED'|'FAULTED'|'AWAITING_LIVE_TICK'|'FAIL_CLOSED';
export interface MarketDataRecoveryResult<TRecoveryData = undefined> { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: TRecoveryData; }
export interface MarketDataRecoveryDetails { generationId?: number; attempt?: number; reason?: string; code?: number; disconnectClean?: boolean; lastMessageAgeMs?: number | null; lastTickAgeMs?: number | null; durationMs?: number; missingMinutes?: number; }
export interface MarketDataRecoveryCallbacks<TRecoveryData = undefined> {
  backfill: (requiredCompletedMinute?: Date) => Promise<MarketDataRecoveryResult<TRecoveryData>>;
  /** Returns the latest completed 1m candle timestamp seeded during startup warmup. When provided, handleInitialConnected performs evidence-based cold-start continuity reconciliation. */
  getLastSeededCompletedMinute?: () => Date | null | undefined;
  /** Injectable expected-completed-minute calculator for tests; live callers use the default IST 09:15–15:30 formula. */
  getExpectedCompletedMinute?: (now: Date) => Date | null;
  /** Injectable for deterministic replay; live callers retain Date.now(). */
  nowMs?: () => number;
  /** Injectable for tests; live callers retain the canonical NSE derivatives calendar. */
  isMarketSession?: (value: Date) => boolean;
  /** Injectable session-boundary source for deterministic tests; live callers use the canonical NSE calendar. */
  getSessionBoundary?: (value: Date) => Pick<NseSessionBoundary, 'openAt' | 'closeAt'>;
  /**
   * The instant immediately after the last source 1m candle the backfill/warmup source can
   * ever produce for `value`'s trading day (e.g. 15:30 IST for NSE_INDEX|Nifty 50, whose
   * underlying cash-market index stops publishing new prints at 15:29 IST -- ten minutes
   * before TradeMind's own 15:40 operational EOD/grace boundary). Independent of, and always
   * at or before, `getSessionBoundary`'s `closeAt`: a live-construction boundary requiring
   * REST coverage past this instant is never usable, even when it is still before the
   * operational session close. Omitted only for legacy/non-NIFTY callers with no known
   * source-data horizon narrower than the operational session.
   */
  getSourceCompletionBoundary?: (value: Date) => Date | null;
  /**
   * Aligns the live-construction handoff to the strategy's complete input frames,
   * anchored at the 09:15 IST session open. When supplied, the boundary is always
   * strictly after connection establishment and recovery must prove coverage through
   * boundary - 1 minute before READY. V2 uses 5, V4 uses 15 (LCM of 3 and 5), and V8
   * uses 2. Omitted only for legacy callers retaining the prior one-minute behavior.
   */
  liveConstructionAlignmentMinutes?: number;
  /** Extracts the latest authoritative completed 1m source minute from a recovery result. Required with liveConstructionAlignmentMinutes. */
  getRecoveredCompletedMinute?: (recoveryData: TRecoveryData | undefined) => Date | null | undefined;
  onRecovered?: (generationId: number, recoveryData: TRecoveryData | undefined) => undefined;
  /**
   * Fired synchronously from handleInitialConnected/handleReconnected (only when
   * getLastSeededCompletedMinute is configured) with the first minute boundary
   * guaranteed to be observable from its very start on the current connection --
   * i.e. the live candle-construction boundary a WebSocket that connected mid-minute
   * must never be allowed to build a bucket before. Real callers wire this directly to
   * LiveCandleBuilderService.setLiveConstructionBoundary(instrumentKey, boundary.getTime()).
   */
  onLiveConstructionBoundary?: (boundary: Date) => void;
  /**
   * Fired when no strictly-future strategy-aligned handoff exists before the canonical
   * session close. Callers must block live candle construction through `sessionClose`;
   * this is a fail-closed floor, not a fabricated strategy handoff boundary.
   */
  onLiveConstructionUnavailable?: (sessionClose: Date) => void;
  onEvent?: (event: 'RECONNECT_STARTED'|'RECONNECT_SUCCEEDED'|'DATA_GAP_DETECTED'|'DATA_GAP_RECOVERED'|'DATA_GAP_UNRECOVERABLE'|'MARKET_DATA_DEGRADED'|'MARKET_DATA_BACKFILL_STARTED'|'MARKET_DATA_BACKFILL_COMPLETED'|'MARKET_DATA_FRESH_TICK_CONFIRMED'|'MARKET_DATA_READY'|'MARKET_DATA_RECOVERY_FAILED', details: Record<string, string|number|boolean|null>) => void;
}

export const NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE = 'NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE';

/**
 * completePendingBoundaryReconciliation()'s result. 'RECOVERED' is the only outcome a caller
 * may treat as safe to proceed toward a completed session; 'NONE_PENDING' means nothing was
 * required (also safe to proceed); 'NOT_RECOVERED' covers every failure -- backfill
 * rejection/throw, an exact-target mismatch, or the recovery being superseded/abandoned by a
 * disconnect, reconnect, generation advance, or stop() racing the wait -- with `reason`
 * distinguishing which.
 */
export type BoundaryReconciliationOutcome = 'NONE_PENDING' | 'RECOVERED' | 'NOT_RECOVERED';
export interface BoundaryReconciliationResult { outcome: BoundaryReconciliationOutcome; reason: string; }

type BoundaryReconciliationDisposition = 'REQUIRED_UNRESOLVED' | 'RECOVERED' | 'FAILED';
interface BoundaryReconciliationObligation {
  generationId: number;
  boundaryMs?: number;
  requiredCompletedMinuteMs?: number;
  disposition: BoundaryReconciliationDisposition;
  reason: string;
  attemptToken?: number;
}

type LiveConstructionBoundaryDecision =
  | { kind: 'ALIGNED'; target: Date; boundary: Date }
  | { kind: 'NO_SAFE_SAME_SESSION_HANDOFF'; sessionClose: Date };

const _istFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function _istMinute(value: Date): { date: string; minute: number } {
  const p = Object.fromEntries(_istFmt.formatToParts(value).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
/** Returns the expected latest completed 1m candle timestamp at `now` in IST (09:15–15:30 session window), or null outside the window. Exported for tests only. */
export function defaultExpectedCompletedMinute(now: Date): Date | null {
  const v = _istMinute(now);
  if (v.minute <= 9 * 60 + 15 || v.minute >= 15 * 60 + 30) return null;
  const m = v.minute - 1; const h = Math.floor(m / 60); const mi = m % 60;
  return new Date(`${v.date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+05:30`);
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
  // The live candle-construction boundary a WebSocket that connected mid-bucket must
  // never build a candle before (see LiveCandleBuilderService.setLiveConstructionBoundary
  // and onLiveConstructionBoundary above). Strategy-aligned callers reconcile every 1m
  // source minute through boundary-1 via REST, so every complete pre-boundary strategy
  // bucket belongs to recovery and every bucket at/after the boundary belongs to live
  // construction. `pendingReconciliation` owns that one-shot handoff per generation.
  private pendingReconciliation: { generationId: number; boundaryMs: number; requiredCompletedMinuteMs?: number } | null = null;
  // Tracks the most recently started recover() attempt -- generationId/token ownership
  // AND the promise -- so an EOD completion barrier (completePendingBoundaryReconciliation)
  // can (a) await work that was already kicked off by a live tick, not only work it
  // triggers itself, and (b) prove that specific attempt is still the coordinator's current
  // ownership once it settles, rather than reporting success merely because the coordinator
  // did not end up FAULTED (a disconnect/reconnect/stop racing the await also leaves it
  // something other than FAULTED, e.g. RECONNECTING or STOPPED, and must never be read as
  // "the recovery I was waiting for actually happened").
  private currentRecoveryAttempt: { generationId: number; token: number; promise: Promise<BoundaryReconciliationResult> } | undefined;
  // Durable logical evidence that a strategy-aligned handoff required reconciliation.
  // `pendingReconciliation` is only executable scheduling state and may be retired by a
  // disconnect/stop; this obligation must survive that retirement so the EOD barrier can
  // never mistake cancelled required work for "nothing was required".
  private boundaryReconciliationObligation: BoundaryReconciliationObligation | null = null;
  private readonly isMarketSession: (value: Date) => boolean;
  private readonly getSessionBoundary: (value: Date) => Pick<NseSessionBoundary, 'openAt' | 'closeAt'>;
  constructor(private readonly callbacks: MarketDataRecoveryCallbacks<TRecoveryData>) {
    super();
    this.isMarketSession = callbacks.isMarketSession ?? isWithinNseSession;
    this.getSessionBoundary = callbacks.getSessionBoundary ?? ((value) => nseSessionCalendar.boundaryFor(value));
  }
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
   * reconnect. When getLastSeededCompletedMinute is provided in callbacks,
   * performs evidence-based cold-start continuity reconciliation before
   * granting backfillReady; otherwise defaults to the prior unconditional
   * backfillReady = true (compatible with legacy callers).
   */
  handleInitialConnected(details: { generationId: number; connectedAt?: Date }): void {
    if (this.stopping || this.state !== 'AWAITING_LIVE_TICK' || this.activeGenerationId !== 0) return;
    const { generationId } = details;
    if (typeof generationId !== 'number' || !Number.isFinite(generationId) || generationId <= this.activeGenerationId) return;
    this.activeGenerationId = generationId;
    this.recoveryStartedAt = details.connectedAt ? details.connectedAt.getTime() : this.nowMs();
    this.freshLiveTick = false;
    const lastSeeded = this.callbacks.getLastSeededCompletedMinute?.();
    if (lastSeeded === undefined) {
      // No cold-start reconciliation configured (legacy/untracked caller): grant immediately.
      this.backfillReady = true;
      return;
    }
    const now = details.connectedAt ?? new Date(this.recoveryStartedAt);
    const established = this.establishLiveConstructionBoundary(now);
    if (established === null) {
      // Outside the configured session window: no completed-minute boundary applies.
      this.backfillReady = true;
      return;
    }
    if (established.kind === 'NO_SAFE_SAME_SESSION_HANDOFF') {
      this.failNoSafeSameSessionHandoff(established.sessionClose);
      return;
    }
    const { target, boundary } = established;
    this.requireBoundaryReconciliation(boundary, target);
    if (lastSeeded !== null && lastSeeded.getTime() >= target.getTime()) {
      // Continuous: warmup already covers every minute up to (and including, where the
      // connection landed exactly on a clean boundary) the last minute that must be
      // authoritative before live construction may begin.
      this.backfillReady = true;
      this.markBoundaryReconciliationRecovered('STARTUP_SEED_COVERAGE_CONFIRMED');
      return;
    }
    // Required source history is missing. For aligned production callers this includes
    // every minute through boundary-1, not merely the minute that was forming at connect.
    // Defer reconciliation until real wall-clock time has reached the boundary.
    this.backfillReady = false;
    this.pendingReconciliation = {
      generationId: this.activeGenerationId,
      boundaryMs: boundary.getTime(),
      requiredCompletedMinuteMs: this.callbacks.liveConstructionAlignmentMinutes === undefined ? undefined : target.getTime(),
    };
    this.triggerBoundaryReconciliationIfDue();
  }
  /**
   * Computes and publishes the live candle-construction boundary. Production callers
   * provide their strategy alignment, yielding the next strictly-future 09:15-anchored
   * boundary and an authoritative REST target of boundary-1. The legacy one-minute rule is
   * retained only when no alignment is configured. Returns null outside the configured
   * completed-minute window.
   */
  private establishLiveConstructionBoundary(now: Date): LiveConstructionBoundaryDecision | null {
    const alignmentMinutes = this.callbacks.liveConstructionAlignmentMinutes;
    if (alignmentMinutes !== undefined) {
      if (!Number.isInteger(alignmentMinutes) || alignmentMinutes <= 0) throw new Error('liveConstructionAlignmentMinutes must be a positive integer.');
      if (this.callbacks.getRecoveredCompletedMinute === undefined) throw new Error('getRecoveredCompletedMinute is required when liveConstructionAlignmentMinutes is configured.');
      if (!this.isMarketSession(now)) return null;
      const session = this.getSessionBoundary(now);
      const elapsedMinutes = Math.floor((now.getTime() - session.openAt.getTime()) / 60_000);
      if (elapsedMinutes < 0) return null;
      const boundary = new Date(session.openAt.getTime() + (Math.floor(elapsedMinutes / alignmentMinutes) + 1) * alignmentMinutes * 60_000);
      if (boundary.getTime() > session.closeAt.getTime()) {
        return { kind: 'NO_SAFE_SAME_SESSION_HANDOFF', sessionClose: new Date(session.closeAt.getTime()) };
      }
      const target = new Date(boundary.getTime() - 60_000);
      // Independent second limit (see getSourceCompletionBoundary doc above): a boundary
      // that is otherwise safely before the operational session close is still not usable
      // if its required REST target has no source data -- being "before 15:40" never proves
      // "before 15:30" for NSE_INDEX|Nifty 50.
      const sourceHorizon = this.callbacks.getSourceCompletionBoundary?.(now);
      if (sourceHorizon != null && target.getTime() >= sourceHorizon.getTime()) {
        return { kind: 'NO_SAFE_SAME_SESSION_HANDOFF', sessionClose: new Date(session.closeAt.getTime()) };
      }
      this.callbacks.onLiveConstructionBoundary?.(boundary);
      return { kind: 'ALIGNED', target, boundary };
    }
    const baseExpected = this.callbacks.getExpectedCompletedMinute
      ? this.callbacks.getExpectedCompletedMinute(now)
      : defaultExpectedCompletedMinute(now);
    if (baseExpected === null) return null;
    const formingMinuteStart = new Date(baseExpected.getTime() + 60_000);
    const exactlyOnBoundary = now.getTime() === formingMinuteStart.getTime();
    const target = exactlyOnBoundary ? baseExpected : formingMinuteStart;
    const boundary = new Date(target.getTime() + 60_000);
    this.callbacks.onLiveConstructionBoundary?.(boundary);
    return { kind: 'ALIGNED', target, boundary };
  }

  private failNoSafeSameSessionHandoff(sessionClose: Date): void {
    this.pendingReconciliation = null;
    this.backfillReady = false;
    this.boundaryReconciliationObligation = {
      generationId: this.activeGenerationId,
      disposition: 'FAILED',
      reason: NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE,
    };
    try {
      this.callbacks.onLiveConstructionUnavailable?.(new Date(sessionClose.getTime()));
    } finally {
      // A construction-block callback failure must never leave the coordinator CONNECTED.
      this.fail(NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE, {
        ready: false,
        reason: NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_BEFORE_SESSION_CLOSE,
        missingMinutes: 0,
        duplicateMinutes: 0,
      });
    }
  }
  /** Fires pending aligned-boundary reconciliation once wall-clock time has reached its boundary. */
  private triggerBoundaryReconciliationIfDue(): void {
    const pending = this.pendingReconciliation;
    if (pending === null || pending.generationId !== this.activeGenerationId) return;
    if (this.nowMs() < pending.boundaryMs) return;
    this.pendingReconciliation = null;
    const token = ++this.recoveryToken;
    this.startRecovery(this.activeGenerationId, token, pending.requiredCompletedMinuteMs === undefined ? undefined : new Date(pending.requiredCompletedMinuteMs));
  }
  /** Starts (or restarts) recover() for a specific generation/token and records that exact ownership so a later awaiter can positively verify it, not merely observe a non-FAULTED state. */
  private startRecovery(generationId: number, token: number, requiredCompletedMinute?: Date): void {
    const obligation = this.boundaryReconciliationObligation;
    if (obligation?.generationId === generationId && obligation.disposition === 'REQUIRED_UNRESOLVED') obligation.attemptToken = token;
    const promise = this.recover(generationId, token, requiredCompletedMinute);
    this.currentRecoveryAttempt = { generationId, token, promise };
  }

  private requireBoundaryReconciliation(boundary: Date, requiredCompletedMinute: Date): void {
    this.boundaryReconciliationObligation = {
      generationId: this.activeGenerationId,
      boundaryMs: boundary.getTime(),
      requiredCompletedMinuteMs: requiredCompletedMinute.getTime(),
      disposition: 'REQUIRED_UNRESOLVED',
      reason: 'BOUNDARY_RECONCILIATION_REQUIRED',
    };
  }

  private markBoundaryReconciliationRecovered(reason: string): void {
    const obligation = this.boundaryReconciliationObligation;
    if (obligation === null || obligation.generationId !== this.activeGenerationId || obligation.disposition !== 'REQUIRED_UNRESOLVED') return;
    obligation.disposition = 'RECOVERED';
    obligation.reason = reason;
  }

  private failBoundaryReconciliationObligation(reason: string): void {
    const obligation = this.boundaryReconciliationObligation;
    if (obligation === null || obligation.disposition === 'FAILED') return;
    obligation.disposition = 'FAILED';
    obligation.reason = reason;
  }
  /**
   * EOD completion barrier: awaits any strategy-aligned boundary reconciliation that is
   * still pending OR already in flight (started by a live tick) for the current
   * generation, so a caller finalizing a session's terminal outcome never lets stop()
   * silently discard a still-unresolved recovery. Must be called BEFORE stop().
   *
   * SUCCESS ('RECOVERED') requires POSITIVE proof. The awaited attempt's own outcome (see
   * recover()'s doc) is already determined solely via isCurrentRecovery() checks made
   * synchronously at the moment they mattered -- never by inspecting shared instance state
   * after the fact, which fail()'s own recoveryToken bump would make indistinguishable from
   * an unrelated external supersession. This method still re-verifies ownership one more
   * time after the await resumes (a disconnect/reconnect/stop can still land in the gap
   * between recover() resolving and this continuation actually running), so a stale
   * 'RECOVERED' can never be reported once ownership has moved on. `this.state !== 'FAULTED'`
   * is deliberately never used as the success signal: a disconnect racing the await leaves
   * the coordinator RECONNECTING (not FAULTED) while silently abandoning the in-flight
   * attempt, and a stop() leaves it STOPPED -- neither is evidence the awaited recovery
   * actually happened.
   */
  async completePendingBoundaryReconciliation(): Promise<BoundaryReconciliationResult> {
    if (this.stopping) return { outcome: 'NOT_RECOVERED', reason: 'COORDINATOR_STOPPED' };
    const obligation = this.boundaryReconciliationObligation;
    if (obligation === null) return { outcome: 'NONE_PENDING', reason: 'NO_RECONCILIATION_REQUIREMENT' };
    if (obligation.disposition === 'FAILED') return { outcome: 'NOT_RECOVERED', reason: obligation.reason };
    if (obligation.disposition === 'RECOVERED') {
      const stillCurrent = obligation.generationId === this.activeGenerationId && this.state !== 'FAULTED' && this.state !== 'STOPPED' && this.state !== 'STOPPING';
      return stillCurrent
        ? { outcome: 'RECOVERED', reason: obligation.reason }
        : { outcome: 'NOT_RECOVERED', reason: 'RECOVERY_GENERATION_OR_STATE_SUPERSEDED' };
    }
    if (obligation.generationId !== this.activeGenerationId) return { outcome: 'NOT_RECOVERED', reason: 'RECOVERY_GENERATION_OR_TOKEN_SUPERSEDED' };
    const pending = this.pendingReconciliation;
    if (pending !== null && pending.generationId === this.activeGenerationId) {
      this.pendingReconciliation = null;
      const generationId = this.activeGenerationId;
      const token = ++this.recoveryToken;
      this.startRecovery(generationId, token, pending.requiredCompletedMinuteMs === undefined ? undefined : new Date(pending.requiredCompletedMinuteMs));
    }
    const attempt = this.currentRecoveryAttempt;
    if (attempt === undefined || attempt.generationId !== obligation.generationId || attempt.token !== obligation.attemptToken) {
      return { outcome: 'NOT_RECOVERED', reason: 'REQUIRED_RECOVERY_ATTEMPT_UNAVAILABLE' };
    }
    const attemptResult = await attempt.promise;
    if (this.stopping) return { outcome: 'NOT_RECOVERED', reason: 'COORDINATOR_STOPPED' };
    if (attemptResult.outcome !== 'RECOVERED') return attemptResult;
    const completedObligation = this.boundaryReconciliationObligation;
    const stillOwned = attempt.generationId === this.activeGenerationId
      && attempt.token === this.recoveryToken
      && this.backfillReady
      && completedObligation?.generationId === attempt.generationId
      && completedObligation.attemptToken === attempt.token
      && completedObligation.disposition === 'RECOVERED';
    return stillOwned ? attemptResult : { outcome: 'NOT_RECOVERED', reason: 'RECOVERY_GENERATION_OR_TOKEN_SUPERSEDED' };
  }
  /**
   * Race-safe wait for the coordinator's first READY: checks current state,
   * registers a one-shot listener, re-checks, and always removes the listener
   * and timer exactly once, however the wait settles. Rejects on FAULTED/STOPPED,
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
    this.failBoundaryReconciliationObligation('REQUIRED_RECOVERY_INVALIDATED_BY_DISCONNECT');
    this.recoveryToken += 1; this.backfillReady = false; this.freshLiveTick = false;
    // Any forming-minute reconciliation still pending from the connection that just
    // dropped is now moot -- handleReconnected (or a fresh handleInitialConnected, which
    // cannot happen twice) establishes its own boundary for whatever connection comes next.
    this.pendingReconciliation = null;
    this.setState('DEGRADED'); this.emitEvent('MARKET_DATA_DEGRADED', details); this.setState('RECONNECTING');
    this.emitEvent('RECONNECT_STARTED', details); this.emitEvent('DATA_GAP_DETECTED', details);
  }
  handleReconnected(details: MarketDataRecoveryDetails = {}): void {
    if (this.stopping || this.state !== 'RECONNECTING') return;
    if (details.generationId !== undefined && details.generationId <= this.activeGenerationId) return;
    this.activeGenerationId = details.generationId ?? this.activeGenerationId + 1;
    this.setState('CONNECTED'); this.emitEvent('RECONNECT_SUCCEEDED', details);
    // A reconnect always re-backfills (unlike cold start, there is no "already covered"
    // shortcut -- the outage itself proves data may be missing). Callers not configured
    // for cold-start continuity (no getLastSeededCompletedMinute) keep the prior
    // unconditional-immediate-recover behavior exactly; configured callers additionally
    // get the same forming-minute-at-reconnect boundary protection as a cold start (the
    // WebSocket can just as easily reconnect mid-bucket as it can connect mid-bucket).
    if (this.callbacks.getLastSeededCompletedMinute === undefined) {
      const token = ++this.recoveryToken; this.startRecovery(this.activeGenerationId, token);
      return;
    }
    const now = new Date(this.nowMs());
    const established = this.establishLiveConstructionBoundary(now);
    if (established === null) {
      // Outside the configured session window: fall back to the unconditional-immediate
      // behavior rather than fabricating a boundary that cannot mean anything here.
      const token = ++this.recoveryToken; this.startRecovery(this.activeGenerationId, token);
      return;
    }
    if (established.kind === 'NO_SAFE_SAME_SESSION_HANDOFF') {
      this.failNoSafeSameSessionHandoff(established.sessionClose);
      return;
    }
    this.requireBoundaryReconciliation(established.boundary, established.target);
    this.pendingReconciliation = {
      generationId: this.activeGenerationId,
      boundaryMs: established.boundary.getTime(),
      requiredCompletedMinuteMs: this.callbacks.liveConstructionAlignmentMinutes === undefined ? undefined : established.target.getTime(),
    };
    this.triggerBoundaryReconciliationIfDue();
  }
  /**
   * `sourceTimestamp` (exchange/provider event time) and `receivedAt` (local
   * time this tick was accepted) are distinct clock domains and must never be
   * substituted for one another. The reconnect/recovery boundary this proves
   * a tick arrived after (`recoveryStartedAt`) is itself a local wall-clock
   * anchor (see handleUnexpectedDisconnect/handleInitialConnected), so the
   * freshness proof below compares receivedAt against it -- never
   * sourceTimestamp, which a broker/local clock skew could place on either
   * side of that boundary independent of when TradeMind actually received
   * the packet. Generation ownership (isCurrentLiveGeneration, checked first)
   * already proves this tick arrived on the current connection, not a
   * pre-reconnect buffered one, so no separate source-time baseline is
   * required for that guarantee.
   */
  handleLiveTick(details: { sourceTimestamp: Date; receivedAt: Date; generationId?: number }): void {
    const { sourceTimestamp, receivedAt, generationId } = details;
    if (this.stopping || !isCurrentLiveGeneration(generationId, this.activeGenerationId)) return;
    // A live tick is real evidence that wall-clock time has reached `receivedAt`: use it to
    // fire a still-pending forming-minute reconciliation once it proves the boundary has
    // actually passed (see establishLiveConstructionBoundary/triggerBoundaryReconciliationIfDue).
    if (this.pendingReconciliation !== null && this.pendingReconciliation.generationId === this.activeGenerationId && receivedAt.getTime() >= this.pendingReconciliation.boundaryMs) {
      const pending = this.pendingReconciliation;
      this.pendingReconciliation = null;
      const token = ++this.recoveryToken;
      this.startRecovery(this.activeGenerationId, token, pending.requiredCompletedMinuteMs === undefined ? undefined : new Date(pending.requiredCompletedMinuteMs));
    }
    if ((this.state === 'WAITING_FOR_FRESH_TICK' || this.state === 'AWAITING_LIVE_TICK') && receivedAt.getTime() >= this.recoveryStartedAt) {
      this.freshLiveTick = true;
      recordMarketReplayEvent('FRESH_TICK_READY', { instrumentKey:null, sourceTimestamp:sourceTimestamp.toISOString(), receivedTimestamp:receivedAt.toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} });
      this.emitEvent('MARKET_DATA_FRESH_TICK_CONFIRMED', { generationId: this.activeGenerationId });
    }
    this.tryBecomeReady();
  }
  stop(): void { if (this.stopping || this.state === 'STOPPED') return; this.failBoundaryReconciliationObligation('COORDINATOR_STOPPED_WITH_REQUIRED_RECOVERY'); this.stopping = true; this.recoveryToken += 1; this.pendingReconciliation = null; recordMarketReplayEvent('EOD', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:this.activeGenerationId, payload:{} }); this.setState('STOPPING'); this.setState('STOPPED'); }
  fault(reason = 'RECOVERY_EXHAUSTED'): void {
    if (this.stopping || this.state === 'FAULTED' || this.state === 'FAIL_CLOSED' || this.state === 'STOPPED' || this.state === 'STOPPING') return;
    this.failBoundaryReconciliationObligation(reason);
    this.recoveryToken += 1; this.fail(reason, { ready:false, reason, missingMinutes:0, duplicateMinutes:0 });
  }
  private static readonly SUPERSEDED_RESULT: BoundaryReconciliationResult = { outcome: 'NOT_RECOVERED', reason: 'RECOVERY_GENERATION_OR_TOKEN_SUPERSEDED' };
  /**
   * Returns THIS specific attempt's own definitive outcome -- determined only via
   * isCurrentRecovery() checks made synchronously at the moment they mattered, never via
   * inspecting shared instance state after the fact (which fail()'s own recoveryToken bump
   * would make indistinguishable from an unrelated external supersession). Every fire-and-
   * forget caller (triggerBoundaryReconciliationIfDue, handleLiveTick, the legacy
   * handleReconnected paths) is free to ignore the resolved value; completePendingBoundaryReconciliation() is the one caller that relies on it for positive proof.
   */
  private async recover(generationId: number, token: number, requiredCompletedMinute?: Date): Promise<BoundaryReconciliationResult> {
    if (!this.isCurrentRecovery(generationId,token)) return MarketDataRecoveryCoordinatorService.SUPERSEDED_RESULT;
    recordMarketReplayEvent('BACKFILL_STARTED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:generationId, payload:{} }); this.setState('BACKFILLING'); this.emitEvent('MARKET_DATA_BACKFILL_STARTED', { generationId });
    try {
      const result = await this.callbacks.backfill(requiredCompletedMinute ? new Date(requiredCompletedMinute.getTime()) : undefined);
      if (!this.isCurrentRecovery(generationId,token)) return MarketDataRecoveryCoordinatorService.SUPERSEDED_RESULT;
      if (!result.ready) { this.fail(result.reason, result); return { outcome: 'NOT_RECOVERED', reason: result.reason }; }
      if (requiredCompletedMinute) {
        const recovered = this.callbacks.getRecoveredCompletedMinute?.(result.recoveryData);
        if (!(recovered instanceof Date) || Number.isNaN(recovered.getTime()) || recovered.getTime() !== requiredCompletedMinute.getTime()) {
          this.fail('REQUIRED_COMPLETED_MINUTE_NOT_RECOVERED', { ready:false, reason:'REQUIRED_COMPLETED_MINUTE_NOT_RECOVERED', missingMinutes:1, duplicateMinutes:result.duplicateMinutes });
          return { outcome: 'NOT_RECOVERED', reason: 'REQUIRED_COMPLETED_MINUTE_NOT_RECOVERED' };
        }
      }
      this.callbacks.onRecovered?.(generationId,result.recoveryData); if (!this.isCurrentRecovery(generationId,token)) return MarketDataRecoveryCoordinatorService.SUPERSEDED_RESULT;
      this.markBoundaryReconciliationRecovered('OWNED_RECOVERY_CONFIRMED');
      this.backfillReady = true; recordMarketReplayEvent('BACKFILL_COMPLETED', { instrumentKey:null, sourceTimestamp:null, receivedTimestamp:new Date().toISOString(), sequenceNumber:null, connectionGenerationId:generationId, payload:{ missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes } }); this.emitEvent('MARKET_DATA_BACKFILL_COMPLETED', { generationId, missingMinutes:result.missingMinutes });
      this.setState('WAITING_FOR_FRESH_TICK'); this.tryBecomeReady();
      return { outcome: 'RECOVERED', reason: 'OWNED_RECOVERY_CONFIRMED' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'BACKFILL_FAILED';
      if (!this.isCurrentRecovery(generationId,token)) return MarketDataRecoveryCoordinatorService.SUPERSEDED_RESULT;
      this.fail(reason, { ready:false, reason, missingMinutes:0, duplicateMinutes:0 });
      return { outcome: 'NOT_RECOVERED', reason };
    }
  }
  private tryBecomeReady(): void {
    if ((this.state === 'WAITING_FOR_FRESH_TICK' || this.state === 'AWAITING_LIVE_TICK') && this.backfillReady && this.freshLiveTick) {
      this.setState('READY'); if(!this.isReadyState())return; if(this.recoveringFromDisconnect)this.emitEvent('DATA_GAP_RECOVERED', { generationId:this.activeGenerationId, durationMs:this.nowMs()-this.recoveryStartedAt }); if(this.isReadyState())this.emitEvent('MARKET_DATA_READY', { generationId:this.activeGenerationId });
    }
  }
  private fail(reason: string, result: MarketDataRecoveryResult<TRecoveryData>): void { if (this.stopping) return; this.failBoundaryReconciliationObligation(reason); this.recoveryToken+=1;this.setState('FAULTED'); const details={ reason, missingMinutes:result.missingMinutes, duplicateMinutes:result.duplicateMinutes, generationId:this.activeGenerationId }; this.emitEvent('DATA_GAP_UNRECOVERABLE', details); this.emitEvent('MARKET_DATA_RECOVERY_FAILED', details); }
  private isCurrentRecovery(generationId:number,token:number):boolean{return !this.stopping&&generationId===this.activeGenerationId&&token===this.recoveryToken&&this.state!=='FAULTED'&&this.state!=='STOPPED'&&this.state!=='STOPPING';}
  private isReadyState():boolean{return this.state==='READY';}
  private nowMs(): number { return this.callbacks.nowMs?.() ?? Date.now(); }
  private emitEvent(event: Parameters<NonNullable<MarketDataRecoveryCallbacks['onEvent']>>[0], details: MarketDataRecoveryDetails | Record<string, string|number|boolean|null>): void { this.callbacks.onEvent?.(event, Object.fromEntries(Object.entries(details).map(([key,value])=>[key,value ?? null]))); }
  private setState(state: MarketDataRecoveryState): void { if (this.state === state) return; const previousState=this.state; this.state=state; this.emit('stateChanged', state, previousState); }
}
