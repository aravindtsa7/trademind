import { NextFunction, Request, Response } from 'express';
import { successResponse } from '../../../common/http/response';
import eventBus from '../../../core/events';
import logger from '../../../core/logger/logger';
import ConnectionManager, { ConnectionState } from '../managers/connection.manager';
import SubscriptionManager from '../managers/subscription.manager';
import { MarketTickEvent } from '../processors/tick.processor';

export default class MarketDataController {
  private connectionManager: ConnectionManager;
  private subscriptionManager: SubscriptionManager;
  private connectedAt?: Date;
  private lastReceivedTickTimestamp?: string;

  constructor() {
    const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim() ?? '';
    this.connectionManager = new ConnectionManager(accessToken);
    this.subscriptionManager = new SubscriptionManager(accessToken, this.connectionManager);

    this.connectionManager.on('stateChanged', ({ state }: { state: ConnectionState }) => {
      this.connectedAt = state === ConnectionState.CONNECTED ? new Date() : undefined;
    });

    eventBus.on('market.tick', (event: MarketTickEvent) => {
      this.lastReceivedTickTimestamp = event.timestamp ?? new Date().toISOString();
    });
  }

  status(_req: Request, res: Response, next: NextFunction) {
    try {
      const state = this.connectionManager.getState();
      const subscriptions = this.subscriptionManager.getSubscriptions();
      const connected = state === ConnectionState.CONNECTED;
      const uptimeSeconds =
        connected && this.connectedAt
          ? Math.floor((Date.now() - this.connectedAt.getTime()) / 1_000)
          : 0;

      return successResponse(res, {
        state,
        connected,
        activeSubscriptions: subscriptions.length,
        subscribedInstrumentKeys: subscriptions.map((subscription) => subscription.instrumentKey),
        lastReceivedTickTimestamp: this.lastReceivedTickTimestamp ?? null,
        connectionUptimeSeconds: uptimeSeconds,
      });
    } catch (error) {
      logger.error('Failed to get market data status', { error });
      return next(error);
    }
  }
}
