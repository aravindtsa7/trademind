import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SharedMarketDataGateway from './shared-market-data-gateway';
import { ConnectionState, ReconnectCircuitSnapshot } from '../managers/connection.manager';
import { MarketDataSubscriptionMode } from '../managers/subscription.manager';
import ProtobufDecoder, { MarketDataFeedResponseDto } from '../protobuf/protobuf.decoder';
import MarketDataRecoveryCoordinatorService, { MarketDataRecoveryResult } from '../services/market-data-recovery-coordinator.service';
import LiveCandleBuilderService from '../services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../services/live-candle-event-adapter.service';
import { LiveCandleDto } from '../dto/live-candle.dto';
import ConsumerRecoveryWatchdogService from '../services/consumer-recovery-watchdog.service';

/**
 * Proves the recovery-isolation and candle-isolation invariants (milestone tests 8, 11-14) using
 * REAL MarketDataRecoveryCoordinatorService/LiveCandleBuilderService/LiveCandleEventAdapterService
 * instances -- one independent set per fake consumer -- wired only to a shared
 * SharedMarketDataGateway. Per-strategy alignment ARITHMETIC (V2=5m/V4=15m/V8=2m boundary
 * computation) is already exhaustively covered, unchanged, by
 * market-data-recovery-coordinator.service.test.ts; this file proves the NEW property the
 * milestone adds: that three independently-configured coordinator instances driven off the same
 * physical transport never leak state into one another.
 */

const NIFTY = 'NSE_INDEX|Nifty 50';

class FakeConnectionManager extends EventEmitter {
  state: ConnectionState = ConnectionState.DISCONNECTED;
  generation = 0;
  disconnectCalls = 0;
  attempts = 0;
  lastReason: string | null = null;

  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED) return;
    this.generation += 1;
    this.state = ConnectionState.CONNECTED;
    this.emit('connected', { generationId: this.generation });
  }
  disconnect(): void { this.disconnectCalls += 1; this.state = ConnectionState.DISCONNECTED; }
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  send(): void {}
  confirmRecoveryReady(generationId: number): boolean { if (this.state !== ConnectionState.CONNECTED || generationId !== this.generation) return false; this.attempts = 0; return true; }
  confirmTransportReady(generationId: number): boolean { return this.confirmRecoveryReady(generationId); }
  reconnectForHealth(reason: string, generationId: number): boolean { if (this.state !== ConnectionState.CONNECTED || generationId !== this.generation) return false; this.attempts += 1; this.lastReason = reason; return true; }
  failRecovery(): boolean { return true; }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot { return { state: 'CLOSED', attempts: this.attempts, lastFailureReason: this.lastReason, activeGenerationId: this.generation, pendingRecoveryGenerationId: null, reconnectEpisodeActive: false, nextRetryAtMs: null }; }

  simulateUnexpectedDisconnect(): void { this.state = ConnectionState.RECONNECTING; this.emit('unexpectedDisconnect', { generationId: this.generation }); }
  simulateReconnected(): void { this.generation += 1; this.state = ConnectionState.CONNECTED; this.emit('reconnected', { generationId: this.generation }); }
  simulateMessage(payload: MarketDataFeedResponseDto): void { this.emit('message', Buffer.from(JSON.stringify(payload)), { generationId: this.generation }); }
}

class PassthroughDecoder {
  decode(buffer: Buffer): MarketDataFeedResponseDto { return JSON.parse(buffer.toString('utf8')) as MarketDataFeedResponseDto; }
}

function tickFeed(instrumentKey: string, ltp: number, at: Date): MarketDataFeedResponseDto {
  const ts = at.toISOString();
  return { type: 'live_feed', currentTs: ts, feeds: { [instrumentKey]: { ltpc: { ltp, ltt: ts, ltq: '1', cp: ltp } } } } as unknown as MarketDataFeedResponseDto;
}

/** A controllable backfill result the test can resolve/reject on demand, per consumer. */
function pendingBackfill(): { promise: Promise<MarketDataRecoveryResult>; resolveReady: () => void; reject: (reason: string) => void } {
  let resolveFn!: (value: MarketDataRecoveryResult) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<MarketDataRecoveryResult>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  return {
    promise,
    resolveReady: () => resolveFn({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }),
    reject: (reason: string) => rejectFn(new Error(reason)),
  };
}

interface StrategyRig {
  consumerId: string;
  channel: ReturnType<SharedMarketDataGateway['registerConsumer']>;
  recovery: MarketDataRecoveryCoordinatorService;
  backfill: ReturnType<typeof pendingBackfill>;
  candleBuilder: LiveCandleBuilderService;
  candleAdapter: LiveCandleEventAdapterService;
  completedCandles: LiveCandleDto[];
  isFaulted: () => boolean;
  watchdog?: ConsumerRecoveryWatchdogService;
  /** Only after this flips true does the rig feed 'stateChanged' into its watchdog -- mirrors each runner's own startupComplete gate. */
  armWatchdog: () => void;
}

class FakeScheduler {
  now = 0;
  private nextId = 0;
  private readonly active = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): number { const id = this.nextId++; this.active.set(id, { at: this.now + delayMs, callback }); return id; }
  clearTimeout(handle: unknown): void { this.active.delete(handle as number); }
  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    let next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, task]) => task.at <= target);
    while (next) {
      this.active.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, task]) => task.at <= target);
    }
    this.now = target;
  }
}

function buildStrategyRig(gateway: SharedMarketDataGateway, consumerId: string, watchdogOptions?: { scheduler: FakeScheduler; budgetMs: number }): StrategyRig {
  const channel = gateway.registerConsumer(consumerId);
  const backfill = pendingBackfill();
  const recovery = new MarketDataRecoveryCoordinatorService({ backfill: () => backfill.promise });
  const isFaulted = (): boolean => recovery.getState() === 'FAULTED';
  channel.on('connected', (details: { generationId: number }) => recovery.handleInitialConnected({ generationId: details.generationId }));
  channel.on('unexpectedDisconnect', (details: { generationId?: number }) => recovery.handleUnexpectedDisconnect(details));
  channel.on('reconnected', (details: { generationId?: number }) => recovery.handleReconnected(details));
  channel.on('reconnectFailed', () => recovery.fault('RECONNECT_FAILED'));
  channel.on('market.tick', (tick: { generationId?: number; timestamp?: string }) => {
    if (typeof tick.timestamp !== 'string') return;
    recovery.handleLiveTick({ sourceTimestamp: new Date(tick.timestamp), receivedAt: new Date(), generationId: tick.generationId });
  });
  const candleBuilder = new LiveCandleBuilderService();
  const candleAdapter = new LiveCandleEventAdapterService(candleBuilder, channel, () => channel.getGenerationId());
  const completedCandles: LiveCandleDto[] = [];
  channel.on('market.candle.completed', (candle: LiveCandleDto) => completedCandles.push(candle));
  candleAdapter.start();
  let armed = false;
  let watchdog: ConsumerRecoveryWatchdogService | undefined;
  if (watchdogOptions) {
    watchdog = new ConsumerRecoveryWatchdogService({
      budgetMs: watchdogOptions.budgetMs,
      onTimeout: (reason) => recovery.fault(reason),
      now: () => watchdogOptions.scheduler.now,
      setTimeoutFn: (cb, ms) => watchdogOptions.scheduler.setTimeout(cb, ms),
      clearTimeoutFn: (handle) => watchdogOptions.scheduler.clearTimeout(handle),
    });
    recovery.on('stateChanged', (state) => { if (armed) watchdog!.onStateChanged(state); });
  }
  const armWatchdog = (): void => { armed = true; };
  return { consumerId, channel, recovery, backfill, candleBuilder, candleAdapter, completedCandles, isFaulted, watchdog, armWatchdog };
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

test('scenario 11: V2/V4/V8 retain independent recovery construction -- three separate coordinator instances, never one shared state machine', async () => {
  const { gateway } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  const v8 = buildStrategyRig(gateway, 'v8');
  await gateway.start();
  assert.notEqual(v2.recovery, v4.recovery);
  assert.notEqual(v2.recovery, v8.recovery);
  // handleInitialConnected() was broadcast identically to all three, but each owns its own state.
  assert.equal(v2.recovery.getState(), 'AWAITING_LIVE_TICK');
  assert.equal(v4.recovery.getState(), 'AWAITING_LIVE_TICK');
  assert.equal(v8.recovery.getState(), 'AWAITING_LIVE_TICK');
});

test('scenario 12: V8 becoming ready first cannot mark V2/V4 ready', async () => {
  const { gateway } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  const v8 = buildStrategyRig(gateway, 'v8');
  await gateway.start();
  await Promise.all([v2.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL), v4.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL), v8.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL)]);
  v8.backfill.resolveReady();
  await v8.backfill.promise;
  v8.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp: 100 });
  assert.equal(v8.recovery.getState(), 'READY');
  assert.equal(v2.recovery.getState(), 'AWAITING_LIVE_TICK');
  assert.equal(v4.recovery.getState(), 'AWAITING_LIVE_TICK');
});

test('scenario 13: V2 becoming ready cannot clear V4 pending strategy recovery', async () => {
  const { gateway, connection } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  await gateway.start();
  // Put V4 into an unresolved DEGRADED/RECONNECTING episode via a real physical reconnect.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING'); // its own backfill() promise has not resolved yet
  // V2, meanwhile, reaches READY independently.
  v2.backfill.resolveReady();
  await v2.backfill.promise;
  v2.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp: 100 });
  assert.equal(v2.recovery.getState(), 'READY');
  // V4's own unresolved recovery must remain exactly where it was -- V2's readiness cannot clear it.
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
});

test('scenario 14: a V4 consumer recovery failure faults V4 only, and never disconnects/faults V2/V8 or the shared transport', async () => {
  const { gateway, connection } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  const v8 = buildStrategyRig(gateway, 'v8');
  await gateway.start();
  // A cold start alone grants backfillReady immediately (no getLastSeededCompletedMinute
  // configured in this rig) -- backfill() is only actually invoked on a reconnect. Drive V4
  // through one so its own backfill() rejection has something real to fail.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  v4.backfill.reject('V4_BACKFILL_FAILED');
  await assert.rejects(v4.backfill.promise);
  // Let the coordinator's internal recover() promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v4.isFaulted(), true);
  assert.equal(v2.isFaulted(), false);
  assert.equal(v8.isFaulted(), false);
  assert.equal(connection.disconnectCalls, 0);
  assert.equal(gateway.getState(), 'RUNNING');
  assert.equal(gateway.getActiveConsumerCount(), 3);
});

test('scenario 15 (physical): a genuine physical breaker open faults every active consumer coordinator, not just one', async () => {
  const { gateway, connection } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  await gateway.start();
  connection.emit('reconnectFailed', { generationId: connection.generation, reason: 'RECONNECT_EXHAUSTED' });
  assert.equal(v2.isFaulted(), true);
  assert.equal(v4.isFaulted(), true);
});

test('scenario 8: no duplicate/cross-strategy market.candle.completed events across three private candle adapters on the same NIFTY feed', async () => {
  const { gateway, connection } = createGateway();
  const v2 = buildStrategyRig(gateway, 'v2');
  const v4 = buildStrategyRig(gateway, 'v4');
  const v8 = buildStrategyRig(gateway, 'v8');
  await gateway.start();
  await Promise.all([v2.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL), v4.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL), v8.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL)]);
  // A 09:15 IST session open, one tick per minute for three minutes -- enough to complete at
  // least one 1m/2m/3m bucket across all three private candle builders.
  const base = new Date('2026-09-02T09:15:00+05:30');
  for (let minute = 0; minute <= 3; minute += 1) {
    const at = new Date(base.getTime() + minute * 60_000);
    connection.simulateMessage(tickFeed(NIFTY, 24500 + minute, at));
  }
  // Every consumer independently observed the identical upstream tick sequence; each one's own
  // candle builder/adapter must have produced its OWN completed candles -- never zero (proving
  // isolation didn't just silently drop everything) and never duplicated onto a sibling.
  assert.ok(v2.completedCandles.length > 0, 'V2 must have completed at least one candle from its own private feed');
  assert.ok(v4.completedCandles.length > 0, 'V4 must have completed at least one candle from its own private feed');
  assert.ok(v8.completedCandles.length > 0, 'V8 must have completed at least one candle from its own private feed');
  // Each consumer's LiveCandleEventAdapterService builds all four supported timeframes (1m/2m/
  // 3m/5m) from the identical upstream tick sequence, on its own private channel/builder --
  // three independent, symmetric pipelines given the same input must therefore produce the
  // identical completed-candle COUNT (never more, from a duplicate delivery, nor fewer, from a
  // dropped one), and never a candle keyed by another consumer's instrument/timeframe/time that
  // its own builder never actually produced.
  assert.equal(v2.completedCandles.length, v4.completedCandles.length);
  assert.equal(v4.completedCandles.length, v8.completedCandles.length);
  const candleKey = (candle: LiveCandleDto): string => `${candle.instrumentKey}|${candle.timeframe}|${candle.candleTime.getTime()}`;
  assert.deepEqual(v2.completedCandles.map(candleKey).sort(), v4.completedCandles.map(candleKey).sort());
  assert.deepEqual(v4.completedCandles.map(candleKey).sort(), v8.completedCandles.map(candleKey).sort());
});

/**
 * F-02: bounded per-consumer LOGICAL recovery watchdog, proven against the REAL
 * MarketDataRecoveryCoordinatorService state machine driven off the same shared physical
 * transport as the scenario 11-15 tests above -- only this time a post-startup unresolved
 * recovery episode is actually bounded by ConsumerRecoveryWatchdogService instead of hanging
 * forever, and the fault it produces is proven to route through the exact same consumer-scoped
 * path scenario 14 already proved (never the physical ConnectionManager, never a sibling).
 */
/**
 * Cold start (handleInitialConnected) never actually calls the `backfill` callback when
 * getLastSeededCompletedMinute is unconfigured (as in this rig) -- backfillReady is granted
 * immediately, and READY only additionally requires one fresh live tick. `resolveBackfill`
 * defaults to true (pre-resolving the rig's one pendingBackfill() Promise, harmless at cold
 * start) but must be set false for a rig whose backfill needs to remain genuinely UNRESOLVED so
 * a LATER reconnect-triggered backfill() call can be made to hang deterministically.
 */
async function bringToReady(rig: StrategyRig, gateway: SharedMarketDataGateway, resolveBackfill = true): Promise<void> {
  await rig.channel.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
  if (resolveBackfill) { rig.backfill.resolveReady(); await rig.backfill.promise; }
  rig.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp: 100 });
  assert.equal(rig.recovery.getState(), 'READY');
  rig.armWatchdog(); // mirrors each runner setting startupComplete = true once RUNNING
}

/** Resolves a rig's SECOND (post-reconnect) backfill() call and drives it back to READY with a fresh tick. */
async function resolveThroughToReady(rig: StrategyRig, gateway: SharedMarketDataGateway, ltp: number): Promise<void> {
  rig.backfill.resolveReady();
  await rig.backfill.promise;
  rig.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp });
  assert.equal(rig.recovery.getState(), 'READY');
}

test('F-02: a hung post-startup V4 backfill faults only V4, bounded exactly at its own budget -- V2/V8 remain healthy and the physical transport is untouched', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v2 = buildStrategyRig(gateway, 'v2', { scheduler, budgetMs: 5 * 60_000 });
  const v4 = buildStrategyRig(gateway, 'v4', { scheduler, budgetMs: 15 * 60_000 });
  const v8 = buildStrategyRig(gateway, 'v8', { scheduler, budgetMs: 2 * 60_000 });
  await gateway.start();
  // V4's own backfill Promise is deliberately left UNRESOLVED (resolveBackfill=false) so the
  // reconnect-triggered backfill() call below can hang genuinely and deterministically -- cold
  // start itself never actually calls backfill() (see bringToReady's own doc), so V4 still
  // reaches READY normally here.
  await Promise.all([bringToReady(v2, gateway), bringToReady(v4, gateway, false), bringToReady(v8, gateway)]);

  // One shared physical reconnect starts an unresolved recovery episode for all three. V2/V8's
  // own backfill Promises were already resolved during bringToReady (unconsumed at cold start),
  // so their reconnect-triggered backfill() calls resolve immediately, needing only a fresh tick
  // to reach READY again -- V4's genuinely hangs.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  await resolveThroughToReady(v2, gateway, 101);
  await resolveThroughToReady(v8, gateway, 102);
  assert.equal(v4.recovery.getState(), 'BACKFILLING'); // still hung, unaffected by V2/V8 resolving

  scheduler.advanceBy(15 * 60_000 - 1);
  assert.equal(v4.isFaulted(), false);
  scheduler.advanceBy(1);
  assert.equal(v4.isFaulted(), true, 'V4 must fault exactly at its own base+15m budget');
  assert.equal(v2.isFaulted(), false, 'V2 must remain healthy');
  assert.equal(v8.isFaulted(), false, 'V8 must remain healthy');
  assert.equal(connection.disconnectCalls, 0, 'a consumer watchdog timeout must never touch the physical ConnectionManager');
  assert.equal(gateway.getState(), 'RUNNING');
  assert.equal(gateway.getActiveConsumerCount(), 3);
});

test('F-02: V2 (base+5m) and V8 (base+2m) each fault at their own independent budget', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v2 = buildStrategyRig(gateway, 'v2', { scheduler, budgetMs: 5 * 60_000 });
  const v8 = buildStrategyRig(gateway, 'v8', { scheduler, budgetMs: 2 * 60_000 });
  await gateway.start();
  await Promise.all([bringToReady(v2, gateway), bringToReady(v8, gateway)]);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v8.recovery.getState(), 'BACKFILLING');
  assert.equal(v2.recovery.getState(), 'BACKFILLING');
  scheduler.advanceBy(2 * 60_000);
  assert.equal(v8.isFaulted(), true, 'V8 faults at base+2m');
  assert.equal(v2.isFaulted(), false, 'V2 (base+5m) must not have faulted yet');
  scheduler.advanceBy(3 * 60_000); // total 5m elapsed for V2
  assert.equal(v2.isFaulted(), true, 'V2 faults at its own base+5m');
});

test('F-02: repeated physical reconnects during one unresolved episode do not restart the deadline', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v4 = buildStrategyRig(gateway, 'v4', { scheduler, budgetMs: 15 * 60_000 });
  await gateway.start();
  await bringToReady(v4, gateway);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  scheduler.advanceBy(10 * 60_000);
  // A SECOND physical generation advance while V4's recovery is STILL unresolved (its backfill()
  // never resolved) -- must not push V4's own deadline out.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  scheduler.advanceBy(4 * 60_000 + 59_999);
  assert.equal(v4.isFaulted(), false); // 14m59.999s elapsed from the FIRST unresolved transition
  scheduler.advanceBy(1);
  assert.equal(v4.isFaulted(), true); // exactly 15m from the first, not the second, disconnect
});

test('F-02: V8 reaching READY quickly does not affect V4, which remains unresolved and later faults at its own deadline', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v4 = buildStrategyRig(gateway, 'v4', { scheduler, budgetMs: 15 * 60_000 });
  const v8 = buildStrategyRig(gateway, 'v8', { scheduler, budgetMs: 2 * 60_000 });
  await gateway.start();
  await Promise.all([bringToReady(v4, gateway), bringToReady(v8, gateway)]);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  assert.equal(v8.recovery.getState(), 'BACKFILLING');
  // V8 resolves its OWN backfill quickly and reaches READY well inside its 2m budget.
  v8.backfill.resolveReady();
  await v8.backfill.promise;
  v8.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp: 101 });
  assert.equal(v8.recovery.getState(), 'READY');
  scheduler.advanceBy(60_000);
  assert.equal(v8.isFaulted(), false);
  assert.equal(v4.isFaulted(), false); // still well inside its own 15m budget
  scheduler.advanceBy(14 * 60_000);
  assert.equal(v4.isFaulted(), true, 'V4 must eventually fault at its own unaffected 15m deadline');
  assert.equal(v8.isFaulted(), false, 'V8 stays healthy/RUNNING throughout');
});

test('F-02: V2 reaching READY does not clear or restart V4\'s unresolved deadline (real coordinator + real gateway)', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v2 = buildStrategyRig(gateway, 'v2', { scheduler, budgetMs: 5 * 60_000 });
  const v4 = buildStrategyRig(gateway, 'v4', { scheduler, budgetMs: 15 * 60_000 });
  await gateway.start();
  // V4's own backfill Promise is deliberately left UNRESOLVED (resolveBackfill=false) so it
  // remains genuinely stuck at BACKFILLING across this whole test -- see bringToReady's own doc.
  await Promise.all([bringToReady(v2, gateway), bringToReady(v4, gateway, false)]);
  // One shared physical reconnect starts an unresolved episode for BOTH -- V2 and V4 are
  // independent ConsumerRecoveryWatchdogService instances (one per rig), so V2 resolving its own
  // backfill quickly must have zero effect on V4's separate, still-unresolved deadline.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v2.recovery.getState(), 'BACKFILLING');
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  scheduler.advanceBy(60_000);
  await resolveThroughToReady(v2, gateway, 103);
  scheduler.advanceBy(60_000);
  assert.equal(v2.isFaulted(), false);
  assert.equal(v4.recovery.getState(), 'BACKFILLING'); // untouched by V2's own resolution
  scheduler.advanceBy(15 * 60_000 - 2 * 60_000);
  assert.equal(v4.isFaulted(), true); // exactly 15m from V4's OWN first unresolved transition
  assert.equal(v2.isFaulted(), false);
});

test('F-02: consumer recovery success before the deadline cancels the watchdog cleanly, and a late timer cannot fault a later new episode', async () => {
  const { gateway, connection } = createGateway();
  const scheduler = new FakeScheduler();
  const v4 = buildStrategyRig(gateway, 'v4', { scheduler, budgetMs: 15 * 60_000 });
  await gateway.start();
  await bringToReady(v4, gateway);
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  assert.equal(v4.recovery.getState(), 'BACKFILLING');
  scheduler.advanceBy(5 * 60_000);
  v4.backfill.resolveReady();
  await v4.backfill.promise;
  v4.channel.emit('market.tick', { generationId: gateway.getGenerationId(), timestamp: new Date().toISOString(), instrumentKey: NIFTY, ltp: 102 });
  assert.equal(v4.recovery.getState(), 'READY');
  scheduler.advanceBy(15 * 60_000); // well past the old episode's would-be deadline
  assert.equal(v4.isFaulted(), false, 'the cancelled timer must never fire');
  // A brand-new unresolved episode begins -- it gets its OWN fresh 15m budget.
  connection.simulateUnexpectedDisconnect();
  connection.simulateReconnected();
  scheduler.advanceBy(15 * 60_000 - 1);
  assert.equal(v4.isFaulted(), false);
  scheduler.advanceBy(1);
  assert.equal(v4.isFaulted(), true);
});
