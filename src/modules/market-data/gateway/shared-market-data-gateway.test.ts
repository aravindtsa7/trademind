import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SharedMarketDataGateway from './shared-market-data-gateway';
import { ConnectionState, ReconnectCircuitSnapshot } from '../managers/connection.manager';
import { MarketDataSubscriptionMode } from '../managers/subscription.manager';
import ProtobufDecoder, { MarketDataFeedResponseDto } from '../protobuf/protobuf.decoder';
import MarketDataRecoveryCoordinatorService from '../services/market-data-recovery-coordinator.service';

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
    // Mirrors the real ConnectionManager's registerClientListeners() 'connected' handler, which
    // emits 'connected' unconditionally on every physical open (cold start AND reconnect alike)
    // and then 'reconnected' immediately afterward when wasReconnecting -- see connection.manager.ts.
    this.emit('connected', { generationId: this.generation });
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

/**
 * ==========================================================================================
 * SHARED GATEWAY STARTUP-GENERATION HANDOFF HOTFIX -- regression suite.
 *
 * Reproduced defect: SharedMarketDataGateway.registerConsumer() is called BEFORE gateway.start()
 * in the combined runtime (see test-live-shared-market-data-gateway.ts), and each strategy's
 * recovery listener (`connection.on('connected', ...)` in test-live-paper-trading.ts /
 * test-live-v4-nifty-momentum-shadow.ts / test-live-v8-nifty-bullish-reclaim-shadow.ts, where
 * `connection` is the leased GatewayMarketDataChannel in shared-gateway mode) is only attached
 * AFTER its own slow startup work (warmup/backfill), which itself only runs AFTER gateway.start()
 * has already resolved. On a1001e3, GatewayMarketDataChannel is a plain EventEmitter with no
 * memory of a 'connected' broadcast that already fired before any listener existed -- the event
 * is lost forever until the next physical reconnect, so MarketDataRecoveryCoordinatorService never
 * learns the current generation and eventually times out FAULTED despite live ticks flowing (the
 * proven live V4 945000ms FAULTED transition). See GatewayMarketDataChannel's own class doc for
 * the fix: a sticky current-generation snapshot, seeded atomically at registerConsumer() time and
 * kept current independent of listener existence, replayed exactly once (race-safe against a
 * disconnect/reconnect or disconnect() release) to any 'connected' listener attached late.
 * ==========================================================================================
 */

test('CASE A (fails-safe baseline): a listener attached BEFORE the physical connect observes the initial generation exactly once, with no replay involved', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await gateway.start();
  // Drain any microtask the handoff mechanism might (wrongly) have scheduled -- there must be
  // none: currentConnectedGenerationId was still null at listener-attachment time.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1], 'a listener attached before connect must receive exactly one live delivery, never a duplicate from the handoff');
});

test('CASE B (REGRESSION -- fails on a1001e3): a recovery listener attached only AFTER the shared transport is already CONNECTED still observes the current generation, without waiting for the next reconnect', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4'); // registered before start(), exactly like the combined runtime.
  await gateway.start(); // physical CONNECTED at generation 1 -- broadcasts 'connected' to nobody yet.
  // Models each strategy runner's own slow startup (historical warmup/backfill/DB reads) that on
  // a1001e3 runs to completion BEFORE `connection.on('connected', ...)` is ever wired -- see
  // test-live-v4-nifty-momentum-shadow.ts's warmUp() call preceding its recovery listener wiring.
  await new Promise((resolve) => setImmediate(resolve));
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  // On a1001e3 this is [] forever (no further reconnect ever occurs in this test) -- the exact
  // reproduced defect. After the hotfix it must be [1], delivered without any reconnect.
  assert.deepEqual(received, [1], 'a late-attached listener must observe the CURRENT physical generation exactly once, and its own generationId must match the real physical generation');
});

test('three consumers attaching at different times (before connect, immediately after, and after a delay) each independently observe the identical current physical generation exactly once', async () => {
  const { gateway } = createGateway();
  const early = gateway.registerConsumer('early');
  const earlyReceived: number[] = [];
  early.on('connected', (details: { generationId: number }) => earlyReceived.push(details.generationId));

  await gateway.start(); // generation 1

  const immediate = gateway.registerConsumer('immediate');
  const immediateReceived: number[] = [];
  immediate.on('connected', (details: { generationId: number }) => immediateReceived.push(details.generationId));

  const delayed = gateway.registerConsumer('delayed');
  await new Promise((resolve) => setImmediate(resolve));
  const delayedReceived: number[] = [];
  delayed.on('connected', (details: { generationId: number }) => delayedReceived.push(details.generationId));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(earlyReceived, [1]);
  assert.deepEqual(immediateReceived, [1]);
  assert.deepEqual(delayedReceived, [1]);
});

test('CASE C: a disconnect/reconnect racing the late-listener handoff never replays the obsolete generation -- the listener converges on the true current generation only', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  // Race: before the queued microtask handoff for generation 1 can fire, the physical connection
  // drops and reconnects to generation 2 -- all synchronously, ahead of the already-scheduled
  // microtask.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2 (emits 'connected' then 'reconnected')
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [2], 'the stale generation-1 handoff must never be delivered once generation 2 is authoritative -- only the true current generation may reach the listener');
});

test('CASE D: after a late-listener handoff delivers the initial generation, a subsequent real reconnect still delivers the next generation normally through the same listener', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve)); // let the generation-1 handoff replay fire
  assert.deepEqual(received, [1]);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2
  assert.deepEqual(received, [1, 2], 'reconnect generation progression must remain intact after a late-listener handoff -- no duplicate/synthetic generation');
});

test('CASE E: a consumer released before the queued handoff replay fires receives no late notification', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  channel.disconnect(); // released before the microtask runs
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [], 'a released consumer must never receive a replayed/future connection notification');
});

test('a listener removed via off() before the queued handoff replay fires is never invoked (EventEmitter cleanup semantics preserved)', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  let calls = 0;
  const listener = () => { calls += 1; };
  channel.on('connected', listener);
  channel.off('connected', listener);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'a listener detached before the handoff replay fires must never be invoked');
});

test('READINESS SAFETY: the connection-generation handoff alone never grants recovery readiness -- a live current-generation tick is still required (CASE F)', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any recovery listener exists
  const recovery = new MarketDataRecoveryCoordinatorService({ backfill: async () => ({ ready: true, reason: 'FRESH', missingMinutes: 0, duplicateMinutes: 0 }) });
  channel.on('connected', (details: { generationId: number }) => recovery.handleInitialConnected({ generationId: details.generationId }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recovery.getGenerationId(), 1, 'the coordinator must have learned the current generation via the handoff');
  assert.equal(recovery.isEvaluationReady(), false, 'connection handoff alone must never grant readiness -- subscription/connection evidence is not market-data readiness evidence');
});

test('READINESS SAFETY: a stale-generation tick cannot satisfy the recovery gate after a reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start();
  const recovery = new MarketDataRecoveryCoordinatorService({ backfill: async () => ({ ready: true, reason: 'FRESH', missingMinutes: 0, duplicateMinutes: 0 }) });
  channel.on('unexpectedDisconnect', (details: Record<string, unknown>) => recovery.handleUnexpectedDisconnect(details));
  channel.on('reconnected', (details: Record<string, unknown>) => recovery.handleReconnected(details));
  channel.on('connected', (details: { generationId: number }) => recovery.handleInitialConnected({ generationId: details.generationId }));
  await new Promise((resolve) => setImmediate(resolve)); // handoff delivers generation 1
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2
  assert.equal(recovery.getGenerationId(), 2);
  recovery.handleLiveTick({ sourceTimestamp: new Date(), receivedAt: new Date(), generationId: 1 }); // stale
  assert.equal(recovery.isEvaluationReady(), false, 'a stale-generation tick must never satisfy readiness');
});

test('CASE G / higher-level ordering regression: a recovery listener attached only after gateway.start() still reaches READY normally once a genuine current-generation NIFTY tick arrives, permitting host READY -> RUNNING', async () => {
  const { gateway, connection } = createGateway();
  const v4Channel = gateway.registerConsumer('shadow:v4:momentum');
  await gateway.start(); // exact combined-runtime ordering: register -> physical connect -> ...

  // ... -> delay strategy recovery listener attachment (models warmup/backfill completing first) -> ...
  await new Promise((resolve) => setImmediate(resolve));

  const recovery = new MarketDataRecoveryCoordinatorService({ backfill: async () => ({ ready: true, reason: 'FRESH', missingMinutes: 0, duplicateMinutes: 0 }) });
  // ... -> install recovery handoff (byte-identical in shape to every V2/V4/V8 runner's own wiring) -> ...
  v4Channel.on('unexpectedDisconnect', (details: Record<string, unknown>) => recovery.handleUnexpectedDisconnect(details));
  v4Channel.on('reconnected', (details: Record<string, unknown>) => recovery.handleReconnected(details));
  v4Channel.on('connected', (details: { generationId: number }) => recovery.handleInitialConnected({ generationId: details.generationId }));
  v4Channel.on('market.tick', (event: { generationId?: number; instrumentKey: string; timestamp?: string }) => {
    if (event.generationId !== v4Channel.getGenerationId() || event.instrumentKey !== NIFTY) return; // stale-generation guard, mirrors isCurrentLiveGeneration
    recovery.handleLiveTick({ sourceTimestamp: new Date(event.timestamp ?? Date.now()), receivedAt: new Date(), generationId: event.generationId });
  });

  // ... -> subscribe -> ...
  await v4Channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recovery.getGenerationId(), 1, 'the handoff must have already seeded the coordinator with the current generation');
  assert.equal(recovery.isEvaluationReady(), false, 'must not be ready before any live tick has arrived');

  // ... -> emit valid NIFTY current-generation event -> waitUntilReady resolves -> ...
  const ready = recovery.waitUntilReady(5_000);
  connection.simulateMessage(tickFeed(NIFTY, 24500));
  await ready;

  // ... -> host is permitted to transition READY -> RUNNING.
  assert.equal(recovery.isEvaluationReady(), true, 'a genuine current-generation NIFTY tick after the handoff must still satisfy the existing recovery gate normally');
});

/**
 * ==========================================================================================
 * TERRA F-01 CORRECTION -- EventEmitter-contract regression suite.
 *
 * Terra High rejected the original hotfix on 5 concrete EventEmitter-contract grounds (probe:
 * on->[1], addListener->[1], once->[1], prependListener->[], thisIsChannel->false):
 *  1. the sticky replay invoked `listener({ generationId })` as a plain call, so a normal
 *     `function` listener saw `this === undefined` instead of `this === channel`.
 *  2/3. prependListener()/prependOnceListener() were never overridden, so a listener attached
 *     through either silently received NO handoff at all -- Node does not route them through
 *     on()/addListener().
 *  4. the source comment claiming prependOnceListener() routed through on() was false.
 *  5. a throwing replay callback would escape queueMicrotask as an unhandled exception, with no
 *     containment matching SharedMarketDataGateway.broadcast()'s own try/catch philosophy.
 * Terra separately asked for scrutiny of internal sticky-state safety: the original
 * implementation tracked currentConnectedGenerationId via ordinary super.on(...) listeners on
 * this channel's OWN public 'connected'/'unexpectedDisconnect'/'reconnectFailed' events -- fully
 * removable by legitimate consumer-code cleanup (removeAllListeners()/removeListener()/etc),
 * which could silently corrupt every future handoff.
 *
 * All five are corrected in gateway-market-data-channel.ts:
 *  - scheduleHandoffReplay() now invokes `listener.call(this, { generationId })`.
 *  - prependListener() is now an explicit override (verified, not assumed, that
 *    prependOnceListener() routes through it).
 *  - the throwing-listener invocation is wrapped in try/catch, logged via the existing
 *    `logger.error` convention.
 *  - sticky-state tracking moved entirely off removable public listeners into
 *    acceptPhysicalLifecycleEvent(), callable only by SharedMarketDataGateway.broadcast().
 * ==========================================================================================
 */

test('EVENTEMITTER CONTRACT (Terra repro): late on() delivers the current generation via the handoff, with this === channel for a normal function listener', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const captured: { observedThis?: unknown } = {};
  const received: number[] = [];
  channel.on('connected', function connectedListener(this: unknown, details: { generationId: number }) {
    captured.observedThis = this;
    received.push(details.generationId);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1]);
  assert.equal(captured.observedThis, channel, 'this === channel must hold for a normal function listener delivered via the sticky replay, matching ordinary emit() semantics');
});

test('EVENTEMITTER CONTRACT: late addListener() delivers the current generation via the handoff, with this === channel', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start();
  const captured: { observedThis?: unknown } = {};
  const received: number[] = [];
  channel.addListener('connected', function connectedListener(this: unknown, details: { generationId: number }) {
    captured.observedThis = this;
    received.push(details.generationId);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1]);
  assert.equal(captured.observedThis, channel);
});

test('EVENTEMITTER CONTRACT (Terra repro): late prependListener() delivers the current generation via the handoff, with this === channel, and remains persistent across a later reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const captured: { observedThis?: unknown } = {};
  const received: number[] = [];
  channel.prependListener('connected', function connectedListener(this: unknown, details: { generationId: number }) {
    captured.observedThis = this;
    received.push(details.generationId);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1], 'prependListener() must receive the sticky handoff exactly like on() -- Terra found this returned [] on the rejected hotfix');
  assert.equal(captured.observedThis, channel);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2
  assert.deepEqual(received, [1, 2], 'a persistent prependListener() must still receive a later reconnect normally, exactly like on()');
});

test('EVENTEMITTER CONTRACT (Terra repro): late once() delivers the current generation exactly once, with this === channel, and never fires again on a later reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const captured: { observedThis?: unknown } = {};
  let calls = 0;
  const received: number[] = [];
  channel.once('connected', function connectedListener(this: unknown, details: { generationId: number }) {
    calls += 1;
    captured.observedThis = this;
    received.push(details.generationId);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(received, [1]);
  assert.equal(captured.observedThis, channel, 'once() replay must preserve this === channel for a normal function listener');
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2
  assert.equal(calls, 1, 'a once() listener consumed by the sticky replay must not fire again on a later reconnect -- normal once-removal semantics must be preserved');
});

test('EVENTEMITTER CONTRACT (Terra repro): late prependOnceListener() delivers the current generation exactly once, with this === channel, and never fires again on a later reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1, before any listener exists
  const captured: { observedThis?: unknown } = {};
  let calls = 0;
  const received: number[] = [];
  channel.prependOnceListener('connected', function connectedListener(this: unknown, details: { generationId: number }) {
    calls += 1;
    captured.observedThis = this;
    received.push(details.generationId);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(received, [1], 'prependOnceListener() must receive the sticky handoff -- Terra found this silently missing on the rejected hotfix');
  assert.equal(captured.observedThis, channel);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2
  assert.equal(calls, 1, 'a prependOnceListener() listener consumed by the sticky replay must not fire again on a later reconnect');
});

test('currentConnectionSnapshot: a consumer registered while DISCONNECTED gets no snapshot (nothing to replay), while one registered while already CONNECTED is seeded with the current generation', async () => {
  const { gateway } = createGateway();
  const early = gateway.registerConsumer('early'); // registered before start() -- gateway is DISCONNECTED
  const earlyReceived: number[] = [];
  early.on('connected', (details: { generationId: number }) => earlyReceived.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(earlyReceived, [], 'no snapshot exists yet -- nothing to replay before the physical connect');

  await gateway.start();
  const late = gateway.registerConsumer('late'); // registered while CONNECTED
  const lateReceived: number[] = [];
  late.on('connected', (details: { generationId: number }) => lateReceived.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateReceived, [1], 'a consumer registered while already CONNECTED must be seeded with the current-generation snapshot');
});

test('THROWING REPLAY CONTAINMENT (Terra repro): a throwing sticky-replay listener does not escape as an uncaught exception, release the consumer, alter the physical connection, or affect a sibling', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  const sibling = gateway.registerConsumer('v8');
  await gateway.start(); // generation 1, before any listener exists

  let uncaught: unknown;
  const onUncaught = (error: unknown) => { uncaught = error; };
  process.on('uncaughtException', onUncaught);
  try {
    let siblingReceived = 0;
    sibling.on('connected', () => { siblingReceived += 1; });
    channel.on('connected', () => { throw new Error('SIMULATED_REPLAY_LISTENER_FAILURE'); });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve)); // extra tick of margin

    assert.equal(uncaught, undefined, 'a throwing replay listener must never escape as an unhandled exception');
    assert.equal(channel.isActive(), true, 'a throwing replay listener must not release the consumer');
    assert.equal(siblingReceived, 1, 'a throwing replay listener on one consumer must not affect a sibling');
    assert.equal(gateway.getState(), 'RUNNING', 'a throwing replay listener must never alter the physical connection/gateway state');
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('INTERNAL STICKY-STATE SAFETY (Terra repro): removeAllListeners(\'connected\') cannot corrupt authoritative sticky generation tracking for a later reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1
  channel.on('connected', () => {}); // ordinary strategy listener
  channel.removeAllListeners('connected'); // legitimate consumer-code cleanup
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2 -- must still be tracked correctly
  const received: number[] = [];
  // Attached AFTER the reconnect -- can only observe generation 2 via the sticky replay path
  // (the live 'connected' broadcast for generation 2 already happened and is gone), so this
  // directly proves the internal snapshot survived the removeAllListeners('connected') call.
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [2], 'removeAllListeners(\'connected\') must never corrupt the sticky handoff for a later-attached listener');
});

test('INTERNAL STICKY-STATE SAFETY (Terra repro): removeAllListeners() with no event name cannot corrupt sticky generation tracking for a later reconnect', async () => {
  const { gateway, connection } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1
  channel.on('connected', () => {});
  channel.on('unexpectedDisconnect', () => {});
  channel.removeAllListeners(); // wipes every listener on every event
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected(); // generation 2 -- must still be tracked correctly
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [2], 'a blanket removeAllListeners() must never corrupt the sticky handoff for a later-attached listener');
});

test('INTERNAL STICKY-STATE SAFETY: consumer release still disables all replay even after removeAllListeners()', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1
  channel.on('connected', () => {});
  channel.removeAllListeners();
  channel.disconnect();
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [], 'a released consumer must never receive a replay, regardless of any prior removeAllListeners() call');
});

test('INTERNAL STICKY-STATE SAFETY: a consumer-scoped failRecovery() must never corrupt sticky generation tracking for a later-attached listener (a synthetic consumer fault must not look like a physical disconnect)', async () => {
  const { gateway } = createGateway();
  const channel = gateway.registerConsumer('v4');
  await gateway.start(); // generation 1
  const faulted = channel.failRecovery(1, 'TEST_CONSUMER_SCOPED_FAULT');
  assert.equal(faulted, true);
  const received: number[] = [];
  channel.on('connected', (details: { generationId: number }) => received.push(details.generationId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [1], 'failRecovery()\'s synthetic reconnectFailed is consumer-scoped only -- it must never null the sticky physical-generation snapshot; only a genuine physical unexpectedDisconnect/reconnectFailed broadcast from the gateway may do that');
});
