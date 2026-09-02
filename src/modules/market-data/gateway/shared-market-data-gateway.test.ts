import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SharedMarketDataGateway from './shared-market-data-gateway';
import { ConnectionState, ReconnectCircuitSnapshot } from '../managers/connection.manager';
import { MarketDataSubscriptionMode } from '../managers/subscription.manager';
import ProtobufDecoder, { MarketDataFeedResponseDto } from '../protobuf/protobuf.decoder';

const NIFTY = 'NSE_INDEX|Nifty 50';
const OPTION = 'NSE_FO|12345';

/**
 * Models the ONE physical ConnectionManager without exercising its real reconnect-timing logic
 * (already exhaustively covered by connection.manager.test.ts) -- this harness only needs to
 * prove SharedMarketDataGateway's OWN wiring: decode-once, health-evidence centralization, and
 * connection-event broadcast/consumer-isolation.
 */
class FakeConnectionManager extends EventEmitter {
  state: ConnectionState = ConnectionState.DISCONNECTED;
  generation = 0;
  connectCalls = 0;
  disconnectCalls = 0;
  sendCalls: unknown[] = [];
  attempts = 0;
  lastReason: string | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.state === ConnectionState.CONNECTED) return; // mirrors ConnectionManager's own idempotent-connect guard
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
  send(data: unknown): void { this.sendCalls.push(data); }

  confirmRecoveryReady(generationId: number): boolean {
    if (this.state !== ConnectionState.CONNECTED || generationId !== this.generation) return false;
    this.attempts = 0; this.lastReason = null;
    return true;
  }

  confirmTransportReady(generationId: number): boolean { return this.confirmRecoveryReady(generationId); }
  reconnectForHealth(reason: string, generationId: number): boolean {
    if (this.state !== ConnectionState.CONNECTED || generationId !== this.generation) return false;
    this.attempts += 1; this.lastReason = reason;
    return true;
  }
  failRecovery(generationId: number, reason = 'RECOVERY_FAILED'): boolean {
    if (generationId !== this.generation) return false;
    this.lastReason = reason;
    return true;
  }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot {
    return { state: 'CLOSED', attempts: this.attempts, lastFailureReason: this.lastReason, activeGenerationId: this.generation, pendingRecoveryGenerationId: null, reconnectEpisodeActive: false, nextRetryAtMs: null };
  }

  // --- test-only helpers simulating the real ConnectionManager's own event contract ---
  simulateUnexpectedDisconnect(details: Record<string, unknown> = {}): void {
    this.state = ConnectionState.RECONNECTING;
    this.emit('unexpectedDisconnect', { generationId: this.generation, ...details });
  }
  simulateReconnected(): void {
    this.generation += 1;
    this.state = ConnectionState.CONNECTED;
    this.emit('reconnected', { generationId: this.generation });
  }
  simulateReconnectFailed(details: Record<string, unknown> = {}): void {
    this.state = ConnectionState.DISCONNECTED;
    this.emit('reconnectFailed', { generationId: this.generation, ...details });
  }
  simulateMessage(payload: MarketDataFeedResponseDto): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)), { generationId: this.generation });
  }
}

class PassthroughDecoder {
  decode(buffer: Buffer): MarketDataFeedResponseDto {
    return JSON.parse(buffer.toString('utf8')) as MarketDataFeedResponseDto;
  }
}

function tickFeed(instrumentKey: string, ltp: number): MarketDataFeedResponseDto {
  const ts = new Date().toISOString();
  return { type: 'live_feed', currentTs: ts, feeds: { [instrumentKey]: { ltpc: { ltp, ltt: ts, ltq: '1', cp: ltp } } } } as unknown as MarketDataFeedResponseDto;
}

function depthFeed(instrumentKey: string, bidPrice: number): MarketDataFeedResponseDto {
  const ts = new Date().toISOString();
  return {
    type: 'live_feed',
    currentTs: ts,
    feeds: { [instrumentKey]: { fullFeed: { marketFF: { marketLevel: { bidAskQuote: [{ bidQ: '1', bidP: bidPrice, askQ: '1', askP: bidPrice + 1 }] } } } } },
  } as unknown as MarketDataFeedResponseDto;
}

function createGateway(): { gateway: SharedMarketDataGateway; connection: FakeConnectionManager } {
  const connection = new FakeConnectionManager();
  const gateway = new SharedMarketDataGateway({
    accessToken: 'test-token',
    connectionManager: connection as never,
    decoder: new PassthroughDecoder() as unknown as ProtobufDecoder,
    isSourceFresh: () => true,
    healthMonitorOptions: { isMarketSession: () => true, stallMs: 60_000, heartbeatCheckMs: 60_000, generationGraceMs: 1 },
  });
  return { gateway, connection };
}

test('scenario 1: three consumers share one physical connect/socket ownership path', async () => {
  const { gateway, connection } = createGateway();
  gateway.registerConsumer('v2');
  gateway.registerConsumer('v4');
  gateway.registerConsumer('v8');
  await gateway.start();
  await gateway.start(); // idempotent -- a second start() must not open a second socket
  assert.equal(connection.connectCalls, 1);
  assert.equal(gateway.getActiveConsumerCount(), 3);
});

test('scenario 6/7: a decoded NIFTY tick fans out once to each subscribed consumer, and not to an unsubscribed one', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  const v8 = gateway.registerConsumer('v8');
  await gateway.start();
  await v2.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  await v4.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  // v8 deliberately does not subscribe to NIFTY.
  const received: Record<string, number> = { v2: 0, v4: 0, v8: 0 };
  v2.on('market.tick', () => { received.v2 += 1; });
  v4.on('market.tick', () => { received.v4 += 1; });
  v8.on('market.tick', () => { received.v8 += 1; });
  connection.simulateMessage(tickFeed(NIFTY, 24500));
  assert.equal(received.v2, 1);
  assert.equal(received.v4, 1);
  assert.equal(received.v8, 0);
});

test('a consumer receives depth events only for instruments it owns', async () => {
  const { gateway, connection } = createGateway();
  const v8 = gateway.registerConsumer('v8');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  await v8.subscribe(OPTION, MarketDataSubscriptionMode.FULL);
  let v8Depth = 0; let v4Depth = 0;
  v8.on('market.depth', () => { v8Depth += 1; });
  v4.on('market.depth', () => { v4Depth += 1; });
  connection.simulateMessage(depthFeed(OPTION, 100));
  assert.equal(v8Depth, 1);
  assert.equal(v4Depth, 0);
});

test('fan-out events are cloned -- one consumer mutating its event cannot affect a sibling', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  await v2.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  await v4.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  let v4Ltp: number | undefined;
  v2.on('market.tick', (event: { ltp?: number }) => { event.ltp = -1; });
  v4.on('market.tick', (event: { ltp?: number }) => { v4Ltp = event.ltp; });
  connection.simulateMessage(tickFeed(NIFTY, 24500));
  assert.equal(v4Ltp, 24500);
});

test('scenario 9/10: physical generationId is preserved identically across consumer events, including across a reconnect', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  await v2.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  await v4.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  const v2Generations: Array<number | undefined> = [];
  const v4Generations: Array<number | undefined> = [];
  v2.on('market.tick', (event: { generationId?: number }) => v2Generations.push(event.generationId));
  v4.on('market.tick', (event: { generationId?: number }) => v4Generations.push(event.generationId));
  connection.simulateMessage(tickFeed(NIFTY, 100));
  assert.equal(v2Generations[0], gateway.getGenerationId());
  assert.equal(v2Generations[0], 1);
  assert.equal(v4Generations[0], 1);
  connection.simulateReconnected();
  assert.equal(gateway.getGenerationId(), 2);
  connection.simulateMessage(tickFeed(NIFTY, 101));
  // Every active consumer observes the identical new physical generationId -- no synthetic
  // per-strategy generation counter exists. Whether a specific consumer treats a given
  // generationId as "current" for ITS OWN recovery purposes (isCurrentLiveGeneration) is a
  // downstream, per-consumer concern this gateway does not decide.
  assert.equal(v2Generations[1], 2);
  assert.equal(v4Generations[1], 2);
});

test('scenario 15: a genuine physical breaker open propagates to every active consumer', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  let v2Faulted = false; let v4Faulted = false;
  v2.on('reconnectFailed', () => { v2Faulted = true; });
  v4.on('reconnectFailed', () => { v4Faulted = true; });
  connection.simulateReconnectFailed({ reason: 'RECONNECT_EXHAUSTED' });
  assert.equal(v2Faulted, true);
  assert.equal(v4Faulted, true);
});

test('a consumer-scoped failRecovery() faults only that consumer and never touches the physical connection', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  let v2Faulted = false; let v4Faulted = false;
  v2.on('reconnectFailed', () => { v2Faulted = true; });
  v4.on('reconnectFailed', () => { v4Faulted = true; });
  const result = v2.failRecovery(gateway.getGenerationId(), 'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
  assert.equal(result, true);
  assert.equal(v2Faulted, true);
  assert.equal(v4Faulted, false);
  assert.equal(connection.disconnectCalls, 0);
});

test('scenario 17: one consumer disconnecting does not disconnect the gateway or affect siblings', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  await v2.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  await v4.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  v2.disconnect();
  assert.equal(connection.disconnectCalls, 0);
  assert.equal(gateway.getState(), 'RUNNING');
  assert.equal(gateway.getActiveConsumerCount(), 1);
  // v2's own lease was released; v4's NIFTY feed must still work.
  let v4Ticks = 0;
  v4.on('market.tick', () => { v4Ticks += 1; });
  connection.simulateMessage(tickFeed(NIFTY, 100));
  assert.equal(v4Ticks, 1);
  // v2 must no longer receive anything, including a later broadcast connection event.
  let v2Reconnected = false;
  v2.on('reconnected', () => { v2Reconnected = true; });
  connection.simulateReconnected();
  assert.equal(v2Reconnected, false);
});

test('scenario 18: the central runtime shutdown disconnects the physical transport exactly once', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  await gateway.start();
  v2.disconnect();
  v4.disconnect();
  gateway.shutdown();
  gateway.shutdown(); // idempotent -- a duplicate central shutdown call must not disconnect twice
  assert.equal(connection.disconnectCalls, 1);
});

test('scenario 19: releasing subscriptions and calling disconnect twice on the same consumer is idempotent (SIGINT/SIGTERM race safety)', async () => {
  const { gateway } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  await gateway.start();
  await v2.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  v2.disconnect();
  v2.disconnect();
  assert.equal(gateway.getActiveConsumerCount(), 0);
});

test('registering a consumer after the transport is already CONNECTED still delivers exactly one connected notification', async () => {
  const { gateway } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  await gateway.start();
  const v4 = gateway.registerConsumer('v4'); // registers late, after CONNECTED
  let v4Connected = 0;
  v4.on('connected', () => { v4Connected += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v4Connected, 1);
  void v2;
});

test('a consumer not subscribed to any instrument receives no tick traffic at all', async () => {
  const { gateway, connection } = createGateway();
  const v8 = gateway.registerConsumer('v8');
  await gateway.start();
  let ticks = 0;
  v8.on('market.tick', () => { ticks += 1; });
  connection.simulateMessage(tickFeed(NIFTY, 100));
  assert.equal(ticks, 0);
});

test('transport health evidence (confirmRecoveryReady) is centralized: a consumer channel can only read it, never independently confirm it', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  await gateway.start();
  assert.equal(gateway.isTransportHealthy(gateway.getGenerationId()), false);
  connection.simulateMessage(tickFeed(NIFTY, 100));
  assert.equal(gateway.isTransportHealthy(gateway.getGenerationId()), true);
  assert.equal(v2.confirmRecoveryReady(gateway.getGenerationId()), true);
  // A stale/older generation must never read as healthy.
  assert.equal(v2.confirmRecoveryReady(gateway.getGenerationId() - 1 || 0), false);
});

/**
 * F-03: startup ownership guard. test-live-paper-trading.ts / test-live-v4-nifty-momentum-shadow.ts /
 * test-live-v8-nifty-bullish-reclaim-shadow.ts each now wrap their entire run(options) body in
 * exactly this pattern: `runtimeOwnsChannel` starts false, flips true only once startup reaches
 * its durable live-ownership point (host RUNNING), and a `finally` releases options.channel on
 * every other exit -- an early return (outside session, warmup/readiness blocked) or any thrown
 * initialization error. These tests prove the PATTERN's mechanics against a REAL
 * SharedMarketDataGateway/GatewayMarketDataChannel (the monolithic run() scripts themselves pull
 * in live Prisma/Upstox-backed dependencies and are not unit-testable in isolation).
 */
async function simulateRunnerStartup(channel: ReturnType<SharedMarketDataGateway['registerConsumer']>, body: (setOwned: () => void) => Promise<void>): Promise<void> {
  let runtimeOwnsChannel = false;
  try {
    await body(() => { runtimeOwnsChannel = true; });
  } finally {
    if (!runtimeOwnsChannel) channel.disconnect();
  }
}

test('F-03: an early return before ownership (e.g. outside-session / warmup-blocked) releases the channel', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start();
  await simulateRunnerStartup(channel, async () => {
    // e.g. "outside NSE session" / "warmup not fresh" -- returns before ever calling setOwned().
    return;
  });
  assert.equal(channel.isActive(), false);
  assert.equal(gateway.getActiveConsumerCount(), 0);
});

test('F-03: a thrown initialization error before ownership releases the channel and still propagates', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v8');
  await gateway.start();
  await assert.rejects(
    simulateRunnerStartup(channel, async () => {
      throw new Error('V8_STARTUP_READINESS_BLOCKED');
    }),
    /V8_STARTUP_READINESS_BLOCKED/,
  );
  assert.equal(channel.isActive(), false);
  assert.equal(gateway.getActiveConsumerCount(), 0);
});

test('F-03: successful startup that reaches ownership is NOT released merely because the async setup function itself returns', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v2');
  await gateway.start();
  await simulateRunnerStartup(channel, async (setOwned) => {
    setOwned(); // host reached RUNNING
    // The real runner keeps running afterward via listeners/timers registered on `channel`.
  });
  assert.equal(channel.isActive(), true);
  assert.equal(gateway.getActiveConsumerCount(), 1);
});

test('F-03: channel.disconnect() called both by a fault path and by the ownership-guard finally is idempotent', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start();
  let deregisterEvents = 0;
  gateway.on('consumerDeregistered', () => { deregisterEvents += 1; });
  await simulateRunnerStartup(channel, async () => {
    // Mirrors a host.start() fault whose onFault hook already released the channel via its own
    // shutdown() close-out before the ownership guard's finally runs.
    channel.disconnect();
    throw new Error('STARTUP_READINESS_TIMEOUT');
  }).catch(() => undefined);
  assert.equal(channel.isActive(), false);
  assert.equal(deregisterEvents, 1, 'deregistration must fire exactly once despite two disconnect() calls');
});

test('F-03: if gateway.start() throws, every registered consumer channel is released centrally', async () => {
  const { gateway, connection } = createGateway();
  connection.connect = async () => { throw new Error('AUTH_REJECTED'); };
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  const v8 = gateway.registerConsumer('v8');
  const registeredChannels = [v2, v4, v8];
  await assert.rejects(async () => {
    try {
      await gateway.start();
    } catch (error) {
      registeredChannels.forEach((channel) => channel.disconnect());
      throw error;
    }
  }, /AUTH_REJECTED/);
  assert.equal(v2.isActive(), false);
  assert.equal(v4.isActive(), false);
  assert.equal(v8.isActive(), false);
  assert.equal(gateway.getActiveConsumerCount(), 0);
});

test('F-03: one consumer failing startup does not disconnect a sibling that already reached ownership', async () => {
  const { gateway } = createGateway();
  const healthySibling = gateway.registerConsumer('v2');
  const failingConsumer = gateway.registerConsumer('v4');
  await gateway.start();
  await simulateRunnerStartup(healthySibling, async (setOwned) => { setOwned(); });
  await simulateRunnerStartup(failingConsumer, async () => { /* warmup-blocked early return */ });
  assert.equal(healthySibling.isActive(), true, 'a sibling that already reached ownership must not be disconnected merely because another consumer failed startup');
  assert.equal(failingConsumer.isActive(), false);
  assert.equal(gateway.getActiveConsumerCount(), 1);
});

test('F-03: gateway shuts down exactly once after every registered consumer releases (mirrors the combined runner\'s consumerDeregistered -> shutdown wiring)', async () => {
  const { gateway, connection } = createGateway();
  const v2 = gateway.registerConsumer('v2');
  const v4 = gateway.registerConsumer('v4');
  let shutdownStarted = false;
  gateway.on('consumerDeregistered', ({ remainingConsumers }: { remainingConsumers: number }) => {
    if (remainingConsumers > 0 || shutdownStarted) return;
    shutdownStarted = true;
    gateway.shutdown();
  });
  await gateway.start();
  await simulateRunnerStartup(v2, async () => { /* early return, e.g. outside session */ });
  assert.equal(gateway.getState(), 'RUNNING', 'one remaining live consumer must keep the shared transport up');
  assert.equal(connection.disconnectCalls, 0);
  await simulateRunnerStartup(v4, async () => { /* early return too */ });
  assert.equal(gateway.getState(), 'STOPPED');
  assert.equal(connection.disconnectCalls, 1);
});
