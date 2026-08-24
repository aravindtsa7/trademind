import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';

/**
 * A7-H1: proves the REST->live cold-start continuity fix end-to-end through
 * the exact composition the real V8 (and V2/V4) entrypoints use --
 * StrategyHostLifecycle.onReady() awaiting MarketDataRecoveryCoordinatorService
 * .waitUntilReady() -- not merely the coordinator in isolation (already covered
 * by market-data-recovery-coordinator.service.test.ts's A7-H1-1..6 unit tests).
 *
 * Reproduces the exact reported live scenario from 2026-08-24:
 *   10:33 IST -- REST warmup's last seeded completed candle
 *   10:34 IST -- the completed minute that was never bridged before this fix
 *   10:35 IST -- first live WebSocket tick after `handleInitialConnected`
 * Before this fix, the coordinator granted `backfillReady` unconditionally on
 * the first connection, so RUNNING was reached with 10:34 permanently missing
 * -- V8's own downstream continuity check then faulted with
 * V8_TARGET_SESSION_SOURCE_DISCONTINUOUS. This suite proves the host now
 * waits for the bridge before ever reaching RUNNING.
 */

const ist = (hh: number, mm: number, ss = 0): Date => new Date(`2026-08-24T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+05:30`);

/**
 * Mirrors the real V8 entrypoint's shape exactly: a MarketDataRecoveryCoordinatorService
 * constructed with getLastSeededCompletedMinute wired to the warmup's last seeded
 * candle, and a StrategyHostLifecycle whose onReady hook awaits
 * recovery.waitUntilReady(startupReadyTimeoutMs) (test-live-v8-nifty-bullish-reclaim-shadow.ts
 * lines ~444-460 and ~584-589).
 */
function v8ColdStartHarness(options: {
  lastSeededCompletedMinute: Date | null;
  now: Date;
  backfill?: () => Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: string }>;
  startupReadyTimeoutMs?: number;
}) {
  const events: string[] = [];
  const onRecoveredCalls: Array<{ generationId: number; data: string | undefined }> = [];
  let candlesStarted = 0;
  const backfill = options.backfill ?? (async () => ({ ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 0, duplicateMinutes: 0, recoveryData: 'BRIDGED' }));
  const recovery = new MarketDataRecoveryCoordinatorService<string>({
    getLastSeededCompletedMinute: () => options.lastSeededCompletedMinute,
    nowMs: () => options.now.getTime(),
    isMarketSession: () => true,
    backfill,
    // Exactly mirrors the real onRecovered: hands the recovered data onward and
    // (re)starts candle aggregation -- the SAME pipeline used for a reconnect gap,
    // never a strategy-specific duplicate.
    onRecovered: (generationId, data) => { onRecoveredCalls.push({ generationId, data }); candlesStarted += 1; return undefined; },
    onEvent: (event) => events.push(event),
  });
  const host = new StrategyHostLifecycle({
    strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
    runtimeId: 'shadow:v8:reclaim',
    hooks: {
      warmup: () => undefined,
      onReady: () => recovery.waitUntilReady(options.startupReadyTimeoutMs ?? 5_000),
      onEod: () => undefined,
      onShutdown: () => undefined,
      onFault: () => undefined,
    },
  });
  return { host, recovery, events, onRecoveredCalls, candlesStarted: () => candlesStarted, setNow: (value: Date) => { options.now = value; } };
}

test('A7-H1: zero gap (warmup already covers the expected completed minute) -- host reaches RUNNING on the first live tick without any backfill', async () => {
  // A7-H2 note: connecting EXACTLY on a clean minute boundary (:00.000) is the one case
  // where "the minute forming at connect" and "the ordinary expectedCompleted minute"
  // coincide (see establishLiveConstructionBoundary), so this stays a true zero-gap,
  // no-extra-wait scenario under the mid-bucket-handoff fix too.
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 34), now: ist(10, 35, 0) }); // expected completed = 10:34, already seeded
  const startPromise = harness.host.start();
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  assert.equal(harness.recovery.getState(), 'AWAITING_LIVE_TICK', 'no backfill needed -- continuity already satisfied');
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 2), receivedAt: ist(10, 35, 2), generationId: 1 });
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
  assert.equal(harness.onRecoveredCalls.length, 0, 'no reconciliation backfill was required');
});

test('A7-H1: the exact reported one-minute gap (10:33 seeded, 10:35 handoff, 10:34 missing) defers RUNNING until the bridge completes -- never reaches RUNNING on the bare live tick alone', async () => {
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 33), now: ist(10, 35, 0) });
  const startPromise = harness.host.start();
  // Let onReady() actually start awaiting recovery.waitUntilReady() (register its listener)
  // before driving the coordinator -- exactly like production, where the WebSocket 'connected'
  // event is always at least one real tick behind host.start() being invoked.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.getState(), 'READY', 'onReady is in flight, awaiting the live-readiness gate');
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  assert.equal(harness.recovery.getState(), 'BACKFILLING', 'the missing 10:34 completed minute must trigger reconciliation before readiness');
  // A live tick arriving WHILE the bridge is still in flight must not shortcut RUNNING --
  // this is the exact defect this fix closes: the forming-minute tick was previously
  // sufficient on its own.
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 1), receivedAt: ist(10, 35, 1), generationId: 1 });
  assert.equal(harness.host.getState(), 'READY', 'RUNNING must not be reached while the cold-start bridge is still pending');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.recovery.getState(), 'WAITING_FOR_FRESH_TICK', 'bridge completed; still needs a tick received after the bridge, not the one that already arrived mid-bridge');
  assert.equal(harness.host.getState(), 'READY');
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 2), receivedAt: ist(10, 35, 2), generationId: 1 });
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
  assert.equal(harness.onRecoveredCalls.length, 1);
  assert.equal(harness.onRecoveredCalls[0].data, 'BRIDGED');
  assert.equal(harness.candlesStarted(), 1, 'candle aggregation restarts through the same pipeline a reconnect gap already uses');
});

test('A7-H1: a multi-minute gap on cold start still bridges before RUNNING', async () => {
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 30), now: ist(10, 35, 0) }); // expected completed = 10:34, 4 minutes missing; connecting exactly on the boundary keeps this test isolated to the pre-existing-gap scenario (see A7-H2 block below for mid-bucket connects)
  const startPromise = harness.host.start();
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  assert.equal(harness.recovery.getState(), 'BACKFILLING');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.recovery.getState(), 'WAITING_FOR_FRESH_TICK');
  assert.equal(harness.host.getState(), 'READY', 'still not RUNNING until a fresh tick arrives');
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 6), receivedAt: ist(10, 35, 6), generationId: 1 });
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
});

test('A7-H1: a bridge failure faults the host closed -- RUNNING is never granted with a permanently unresolved gap', async () => {
  const harness = v8ColdStartHarness({
    lastSeededCompletedMinute: ist(10, 33),
    now: ist(10, 35, 0),
    backfill: async () => ({ ready: false, reason: 'UPSTOX_API_ERROR', missingMinutes: 1, duplicateMinutes: 0 }),
    startupReadyTimeoutMs: 1_000,
  });
  const startPromise = harness.host.start();
  await new Promise((resolve) => setImmediate(resolve)); // let onReady register its waitUntilReady() listener first
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  await startPromise; // host.start() never rejects -- fault() is caught and awaited internally
  assert.equal(harness.host.getState(), 'FAULTED', 'a failed bridge must fault the host closed, never silently grant RUNNING');
  assert.equal(harness.recovery.getState(), 'FAULTED');
});

test('A7-H1: a disconnect/generation change arriving mid-bridge discards the stale backfill result and never lets it grant RUNNING for the wrong generation', async () => {
  let resolveBackfill: ((value: { ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData?: string }) => void) | undefined;
  const harness = v8ColdStartHarness({
    lastSeededCompletedMinute: ist(10, 33),
    now: ist(10, 35, 0),
    backfill: () => new Promise((resolve) => { resolveBackfill = resolve; }),
    startupReadyTimeoutMs: 5_000,
  });
  const startPromise = harness.host.start();
  await new Promise((resolve) => setImmediate(resolve)); // let onReady register its waitUntilReady() listener first
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  assert.equal(harness.recovery.getState(), 'BACKFILLING');
  // Connection drops mid-bridge, exactly like an unexpectedDisconnect racing the cold-start
  // reconciliation before it has ever completed once.
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  assert.equal(harness.recovery.getState(), 'RECONNECTING');
  assert.equal(harness.host.getState(), 'READY', 'no premature RUNNING while reconnecting');
  // The original (now-stale) backfill settles late.
  resolveBackfill!({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: 'STALE' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.onRecoveredCalls.length, 0, 'the stale cold-start backfill result must never be applied after generation invalidation');
  // A genuine reconnect then completes the (fresh) recovery for the new generation. The
  // shared `backfill` callback creates a NEW pending promise per invocation, so the
  // resolver captured above must be re-resolved for this second, post-reconnect call.
  harness.recovery.handleReconnected({ generationId: 2 });
  resolveBackfill!({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: 'FRESH' });
  await new Promise((resolve) => setImmediate(resolve));
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 10), receivedAt: ist(10, 35, 10), generationId: 2 });
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
  assert.equal(harness.onRecoveredCalls.length, 1);
  assert.equal(harness.onRecoveredCalls[0].generationId, 2);
});

test('A7-H1: never requires the still-forming minute -- a live tick that only proves the CURRENT (incomplete) minute is not, by itself, treated as covering the previous completed minute', async () => {
  // lastSeeded is one minute behind now's expected-completed minute; a tick's mere
  // arrival (which only proves receipt time, not which minute is "complete") must not
  // let the missing completed minute go unbridged.
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 33), now: ist(10, 35, 0) });
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  assert.equal(harness.recovery.getState(), 'BACKFILLING', 'the still-forming 10:35 minute can never substitute for the missing completed 10:34 minute');
});

// ---- A7-H2: complete-bucket handoff, through the StrategyHostLifecycle/coordinator composition ----
//
// A7-H1 only ever bridged minutes that were ALREADY complete by wall-clock time at the
// instant of connect. The minute a WebSocket connects (or reconnects) IN THE MIDDLE OF was
// never reconciled at all: LiveCandleBuilderService would build it from whatever live ticks
// happened to arrive after the mid-minute connect and later emit it as "completed" once the
// next minute began -- a timestamp-contiguous but silently incomplete candle. These tests
// prove RUNNING is now deferred until that forming minute is excluded from live construction
// and reconciled through REST, through the exact host/coordinator composition every real
// entrypoint uses (see the real-pipeline behavioral test further below for the
// LiveCandleBuilderService/evaluator side of the same fix).

test('A7-H2: a mid-minute cold-start connect (10:35:23, forming minute 10:35) defers RUNNING until the forming minute is reconciled -- a live tick received before the boundary cannot shortcut it', async () => {
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 34), now: ist(10, 35, 23) }); // zero pre-existing gap under the OLD formula, but 10:35 is still forming at connect
  const startPromise = harness.host.start();
  await new Promise((resolve) => setImmediate(resolve));
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 23) });
  assert.equal(harness.recovery.getState(), 'AWAITING_LIVE_TICK', 'no BACKFILLING transition yet -- merely waiting for wall-clock time to reach the boundary');
  // A live tick received before the 10:36:00 boundary proves the feed is alive but must not
  // itself substitute for the still-forming 10:35 minute.
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 40), receivedAt: ist(10, 35, 40), generationId: 1 });
  assert.equal(harness.host.getState(), 'READY', 'RUNNING must not be reached from a pre-boundary tick alone');
  assert.equal(harness.onRecoveredCalls.length, 0);
  // A live tick at/after the boundary fires the deferred reconciliation.
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 36, 5), receivedAt: ist(10, 36, 5), generationId: 1 });
  assert.equal(harness.recovery.getState(), 'BACKFILLING');
  await new Promise((resolve) => setImmediate(resolve));
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
  assert.equal(harness.onRecoveredCalls.length, 1, 'exactly one reconciliation bridges the forming 10:35 minute');
});

test('A7-H2: mid-minute RECONNECT is protected the same way as a mid-minute cold-start connect', async () => {
  const harness = v8ColdStartHarness({ lastSeededCompletedMinute: ist(10, 34), now: ist(10, 35, 0) }); // clean exact-boundary cold start
  const startPromise = harness.host.start();
  harness.recovery.handleInitialConnected({ generationId: 1, connectedAt: ist(10, 35, 0) });
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 35, 1), receivedAt: ist(10, 35, 1), generationId: 1 });
  await startPromise;
  assert.equal(harness.host.getState(), 'RUNNING');
  assert.equal(harness.onRecoveredCalls.length, 0, 'zero-gap cold start needed no backfill');
  // Disconnect, then reconnect mid-minute at 10:40:15 -- handleReconnected computes its
  // boundary from the coordinator's own current-time clock (there is no separate
  // "reconnectedAt" parameter), so the harness clock must be advanced to the reconnect
  // instant first.
  harness.recovery.handleUnexpectedDisconnect({ generationId: 1 });
  harness.setNow(ist(10, 40, 15));
  harness.recovery.handleReconnected({ generationId: 2 });
  assert.notEqual(harness.recovery.getState(), 'BACKFILLING', 'a mid-minute reconnect must wait for the forming-minute boundary too, not backfill immediately');
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 40, 20), receivedAt: ist(10, 40, 20), generationId: 2 });
  assert.equal(harness.onRecoveredCalls.length, 0, 'still waiting -- a pre-boundary tick must not trigger reconciliation');
  harness.recovery.handleLiveTick({ sourceTimestamp: ist(10, 41, 5), receivedAt: ist(10, 41, 5), generationId: 2 });
  assert.equal(harness.recovery.getState(), 'BACKFILLING');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.onRecoveredCalls.length, 1, 'the reconnect reconciliation ran through the same bridge pipeline as the cold start');
});

// ---- A7-H2: real-pipeline behavioral proof (Blocker 1) ----
//
// Reproduces the exact V8 defect scenario end-to-end through the REAL production classes --
// MarketDataRecoveryCoordinatorService driving a REAL LiveCandleBuilderService/
// LiveCandleEventAdapterService pair over a real event bus, feeding a REAL
// V8BullishReclaimShadowEvaluatorService -- not a mirrored/mocked candle-completion
// callback. This is deliberately NOT the same as the source-text/mirrored-callback style of
// the pre-A7-H2 version of this suite: every assertion below is driven by actually replaying
// ticks through the real tick -> candle -> evaluator pipeline.

test('A7-H2 real-pipeline: a WebSocket connecting mid-minute can never deliver a partial 1m candle into V8, and the derived 2m evaluation downstream remains complete', async () => {
  const { EventEmitter } = await import('events');
  const { default: LiveCandleBuilderServiceCtor } = await import('../modules/market-data/services/live-candle-builder.service');
  const { default: LiveCandleEventAdapterServiceCtor } = await import('../modules/market-data/services/live-candle-event-adapter.service');
  const { default: V8BullishReclaimShadowEvaluatorServiceCtor } = await import('../modules/adaptive-intraday/services/v8-bullish-reclaim-shadow.service');
  const { createV8BullishReclaimConfigs } = await import('../modules/research/v8-nifty-bullish-reclaim');

  const NIFTY = 'NSE_INDEX|Nifty 50';
  const MINUTE = 60_000;
  const priorDate = '2026-08-13';
  const targetDate = '2026-08-14';
  const sessionStartMs = new Date(`${targetDate}T09:15:00+05:30`).getTime();

  const config = createV8BullishReclaimConfigs().find((value) =>
    value.timeframe === 2 && value.levelFamily === 'PDH' && value.reclaimBufferAtr === 0
    && value.bullishBodyAtr === 0.25 && value.rsiMinimum === 'NONE' && value.regimeMode === 'NO_REGIME_FILTER' && value.cooldownMinutes === 5);
  assert.ok(config, 'expected the PDH/NO_REGIME_FILTER/NONE test config to exist in the frozen grid');

  function candle(offsetMinutes: number, ohlc: { open: number; high: number; low: number; close: number }) {
    return { timestamp: new Date(sessionStartMs + offsetMinutes * MINUTE), ...ohlc, volume: 1 };
  }
  function flat(count: number, startOffset: number, dateMs: number, ohlc: { open: number; high: number; low: number; close: number }) {
    return Array.from({ length: count }, (_, index) => ({ timestamp: new Date(dateMs + (startOffset + index) * MINUTE), ...ohlc, volume: 1 }));
  }
  const priorSessionStartMs = new Date(`${priorDate}T09:15:00+05:30`).getTime();
  const priorCompleteSession = flat(375, 0, priorSessionStartMs, { open: 24_050, high: 24_100, low: 24_000, close: 24_050 });
  const quiet = { open: 24_000, high: 24_010, low: 23_990, close: 24_000 };

  const evaluator = new V8BullishReclaimShadowEvaluatorServiceCtor(config);
  evaluator.seedHistoricalOneMinute(priorCompleteSession);
  // Warmup, run BEFORE the WebSocket ever connects, covers 09:15 through 10:00.
  // Connecting during 10:01 is adverse for the 09:15-anchored 2m grid because 10:01
  // is itself a 2m bucket start; the strictly-future safe boundary must be 10:03.
  const warmupSeed = flat(46, 0, sessionStartMs, quiet);
  evaluator.seedHistoricalOneMinute(warmupSeed);
  const lastSeededCompletedMinute = warmupSeed[warmupSeed.length - 1].timestamp; // 09:59

  const bus = new EventEmitter();
  const liveCandleBuilder = new LiveCandleBuilderServiceCtor();
  const candles = new LiveCandleEventAdapterServiceCtor(liveCandleBuilder, bus);
  const completedOneMinute: Array<{ candleTime: Date; open: number }> = [];
  const completedTwoMinute: Array<{ candleTime: Date; open: number }> = [];
  bus.on('market.candle.completed', (event: any) => {
    if (event.instrumentKey !== NIFTY || event.completed !== true) return;
    if (event.timeframe === '1m') { completedOneMinute.push({ candleTime: event.candleTime, open: event.open }); evaluator.processCompletedOneMinute({ timestamp: event.candleTime, open: event.open, high: event.high, low: event.low, close: event.close, volume: 0 }); }
    if (event.timeframe === '2m') completedTwoMinute.push({ candleTime: event.candleTime, open: event.open });
  });

  // Production recovery must cover the complete adverse 2m bucket [10:01,10:02].
  const restReconciledMinutes = [
    candle(46, { open:777, high:778, low:776, close:777 }),
    candle(47, { open:778, high:779, low:777, close:778 }),
  ];
  const latestRecoveredMinute = restReconciledMinutes.at(-1)!.timestamp;
  let backfillCalls = 0;
  // The coordinator's nowMs() must track this artificial 2026-08-14 timeline, not the real
  // (sandbox) wall clock -- otherwise, since the artificial connect date is in the past
  // relative to real "now", every boundary would already appear crossed.
  let simulatedNowMs = 0;
  const recovery = new MarketDataRecoveryCoordinatorService<{ seededOneMinuteCandles: typeof warmupSeed; latest:Date }>({
    isMarketSession: () => true,
    nowMs: () => simulatedNowMs,
    getLastSeededCompletedMinute: () => lastSeededCompletedMinute,
    liveConstructionAlignmentMinutes: 2,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (requiredCompletedMinute) => {
      backfillCalls += 1;
      assert.equal(requiredCompletedMinute?.toISOString(), latestRecoveredMinute.toISOString());
      return { ready:true, reason:'FRESH_CURRENT_DAY_HISTORY', missingMinutes:2, duplicateMinutes:0, recoveryData:{ seededOneMinuteCandles:restReconciledMinutes, latest:latestRecoveredMinute } };
    },
    onRecovered: (_generationId, recoveryData) => { if (recoveryData) evaluator.recoverHistoricalOneMinute(recoveryData.seededOneMinuteCandles); return undefined; },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });
  candles.start();

  // WebSocket connects mid-minute at 10:01:23, inside an adverse 2m bucket.
  const connectedAt = candle(46, quiet).timestamp; // 10:01:00 base
  const connectedAtMidMinute = new Date(connectedAt.getTime() + 23_000); // 10:00:23
  simulatedNowMs = connectedAtMidMinute.getTime();
  recovery.handleInitialConnected({ generationId: 1, connectedAt: connectedAtMidMinute });
  assert.equal(recovery.getState(), 'AWAITING_LIVE_TICK', 'waiting for the strictly-future 10:03:00 2m boundary');

  // A live tick lands WITHIN the still-forming, gated 10:00 minute -- a deliberately absurd LTP
  // (99999) so that, if the bug regressed, it would be unambiguous in the assertions below.
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: new Date(connectedAtMidMinute.getTime() + 5_000).toISOString(), ltp: 99_999 });
  recovery.handleLiveTick({ sourceTimestamp: new Date(connectedAtMidMinute.getTime() + 5_000), receivedAt: new Date(connectedAtMidMinute.getTime() + 5_000), generationId: 1 });
  assert.equal(completedOneMinute.length, 0, 'no candle -- active or completed -- may ever be built from a tick inside the gated forming minute');
  assert.equal(liveCandleBuilder.getActiveCandle(NIFTY, '1m'), undefined, 'the gated tick must not even seed an active candle');

  // Wall-clock reaches the 10:03:00 aligned boundary. REST owns source through 10:02;
  // live construction owns every bucket starting at 10:03 or later.
  const boundaryTick = new Date(connectedAt.getTime() + 2 * MINUTE); // 10:03:00
  recovery.handleLiveTick({ sourceTimestamp: boundaryTick, receivedAt: boundaryTick, generationId: 1 });
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: boundaryTick.toISOString(), ltp: 24_001 });
  assert.equal(backfillCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  // The earlier (gated, pre-boundary) tick already proved the feed itself was alive
  // (receivedAt >= recoveryStartedAt), so once reconciliation resolves, readiness follows
  // immediately -- this is deliberately decoupled from candle completeness, which is
  // guaranteed unconditionally by the builder's boundary gate regardless of coordinator state.
  assert.equal(recovery.getState(), 'READY');

  // Drive through 10:05 so the first at-boundary 2m candle [10:03,10:04] completes.
  const t1004 = new Date(connectedAt.getTime() + 3 * MINUTE);
  bus.emit('market.tick', { instrumentKey:NIFTY, timestamp:t1004.toISOString(), ltp:24_004 });
  const t1005 = new Date(connectedAt.getTime() + 4 * MINUTE);
  bus.emit('market.tick', { instrumentKey:NIFTY, timestamp:t1005.toISOString(), ltp:24_005 });

  // The absurd, gated tick's value must never have reached any completed candle.
  assert.ok(completedOneMinute.every((entry) => entry.open !== 99_999));
  const gatedMinute = completedOneMinute.find((entry) => entry.candleTime.getTime() === connectedAt.getTime());
  assert.equal(gatedMinute, undefined, 'the live path never completes the REST-owned 10:01 minute');
  assert.ok(completedTwoMinute.some((entry) => entry.candleTime.getTime() === boundaryTick.getTime()), 'the first at-boundary 10:03 direct 2m frame must complete live');

  // Prove the recovered adverse [10:01,10:02] frame is present in the evaluator's real
  // source map, while the disjoint [10:03,10:04] frame is live-owned.
  assert.equal(evaluator.checkStartupReadiness(targetDate).ready, true);
  const recoveredFrame = { timestamp:new Date(connectedAt.getTime()), open:777, high:779, low:776, close:778, volume:0 };
  assert.doesNotThrow(() => evaluator.evaluateCompletedFrameWithDiagnostics(recoveredFrame));
});

test('A7-H2 real-pipeline (V2 requirement): a mid-5m-bucket connect can never evaluate a partial 5m candle -- the complete straddling bucket is instead derived deterministically from REST-reconciled 1m data', async () => {
  const { EventEmitter } = await import('events');
  const { default: LiveCandleBuilderServiceCtor } = await import('../modules/market-data/services/live-candle-builder.service');
  const { default: LiveCandleEventAdapterServiceCtor } = await import('../modules/market-data/services/live-candle-event-adapter.service');
  const { default: LivePaperStrategyAdapterServiceCtor } = await import('../modules/paper-trading/services/live-paper-strategy-adapter.service');
  const { default: CandleTimeframeAggregatorServiceCtor } = await import('../modules/indicators/services/candle-timeframe-aggregator.service');

  const NIFTY = 'NSE_INDEX|Nifty 50';
  const MINUTE = 60_000;
  const sessionStartMs = new Date('2026-08-14T09:15:00+05:30').getTime();
  const quiet = { open: 24_000, high: 24_010, low: 23_990, close: 24_000 };
  function oneMinuteCandle(offsetMinutes: number, ohlc = quiet) {
    return { timestamp: new Date(sessionStartMs + offsetMinutes * MINUTE), ...ohlc, volume: 1 };
  }
  function flat(count: number, startOffset: number) {
    return Array.from({ length: count }, (_, index) => oneMinuteCandle(startOffset + index));
  }

  // Mirrors the exact V2 requirement scenario: REST warmup covers through 14:07 (the minute
  // before the WebSocket connects); 293 one-minute rows aggregate to 58 complete 5m candles,
  // well past the EMA15/EMA35 minimum history (36).
  const restThrough1407 = flat(293, 0); // 09:15 -> 14:07 (293 minutes)
  const aggregator = new CandleTimeframeAggregatorServiceCtor();
  const strategyAdapter = new LivePaperStrategyAdapterServiceCtor({ createFromSignal: async () => { throw new Error('must not be reached in this continuity-only test'); } });
  strategyAdapter.seedHistoricalCandles(aggregator.aggregate(restThrough1407, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' }));
  const lastCurrentDayCandle = restThrough1407[restThrough1407.length - 1].timestamp; // 14:07

  const bus = new EventEmitter();
  const liveCandleBuilder = new LiveCandleBuilderServiceCtor();
  const candles = new LiveCandleEventAdapterServiceCtor(liveCandleBuilder, bus);
  const completedFiveMinute: Array<{ candleTime: Date; open: number }> = [];
  bus.on('market.candle.completed', (event: any) => {
    if (event.instrumentKey === NIFTY && event.completed === true && event.timeframe === '5m') completedFiveMinute.push({ candleTime: event.candleTime, open: event.open });
  });

  // The production recovery target is boundary-1: a 14:10 strategy-safe boundary therefore
  // requires REST through 14:09, making the entire 14:05-14:09 bucket authoritative.
  const restReconciledMinute0408 = oneMinuteCandle(293); // 14:08
  const restReconciledMinute0409 = { ...oneMinuteCandle(294), close:24_009, high:24_009 }; // 14:09
  const recoveredFiveMinute: ReturnType<typeof aggregator.aggregate> = [];
  let simulatedNowMs = 0;
  const recovery = new MarketDataRecoveryCoordinatorService<{ oneMinute: ReturnType<typeof flat>; latest: Date }>({
    isMarketSession: () => true,
    nowMs: () => simulatedNowMs,
    getLastSeededCompletedMinute: () => lastCurrentDayCandle,
    liveConstructionAlignmentMinutes: 5,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (requiredCompletedMinute) => {
      assert.equal(requiredCompletedMinute?.toISOString(), restReconciledMinute0409.timestamp.toISOString());
      return { ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 2, duplicateMinutes: 0, recoveryData: { oneMinute: [...restThrough1407, restReconciledMinute0408, restReconciledMinute0409], latest:restReconciledMinute0409.timestamp } };
    },
    onRecovered: (_generationId, recoveryData) => {
      if (!recoveryData) return undefined;
      const completed5m = aggregator.aggregate(recoveryData.oneMinute, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
      recoveredFiveMinute.push(...completed5m);
      strategyAdapter.recoverHistoricalCandles(completed5m);
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });
  candles.start();

  // WebSocket connects mid-minute at 14:08:xx -- exactly the task's reported scenario.
  const connectedAtMidMinute = new Date(oneMinuteCandle(293).timestamp.getTime() + 23_000); // 14:08:23
  simulatedNowMs = connectedAtMidMinute.getTime();
  recovery.handleInitialConnected({ generationId: 1, connectedAt: connectedAtMidMinute });
  assert.equal(recovery.getState(), 'AWAITING_LIVE_TICK');

  // A tick lands within the gated, still-forming 14:08 minute -- must never build any candle,
  // on any timeframe, including the 5m bucket it belongs to.
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: new Date(connectedAtMidMinute.getTime() + 5_000).toISOString(), ltp: 99_999 });
  recovery.handleLiveTick({ sourceTimestamp: new Date(connectedAtMidMinute.getTime() + 5_000), receivedAt: new Date(connectedAtMidMinute.getTime() + 5_000), generationId: 1 });
  assert.equal(liveCandleBuilder.getActiveCandle(NIFTY, '5m'), undefined, 'the gated tick must not seed any active 5m bucket -- 14:05-14:09 must never be built from a partial post-connect observation');

  // The next strictly-future 5m boundary is 14:10. Recovery runs there through 14:09,
  // while live construction begins with the disjoint 14:10 bucket.
  const boundaryTick = new Date(oneMinuteCandle(295).timestamp.getTime()); // 14:10:00
  recovery.handleLiveTick({ sourceTimestamp: boundaryTick, receivedAt: boundaryTick, generationId: 1 });
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: boundaryTick.toISOString(), ltp: 24_010 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recovery.getState(), 'READY');

  // The complete 14:05-14:09 5m candle must have arrived through the real onRecovered
  // callback. No test-side source-minute injection or recovery call is permitted here.
  const fiveMinuteBucketStart = oneMinuteCandle(290).timestamp.getTime(); // 14:05
  const recoveredBoundaryBucket = recoveredFiveMinute.find((value) => value.timestamp.getTime() === fiveMinuteBucketStart);
  assert.ok(recoveredBoundaryBucket, 'production onRecovered must reconstruct the complete 14:05-14:09 bucket');
  assert.equal(recoveredBoundaryBucket?.close, 24_009);

  // The live path itself must never have independently completed 14:05-14:09 with the
  // gated tick's value -- assert directly against everything the real event bus emitted.
  assert.ok(completedFiveMinute.every((entry) => entry.candleTime.getTime() !== fiveMinuteBucketStart), 'the live builder must never itself complete the boundary-straddling 5m bucket');

  // The first at-boundary live bucket must complete normally and must not overlap recovery.
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: oneMinuteCandle(300).timestamp.toISOString(), ltp:24_015 });
  assert.ok(completedFiveMinute.some((entry) => entry.candleTime.getTime() === boundaryTick.getTime()), 'the 14:10 live bucket must complete normally');
});

test('A7-H2 real-pipeline (V4 requirement): a mid-3m-bucket connect can never evaluate a partial 3m candle, and the derived 5m regime state cannot silently absorb an incomplete handoff bucket', async () => {
  const { EventEmitter } = await import('events');
  const { default: LiveCandleBuilderServiceCtor } = await import('../modules/market-data/services/live-candle-builder.service');
  const { default: LiveCandleEventAdapterServiceCtor } = await import('../modules/market-data/services/live-candle-event-adapter.service');
  const { default: V4NiftyMomentumShadowEvaluatorServiceCtor } = await import('../modules/adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service');

  const NIFTY = 'NSE_INDEX|Nifty 50';
  const MINUTE = 60_000;
  const sessionStartMs = new Date('2026-08-14T09:15:00+05:30').getTime();
  const quiet = { open: 24_000, high: 24_010, low: 23_990, close: 24_000 };
  function oneMinuteCandle(offsetMinutes: number) { return { timestamp: new Date(sessionStartMs + offsetMinutes * MINUTE), ...quiet, volume: 1 }; }
  function flat(count: number, startOffset: number) { return Array.from({ length: count }, (_, index) => oneMinuteCandle(startOffset + index)); }

  const evaluator = new V4NiftyMomentumShadowEvaluatorServiceCtor();
  // 300 one-minute rows aggregate to 60 complete 5m candles -- past the regime engine's
  // EMA35 minimum (35). 300 is a multiple of 3, so the "base" offset below has the same
  // 3m-bucket-alignment properties the scenario relies on.
  const warmup = flat(300, 0); // 09:15 -> 14:14
  evaluator.seedHistoricalOneMinute(warmup);
  const lastCurrentDayCandle = warmup[warmup.length - 1].timestamp;
  const base = warmup.length; // offset of the minute forming at connect

  const bus = new EventEmitter();
  const liveCandleBuilder = new LiveCandleBuilderServiceCtor();
  const candles = new LiveCandleEventAdapterServiceCtor(liveCandleBuilder, bus);
  const completed: Array<{ timeframe: string; candleTime: Date }> = [];
  bus.on('market.candle.completed', (event: any) => {
    if (event.instrumentKey !== NIFTY || event.completed !== true) return;
    completed.push({ timeframe: event.timeframe, candleTime: event.candleTime });
    if (event.timeframe === '5m') evaluator.processCompletedFiveMinute({ timestamp: event.candleTime, open: event.open, high: event.high, low: event.low, close: event.close, volume: 0 });
  });

  const restReconciledThroughBoundary = flat(15, base); // 14:15 through 14:29
  const latestRecoveredMinute = restReconciledThroughBoundary.at(-1)!.timestamp;
  let simulatedNowMs = 0;
  const recovery = new MarketDataRecoveryCoordinatorService<{ oneMinute: ReturnType<typeof flat>; latest:Date }>({
    isMarketSession: () => true,
    nowMs: () => simulatedNowMs,
    getLastSeededCompletedMinute: () => lastCurrentDayCandle,
    liveConstructionAlignmentMinutes: 15,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (requiredCompletedMinute) => {
      assert.equal(requiredCompletedMinute?.toISOString(), latestRecoveredMinute.toISOString());
      return { ready:true, reason:'FRESH_CURRENT_DAY_HISTORY', missingMinutes:15, duplicateMinutes:0, recoveryData:{ oneMinute:restReconciledThroughBoundary, latest:latestRecoveredMinute } };
    },
    onRecovered: (_generationId, recoveryData) => { if (recoveryData) evaluator.recoverHistoricalOneMinute(recoveryData.oneMinute); return undefined; },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });
  candles.start();

  // WebSocket connects mid-minute 23 seconds in -- forming minute is `base`, boundary is `base+1`.
  const connectedAtMidMinute = new Date(oneMinuteCandle(base).timestamp.getTime() + 23_000);
  simulatedNowMs = connectedAtMidMinute.getTime();
  recovery.handleInitialConnected({ generationId: 1, connectedAt: connectedAtMidMinute });

  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: new Date(connectedAtMidMinute.getTime() + 5_000).toISOString(), ltp: 99_999 });
  recovery.handleLiveTick({ sourceTimestamp: new Date(connectedAtMidMinute.getTime() + 5_000), receivedAt: new Date(connectedAtMidMinute.getTime() + 5_000), generationId: 1 });
  assert.equal(completed.length, 0, 'no candle on any timeframe may be built from a tick inside the gated forming minute');

  const boundaryTick = new Date(oneMinuteCandle(base + 15).timestamp.getTime()); // 14:30, aligned to both 3m and 5m
  recovery.handleLiveTick({ sourceTimestamp: boundaryTick, receivedAt: boundaryTick, generationId: 1 });
  bus.emit('market.tick', { instrumentKey: NIFTY, timestamp: boundaryTick.toISOString(), ltp: 24_000 });
  await new Promise((resolve) => setImmediate(resolve));

  // Production recoverHistoricalOneMinute must have reconstructed every complete 3m and 5m
  // bucket before 14:30. Inspect the evaluator's real derived histories rather than manually
  // calling recovery or injecting a source minute from the test.
  const straddlingBucketStart = oneMinuteCandle(base).timestamp.getTime();
  const recoveredHistories = evaluator as unknown as { threeMinute: Array<{timestamp:Date}>; fiveMinute:Array<{timestamp:Date}> };
  assert.ok(recoveredHistories.threeMinute.some((entry) => entry.timestamp.getTime() === straddlingBucketStart), 'production recovery must reconstruct the 14:15 3m bucket');
  assert.ok(recoveredHistories.fiveMinute.some((entry) => entry.timestamp.getTime() === straddlingBucketStart), 'production recovery must reconstruct the 14:15 5m bucket');

  // At/after 14:30 belongs exclusively to live construction. Drive enough ticks to roll
  // both the first 3m and 5m buckets and prove neither timeframe has an ownership gap.
  [16, 17, 18, 19, 20].forEach((offset) => bus.emit('market.tick', { instrumentKey:NIFTY, timestamp:oneMinuteCandle(base + offset).timestamp.toISOString(), ltp:24_000 + offset }));
  assert.ok(completed.some((entry) => entry.timeframe === '3m' && entry.candleTime.getTime() === boundaryTick.getTime()), 'the first at-boundary 3m bucket must complete live');
  assert.ok(completed.some((entry) => entry.timeframe === '5m' && entry.candleTime.getTime() === boundaryTick.getTime()), 'the first at-boundary 5m bucket must complete live');
});

// ---- Static production-wiring checks against the real V2/V4/V8 entrypoints ----

const runtimes: Record<'V2' | 'V4' | 'V8', { file: string; warmupField: string }> = {
  V2: { file: 'src/tests/test-live-paper-trading.ts', warmupField: 'warmupResult.lastCurrentDayCandle' },
  V4: { file: 'src/tests/test-live-v4-nifty-momentum-shadow.ts', warmupField: 'warmup.lastCurrentDayCandle' },
  V8: { file: 'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts', warmupField: 'warmup.lastCurrentDayCandle' },
};

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

test('A7-H1: V2, V4 and V8 each wire getLastSeededCompletedMinute to the SEMANTICALLY correct warmup field (lastCurrentDayCandle), not merely to some field', () => {
  for (const [name, { file, warmupField }] of Object.entries(runtimes)) {
    const text = source(file);
    assert.ok(
      text.includes(`getLastSeededCompletedMinute: () => ${warmupField}`),
      `${name}: expected getLastSeededCompletedMinute wired exactly to ${warmupField}`,
    );
  }
});

test('A7-H1: V2, V4 and V8 each still gate RUNNING through onReady awaiting recovery.waitUntilReady(...) -- the cold-start fix must compose with, not bypass, the existing live-readiness gate', () => {
  for (const [name, { file }] of Object.entries(runtimes)) {
    const text = source(file);
    assert.ok(text.includes('onReady'), `${name}: expected an onReady hook`);
    assert.ok(text.includes('recovery.waitUntilReady('), `${name}: expected onReady to await recovery.waitUntilReady(...)`);
  }
});

test('A7-H1: MarketDataRecoveryCoordinatorService is constructed directly (via `new`) in all three entrypoints -- no separate per-strategy wrapper/factory that could diverge or silently drop a method', () => {
  for (const [name, { file }] of Object.entries(runtimes)) {
    const text = source(file);
    assert.ok(
      text.includes('new MarketDataRecoveryCoordinatorService<RecoveryWarmup>('),
      `${name}: expected the SAME direct class construction shared by every entrypoint`,
    );
  }
});

test('A7-H2: V2, V4 and V8 each wire onLiveConstructionBoundary to LiveCandleBuilderService.setLiveConstructionBoundary -- the mid-bucket handoff fix must reach the live candle builder in every entrypoint, not merely the coordinator', () => {
  const alignments: Record<string, number> = { V2:5, V4:15, V8:2 };
  for (const [name, { file }] of Object.entries(runtimes)) {
    const text = source(file);
    assert.ok(text.includes('onLiveConstructionBoundary:'), `${name}: expected an onLiveConstructionBoundary callback wired on the recovery coordinator`);
    assert.ok(text.includes('.setLiveConstructionBoundary('), `${name}: expected onLiveConstructionBoundary to call liveCandleBuilder.setLiveConstructionBoundary(...)`);
    assert.ok(text.includes(`const liveConstructionAlignmentMinutes = ${alignments[name]}`), `${name}: expected the strategy-safe aligned handoff boundary`);
    assert.ok(text.includes('liveConstructionAlignmentMinutes,'), `${name}: expected the alignment to be passed to the recovery coordinator`);
    assert.ok(text.includes('getRecoveredCompletedMinute:'), `${name}: expected READY to verify authoritative recovery through boundary minus one minute`);
    assert.ok(text.includes('onLiveConstructionUnavailable:'), `${name}: expected a canonical-close construction block when no same-session aligned handoff exists`);
    assert.ok(text.includes('maximumReconnectDurationMs:reconnectDurationMs'), `${name}: expected reconnect ownership to remain alive through the bounded handoff wait`);
    assert.ok(text.includes('generationGraceMs:healthGraceMs'), `${name}: expected health grace to distinguish intentional handoff waiting from a stall`);
  }
});
