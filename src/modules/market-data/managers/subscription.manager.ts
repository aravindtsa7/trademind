import { randomUUID } from 'crypto';
import logger from '../../../core/logger/logger';
import ConnectionManager, { ConnectionState } from './connection.manager';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';

export enum MarketDataSubscriptionMode {
  LTPC = 'ltpc',
  OPTION_GREEKS = 'option_greeks',
  FULL = 'full',
  FULL_D30 = 'full_d30',
}

export interface MarketDataSubscription {
  instrumentKey: string;
  mode: MarketDataSubscriptionMode;
}

interface SubscriptionRequest {
  guid: string;
  method: 'sub' | 'unsub';
  data: {
    mode: MarketDataSubscriptionMode;
    instrumentKeys: string[];
  };
}

export default class SubscriptionManager {
  private connectionManager: ConnectionManager;
  private subscriptions = new Map<string, MarketDataSubscriptionMode>();
  private restoredGenerationId?: number;

  constructor(accessToken: string, connectionManager = new ConnectionManager(accessToken)) {
    this.connectionManager = connectionManager;
    this.registerConnectionListeners();
  }

  async subscribe(
    instrumentKey: string,
    mode = MarketDataSubscriptionMode.FULL
  ): Promise<void> {
    await this.subscribeMany([instrumentKey], mode);
  }

  unsubscribe(instrumentKey: string): void {
    this.unsubscribeMany([instrumentKey]);
  }

  async subscribeMany(
    instrumentKeys: string[],
    mode = MarketDataSubscriptionMode.FULL
  ): Promise<void> {
    const keysToSubscribe = this.getNewInstrumentKeys(instrumentKeys);

    if (keysToSubscribe.length === 0) {
      logger.debug('Ignoring duplicate market data subscription request');
      return;
    }

    keysToSubscribe.forEach((instrumentKey) => this.subscriptions.set(instrumentKey, mode));
    keysToSubscribe.forEach((instrumentKey) => recordMarketReplayEvent('SUBSCRIPTION_INTENT', {
      instrumentKey,
      sourceTimestamp: null,
      receivedTimestamp: new Date().toISOString(),
      sequenceNumber: null,
      connectionGenerationId: this.connectionManager.getGenerationId(),
      payload: { mode },
    }));
    const wasConnected = this.connectionManager.getState() === ConnectionState.CONNECTED;

    try {
      await this.connectionManager.connect();

      if (wasConnected) {
        this.sendSubscriptionRequest('sub', keysToSubscribe, mode);
      }

      logger.info('Subscribed to market data instruments', {
        instrumentCount: keysToSubscribe.length,
        mode,
      });
    } catch (error) {
      // The subscription intent is retained and ConnectionManager already owns
      // its bounded reconnect loop. Do not terminate a live harness merely
      // because the first authorization/socket attempt was transiently down.
      if (this.connectionManager.getState() === ConnectionState.RECONNECTING) {
        logger.warn('Market data subscription is pending reconnect', { instrumentCount: keysToSubscribe.length, mode });
        return;
      }
      logger.error('Failed to subscribe to market data instruments', {
        instrumentCount: keysToSubscribe.length,
        mode,
        error,
      });
      throw error;
    }
  }

  unsubscribeMany(instrumentKeys: string[]): void {
    const subscriptionsByMode = new Map<MarketDataSubscriptionMode, string[]>();

    for (const instrumentKey of new Set(instrumentKeys)) {
      const mode = this.subscriptions.get(instrumentKey);
      if (!mode) {
        continue;
      }

      this.subscriptions.delete(instrumentKey);
      const keys = subscriptionsByMode.get(mode) ?? [];
      keys.push(instrumentKey);
      subscriptionsByMode.set(mode, keys);
    }

    if (subscriptionsByMode.size === 0) {
      logger.debug('Ignoring unsubscribe request for inactive market data subscriptions');
      return;
    }

    try {
      if (this.connectionManager.getState() === ConnectionState.CONNECTED) {
        subscriptionsByMode.forEach((keys, mode) => {
          this.sendSubscriptionRequest('unsub', keys, mode);
        });
      }

      logger.info('Unsubscribed from market data instruments', {
        instrumentCount: instrumentKeys.length,
      });
    } catch (error) {
      logger.error('Failed to unsubscribe from market data instruments', { error });
      throw error;
    }
  }

  getSubscriptions(): MarketDataSubscription[] {
    return Array.from(this.subscriptions, ([instrumentKey, mode]) => ({ instrumentKey, mode }));
  }

  private registerConnectionListeners(): void {
    this.connectionManager.on(
      'stateChanged',
      ({ previousState, state, generationId }: { previousState: ConnectionState; state: ConnectionState; generationId?: number }) => {
        if (state === ConnectionState.CONNECTED && previousState !== ConnectionState.CONNECTED) {
          this.restoreSubscriptions(generationId ?? this.connectionManager.getGenerationId());
        }
      }
    );
  }

  private getNewInstrumentKeys(instrumentKeys: string[]): string[] {
    const uniqueKeys = new Set(
      instrumentKeys.map((instrumentKey) => instrumentKey.trim()).filter(Boolean)
    );

    return Array.from(uniqueKeys).filter((instrumentKey) => !this.subscriptions.has(instrumentKey));
  }

  private restoreSubscriptions(generationId: number): void {
    if (this.restoredGenerationId === generationId) return;
    this.restoredGenerationId = generationId;
    if (this.subscriptions.size === 0) {
      return;
    }

    const subscriptionsByMode = new Map<MarketDataSubscriptionMode, string[]>();
    this.subscriptions.forEach((mode, instrumentKey) => {
      const keys = subscriptionsByMode.get(mode) ?? [];
      keys.push(instrumentKey);
      subscriptionsByMode.set(mode, keys);
    });

    try {
      subscriptionsByMode.forEach((instrumentKeys, mode) => {
        this.sendSubscriptionRequest('sub', instrumentKeys, mode);
      });

      logger.info('Restored market data subscriptions after reconnection', {
        instrumentCount: this.subscriptions.size,
        generationId,
      });
      this.connectionManager.emit('subscriptionsRestored', { generationId, instrumentCount: this.subscriptions.size });
      this.subscriptions.forEach((mode, instrumentKey) => recordMarketReplayEvent('SUBSCRIPTION_RESTORED', {
        instrumentKey,
        sourceTimestamp: null,
        receivedTimestamp: new Date().toISOString(),
        sequenceNumber: null,
        connectionGenerationId: generationId,
        payload: { mode },
      }));
    } catch (error) {
      this.restoredGenerationId = undefined;
      logger.error('Failed to restore market data subscriptions after reconnection', { error });
    }
  }

  private sendSubscriptionRequest(
    method: SubscriptionRequest['method'],
    instrumentKeys: string[],
    mode: MarketDataSubscriptionMode
  ): void {
    const request: SubscriptionRequest = {
      guid: randomUUID(),
      method,
      data: {
        mode,
        instrumentKeys,
      },
    };

    this.connectionManager.send(Buffer.from(JSON.stringify(request)));
  }
}
