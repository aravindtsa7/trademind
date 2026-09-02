import { EventEmitter } from 'events';
import { MarketDataSubscription, MarketDataSubscriptionMode } from '../managers/subscription.manager';

/** Structural boundary satisfied by the real SubscriptionManager AND by GatewayMarketDataChannel. */
export interface MarketDataSubscriptionPort {
  subscribe(instrumentKey: string, mode?: MarketDataSubscriptionMode): Promise<void>;
  unsubscribe(instrumentKey: string): void;
  unsubscribeMany(instrumentKeys: string[]): void;
  getSubscriptions(): MarketDataSubscription[];
}

/** Structural boundary satisfied by the real ConnectionManager AND by GatewayMarketDataChannel. */
export interface MarketDataConnectionPort extends EventEmitter {
  getGenerationId(): number;
  /**
   * Standalone: opens the dedicated physical breaker (ConnectionManager.failRecovery), exactly
   * as today. Shared gateway: consumer-scoped only -- see GatewayMarketDataChannel's own doc.
   * Never opens the shared physical breaker or affects sibling consumers.
   */
  failRecovery(generationId: number, reason?: string): boolean;
  /**
   * Standalone: disconnects the dedicated physical socket, exactly as today. Shared gateway:
   * releases this consumer's subscription leases and marks it inactive only -- never touches the
   * shared physical transport. See GatewayMarketDataChannel's own doc.
   */
  disconnect(): void;
}

/** Structural boundary satisfied by the real MarketDataHealthMonitorService AND by GatewayMarketDataChannel. */
export interface MarketDataHealthPort {
  start(): void;
  stop(): void;
  noteValidMarketEvent(generationId: number): void;
  noteNiftyTick(generationId: number, sourceTimestamp?: Date): void;
  confirmRecoveryReady(generationId: number): boolean;
  confirmPostSourceTransportReady(generationId: number): boolean;
}

/**
 * The complete market-data surface a strategy runner (V2/V4/V8) depends on. A GatewayMarketDataChannel
 * leased from SharedMarketDataGateway satisfies this whole shape in one object, standing in for
 * the three separate real objects (ConnectionManager, SubscriptionManager,
 * MarketDataHealthMonitorService) a standalone runner constructs directly -- so runner files do
 * not need to know which one they were given.
 */
export interface StrategyMarketDataChannel extends MarketDataConnectionPort, MarketDataSubscriptionPort, MarketDataHealthPort {}
