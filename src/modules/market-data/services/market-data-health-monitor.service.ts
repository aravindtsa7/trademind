import { EventEmitter } from 'events';
import ConnectionManager, { ConnectionState, ReconnectCircuitState } from '../managers/connection.manager';
import { isWithinIstMarketSession } from './ist-market-session-eod.service';

export type MarketDataHealthState = 'RECOVERING' | 'GRACE' | 'HEALTHY' | 'UNHEALTHY' | 'FAULTED';

export interface MarketDataHealthSnapshot {
  [key: string]: string | number | boolean | null;
  generationId: number;
  state: ConnectionState;
  healthState: MarketDataHealthState;
  insideGrace: boolean;
  graceRemainingMs: number | null;
  lastRawMessageAgeMs: number | null;
  lastValidMarketEventAgeMs: number | null;
  lastNiftyTickAgeMs: number | null;
  /** Local receive-time age since the accepted NIFTY sourceTimestamp last advanced; null until a source-carrying tick has been accepted for the current generation. Distinct from lastNiftyTickAgeMs, which only proves packets are still arriving, not that source time is progressing. */
  lastNiftySourceAdvanceAgeMs: number | null;
  reconnectCount: number;
  reconnectAttemptCount: number;
  breakerState: ReconnectCircuitState;
  lastFailureReason: string | null;
  nextRetryAtMs: number | null;
}

export interface MarketDataHealthMonitorOptions {
  stallMs?: number;
  heartbeatCheckMs?: number;
  generationGraceMs?: number;
  now?: () => number;
  isMarketSession?: (value: Date) => boolean;
  /**
   * Narrower than isMarketSession: "is the underlying market-data SOURCE still expected to be
   * producing fresh ticks right now?" Gates ONLY the narrow SOURCE_STALL classification inside
   * check() -- raw/transport activity still fresh, but the accepted NIFTY sourceTimestamp has
   * stopped advancing. A dead-open transport (STALL) or an unconfirmed grace period
   * (HEALTH_GRACE_EXPIRED) always solicits a reconnect regardless of this predicate: this class
   * still exists to detect a WebSocket that remains logically connected but has stopped
   * delivering packets, and option quotes/marking/risk/exit data can still require a working
   * socket up to the operational EOD, independent of whether NIFTY source candles are still
   * being produced. Every other use of isMarketSession in this class (grace-period activation,
   * confirmRecoveryReady, the overall check() gate) is untouched and keeps operating through
   * the wider operational session. Defaults to isMarketSession, so a caller that does not
   * configure this sees no behavior change. Live callers inject this as
   * `now => now < nifty1mSourceCompletionBoundary(now)` (or equivalent) rather than this class
   * hardcoding any source-specific boundary -- this class deliberately does not infer market
   * data (see the class doc comment).
   */
  isSourceFresh?: (value: Date) => boolean;
  /**
   * `reason` is the SAME classification check() already computes internally
   * (STALL/SOURCE_STALL/HEALTH_GRACE_EXPIRED) -- callers must never re-guess it from snapshot
   * fields. `reconnectSolicited` is the exact same boolean this class used to decide whether it
   * called connection.reconnectForHealth() for this event (see check()): true for STALL/
   * HEALTH_GRACE_EXPIRED always, and for SOURCE_STALL only when isSourceFresh(now) was also
   * true. A caller's own coordinator-disconnect handling (handleUnexpectedDisconnect(...) or
   * its source-recovery-not-required alternate) must be gated on this SAME flag -- never
   * invoked unconditionally -- so an expected post-source-completion SOURCE_STALL (transport
   * healthy, only the NIFTY source itself naturally stopped) can never start an unpaired
   * disconnect/reconnect episode the coordinator can never close out.
   */
  onStall?: (snapshot: MarketDataHealthSnapshot, context: { reason: MarketDataStallReason; reconnectSolicited: boolean }) => void;
  onHealthy?: (snapshot: MarketDataHealthSnapshot) => void;
}

export type MarketDataStallReason = 'STALL' | 'SOURCE_STALL' | 'HEALTH_GRACE_EXPIRED';

/** Detects a dead-but-open transport. It deliberately does not infer market data. */
export default class MarketDataHealthMonitorService extends EventEmitter {
  private readonly stallMs: number;
  private readonly heartbeatCheckMs: number;
  private readonly generationGraceMs: number;
  private readonly now: () => number;
  private readonly isMarketSession: (value: Date) => boolean;
  private readonly isSourceFresh: (value: Date) => boolean;
  private timer?: NodeJS.Timeout;
  private generationId = 0;
  private lastRawMessageAt?: number;
  private lastValidMarketEventAt?: number;
  private lastNiftyTickAt?: number;
  /** SOURCE_TIME (ms) of the last accepted current-generation NIFTY tick whose sourceTimestamp advanced past the previous one. */
  private lastAcceptedNiftySourceTimestampMs?: number;
  /** RECEIVE_TIME this monitor last observed a NIFTY source-timestamp advance -- the only value ever compared against this.now() for staleness. */
  private lastNiftySourceAdvanceAt?: number;
  private reconnectCount = 0;
  /**
   * Generation for which a transport reconnect has actually been SOLICITED (STALL/
   * HEALTH_GRACE_EXPIRED, or a SOURCE_STALL where isSourceFresh was also true) -- the ONLY
   * latch that gates reconnect eligibility / duplicate-reconnect prevention. A benign
   * SOURCE_STALL with reconnectSolicited=false must NEVER arm this: doing so previously hid a
   * later same-generation transport STALL/HEALTH_GRACE_EXPIRED behind the early-return below,
   * leaving a dead-open socket unrecoverable until EOD (see class doc "same-generation"
   * correction). Cleared only by generation rotation (activateGeneration) or an explicit
   * transport-readiness confirmation (confirmRecoveryReady/confirmPostSourceTransportReady).
   */
  private reconnectSolicitedGeneration?: number;
  /**
   * Generation for which a benign (reconnectSolicited=false) SOURCE_STALL has already been
   * reported -- purely informational, so a heartbeat that keeps observing the identical benign
   * condition does not re-emit 'stalled'/onStall every cycle. Must NEVER participate in
   * reconnect eligibility -- see reconnectSolicitedGeneration above, which is the only latch
   * check() consults before classifying/soliciting a reconnect.
   */
  private sourceStallObservedGeneration?: number;
  private generationActivatedAt?: number;
  private healthState: MarketDataHealthState = 'RECOVERING';

  constructor(private readonly connection: ConnectionManager, private readonly options: MarketDataHealthMonitorOptions = {}) {
    super();
    this.stallMs = options.stallMs ?? Number(process.env.MARKET_DATA_STALL_MS ?? 45_000);
    this.heartbeatCheckMs = options.heartbeatCheckMs ?? Number(process.env.MARKET_DATA_HEARTBEAT_CHECK_MS ?? 5_000);
    this.generationGraceMs = options.generationGraceMs ?? Number(process.env.MARKET_DATA_HEALTH_GRACE_MS ?? this.stallMs);
    if (!Number.isFinite(this.stallMs) || this.stallMs <= 0) throw new Error('stallMs must be a positive finite number.');
    if (!Number.isFinite(this.heartbeatCheckMs) || this.heartbeatCheckMs <= 0) throw new Error('heartbeatCheckMs must be a positive finite number.');
    if (!Number.isFinite(this.generationGraceMs) || this.generationGraceMs <= 0) throw new Error('generationGraceMs must be a positive finite number.');
    this.now = options.now ?? Date.now;
    this.isMarketSession = options.isMarketSession ?? isWithinIstMarketSession;
    this.isSourceFresh = options.isSourceFresh ?? this.isMarketSession;
    connection.on('connected', (details: { generationId: number }) => this.activateGeneration(details.generationId));
    connection.on('reconnected', () => { this.reconnectCount += 1; });
    connection.on('message', (_message: Buffer, details: { generationId: number }) => this.noteRawMessage(details.generationId));
    connection.on('stateChanged', ({ state }: { state: ConnectionState }) => { if (state !== ConnectionState.CONNECTED) this.healthState = state === ConnectionState.FAULTED ? 'FAULTED' : 'RECOVERING'; });
  }

  start(): void { if (this.timer) return; this.timer = setInterval(() => this.check(), this.heartbeatCheckMs); this.timer.unref(); }
  stop(): void { if (!this.timer) return; clearInterval(this.timer); this.timer = undefined; }
  noteValidMarketEvent(generationId: number): void { if (generationId !== this.generationId) return; this.lastValidMarketEventAt = this.now(); }
  /**
   * `sourceTimestamp` is the exchange/provider event time carried by the
   * tick, never the local receive time. It only ever advances
   * lastNiftySourceAdvanceAt (a RECEIVE_TIME) when it strictly progresses
   * past the last accepted current-generation value -- a repeated or
   * out-of-order source timestamp leaves the advance clock untouched, so
   * `check()` can detect a feed that keeps delivering packets whose source
   * time itself has stopped moving.
   */
  noteNiftyTick(generationId: number, sourceTimestamp?: Date): void {
    if (generationId !== this.generationId) return;
    this.lastNiftyTickAt = this.now();
    const sourceMs = sourceTimestamp?.getTime();
    if (sourceMs !== undefined && Number.isFinite(sourceMs) && (this.lastAcceptedNiftySourceTimestampMs === undefined || sourceMs > this.lastAcceptedNiftySourceTimestampMs)) {
      this.lastAcceptedNiftySourceTimestampMs = sourceMs;
      this.lastNiftySourceAdvanceAt = this.now();
    }
  }
  confirmRecoveryReady(generationId: number): boolean {
    if (generationId !== this.generationId || this.connection.getState() !== ConnectionState.CONNECTED) return false;
    if (this.healthState === 'HEALTHY') return true;
    const now = this.now();
    if(!this.isMarketSession(new Date(now)))return false;
    if (![this.lastRawMessageAt,this.lastValidMarketEventAt,this.lastNiftyTickAt].every((value) => value !== undefined && now - value <= this.stallMs)) return false;
    const confirmed = this.connection.confirmRecoveryReady(generationId);
    if (!confirmed) return false;
    this.healthState = 'HEALTHY'; this.generationActivatedAt = undefined; this.reconnectSolicitedGeneration = undefined; this.sourceStallObservedGeneration = undefined;
    const snapshot=this.getSnapshot(); this.emit('healthy',snapshot); this.options.onHealthy?.(snapshot); return true;
  }
  /**
   * Post-source-completion analogue of confirmRecoveryReady(): proves the same current-
   * generation, CONNECTED transport evidence -- a raw message AND a valid market event, option
   * quotes count exactly as well as NIFTY -- but deliberately never requires lastNiftyTickAt.
   * Once the source horizon has passed, a further NIFTY tick is no longer guaranteed at all, so
   * requiring one here would make this contract just as unsatisfiable as confirmRecoveryReady()
   * is post-completion. A raw message alone is still insufficient: lastValidMarketEventAt must
   * independently also be current-generation-fresh, exactly mirroring confirmRecoveryReady's
   * own two-signals-of-three floor. Internally re-verifies the evidence itself (never trusts
   * the caller's assertion), and reuses ConnectionManager's confirmTransportReady() to clear
   * the identical reconnect-circuit bookkeeping confirmRecoveryReady() would -- but that call is
   * about the TRANSPORT's reconnect breaker, not source-candle recovery, so it deliberately
   * never emits MARKET_DATA_RECOVERY_CONFIRMED: no source-candle recovery/backfill happened on
   * this bypass path, and claiming so would be misleading observability.
   */
  confirmPostSourceTransportReady(generationId: number): boolean {
    if (generationId !== this.generationId || this.connection.getState() !== ConnectionState.CONNECTED) return false;
    if (this.healthState === 'HEALTHY') return true;
    const now = this.now();
    if (!this.isMarketSession(new Date(now))) return false;
    if (![this.lastRawMessageAt, this.lastValidMarketEventAt].every((value) => value !== undefined && now - value <= this.stallMs)) return false;
    const confirmed = this.connection.confirmTransportReady(generationId);
    if (!confirmed) return false;
    this.healthState = 'HEALTHY'; this.generationActivatedAt = undefined; this.reconnectSolicitedGeneration = undefined; this.sourceStallObservedGeneration = undefined;
    const snapshot = this.getSnapshot(); this.emit('healthy', snapshot); this.options.onHealthy?.(snapshot);
    return true;
  }
  isHealthy(): boolean { return this.healthState === 'HEALTHY' && this.connection.getState() === ConnectionState.CONNECTED; }
  checkNow(): void { this.check(); }
  getSnapshot(): MarketDataHealthSnapshot {
    const now = this.now(); const age = (value?: number) => value === undefined ? null : Math.max(0, now - value); const circuit=this.connection.getReconnectCircuitSnapshot();
    const insideGrace = this.healthState === 'GRACE' && this.connection.getState() === ConnectionState.CONNECTED && this.generationActivatedAt !== undefined && now-this.generationActivatedAt < this.generationGraceMs;
    return { generationId:this.generationId, state:this.connection.getState(), healthState:this.healthState, insideGrace, graceRemainingMs:this.healthState==='GRACE'&&this.generationActivatedAt!==undefined?Math.max(0,this.generationGraceMs-(now-this.generationActivatedAt)):null, lastRawMessageAgeMs:age(this.lastRawMessageAt), lastValidMarketEventAgeMs:age(this.lastValidMarketEventAt), lastNiftyTickAgeMs:age(this.lastNiftyTickAt), lastNiftySourceAdvanceAgeMs:age(this.lastNiftySourceAdvanceAt), reconnectCount:this.reconnectCount, reconnectAttemptCount:circuit.attempts, breakerState:circuit.state, lastFailureReason:circuit.lastFailureReason, nextRetryAtMs:circuit.nextRetryAtMs };
  }
  private activateGeneration(generationId: number): void {
    this.generationId=generationId; this.reconnectSolicitedGeneration=undefined; this.sourceStallObservedGeneration=undefined; this.healthState='GRACE'; this.lastRawMessageAt=undefined; this.lastValidMarketEventAt=undefined; this.lastNiftyTickAt=undefined; this.lastAcceptedNiftySourceTimestampMs=undefined; this.lastNiftySourceAdvanceAt=undefined;
    const now=this.now(); this.generationActivatedAt=this.isMarketSession(new Date(now))?now:undefined;
    if(this.generationActivatedAt!==undefined)this.emit('graceStarted',this.getSnapshot());
  }
  private noteRawMessage(generationId: number): void { if (generationId !== this.generationId) return; this.lastRawMessageAt = this.now(); }
  private check(): void {
    if (!this.isMarketSession(new Date(this.now())) || this.connection.getState() !== ConnectionState.CONNECTED) return;
    if (this.healthState === 'GRACE' && this.generationActivatedAt === undefined) { this.generationActivatedAt=this.now(); this.emit('graceStarted',this.getSnapshot()); return; }
    if (this.healthState === 'GRACE' && this.generationActivatedAt !== undefined && this.now()-this.generationActivatedAt < this.generationGraceMs) return;
    const snapshot = this.getSnapshot();
    // The ONLY latch gating check()'s early exit: a reconnect already SOLICITED for this
    // generation. A benign SOURCE_STALL (reconnectSolicited=false, below) never arms this, so a
    // later same-generation STALL/HEALTH_GRACE_EXPIRED remains fully eligible for detection and
    // a real reconnect -- see reconnectSolicitedGeneration's own doc for why this must stay
    // separate from sourceStallObservedGeneration.
    if (this.reconnectSolicitedGeneration === snapshot.generationId) return;
    const sourceFresh = this.isSourceFresh(new Date(this.now()));
    // Once the source horizon has passed, a further NIFTY tick is no longer guaranteed AT ALL
    // (see MarketDataRecoveryCoordinatorService's own post-source-completion contract) -- a
    // permanently-null/stale lastNiftyTickAgeMs must never, by itself, manufacture a STALL/
    // HEALTH_GRACE_EXPIRED for an otherwise perfectly healthy transport, or check() would keep
    // re-flagging every heartbeat forever purely because NIFTY naturally went silent. Before
    // the boundary this is completely untouched: an absent/stale NIFTY tick is exactly as
    // meaningful as before, so normal intraday recovery readiness is not weakened.
    const referenceAge = sourceFresh
      ? Math.max(snapshot.lastRawMessageAgeMs ?? Infinity, snapshot.lastValidMarketEventAgeMs ?? Infinity, snapshot.lastNiftyTickAgeMs ?? Infinity)
      : Math.max(snapshot.lastRawMessageAgeMs ?? Infinity, snapshot.lastValidMarketEventAgeMs ?? Infinity);
    // Packets can keep arriving (referenceAge healthy) while the accepted NIFTY
    // sourceTimestamp itself stops advancing; a receive-time-only view would
    // report that as healthy forever. lastNiftySourceAdvanceAgeMs is only
    // defined once a source-carrying NIFTY tick has actually been accepted for
    // this generation, so a feed that never supplies source timestamps -- or
    // one that briefly repeats the same source timestamp within the stall
    // threshold -- stays exempt from this check.
    const sourceStalled = snapshot.lastNiftySourceAdvanceAgeMs !== null && snapshot.lastNiftySourceAdvanceAgeMs > this.stallMs;
    if (snapshot.healthState !== 'GRACE' && referenceAge <= this.stallMs && !sourceStalled) return;
    const reason: MarketDataStallReason = snapshot.healthState==='GRACE'?'HEALTH_GRACE_EXPIRED':(referenceAge>this.stallMs?'STALL':'SOURCE_STALL');
    // isSourceFresh gates ONLY the narrow SOURCE_STALL case -- raw/transport activity is still
    // fresh, but the accepted NIFTY sourceTimestamp itself has stopped advancing because its
    // canonical source horizon ended. That specific condition must not solicit a reconnect the
    // recovery coordinator can never satisfy for a new candle. A dead-open transport (STALL) or
    // an unconfirmed grace period (HEALTH_GRACE_EXPIRED) is a genuine transport-health problem
    // -- option quotes/marking/risk/exit data can still require a working socket up to the
    // 15:40 operational EOD -- so those must always solicit a reconnect, exactly as before this
    // gate existed. ConnectionManager itself, and any genuine (non-health-monitor) transport-
    // level disconnect/reconnect, are untouched regardless.
    const reconnectSolicited = reason !== 'SOURCE_STALL' || sourceFresh;
    if (reason === 'SOURCE_STALL' && !reconnectSolicited) {
      // Benign, observability-only: reported once per generation (never re-emitted every
      // heartbeat for the SAME still-benign condition), but deliberately never arms
      // reconnectSolicitedGeneration -- see that field's doc. This is what lets a later
      // same-generation STALL/HEALTH_GRACE_EXPIRED still be detected and reconnected below.
      if (this.sourceStallObservedGeneration === snapshot.generationId) return;
      this.sourceStallObservedGeneration = snapshot.generationId;
      this.healthState = 'UNHEALTHY';
      const unhealthy = this.getSnapshot(); this.emit('stalled', unhealthy);
      this.options.onStall?.(unhealthy, { reason, reconnectSolicited });
      return;
    }
    this.healthState='UNHEALTHY'; this.reconnectSolicitedGeneration=snapshot.generationId;
    const unhealthy=this.getSnapshot(); this.emit('stalled',unhealthy);
    // The classification (and whether a reconnect was solicited for it) must reach the caller
    // BEFORE any coordinator-disconnect handling the caller performs in response -- see the
    // onStall doc above. Passing anything less specific here is exactly what previously let
    // every runner's onStall callback start an unpaired coordinator episode for an expected,
    // benign post-source SOURCE_STALL.
    this.options.onStall?.(unhealthy, { reason, reconnectSolicited });
    this.connection.reconnectForHealth(reason,snapshot.generationId);
  }
}
