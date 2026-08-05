import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import MarketDataWebSocketClient from '../client/websocket.client';

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;

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

  constructor(accessToken: string, client = new MarketDataWebSocketClient(accessToken)) {
    super();
    this.client = client;
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
        logger.error('Market data WebSocket connection attempt failed', { error });
        this.scheduleReconnect();
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
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;
      this.setState(ConnectionState.CONNECTED);
    });

    this.client.on('disconnected', () => {
      if (this.manuallyDisconnected) {
        return;
      }

      logger.warn('Market data WebSocket disconnected unexpectedly');
      this.scheduleReconnect();
    });

    this.client.on('connectionError', (error) => {
      logger.error('Market data WebSocket emitted a connection error', { error });
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyDisconnected || this.reconnectTimer || this.state === ConnectionState.CONNECTED) {
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
