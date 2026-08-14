import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import { shouldEmitTradingLog } from '../../../core/logger/trading-log-mode';

const marketDataAuthorizeUrl = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

interface WebSocketAuthorizationResponse {
  data?: {
    authorized_redirect_uri?: string;
  };
}

export default class MarketDataWebSocketClient extends EventEmitter {
  private axios: AxiosInstance;
  private socket?: WebSocket;
  private intentionalDisconnect = false;

  constructor(private accessToken: string) {
    super();
    this.axios = axios.create({ timeout: 10_000 });
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
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        const socket = new WebSocket(authorizedUrl);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        socket.addEventListener('open', () => {
          logger.info('Connected to Upstox market data WebSocket');
          this.emit('connected');
          finish();
        });

        socket.addEventListener('message', (event: MessageEvent) => {
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
          const error = new Error('Upstox market data WebSocket connection failed.');
          if (this.intentionalDisconnect) {
            logger.debug('Ignoring expected WebSocket error during intentional disconnect');
            finish(error);
            return;
          }
          logger.error('Upstox market data WebSocket error', { error });
          this.emit('connectionError', error);
          finish(error);
        });

        socket.addEventListener('close', (event: CloseEvent) => {
          const isCurrentSocket = this.socket === socket;
          if (isCurrentSocket) {
            this.socket = undefined;
          }

          const intentional = this.intentionalDisconnect;
          logger.info(intentional ? 'Disconnected from Upstox market data WebSocket intentionally' : 'Disconnected from Upstox market data WebSocket', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
          if (!settled && !intentional) finish(new Error(`Upstox market data WebSocket closed before opening (code ${event.code}).`));
          this.emit('disconnected', { ...event, intentional }, isCurrentSocket);
        });
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
