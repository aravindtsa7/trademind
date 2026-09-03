import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import MarketDataWebSocketClient from '../client/websocket.client';
import ConnectionManager, { ConnectionManagerOptions, ConnectionState } from '../managers/connection.manager';
import SubscriptionManager from '../managers/subscription.manager';
import ProtobufDecoder from '../protobuf/protobuf.decoder';
import TickProcessor, { MarketDepthEvent, MarketGreeksEvent, MarketTickEvent } from '../processors/tick.processor';
import MarketDataHealthMonitorService, { MarketDataHealthMonitorOptions } from '../services/market-data-health-monitor.service';
import { nifty1mSourceCompletionBoundary } from '../../historical-candles/utils/historical-session-completeness.util';
import SharedSubscriptionRegistry from './shared-subscription-registry';
import GatewayMarketDataChannel, { PhysicalLifecycleEvent } from './gateway-market-data-channel';
import { InstrumentRegistry, createDefaultInstrumentRegistry, niftyInstrumentKey } from './instrument-registry';

export interface SharedMarketDataGatewayOptions {
  accessToken: string;
  /** Instrument this gateway treats as authoritative transport-liveness evidence. Defaults to NIFTY. */
  primaryInstrumentKey?: string;
  instrumentRegistry?: InstrumentRegistry;
  connectionManagerOptions?: ConnectionManagerOptions;
  healthMonitorOptions?: Pick<MarketDataHealthMonitorOptions, 'stallMs' | 'heartbeatCheckMs' | 'generationGraceMs' | 'now' | 'isMarketSession'>;
  /** Defaults to the canonical NIFTY 1m source-completion boundary (15:30 IST). */
  isSourceFresh?: (value: Date) => boolean;
  now?: () => number;
  // Test/DI seams -- production callers should not need these.
  webSocketClient?: MarketDataWebSocketClient;
  connectionManager?: ConnectionManager;
  subscriptionManager?: SubscriptionManager;
  decoder?: ProtobufDecoder;
  tickProcessor?: TickProcessor;
  healthMonitor?: MarketDataHealthMonitorService;
}

export type SharedGatewayState = 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPED';

/**
 * ONE physical Upstox market-data WebSocket, shared by every registered strategy consumer.
 *
 * Owns exactly one MarketDataWebSocketClient, one ConnectionManager, one physical
 * SubscriptionManager (wrapped by SharedSubscriptionRegistry for ref-counted ownership), one
 * ProtobufDecoder, and one upstream TickProcessor -- every packet Upstox sends is decoded and
 * normalized exactly once, on a private upstream EventEmitter never exposed to strategy code.
 * A fan-out router (wireUpstreamTicks/fanOut) then re-emits each normalized tick/depth/greeks
 * event onto every consumer channel that currently owns that instrument, cloning the event so no
 * consumer can mutate another's copy.
 *
 * Transport health vs. strategy recovery split (the central design requirement of this class):
 * this gateway owns exactly ONE MarketDataHealthMonitorService, wired to the ONE ConnectionManager,
 * and is the SOLE caller of confirmRecoveryReady()/confirmPostSourceTransportReady() (see
 * noteHealthEvidence()) and the sole indirect trigger of connection.reconnectForHealth() (via the
 * health monitor's own check() loop). A strategy consumer's GatewayMarketDataChannel can only
 * READ that shared evidence (isTransportHealthy()) -- it can never independently confirm/clear
 * ConnectionManager's reconnect/breaker bookkeeping, and a consumer's own recovery failure
 * (channel.failRecovery()) never reaches ConnectionManager at all, so one strategy's backfill
 * failure can never open the shared physical breaker or disconnect healthy siblings. A genuine
 * physical breaker OPEN (ConnectionManager's 'reconnectFailed') is the one condition that
 * propagates to every active consumer (see wireConnectionEvents()).
 *
 * Per-strategy recovery (MarketDataRecoveryCoordinatorService), candle construction
 * (LiveCandleBuilderService/LiveCandleEventAdapterService), source-boundary coverage, and host
 * lifecycle remain entirely outside this class, owned by each strategy runner against its own
 * private GatewayMarketDataChannel -- this class has no knowledge of V2/V4/V8 as such.
 */
export default class SharedMarketDataGateway extends EventEmitter {
  readonly subscriptions: SharedSubscriptionRegistry;
  readonly instrumentRegistry: InstrumentRegistry;
  private readonly connectionManager: ConnectionManager;
  private readonly health: MarketDataHealthMonitorService;
  private readonly upstreamTickProcessor: TickProcessor;
  private readonly upstreamBus = new EventEmitter();
  private readonly decoder: ProtobufDecoder;
  private readonly primaryInstrumentKey: string;
  private readonly isSourceFresh: (value: Date) => boolean;
  private readonly now: () => number;
  private readonly consumers = new Map<string, GatewayMarketDataChannel>();
  private state: SharedGatewayState = 'IDLE';

  constructor(options: SharedMarketDataGatewayOptions) {
    super();
    this.instrumentRegistry = options.instrumentRegistry ?? createDefaultInstrumentRegistry();
    this.primaryInstrumentKey = options.primaryInstrumentKey ?? niftyInstrumentKey;
    this.now = options.now ?? Date.now;
    this.isSourceFresh = options.isSourceFresh ?? ((value: Date) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime());
    const webSocketClient = options.webSocketClient ?? new MarketDataWebSocketClient(options.accessToken);
    this.connectionManager = options.connectionManager ?? new ConnectionManager(options.accessToken, webSocketClient, options.connectionManagerOptions);
    const physicalSubscriptionManager = options.subscriptionManager ?? new SubscriptionManager(options.accessToken, this.connectionManager);
    this.subscriptions = new SharedSubscriptionRegistry(physicalSubscriptionManager);
    this.decoder = options.decoder ?? new ProtobufDecoder();
    this.upstreamTickProcessor = options.tickProcessor ?? new TickProcessor(this.upstreamBus);
    this.health = options.healthMonitor ?? new MarketDataHealthMonitorService(this.connectionManager, {
      ...options.healthMonitorOptions,
      isSourceFresh: this.isSourceFresh,
      onStall: (snapshot, { reason, reconnectSolicited }) => {
        if (!reconnectSolicited) {
          // Expected post-source-completion condition (NIFTY source naturally went quiet while
          // option/transport traffic is still healthy) -- observability only, exactly mirroring
          // every standalone runner's identical MARKET_DATA_SOURCE_STALE_EXPECTED branch, now
          // centralized once instead of duplicated per strategy.
          logger.info('SHARED_MARKET_DATA_SOURCE_STALE_EXPECTED', { ...snapshot, reason });
          return;
        }
        // A genuine stall: MarketDataHealthMonitorService.check() has already (synchronously,
        // right after this callback returns) called connection.reconnectForHealth(), which itself
        // emits ConnectionManager's own 'unexpectedDisconnect' -- wireConnectionEvents() below
        // broadcasts that to every active consumer. Nothing further is required here.
        logger.warn('SHARED_MARKET_DATA_TRANSPORT_STALL', { ...snapshot, reason });
      },
    });
    this.wireConnectionEvents();
    this.wireUpstreamTicks();
  }

  getGenerationId(): number {
    return this.connectionManager.getGenerationId();
  }

  getState(): SharedGatewayState {
    return this.state;
  }

  getActiveConsumerCount(): number {
    return [...this.consumers.values()].filter((channel) => channel.isActive()).length;
  }

  getPhysicalSubscriptionCount(): number {
    return this.subscriptions.getPhysicalSubscriptionCount();
  }

  /** Read-only proof that the CURRENT physical generation has been confirmed alive by the gateway's own evidence. Never mutates ConnectionManager bookkeeping itself. */
  isTransportHealthy(generationId: number): boolean {
    return this.connectionManager.getGenerationId() === generationId && this.health.isHealthy();
  }

  /**
   * Registers a new, isolated consumer channel. Safe to call before or after start() -- a
   * consumer registering while the transport is already CONNECTED is seeded with that current
   * generation atomically at construction (see GatewayMarketDataChannel's own class doc for the
   * full current-generation handoff this feeds: a 'connected' listener attached at ANY later
   * point -- immediately, or only after the strategy's own slow startup work -- still observes
   * the current generation exactly once, without waiting for the next reconnect).
   */
  registerConsumer(consumerId: string): GatewayMarketDataChannel {
    if (this.consumers.has(consumerId)) throw new Error(`SharedMarketDataGateway: consumer "${consumerId}" is already registered.`);
    const channel = new GatewayMarketDataChannel(this, consumerId, this.currentConnectionSnapshot());
    this.consumers.set(consumerId, channel);
    logger.info('SHARED_MARKET_DATA_CONSUMER_REGISTERED', { consumerId, consumerCount: this.consumers.size });
    return channel;
  }

  /** Read-only atomic snapshot of the physical connection -- the current generation if CONNECTED right now, else null. Never mutates ConnectionManager bookkeeping; feeds only GatewayMarketDataChannel's own sticky handoff state (see its class doc). */
  private currentConnectionSnapshot(): { generationId: number } | null {
    return this.connectionManager.getState() === ConnectionState.CONNECTED ? { generationId: this.connectionManager.getGenerationId() } : null;
  }

  /**
   * Called by GatewayMarketDataChannel.disconnect(); not intended to be called directly by
   * strategy code. Emits 'consumerDeregistered' so an owning combined runtime can detect when
   * every registered consumer has finished and call shutdown() itself -- this class never
   * decides that on its own (see shutdown()'s own doc: central-runtime-owned only).
   */
  deregisterConsumer(consumerId: string): void {
    if (!this.consumers.delete(consumerId)) return;
    logger.info('SHARED_MARKET_DATA_CONSUMER_DEREGISTERED', { consumerId, remainingConsumers: this.consumers.size });
    try {
      this.emit('consumerDeregistered', { consumerId, remainingConsumers: this.consumers.size });
    } catch (error) {
      logger.error('Shared market-data gateway consumerDeregistered listener failed', { error, consumerId });
    }
  }

  /** Explicit, central ownership of the physical connect -- see milestone invariant "make physical ownership explicit". Idempotent. */
  async start(): Promise<void> {
    if (this.state === 'RUNNING' || this.state === 'STARTING') return;
    this.state = 'STARTING';
    logger.info('SHARED_MARKET_DATA_GATEWAY_STARTED', {
      consumerCount: this.consumers.size,
      instruments: this.instrumentRegistry.list().map((instrument) => instrument.instrumentKey),
    });
    this.health.start();
    await this.connectionManager.connect();
    this.state = 'RUNNING';
  }

  /**
   * Central physical disconnect. Must be called only by the owning combined runtime once every
   * consumer has finished (or on a genuine gateway-fatal condition) -- never by an individual
   * consumer's own shutdown path (see GatewayMarketDataChannel.disconnect(), which deliberately
   * never calls this). Idempotent.
   */
  shutdown(): void {
    if (this.state === 'STOPPED') return;
    this.health.stop();
    this.connectionManager.disconnect();
    this.state = 'STOPPED';
    logger.info('SHARED_MARKET_DATA_GATEWAY_SHUTDOWN', { consumerCount: this.consumers.size });
  }

  private wireConnectionEvents(): void {
    this.connectionManager.on('connected', (details: { generationId: number }) => this.broadcast('connected', details));
    this.connectionManager.on('unexpectedDisconnect', (details: unknown) => this.broadcast('unexpectedDisconnect', details));
    this.connectionManager.on('reconnected', (details: unknown) => this.broadcast('reconnected', details));
    this.connectionManager.on('reconnectFailed', (details: unknown) => {
      // The one genuine physical-transport-fatal condition: propagate to every active consumer
      // (see class doc). A per-consumer channel.failRecovery() never reaches this event.
      logger.error('SHARED_MARKET_DATA_TRANSPORT_BREAKER_OPEN', details as Record<string, unknown>);
      this.broadcast('reconnectFailed', details);
    });
  }

  /**
   * Routes through GatewayMarketDataChannel.acceptPhysicalLifecycleEvent() (never a plain
   * `channel.emit(event, details)`) so this remains the ONE place physical lifecycle truth
   * reaches a channel's sticky current-generation bookkeeping -- see that method's own doc for why
   * a plain public emit is not a safe substitute (removable listener cleanup on the channel must
   * never be able to corrupt it).
   */
  private broadcast(event: PhysicalLifecycleEvent, details: unknown): void {
    for (const channel of this.consumers.values()) {
      if (!channel.isActive()) continue;
      try {
        channel.acceptPhysicalLifecycleEvent(event, details);
      } catch (error) {
        logger.error('Shared market-data consumer listener failed', { error, event, consumerId: channel.consumerId });
      }
    }
  }

  private wireUpstreamTicks(): void {
    this.connectionManager.on('message', (message: Buffer, details: { generationId: number }) => {
      try {
        this.upstreamTickProcessor.process(this.decoder.decode(message), details.generationId);
      } catch (error) {
        logger.error('Shared market-data decode/process error', { error });
      }
    });
    this.upstreamBus.on('market.tick', (event: MarketTickEvent) => {
      this.noteHealthEvidence(event);
      this.fanOut('market.tick', event);
    });
    this.upstreamBus.on('market.depth', (event: MarketDepthEvent) => this.fanOut('market.depth', event));
    this.upstreamBus.on('market.greeks', (event: MarketGreeksEvent) => this.fanOut('market.greeks', event));
  }

  /**
   * The gateway's OWN, centralized transport-liveness evidence -- decoupled from any strategy's
   * backfill/recovery state (see class doc). Mirrors exactly the two branches every standalone
   * runner previously ran per-strategy: confirmRecoveryReady() (requires a fresh NIFTY tick,
   * used before the NIFTY source-completion boundary) and confirmPostSourceTransportReady()
   * (any valid market event, used at/after it, since no further NIFTY tick is guaranteed once
   * source responsibility is complete).
   */
  private noteHealthEvidence(tick: MarketTickEvent): void {
    if (typeof tick.generationId !== 'number') return;
    this.health.noteValidMarketEvent(tick.generationId);
    const sourceFresh = this.isSourceFresh(new Date(this.now()));
    if (!sourceFresh) this.health.confirmPostSourceTransportReady(tick.generationId);
    if (tick.instrumentKey === this.primaryInstrumentKey) {
      const sourceTimestamp = tick.timestamp === undefined ? undefined : new Date(tick.timestamp);
      this.health.noteNiftyTick(tick.generationId, sourceTimestamp && !Number.isNaN(sourceTimestamp.getTime()) ? sourceTimestamp : undefined);
      if (sourceFresh) this.health.confirmRecoveryReady(tick.generationId);
    }
  }

  private fanOut(event: 'market.tick' | 'market.depth' | 'market.greeks', payload: MarketTickEvent | MarketDepthEvent | MarketGreeksEvent): void {
    const owners = this.subscriptions.getOwners(payload.instrumentKey);
    if (owners.size === 0) return;
    for (const consumerId of owners) {
      const channel = this.consumers.get(consumerId);
      if (!channel || !channel.isActive()) continue;
      channel.emit(event, cloneMarketEvent(payload));
    }
  }
}

/**
 * Every field on MarketTickEvent/MarketGreeksEvent/MarketDepthEvent is either a primitive or
 * (MarketDepthEvent.quotes only) an array of plain quote objects -- a shallow clone plus a fresh
 * quotes array/entries is sufficient to guarantee one consumer's handler can never mutate a
 * sibling consumer's copy of the same underlying tick.
 */
function cloneMarketEvent<T extends { instrumentKey: string }>(event: T): T {
  const clone: T & { quotes?: unknown[] } = { ...event };
  if (Array.isArray(clone.quotes)) clone.quotes = clone.quotes.map((quote) => ({ ...(quote as Record<string, unknown>) }));
  return clone;
}
