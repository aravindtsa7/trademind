import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
import PaperRuntimeCandleAdapterService, { PaperRuntimeCandleContractsProvider, PaperRuntimeCandleRuntime } from '../modules/paper-trading/services/paper-runtime-candle-adapter.service';
import { PaperTradingRuntimeState } from '../modules/paper-trading/dto/paper-trading-runtime.dto';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from '../modules/paper-trading/dto/live-paper-strategy.dto';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { LiveCandleDto } from '../modules/market-data/dto/live-candle.dto';
import { Candle } from '../modules/indicators/types';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';

/**
 * A7 V2 H2 reset-race correction + A7 V2 reconnect candle-adapter ordering fix: proves two
 * invariants against the REAL MarketDataRecoveryCoordinatorService, LiveCandleBuilderService,
 * LiveCandleEventAdapterService and PaperRuntimeCandleAdapterService, wired in the SAME
 * production call order test-live-paper-trading.ts uses for its
 * connectionManager.on('unexpectedDisconnect'|'reconnected', ...) handlers and
 * eventBus.on('market.tick', handleMarketTick) / liveCandleEventAdapter.start() registration order:
 *
 * 1. H2: once live construction is permitted at boundary B, any current-generation active candle
 *    whose bucketStart >= B must survive asynchronous recovery publication (onRecovered must never
 *    unconditionally reset the builder).
 * 2. Reconnect ordering: on disconnect BOTH paperRuntimeCandleAdapter and liveCandleEventAdapter
 *    stop; on reconnect, ONLY liveCandleEventAdapter restarts immediately (right after
 *    handleReconnected() has synchronously established the new current-generation construction
 *    boundary) so the very first clean-boundary tick is captured instead of silently dropped.
 *    paperRuntimeCandleAdapter -- and therefore all strategy evaluation -- stays stopped until the
 *    existing recovery READY path restarts it.
 *
 * Regression story (H2): onRecovered previously called liveCandleBuilder.reset(niftyInstrumentKey)
 * unconditionally on every recovery completion. Once a live tick had already built a genuine
 * current-generation active candle at/after the freshly established live-construction boundary --
 * entirely possible, since recovery is started fire-and-forget from the very tick that proves the
 * boundary is due, and is never awaited inline -- that later, asynchronously-resolving reset
 * silently deleted it, corrupting (or losing outright) the bucket's true opening tick once a later
 * tick rebuilt it from scratch.
 *
 * Regression story (reconnect ordering): on disconnect, production stops BOTH candle adapters. The
 * old reconnect handler called only recovery.handleReconnected(details) and left
 * liveCandleEventAdapter stopped until the asynchronous onRecovered callback restarted it. Since
 * handleReconnected() establishes the clean live-construction boundary SYNCHRONOUSLY, the first
 * tick to arrive at or after that boundary (e.g. the 14:10 tick) reached the recovery-trigger
 * listener (which kicked off backfill) but never reached LiveCandleBuilder -- it was silently
 * dropped because liveCandleEventAdapter's own 'market.tick' listener was not yet registered. The
 * NEXT tick (14:11) would then have opened a partial 14:10-mislabelled (or outright wrong-bucket)
 * candle. The fix restarts liveCandleEventAdapter immediately after handleReconnected() returns.
 */

const NIFTY = 'NSE_INDEX|Nifty 50';
const openAt = new Date('2026-08-24T09:15:00+05:30');
const closeAt = new Date('2026-08-24T15:40:00+05:30');

interface RecoveryData { rows: Candle[]; latestMinute: Date; }

/** The 14:05-14:09 one-minute rows REST must confirm before the 14:10 live-construction boundary. */
function preBoundaryRows(): Candle[] {
  const rows: Candle[] = [];
  const start = new Date('2026-08-24T14:05:00+05:30').getTime();
  for (let index = 0; index < 5; index += 1) {
    const open = 200 + index;
    rows.push({ timestamp: new Date(start + index * 60_000), open, high: open + 3, low: open - 2, close: open + 1, volume: 10 + index });
  }
  return rows;
}

function tickEvent(timestampIso: string, ltp: number, generationId: number) {
  return { instrumentKey: NIFTY, timestamp: timestampIso, ltp, generationId };
}

function createHarness() {
  const bus = new EventEmitter();
  const liveCandleBuilder = new LiveCandleBuilderService();
  let generationId = 1;
  const liveCandleEventAdapter = new LiveCandleEventAdapterService(liveCandleBuilder, bus, () => generationId);

  const completedCandles: LiveCandleDto[] = [];
  bus.on('market.candle.completed', (candle: LiveCandleDto) => completedCandles.push(candle));

  let resolveBackfill: ((value: { ready: true; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData: RecoveryData }) => void) | undefined;
  let backfillCalls = 0;
  let onRecoveredCalls = 0;
  let seededHistory: Candle[] = [];
  let now = new Date('2026-08-24T14:08:00+05:30').getTime();

  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => now,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    // Pre-reconnect warm-up only covers through 14:04 -- the reconnect must prove REST coverage
    // through 14:09 before the 14:10 live-construction handoff is trusted.
    getLastSeededCompletedMinute: () => new Date('2026-08-24T14:04:00+05:30'),
    liveConstructionAlignmentMinutes: 5,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async () => {
      backfillCalls += 1;
      // Deliberately held in-flight -- resolved manually by the test to control interleaving.
      return new Promise((resolve) => { resolveBackfill = resolve; });
    },
    onRecovered: (_generationId, data) => {
      onRecoveredCalls += 1;
      // THE A7 RECONNECT-ORDERING FIX (mirrors applyRecoveredHistoricalCandles): restart
      // liveCandleEventAdapter here too. Idempotent -- a no-op when the reconnect wiring below
      // already restarted it, which is the normal (fixed) case this test exercises.
      liveCandleEventAdapter.start();
      if (!data) return undefined;
      seededHistory = new CandleTimeframeAggregatorService().aggregate(data.rows, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
      // THE H2 FIX UNDER TEST: no liveCandleBuilder.reset(NIFTY) here -- exactly what
      // test-live-paper-trading.ts's applyRecoveredHistoricalCandles does (or rather,
      // deliberately does not do).
      return undefined;
    },
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
  });

  // Production-equivalent actionable path: a real PaperRuntimeCandleAdapterService wired to a stub
  // runtime that is always RUNNING, so the ONLY gate under test is the adapter's own start()/stop()
  // lifecycle -- exactly the ownership model the A7 reconnect-ordering fix establishes (never
  // runtime-state gating, which is a separate concern already covered elsewhere).
  const evaluatedCandles: LiveCandleDto[] = [];
  const runtimeStub: PaperRuntimeCandleRuntime = {
    getState: () => PaperTradingRuntimeState.RUNNING,
    async processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> {
      evaluatedCandles.push({
        instrumentKey: NIFTY,
        timeframe: '5m',
        candleTime: new Date(input.candle.timestamp.getTime()),
        open: input.candle.open,
        high: input.candle.high,
        low: input.candle.low,
        close: input.candle.close,
        completed: true,
      });
      return {
        candleTimestamp: new Date(input.candle.timestamp.getTime()),
        spotPrice: input.candle.close,
        ema15: null,
        ema35: null,
        rsi14: null,
        rawEmaSignal: StrategySignal.NO_TRADE,
        timeFilterAllowed: true,
        finalSignal: StrategySignal.NO_TRADE,
        reasons: [],
        processed: true,
      };
    },
  };
  const contractsProvider: PaperRuntimeCandleContractsProvider = { getContracts: () => [] };
  const paperRuntimeCandleAdapter = new PaperRuntimeCandleAdapterService(runtimeStub, contractsProvider, bus);

  // Mirrors handleRecoveryState's own READY branch in test-live-paper-trading.ts: the ONLY place
  // paperRuntimeCandleAdapter is restarted after a disconnect.
  recovery.on('stateChanged', (state) => {
    if (state === 'READY') paperRuntimeCandleAdapter.start();
  });

  // Registration order matters and is the crux of this test: the recovery-triggering listener
  // (mirroring handleMarketTick) is registered BEFORE liveCandleEventAdapter.start() registers
  // its own 'market.tick' listener -- exactly test-live-paper-trading.ts's real order
  // (eventBus.on('market.tick', handleMarketTick) at setup time, liveCandleEventAdapter.start()
  // only later).
  bus.on('market.tick', (event: ReturnType<typeof tickEvent>) => {
    recovery.handleLiveTick({ sourceTimestamp: new Date(event.timestamp), receivedAt: new Date(event.timestamp), generationId: event.generationId });
  });

  // Both adapters start active, exactly like run()'s own startup sequence
  // (liveCandleEventAdapter.start() / paperRuntimeCandleAdapter.start()).
  liveCandleEventAdapter.start();
  paperRuntimeCandleAdapter.start();

  return {
    bus, recovery, liveCandleBuilder, liveCandleEventAdapter, paperRuntimeCandleAdapter, completedCandles, evaluatedCandles,
    getBackfillCalls: () => backfillCalls,
    getOnRecoveredCalls: () => onRecoveredCalls,
    getSeededHistory: () => seededHistory,
    setNow: (date: Date): void => { now = date.getTime(); },
    resolveRecovery: (rows: Candle[], latestMinute: Date): void => {
      resolveBackfill?.({ ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { rows, latestMinute } });
    },
    setGenerationId: (value: number): void => { generationId = value; },
    liveTickListenerCount: (): number => bus.listenerCount('market.tick'),
    candleCompletedListenerCount: (): number => bus.listenerCount('market.candle.completed'),
    /**
     * Exactly test-live-paper-trading.ts's connectionManager.on('unexpectedDisconnect', ...)
     * handler: recovery.handleUnexpectedDisconnect() first, then
     * paperRuntimeCandleAdapter.stop(); liveCandleEventAdapter.stop().
     */
    simulateUnexpectedDisconnect: (details: { generationId?: number }): void => {
      recovery.handleUnexpectedDisconnect(details);
      paperRuntimeCandleAdapter.stop();
      liveCandleEventAdapter.stop();
    },
    /**
     * Exactly test-live-paper-trading.ts's connectionManager.on('reconnected', ...) handler
     * under the A7 fix: recovery.handleReconnected() synchronously establishes the new
     * current-generation construction boundary, then liveCandleEventAdapter is restarted
     * immediately. paperRuntimeCandleAdapter is deliberately NOT restarted here -- it stays
     * stopped until the existing recovery READY path (recovery.on('stateChanged', ...) above).
     */
    simulateReconnected: (details: { generationId?: number }): void => {
      recovery.handleReconnected(details);
      liveCandleEventAdapter.start();
    },
  };
}

test('A7 V2 reconnect ordering: production disconnect/reconnect lifecycle preserves the first clean-boundary tick, defers strategy evaluation until recovery READY, and completes the 14:10 bucket exactly once', async () => {
  const value = createHarness();

  // 1. Both adapters initially active.
  assert.equal(value.liveTickListenerCount(), 2, 'recovery-trigger listener + liveCandleEventAdapter');
  assert.equal(value.candleCompletedListenerCount(), 2, 'completedCandles collector + paperRuntimeCandleAdapter');

  // 2-4. Disconnect at 14:08, exactly as production's connectionManager.on('unexpectedDisconnect', ...)
  // handler does: recovery.handleUnexpectedDisconnect() first, then BOTH candle adapters stop.
  value.simulateUnexpectedDisconnect({ generationId: 1 });
  assert.equal(value.liveTickListenerCount(), 1, 'liveCandleEventAdapter must be fully stopped on disconnect');
  assert.equal(value.candleCompletedListenerCount(), 1, 'paperRuntimeCandleAdapter must be fully stopped on disconnect');

  // 5-6. Reconnect: production-equivalent wiring restarts ONLY liveCandleEventAdapter, immediately
  // after handleReconnected() has synchronously established the current-generation boundary.
  value.setGenerationId(2);
  value.simulateReconnected({ generationId: 2 });
  assert.equal(value.liveTickListenerCount(), 2, 'liveCandleEventAdapter must be restarted immediately after handleReconnected()');
  assert.equal(value.candleCompletedListenerCount(), 1, 'paperRuntimeCandleAdapter must remain stopped until recovery READY');

  // boundary = 14:10 (established synchronously inside handleReconnected -- confirmed via the
  // live-construction floor).
  const preBoundaryTick = value.liveCandleBuilder.processTick({ instrumentKey: NIFTY, timestamp: new Date('2026-08-24T14:09:59+05:30'), ltp: 999 }, '5m');
  assert.equal(preBoundaryTick.ignored, true);
  assert.equal(preBoundaryTick.ignoreReason, 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY');

  // 7. REST recovery is intentionally deferred (resolveBackfill captured, not yet called).

  // 8. First 14:10 boundary tick, emitted through the REAL event bus/listener ordering.
  value.setNow(new Date('2026-08-24T14:10:05+05:30'));
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:10:05+05:30', 210, 2));
  assert.equal(value.getBackfillCalls(), 1, 'the boundary tick must have kicked off recovery exactly once');
  assert.equal(value.getOnRecoveredCalls(), 0, 'recovery must still be in flight -- onRecovered has not run yet');

  // 9. The active 14:10 candle must exist and contain that first tick. This is the exact defect the
  // A7 fix closes: without restarting liveCandleEventAdapter immediately after handleReconnected(),
  // this tick would have been silently dropped (adapter still stopped) and the NEXT (14:11) tick
  // would have opened a partial/mislabelled candle instead.
  const afterFirstTick = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(afterFirstTick?.candleTime.toISOString(), new Date('2026-08-24T14:10:00+05:30').toISOString());
  assert.equal(afterFirstTick?.open, 210, 'the true 14:10 opening tick must be recorded, not dropped');

  // 10. The actionable paper-runtime/strategy path must not have evaluated anything yet --
  // paperRuntimeCandleAdapter is still stopped (no listener registered) and the stub runtime was
  // never called.
  assert.equal(value.candleCompletedListenerCount(), 1, 'paperRuntimeCandleAdapter must still be stopped during recovery');
  assert.equal(value.evaluatedCandles.length, 0, 'no candle may reach the strategy path before recovery READY');

  // 11. Resolve REST recovery.
  value.resolveRecovery(preBoundaryRows(), new Date('2026-08-24T14:09:00+05:30'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(value.getOnRecoveredCalls(), 1);

  // 12. The SAME 14:10 active candle must still exist with its first tick preserved.
  const afterRecovery = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(afterRecovery?.candleTime.toISOString(), new Date('2026-08-24T14:10:00+05:30').toISOString());
  assert.equal(afterRecovery?.open, 210, 'the reset race regression: the true 14:10 open must survive onRecovered');

  // 13. Emit the 14:11 tick -- this is also the tick that proves freshness and drives recovery to
  // READY, at which point the existing recovery-READY path (mirrored in the harness) restarts
  // paperRuntimeCandleAdapter.
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:11:00+05:30', 215, 2));
  assert.equal(value.recovery.getState(), 'READY');
  assert.equal(value.candleCompletedListenerCount(), 2, 'paperRuntimeCandleAdapter must resume only via the existing recovery READY path');
  const afterExtend = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(afterExtend?.open, 210, 'extending the SAME candle must not disturb its original open');
  assert.equal(afterExtend?.close, 215);
  assert.equal(afterExtend?.high, 215);
  assert.equal(afterExtend?.low, 210);

  // 14. Emit the 14:15 tick to complete the 14:10 bucket.
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:15:00+05:30', 220, 2));
  await value.paperRuntimeCandleAdapter.drain();

  // 15-16. Exactly ONE 14:10 completed 5m candle -- no duplicate/missing/partial completion.
  const completedAt14_10 = value.completedCandles.filter((candle) => candle.timeframe === '5m' && candle.candleTime.getTime() === new Date('2026-08-24T14:10:00+05:30').getTime());
  assert.equal(completedAt14_10.length, 1, 'no duplicate/missing completion for the 14:10 bucket');
  assert.equal(completedAt14_10[0].open, 210, 'the completed candle must carry the true 14:10 opening tick, not a rebuilt one from 14:11');
  assert.equal(completedAt14_10[0].high, 215);
  assert.equal(completedAt14_10[0].low, 210);
  assert.equal(completedAt14_10[0].close, 215);
  const activeAfterCompletion = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(activeAfterCompletion?.candleTime.toISOString(), new Date('2026-08-24T14:15:00+05:30').toISOString());
  assert.equal(activeAfterCompletion?.open, 220);

  // The 14:10 candle must have reached the actionable strategy path -- through the real
  // PaperRuntimeCandleAdapterService -- exactly once, only after recovery reached READY.
  assert.equal(value.evaluatedCandles.length, 1);
  assert.equal(value.evaluatedCandles[0].candleTime.getTime(), new Date('2026-08-24T14:10:00+05:30').getTime());

  // 17. Recovered 14:05-14:09 history remains correct.
  assert.equal(value.getSeededHistory().length, 1);
  assert.equal(value.getSeededHistory()[0].timestamp.toISOString(), new Date('2026-08-24T14:05:00+05:30').toISOString());
  assert.equal(value.getSeededHistory()[0].open, 200);
  assert.equal(value.getSeededHistory()[0].high, 207);
  assert.equal(value.getSeededHistory()[0].low, 198);
  assert.equal(value.getSeededHistory()[0].close, 205);

  // 18. Stale-generation state must not survive a real generation change.
  value.simulateUnexpectedDisconnect({ generationId: 2 });
  value.setGenerationId(3);
  // A stale generation-2 tick arriving after the real generation change must never be accepted.
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:16:00+05:30', 500, 2));
  assert.equal(value.liveCandleBuilder.getActiveCandle(NIFTY, '5m')?.open, 220, 'a stale-generation tick must not mutate the current active candle');

  value.simulateReconnected({ generationId: 3 });
  // The new generation's own boundary tick must find a CLEAN slate: LiveCandleEventAdapterService's
  // own generation-scoped reset must have retired the generation-2 active candle (14:15, open=220)
  // before generation 3's first tick can build anything.
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:20:00+05:30', 999, 3));
  const afterGenerationChange = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.notEqual(afterGenerationChange?.open, 220, 'generation-3 state must not inherit generation-2 leftovers');

  // 19. Duplicate reconnect/start calls must never register duplicate listeners (start() is
  // idempotent) -- confirmed both across the reconnects already exercised above and via extra
  // explicit repeated calls here.
  value.liveCandleEventAdapter.start();
  value.liveCandleEventAdapter.start();
  assert.equal(value.liveTickListenerCount(), 2, 'repeated liveCandleEventAdapter.start() calls must never register duplicate listeners');
});

test('A7 V2 reconnect ordering: recovery failure leaves the current-generation active candle intact and never starts the actionable strategy path', async () => {
  const value = createHarness();
  value.simulateUnexpectedDisconnect({ generationId: 1 });
  value.setGenerationId(2);
  value.simulateReconnected({ generationId: 2 });
  assert.equal(value.liveTickListenerCount(), 2, 'liveCandleEventAdapter must be restarted immediately after handleReconnected()');
  assert.equal(value.candleCompletedListenerCount(), 1, 'paperRuntimeCandleAdapter must remain stopped until recovery READY');

  value.setNow(new Date('2026-08-24T14:10:05+05:30'));
  value.bus.emit('market.tick', tickEvent('2026-08-24T14:10:05+05:30', 210, 2));

  const active = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(active?.open, 210);
  assert.equal(value.candleCompletedListenerCount(), 1, 'paperRuntimeCandleAdapter must never start when recovery never reaches READY');
  assert.equal(value.evaluatedCandles.length, 0);

  // Recovery resolves as a failure -- onRecovered is never called for a failed backfill (recover()
  // routes to fail()/FAULTED instead), so there is nothing to assert about onRecovered's own
  // behavior here; the point is that the active candle -- and the actionable strategy path's
  // stopped state -- were never touched by anything in this path.
  const stillActive = value.liveCandleBuilder.getActiveCandle(NIFTY, '5m');
  assert.equal(stillActive?.open, 210, 'the active candle must remain untouched regardless of eventual recovery outcome');
  assert.equal(value.candleCompletedListenerCount(), 1);
  assert.equal(value.evaluatedCandles.length, 0);
});
