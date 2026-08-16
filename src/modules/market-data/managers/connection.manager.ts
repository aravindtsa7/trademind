import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import MarketDataWebSocketClient from '../client/websocket.client';

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;
const defaultMaximumReconnectAttempts = 6;
const defaultMaximumReconnectDurationMs = 60_000;
const defaultReconnectJitterMs = 250;

export interface ConnectionManagerOptions {
  maximumReconnectAttempts?: number;
  maximumReconnectDurationMs?: number;
  reconnectJitterMs?: number;
  random?: () => number;
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
  reason?: string;
  code?: number;
  disconnectClean?: boolean;
  downtimeMs?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  effectiveDelayMs?: number;
}

/**
 * The sole owner of socket reconnect episodes.  Runtime-specific code may
 * observe its events but must never schedule its own reconnect timer.
 */
export default class ConnectionManager extends EventEmitter {
  private client: MarketDataWebSocketClient;
  private state = ConnectionState.DISCONNECTED;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private connectPromise?: Promise<void>;
  private manuallyDisconnected = false;
  private reconnectStartedAt?: number;
  private reconnectEpisodeActive = false;
  private generationId = 0;
  private recoveryReason?: string;
  private readonly maximumReconnectAttempts: number;
  private readonly maximumReconnectDurationMs: number;
  private readonly reconnectJitterMs: number;
  private readonly random: () => number;

  constructor(accessToken: string, client = new MarketDataWebSocketClient(accessToken), options: ConnectionManagerOptions = {}) {
    super();
    this.client = client;
    this.maximumReconnectAttempts = options.maximumReconnectAttempts ?? Number(process.env.MARKET_DATA_MAX_RECONNECT_ATTEMPTS ?? defaultMaximumReconnectAttempts);
    this.maximumReconnectDurationMs = options.maximumReconnectDurationMs ?? Number(process.env.MARKET_DATA_MAX_RECONNECT_DURATION_MS ?? defaultMaximumReconnectDurationMs);
    this.reconnectJitterMs = options.reconnectJitterMs ?? Number(process.env.MARKET_DATA_RECONNECT_JITTER_MS ?? defaultReconnectJitterMs);
    this.random = options.random ?? Math.random;
    this.registerClientListeners();
  }

  async connect(): Promise<void> {
    this.manuallyDisconnected = false;
    if (this.state === ConnectionState.CONNECTED) return;
    if (this.connectPromise) return this.connectPromise;
    this.clearReconnectTimer();
    this.setState(this.reconnectAttempts > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);
    this.connectPromise = this.client.connect().catch((error) => {
      if (!this.manuallyDisconnected) {
        logger.error('Market data WebSocket connection attempt failed', { error, generationId: this.generationId });
        if (this.reconnectEpisodeActive) this.scheduleReconnect(); else this.beginReconnect({ reason: 'CONNECT_ERROR' });
      }
      throw error;
    }).finally(() => { this.connectPromise = undefined; });
    return this.connectPromise;
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.clearReconnectTimer(); this.reconnectAttempts = 0; this.reconnectEpisodeActive = false; this.recoveryReason = undefined;
    this.client.disconnect(); this.setState(ConnectionState.DISCONNECTED);
    logger.info('Market data WebSocket disconnected by request', { generationId: this.generationId });
  }

  /** Called by the shared health monitor when an open socket has stopped producing usable data. */
  reconnectForHealth(reason = 'STALL'): void {
    if (this.manuallyDisconnected || this.reconnectEpisodeActive || this.state !== ConnectionState.CONNECTED) return;
    this.recoveryReason = reason;
    this.beginReconnect({ reason });
    this.client.disconnectForRecovery();
  }

  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generationId; }
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.client.send(data); }

  private registerClientListeners(): void {
    this.client.on('connected', () => {
      const wasReconnecting = this.state === ConnectionState.RECONNECTING || this.reconnectAttempts > 0 || this.reconnectEpisodeActive;
      this.generationId += 1;
      this.clearReconnectTimer(); this.reconnectAttempts = 0; this.reconnectEpisodeActive = false;
      const downtimeMs = this.reconnectStartedAt === undefined ? 0 : Date.now() - this.reconnectStartedAt;
      this.reconnectStartedAt = undefined;
      this.setState(ConnectionState.CONNECTED);
      const details: ConnectionEventDetails = { generationId: this.generationId, downtimeMs, reason: this.recoveryReason };
      this.emit('connected', details);
      if (wasReconnecting) {
        logger.info('MARKET_DATA_RECONNECTED', details);
        this.emit('reconnected', details);
      }
      this.recoveryReason = undefined;
    });
    this.client.on('message', (message: Buffer) => this.emit('message', message, { generationId: this.generationId }));
    this.client.on('disconnected', (event: { code?: number; reason?: string; intentional?: boolean; wasClean?: boolean } | undefined, isCurrentSocket = true) => {
      if (!isCurrentSocket || this.manuallyDisconnected || event?.intentional) return;
      this.beginReconnect({ code: event?.code, reason: event?.reason, disconnectClean: event?.wasClean });
    });
    this.client.on('connectionError', (error) => {
      if (this.manuallyDisconnected) return;
      logger.error('Market data WebSocket emitted a connection error', { error, generationId: this.generationId });
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyDisconnected || this.reconnectTimer || this.state === ConnectionState.CONNECTED || this.state === ConnectionState.FAULTED) return;
    this.reconnectStartedAt ??= Date.now();
    const elapsedMs = Date.now() - this.reconnectStartedAt;
    if (this.reconnectAttempts >= this.maximumReconnectAttempts || elapsedMs >= this.maximumReconnectDurationMs) {
      this.setState(ConnectionState.FAULTED);
      const details: ConnectionEventDetails = { generationId: this.generationId, attempt: this.reconnectAttempts, downtimeMs: elapsedMs, reason: this.recoveryReason };
      logger.error('MARKET_DATA_RECOVERY_FAILED', details); this.emit('reconnectFailed', details); return;
    }
    const baseDelayMs = Math.min(initialReconnectDelayMs * 2 ** this.reconnectAttempts, maximumReconnectDelayMs);
    const jitterMs = Math.floor(Math.max(0, this.random()) * Math.max(0, this.reconnectJitterMs));
    const effectiveDelayMs = baseDelayMs + jitterMs;
    this.reconnectAttempts += 1; this.setState(ConnectionState.RECONNECTING);
    const details: ConnectionEventDetails = { generationId: this.generationId, attempt: this.reconnectAttempts, reason: this.recoveryReason, baseDelayMs, jitterMs, effectiveDelayMs };
    logger.info('MARKET_DATA_RECONNECT_ATTEMPT', details); this.emit('reconnectAttempt', details);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => logger.error('Scheduled market data WebSocket reconnection failed', { error, generationId: this.generationId }));
    }, effectiveDelayMs);
  }

  private beginReconnect(details: Partial<ConnectionEventDetails> = {}): void {
    if (this.manuallyDisconnected || this.reconnectEpisodeActive) return;
    this.reconnectEpisodeActive = true; this.reconnectStartedAt ??= Date.now();
    const event: ConnectionEventDetails = { generationId: this.generationId, ...details };
    logger.warn('MARKET_DATA_DEGRADED', event); this.emit('unexpectedDisconnect', event);
    this.setState(ConnectionState.RECONNECTING); this.scheduleReconnect();
  }
  private clearReconnectTimer(): void { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; } }
  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    const previousState = this.state; this.state = state;
    logger.info('Market data WebSocket connection state changed', { previousState, state, generationId: this.generationId });
    this.emit('stateChanged', { previousState, state, generationId: this.generationId });
  }
}
