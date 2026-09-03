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
 *
 * CURRENT-GENERATION HANDOFF (startup-generation race fix): a strategy runner registers its
 * consumer, then does its own (potentially slow: warmup/backfill/DB reads) startup work BEFORE
 * ever calling `channel.on('connected', ...)` to wire its MarketDataRecoveryCoordinatorService --
 * see e.g. test-live-v4-nifty-momentum-shadow.ts, which only attaches that listener after
 * `warmUp()` has already resolved. In the combined shared-gateway runtime, the ONE physical
 * transport is already connected (gateway.start() already resolved) before any strategy's
 * run() -- and therefore before that listener -- exists. A plain EventEmitter would broadcast
 * 'connected' to nobody and lose it forever (no further 'connected' fires until the next
 * reconnect), which is exactly the reproduced defect: the recovery coordinator never learns the
 * current generation and eventually times out FAULTED despite live ticks flowing.
 *
 * `currentConnectedGenerationId` is a sticky snapshot of "the generation the shared physical
 * transport is connected at right now", seeded at construction time (see
 * `initialConnectionSnapshot`, read by SharedMarketDataGateway.registerConsumer() atomically with
 * this channel's creation) and kept current EXCLUSIVELY via `acceptPhysicalLifecycleEvent()`
 * (see its own doc) -- deliberately NOT via ordinary `super.on(...)` listeners on this channel's
 * OWN public 'connected'/'unexpectedDisconnect'/'reconnectFailed' events. An earlier version of
 * this file used such listeners, which was a real bug: they live in the exact same removable
 * listener array as every strategy-attached listener, so `channel.removeAllListeners('connected')`
 * /`removeAllListeners()`/`removeListener(...)` -- all ordinary, legitimate EventEmitter calls a
 * consumer is free to make -- could silently delete the bookkeeping too and corrupt every future
 * handoff. `acceptPhysicalLifecycleEvent()` is called only by SharedMarketDataGateway.broadcast(),
 * never reachable from public listener-management APIs, so no amount of listener cleanup on this
 * channel can ever affect it.
 *
 * EVERY public registration API relevant to 'connected' -- on, addListener, once,
 * prependListener, prependOnceListener -- is covered, none silently bypasses the handoff (see
 * on()'s and prependListener()'s own docs for exactly how). A late listener -- attached before or
 * after the physical connect, whenever it happens to be wired, through any of those APIs --
 * observes the current generation exactly once if one exists, without waiting for the next
 * reconnect, with EventEmitter-equivalent receiver (`this`) semantics and normal once-removal
 * semantics (see `scheduleHandoffReplay`). This is a strict generalization of the ordering every
 * consumer already gets when its listener happens to be attached before connect (a live broadcast
 * reaches it normally), so it introduces no new event ('connected' is still the only event this
 * channel ever delivers for transport-open, exactly as before -- 'reconnected' is never touched or
 * substituted). The replay itself is deferred one microtask and re-validated against the CURRENT
 * snapshot and lifecycle state at the moment it fires, so a disconnect/reconnect or a
 * `disconnect()` release racing the handoff can never deliver a stale/obsolete generation or a
 * notification to a released consumer -- see the class's own test suite for the exact races this
 * guards against. Connection handoff is lifecycle initialization ONLY: it never itself confirms
 * market-data readiness (see MarketDataRecoveryCoordinatorService.handleInitialConnected(), which
 * still requires a real current-generation live tick before the coordinator can become READY).
 */
export type PhysicalLifecycleEvent = 'connected' | 'unexpectedDisconnect' | 'reconnected' | 'reconnectFailed';

export default class GatewayMarketDataChannel extends EventEmitter implements StrategyMarketDataChannel {
  private state: ConsumerLifecycleState = 'REGISTERED';
  /** Sticky "connected at this generation right now, or not connected" snapshot -- see class doc. */
  private currentConnectedGenerationId: number | null;

  constructor(private readonly gateway: SharedMarketDataGateway, readonly consumerId: string, initialConnectionSnapshot: { generationId: number } | null = null) {
    super();
    this.currentConnectedGenerationId = initialConnectionSnapshot?.generationId ?? null;
  }

  /**
   * Race-safe current-generation handoff for a 'connected' listener (see class doc). Covers
   * on(), addListener() (Node aliases addListener directly to on() at the prototype level --
   * verified via `EventEmitter.prototype.addListener === EventEmitter.prototype.on` against this
   * repo's Node runtime -- so overriding on() alone would already cover a raw `addListener()`
   * call even without the explicit override below; it is kept explicit so neither API can ever
   * silently diverge from the other) and once() (`EventEmitter.prototype.once` calls
   * `this.on(type, onceWrappedListener)` -- verified via `.toString()` against this repo's Node
   * runtime, not assumed). prependListener()/prependOnceListener() are a SEPARATE family Node
   * does not route through on() at all -- see prependListener()'s own doc.
   */
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === 'connected') this.scheduleHandoffReplay(listener);
    return this;
  }

  addListener(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.on(event, listener);
  }

  /**
   * Same current-generation handoff as on() (see its doc), for the prepend registration family.
   * A deliberately SEPARATE override: Node's EventEmitter does not route
   * prependListener()/prependOnceListener() through on()/addListener() at all. An earlier version
   * of this file incorrectly claimed (in a comment, never tested) that prependOnceListener()
   * routed through on() -- it does not. Verified directly against this repo's Node runtime:
   * `EventEmitter.prototype.prependOnceListener.toString()` shows it calls
   * `this.prependListener(type, onceWrappedListener)`, which resolves polymorphically to THIS
   * override once it exists -- so prependOnceListener() is covered here, not in on(). Without
   * this override, a listener attached via prependListener()/prependOnceListener() would silently
   * receive no current-generation handoff at all (Terra F-01 finding: `prependListener -> []`).
   */
  prependListener(event: string | symbol, listener: (...args: any[]) => void): this {
    super.prependListener(event, listener);
    if (event === 'connected') this.scheduleHandoffReplay(listener);
    return this;
  }

  /**
   * Delivers the CURRENT connected generation (if any) to exactly this one newly-attached
   * listener, once, on a fresh microtask -- never via `this.emit(...)`, so no sibling listener
   * (attached earlier, already correctly live-notified when the real event fired) is re-notified.
   *
   * Receiver semantics: invoked via `listener.call(this, { generationId })`, matching ordinary
   * EventEmitter listener-receiver semantics (`this === channel`) exactly as a real
   * `emit('connected', ...)` would deliver it to a normal function listener -- this matters
   * specifically for a plain `function (details) { this.getGenerationId() }`-style listener
   * (arrow-function listeners are unaffected either way, per normal JS lexical-`this` semantics).
   * For a `listener` that is actually a once()/prependOnceListener() wrapper (Node's internal
   * `onceWrapper`, produced by `_onceWrap` and bound via `Function.prototype.bind` at creation --
   * verified against this repo's Node runtime), the explicit receiver here is a no-op: a bound
   * function's own `this` cannot be overridden by `call`/`apply`, so the wrapper always uses its
   * own captured target regardless. Calling that wrapper (rather than the unwrapped original)
   * is exactly what preserves normal once-removal semantics: the wrapper self-deregisters (via
   * its own `target.removeListener(type, wrapFn)`) BEFORE invoking the real listener, so a listener
   * consumed by this replay is already gone from the listener array and cannot double-fire on a
   * later reconnect's live 'connected' broadcast.
   *
   * Containment: a throwing listener is caught and logged (mirroring
   * SharedMarketDataGateway.broadcast()'s own containment for the live-delivery path) rather than
   * escaping as an unhandled queueMicrotask exception, which would otherwise destabilize the
   * process. Never touches ConnectionManager, never opens the physical breaker, never emits a
   * synthetic reconnectFailed -- a consumer-scoped listener bug must stay consumer-scoped.
   *
   * Deferred to a microtask, then re-validated, so a listener attached synchronously in the same
   * tick as a live 'connected' broadcast can never receive it twice (nothing to replay yet -- see
   * on()'s/prependListener()'s call ordering) and so a disconnect/reconnect or disconnect()
   * release racing the handoff is always observed before this fires:
   *  - `currentConnectedGenerationId !== generationId` -- the generation moved on (disconnected,
   *    or a NEWER generation is now current); the true current lifecycle sequence (a live
   *    'connected'/'unexpectedDisconnect' the listener is already attached to receive) governs
   *    instead of this now-stale snapshot.
   *  - `!isActive()` -- this consumer was released; it must never receive a late notification.
   *  - listener no longer attached (removed via off()/removeListener() before the microtask ran;
   *    Node's removeListener() matches a once() wrapper by its exposed `.listener` property too,
   *    so `channel.off('connected', originalFn)` correctly cancels a still-pending once() replay).
   */
  private scheduleHandoffReplay(listener: (...args: any[]) => void): void {
    if (this.state === 'RELEASED' || this.currentConnectedGenerationId === null) return;
    const generationId = this.currentConnectedGenerationId;
    queueMicrotask(() => {
      if (this.state === 'RELEASED' || this.currentConnectedGenerationId !== generationId) return;
      if (!this.rawListeners('connected').includes(listener)) return;
      try {
        listener.call(this, { generationId });
      } catch (error) {
        logger.error('Shared market-data consumer handoff-replay listener failed', { error, consumerId: this.consumerId, event: 'connected', generationId });
      }
    });
  }

  /**
   * Internal-only physical-lifecycle intake -- called EXCLUSIVELY by
   * SharedMarketDataGateway.broadcast(); never intended to be called directly by strategy code
   * (see class doc for why this exists as a separate method rather than relying on this channel's
   * own public 'connected'/'unexpectedDisconnect'/'reconnectFailed' listeners: those are freely
   * removable by consumer code and must never be the authoritative source of sticky lifecycle
   * truth). Updates `currentConnectedGenerationId` directly, then emits the public event exactly
   * as before for whatever external listeners currently exist -- SharedMarketDataGateway remains
   * the sole source of physical lifecycle truth; this method only relays it into this channel's
   * own sticky bookkeeping before doing what `channel.emit(event, details)` already did.
   * 'reconnected' carries no snapshot update of its own: ConnectionManager always emits 'connected'
   * (handled here) immediately before 'reconnected' on every reconnect (see connection.manager.ts),
   * so the snapshot is already current by the time 'reconnected' arrives.
   */
  acceptPhysicalLifecycleEvent(event: PhysicalLifecycleEvent, details: unknown): void {
    if (event === 'connected') this.currentConnectedGenerationId = (details as { generationId: number }).generationId;
    else if (event === 'unexpectedDisconnect' || event === 'reconnectFailed') this.currentConnectedGenerationId = null;
    this.emit(event, details);
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
