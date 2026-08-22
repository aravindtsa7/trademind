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
  onStall?: (snapshot: MarketDataHealthSnapshot) => void;
  onHealthy?: (snapshot: MarketDataHealthSnapshot) => void;
}

/** Detects a dead-but-open transport. It deliberately does not infer market data. */
export default class MarketDataHealthMonitorService extends EventEmitter {
  private readonly stallMs: number;
  private readonly heartbeatCheckMs: number;
  private readonly generationGraceMs: number;
  private readonly now: () => number;
  private readonly isMarketSession: (value: Date) => boolean;
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
  private stalledGeneration?: number;
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
    this.healthState = 'HEALTHY'; this.generationActivatedAt = undefined; this.stalledGeneration = undefined;
    const snapshot=this.getSnapshot(); this.emit('healthy',snapshot); this.options.onHealthy?.(snapshot); return true;
  }
  isHealthy(): boolean { return this.healthState === 'HEALTHY' && this.connection.getState() === ConnectionState.CONNECTED; }
  checkNow(): void { this.check(); }
  getSnapshot(): MarketDataHealthSnapshot {
    const now = this.now(); const age = (value?: number) => value === undefined ? null : Math.max(0, now - value); const circuit=this.connection.getReconnectCircuitSnapshot();
    const insideGrace = this.healthState === 'GRACE' && this.connection.getState() === ConnectionState.CONNECTED && this.generationActivatedAt !== undefined && now-this.generationActivatedAt < this.generationGraceMs;
    return { generationId:this.generationId, state:this.connection.getState(), healthState:this.healthState, insideGrace, graceRemainingMs:this.healthState==='GRACE'&&this.generationActivatedAt!==undefined?Math.max(0,this.generationGraceMs-(now-this.generationActivatedAt)):null, lastRawMessageAgeMs:age(this.lastRawMessageAt), lastValidMarketEventAgeMs:age(this.lastValidMarketEventAt), lastNiftyTickAgeMs:age(this.lastNiftyTickAt), lastNiftySourceAdvanceAgeMs:age(this.lastNiftySourceAdvanceAt), reconnectCount:this.reconnectCount, reconnectAttemptCount:circuit.attempts, breakerState:circuit.state, lastFailureReason:circuit.lastFailureReason, nextRetryAtMs:circuit.nextRetryAtMs };
  }
  private activateGeneration(generationId: number): void {
    this.generationId=generationId; this.stalledGeneration=undefined; this.healthState='GRACE'; this.lastRawMessageAt=undefined; this.lastValidMarketEventAt=undefined; this.lastNiftyTickAt=undefined; this.lastAcceptedNiftySourceTimestampMs=undefined; this.lastNiftySourceAdvanceAt=undefined;
    const now=this.now(); this.generationActivatedAt=this.isMarketSession(new Date(now))?now:undefined;
    if(this.generationActivatedAt!==undefined)this.emit('graceStarted',this.getSnapshot());
  }
  private noteRawMessage(generationId: number): void { if (generationId !== this.generationId) return; this.lastRawMessageAt = this.now(); }
  private check(): void {
    if (!this.isMarketSession(new Date(this.now())) || this.connection.getState() !== ConnectionState.CONNECTED) return;
    if (this.healthState === 'GRACE' && this.generationActivatedAt === undefined) { this.generationActivatedAt=this.now(); this.emit('graceStarted',this.getSnapshot()); return; }
    if (this.healthState === 'GRACE' && this.generationActivatedAt !== undefined && this.now()-this.generationActivatedAt < this.generationGraceMs) return;
    const snapshot = this.getSnapshot(); const referenceAge = Math.max(snapshot.lastRawMessageAgeMs ?? Infinity, snapshot.lastValidMarketEventAgeMs ?? Infinity, snapshot.lastNiftyTickAgeMs ?? Infinity);
    if (this.stalledGeneration === snapshot.generationId) return;
    // Packets can keep arriving (referenceAge healthy) while the accepted NIFTY
    // sourceTimestamp itself stops advancing; a receive-time-only view would
    // report that as healthy forever. lastNiftySourceAdvanceAgeMs is only
    // defined once a source-carrying NIFTY tick has actually been accepted for
    // this generation, so a feed that never supplies source timestamps -- or
    // one that briefly repeats the same source timestamp within the stall
    // threshold -- stays exempt from this check.
    const sourceStalled = snapshot.lastNiftySourceAdvanceAgeMs !== null && snapshot.lastNiftySourceAdvanceAgeMs > this.stallMs;
    if (snapshot.healthState !== 'GRACE' && referenceAge <= this.stallMs && !sourceStalled) return;
    this.healthState='UNHEALTHY'; this.stalledGeneration=snapshot.generationId; const reason=snapshot.healthState==='GRACE'?'HEALTH_GRACE_EXPIRED':(referenceAge>this.stallMs?'STALL':'SOURCE_STALL'); const unhealthy=this.getSnapshot(); this.emit('stalled',unhealthy); this.options.onStall?.(unhealthy); this.connection.reconnectForHealth(reason,snapshot.generationId);
  }
}
