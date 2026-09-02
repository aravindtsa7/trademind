import logger from '../../../core/logger/logger';
import SubscriptionManager, { MarketDataSubscription, MarketDataSubscriptionMode } from '../managers/subscription.manager';

/** One in-flight first-owner physical subscribe attempt for a single instrumentKey (F-04). */
interface PendingFirstOwner {
  consumerId: string;
  mode: MarketDataSubscriptionMode;
  promise: Promise<void>;
  /** Set by a release() that arrives for `consumerId` while this attempt is still in flight. */
  cancelled: boolean;
}

/**
 * Ref-counted ownership layer over the ONE physical SubscriptionManager. SubscriptionManager
 * itself only deduplicates within its own instrumentKey->mode map -- it has no notion of which
 * of several strategy consumers requires a given instrument, so releasing one consumer's
 * interest would otherwise unsubscribe an instrument a sibling consumer still needs. This class
 * adds that missing ownership layer without modifying SubscriptionManager itself:
 *
 * - the underlying physical subscribe is sent only when an instrument gains its FIRST owner;
 * - the underlying physical unsubscribe is sent only when an instrument loses its LAST owner;
 * - a duplicate acquire() by the same consumer for the same instrument/mode is idempotent;
 * - two consumers may not lease the same instrument at conflicting modes (fails closed rather
 *   than silently downgrading data -- every current live strategy only ever requests FULL).
 *
 * Async linearizability (F-04): the physical subscribe is asynchronous, so a naive
 * check-then-set would let a second concurrent acquire() for the same instrumentKey observe a
 * first owner that has been synchronously reserved but not yet physically confirmed, and record
 * itself as an additional owner with NO physical subscription ever having succeeded (a phantom
 * owner). `pendingFirstOwner` closes that gap: while a key's first-owner physical subscribe is
 * in flight, EVERY concurrent acquire() for that exact key (including a same-consumer duplicate)
 * waits for it to fully settle -- success, terminal rollback, or a cancellation from a release()
 * that raced in for the same reserving consumer -- before evaluating ownership state at all. This
 * makes concurrent first-owner acquires linearizable without a generic per-key mutex, and
 * deliberately serializes ONLY the instrumentKey in question -- unrelated instruments proceed
 * fully independently.
 *
 * Reconnect restoration is NOT reimplemented here: SubscriptionManager already restores the
 * full physical subscription set exactly once per generation (registerConnectionListeners ->
 * restoreSubscriptions, gated by restoredGenerationId), and the map this class maintains IS the
 * physical union at all times by construction -- acquire() always adds to the underlying
 * SubscriptionManager on first ownership, release() only removes on last ownership -- so that
 * existing restoration already restores the correct union with no changes required here.
 */
export default class SharedSubscriptionRegistry {
  // instrumentKey -> consumerId -> mode
  private readonly owners = new Map<string, Map<string, MarketDataSubscriptionMode>>();
  private readonly pendingFirstOwner = new Map<string, PendingFirstOwner>();

  constructor(private readonly physical: SubscriptionManager) {}

  async acquire(consumerId: string, instrumentKey: string, mode: MarketDataSubscriptionMode): Promise<void> {
    const key = requireInstrumentKey(instrumentKey);
    // Wait behind any in-flight first-owner physical subscribe for this exact key. Ownership
    // state (including whether a first owner even exists yet) is undefined mid-attempt, so every
    // concurrent acquire -- for any consumerId, including the one that started the attempt --
    // must wait for it to fully settle before evaluating anything. Different instrumentKeys never
    // wait on one another.
    let pending = this.pendingFirstOwner.get(key);
    while (pending !== undefined) {
      await pending.promise.catch(() => undefined);
      pending = this.pendingFirstOwner.get(key);
    }

    const consumers = this.owners.get(key);
    const existingMode = consumers?.get(consumerId);
    if (existingMode !== undefined) {
      if (existingMode !== mode) {
        throw new Error(`SharedSubscriptionRegistry: consumer "${consumerId}" already owns "${key}" at mode "${existingMode}"; requested mode "${mode}" conflicts.`);
      }
      return; // Idempotent duplicate request by the same consumer.
    }
    if (consumers && consumers.size > 0) {
      const [firstOwnerMode] = consumers.values();
      if (firstOwnerMode !== mode) {
        throw new Error(`SharedSubscriptionRegistry: "${key}" is already leased by another consumer at mode "${firstOwnerMode}"; mode "${mode}" is not safely mergeable. Refusing to silently downgrade data.`);
      }
      // Not the first owner: physical coverage already exists, so this commits synchronously --
      // no physical call, and therefore nothing further to linearize against.
      consumers.set(consumerId, mode);
      logger.info('SHARED_MARKET_DATA_SUBSCRIPTION_OWNER_ADDED', { instrumentKey: key, mode, consumerId, ownerCount: consumers.size });
      return;
    }

    // As of this synchronous point we are the first owner. Reserve the physical-subscribe slot
    // for this key BEFORE awaiting anything, so a concurrent acquire() arriving at any point
    // before this attempt settles waits on THIS attempt instead of racing it -- and reserve an
    // EMPTY owner map (not yet containing consumerId) so a rollback on terminal failure need not
    // guess whether anyone else was added in the meantime (nobody could have been: they were all
    // waiting on pendingFirstOwner above).
    const ownerMap = new Map<string, MarketDataSubscriptionMode>();
    this.owners.set(key, ownerMap);
    const attempt = (async (): Promise<void> => {
      logger.info('SHARED_MARKET_DATA_SUBSCRIBE', { instrumentKey: key, mode, consumerId });
      await this.physical.subscribe(key, mode);
    })();
    const reservation: PendingFirstOwner = { consumerId, mode, promise: attempt, cancelled: false };
    this.pendingFirstOwner.set(key, reservation);
    try {
      await attempt;
    } catch (error) {
      if (this.owners.get(key) === ownerMap) this.owners.delete(key);
      throw error;
    } finally {
      if (this.pendingFirstOwner.get(key) === reservation) this.pendingFirstOwner.delete(key);
    }
    if (reservation.cancelled) {
      // A release() for this exact consumer arrived while the physical subscribe was still in
      // flight. The subscribe itself succeeded (we are past the await without throwing), so this
      // is a genuine last-owner unsubscribe -- never commit an owner that already asked to leave.
      logger.info('SHARED_MARKET_DATA_UNSUBSCRIBE', { instrumentKey: key, consumerId });
      this.owners.delete(key);
      this.physical.unsubscribe(key);
      return;
    }
    ownerMap.set(consumerId, mode);
  }

  release(consumerId: string, instrumentKey: string): void {
    const key = requireInstrumentKey(instrumentKey);
    const pending = this.pendingFirstOwner.get(key);
    if (pending && pending.consumerId === consumerId) {
      // The reserving consumer's own physical subscribe has not yet settled -- mark it
      // cancelled so acquire() releases immediately once it resolves instead of committing an
      // owner that already asked to leave. Nothing physical to do here: either the subscribe has
      // not happened yet, or acquire()'s own cancellation handling above will undo it.
      pending.cancelled = true;
      return;
    }
    const consumers = this.owners.get(key);
    if (!consumers?.has(consumerId)) return;
    consumers.delete(consumerId);
    if (consumers.size === 0) {
      this.owners.delete(key);
      logger.info('SHARED_MARKET_DATA_UNSUBSCRIBE', { instrumentKey: key, consumerId });
      this.physical.unsubscribe(key);
    } else {
      logger.info('SHARED_MARKET_DATA_SUBSCRIPTION_OWNER_REMOVED', { instrumentKey: key, consumerId, ownerCount: consumers.size });
    }
  }

  releaseAll(consumerId: string): void {
    for (const instrumentKey of this.getOwnedInstrumentKeys(consumerId)) this.release(consumerId, instrumentKey);
    // Also cancel any of this consumer's own first-owner acquires still in flight (not yet
    // committed, so not covered by getOwnedInstrumentKeys() above) -- otherwise a
    // disconnect/releaseAll racing an in-flight acquire could let it commit ownership for a
    // consumer that already left (see acquire()'s reservation.cancelled handling).
    for (const [instrumentKey, pending] of this.pendingFirstOwner) {
      if (pending.consumerId === consumerId) this.release(consumerId, instrumentKey);
    }
  }

  getOwnedInstrumentKeys(consumerId: string): string[] {
    const result: string[] = [];
    for (const [instrumentKey, consumers] of this.owners) if (consumers.has(consumerId)) result.push(instrumentKey);
    return result;
  }

  getOwnedSubscriptions(consumerId: string): MarketDataSubscription[] {
    const result: MarketDataSubscription[] = [];
    for (const [instrumentKey, consumers] of this.owners) {
      const mode = consumers.get(consumerId);
      if (mode !== undefined) result.push({ instrumentKey, mode });
    }
    return result;
  }

  /** Consumers currently leasing `instrumentKey` -- used by the gateway's fan-out router. */
  getOwners(instrumentKey: string): ReadonlySet<string> {
    return new Set(this.owners.get(instrumentKey.trim())?.keys() ?? []);
  }

  /** Number of distinct instruments with at least one active owner -- the current physical subscription count. */
  getPhysicalSubscriptionCount(): number {
    return this.owners.size;
  }
}

function requireInstrumentKey(instrumentKey: string): string {
  const trimmed = instrumentKey.trim();
  if (!trimmed) throw new Error('SharedSubscriptionRegistry: instrumentKey must be a non-empty string.');
  return trimmed;
}
