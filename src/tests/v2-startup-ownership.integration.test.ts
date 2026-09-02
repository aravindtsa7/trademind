import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SharedMarketDataGateway from '../modules/market-data/gateway/shared-market-data-gateway';
import { ConnectionState, ReconnectCircuitSnapshot } from '../modules/market-data/managers/connection.manager';

/**
 * F-03 targeted regression for test-live-paper-trading.ts's run().
 *
 * Terra proved the real defect was ORDERING, not the ownership pattern itself: the V2
 * outside-session early return sat BEFORE `let runtimeOwnsChannel = false; try { ... }`, so it
 * returned without ever reaching the finally that releases options.channel. The generic
 * `simulateRunnerStartup` pattern helper in shared-market-data-gateway.test.ts models the
 * ownership PATTERN in the abstract and cannot prove this file's own function actually
 * implements it in the right order -- only exercising the real, unmodified `run()` export can.
 *
 * These tests do exactly that: they import the real `run()` from ./test-live-paper-trading and
 * drive it against a real SharedMarketDataGateway/GatewayMarketDataChannel pair (only the
 * physical WebSocket/ConnectionManager are faked, matching the existing accepted convention in
 * shared-market-data-gateway.test.ts). The wall clock is pinned to a fixed outside-session
 * instant so isLikelyMarketSession(new Date()) is deterministic regardless of when this suite
 * runs -- no Prisma, no Upstox, no live network/database dependency.
 */

class FakeConnectionManager extends EventEmitter {
  state: ConnectionState = ConnectionState.DISCONNECTED;
  generation = 0;
  disconnectCalls = 0;

  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED) return;
    this.generation += 1;
    this.state = ConnectionState.CONNECTED;
    this.emit('connected', { generationId: this.generation });
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.state = ConnectionState.DISCONNECTED;
  }

  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  send(): void {}
  confirmRecoveryReady(): boolean { return false; }
  confirmTransportReady(): boolean { return false; }
  reconnectForHealth(): boolean { return false; }
  failRecovery(): boolean { return false; }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot {
    return { state: 'CLOSED', attempts: 0, lastFailureReason: null, activeGenerationId: this.generation, pendingRecoveryGenerationId: null, reconnectEpisodeActive: false, nextRetryAtMs: null };
  }
}

function createGateway(): SharedMarketDataGateway {
  return new SharedMarketDataGateway({
    accessToken: 'TEST_TOKEN_V2_STARTUP_OWNERSHIP',
    connectionManager: new FakeConnectionManager() as never,
    healthMonitorOptions: { isMarketSession: () => true, stallMs: 60_000, heartbeatCheckMs: 60_000, generationGraceMs: 1 },
  });
}

/**
 * Pins `new Date()` (zero-argument calls only) to a fixed instant for the duration of `fn`, then
 * restores the real clock. Every other `new Date(...)` call (e.g. the NSE session calendar's own
 * internal boundary construction) is forwarded to the real Date constructor untouched, and the
 * constructed instances remain genuine `instanceof (patched global) Date`, which
 * NseSessionCalendar.boundaryFor() itself asserts. Scoped to this test file's own process --
 * node:test isolates each test file into a separate process, so this never leaks to siblings.
 */
function withFixedClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedMs);
      // Every non-zero-arg call in this codebase's session-calendar path constructs from a
      // single ISO string (see nse-session-calendar.service.ts's istDateTime) -- forwarded
      // untouched to the real Date constructor so those computations stay unaffected.
      else super(args[0] as string);
    }
    static now(): number { return fixedMs; }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
  return fn().finally(() => {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  });
}

// Sunday 2026-01-04, 12:00 IST -- outside the NSE derivatives session on BOTH weekday and
// time-of-day grounds, so isWithinNseSession(...) is unambiguously false.
const OUTSIDE_SESSION_ISO = '2026-01-04T12:00:00+05:30';

// Set before the first dynamic import of test-live-paper-trading.ts below, so its own top-level
// `import 'dotenv/config'` (which never overwrites an already-set process.env value) cannot
// leave UPSTOX_ACCESS_TOKEN unset. The value itself is never used to reach a real network call --
// the outside-session return in run() happens before any connection/subscription is attempted.
process.env.UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN?.trim() || 'TEST_TOKEN_V2_STARTUP_OWNERSHIP';

test('F-03 (real run()): V2 outside-session early return now sits inside the ownership try/finally and releases its shared-gateway channel exactly once', async () => {
  const { run } = await import('./test-live-paper-trading');
  const gateway = createGateway();
  const channel = gateway.registerConsumer('paper:v2');
  let deregisterEvents = 0;
  gateway.on('consumerDeregistered', () => { deregisterEvents += 1; });
  await gateway.start();

  await withFixedClock(OUTSIDE_SESSION_ISO, () => run({ channel, strategyVersion: 'V2' }));

  assert.equal(channel.isActive(), false, 'the outside-session return must release the channel');
  assert.equal(gateway.getActiveConsumerCount(), 0);
  assert.equal(deregisterEvents, 1, 'deregistration must fire exactly once');

  // Idempotency, exercised against the SAME real channel run() above already released -- mirrors
  // a duplicate release racing in from a fault path.
  channel.disconnect();
  assert.equal(deregisterEvents, 1, 'a second disconnect() on an already-released channel must not re-fire deregistration');

  gateway.shutdown();
});

test('F-03 (real run()): gateway shuts down exactly once once V2 (via real run()) and its siblings all release', async () => {
  const { run } = await import('./test-live-paper-trading');
  const gateway = createGateway();
  const v2Channel = gateway.registerConsumer('paper:v2');
  const v4Channel = gateway.registerConsumer('shadow:v4:momentum');
  const v8Channel = gateway.registerConsumer('shadow:v8:reclaim');
  let shutdownCalls = 0;
  gateway.on('consumerDeregistered', ({ remainingConsumers }: { remainingConsumers: number }) => {
    if (remainingConsumers > 0) return;
    shutdownCalls += 1;
    gateway.shutdown();
  });
  await gateway.start();

  await withFixedClock(OUTSIDE_SESSION_ISO, () => run({ channel: v2Channel, strategyVersion: 'V2' }));
  assert.equal(gateway.getState(), 'RUNNING', 'active siblings must keep the shared transport up after V2 alone releases');
  assert.equal(gateway.getActiveConsumerCount(), 2);

  v4Channel.disconnect();
  assert.equal(gateway.getState(), 'RUNNING', 'one remaining live consumer must still keep the shared transport up');

  v8Channel.disconnect();
  assert.equal(gateway.getState(), 'STOPPED');
  assert.equal(shutdownCalls, 1, 'gateway shutdown must fire exactly once, only after the last consumer releases');
});
