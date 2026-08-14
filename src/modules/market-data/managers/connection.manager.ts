import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import MarketDataWebSocketClient from '../client/websocket.client';

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;
const defaultMaximumReconnectAttempts = 6;
const defaultMaximumReconnectDurationMs = 60_000;

export interface ConnectionManagerOptions {
  maximumReconnectAttempts?: number;
  maximumReconnectDurationMs?: number;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
}

export default class ConnectionManager extends EventEmitter {
  private client: MarketDataWebSocketClient;
  private state = ConnectionState.DISCONNECTED;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private connectPromise?: Promise<void>;
  private manuallyDisconnected = false;
  private reconnectStartedAt?: number;
  private reconnectEpisodeActive = false;
  private readonly maximumReconnectAttempts: number;
  private readonly maximumReconnectDurationMs: number;

  constructor(accessToken: string, client = new MarketDataWebSocketClient(accessToken), options: ConnectionManagerOptions = {}) {
    super();
    this.client = client;
    this.maximumReconnectAttempts = options.maximumReconnectAttempts ?? defaultMaximumReconnectAttempts;
    this.maximumReconnectDurationMs = options.maximumReconnectDurationMs ?? defaultMaximumReconnectDurationMs;
    this.registerClientListeners();
  }

  async connect(): Promise<void> {
    this.manuallyDisconnected = false;

    if (this.state === ConnectionState.CONNECTED) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.clearReconnectTimer();
    this.setState(
      this.reconnectAttempts > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING
    );

    this.connectPromise = this.client
      .connect()
      .catch((error) => {
        if (!this.manuallyDisconnected) {
          logger.error('Market data WebSocket connection attempt failed', { error });
          if (this.reconnectEpisodeActive) this.scheduleReconnect();
          else this.beginReconnect();
        }
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });

    return this.connectPromise;
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.reconnectEpisodeActive = false;
    this.client.disconnect();
    this.setState(ConnectionState.DISCONNECTED);

    logger.info('Market data WebSocket disconnected by request');
  }

  getState(): ConnectionState {
    return this.state;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.client.send(data);
  }

  private registerClientListeners(): void {
    this.client.on('connected', () => {
      const wasReconnecting = this.state === ConnectionState.RECONNECTING || this.reconnectAttempts > 0;
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;
      this.reconnectEpisodeActive = false;
      const downtimeMs = this.reconnectStartedAt === undefined ? 0 : Date.now() - this.reconnectStartedAt;
      this.reconnectStartedAt = undefined;
      this.setState(ConnectionState.CONNECTED);
      if (wasReconnecting) {
        logger.info('Market data WebSocket reconnected', { downtimeMs });
        this.emit('reconnected', { downtimeMs });
      }
    });

    this.client.on('disconnected', (event: { code?: number; reason?: string; intentional?: boolean } | undefined, isCurrentSocket = true) => {
      if (!isCurrentSocket) return;
      if (this.manuallyDisconnected || event?.intentional) {
        return;
      }
      this.beginReconnect(event);
    });

    this.client.on('connectionError', (error) => {
      if (this.manuallyDisconnected) return;
      logger.error('Market data WebSocket emitted a connection error', { error });
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyDisconnected || this.reconnectTimer || this.state === ConnectionState.CONNECTED) {
      return;
    }

    this.reconnectStartedAt ??= Date.now();
    const elapsedMs = Date.now() - this.reconnectStartedAt;
    if (this.reconnectAttempts >= this.maximumReconnectAttempts || elapsedMs >= this.maximumReconnectDurationMs) {
      this.setState(ConnectionState.DISCONNECTED);
      logger.error('Market data WebSocket reconnect failed closed', { attempts: this.reconnectAttempts, downtimeMs: elapsedMs });
      this.emit('reconnectFailed', { attempts: this.reconnectAttempts, downtimeMs: elapsedMs });
      return;
    }

    const delayMs = Math.min(
      initialReconnectDelayMs * 2 ** this.reconnectAttempts,
      maximumReconnectDelayMs
    );
    this.reconnectAttempts += 1;
    this.setState(ConnectionState.RECONNECTING);

    logger.info('Scheduling market data WebSocket reconnection', {
      attempt: this.reconnectAttempts,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        logger.error('Scheduled market data WebSocket reconnection failed', { error });
      });
    }, delayMs);
  }

  private beginReconnect(details?: { code?: number; reason?: string }): void {
    if (this.manuallyDisconnected || this.reconnectEpisodeActive) return;
    this.reconnectEpisodeActive = true;
    this.reconnectStartedAt ??= Date.now();
    logger.warn('Market data WebSocket disconnected unexpectedly', { code: details?.code, reason: details?.reason });
    this.emit('unexpectedDisconnect', { code: details?.code, reason: details?.reason });
    this.setState(ConnectionState.RECONNECTING);
    this.scheduleReconnect();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }

    const previousState = this.state;
    this.state = state;

    logger.info('Market data WebSocket connection state changed', {
      previousState,
      state,
    });
    this.emit('stateChanged', { previousState, state });
  }
}
