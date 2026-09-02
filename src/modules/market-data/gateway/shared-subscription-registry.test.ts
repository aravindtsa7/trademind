import assert from 'node:assert/strict';
import test from 'node:test';
import SharedSubscriptionRegistry from './shared-subscription-registry';
import { MarketDataSubscriptionMode } from '../managers/subscription.manager';

class FakePhysicalSubscriptionManager {
  subscribeCalls: Array<{ instrumentKey: string; mode: MarketDataSubscriptionMode }> = [];
  unsubscribeCalls: string[] = [];
  failNextSubscribe = false;

  async subscribe(instrumentKey: string, mode = MarketDataSubscriptionMode.FULL): Promise<void> {
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      throw new Error('SUBSCRIBE_FAILED');
    }
    this.subscribeCalls.push({ instrumentKey, mode });
  }

  unsubscribe(instrumentKey: string): void {
    this.unsubscribeCalls.push(instrumentKey);
  }
}

const NIFTY = 'NSE_INDEX|Nifty 50';

test('scenario 2: three consumers leasing the same instrument send exactly one physical subscribe', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v8', NIFTY, MarketDataSubscriptionMode.FULL);
  assert.equal(physical.subscribeCalls.length, 1);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2', 'v4', 'v8']));
});

test('duplicate acquire by the same consumer/instrument/mode is idempotent', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  assert.equal(physical.subscribeCalls.length, 1);
  assert.equal(registry.getOwnedSubscriptions('v2').length, 1);
});

test('scenario 3: releasing one owner does not unsubscribe while another still owns it', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  registry.release('v4', NIFTY);
  assert.equal(physical.unsubscribeCalls.length, 0);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2']));
});

test('scenario 4: the last owner releasing causes exactly one physical unsubscribe', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  registry.release('v4', NIFTY);
  registry.release('v2', NIFTY);
  assert.deepEqual(physical.unsubscribeCalls, [NIFTY]);
  assert.equal(registry.getOwners(NIFTY).size, 0);
  assert.equal(registry.getPhysicalSubscriptionCount(), 0);
});

test('releasing an instrument a consumer never owned is a harmless no-op', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  registry.release('v2', NIFTY);
  assert.equal(physical.unsubscribeCalls.length, 0);
});

test('scenario 16: a dynamically leased option instrument is reference counted like any other', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const option = 'NSE_FO|12345';
  await registry.acquire('v4', option, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v8', option, MarketDataSubscriptionMode.FULL);
  assert.equal(physical.subscribeCalls.length, 1);
  // One strategy releasing its own leg must not remove the other's feed.
  registry.release('v4', option);
  assert.equal(physical.unsubscribeCalls.length, 0);
  assert.deepEqual(registry.getOwners(option), new Set(['v8']));
  registry.release('v8', option);
  assert.deepEqual(physical.unsubscribeCalls, [option]);
});

test('conflicting subscription modes for the same instrument fail closed rather than silently downgrading data', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await assert.rejects(
    () => registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.LTPC),
    /not safely mergeable/,
  );
  // The rejected consumer never became an owner.
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2']));
});

test('a consumer requesting a conflicting mode for its own already-owned instrument fails closed', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await assert.rejects(() => registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.LTPC));
});

test('a failed first-owner physical subscribe retains no phantom ownership', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  physical.failNextSubscribe = true;
  const registry = new SharedSubscriptionRegistry(physical as never);
  await assert.rejects(() => registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL));
  assert.equal(registry.getOwners(NIFTY).size, 0);
  // A later, successful acquire must still work cleanly.
  await registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  assert.equal(physical.subscribeCalls.length, 1);
});

test('releaseAll releases every instrument owned by exactly one consumer, leaving siblings untouched', async () => {
  const physical = new FakePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  await registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await registry.acquire('v4', 'NSE_FO|1', MarketDataSubscriptionMode.FULL);
  await registry.acquire('v8', NIFTY, MarketDataSubscriptionMode.FULL);
  registry.releaseAll('v4');
  assert.deepEqual(registry.getOwnedInstrumentKeys('v4'), []);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v8']));
  assert.deepEqual(physical.unsubscribeCalls, ['NSE_FO|1']);
});

/**
 * F-04: SharedSubscriptionRegistry must correctly serialize lease state against its physical
 * SubscriptionManager actions -- the physical subscribe is async, and a naive check-then-set
 * lets a second concurrent acquire() for the same instrumentKey observe a synchronously-reserved
 * (but not yet physically confirmed) first owner. ControllablePhysicalSubscriptionManager lets
 * these tests hold a physical subscribe pending indefinitely and resolve/reject it deterministically.
 */
class ControllablePhysicalSubscriptionManager {
  subscribeCalls: Array<{ instrumentKey: string; mode: MarketDataSubscriptionMode }> = [];
  unsubscribeCalls: string[] = [];
  private pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  subscribe(instrumentKey: string, mode = MarketDataSubscriptionMode.FULL): Promise<void> {
    this.subscribeCalls.push({ instrumentKey, mode });
    return new Promise<void>((resolve, reject) => { this.pending.push({ resolve, reject }); });
  }

  unsubscribe(instrumentKey: string): void {
    this.unsubscribeCalls.push(instrumentKey);
  }

  pendingCount(): number { return this.pending.length; }
  resolveOldest(): void { this.pending.shift()?.resolve(); }
  rejectOldest(message = 'SUBSCRIBE_FAILED'): void { this.pending.shift()?.reject(new Error(message)); }
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('F-04 race 1/4: simultaneous first-owner acquires for the same instrument send exactly one physical subscribe', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const v2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  const v4 = registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  // Both callers raced in before the physical subscribe settled -- only ONE physical subscribe
  // may ever have been sent, and neither caller may be a committed owner yet.
  assert.equal(physical.subscribeCalls.length, 1);
  assert.equal(registry.getOwners(NIFTY).size, 0);
  physical.resolveOldest();
  await Promise.all([v2, v4]);
  assert.equal(physical.subscribeCalls.length, 1);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2', 'v4']));
});

test('F-04 race 2/4: a delayed-then-successful first subscribe lets the second acquire wait and succeed afterward', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const v2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  const v4 = registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  assert.equal(physical.subscribeCalls.length, 1); // v4 waited instead of racing its own subscribe
  assert.equal(registry.getOwners(NIFTY).size, 0);
  physical.resolveOldest();
  await Promise.all([v2, v4]);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2', 'v4']));
  assert.equal(physical.subscribeCalls.length, 1);
});

test('F-04 race 3/4: a delayed-then-terminally-rejected first subscribe leaves no phantom owner, and the second acquire performs a valid physical subscribe itself', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const v2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  const v4 = registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  assert.equal(physical.subscribeCalls.length, 1);
  physical.rejectOldest();
  await assert.rejects(v2, /SUBSCRIBE_FAILED/);
  await flush(); // let v4's continuation progress from "waiting" to "became the new first owner"
  // v4 must never inherit v2's rejection, never become a phantom owner, and must perform its
  // OWN, real, physical subscribe rather than reusing v2's failed attempt.
  assert.equal(physical.subscribeCalls.length, 2);
  assert.equal(registry.getOwners(NIFTY).size, 0); // not committed yet -- v4's own subscribe is still pending
  physical.resolveOldest(); // resolves v4's own (now oldest remaining) pending subscribe
  await v4;
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v4']));
  assert.equal(physical.subscribeCalls.length, 2);
});

test('F-04 race 4/4: three concurrent first-owner acquires for the same instrument send exactly one physical subscribe', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const calls = [
    registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL),
    registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL),
    registry.acquire('v8', NIFTY, MarketDataSubscriptionMode.FULL),
  ];
  await flush();
  assert.equal(physical.subscribeCalls.length, 1);
  physical.resolveOldest();
  await Promise.all(calls);
  assert.equal(physical.subscribeCalls.length, 1);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2', 'v4', 'v8']));
});

test('F-04: concurrent last-release + new-acquire leaves a consistent final state with exactly one physical subscribe', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const firstAcquire = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  physical.resolveOldest();
  await firstAcquire;
  assert.equal(physical.subscribeCalls.length, 1);
  registry.release('v2', NIFTY); // last owner releases -- physical unsubscribe fires synchronously
  assert.deepEqual(physical.unsubscribeCalls, [NIFTY]);
  const reacquire = registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  assert.equal(physical.subscribeCalls.length, 2); // a fresh physical subscribe, not reuse of the torn-down one
  physical.resolveOldest();
  await reacquire;
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v4']));
});

test('F-04: a release racing an in-flight first-owner acquire for the SAME consumer leaves no leaked owner', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const acquireV2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  assert.equal(physical.subscribeCalls.length, 1);
  registry.release('v2', NIFTY); // e.g. channel.disconnect() racing the still-pending acquire
  physical.resolveOldest(); // the physical subscribe DID succeed...
  await acquireV2;
  // ...but the release must still win: no leaked/committed owner, and the transient subscription
  // was torn back down rather than left dangling.
  assert.equal(registry.getOwners(NIFTY).size, 0);
  assert.deepEqual(physical.unsubscribeCalls, [NIFTY]);
});

test('F-04: releaseAll cancels an in-flight first-owner acquire for the departing consumer', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const acquireV2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  registry.releaseAll('v2'); // e.g. GatewayMarketDataChannel.disconnect() racing the pending acquire
  physical.resolveOldest();
  await acquireV2;
  assert.equal(registry.getOwners(NIFTY).size, 0);
  assert.deepEqual(physical.unsubscribeCalls, [NIFTY]);
});

test('F-04: two consumers concurrently acquiring the same dynamically-leased option send exactly one physical subscribe', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const option = 'NSE_FO|24600CE';
  const v4 = registry.acquire('v4', option, MarketDataSubscriptionMode.FULL);
  const v8 = registry.acquire('v8', option, MarketDataSubscriptionMode.FULL);
  await flush();
  assert.equal(physical.subscribeCalls.length, 1);
  physical.resolveOldest();
  await Promise.all([v4, v8]);
  assert.deepEqual(registry.getOwners(option), new Set(['v4', 'v8']));
});

test('F-04: a mode-conflict request against an in-flight first-owner acquire fails before mutating committed ownership', async () => {
  const physical = new ControllablePhysicalSubscriptionManager();
  const registry = new SharedSubscriptionRegistry(physical as never);
  const v2 = registry.acquire('v2', NIFTY, MarketDataSubscriptionMode.FULL);
  await flush();
  const conflicting = registry.acquire('v4', NIFTY, MarketDataSubscriptionMode.LTPC);
  physical.resolveOldest();
  await v2;
  await assert.rejects(conflicting, /not safely mergeable/);
  assert.deepEqual(registry.getOwners(NIFTY), new Set(['v2']));
});
