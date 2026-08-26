import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import eventBus from '../core/events';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import { Candle } from '../modules/indicators/types';
import MarketDataWebSocketClient from '../modules/market-data/client/websocket.client';
import ConnectionManager from '../modules/market-data/managers/connection.manager';
import SubscriptionManager, {
  MarketDataSubscriptionMode,
} from '../modules/market-data/managers/subscription.manager';
import ProtobufDecoder from '../modules/market-data/protobuf/protobuf.decoder';
import TickProcessor, {
  MarketDepthEvent,
  MarketTickEvent,
} from '../modules/market-data/processors/tick.processor';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import { SourceBoundaryEvaluationCoverageTracker } from '../modules/market-data/services/source-boundary-evaluation-coverage';
import {
  NseSessionEodCoordinator,
  isAtOrAfterNseSessionClose,
  isWithinNseSession,
} from '../modules/market-data/services/nse-session-calendar.service';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { StrategyTerminalOutcomeArbiter } from '../modules/market-data/services/strategy-terminal-outcome-arbiter.service';
import { LiveGenerationCacheScope } from '../modules/market-data/utils/live-generation-cache';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import LivePaperFreshWarmupService from '../modules/paper-trading/services/live-paper-fresh-warmup.service';
import { PaperStrategyWarmupTarget } from '../modules/paper-trading/dto/paper-strategy-warmup.dto';
import MarketDataHealthMonitorService from '../modules/market-data/services/market-data-health-monitor.service';
import V8BullishReclaimShadowEvaluatorService, {
  describeV8ErrorSafely,
  isV8CompletedUnderlyingCandleEvent,
  routeV8CompletedCandleFailure,
  v8ObserveTerminalFailure,
  V8ShadowRuntimeCounters,
} from '../modules/adaptive-intraday/services/v8-bullish-reclaim-shadow.service';
import V8ShadowObservationTracker, {
  V8ShadowResolution,
} from '../modules/adaptive-intraday/services/v8-shadow-observation-tracker.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import {
  ForwardValidationJournal,
  normalizeQuote,
  resolveSessionOutcome,
  strategyFingerprint,
  executionComparison,
} from '../modules/research-validation';
import { v8FrozenStrategyInputs } from '../modules/research/v8-nifty-bullish-reclaim';

const NIFTY = 'NSE_INDEX|Nifty 50';
const STRATEGY = 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW';
const frozenPath = resolve(
  process.cwd(),
  'artifacts/v8-nifty-bullish-reclaim/train-only-freeze-v1/frozen-candidate.json',
);
class WarmupTarget implements PaperStrategyWarmupTarget {
  private count = 0;
  seedHistoricalCandles(c: readonly Candle[]): void {
    this.count = c.length;
  }
  isWarmupReady(): boolean {
    return this.count >= 36;
  }
}
class CurrentNiftyCeContracts {
  constructor(
    private readonly repo = new InstrumentRepository(),
    private readonly selector = new OptionContractSelectorService(),
  ) {}
  async resolve(spotPrice: number, timestamp: Date): Promise<OptionContract> {
    const contracts = (await this.repo.findActive())
      .filter((i) => isNifty(i.underlyingSymbol) && i.instrumentType === 'CE')
      .map((i) => ({
        instrumentKey: i.instrumentKey,
        tradingSymbol: i.tradingSymbol,
        underlying: 'NIFTY 50',
        strikePrice: Number(i.strikePrice),
        expiry: new Date(i.expiry),
        optionType: 'CE' as const,
        exchange: i.exchange,
        segment: i.segment,
        lotSize: i.lotSize,
      }));
    if (!contracts.length) throw Error('No active NIFTY CE contracts available for V8 shadow.');
    const s = this.selector.select({
      underlying: 'NIFTY 50',
      spotPrice,
      signal: StrategySignal.BUY_CE,
      timestamp,
      contracts,
    });
    const found = contracts.find((c) => c.instrumentKey === s.instrumentKey);
    if (!found) throw Error('CE selection returned unknown contract.');
    return found;
  }
}
/** Validates at the environment/config boundary, naming the offending variable, matching the style already used by ConnectionManager/MarketDataHealthMonitorService. */
function positiveTimeoutMs(name: string, environmentValue: string | undefined, fallback: number): number {
  const value = environmentValue === undefined ? fallback : Number(environmentValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}
async function run(): Promise<void> {
  if (process.env.SHADOW_ONLY !== 'true' || process.env.PAPER_TRADING_ONLY !== 'true')
    throw Error('V8 shadow requires SHADOW_ONLY=true and PAPER_TRADING_ONLY=true.');
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as {
    candidate: { config: any; policy: any };
    fingerprint?: string;
  };
  const inputs = v8FrozenStrategyInputs(frozen.candidate);
  const fingerprint = strategyFingerprint({ ...inputs });
  if (frozen.fingerprint && frozen.fingerprint !== fingerprint)
    throw Error('Frozen V8 fingerprint mismatch; refusing runtime.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw Error('UPSTOX_ACCESS_TOKEN is required for V8 shadow market-data observation.');
  if (!isWithinNseSession(new Date())) {
    console.log(
      '[V8_STARTUP] Outside configured NSE derivatives session; no observations created.',
    );
    return;
  }
  const date = istDate(new Date());
  const journal = new ForwardValidationJournal(STRATEGY, fingerprint);
  if (journal.hasRecordsForDate(date))
    journal.appendEvent(date, 'MANUAL_RESTART', ['MANUAL_RESTART']);
  const warmup = await new LivePaperFreshWarmupService(
    new HistoricalCandleRepository(),
    new WarmupTarget(),
  ).warmUp();
  if (!warmup.ready) {
    console.log(`[V8_STARTUP] BLOCKED_NOT_READY reason=${warmup.freshnessReason}`);
    const outcome = resolveSessionOutcome({
      reason: warmup.freshnessReason,
      invalidData: true,
    });
    journal.append({
      recordType: 'SUMMARY',
      tradingDate: date,
      strategyId: STRATEGY,
      fingerprint,
      sessionCompleted: outcome.sessionCompleted,
      eodReason: warmup.freshnessReason,
      status: outcome.status,
      flags: ['FORWARD_EVALUATION_ONLY', 'SHADOW_ONLY', 'ZERO_ORDER', 'STARTUP_DATA_BLOCKED'],
    });
    return;
  }
  const evaluator = new V8BullishReclaimShadowEvaluatorService(frozen.candidate.config);
  evaluator.seedHistoricalOneMinute(warmup.seededOneMinuteCandles);
  const startupReadiness = evaluator.checkStartupReadiness(date);
  if (!startupReadiness.ready) {
    console.log(`[V8_STARTUP] BLOCKED_NOT_READY reason=${startupReadiness.reason}`);
    const outcome = resolveSessionOutcome({
      reason: startupReadiness.reason,
      invalidData: true,
    });
    journal.append({
      recordType: 'SUMMARY',
      tradingDate: date,
      strategyId: STRATEGY,
      fingerprint,
      sessionCompleted: outcome.sessionCompleted,
      eodReason: startupReadiness.reason,
      status: outcome.status,
      flags: ['FORWARD_EVALUATION_ONLY', 'SHADOW_ONLY', 'ZERO_ORDER', 'STARTUP_DATA_BLOCKED'],
    });
    return;
  }
  journal.append({
    recordType: 'SESSION',
    tradingDate: date,
    strategyId: STRATEGY,
    fingerprint,
    runtimeStartedAt: new Date().toISOString(),
    warmupReadyAt: new Date().toISOString(),
    marketDataHealthy: true,
    sessionCompleted: false,
    flags: ['FORWARD_EVALUATION_ONLY', 'SHADOW_ONLY', 'ZERO_ORDER'],
  });
  console.log(`[V8_FORWARD_FINGERPRINT] strategyId=${STRATEGY} fingerprint=${fingerprint}`);
  const liveConstructionAlignmentMinutes = 2;
  const alignedHandoffWaitMs = liveConstructionAlignmentMinutes * 60_000;
  // A7-H6 V8: V8 has no separate wall-clock-triggered final evaluation the way V2/V4 do (see
  // v8-source-boundary-non-requirement.test.ts) -- its one required final opportunity is
  // whichever 2m bucket is the LAST one its own 09:15-anchored grid can ever complete before
  // the NIFTY 1m source horizon (15:29 IST): 15:27-15:28, becoming evaluable once the boundary
  // at 15:29 is reached. Derived from the canonical nifty1mSourceCompletionBoundary utility
  // (15:30) minus 1 minute (the coordinator's own boundary-1-minute convention) minus this
  // strategy's own 2-minute alignment -- never a duplicate hardcoded literal.
  const v8FinalBucketStart = new Date(nifty1mSourceCompletionBoundary(new Date()).getTime() - 60_000 - liveConstructionAlignmentMinutes * 60_000);
  // Owned evidence for whether the one required final live evaluation of the 15:27-15:28 frame
  // actually ran through the normal live evaluator path exactly once. Reuses
  // SourceBoundaryEvaluationCoverageTracker (already proven correct for V2/V4's own once-per-
  // session final-evaluation requirement) with a fixed, deliberately generation-INDEPENDENT
  // token: this requirement, like V2/V4's, is a once-per-SESSION fact, not a once-per-
  // connection-generation one -- an intervening, unrelated reconnect must never be able to
  // silently orphan (or overwrite) a requirement/record that already reached EVALUATED, nor
  // prevent a later live-tick-driven evaluation (which reads connection.getGenerationId() at
  // evaluation time, not at arm time) from being able to mark it.
  const v8FinalOpportunityToken = 1;
  const v8FinalOpportunityCoverage = new SourceBoundaryEvaluationCoverageTracker('shadow:v8:reclaim', STRATEGY);
  v8FinalOpportunityCoverage.require(v8FinalOpportunityToken, v8FinalBucketStart);
  const startupReadyTimeoutMs = positiveTimeoutMs('MARKET_DATA_STARTUP_READY_TIMEOUT_MS', process.env.MARKET_DATA_STARTUP_READY_TIMEOUT_MS, 45_000) + alignedHandoffWaitMs;
  const healthGraceMs = positiveTimeoutMs('MARKET_DATA_HEALTH_GRACE_MS', process.env.MARKET_DATA_HEALTH_GRACE_MS, 45_000) + alignedHandoffWaitMs;
  const reconnectDurationMs = positiveTimeoutMs('MARKET_DATA_MAX_RECONNECT_DURATION_MS', process.env.MARKET_DATA_MAX_RECONNECT_DURATION_MS, 60_000) + alignedHandoffWaitMs;
  const websocket = new MarketDataWebSocketClient(token),
    connection = new ConnectionManager(token, websocket, { maximumReconnectDurationMs:reconnectDurationMs }),
    subscriptions = new SubscriptionManager(token, connection),
    decoder = new ProtobufDecoder(),
    ticks = new TickProcessor(),
    liveCandleBuilder = new LiveCandleBuilderService(),
    candles = new LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connection.getGenerationId()),
    tracker = new V8ShadowObservationTracker(frozen.candidate.policy),
    contracts = new CurrentNiftyCeContracts(),
    counters = new V8ShadowRuntimeCounters();
  let closing = false,
    eod = false;
  // Separates each terminal trigger's own close-out work (still gated by the `closing` latch
  // below, run at most once) from the single durable SUMMARY/CLEAN_SHUTDOWN write: a racing
  // fault can still escalate the outcome for as long as commit() has not yet run.
  const terminalOutcomeArbiter = new StrategyTerminalOutcomeArbiter();
  // Bounds the wait for the first accepted current-generation NIFTY event
  // after subscribing on cold start. Reuses the same 45s figure
  // MarketDataHealthMonitorService already treats as "stalled" for an
  // established connection (MARKET_DATA_STALL_MS) -- long enough to absorb
  // ordinary market-open subscription/auth latency without a false failure,
  // bounded so a genuinely absent feed fails closed instead of hanging. On a
  // genuinely silent feed during an active session, this bound -- not the
  // health monitor's periodic stall check -- is what owns and reports the
  // startup failure.
  // Before host.start() has successfully returned, host.start() itself is the
  // sole owner of the initial RUNNING transition (via onReady ->
  // recovery.waitUntilReady()). Calling host.recovered() from the persistent
  // recovery listener too, while the host is still transiting through
  // READY/DEGRADED during startup, races start()'s own unconditional RUNNING
  // transition and produces an illegal RUNNING->RUNNING transition.
  let startupComplete = false;
  // Decided once, at the START of each disconnect/reconnect episode, from the coordinator's OWN
  // generation-independent authoritative truth (v8FinalOpportunityCoverage), and reused
  // consistently through the matching reconnect -- never decided after the fact from a FAULTED
  // coordinator. See health's onStall and connection.on('unexpectedDisconnect'/'reconnected') below.
  let sourceRecoveryBypassActive = false;
  const eodCoordinator = new NseSessionEodCoordinator();
  let host: StrategyHostLifecycle | undefined;
  const latest = new Map<
    string,
    { ltp?: number; bid?: number; ask?: number; timestamp?: string }
  >();
  const latestGenerationScope = new LiveGenerationCacheScope();
  let signals = 0;
  let statusTimer: NodeJS.Timeout | undefined;
  const writeExit = (entry: V8ShadowResolution) => {
    const o = entry.observation;
    const compare =
      o.theoreticalEntry !== null && entry.theoreticalExit !== null
        ? executionComparison(
            o.theoreticalEntry,
            entry.theoreticalExit,
            o.executableEntry,
            entry.executableExit,
          )
        : undefined;
    journal.append({
      recordType: 'EXIT',
      tradingDate: istDate(o.signalTimestamp),
      strategyId: STRATEGY,
      fingerprint,
      signalId: o.signalId,
      signalTimestampIst: o.signalTimestamp.toISOString(),
      selectedOptionInstrument: o.contract.instrumentKey,
      theoreticalEntryPrice: o.theoreticalEntry,
      executableEntryPrice: o.executableEntry,
      entryPriceSource: o.entrySource as any,
      theoreticalExitPrice: entry.theoreticalExit,
      executableExitPrice: entry.executableExit,
      exitPriceSource: entry.exitSource as any,
      exitReason: entry.reason,
      theoreticalReturn: compare?.theoreticalReturn ?? null,
      executableEstimatedReturn: compare?.executableEstimatedReturn ?? null,
      estimatedEntrySlippage: compare?.entrySlippage ?? null,
      estimatedExitSlippage: compare?.exitSlippage ?? null,
      totalEstimatedSlippage: compare?.totalEstimatedSlippage ?? null,
      totalExecutionFrictionPercent: compare?.totalExecutionFrictionPercent ?? null,
      quote: entry.exitQuote,
      executionQuoteQuality: entry.exitQuote.quality,
      flags: [
        entry.reason === 'EOD' ? 'EOD_FORCED_EXIT' : 'FORWARD_EVALUATION_ONLY',
        ...(entry.exitQuote.quality === 'STALE_QUOTE' ? ['STALE_OPTION_QUOTE'] : []),
      ],
    });
    counters.markClosed();
    console.log(
      `[V8_FORWARD_EXIT] id=${o.signalId} reason=${entry.reason} theoretical=${compare?.theoreticalReturn ?? 'N/A'} executable=${compare?.executableEstimatedReturn ?? 'N/A'}`,
    );
  };
  const handleTick = (x: unknown) => {
    const t = x as MarketTickEvent;
    if (!t.instrumentKey || typeof t.ltp !== 'number' || !t.timestamp) return;
    if (!latestGenerationScope.accept(t.generationId, connection.getGenerationId(), () => latest.clear())) return;
    const at = new Date(t.timestamp);
    health.noteValidMarketEvent(t.generationId);
    // Post-source-completion transport-readiness confirmation: any current-generation valid
    // market event -- option quotes count exactly like NIFTY -- can prove the new connection is
    // genuinely alive, since a NIFTY tick is not guaranteed to ever arrive again once source
    // responsibility is complete (see PROVEN BLOCKER 2). No-op outside that one waiting state.
    if (recovery.getState() === 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT' && health.confirmPostSourceTransportReady(t.generationId)) {
      recovery.handleTransportReadySourceRecoveryNotRequired(t.generationId);
    }
    if (isAtOrAfterNseSessionClose(at)) {
      void host?.eod('MARKET_EOD');
      return;
    }
    latest.set(t.instrumentKey, {
      ...(latest.get(t.instrumentKey) ?? {}),
      ltp: t.ltp,
      timestamp: t.timestamp,
    });
    if (t.instrumentKey === NIFTY) {
      health.noteNiftyTick(t.generationId, at);
      recovery.handleLiveTick({ sourceTimestamp: at, receivedAt: new Date(), generationId: t.generationId });
      if (recovery.isEvaluationReady()) health.confirmRecoveryReady(t.generationId);
    }
    if (!recovery.isEvaluationReady()) return;
    for (const id of activeIds) writeExitList(id, t.instrumentKey, t.ltp, t.ltp, at);
  };
  const handleDepth = (x: unknown) => {
    const d = x as MarketDepthEvent;
    if (!d.instrumentKey || !d.timestamp) return;
    if (!latestGenerationScope.accept(d.generationId, connection.getGenerationId(), () => latest.clear())) return;
    const q = d.quotes[0];
    latest.set(d.instrumentKey, {
      ...(latest.get(d.instrumentKey) ?? {}),
      bid: q?.bidPrice,
      ask: q?.askPrice,
      timestamp: d.timestamp,
    });
  };
  const activeIds = new Set<string>();
  const writeExitList = (id: string, key: string, low: number, high: number, at: Date) => {
    const v = latest.get(key) ?? {};
    const quote = normalizeQuote(
      { ltp: v.ltp, bid: v.bid, ask: v.ask, timestamp: v.timestamp },
      at,
    );
    const wasOpen = tracker.getObservation(id);
    const exits = tracker.observe(id, key, low, high, quote, at);
    const opened = !wasOpen ? tracker.getObservation(id) : undefined;
    if (opened) {
      journal.append({
        recordType: 'ENTRY',
        tradingDate: istDate(opened.signalTimestamp),
        strategyId: STRATEGY,
        fingerprint,
        signalId: id,
        signalTimestampIst: opened.signalTimestamp.toISOString(),
        selectedOptionInstrument: opened.contract.instrumentKey,
        optionType: 'CE',
        strike: opened.contract.strikePrice,
        expiry: opened.contract.expiry.toISOString(),
        theoreticalEntryPrice: opened.theoreticalEntry,
        executableEntryPrice: opened.executableEntry,
        entryPriceSource: opened.entrySource as any,
        quote: opened.entryQuote,
        executionQuoteQuality: opened.entryQuote.quality,
        flags: [
          'FORWARD_EVALUATION_ONLY',
          ...(opened.entryQuote.quality === 'STALE_QUOTE' ? ['STALE_OPTION_QUOTE'] : []),
        ],
      });
      console.log(
        `[V8_FORWARD_ENTRY] id=${id} option=${opened.contract.instrumentKey} ltp=${number(opened.entryQuote.ltp)} bid=${number(opened.entryQuote.bid)} ask=${number(opened.entryQuote.ask)} quality=${opened.entryQuote.quality} shadowEntry=OPENED`,
      );
    }
    exits.forEach((x) => {
      activeIds.delete(id);
      writeExit(x);
    });
  };
  const handleCandle = async (x: unknown) => {
    try {
      const c = x as any;
      if (eod || !host?.canEvaluate() || !recovery.isEvaluationReady() || !isV8CompletedUnderlyingCandleEvent(c, NIFTY))
        return;
      const candle = {
        timestamp: new Date(c.candleTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 0,
      };
      if (c.timeframe === '1m') evaluator.processCompletedOneMinute(candle);
      if (c.timeframe !== `${frozen.candidate.config.timeframe}m`) return;
      counters.markCompleted2m();
      const result = evaluator.evaluateCompletedFrameWithDiagnostics(candle);
      // This is the actual normal live V8 evaluator path -- never historical backfill/recovered
      // history (recoverHistoricalOneMinute, called from onRecovered below, seeds 1m indicator
      // history only and never reaches this call). Mark the one required final opportunity
      // EVALUATED only when the genuine, live-evaluated frame is exactly the 15:27-15:28 bucket.
      // Idempotent: markEvaluated() is a no-op once already EVALUATED, so duplicate callbacks
      // (there are none on this path, but as a general invariant) cannot produce a second mark.
      if (candle.timestamp.getTime() === v8FinalBucketStart.getTime()) {
        v8FinalOpportunityCoverage.markEvaluated(v8FinalOpportunityToken, candle.timestamp, 'V8_FINAL_OPPORTUNITY_EVALUATED');
      }
      console.log(v8EvaluationLog(result.evaluation));
      const signal = result.signal;
      if (!signal) return;
      signals++;
      counters.markSignal();
      const id = `V8-${signal.timestamp.getTime()}`;
      journal.append({
        recordType: 'SIGNAL',
        tradingDate: signal.date,
        strategyId: STRATEGY,
        fingerprint,
        signalId: id,
        signalTimestampIst: signal.timestamp.toISOString(),
        signalTimestampUtc: signal.timestamp.toISOString(),
        underlyingInstrument: NIFTY,
        underlyingClose: signal.spotPrice,
        regime: signal.regime,
        indicators: {
          atr: signal.atr14,
          body: signal.body,
          bodyAtr: signal.bodyAtr,
          structuralLevel: signal.structuralLevel,
          rsi14: signal.rsi14 ?? null,
          reclaimBufferAtr: signal.reclaimBufferAtr,
        },
        optionType: 'CE',
        signalReason: 'FROZEN_BULLISH_RECLAIM',
        flags: ['FORWARD_EVALUATION_ONLY', 'ZERO_ORDER'],
      });
      const signalGenerationId = connection.getGenerationId();
      try {
        const contract = await contracts.resolve(signal.spotPrice, signal.timestamp);
        if (!isCurrentLiveGeneration(signalGenerationId, connection.getGenerationId()) || !host?.canEvaluate() || !recovery.isEvaluationReady()) return;
        tracker.register(id, signal.timestamp, contract);
        activeIds.add(id);
        await subscriptions.subscribe(contract.instrumentKey, MarketDataSubscriptionMode.FULL);
        if (!isCurrentLiveGeneration(signalGenerationId, connection.getGenerationId()) || !host?.canEvaluate() || !recovery.isEvaluationReady()) return;
        const quote = normalizeQuote(latest.get(contract.instrumentKey) ?? {}, signal.timestamp);
        console.log(
          `[V8_FORWARD_SIGNAL] timestamp=${istTimestamp(signal.timestamp)} close=${number(signal.spotPrice)} option=${contract.instrumentKey} reason=FROZEN_BULLISH_RECLAIM ltp=${number(quote.ltp)} bid=${number(quote.bid)} ask=${number(quote.ask)} quality=${quote.quality} shadowEntry=PENDING_OPTION_QUOTE`,
        );
      } catch (error) {
        journal.appendEvent(
          signal.date,
          'OPTION_RESOLUTION_FAILED',
          ['EXECUTION_ESTIMATE_UNAVAILABLE'],
          { error: error instanceof Error ? error.message : 'unknown' },
        );
      }
    } catch (error) {
      // Any exception in the completed-candle path (e.g. an incomplete or
      // structurally corrupted required historical session detected
      // mid-session) must not escape this async EventEmitter listener as an
      // unhandled rejection, AND the host fault attempt must be the FIRST
      // thing that happens -- no observability operation (logging,
      // journaling, error formatting) may run beforehand or be able to
      // prevent it. A live host is guaranteed to exist here: the guard at
      // the top of this function already required host?.canEvaluate() to
      // be true to reach this point, so an undefined host during an active
      // failure is treated as a defect (thrown, not silently no-op'd) rather
      // than silently resolving without faulting.
      await routeV8CompletedCandleFailure(error, {
        fault: (faultError) => {
          if (!host) throw new Error('V8_HOST_UNAVAILABLE_DURING_ACTIVE_FAULT');
          // Once the arbiter has started (or finished) sealing a different outcome
          // (a shutdown() raced ahead of this evaluator failure), this must not flip
          // the HOST's own state to FAULTED: that would disagree with the outcome
          // already durably recorded (or in the middle of being recorded).
          if (terminalOutcomeArbiter.isSealing()) return Promise.resolve();
          return host.fault(faultError);
        },
        journal: () => journal.appendEvent(date, 'V8_EVALUATOR_FAULT', ['V8_EVALUATOR_FAULT', 'CRITICAL_DATA_QUALITY'], { error: describeV8ErrorSafely(error) }),
        log: (message) => console.error(message),
      });
    }
  };
  const onCompletedCandle = (x: unknown): void => {
    handleCandle(x).catch((error) => v8ObserveTerminalFailure(error, console.error));
  };
  type RecoveryWarmup = Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryWarmup>({
    getLastSeededCompletedMinute: () => warmup.lastCurrentDayCandle,
    liveConstructionAlignmentMinutes,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (recoveryWarmup) => recoveryWarmup?.lastCurrentDayCandle,
    backfill: async (requiredCompletedMinute) => {
      const r = await new LivePaperFreshWarmupService(
        new HistoricalCandleRepository(),
        new WarmupTarget(),
      ).warmUp(requiredCompletedMinute ? new Date(requiredCompletedMinute.getTime() + 60_000) : undefined);
      return {
        ready: r.ready,
        reason: r.freshnessReason,
        missingMinutes: r.currentDayMissingMinuteCount,
        duplicateMinutes: r.currentDayDuplicateCount,
        recoveryData: r,
      };
    },
    onRecovered: (_generationId,recoveryWarmup) => { if (recoveryWarmup?.ready) evaluator.recoverHistoricalOneMinute(recoveryWarmup.seededOneMinuteCandles); candles.start(); return undefined; },
    // A7-H2: the coordinator computes the first minute boundary guaranteed observable from
    // its very start on this connection (cold start or reconnect alike); no live candle,
    // for any timeframe, may ever be built before it -- otherwise a WebSocket that
    // connects/reconnects mid-minute could silently emit a partial "completed" candle.
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(NIFTY, boundary.getTime()),
    onLiveConstructionUnavailable: (sessionClose) => liveCandleBuilder.blockLiveConstructionForSession(NIFTY, sessionClose.getTime()),
    onEvent: (type, details) => { journal.appendEvent(date, type, [type], details); },
  });
  const health = new MarketDataHealthMonitorService(connection, {
    generationGraceMs:healthGraceMs,
    // NIFTY_INDEX genuinely stops publishing 1m source candles at the canonical 15:30 IST
    // source-completion boundary, well before the wider 09:15-15:40 operational session ends.
    // A STALL detected at/after that boundary must not solicit a reconnect the recovery
    // coordinator can never satisfy for a new candle. Reuses the canonical
    // nifty1mSourceCompletionBoundary utility -- no duplicate hardcoded boundary here.
    isSourceFresh: (value) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime(),
    onStall: (s, { reason, reconnectSolicited }) => {
      if (!reconnectSolicited) {
        // Expected post-source-completion condition: transport (raw/option) traffic is
        // genuinely healthy -- only the NIFTY source itself has naturally stopped. Must NOT
        // start a coordinator disconnect episode or stop candle events for this (see PROVEN
        // BLOCKER 1) -- retain observability only.
        journal.appendEvent(date, 'MARKET_DATA_SOURCE_STALE_EXPECTED', ['MARKET_DATA_SOURCE_STALE_EXPECTED'], { ...s, reason });
        return;
      }
      candles.stop();
      // Fires (and calls handleUnexpectedDisconnect directly) BEFORE ConnectionManager's own
      // 'unexpectedDisconnect' event -- this is the real first mover for a health-triggered
      // STALL/HEALTH_GRACE_EXPIRED, so the bypass decision must be made identically here too
      // (see connection.on('unexpectedDisconnect', ...) below for the full rationale).
      sourceRecoveryBypassActive = v8FinalOpportunityCoverage.getRecord()?.disposition === 'EVALUATED';
      const details = {
        generationId: s.generationId,
        reason,
        lastMessageAgeMs: s.lastRawMessageAgeMs,
        lastTickAgeMs: s.lastNiftyTickAgeMs,
      };
      if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
      else recovery.handleUnexpectedDisconnect(details);
      journal.appendEvent(date, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], s);
    },
  });
  const emitStatus = () => {
    const value = counters.snapshot();
    console.log(
      `[V8_SHADOW_STATUS] completed2m=${value.completed2m} signals=${value.signals} open=${tracker.getOpenCount()} closed=${value.closed}`,
    );
  };
  const shutdown = async (reason: string, invalidData = false) => {
    // Proposed unconditionally, even if a different trigger already owns the close-out work
    // below -- this is the only way a racing fault can still escalate the eventual commit()'d
    // outcome.
    terminalOutcomeArbiter.propose(reason, resolveSessionOutcome({ reason, invalidData }).status);
    if (closing) return;
    closing = true;
    eod = true;
    // sealAfterCloseOut() is the single production seam: it runs this fallible close-out
    // (including all required observability) fully to completion -- or, if it throws, escalates
    // to FAULTED and still durably seals that reason -- BEFORE the SUMMARY/CLEAN_SHUTDOWN write
    // below ever runs. Nothing capable of throwing runs after sealAfterCloseOut() resolves: the
    // durable SUMMARY append inside the writer below is the final potentially-throwing operation
    // in this terminal path, so a successful VALID_COMPLETED SUMMARY can never be followed by a
    // lifecycle failure that would leave the host FAULTED next to it.
    await terminalOutcomeArbiter.sealAfterCloseOut(
      async () => {
        if (statusTimer) clearInterval(statusTimer);
        health.stop();
        recovery.stop();
        const at = new Date();
        tracker.closeAtEod(at).forEach(writeExit);
        candles.stop();
        eventBus.off('market.tick', handleTick);
        eventBus.off('market.depth', handleDepth);
        eventBus.off('market.candle.completed', onCompletedCandle);
        await subscriptions.unsubscribeMany(
          subscriptions.getSubscriptions().map((s) => s.instrumentKey),
        );
        connection.disconnect();
        // Status observability -- still close-out work, so it must finish (or fault the
        // session) before the seal below, never after it. This runs before the arbiter
        // resolves the authoritative outcome, so it must never assert a final status --
        // the durable SUMMARY written below (from resolveSessionOutcome({ reason: finalReason }))
        // remains the sole authoritative record of how the session actually ended.
        const value = counters.snapshot();
        console.log(
          `[V8_EOD_SUMMARY] date=${date} completed2m=${value.completed2m} signals=${value.signals} closed=${value.closed} open=${tracker.getOpenCount()}`,
        );
      },
      (finalReason) => {
        // commit() (inside sealAfterCloseOut) reads the arbiter's authoritative reason at this
        // exact instant -- a fault that raced in via propose() any time before this line (including
        // during close-out itself) wins here even though this call originated from a different
        // trigger's own local `reason`.
        const outcome = resolveSessionOutcome({ reason: finalReason, invalidData });
        // CLEAN_SHUTDOWN (non-authoritative) must be durable before SUMMARY (the A9-authoritative
        // eligibility record): a failure appending CLEAN_SHUTDOWN must never leave a durable
        // VALID_COMPLETED SUMMARY with no corresponding shutdown evidence.
        if (outcome.status === 'VALID_COMPLETED') journal.appendEvent(date, 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason: finalReason });
        journal.append({
          recordType: 'SUMMARY',
          tradingDate: date,
          strategyId: STRATEGY,
          fingerprint,
          sessionCompleted: outcome.sessionCompleted,
          eodReason: finalReason,
          signals,
          resolvedTrades: 0,
          unresolvedTrades: tracker.getOpenCount(),
          status: outcome.status,
          flags: ['SHADOW_ONLY', 'ZERO_ORDER'],
        });
      },
    );
  };
  /**
   * EOD-specific wrapper: proves whether the one required final live evaluation of the
   * 15:27-15:28 frame actually occurred before committing the durable outcome. Missing/still-
   * pending coverage (the requirement was armed unconditionally at startup, so "absent" cannot
   * occur here -- see v8FinalOpportunityCoverage.require() above) must never let the session
   * reach VALID_COMPLETED; a genuinely EVALUATED disposition never forces invalidity on its
   * own -- other, unrelated A9 requirements can still independently invalidate the session, but
   * this evaluation-coverage check alone is not one of them.
   */
  const performV8EodExit = async (reason: string): Promise<void> => {
    const v8FinalOpportunityLost = v8FinalOpportunityCoverage.getRecord()?.disposition !== 'EVALUATED';
    if (v8FinalOpportunityLost) {
      journal.appendEvent(date, 'V8_FINAL_OPPORTUNITY_LOST', ['V8_FINAL_OPPORTUNITY_LOST', 'CRITICAL_DATA_QUALITY'], { reason: v8FinalOpportunityCoverage.getRecord()?.reason ?? 'UNKNOWN', disposition: v8FinalOpportunityCoverage.disposition(v8FinalOpportunityToken) });
      console.error(`[V8_FINAL_OPPORTUNITY] Live evaluation of the final 15:27-15:28 frame was not proven (${v8FinalOpportunityCoverage.disposition(v8FinalOpportunityToken)}); session will fail closed as INVALID_DATA.`);
    }
    await shutdown(reason, v8FinalOpportunityLost);
  };
  connection.on('unexpectedDisconnect', (d: any) => {
    candles.stop();
    // Decided HERE, at disconnect time -- not after a doomed handleReconnected() has already
    // faulted the coordinator. If the one required final live evaluation of the 15:27-15:28
    // frame has ALREADY, positively, reached EVALUATED (sticky/terminal, independent of the
    // connection generation), this transport episode can never need a NEW source-candle
    // recovery regardless of when the matching reconnect lands -- so it is routed through the
    // alternate handleUnexpectedDisconnectSourceRecoveryNotRequired()/
    // handleReconnectedSourceRecoveryNotRequired() pair, which never creates/poisons a
    // boundaryReconciliationObligation and never reaches FAULTED for this episode. Otherwise
    // (LOST, still pending, or never armed) this is the ordinary, fully unchanged, fail-closed
    // handleUnexpectedDisconnect()/handleReconnected() pair.
    sourceRecoveryBypassActive = v8FinalOpportunityCoverage.getRecord()?.disposition === 'EVALUATED';
    if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(d);
    else recovery.handleUnexpectedDisconnect(d);
    journal.appendEvent(date, 'RECONNECT_STARTED', ['WEBSOCKET_DISCONNECTED']);
  });
  connection.on('reconnected', (d: any) => {
    if (sourceRecoveryBypassActive) recovery.handleReconnectedSourceRecoveryNotRequired(d);
    else recovery.handleReconnected(d);
    journal.appendEvent(date, 'RECONNECT_SUCCEEDED', ['WEBSOCKET_RECONNECTED']);
  });
  connection.on('reconnectFailed', () => {
    recovery.fault('RECONNECT_FAILED');
    journal.appendEvent(date, 'RECONNECT_FAILED', [
      'RECONNECT_FAILED',
      'DATA_GAP_UNRECOVERABLE',
      'CRITICAL_DATA_QUALITY',
    ]);
    // Once the arbiter has started (or finished) sealing a different outcome, this
    // external trigger must not flip the HOST's own state to FAULTED: that would
    // disagree with the outcome already durably recorded (or in the middle of being
    // recorded) for this session.
    if (!terminalOutcomeArbiter.isSealing()) void host?.fault(new Error('RECONNECT_FAILED'));
  });
  // ConnectionManager emits 'connected' on every successful open, cold start
  // and reconnect alike (and 'reconnected' fires immediately after it on a
  // reconnect). handleInitialConnected() only has an effect the very first
  // time it runs while recovery is still untouched, so this cannot reset or
  // race the reconnect state machine driven by 'unexpectedDisconnect' /
  // 'reconnected' above.
  connection.on('connected', (d: { generationId: number }) => {
    recovery.handleInitialConnected({ generationId: d.generationId });
  });
  host = new StrategyHostLifecycle({
    strategyId: STRATEGY,
    runtimeId: 'shadow:v8:reclaim',
    eodCoordinator,
    hooks: {
      warmup: () => undefined,
      // The historical fail-closed gate already ran above
      // (evaluator.checkStartupReadiness). This is the LIVE gate: RUNNING
      // (reason=MARKET_DATA_READY) must not be granted until an accepted,
      // usable, current-generation NIFTY event has actually been observed.
      onReady: async () => {
        const ready = recovery.waitUntilReady(startupReadyTimeoutMs);
        ready.catch(() => undefined); // observed even if subscribe() below throws first
        await subscriptions.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
        await ready;
      },
      onEod: (reason) => performV8EodExit(reason ?? 'EOD'),
      onShutdown: (reason) => shutdown(reason ?? 'SIGINT'),
      onFault: () => shutdown('FAULTED'),
    },
    log: (value) => console.log(`[STRATEGY_HOST_STATE] strategyId=${value.strategyId} runtimeId=${value.runtimeId} previous=${value.previous} state=${value.state} reason=${value.reason}`),
  });
  // host.start() itself owns the initial RUNNING transition via its onReady
  // hook; only a genuine post-startup recovery may call host.recovered() here,
  // gated by startupComplete.
  recovery.on('stateChanged', (state) => {
    if (state === 'DEGRADED') void host?.degrade('MARKET_DATA_DEGRADED');
    if (state === 'READY') {
      if (!health.confirmRecoveryReady(recovery.getGenerationId())) {
        connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
      } else if (startupComplete) {
        void host?.recovered('MARKET_DATA_READY');
      }
    }
    if (state === 'SOURCE_COMPLETE_READY') {
      // Mirrors the READY branch above, but confirms via confirmPostSourceTransportReady()
      // (transport evidence -- raw+valid, never a NIFTY tick, which is not guaranteed to ever
      // arrive again once source responsibility is complete).
      if (!health.confirmPostSourceTransportReady(recovery.getGenerationId())) {
        connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
      } else if (startupComplete) {
        void host?.recovered('MARKET_DATA_READY');
      }
    }
    // A FAULTED coordinator here always means a source-candle recovery was genuinely attempted
    // and genuinely failed -- a benign post-source-completion transport episode never reaches
    // handleReconnected()/FAULTED at all; see the sourceRecoveryBypassActive-gated onStall/
    // unexpectedDisconnect/reconnected handlers above.
    if (state === 'FAULTED') connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_COORDINATOR_FAULTED');
  });
  process.once('SIGINT', () => {
    void host?.shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void host?.shutdown('SIGTERM');
  });
  connection.on('message', (b: Buffer, d: { generationId: number }) => {
    try {
      ticks.process(decoder.decode(b), d.generationId);
    } catch {}
  });
  eventBus.on('market.tick', handleTick);
  eventBus.on('market.depth', handleDepth);
  eventBus.on('market.candle.completed', onCompletedCandle);
  candles.start();
  health.start();
  statusTimer = setInterval(emitStatus, 60_000);
  statusTimer.unref();
  await host.start();
  if (host.getState() !== 'RUNNING') return;
  startupComplete = true; // the persistent recovery listener may now own DEGRADED -> RUNNING for any later, genuine reconnect recovery
  console.log(
    `[V8_STARTUP] strategyId=${STRATEGY} shadowOnly=true paperOrders=false brokerOrders=false`,
  );
}
function v8EvaluationLog(
  value: import('../modules/research/v8-nifty-bullish-reclaim').V8BullishReclaimEvaluation,
): string {
  return `[V8_ENTRY_EVALUATION] ${istTimestamp(value.timestamp)} close=${number(value.close)} pdh=${number(value.structuralLevel)} atr=${number(value.atr14)} reclaimBuffer=${number(value.reclaimBufferAtr)} reclaimThreshold=${number(value.reclaimThreshold)} interaction=${value.interaction ?? 'N/A'} armed=${value.armedBefore} reclaim=${value.reclaim ?? 'N/A'} body=${number(value.body)} bodyAtr=${number(value.bodyAtr)} bodyThreshold=${number(value.bullishBodyAtr)} rsi=${number(value.rsi14)} rsiThreshold=${value.rsiMinimum} rsiPass=${value.rsiPass} regimePass=${value.regimePass} cooldown=${value.cooldownEligible ?? 'N/A'} signal=${value.signal} reason=${value.reason}`;
}
function number(value: number | null | undefined): string {
  return value === null || value === undefined ? 'N/A' : value.toFixed(4);
}
function istTimestamp(value: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(value);
}
function isNifty(v: string) {
  return (
    v
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '') === 'NIFTY50' || v.trim().toUpperCase() === 'NIFTY'
  );
}
function istDate(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
void run().catch((e) => {
  console.error('[V8_SHADOW_FATAL]', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
