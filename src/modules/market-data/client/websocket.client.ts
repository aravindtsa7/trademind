import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import { shouldEmitTradingLog } from '../../../core/logger/trading-log-mode';

const marketDataAuthorizeUrl = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const defaultOpenHandshakeTimeoutMs = 10_000;

export interface MarketDataWebSocketClientScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MarketDataWebSocketClientOptions {
  openHandshakeTimeoutMs?: number;
  scheduler?: MarketDataWebSocketClientScheduler;
}

export class MarketDataWebSocketOpenTimeoutError extends Error {
  readonly code = 'WEBSOCKET_OPEN_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`Upstox market data WebSocket did not open within ${timeoutMs}ms.`);
    this.name = 'MarketDataWebSocketOpenTimeoutError';
  }
}

interface WebSocketAuthorizationResponse {
  data?: {
    authorized_redirect_uri?: string;
  };
}

export default class MarketDataWebSocketClient extends EventEmitter {
  private axios: AxiosInstance;
  private socket?: WebSocket;
  private intentionalDisconnect = false;
  private readonly intentionallyClosingSockets = new WeakSet<WebSocket>();
  private readonly openHandshakeTimeoutMs: number;
  private readonly scheduler: MarketDataWebSocketClientScheduler;

  constructor(private accessToken: string, options: MarketDataWebSocketClientOptions = {}) {
    super();
    this.axios = axios.create({ timeout: 10_000 });
    this.openHandshakeTimeoutMs = positiveFiniteNumber(
      options.openHandshakeTimeoutMs,
      process.env.MARKET_DATA_WEBSOCKET_OPEN_TIMEOUT_MS,
      defaultOpenHandshakeTimeoutMs,
      'openHandshakeTimeoutMs'
    );
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  async connect(): Promise<void> {
    try {
      this.intentionalDisconnect = false;
      if (this.socket?.readyState === WebSocket.OPEN) {
        logger.info('Upstox market data WebSocket is already connected');
        return;
      }

      const authorizedUrl = await this.getAuthorizedWebSocketUrl();
      if (this.intentionalDisconnect) {
        throw new Error('WebSocket connection was cancelled by an intentional disconnect.');
      }
      logger.info('Connecting to Upstox market data WebSocket');

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let handshakeTimer: unknown;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (handshakeTimer !== undefined) {
            this.scheduler.clearTimeout(handshakeTimer);
            handshakeTimer = undefined;
          }
          error ? reject(error) : resolve();
        };
        const socket = new WebSocket(authorizedUrl);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        socket.addEventListener('open', () => {
          if (this.socket !== socket) {
            logger.warn('Ignoring stale Upstox market data WebSocket open callback');
            socket.close();
            return;
          }
          logger.info('Connected to Upstox market data WebSocket');
          try {
            this.emit('connected');
          } catch (error) {
            logger.error('Upstox market data connected listener failed', { error });
          }
          finish();
        });

        socket.addEventListener('message', (event: MessageEvent) => {
          if (this.socket !== socket) return;
          if (!(event.data instanceof ArrayBuffer)) {
            logger.warn('Received a non-binary Upstox market data WebSocket message');
            return;
          }

          const message = Buffer.from(event.data);
          if (shouldEmitTradingLog('RAW_MARKET_DATA_PACKET')) {
            logger.debug('Received Upstox market data WebSocket message', { bytes: message.length });
          }
          this.emit('message', message);
        });

        socket.addEventListener('error', () => {
          if (this.socket !== socket) return;
          const error = new Error('Upstox market data WebSocket connection failed.');
          if (this.intentionalDisconnect || this.intentionallyClosingSockets.has(socket)) {
            logger.debug('Ignoring expected WebSocket error during intentional disconnect');
            finish(error);
            return;
          }
          logger.error('Upstox market data WebSocket error', { error });
          try {
            this.emit('connectionError', error);
          } catch (listenerError) {
            logger.error('Upstox market data connection-error listener failed', { error: listenerError });
          }
          finish(error);
        });

        socket.addEventListener('close', (event: CloseEvent) => {
          const isCurrentSocket = this.socket === socket;
          if (isCurrentSocket) {
            this.socket = undefined;
          }

          const intentional = this.intentionalDisconnect || this.intentionallyClosingSockets.has(socket);
          logger.info(intentional ? 'Disconnected from Upstox market data WebSocket intentionally' : 'Disconnected from Upstox market data WebSocket', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
          if (!settled) finish(new Error(intentional ? 'Upstox market data WebSocket connection was cancelled before opening.' : `Upstox market data WebSocket closed before opening (code ${event.code}).`));
          this.emit('disconnected', { ...event, intentional }, isCurrentSocket);
        });

        handshakeTimer = this.scheduler.setTimeout(() => {
          if (settled || this.socket !== socket) return;
          const error = new MarketDataWebSocketOpenTimeoutError(this.openHandshakeTimeoutMs);
          logger.error('Upstox market data WebSocket open handshake timed out', {
            openHandshakeTimeoutMs: this.openHandshakeTimeoutMs,
          });
          this.intentionallyClosingSockets.add(socket);
          this.socket = undefined;
          finish(error);
          try {
            socket.close();
          } catch (closeError) {
            logger.warn('Failed to close timed-out Upstox market data WebSocket', { closeError });
          }
        }, this.openHandshakeTimeoutMs);
      });
    } catch (error) {
      if (this.intentionalDisconnect) throw error;
      logger.error('Failed to connect to Upstox market data WebSocket', { error });
      throw error;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (!this.socket) {
      return;
    }

    logger.info('Disconnecting from Upstox market data WebSocket');
    this.intentionallyClosingSockets.add(this.socket);
    this.socket.close();
  }

  /** Close a stalled transport while allowing ConnectionManager to recover it. */
  disconnectForRecovery(): void {
    if (!this.socket) return;
    this.intentionalDisconnect = false;
    logger.warn('Closing stalled Upstox market data WebSocket for recovery');
    this.socket.close();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Upstox market data WebSocket is not connected.');
    }

    this.socket.send(data);
    if (shouldEmitTradingLog('RAW_MARKET_DATA_PACKET')) logger.debug('Sent Upstox market data WebSocket message');
  }

  private async getAuthorizedWebSocketUrl(): Promise<string> {
    if (!this.accessToken) {
      throw new Error('An Upstox OAuth access token is required to connect to market data.');
    }

    const response = await this.axios.get<WebSocketAuthorizationResponse>(marketDataAuthorizeUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
    const authorizedUrl = response.data.data?.authorized_redirect_uri;

    if (!authorizedUrl) {
      throw new Error('Upstox did not return an authorized market data WebSocket URL.');
    }

    return authorizedUrl;
  }
}

function positiveFiniteNumber(
  optionValue: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  name: string
): number {
  const value = optionValue ?? (environmentValue === undefined ? fallback : Number(environmentValue));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}
