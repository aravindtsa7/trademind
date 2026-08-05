import { randomUUID } from 'crypto';
import logger from '../../../core/logger/logger';
import ConnectionManager, { ConnectionState } from './connection.manager';

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
      ({ state }: { state: ConnectionState }) => {
        if (state === ConnectionState.CONNECTED) {
          this.restoreSubscriptions();
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

  private restoreSubscriptions(): void {
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
      });
    } catch (error) {
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
