import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import MarketDataWebSocketClient, { MarketDataWebSocketOpenTimeoutError } from '../client/websocket.client';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;
const defaultMaximumReconnectAttempts = 6;
const defaultMaximumReconnectDurationMs = 60_000;
const defaultReconnectJitterMs = 250;

export type ReconnectCircuitState = 'CLOSED' | 'OPEN';

export interface ConnectionManagerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConnectionManagerOptions {
  maximumReconnectAttempts?: number;
  maximumReconnectDurationMs?: number;
  reconnectJitterMs?: number;
  initialReconnectDelayMs?: number;
  maximumReconnectDelayMs?: number;
  random?: () => number;
  now?: () => number;
  scheduler?: ConnectionManagerScheduler;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  FAULTED = 'FAULTED',
}

export interface ConnectionEventDetails {
  generationId: number;
  attempt?: number;
  attempts?: number;
  reason?: string;
  code?: number;
  disconnectClean?: boolean;
  downtimeMs?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  effectiveDelayMs?: number;
  breakerState?: ReconnectCircuitState;
  lastFailureReason?: string;
  nextRetryAtMs?: number;
}

export interface ReconnectCircuitSnapshot {
  state: ReconnectCircuitState;
  attempts: number;
  lastFailureReason: string | null;
  activeGenerationId: number;
  pendingRecoveryGenerationId: number | null;
  reconnectEpisodeActive: boolean;
  nextRetryAtMs: number | null;
}

interface ReconnectTimerOwnership {
  handle: unknown;
  token: number;
  generationId: number;
}

interface RecoveryDeadlineOwnership {
  handle: unknown;
  episodeToken: number;
}

/**
 * beginReconnect()/scheduleReconnect() internal option: when true, the caller (currently only
 * reconnectForHealth()) has taken explicit ownership of starting the physical-outage anchor
 * itself, at the point it actually initiates transport invalidation, rather than at the moment
 * this episode was merely declared. See transportOutageStartedAt's own doc for the full rationale.
 */
interface BeginReconnectOptions {
  deferPhysicalOutageStart?: boolean;
}

/**
 * The sole owner of socket reconnect episodes.  Runtime-specific code may
 * observe its events but must never schedule its own reconnect timer.
 */
export default class ConnectionManager extends EventEmitter {
  private client: MarketDataWebSocketClient;
  private state = ConnectionState.DISCONNECTED;
  private reconnectTimer?: ReconnectTimerOwnership;
  private recoveryDeadlineTimer?: RecoveryDeadlineOwnership;
  private reconnectAttempts = 0;
  private connectPromise?: Promise<void>;
  private connectAttemptToken?: number;
  private manuallyDisconnected = false;
  /**
   * LOGICAL unresolved-recovery anchor -- "how long has strategy-safe market-data readiness been
   * unconfirmed", spanning as many bare socket reconnects/backfills as it takes. Owns
   * maximumReconnectDurationMs/recoveryDeadlineTimer/recoveryEpisodeToken/reconnectAttempts/
   * pendingRecoveryGenerationId. Cleared ONLY by clearRecoveryBookkeeping() (confirmRecoveryReady()/
   * confirmTransportReady(), i.e. a genuine current-generation strategy-safe confirmation) or a
   * manual disconnect() -- deliberately NEVER by a bare socket reconnect or a REST/backfill
   * success alone: neither proves a fresh live tick was ever observed, and a socket that keeps
   * reconnecting without ever getting confirmed must still fail closed at the original budget
   * (see the "spans bare socket opens" / "cannot restart per generation" tests). Distinct from
   * transportOutageStartedAt below -- see that field's doc for the split this class enforces.
   */
  private reconnectStartedAt?: number;
  /**
   * PHYSICAL transport-outage anchor -- "how long has the CURRENT socket specifically been
   * physically unavailable", for accurate MARKET_DATA_RECONNECTED downtimeMs telemetry only.
   * Cleared unconditionally the instant the socket next opens (registerClientListeners'
   * 'connected' handler) -- regardless of whether logical strategy-safe readiness has been
   * confirmed. A later, independent outage always gets a fresh value here even while
   * reconnectStartedAt (above) is still counting an unresolved logical episode. Carries no
   * fail-closed/duration-budget semantics of its own; it exists purely so telemetry never reports
   * an unrelated prior episode's elapsed time as this reconnect's downtime (the proven 2026-09-01
   * V4 incident: a ~2.5s physical reconnect logged with downtimeMs≈920114 because both clocks
   * used to be the same field).
   *
   * WHERE it is established is deliberately NOT uniform, because "physically unavailable" means
   * different things for different triggers:
   *  - beginReconnect(), called directly from an already-realized transport loss (an unexpected
   *    'disconnected'/close event with no episode yet active, or a first connect attempt that
   *    never opened at all), sets it itself: the transport is ALREADY gone by the time that call
   *    runs.
   *  - reconnectForHealth() (STALL / HEALTH_GRACE_EXPIRED / a raw connectionError whose transport
   *    is NOT yet proven closed) instead passes { deferPhysicalOutageStart: true } into
   *    beginReconnect() and merely INITIATES invalidation (client.disconnectForRecovery()'s
   *    socket.close()) -- the CURRENT socket may still be physically open at that point (a health
   *    stall is data going silent, not proof the transport itself has failed, and close() only
   *    begins a handshake that completes asynchronously). The anchor is instead set when
   *    registerClientListeners()'s 'disconnected' handler observes the resulting close event while
   *    an episode is already active -- the first point with actual proof the transport is gone.
   *    Anchoring any earlier would count time the socket was demonstrably still usable as
   *    "downtime".
   *  - reconnectForTransportFailure(), called only for a raw connectionError whose client contract
   *    already proves the CURRENT socket physically unusable (readyState CLOSED) at the moment the
   *    error fired, does NOT defer: the transport is already known dead right now, so there is no
   *    earlier-than-true point to protect against, and deferring would instead UNDERCOUNT downtime
   *    by excluding the error-to-close interval. The close event that inevitably follows still
   *    reaches the 'disconnected' handler above, but beginPhysicalOutage() there is then a no-op.
   * See beginPhysicalOutage()/reconnectForHealth()/reconnectForTransportFailure()'s own comments
   * for the mechanics.
   */
  private transportOutageStartedAt?: number;
  private reconnectEpisodeActive = false;
  private generationId = 0;
  private recoveryReason?: string;
  private breakerState: ReconnectCircuitState = 'CLOSED';
  private lastFailureReason?: string;
  private nextRetryAtMs?: number;
  private pendingRecoveryGenerationId?: number;
  private reconnectToken = 0;
  private recoveryEpisodeToken = 0;
  private readonly maximumReconnectAttempts: number;
  private readonly maximumReconnectDurationMs: number;
  private readonly reconnectJitterMs: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maximumReconnectDelayMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly scheduler: ConnectionManagerScheduler;

  constructor(accessToken: string, client = new MarketDataWebSocketClient(accessToken), options: ConnectionManagerOptions = {}) {
    super();
    this.client = client;
    this.maximumReconnectAttempts = positiveInteger(options.maximumReconnectAttempts, process.env.MARKET_DATA_MAX_RECONNECT_ATTEMPTS, defaultMaximumReconnectAttempts, 'maximumReconnectAttempts');
    this.maximumReconnectDurationMs = positiveNumber(options.maximumReconnectDurationMs, process.env.MARKET_DATA_MAX_RECONNECT_DURATION_MS, defaultMaximumReconnectDurationMs, 'maximumReconnectDurationMs');
    this.reconnectJitterMs = nonNegativeNumber(options.reconnectJitterMs, process.env.MARKET_DATA_RECONNECT_JITTER_MS, defaultReconnectJitterMs, 'reconnectJitterMs');
    this.initialReconnectDelayMs = positiveNumber(options.initialReconnectDelayMs, process.env.MARKET_DATA_INITIAL_RECONNECT_DELAY_MS, initialReconnectDelayMs, 'initialReconnectDelayMs');
    this.maximumReconnectDelayMs = positiveNumber(options.maximumReconnectDelayMs, process.env.MARKET_DATA_MAX_RECONNECT_DELAY_MS, maximumReconnectDelayMs, 'maximumReconnectDelayMs');
    if (this.maximumReconnectDelayMs < this.initialReconnectDelayMs) throw new Error('maximumReconnectDelayMs must be greater than or equal to initialReconnectDelayMs.');
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.registerClientListeners();
  }

  async connect(): Promise<void> {
    return this.connectInternal(false);
  }

  private async connectInternal(ownedReconnectAttempt: boolean): Promise<void> {
    const invocationToken = this.reconnectToken;
    if (this.isCircuitOpenOrFaulted()) throw new Error('Market data reconnect circuit is OPEN. Restart the runtime to retry.');
    if (this.isConnected()) return;
    while (this.connectPromise) {
      const pending = this.connectPromise;
      if (!this.manuallyDisconnected && this.connectAttemptToken === this.reconnectToken) return pending;
      await pending.catch(() => undefined);
    }
    if (this.isCircuitOpenOrFaulted()) {
      if (ownedReconnectAttempt) return;
      throw new Error('Market data reconnect circuit is OPEN. Restart the runtime to retry.');
    }
    if (this.isConnected()) return;
    if (ownedReconnectAttempt && (invocationToken !== this.reconnectToken || !this.reconnectEpisodeActive || this.state !== ConnectionState.RECONNECTING)) return;
    if (!ownedReconnectAttempt && this.state === ConnectionState.RECONNECTING && this.reconnectEpisodeActive) { logger.debug('Ignoring direct market data connect while an owned reconnect attempt is pending', { generationId:this.generationId }); return; }
    this.manuallyDisconnected = false;
    this.clearReconnectTimer();
    this.setState(this.reconnectAttempts > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);
    const attemptToken = this.reconnectToken;
    const attempt = this.client.connect().catch((error) => {
      if (!this.manuallyDisconnected && attemptToken === this.reconnectToken && this.breakerState === 'CLOSED') {
        const failureReason = error instanceof MarketDataWebSocketOpenTimeoutError ? error.code : 'CONNECT_ERROR';
        this.lastFailureReason = failureReason;
        logger.error('Market data WebSocket connection attempt failed', { error, generationId: this.generationId, reason: failureReason });
        if (this.reconnectEpisodeActive) this.scheduleReconnect(); else this.beginReconnect({ reason: failureReason });
      }
      throw error;
    }).finally(() => { if (this.connectPromise === attempt) { this.connectPromise = undefined; this.connectAttemptToken = undefined; } });
    this.connectPromise = attempt; this.connectAttemptToken = attemptToken;
    return attempt;
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.reconnectToken += 1; this.recoveryEpisodeToken += 1;
    this.clearReconnectTimer(); this.reconnectEpisodeActive = false; this.pendingRecoveryGenerationId = undefined;
    // An intentional disconnect (including EOD) never leaves physical-outage bookkeeping dangling,
    // regardless of breaker state -- no further beginReconnect()/scheduleReconnect() call can ever
    // reuse or need it once manuallyDisconnected is true.
    this.transportOutageStartedAt = undefined;
    if (this.breakerState === 'CLOSED') { this.clearRecoveryDeadline(); this.reconnectAttempts = 0; this.reconnectStartedAt = undefined; this.recoveryReason = undefined; this.lastFailureReason = undefined; }
    this.client.disconnect(); this.setState(ConnectionState.DISCONNECTED);
    logger.info('Market data WebSocket disconnected by request', { generationId: this.generationId });
  }

  /**
   * Called by the shared health monitor when an open socket has stopped producing usable data
   * (STALL/HEALTH_GRACE_EXPIRED), and also by the 'connectionError' listener below for a raw
   * transport error whose transport is NOT yet proven closed (see reconnectForTransportFailure()
   * for the case where it has been). The current socket is not yet proven physically unavailable
   * merely because a stall was detected or an unproven error event fired (the 'ws' client does not
   * clear its own socket reference on 'error', only on 'close') -- until the close this method
   * requests actually completes, the socket may still be physically open (mid closing-handshake,
   * or not yet acted on at all). beginReconnect() is therefore told to defer the physical-outage
   * anchor entirely; this method only INITIATES invalidation (client.disconnectForRecovery()'s
   * socket.close()) -- the anchor itself is set later, in registerClientListeners()'s 'disconnected'
   * handler, at the first point there is actual proof (the real close event) that the transport is
   * gone. This keeps downtime telemetry from including any interval where the socket was still
   * demonstrably usable.
   */
  reconnectForHealth(reason = 'STALL', expectedGenerationId = this.generationId): boolean {
    if (this.manuallyDisconnected || this.breakerState === 'OPEN' || this.reconnectEpisodeActive || this.state !== ConnectionState.CONNECTED || expectedGenerationId !== this.generationId) return false;
    this.recoveryReason = reason;
    const started = this.beginReconnect({ reason }, { deferPhysicalOutageStart: true });
    if (started) this.client.disconnectForRecovery();
    return started;
  }

  /**
   * Called only by the 'connectionError' listener below, for a raw CURRENT connectionError whose
   * client contract already proves the socket physically unusable (readyState CLOSED) at the
   * moment the error fired -- e.g. Node's global WebSocket implementation, which transitions
   * readyState to CLOSED before dispatching 'error', unlike a health stall on data that may still
   * be flowing over an otherwise-open socket. Unlike reconnectForHealth() above, there is nothing
   * left to invalidate (no disconnectForRecovery() call -- the transport is already tearing itself
   * down) and no reason to defer the physical-outage anchor, so beginReconnect() runs with its
   * default (immediate) physical anchoring. The close event that inevitably follows this same dead
   * socket still reaches registerClientListeners()'s 'disconnected' handler, but beginPhysicalOutage()
   * there is idempotent, so it cannot restart (or duplicate) the anchor this method already set.
   */
  private reconnectForTransportFailure(reason: string, expectedGenerationId = this.generationId): boolean {
    if (this.manuallyDisconnected || this.breakerState === 'OPEN' || this.reconnectEpisodeActive || this.state !== ConnectionState.CONNECTED || expectedGenerationId !== this.generationId) return false;
    this.recoveryReason = reason;
    return this.beginReconnect({ reason });
  }

  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generationId; }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot { return { state:this.breakerState, attempts:this.reconnectAttempts, lastFailureReason:this.lastFailureReason ?? null, activeGenerationId:this.generationId, pendingRecoveryGenerationId:this.pendingRecoveryGenerationId ?? null, reconnectEpisodeActive:this.reconnectEpisodeActive, nextRetryAtMs:this.nextRetryAtMs ?? null }; }
  /** Shared reconnect/breaker bookkeeping clear for both confirmRecoveryReady() and confirmTransportReady() -- purely mechanical, carries no observability semantics of its own. */
  private clearRecoveryBookkeeping(generationId: number): boolean {
    if (this.breakerState === 'OPEN' || this.state !== ConnectionState.CONNECTED || generationId !== this.generationId) return false;
    if (this.reconnectStartedAt !== undefined && this.now() - this.reconnectStartedAt >= this.maximumReconnectDurationMs) { this.openCircuit('RECONNECT_DURATION_EXHAUSTED'); return false; }
    this.recoveryEpisodeToken += 1; this.clearRecoveryDeadline();
    this.reconnectAttempts = 0; this.reconnectStartedAt = undefined; this.recoveryReason = undefined; this.lastFailureReason = undefined; this.pendingRecoveryGenerationId = undefined; this.nextRetryAtMs = undefined;
    return true;
  }
  confirmRecoveryReady(generationId: number): boolean {
    if (!this.clearRecoveryBookkeeping(generationId)) return false;
    const confirmationToken=this.reconnectToken;const details = this.getReconnectCircuitSnapshot();
    logger.info('MARKET_DATA_RECOVERY_CONFIRMED', details); try { this.emit('recoveryConfirmed', details); } catch(error) { logger.error('Market data recovery-confirmed listener failed', { error, generationId:this.generationId }); }
    return this.isCurrentConnectedGeneration(confirmationToken,generationId);
  }
  /**
   * Transport-only analogue of confirmRecoveryReady() for MarketDataHealthMonitorService's
   * post-source-completion bypass path (confirmPostSourceTransportReady()), where no
   * source-candle recovery/backfill ever happened. Clears the identical reconnect/breaker
   * bookkeeping so a benign post-source transport recovery is not left stuck mid-episode, but
   * deliberately never logs/emits MARKET_DATA_RECOVERY_CONFIRMED/'recoveryConfirmed' -- that
   * event means a genuine source recovery was confirmed, which is untrue here and would be
   * misleading observability. confirmRecoveryReady()'s own contract/emission is untouched.
   */
  confirmTransportReady(generationId: number): boolean {
    if (!this.clearRecoveryBookkeeping(generationId)) return false;
    const confirmationToken=this.reconnectToken;const details = this.getReconnectCircuitSnapshot();
    logger.info('MARKET_DATA_TRANSPORT_READY_CONFIRMED', details); try { this.emit('transportReadyConfirmed', details); } catch(error) { logger.error('Market data transport-ready-confirmed listener failed', { error, generationId:this.generationId }); }
    return this.isCurrentConnectedGeneration(confirmationToken,generationId);
  }
  failRecovery(generationId: number, reason = 'RECOVERY_FAILED'): boolean {
    if (this.breakerState === 'OPEN' || this.state !== ConnectionState.CONNECTED || generationId !== this.generationId || this.pendingRecoveryGenerationId !== generationId) return false;
    this.lastFailureReason = reason; this.openCircuit(reason); return true;
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void { if(this.breakerState==='OPEN'||this.state!==ConnectionState.CONNECTED)throw new Error('Market data connection is not available.');this.client.send(data); }

  private registerClientListeners(): void {
    this.client.on('connected', () => {
      if (this.manuallyDisconnected || this.breakerState === 'OPEN' || this.state === ConnectionState.FAULTED) { logger.warn('Ignoring stale market data socket-open callback', { generationId:this.generationId, breakerState:this.breakerState }); this.client.disconnect(); return; }
      if (this.state !== ConnectionState.CONNECTING && this.state !== ConnectionState.RECONNECTING) { logger.warn('Ignoring duplicate market data socket-open callback', { generationId:this.generationId, state:this.state }); return; }
      if (this.reconnectStartedAt !== undefined && this.now() - this.reconnectStartedAt >= this.maximumReconnectDurationMs) { this.openCircuit('RECONNECT_DURATION_EXHAUSTED'); this.client.disconnect(); return; }
      const wasReconnecting = this.state === ConnectionState.RECONNECTING || this.reconnectAttempts > 0 || this.reconnectEpisodeActive;
      this.generationId += 1;
      this.reconnectToken += 1; this.clearReconnectTimer(); this.reconnectEpisodeActive = false; this.nextRetryAtMs = undefined;
      const connectedToken=this.reconnectToken;
      // PHYSICAL downtime only -- see transportOutageStartedAt's own doc. The socket opening ends
      // the current physical outage unconditionally, regardless of whether strategy-safe logical
      // readiness (reconnectStartedAt, untouched here) has been confirmed.
      const downtimeMs = this.transportOutageStartedAt === undefined ? 0 : this.now() - this.transportOutageStartedAt;
      this.transportOutageStartedAt = undefined;
      this.pendingRecoveryGenerationId = wasReconnecting ? this.generationId : undefined;
      this.setState(ConnectionState.CONNECTED);
      const details: ConnectionEventDetails = { generationId: this.generationId, downtimeMs, reason: this.recoveryReason };
      try { this.emit('connected', details); } catch(error) { logger.error('Market data connected listener failed', { error, generationId:this.generationId }); }
      if(!this.isCurrentConnectedGeneration(connectedToken,details.generationId))return;
      if (wasReconnecting) {
        recordMarketReplayEvent('RECONNECT', {
          instrumentKey: null,
          sourceTimestamp: null,
          receivedTimestamp: new Date().toISOString(),
          sequenceNumber: null,
          connectionGenerationId: this.generationId,
          payload: details as unknown as Record<string, unknown>,
        });
        logger.info('MARKET_DATA_RECONNECTED', details);
        try { this.emit('reconnected', details); } catch(error) { logger.error('Market data reconnected listener failed', { error, generationId:this.generationId }); }
      }
    });
    this.client.on('message', (message: Buffer) => { if(this.breakerState==='CLOSED'&&this.state===ConnectionState.CONNECTED)this.emit('message', message, { generationId: this.generationId }); });
    this.client.on('disconnected', (event: { code?: number; reason?: string; intentional?: boolean; wasClean?: boolean } | undefined, isCurrentSocket = true) => {
      if (!isCurrentSocket || this.manuallyDisconnected || event?.intentional) return;
      if (this.reconnectEpisodeActive) {
        // This close COMPLETES an already-declared episode -- typically a health-driven recovery
        // (reconnectForHealth()) whose disconnectForRecovery() call already initiated this exact
        // close but deliberately deferred anchoring the physical-outage clock until now.
        // beginReconnect() would just return false here (an episode is already active); anchor the
        // physical clock directly instead -- this IS the first point with actual proof (the real
        // close event) that the transport is gone. beginPhysicalOutage() is idempotent, so a
        // duplicate/secondary close signal for the same outage cannot restart it.
        this.beginPhysicalOutage();
        return;
      }
      this.beginReconnect({ code: event?.code, reason: event?.reason, disconnectClean: event?.wasClean });
    });
    this.client.on('connectionError', (error, transportClosed?: boolean) => {
      if (this.manuallyDisconnected) return;
      logger.error('Market data WebSocket emitted a connection error', { error, generationId: this.generationId, transportClosed });
      if (this.state !== ConnectionState.CONNECTED) return;
      // transportClosed proves (per the client's own readyState contract) that the CURRENT socket
      // is already unusable right now -- see reconnectForTransportFailure()'s own doc for why that
      // case must anchor physical downtime immediately rather than deferring to reconnectForHealth().
      if (transportClosed) this.reconnectForTransportFailure('CONNECTION_ERROR', this.generationId);
      else this.reconnectForHealth('CONNECTION_ERROR', this.generationId);
    });
  }

  private scheduleReconnect(token = this.reconnectToken, options: BeginReconnectOptions = {}): void {
    if (token !== this.reconnectToken || this.manuallyDisconnected || this.breakerState === 'OPEN' || this.reconnectTimer !== undefined || this.state === ConnectionState.CONNECTED || this.state === ConnectionState.FAULTED) return;
    if (this.reconnectStartedAt === undefined) { this.reconnectStartedAt=this.now(); this.recoveryEpisodeToken+=1; this.scheduleRecoveryDeadline(this.recoveryEpisodeToken); }
    // Independent physical-outage guard -- see transportOutageStartedAt's own doc. Deliberately
    // separate from the logical guard above: a bare reconnect that already cleared the physical
    // anchor (a prior outage within this same still-unresolved logical episode) must still get a
    // fresh physical anchor for THIS outage's own downtime telemetry. Skipped when the caller
    // (reconnectForHealth(), via beginReconnect()'s own synchronous tail call into this method)
    // has explicitly deferred it to set at the real invalidation point instead -- without this
    // skip, this fallback would otherwise anchor it right back at the too-early moment the defer
    // exists to avoid.
    if (!options.deferPhysicalOutageStart) this.beginPhysicalOutage();
    const elapsedMs = this.now() - this.reconnectStartedAt;
    if (this.reconnectAttempts >= this.maximumReconnectAttempts || elapsedMs >= this.maximumReconnectDurationMs) {
      this.openCircuit(this.recoveryReason ?? this.lastFailureReason ?? 'RECONNECT_EXHAUSTED'); return;
    }
    const baseDelayMs = Math.min(this.initialReconnectDelayMs * 2 ** this.reconnectAttempts, this.maximumReconnectDelayMs);
    const jitterMs = Math.floor(Math.min(1, Math.max(0, this.random())) * this.reconnectJitterMs);
    const effectiveDelayMs = Math.min(baseDelayMs + jitterMs, this.maximumReconnectDurationMs - elapsedMs);
    this.reconnectAttempts += 1; this.setState(ConnectionState.RECONNECTING);
    this.nextRetryAtMs = this.now() + effectiveDelayMs;
    const details: ConnectionEventDetails = { generationId: this.generationId, attempt:this.reconnectAttempts, attempts:this.reconnectAttempts, reason:this.recoveryReason, baseDelayMs, jitterMs, effectiveDelayMs, breakerState:this.breakerState, lastFailureReason:this.lastFailureReason, nextRetryAtMs:this.nextRetryAtMs };
    logger.info('MARKET_DATA_RECONNECT_ATTEMPT', details);
    try { this.emit('reconnectAttempt', details); } catch(error) { logger.error('Market data reconnect-attempt listener failed', { error, generationId:this.generationId }); }
    if (!this.isOwnedReconnectSchedule(token)) return;
    const expectedGenerationId = this.generationId;
    const ownership: ReconnectTimerOwnership = { handle:undefined, token, generationId:expectedGenerationId };
    ownership.handle = this.scheduler.setTimeout(() => {
      if (this.reconnectTimer !== ownership) return;
      this.reconnectTimer = undefined;
      if (ownership.token !== this.reconnectToken || ownership.generationId !== this.generationId || this.manuallyDisconnected || this.breakerState === 'OPEN' || !this.reconnectEpisodeActive || this.state !== ConnectionState.RECONNECTING) return;
      this.nextRetryAtMs = undefined;
      if (this.reconnectStartedAt !== undefined && this.now() - this.reconnectStartedAt >= this.maximumReconnectDurationMs) { this.openCircuit('RECONNECT_DURATION_EXHAUSTED'); return; }
      this.connectInternal(true).catch((error) => logger.error('Scheduled market data WebSocket reconnection failed', { error, generationId: this.generationId }));
    }, effectiveDelayMs);
    this.reconnectTimer = ownership;
  }

  private beginReconnect(details: Partial<ConnectionEventDetails> = {}, options: BeginReconnectOptions = {}): boolean {
    if (this.manuallyDisconnected || this.breakerState === 'OPEN' || this.reconnectEpisodeActive) return false;
    this.reconnectEpisodeActive = true;
    if (this.reconnectStartedAt === undefined) { this.reconnectStartedAt=this.now(); this.recoveryEpisodeToken+=1; this.scheduleRecoveryDeadline(this.recoveryEpisodeToken); }
    // Independent physical-outage guard -- see transportOutageStartedAt's own doc. A genuine new
    // disconnect (this method called directly for an already-realized transport loss) always gets
    // its own fresh physical anchor even when the logical anchor above is left untouched because
    // an earlier, still-unresolved recovery episode is already active. Skipped when the caller
    // (reconnectForHealth()) passes deferPhysicalOutageStart: the current socket is not yet proven
    // physically unavailable at this point -- that caller anchors it itself at the real
    // invalidation call instead.
    if (!options.deferPhysicalOutageStart) this.beginPhysicalOutage();
    this.reconnectToken += 1; const reconnectToken=this.reconnectToken;
    const failureReason = details.reason?.trim() || (details.code === undefined ? undefined : `SOCKET_${details.code}`) || this.lastFailureReason || 'DISCONNECTED';
    this.recoveryReason = failureReason; this.lastFailureReason = failureReason; this.pendingRecoveryGenerationId = undefined;
    const event: ConnectionEventDetails = { generationId: this.generationId, ...details };
    logger.warn('MARKET_DATA_DEGRADED', event);
    try { this.emit('unexpectedDisconnect', event); } catch(error) { logger.error('Market data unexpected-disconnect listener failed', { error, generationId:this.generationId }); }
    recordMarketReplayEvent('DISCONNECT', {
      instrumentKey: null,
      sourceTimestamp: null,
      receivedTimestamp: new Date().toISOString(),
      sequenceNumber: null,
      connectionGenerationId: this.generationId,
      payload: event as unknown as Record<string, unknown>,
    });
    if (!this.canContinueReconnectEpisode(reconnectToken)) return false;
    this.setState(ConnectionState.RECONNECTING); this.scheduleReconnect(reconnectToken, options); return this.canContinueReconnectEpisode(reconnectToken);
  }
  /** Sets the physical-outage anchor exactly once per outage -- see transportOutageStartedAt's own doc for who calls this and when. */
  private beginPhysicalOutage(): void { if (this.transportOutageStartedAt === undefined) this.transportOutageStartedAt = this.now(); }
  private openCircuit(reason: string): void {
    if (this.breakerState === 'OPEN') return;
    this.breakerState = 'OPEN'; this.lastFailureReason = reason; this.reconnectToken += 1; this.recoveryEpisodeToken += 1; this.clearReconnectTimer(); this.clearRecoveryDeadline(); this.reconnectEpisodeActive = false; this.pendingRecoveryGenerationId = undefined; this.nextRetryAtMs = undefined; this.transportOutageStartedAt = undefined;
    this.setState(ConnectionState.FAULTED);
    const downtimeMs = this.reconnectStartedAt === undefined ? 0 : Math.max(0, this.now() - this.reconnectStartedAt);
    const details: ConnectionEventDetails = { generationId:this.generationId, attempt:this.reconnectAttempts, attempts:this.reconnectAttempts, downtimeMs, reason, breakerState:this.breakerState, lastFailureReason:reason };
    logger.error('MARKET_DATA_RECOVERY_FAILED', details);
    try { this.emit('reconnectFailed', details); } catch(error) { logger.error('Market data reconnect-failed listener failed', { error, generationId:this.generationId }); }
    try { this.emit('breakerOpened', details); } catch(error) { logger.error('Market data breaker-opened listener failed', { error, generationId:this.generationId }); }
    this.client.disconnect();
  }
  private scheduleRecoveryDeadline(episodeToken: number): void {
    if(this.recoveryDeadlineTimer!==undefined||this.reconnectStartedAt===undefined)return;
    const delayMs=Math.max(0,this.maximumReconnectDurationMs-(this.now()-this.reconnectStartedAt));const ownership:RecoveryDeadlineOwnership={handle:undefined,episodeToken};
    ownership.handle=this.scheduler.setTimeout(()=>{if(this.recoveryDeadlineTimer!==ownership)return;if(ownership.episodeToken!==this.recoveryEpisodeToken||this.manuallyDisconnected||this.breakerState==='OPEN'||this.reconnectStartedAt===undefined)return;const remaining=this.maximumReconnectDurationMs-(this.now()-this.reconnectStartedAt);if(remaining>0){this.recoveryDeadlineTimer=undefined;this.scheduleRecoveryDeadline(episodeToken);return;}this.recoveryDeadlineTimer=undefined;this.openCircuit('RECONNECT_DURATION_EXHAUSTED');},delayMs);this.recoveryDeadlineTimer=ownership;
  }
  private clearReconnectTimer(): void { if (this.reconnectTimer !== undefined) { this.scheduler.clearTimeout(this.reconnectTimer.handle); this.reconnectTimer = undefined; } this.nextRetryAtMs = undefined; }
  private clearRecoveryDeadline():void{if(this.recoveryDeadlineTimer!==undefined){this.scheduler.clearTimeout(this.recoveryDeadlineTimer.handle);this.recoveryDeadlineTimer=undefined;}}
  private canContinueReconnectEpisode(token:number):boolean{return token===this.reconnectToken&&!this.manuallyDisconnected&&this.breakerState==='CLOSED'&&this.reconnectEpisodeActive;}
  private isOwnedReconnectSchedule(token:number):boolean{return this.canContinueReconnectEpisode(token)&&this.state===ConnectionState.RECONNECTING;}
  private isCurrentConnectedGeneration(token:number,generationId:number):boolean{return token===this.reconnectToken&&this.breakerState==='CLOSED'&&this.state===ConnectionState.CONNECTED&&generationId===this.generationId;}
  private isCircuitOpenOrFaulted():boolean{return this.breakerState==='OPEN'||this.state===ConnectionState.FAULTED;}
  private isConnected():boolean{return this.state===ConnectionState.CONNECTED;}
  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    const previousState = this.state; this.state = state;
    logger.info('Market data WebSocket connection state changed', { previousState, state, generationId: this.generationId });
    recordMarketReplayEvent('CONNECTION_STATE', {
      instrumentKey: null,
      sourceTimestamp: null,
      receivedTimestamp: new Date().toISOString(),
      sequenceNumber: null,
      connectionGenerationId: this.generationId,
      payload: { previousState, state },
    });
    try { this.emit('stateChanged', { previousState, state, generationId: this.generationId }); } catch(error) { logger.error('Market data connection-state listener failed', { error, generationId:this.generationId, state }); }
  }
}

function configured(optionValue: number | undefined, environmentValue: string | undefined, fallback: number): number { return optionValue ?? (environmentValue === undefined ? fallback : Number(environmentValue)); }
function positiveInteger(optionValue: number | undefined, environmentValue: string | undefined, fallback: number, name: string): number { const value=configured(optionValue,environmentValue,fallback); if(!Number.isInteger(value)||value<=0)throw new Error(`${name} must be a positive integer.`); return value; }
function positiveNumber(optionValue: number | undefined, environmentValue: string | undefined, fallback: number, name: string): number { const value=configured(optionValue,environmentValue,fallback); if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be a positive finite number.`); return value; }
function nonNegativeNumber(optionValue: number | undefined, environmentValue: string | undefined, fallback: number, name: string): number { const value=configured(optionValue,environmentValue,fallback); if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be a non-negative finite number.`); return value; }
