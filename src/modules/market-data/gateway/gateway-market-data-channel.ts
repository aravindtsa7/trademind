import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import { MarketDataSubscription, MarketDataSubscriptionMode } from '../managers/subscription.manager';
import { StrategyMarketDataChannel } from './strategy-market-data-channel';
import type SharedMarketDataGateway from './shared-market-data-gateway';

export type ConsumerLifecycleState = 'REGISTERED' | 'ACTIVE' | 'RELEASED';

/**
 * One strategy's private, isolated view of the shared physical market-data transport.
 *
 * This is the ownership split required by the shared-gateway milestone (see
 * SharedMarketDataGateway's own class doc for the full rationale): a channel may lease/release
 * instrument subscriptions and read physical state, but has NO authority to disconnect the
 * shared physical transport or open its breaker -- only the gateway itself (via its own single
 * MarketDataHealthMonitorService) does that, centrally, once, for every active consumer at once.
 * A channel's own failRecovery()/disconnect() calls are consumer-scoped only:
 *
 * - failRecovery() never touches ConnectionManager -- it emits a synthetic 'reconnectFailed'
 *   event on THIS channel only, so the strategy runner's own unchanged
 *   `channel.on('reconnectFailed', ...)` listener faults just that one strategy's host.
 * - disconnect() releases this consumer's subscription leases and deregisters it from the
 *   gateway; it never calls ConnectionManager.disconnect(). The physical transport is
 *   disconnected only by the central runtime, via SharedMarketDataGateway.shutdown(), once every
 *   consumer has finished.
 *
 * Emits (broadcast identically to every ACTIVE channel by the gateway): 'connected',
 * 'unexpectedDisconnect', 'reconnected', 'reconnectFailed' (only for a genuine physical breaker
 * open -- see SharedMarketDataGateway), 'market.tick', 'market.depth', 'market.greeks' (fanned
 * out only for instruments this channel currently owns). A strategy runner is also free to
 * `channel.emit(...)`/`channel.on(...)` its own private event names on this same object (e.g.
 * 'market.candle.completed', or a strategy-internal pub/sub event) exactly as it would with a
 * private EventEmitter -- nothing about that usage is gateway-specific.
 */
export default class GatewayMarketDataChannel extends EventEmitter implements StrategyMarketDataChannel {
  private state: ConsumerLifecycleState = 'REGISTERED';

  constructor(private readonly gateway: SharedMarketDataGateway, readonly consumerId: string) {
    super();
  }

  isActive(): boolean {
    return this.state !== 'RELEASED';
  }

  getGenerationId(): number {
    return this.gateway.getGenerationId();
  }

  async subscribe(instrumentKey: string, mode: MarketDataSubscriptionMode = MarketDataSubscriptionMode.FULL): Promise<void> {
    if (this.state === 'RELEASED') throw new Error(`GatewayMarketDataChannel(${this.consumerId}): cannot subscribe after disconnect().`);
    this.state = 'ACTIVE';
    await this.gateway.subscriptions.acquire(this.consumerId, instrumentKey, mode);
  }

  unsubscribe(instrumentKey: string): void {
    this.gateway.subscriptions.release(this.consumerId, instrumentKey);
  }

  unsubscribeMany(instrumentKeys: string[]): void {
    instrumentKeys.forEach((instrumentKey) => this.unsubscribe(instrumentKey));
  }

  getSubscriptions(): MarketDataSubscription[] {
    return this.gateway.subscriptions.getOwnedSubscriptions(this.consumerId);
  }

  /** Consumer-scoped fault only -- see class doc. Never opens the shared physical breaker. */
  failRecovery(generationId: number, reason = 'RECOVERY_FAILED'): boolean {
    if (this.state === 'RELEASED' || generationId !== this.gateway.getGenerationId()) return false;
    logger.error('SHARED_MARKET_DATA_CONSUMER_RECOVERY_FAILED', { consumerId: this.consumerId, generationId, reason });
    const details = { generationId, reason, attempts: 0, downtimeMs: 0 };
    try {
      this.emit('reconnectFailed', details);
    } catch (error) {
      logger.error('Shared market-data consumer reconnect-failed listener failed', { error, consumerId: this.consumerId });
    }
    return true;
  }

  /** Consumer-scoped release only -- see class doc. Never disconnects the shared physical transport. */
  disconnect(): void {
    if (this.state === 'RELEASED') return;
    this.state = 'RELEASED';
    this.gateway.subscriptions.releaseAll(this.consumerId);
    this.gateway.deregisterConsumer(this.consumerId);
    logger.info('SHARED_MARKET_DATA_CONSUMER_RELEASED', { consumerId: this.consumerId });
  }

  // Health-facade surface: physical transport health/evidence is owned centrally by the
  // gateway's own single MarketDataHealthMonitorService (see SharedMarketDataGateway). These
  // note* calls are intentionally no-ops here -- the gateway already derives the identical
  // evidence once, upstream of fan-out, from the same ticks this channel receives -- and the
  // confirm* calls are read-only queries against that one shared evidence, never a second,
  // independent confirmation authority that could race or duplicate the gateway's own.
  start(): void {}
  stop(): void {}
  noteValidMarketEvent(): void {}
  noteNiftyTick(): void {}
  confirmRecoveryReady(generationId: number): boolean {
    return this.gateway.isTransportHealthy(generationId);
  }
  confirmPostSourceTransportReady(generationId: number): boolean {
    return this.gateway.isTransportHealthy(generationId);
  }
}
