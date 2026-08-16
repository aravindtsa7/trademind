import { EventEmitter } from 'events';
import ConnectionManager, { ConnectionState } from '../managers/connection.manager';
import { isWithinIstMarketSession } from './ist-market-session-eod.service';

export interface MarketDataHealthSnapshot {
  [key: string]: string | number | null;
  generationId: number;
  state: ConnectionState;
  lastRawMessageAgeMs: number | null;
  lastValidMarketEventAgeMs: number | null;
  lastNiftyTickAgeMs: number | null;
  reconnectCount: number;
}

export interface MarketDataHealthMonitorOptions {
  stallMs?: number;
  heartbeatCheckMs?: number;
  now?: () => number;
  isMarketSession?: (value: Date) => boolean;
  onStall?: (snapshot: MarketDataHealthSnapshot) => void;
}

/** Detects a dead-but-open transport. It deliberately does not infer market data. */
export default class MarketDataHealthMonitorService extends EventEmitter {
  private readonly stallMs: number;
  private readonly heartbeatCheckMs: number;
  private readonly now: () => number;
  private readonly isMarketSession: (value: Date) => boolean;
  private timer?: NodeJS.Timeout;
  private generationId = 0;
  private lastRawMessageAt?: number;
  private lastValidMarketEventAt?: number;
  private lastNiftyTickAt?: number;
  private reconnectCount = 0;
  private stalledGeneration?: number;

  constructor(private readonly connection: ConnectionManager, private readonly options: MarketDataHealthMonitorOptions = {}) {
    super();
    this.stallMs = options.stallMs ?? Number(process.env.MARKET_DATA_STALL_MS ?? 45_000);
    this.heartbeatCheckMs = options.heartbeatCheckMs ?? Number(process.env.MARKET_DATA_HEARTBEAT_CHECK_MS ?? 5_000);
    this.now = options.now ?? Date.now;
    this.isMarketSession = options.isMarketSession ?? isWithinIstMarketSession;
    connection.on('connected', (details: { generationId: number }) => this.activateGeneration(details.generationId));
    connection.on('reconnected', () => { this.reconnectCount += 1; });
    connection.on('message', (_message: Buffer, details: { generationId: number }) => this.noteRawMessage(details.generationId));
  }

  start(): void { if (this.timer) return; this.timer = setInterval(() => this.check(), this.heartbeatCheckMs); this.timer.unref(); }
  stop(): void { if (!this.timer) return; clearInterval(this.timer); this.timer = undefined; }
  noteValidMarketEvent(generationId: number): void { if (generationId !== this.generationId) return; this.lastValidMarketEventAt = this.now(); }
  noteNiftyTick(generationId: number): void { if (generationId !== this.generationId) return; this.lastNiftyTickAt = this.now(); }
  getSnapshot(): MarketDataHealthSnapshot {
    const now = this.now(); const age = (value?: number) => value === undefined ? null : Math.max(0, now - value);
    return { generationId: this.generationId, state: this.connection.getState(), lastRawMessageAgeMs: age(this.lastRawMessageAt), lastValidMarketEventAgeMs: age(this.lastValidMarketEventAt), lastNiftyTickAgeMs: age(this.lastNiftyTickAt), reconnectCount: this.reconnectCount };
  }
  private activateGeneration(generationId: number): void { this.generationId = generationId; this.stalledGeneration = undefined; const now = this.now(); this.lastRawMessageAt = now; this.lastValidMarketEventAt = undefined; this.lastNiftyTickAt = undefined; }
  private noteRawMessage(generationId: number): void { if (generationId !== this.generationId) return; this.lastRawMessageAt = this.now(); }
  private check(): void {
    if (!this.isMarketSession(new Date(this.now())) || this.connection.getState() !== ConnectionState.CONNECTED) return;
    const snapshot = this.getSnapshot(); const referenceAge = Math.max(snapshot.lastRawMessageAgeMs ?? Infinity, snapshot.lastValidMarketEventAgeMs ?? Infinity);
    if (referenceAge <= this.stallMs || this.stalledGeneration === snapshot.generationId) return;
    this.stalledGeneration = snapshot.generationId; this.emit('stalled', snapshot); this.options.onStall?.(snapshot); this.connection.reconnectForHealth('STALL');
  }
}
