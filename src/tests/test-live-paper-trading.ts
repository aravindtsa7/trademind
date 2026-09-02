import 'dotenv/config';
import { EventEmitter } from 'events';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import { Candle } from '../modules/indicators/types';
import MarketDataWebSocketClient from '../modules/market-data/client/websocket.client';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
import ConnectionManager from '../modules/market-data/managers/connection.manager';
import SubscriptionManager, { MarketDataSubscriptionMode } from '../modules/market-data/managers/subscription.manager';
import TickProcessor, { MarketDepthEvent, MarketTickEvent } from '../modules/market-data/processors/tick.processor';
import ProtobufDecoder from '../modules/market-data/protobuf/protobuf.decoder';
import { OptionContract } from '../modules/options/types';
import PaperMarketDataAdapterService from '../modules/paper-trading/services/paper-market-data-adapter.service';
import PaperOrderManagerService from '../modules/paper-trading/services/paper-order-manager.service';
import PaperPositionMonitorService from '../modules/paper-trading/services/paper-position-monitor.service';
import PaperRuntimeCandleAdapterService, { PaperRuntimeCandleContractsProvider } from '../modules/paper-trading/services/paper-runtime-candle-adapter.service';
import PaperTradingOrchestratorService from '../modules/paper-trading/services/paper-trading-orchestrator.service';
import PaperTradingRuntimeService from '../modules/paper-trading/services/paper-trading-runtime.service';
import LivePaperStrategyAdapterService from '../modules/paper-trading/services/live-paper-strategy-adapter.service';
import LivePaperFreshWarmupService from '../modules/paper-trading/services/live-paper-fresh-warmup.service';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from '../modules/paper-trading/dto/live-paper-strategy.dto';
import { PaperTradingRuntimeState } from '../modules/paper-trading/dto/paper-trading-runtime.dto';
import { NseSessionEodCoordinator, OneShotWallClockTrigger, isAtOrAfterNseSessionClose, isWithinNseSession } from '../modules/market-data/services/nse-session-calendar.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import MarketDataHealthMonitorService from '../modules/market-data/services/market-data-health-monitor.service';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { StrategyTerminalOutcomeArbiter } from '../modules/market-data/services/strategy-terminal-outcome-arbiter.service';
import { SourceBoundaryEvaluationCoverageTracker } from '../modules/market-data/services/source-boundary-evaluation-coverage';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import { cacheCurrentLiveDepth, getCurrentLiveDepth } from '../modules/market-data/utils/live-depth-cache';
import { cacheCurrentLiveInstrumentValue, getCurrentLiveInstrumentValue, LiveInstrumentValue } from '../modules/market-data/utils/live-instrument-value-cache';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';
import { ForwardValidationJournal, normalizeQuote, resolveSessionOutcome, strategyFingerprint } from '../modules/research-validation';
import RuntimeRiskGateService from '../modules/risk/runtime-risk-gate.service';
import PaperEntryQuoteWaiterService from '../modules/paper-trading/services/paper-entry-quote-waiter.service';
import PaperPortfolioService, { InMemoryPaperPortfolioRepository } from '../modules/paper-trading/services/paper-portfolio.service';
import PaperFillModelService from '../modules/paper-trading/services/paper-fill-model.service';
import PrismaExecutionRepository from '../modules/execution/prisma-execution.repository';
import { PaperOrderStatus } from '../modules/paper-trading/types/paper-trading.types';
import { MarketDataConnectionPort, MarketDataHealthPort, MarketDataSubscriptionPort, StrategyMarketDataChannel } from '../modules/market-data/gateway/strategy-market-data-channel';
import ConsumerRecoveryWatchdogService from '../modules/market-data/services/consumer-recovery-watchdog.service';

const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';
const tickPrintIntervalMs = 30_000;
const runtimeStatusIntervalMs = 60_000;

/** Validates at the environment/config boundary, naming the offending variable, matching the style already used by ConnectionManager/MarketDataHealthMonitorService. */
function positiveTimeoutMs(name: string, environmentValue: string | undefined, fallback: number): number {
  const value = environmentValue === undefined ? fallback : Number(environmentValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}

interface StrategyEvaluatedEvent {
  candleTimestamp: Date;
  spotPrice: number;
  rawSignal: string;
  finalSignal: string;
  timeFilterAllowed: boolean;
  reasons: string[];
  paperOrderId?: string;
}

interface PaperOrderActionEvent {
  orderId: string;
  instrumentKey: string;
  timestamp: Date;
  observedPremium: number;
  action: string;
}

/**
 * Resolves the active local NIFTY option universe only when a completed candle
 * needs strategy evaluation. The provider deliberately does not fetch an
 * option chain or make any Upstox REST request.
 */
class CurrentNiftyOptionContractsProvider implements PaperRuntimeCandleContractsProvider {
  constructor(private readonly instruments: InstrumentRepository) {}

  async getContracts(): Promise<readonly OptionContract[]> {
    const activeInstruments = await this.instruments.findActive();
    const contracts = activeInstruments
      .filter((instrument) => isNiftyUnderlying(instrument.underlyingSymbol))
      .filter((instrument) => instrument.instrumentType === 'CE' || instrument.instrumentType === 'PE')
      .map((instrument): OptionContract | undefined => {
        const strikePrice = Number(instrument.strikePrice);
        if (!Number.isFinite(strikePrice) || strikePrice <= 0 || !Number.isInteger(instrument.lotSize) || instrument.lotSize <= 0) {
          return undefined;
        }
        return {
          instrumentKey: instrument.instrumentKey,
          tradingSymbol: instrument.tradingSymbol,
          // The frozen paper strategy uses this canonical underlying value.
          underlying: 'NIFTY 50',
          strikePrice,
          expiry: new Date(instrument.expiry.getTime()),
          optionType: instrument.instrumentType as 'CE' | 'PE',
          exchange: instrument.exchange,
          segment: instrument.segment,
          lotSize: instrument.lotSize,
        };
      })
      .filter((contract): contract is OptionContract => contract !== undefined);

    // An empty universe must not prevent NO_TRADE evaluations. If a future
    // actionable signal occurs, the selector/orchestrator will fail clearly.
    return contracts;
  }
}

function isNiftyUnderlying(underlying: string): boolean {
  return underlying.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === 'NIFTY50'
    || underlying.trim().toUpperCase() === 'NIFTY';
}

function getIstParts(timestamp: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(timestamp).map((part) => [part.type, part.value])
  );
}

function formatIst(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(timestamp);
}

function isLikelyMarketSession(timestamp: Date): boolean {
  return isWithinNseSession(timestamp);
}

export interface LiveRuntimeOptions {
  /** Injected only by the combined shared-market-data-gateway runtime; standalone `npm run paper:v2` omits this and constructs its own dedicated ConnectionManager/SubscriptionManager/MarketDataHealthMonitorService exactly as before. */
  channel?: StrategyMarketDataChannel;
  /**
   * Explicit, per-instance V2 identity override (F-01). When provided, this -- not
   * process.env.TRADING_STRATEGY_VERSION -- determines whether this run() invocation evaluates
   * the frozen V2 trend-down decision path. Required by the combined shared-market-data-gateway
   * runtime (test-live-shared-market-data-gateway.ts), which runs this V2 runner in the SAME
   * process as V4/V8 and therefore cannot rely on a single process-global env var to distinguish
   * this instance's identity from a sibling's. Standalone invocations (`npm run paper:v1` /
   * `npm run paper:v2`) omit this and fall back to process.env.TRADING_STRATEGY_VERSION exactly
   * as before.
   */
  strategyVersion?: 'V1' | 'V2';
}

export async function run(options: LiveRuntimeOptions = {}): Promise<void> {
  // F-03 startup ownership guard: every registered shared-gateway consumer must end up either
  // durably owned by a running strategy lifecycle or released here. Set true only once this
  // runtime has reached its durable live-ownership point (host reaches RUNNING); every other
  // path below it -- the outside-session early return, a startup-readiness fault, a
  // data-freshness block, a thrown config/token error, or any other thrown initialization error
  // -- falls through to the finally at the end of this function and releases this consumer's
  // channel. GatewayMarketDataChannel.disconnect() is idempotent, so this is safe even when a
  // fault-triggered shutdown() already released the channel first. A no-op in standalone mode
  // (no options.channel). Mirrors the same pattern already accepted for V4/V8.
  // F-03 startup ownership guard: every registered shared-gateway consumer must end up either
  // durably owned by a running strategy lifecycle or released here. Set true only once this
  // runtime has reached its durable live-ownership point (host reaches RUNNING); every other
  // path below it -- the outside-session early return, a startup-readiness fault, a
  // data-freshness block, a thrown config/token error, or any other thrown initialization error
  // -- falls through to the finally at the end of this function and releases this consumer's
  // channel. GatewayMarketDataChannel.disconnect() is idempotent, so this is safe even when a
  // fault-triggered shutdown() already released the channel first. A no-op in standalone mode
  // (no options.channel). Mirrors the same pattern already accepted for V4/V8.
  let runtimeOwnsChannel = false;
  try {
  // Resolved ONCE, here, before any strategy construction -- this local is the sole authority
  // for V2 identity and its exit policy for the remainder of this run() invocation. A sibling
  // V4/V8 startup (or anything else) mutating process.env.TRADING_STRATEGY_VERSION afterward can
  // never change it (see LiveRuntimeOptions.strategyVersion doc above).
  const isV2 = options.strategyVersion === 'V2' || (options.strategyVersion === undefined && process.env.TRADING_STRATEGY_VERSION === 'V2');
  const v2ExitPolicyConfig = Object.freeze({
    targetPercent: Number(process.env.V2_TARGET_PERCENT ?? 5),
    stopLossPercent: Number(process.env.V2_STOP_PERCENT ?? 5),
    maximumHoldingMinutes: Number(process.env.V2_MAX_HOLD_MINUTES ?? 15),
  });
  const paperTradingOnly = process.env.PAPER_TRADING_ONLY === 'true';
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN;
  if (!accessToken) throw new Error('UPSTOX_ACCESS_TOKEN must be set in .env before running the live paper-trading harness.');
  const forwardFingerprint = strategyFingerprint({ strategyId: 'V2_TREND_DOWN_PE', timeframe: '5m', regime: 'TREND_DOWN', ema: ['EMA15', 'EMA35'], proximityPercent: 0.2, rsi: 'RSI14<35', cooldownMinutes: 10, targetPercent: 5, stopPercent: 5, holdMinutes: 15 });
  console.log(`[V2_FORWARD_FINGERPRINT] strategyId=V2_TREND_DOWN_PE fingerprint=${forwardFingerprint}`);

  if (!isLikelyMarketSession(new Date())) {
    console.log('Live paper-trading harness was not started because the current IST time is outside the configured NSE derivatives session.');
    console.log('No market data was fabricated. Run `npm run test:live-paper-trading` during the next live market session.');
    return;
  }

  const liveConstructionAlignmentMinutes = 5;
  const alignedHandoffWaitMs = liveConstructionAlignmentMinutes * 60_000;
  const startupReadyTimeoutMs = positiveTimeoutMs('MARKET_DATA_STARTUP_READY_TIMEOUT_MS', process.env.MARKET_DATA_STARTUP_READY_TIMEOUT_MS, 45_000) + alignedHandoffWaitMs;
  const healthGraceMs = positiveTimeoutMs('MARKET_DATA_HEALTH_GRACE_MS', process.env.MARKET_DATA_HEALTH_GRACE_MS, 45_000) + alignedHandoffWaitMs;
  const reconnectDurationMs = positiveTimeoutMs('MARKET_DATA_MAX_RECONNECT_DURATION_MS', process.env.MARKET_DATA_MAX_RECONNECT_DURATION_MS, 60_000) + alignedHandoffWaitMs;

  // Shared-gateway mode (options.channel injected by the combined runtime): connection,
  // subscription and market-data-bus roles all collapse onto the ONE leased channel -- no
  // dedicated WebSocket/decoder/TickProcessor is constructed here at all, since the gateway
  // already decodes every packet exactly once upstream. Standalone mode (npm run paper:v2)
  // constructs its own dedicated triad exactly as before, using a private bus instead of the
  // process-global eventBus purely for symmetry with the gateway path -- this process never runs
  // any other strategy, so there is no cross-talk risk either way.
  let connectionManager: MarketDataConnectionPort;
  let subscriptionManager: MarketDataSubscriptionPort;
  let realConnectionManager: ConnectionManager | undefined;
  let tickProcessor: TickProcessor | undefined;
  let protobufDecoder: ProtobufDecoder | undefined;
  const bus: StrategyMarketDataChannel | EventEmitter = options.channel ?? new EventEmitter();
  if (options.channel) {
    connectionManager = options.channel;
    subscriptionManager = options.channel;
  } else {
    const webSocketClient = new MarketDataWebSocketClient(accessToken);
    realConnectionManager = new ConnectionManager(accessToken, webSocketClient, { maximumReconnectDurationMs:reconnectDurationMs });
    connectionManager = realConnectionManager;
    subscriptionManager = new SubscriptionManager(accessToken, realConnectionManager);
    protobufDecoder = new ProtobufDecoder();
    tickProcessor = new TickProcessor(bus);
  }
  const liveCandleBuilder = new LiveCandleBuilderService();
  // NIFTY_INDEX genuinely stops publishing 1m source candles at the canonical 15:30 IST source
  // horizon -- scoped to this instrument only (never every instrument the shared builder
  // processes, e.g. the option contract subscribed on a signal) via the canonical
  // nifty1mSourceCompletionBoundary utility, computed once for this session's trading day.
  liveCandleBuilder.setSourceCompletionBoundary(niftyInstrumentKey, nifty1mSourceCompletionBoundary(new Date()).getTime());
  const liveCandleEventAdapter = new LiveCandleEventAdapterService(liveCandleBuilder, bus, () => connectionManager.getGenerationId());

  const orderManager = new PaperOrderManagerService();
  // Prisma/MySQL is authoritative. The in-memory portfolio retains existing
  // same-process monitoring APIs only; it is never used for restart recovery.
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository());
  const fillModel = new PaperFillModelService();
  const prismaExecution = new PrismaExecutionRepository();
  const executionSessionDate = istDate(new Date());
  const initializeDurableExecution = async (): Promise<void> => {
    // Keep the existing startup order: local same-process monitoring is
    // reconciled first, then Prisma establishes the durable execution source
    // of truth for this IST session.
    portfolio.reconcileOpenOrders(executionSessionDate, orderManager.getActiveOrders().map((order) => order.id));
    await prismaExecution.initialize(executionSessionDate);
  };
  await initializeDurableExecution();
  let paperMarketDataAdapter: PaperMarketDataAdapterService;
  const positionMonitor = new PaperPositionMonitorService(orderManager, portfolio, istDate, (order) => {
    const fill = fillModel.fill({ side:'SELL', requestedQuantity:order.contract.quantity, quote:paperMarketDataAdapter.getExecutionQuoteSnapshot(order.contract.instrumentKey), intentTimestamp:order.entry.entryTimestamp });
    // The existing V2 lifecycle has no residual-exit state; a partial SELL may
    // be observed but cannot close the whole paper position at a fabricated size.
    return fill.status === 'FILLED' ? fillModel.toSummary(fill) : undefined;
  }, undefined, async (order, update, reason, fill) => {
    if (!order.executionOrderId) throw new Error(`Paper order ${order.id} is missing its durable execution order id.`);
    await prismaExecution.recordPaperExit(order.executionOrderId, istDate(update.timestamp), fill, update.timestamp, reason);
  }, async (order, error) => {
    riskGate.transition('HALTED');
    console.error(`[PAPER_EXECUTION_DURABILITY_FAILURE] orderId=${order.id} error=${error instanceof Error ? error.message : 'unknown'}`);
    if (order.executionOrderId) {
      await prismaExecution.markReconciliationRequired(order.executionOrderId, istDate(order.entry.entryTimestamp), new Date(), 'LOCAL_DURABLE_EXIT_UNCERTAIN');
    }
  });
  paperMarketDataAdapter = new PaperMarketDataAdapterService(
    positionMonitor,
    bus,
    portfolio,
    2_000,
    () => new Date(),
    () => connectionManager.getGenerationId(),
  );
  const latestPremiumByInstrument = new Map<string, LiveInstrumentValue<number>>();
  const latestDepthByInstrument = new Map<string, MarketDepthEvent>();
  let recovery: MarketDataRecoveryCoordinatorService<Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>> | undefined;
  let eodRequestedForRisk = false;
  const riskGate = new RuntimeRiskGateService({ getPortfolioSnapshot: (sessionDate) => prismaExecution.getCachedSnapshot(sessionDate), getExecutionHealth: (sessionDate) => prismaExecution.getHealth(sessionDate) });
  const orchestration = new PaperTradingOrchestratorService(
    undefined,
    orderManager,
    subscriptionManager,
    {
      async getObservedPremium(instrumentKey: string) {
        const quote = await new PaperEntryQuoteWaiterService({
          // The wait has to satisfy the stricter executable-fill contract, not
          // merely the general RiskGate quote check. The captured snapshot is
          // then supplied unchanged to both layers.
          maxQuoteAgeMs: fillModel.maxQuoteAgeMs,
          getSnapshot: () => undefined,
          getExecutionSnapshot: (key) => paperMarketDataAdapter.getExecutionQuoteSnapshot(key),
          abortReason: () => riskGate.isKillSwitchActive() ? 'KILL_SWITCH_ACTIVE' : shuttingDown || eodRequestedForRisk ? 'EOD_BLOCK' : recovery?.getState() !== 'READY' ? 'MARKET_DATA_NOT_READY' : riskGate.getTradingState() !== 'ACTIVE' ? 'RUNTIME_DEGRADED' : undefined,
        }).waitForFreshExecutionQuote(instrumentKey);
        return { observedEntryPremium: quote.ltp as number, executionQuote: quote };
      },
    },
    MarketDataSubscriptionMode.FULL,
    riskGate,
    { buildIntent: ({ signal, contract, observedEntryPremium, executionQuote }) => {
      return { runtimeId: 'paper:v2', strategyId: 'V2_TREND_DOWN_PE', sessionDate: istDate(signal.signalTimestamp), timestamp: signal.signalTimestamp, instrument: contract.instrumentKey, underlying: 'NIFTY 50', side: 'BUY_PE', action: 'OPEN', entryPremium: observedEntryPremium, quantity: contract.lotSize as number, marketDataState: recovery?.getState(), sessionTradable: !eodRequestedForRisk && !shuttingDown, quote: { ltp: executionQuote?.ltp ?? null, bid: executionQuote?.bestBid ?? null, ask: executionQuote?.bestAsk ?? null, ageMs: executionQuote?.quoteAgeMs ?? null, crossed: executionQuote?.dataQuality === 'CROSSED' } };
    } },
    portfolio,
    fillModel,
    paperMarketDataAdapter,
    undefined,
    prismaExecution,
  );
  const strategyAdapter = new LivePaperStrategyAdapterService(orchestration, undefined, undefined, () => orderManager.getActiveOrders().length > 0, { v2: isV2, paperTradingOnly, v2ExitPolicy: v2ExitPolicyConfig });
  const forwardJournal = new ForwardValidationJournal('V2_TREND_DOWN_PE', forwardFingerprint);
  const performStartupWarmup = async (): Promise<Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>> => {
    return new LivePaperFreshWarmupService(
      new HistoricalCandleRepository(),
      strategyAdapter,
    ).warmUp();
  };
  const warmupResult = await performStartupWarmup();
  console.log(`[paper.strategy.warmup] source=${warmupResult.currentDaySource} attempts=${warmupResult.intradayBackfillAttempts} lagMinutes=${warmupResult.currentDayLagMinutes ?? 'N/A'} retryReason=${warmupResult.intradayRetryReason ?? 'NONE'} now=${formatIst(warmupResult.currentIstTimestamp)} rowsReturned=${warmupResult.currentDayRowsReturned} firstCurrent=${warmupResult.firstCurrentDayCandle ? formatIst(warmupResult.firstCurrentDayCandle) : 'NONE'} lastCurrent=${warmupResult.lastCurrentDayCandle ? formatIst(warmupResult.lastCurrentDayCandle) : 'NONE'} latest1m=${warmupResult.latestUnderlyingHistoricalCandle ? formatIst(warmupResult.latestUnderlyingHistoricalCandle) : 'NONE'} expected1m=${warmupResult.latestCompletedOneMinuteExpected ? formatIst(warmupResult.latestCompletedOneMinuteExpected) : 'NONE'} latest5m=${warmupResult.latestCompletedFiveMinuteAvailable ? formatIst(warmupResult.latestCompletedFiveMinuteAvailable) : 'NONE'} ageMinutes=${warmupResult.warmupAgeMinutes?.toFixed(2) ?? 'N/A'} missingMinutes=${warmupResult.currentDayMissingMinuteCount} duplicates=${warmupResult.currentDayDuplicateCount} ready=${warmupResult.ready} reason=${warmupResult.freshnessReason}`);
  if (!warmupResult.ready) {
    console.log('[paper.strategy.warmup] Startup blocked: current-day historical warm-up is not fresh. No V1/V2 entries will be evaluated.');
    const forwardDate = istDate(new Date());
    const outcome = resolveSessionOutcome({
      reason: warmupResult.freshnessReason,
      invalidData: true,
    });
    forwardJournal.append({
      recordType: 'SUMMARY',
      tradingDate: forwardDate,
      strategyId: 'V2_TREND_DOWN_PE',
      fingerprint: forwardFingerprint,
      sessionCompleted: outcome.sessionCompleted,
      eodReason: warmupResult.freshnessReason,
      status: outcome.status,
      flags: ['FORWARD_EVALUATION_ONLY', 'STARTUP_DATA_BLOCKED'],
    });
    return;
  }
  const strategyResults = new Map<number, LivePaperStrategyResult>();
  const forwardDate = istDate(new Date());
  let host: StrategyHostLifecycle | undefined;
  if (forwardJournal.hasRecordsForDate(forwardDate)) forwardJournal.appendEvent(forwardDate, 'MANUAL_RESTART', ['MANUAL_RESTART'], { reason: 'existing_session_journal' });
  forwardJournal.append({ recordType: 'SESSION', tradingDate: forwardDate, strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, runtimeStartedAt: new Date().toISOString(), marketDataHealthy: true, sessionCompleted: false, flags: ['FORWARD_EVALUATION_ONLY'] });
  const instrumentedStrategyAdapter = {
    async processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> {
      const result = await strategyAdapter.processCompletedCandle(input);
      strategyResults.set(result.candleTimestamp.getTime(), result);
      return result;
    },
    isWarmupReady(): boolean {
      return strategyAdapter.isWarmupReady();
    },
  };
  const runtime = new PaperTradingRuntimeService(instrumentedStrategyAdapter, paperMarketDataAdapter, orderManager, bus);
  const contractsProvider = new CurrentNiftyOptionContractsProvider(new InstrumentRepository());
  const hostGatedRuntime = {
    getState: (): PaperTradingRuntimeState => host?.canEvaluate() ? runtime.getState() : PaperTradingRuntimeState.STOPPED,
    processCompletedCandle: (input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> => runtime.processCompletedCandle(input),
  };
  const paperRuntimeCandleAdapter = new PaperRuntimeCandleAdapterService(hostGatedRuntime, contractsProvider, bus);

  const createdOrderIds = new Set<string>();
  // Bounds the wait for the first accepted current-generation NIFTY event
  // after subscribing on cold start. Reuses the same 45s figure
  // MarketDataHealthMonitorService already treats as "stalled" for an
  // established connection (MARKET_DATA_STALL_MS). On a genuinely silent feed
  // during an active session, this bound (not the health monitor's periodic
  // stall check, which only starts polling once CONNECTED and fires on a
  // multiple of its own heartbeat) is what owns and reports the startup
  // failure.
  const eodCoordinator = new NseSessionEodCoordinator();
  let lastNiftyTickPrintedAt = 0;
  let shuttingDown = false;
  let eodRequested = false;
  // Decided once, at the START of each disconnect/reconnect episode, from the coordinator's
  // OWN generation-independent authoritative truth (sourceBoundaryEvaluationCoverage), and
  // reused consistently through the matching reconnect -- never decided after the fact from a
  // FAULTED coordinator. See connectionManager.on('unexpectedDisconnect'/'reconnected') below.
  let sourceRecoveryBypassActive = false;
  let requestedShutdownReason = 'SESSION_END';
  // Separates each terminal trigger's own close-out work (still gated by the
  // `shuttingDown` latch below, run at most once) from the single durable
  // SUMMARY/CLEAN_SHUTDOWN write: a racing fault can still escalate the
  // outcome for as long as commit() has not yet run, even if a different
  // trigger already owns the close-out work in progress.
  const terminalOutcomeArbiter = new StrategyTerminalOutcomeArbiter();
  // Before host.start() has successfully returned, host.start() itself is the
  // sole owner of the initial RUNNING transition (via onReady ->
  // recovery.waitUntilReady()). Calling host.recovered() from the persistent
  // recovery listener too, while the host is still transiting through
  // READY/DEGRADED during startup, races start()'s own unconditional RUNNING
  // transition and produces an illegal RUNNING->RUNNING transition.
  let startupComplete = false;
  type RecoveryWarmup = Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>;
  const performRecoveryBackfill = async (requiredCompletedMinute?: Date): Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number; recoveryData: RecoveryWarmup }> => {
    const recoveryWarmupTarget = { count: 0, seedHistoricalCandles(candles: readonly import('../modules/indicators/types').Candle[]): void { this.count = candles.length; }, isWarmupReady(): boolean { return this.count >= 36; } };
    const recoveryWarmup = await new LivePaperFreshWarmupService(new HistoricalCandleRepository(), recoveryWarmupTarget)
      .warmUp(requiredCompletedMinute ? new Date(requiredCompletedMinute.getTime() + 60_000) : undefined);
    return {
      ready: recoveryWarmup.ready,
      reason: recoveryWarmup.freshnessReason,
      missingMinutes: recoveryWarmup.currentDayMissingMinuteCount,
      duplicateMinutes: recoveryWarmup.currentDayDuplicateCount,
      recoveryData: recoveryWarmup,
    };
  };
  // A7-H6: set only when a recovery reconstructs data reaching exactly the NIFTY
  // source-completion boundary (15:29 IST) -- the one bucket recoverHistoricalCandles() below
  // must withhold so the source-boundary trigger's own actionable evaluation call is never
  // rejected as "already seeded". Read and cleared by performSourceBoundaryEvaluation().
  let pendingSourceBoundaryCandle: Candle | undefined;
  const isNiftyFinalSourceMinute = (candidate: Date | null | undefined): boolean =>
    candidate != null && candidate.getTime() === nifty1mSourceCompletionBoundary(candidate).getTime() - 60_000;
  const applyRecoveredHistoricalCandles = (_generationId: number, recoveryWarmup: RecoveryWarmup | undefined): undefined => {
    if (!recoveryWarmup) return undefined;
    const completed = new CandleTimeframeAggregatorService().aggregate(recoveryWarmup.seededOneMinuteCandles, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
    // recoverHistoricalCandles() remains non-evaluating infrastructure recovery for every
    // ordinary (mid-session) reconciliation. Only when this recovery proves coverage exactly
    // through the source horizon is its final bucket also the one genuine forward-evaluation
    // opportunity left in the session -- withhold just that bucket from seeding and hand it to
    // performSourceBoundaryEvaluation() instead, so history stays complete for every other case.
    const isTerminalRecovery = isNiftyFinalSourceMinute(recoveryWarmup.lastCurrentDayCandle);
    const toSeed = isTerminalRecovery && completed.length > 0 ? completed.slice(0, -1) : completed;
    strategyAdapter.recoverHistoricalCandles(toSeed);
    if (isTerminalRecovery && completed.length > 0) pendingSourceBoundaryCandle = completed.at(-1);
    // A7 reset-race correction: deliberately NOT calling liveCandleBuilder.reset(niftyInstrumentKey)
    // here. This callback fires asynchronously, well after onLiveConstructionBoundary already
    // set today's floor (liveConstructionBoundaries, checked on every tick -- no bucket before
    // it can ever be built, on any generation) and well after a live tick may already have built
    // a genuine current-generation active candle at/after that boundary (the boundary and
    // "recovery is due" are both driven by the SAME live tick reaching handleMarketTick before
    // this same event reaches LiveCandleEventAdapterService -- recovery is deliberately NOT
    // awaited inline, so it can resolve strictly after that candle already exists). An
    // unconditional whole-instrument reset here would delete that valid candle and its
    // chronological watermark, corrupting the bucket's open (or losing it outright) the moment
    // a later tick rebuilds it from scratch. Stale state from BEFORE this generation is already
    // retired independently and unconditionally, before any tick of the new generation can build
    // anything: LiveCandleEventAdapterService's own LiveGenerationCacheScope resets the builder
    // (candleBuilder.reset(), no instrument filter) the instant a tick's generationId first
    // differs from its cached one, and setLiveConstructionBoundary's floor (set synchronously,
    // before recovery even starts) independently guarantees nothing before the boundary can ever
    // be built on any generation. Both guarantees are unconditional and generation-driven, not
    // recovery-timing-driven, so this callback has nothing left to safely clear.
    liveCandleEventAdapter.start();
    return undefined;
  };
  const handleRecoveryEvent = (eventType: string, details: Record<string, string | number | boolean | null>): void => {
    const unrecovered = eventType === 'DATA_GAP_UNRECOVERABLE';
    forwardJournal.appendEvent(forwardDate, eventType, [eventType, ...(unrecovered ? ['CRITICAL_DATA_QUALITY'] : [])], details);
    console.log(`[MARKET_DATA_BACKFILL] event=${eventType} state=${recovery?.getState()}`);
  };
  const handleRecoveryState = (state: string): void => {
    if (state === 'DEGRADED') {
      void host?.degrade('MARKET_DATA_DEGRADED');
    }
    // eodRequested (set synchronously the instant EOD is detected, well before shuttingDown
    // is set inside shutdown()) must also gate this: an EOD-triggered canonical-close
    // reconciliation (see completePendingBoundaryReconciliation in performDurableEodExit)
    // can drive this coordinator to READY while shuttingDown is still false, and must never
    // be allowed to re-arm post-close strategy evaluation.
    if ((state === 'READY' || state === 'SOURCE_COMPLETE_READY') && !shuttingDown && !eodRequested) {
      // SOURCE_COMPLETE_READY confirms via confirmPostSourceTransportReady() (transport
      // evidence -- raw+valid, never a NIFTY tick, which is not guaranteed to ever arrive
      // again once source responsibility is complete); READY keeps the original
      // confirmRecoveryReady() (which does require one).
      const healthConfirmed = state === 'READY'
        ? health.confirmRecoveryReady(recovery!.getGenerationId())
        : health.confirmPostSourceTransportReady(recovery!.getGenerationId());
      if (!healthConfirmed) {
        connectionManager.failRecovery(recovery!.getGenerationId(), 'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
        return;
      }
      paperMarketDataAdapter.setMarketDataAvailable(true);
      paperRuntimeCandleAdapter.start();
      // host.start() itself owns the initial RUNNING transition via its
      // onReady hook; only a genuine post-startup recovery may call
      // host.recovered() here. See startupComplete above.
      if (startupComplete) void host?.recovered('MARKET_DATA_READY');
    }
    // A FAULTED coordinator here always means a source-candle recovery was genuinely attempted
    // and genuinely failed (including the fail-closed NO_SAFE_LIVE_CONSTRUCTION_BOUNDARY_
    // BEFORE_SESSION_CLOSE case) -- a benign post-source-completion transport episode never
    // reaches handleReconnected()/FAULTED at all; see the sourceRecoveryBypassActive-gated
    // unexpectedDisconnect/reconnected handlers below, which route it through
    // handleUnexpectedDisconnectSourceRecoveryNotRequired()/handleReconnectedSourceRecoveryNotRequired()
    // instead. So this escalation is unconditional and correct exactly as it was before the
    // post-source-completion investigation.
    if (state === 'FAULTED') connectionManager.failRecovery(recovery!.getGenerationId(), 'RECOVERY_COORDINATOR_FAULTED');
  };
  recovery = new MarketDataRecoveryCoordinatorService<RecoveryWarmup>({
    getLastSeededCompletedMinute: () => warmupResult.lastCurrentDayCandle,
    liveConstructionAlignmentMinutes,
    // NSE_INDEX|Nifty 50's own source horizon is narrower than TradeMind's own operational
    // EOD/grace boundary above -- see historical-session-completeness.util.
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (recoveryWarmup) => recoveryWarmup?.lastCurrentDayCandle,
    backfill: performRecoveryBackfill,
    onRecovered: applyRecoveredHistoricalCandles,
    // A7-H2: exclude any bucket, on any timeframe, that starts before the first minute
    // guaranteed observable from its very start on this connection -- otherwise a
    // WebSocket that connects/reconnects mid-minute could silently emit a partial
    // "completed" 5m candle into the live evaluation path.
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(niftyInstrumentKey, boundary.getTime()),
    onLiveConstructionUnavailable: (sessionClose) => liveCandleBuilder.blockLiveConstructionForSession(niftyInstrumentKey, sessionClose.getTime()),
    onEvent: handleRecoveryEvent,
  });
  // Gateway mode: health evidence/confirmation is centralized once in SharedMarketDataGateway's
  // own single MarketDataHealthMonitorService (see that class's doc) -- `health` here is simply
  // the same leased channel again, exposing read-only confirm*/no-op note* methods. The onStall
  // behavior below (stopping candle events, calling recovery.handleUnexpectedDisconnect,
  // MARKET_DATA_DEGRADED journaling) is NOT lost under gateway mode: it is exactly what the
  // unchanged `connectionManager.on('unexpectedDisconnect', ...)` listener registered further
  // below already does, fired once by the gateway's own centralized stall-triggered reconnect --
  // only the benign SOURCE_STALL (reconnectSolicited=false) observability line is not duplicated
  // per strategy under gateway mode (logged once, centrally, by the gateway instead).
  const health: MarketDataHealthPort = options.channel ?? new MarketDataHealthMonitorService(realConnectionManager!, {
    generationGraceMs:healthGraceMs,
    // NIFTY_INDEX genuinely stops publishing 1m source candles at the canonical 15:30 IST
    // source-completion boundary, well before the wider 09:15-15:40 operational session ends.
    // A STALL detected at/after that boundary must not solicit a reconnect the recovery
    // coordinator can never satisfy for a new candle (see the coordinator's own, unchanged,
    // no-safe-handoff fail-closed rule). Reuses the canonical nifty1mSourceCompletionBoundary
    // utility -- no duplicate hardcoded boundary here.
    isSourceFresh: (value) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime(),
    onStall: (snapshot, { reason, reconnectSolicited }) => {
      if (!reconnectSolicited) {
        // Expected post-source-completion condition: transport (raw/option) traffic is
        // genuinely healthy -- only the NIFTY source itself has naturally stopped. Must NOT
        // start a coordinator disconnect episode, stop adapters, or disable market-data
        // availability for this (see PROVEN BLOCKER 1) -- retain observability only.
        forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_SOURCE_STALE_EXPECTED', ['MARKET_DATA_SOURCE_STALE_EXPECTED'], { ...snapshot, reason });
        return;
      }
      // Fires (and calls handleUnexpectedDisconnect directly) BEFORE ConnectionManager's own
      // 'unexpectedDisconnect' event -- this is the real first mover for a health-triggered
      // STALL/HEALTH_GRACE_EXPIRED, so the bypass decision must be made identically here too
      // (see connectionManager.on('unexpectedDisconnect', ...) below for the full rationale).
      sourceRecoveryBypassActive = sourceBoundaryEvaluationCoverage.getRecord()?.disposition === 'EVALUATED';
      const details = { generationId: snapshot.generationId, reason, lastMessageAgeMs: snapshot.lastRawMessageAgeMs, lastTickAgeMs: snapshot.lastNiftyTickAgeMs };
      if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
      else recovery.handleUnexpectedDisconnect(details);
      paperMarketDataAdapter.setMarketDataAvailable(false); paperRuntimeCandleAdapter.stop(); liveCandleEventAdapter.stop();
      forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], { ...snapshot });
    },
  });
  recovery.on('stateChanged', handleRecoveryState);
  // F-02: bounded POST-STARTUP consumer recovery watchdog. Budget mirrors the existing V2
  // alignment convention (base MARKET_DATA_MAX_RECONNECT_DURATION_MS + 5 minutes) already
  // computed above as reconnectDurationMs. Only fed states once startupComplete is true (see
  // the listener below) so it can never compete with waitUntilReady()'s own cold-start bound.
  // onTimeout calls only recovery.fault() -- never the physical connectionManager -- so a V2-only
  // timeout can never open the shared gateway breaker or affect V4/V8 siblings (see
  // handleRecoveryState's own FAULTED branch above, which already routes any fault through the
  // consumer-scoped connectionManager.failRecovery()/channel.failRecovery() port).
  const recoveryWatchdog = new ConsumerRecoveryWatchdogService({ budgetMs: reconnectDurationMs, onTimeout: (reason) => recovery!.fault(reason) });
  recovery.on('stateChanged', (state) => { if (startupComplete) recoveryWatchdog.onStateChanged(state); });

  // A7-H6: owned evidence for whether the one required final forward-strategy evaluation at
  // the NIFTY source-completion boundary actually ran (see SourceBoundaryEvaluationCoverageTracker).
  const sourceBoundaryEvaluationCoverage = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  // One-shot, generation-owned, cancellable trigger for the NIFTY source-completion boundary --
  // never a hardcoded literal (see nifty1mSourceCompletionBoundary), and cancelled unconditionally
  // in shutdown()'s close-out below so it can never fire after terminalization has started.
  const sourceBoundaryTrigger = new OneShotWallClockTrigger();
  /**
   * The source-boundary completion trigger: fires once at the NIFTY source-completion
   * boundary (15:30 IST) rather than waiting for the 15:40 operational EOD barrier, so the
   * final genuine V2 5m opportunity (15:25-15:29) is never silently substituted by non-
   * evaluating terminal recovery. Reads `connectionManager.getGenerationId()` fresh at fire
   * time (never a value captured at arm time) so a disconnect/reconnect between arming and
   * firing is always judged against whichever generation is actually current when it runs.
   */
  const markSourceBoundaryLost = (generationId: number, reason: string): void => {
    sourceBoundaryEvaluationCoverage.markLost(generationId, reason);
    forwardJournal.appendEvent(forwardDate, 'V2_SOURCE_BOUNDARY_LOST', ['V2_SOURCE_BOUNDARY_LOST', 'CRITICAL_DATA_QUALITY'], { reason, generationId });
  };
  const performSourceBoundaryEvaluation = async (): Promise<void> => {
    if (shuttingDown || eodRequested) return;
    const generationId = connectionManager.getGenerationId();
    const boundaryAt = nifty1mSourceCompletionBoundary(new Date());
    // The one authoritative REST target this terminal evaluation may ever accept -- exactly
    // one minute before the source-completion boundary (15:29 IST for the 15:30 boundary).
    // Never inferred from wall clock at recovery time; always this exact instant.
    const requiredCompletedMinute = new Date(boundaryAt.getTime() - 60_000);
    const finalBucketStart = new Date(boundaryAt.getTime() - liveConstructionAlignmentMinutes * 60_000);
    sourceBoundaryEvaluationCoverage.require(generationId, boundaryAt);
    forwardJournal.appendEvent(forwardDate, 'V2_SOURCE_BOUNDARY_EVALUATION_STARTED', ['V2_SOURCE_BOUNDARY_EVALUATION_STARTED'], { generationId, boundaryAt: boundaryAt.toISOString(), requiredCompletedMinute: requiredCompletedMinute.toISOString() });

    let candle: import('../modules/indicators/types').Candle | undefined;
    // Path A: ticks flowed normally all session and already built this exact final bucket
    // locally -- flush it (mirroring finishSession()'s own semantics for this one candle)
    // rather than re-deriving it from REST.
    const active = liveCandleBuilder.getActiveCandle(niftyInstrumentKey, '5m');
    if (active && active.candleTime.getTime() === finalBucketStart.getTime()) {
      candle = { timestamp: new Date(active.candleTime.getTime()), open: active.open, high: active.high, low: active.low, close: active.close, volume: 0 };
      // Consumed here -- must not also be flushed (and re-emitted) a second time by the
      // 15:40 EOD finishSession() call.
      liveCandleBuilder.reset(niftyInstrumentKey, '5m');
      forwardJournal.appendEvent(forwardDate, 'V2_PATH_A_LOCAL_CANDLE_USED', ['V2_PATH_A_LOCAL_CANDLE_USED'], { candleTime: candle.timestamp.toISOString() });
    } else {
      // Path B: no locally-built candle for this bucket exists (e.g. a disconnect/reconnect
      // gated live construction for it) -- positively recover/confirm authoritative source
      // through 15:29 via the exact same barrier the 15:40 EOD path uses, scoped explicitly to
      // THIS boundary/requiredCompletedMinute so a cached RECOVERED left over from an earlier
      // (e.g. startup) aligned boundary can never satisfy this terminal requirement. Idempotent
      // for repeat calls that already match this exact boundary (a second call from EOD, after
      // this one already succeeded, returns the same RECOVERED outcome without re-running
      // backfill); a mismatched cached obligation instead triggers a fresh recovery attempt.
      forwardJournal.appendEvent(forwardDate, 'V2_PATH_B_RECOVERY_REQUIRED', ['V2_PATH_B_RECOVERY_REQUIRED'], { boundaryAt: boundaryAt.toISOString(), requiredCompletedMinute: requiredCompletedMinute.toISOString() });
      const result = await recovery!.completePendingBoundaryReconciliation({ generationId, boundaryAt, requiredCompletedMinute });
      if (shuttingDown || eodRequested || connectionManager.getGenerationId() !== generationId) {
        markSourceBoundaryLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_DURING_RECOVERY');
        return;
      }
      if (result.outcome !== 'RECOVERED') {
        forwardJournal.appendEvent(forwardDate, 'V2_PATH_B_RECOVERY_FAILED', ['V2_PATH_B_RECOVERY_FAILED', 'CRITICAL_DATA_QUALITY'], { reason: result.reason });
        markSourceBoundaryLost(generationId, result.reason);
        return;
      }
      forwardJournal.appendEvent(forwardDate, 'V2_PATH_B_RECOVERY_COMPLETED', ['V2_PATH_B_RECOVERY_COMPLETED'], {});
      candle = pendingSourceBoundaryCandle;
      pendingSourceBoundaryCandle = undefined;
      if (!candle) {
        markSourceBoundaryLost(generationId, 'TERMINAL_CANDLE_NOT_RECONSTRUCTED');
        return;
      }
    }

    if (shuttingDown || eodRequested || connectionManager.getGenerationId() !== generationId) {
      markSourceBoundaryLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_BEFORE_EVALUATION');
      return;
    }
    if (hostGatedRuntime.getState() !== PaperTradingRuntimeState.RUNNING) {
      markSourceBoundaryLost(generationId, 'HOST_NOT_RUNNING_AT_SOURCE_BOUNDARY');
      return;
    }
    try {
      const contracts = await contractsProvider.getContracts();
      if (shuttingDown || eodRequested || connectionManager.getGenerationId() !== generationId) {
        markSourceBoundaryLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_BEFORE_EVALUATION');
        return;
      }
      // The exact same actionable path an ordinary completed live 5m candle uses: the
      // host-gated runtime object PaperRuntimeCandleAdapterService itself calls.
      const result = await hostGatedRuntime.processCompletedCandle({ candle, completed: true, contracts });
      bus.emit('paper.strategy.evaluated', {
        candleTimestamp: new Date(result.candleTimestamp.getTime()),
        spotPrice: result.spotPrice,
        rawSignal: result.rawEmaSignal,
        finalSignal: result.finalSignal,
        timeFilterAllowed: result.timeFilterAllowed,
        reasons: [...result.reasons],
        paperOrderId: result.orchestration?.order.id,
      });
      // NO_TRADE, a filtered signal, or a risk-denied BUY_PE all still count as evaluated --
      // the opportunity was genuinely evaluated through the actionable path exactly once.
      sourceBoundaryEvaluationCoverage.markEvaluated(generationId, candle.timestamp, 'SOURCE_BOUNDARY_EVALUATION_COMPLETED');
      forwardJournal.appendEvent(forwardDate, 'V2_SOURCE_BOUNDARY_EVALUATED', ['V2_SOURCE_BOUNDARY_EVALUATED'], { candleTimestamp: candle.timestamp.toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Source-boundary strategy evaluation failed.';
      bus.emit('paper.strategy.error', { instrumentKey: niftyInstrumentKey, candleTimestamp: new Date(candle.timestamp.getTime()), message });
      markSourceBoundaryLost(generationId, message);
    }
  };

  // Only ever registered (below) in standalone mode -- tickProcessor/protobufDecoder are always
  // defined by the time this can actually run.
  const handleWebSocketMessage = (buffer: Buffer, details: { generationId: number }): void => {
    try {
      tickProcessor!.process(protobufDecoder!.decode(buffer), details.generationId);
    } catch (error) {
      console.error('[market-data decode/process error]', safeMessage(error));
    }
  };
  const handleMarketTick = (event: unknown): void => {
    const tick = event as Partial<MarketTickEvent>;
    if (!isCurrentLiveGeneration(tick.generationId, connectionManager.getGenerationId())) return;
    if (typeof tick.instrumentKey !== 'string' || typeof tick.ltp !== 'number' || !Number.isFinite(tick.ltp) || tick.ltp <= 0 || typeof tick.timestamp !== 'string') return;
    const timestamp = new Date(tick.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;
    if (isAtOrAfterNseSessionClose(timestamp)) { eodRequested = true; eodRequestedForRisk = true; paperRuntimeCandleAdapter.stop(); void host?.eod('MARKET_EOD'); return; }
    health.noteValidMarketEvent(tick.generationId);
    // Post-source-completion transport-readiness confirmation: any current-generation valid
    // market event -- option quotes count exactly like NIFTY -- can prove the new connection is
    // genuinely alive, since a NIFTY tick is not guaranteed to ever arrive again once source
    // responsibility is complete (see PROVEN BLOCKER 2). No-op outside that one waiting state.
    if (recovery!.getState() === 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT' && health.confirmPostSourceTransportReady(tick.generationId)) {
      recovery!.handleTransportReadySourceRecoveryNotRequired(tick.generationId);
    }
    if (tick.instrumentKey === niftyInstrumentKey) { health.noteNiftyTick(tick.generationId, timestamp); recovery!.handleLiveTick({ sourceTimestamp: timestamp, receivedAt: new Date(), generationId: tick.generationId }); if (recovery!.isEvaluationReady()) health.confirmRecoveryReady(tick.generationId); }
    cacheCurrentLiveInstrumentValue(latestPremiumByInstrument, tick.instrumentKey, tick.ltp, tick.generationId, connectionManager.getGenerationId());
    if (tick.instrumentKey === niftyInstrumentKey && Date.now() - lastNiftyTickPrintedAt >= tickPrintIntervalMs) {
      lastNiftyTickPrintedAt = Date.now();
      console.log(`[market.tick] NIFTY ${formatIst(timestamp)} | LTP ${tick.ltp.toFixed(2)}`);
    }
  };
  const handleCompletedFiveMinuteCandle = (event: unknown): void => {
    const candle = event as { instrumentKey?: string; timeframe?: string; candleTime?: Date; open?: number; high?: number; low?: number; close?: number; completed?: boolean };
    if (eodRequested) return;
    if (candle.instrumentKey !== niftyInstrumentKey || candle.timeframe !== '5m' || candle.completed !== true || !(candle.candleTime instanceof Date)) return;
    console.log(`[market.candle.completed] NIFTY 5m ${formatIst(candle.candleTime)} | O ${candle.open?.toFixed(2)} H ${candle.high?.toFixed(2)} L ${candle.low?.toFixed(2)} C ${candle.close?.toFixed(2)}`);
  };
  const handleStrategyEvaluated = (event: unknown): void => {
    if (eodRequested) return;
    const evaluation = event as StrategyEvaluatedEvent;
    if (!(evaluation.candleTimestamp instanceof Date)) return;
    const indicatorValues = strategyResults.get(evaluation.candleTimestamp.getTime());
    if (evaluation.paperOrderId) createdOrderIds.add(evaluation.paperOrderId);
    if (evaluation.finalSignal === 'BUY_PE') forwardJournal.append({ recordType: 'SIGNAL', tradingDate: istDate(evaluation.candleTimestamp), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, signalId: `V2-${evaluation.candleTimestamp.getTime()}`, signalTimestampIst: formatIst(evaluation.candleTimestamp), signalTimestampUtc: evaluation.candleTimestamp.toISOString(), underlyingInstrument: niftyInstrumentKey, underlyingClose: evaluation.spotPrice, regime: 'TREND_DOWN', indicators: { ema15: indicatorValues?.ema15 ?? null, ema35: indicatorValues?.ema35 ?? null, rsi14: indicatorValues?.rsi14 ?? null }, signalReason: evaluation.reasons.join('|'), flags: ['FORWARD_EVALUATION_ONLY'] });
    if (evaluation.paperOrderId) {
      const order = orderManager.getById(evaluation.paperOrderId); const fill = order?.entry.executionFill;
      forwardJournal.append({ recordType:'ENTRY', tradingDate:istDate(evaluation.candleTimestamp), strategyId:'V2_TREND_DOWN_PE', fingerprint:forwardFingerprint, signalId:evaluation.paperOrderId, signalTimestampIst:formatIst(evaluation.candleTimestamp), selectedOptionInstrument:order?.contract.instrumentKey, optionType:order?.contract.optionType, strike:order?.contract.strikePrice, expiry:order?.contract.expiry.toISOString(), theoreticalEntryPrice:order?.entry.observedEntryPremium ?? null, executableEntryPrice:fill?.averageFillPrice ?? null, entryPriceSource:fill?.fillQuality === 'LTP_ONLY_ESTIMATE' ? 'ESTIMATED_LTP' : fill ? 'ASK' : 'UNAVAILABLE', indicators:{ fillStatus:fill?.status ?? 'UNAVAILABLE', fillQuality:fill?.fillQuality ?? 'UNAVAILABLE', requestedQuantity:fill?.requestedQuantity ?? null, filledQuantity:fill?.filledQuantity ?? null, quotedBestPrice:fill?.quotedBestPrice ?? null, totalExecutionSlippage:fill?.totalExecutionSlippage ?? null, slippagePercent:fill?.slippagePercent ?? null }, flags:['FORWARD_EVALUATION_ONLY', ...(fill ? [] : ['EXECUTION_ESTIMATE_UNAVAILABLE'])] });
    }
    console.log(`[paper.strategy.evaluated] ${formatIst(evaluation.candleTimestamp)} | EMA15 ${formatIndicator(indicatorValues?.ema15)} | EMA35 ${formatIndicator(indicatorValues?.ema35)} | RSI14 ${formatIndicator(indicatorValues?.rsi14)} | raw ${evaluation.rawSignal} | final ${evaluation.finalSignal} | time filter ${evaluation.timeFilterAllowed ? 'ALLOWED' : 'BLOCKED'}${evaluation.paperOrderId ? ` | order ${evaluation.paperOrderId}` : ''}`);
    if (evaluation.reasons.length > 0) console.log(`  reasons: ${evaluation.reasons.join(' | ')}`);
    if (isV2) console.log(formatV2TradingLine(evaluation, indicatorValues));
  };
  const handlePaperOrderAction = (event: unknown): void => {
    const action = event as PaperOrderActionEvent;
    if (typeof action.orderId !== 'string' || !(action.timestamp instanceof Date)) return;
    const settledOrder = orderManager.getById(action.orderId); if (settledOrder?.exit) riskGate.recordClosedOrder(istDate(action.timestamp), action.orderId);
    const recordType = action.action.toUpperCase().includes('EXIT') || action.action.toUpperCase().includes('CLOSE') ? 'EXIT' : 'ENTRY';
    const depth = getCurrentLiveDepth(latestDepthByInstrument, action.instrumentKey, connectionManager.getGenerationId()); const best = depth?.quotes?.[0]; const staleThreshold = Number(process.env.FORWARD_STALE_QUOTE_MS ?? '2000'); const quote = normalizeQuote({ ltp: action.observedPremium, bid: best?.bidPrice, ask: best?.askPrice, bidQuantity: best?.bidQuantity ? Number(best.bidQuantity) : undefined, askQuantity: best?.askQuantity ? Number(best.askQuantity) : undefined, timestamp: depth?.timestamp }, action.timestamp, Number.isFinite(staleThreshold) ? staleThreshold : 2000);
    const fill = recordType === 'ENTRY' ? settledOrder?.entry.executionFill : settledOrder?.exit?.executionFill;
    const entryFill = settledOrder?.entry.executionFill; const theoreticalReturn = settledOrder?.exit ? (settledOrder.exit.observedExitPremium - settledOrder.entry.observedEntryPremium) / settledOrder.entry.observedEntryPremium * 100 : null; const executableReturn = settledOrder?.exit && entryFill && fill ? (fill.averageFillPrice - entryFill.averageFillPrice) / entryFill.averageFillPrice * 100 : null;
    forwardJournal.append({ recordType, tradingDate: istDate(action.timestamp), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, signalId: action.orderId, signalTimestampIst: formatIst(action.timestamp), selectedOptionInstrument: action.instrumentKey, theoreticalEntryPrice: recordType === 'ENTRY' ? settledOrder?.entry.observedEntryPremium ?? action.observedPremium : undefined, theoreticalExitPrice: recordType === 'EXIT' ? action.observedPremium : undefined, executableEntryPrice: recordType === 'ENTRY' ? (fill?.averageFillPrice ?? null) : undefined, executableExitPrice: recordType === 'EXIT' ? (fill?.averageFillPrice ?? null) : undefined, entryPriceSource: recordType === 'ENTRY' ? (fill ? 'ASK' : 'UNAVAILABLE') : undefined, exitPriceSource: recordType === 'EXIT' ? (fill ? 'BID' : 'UNAVAILABLE') : undefined, theoreticalReturn:recordType === 'EXIT' ? theoreticalReturn : undefined, executableEstimatedReturn:recordType === 'EXIT' ? executableReturn : undefined, totalEstimatedSlippage:recordType === 'EXIT' && entryFill && fill ? (entryFill.totalExecutionSlippage + fill.totalExecutionSlippage) : undefined, totalExecutionFrictionPercent:recordType === 'EXIT' && theoreticalReturn !== null && executableReturn !== null ? theoreticalReturn - executableReturn : undefined, executionQuoteQuality: quote.quality, quote, indicators: { fillStatus: fill?.status ?? 'UNAVAILABLE', fillQuality: fill?.fillQuality ?? 'UNAVAILABLE', requestedQuantity: fill?.requestedQuantity ?? null, filledQuantity: fill?.filledQuantity ?? null, quotedBestPrice: fill?.quotedBestPrice ?? null, totalExecutionSlippage: fill?.totalExecutionSlippage ?? null, slippagePercent: fill?.slippagePercent ?? null }, flags: ['FORWARD_EVALUATION_ONLY', ...(fill ? [] : ['EXECUTION_ESTIMATE_UNAVAILABLE']), ...(quote.quality === 'STALE_QUOTE' ? ['STALE_OPTION_QUOTE'] : [])] });
    console.log(`[paper.order.action] ${action.action} | order ${action.orderId} | ${action.instrumentKey} | premium ${action.observedPremium.toFixed(2)} | ${formatIst(action.timestamp)}`);
  };
  const handleMarketDepth = (event: unknown): void => {
    cacheCurrentLiveDepth(latestDepthByInstrument, event, connectionManager.getGenerationId());
  };
  const handleStrategyError = (event: unknown): void => {
    const error = event as { instrumentKey?: string; candleTimestamp?: Date; message?: string };
    console.error(`[paper.strategy.error] ${error.instrumentKey ?? 'unknown'} | ${error.candleTimestamp instanceof Date ? formatIst(error.candleTimestamp) : 'unknown time'} | ${error.message ?? 'Unknown paper-strategy error.'}`);
  };

  // Gateway mode decodes every packet exactly once upstream and never re-exposes a raw 'message'
  // event per consumer -- only standalone mode owns a dedicated decode path.
  if (!options.channel) connectionManager.on('message', handleWebSocketMessage);
  bus.on('market.tick', handleMarketTick);
  bus.on('market.depth', handleMarketDepth);
  bus.on('market.candle.completed', handleCompletedFiveMinuteCandle);
  bus.on('paper.strategy.evaluated', handleStrategyEvaluated);
  bus.on('paper.order.action', handlePaperOrderAction);
  bus.on('paper.strategy.error', handleStrategyError);

  const printStatus = (): void => {
    const status = runtime.getStatus();
    console.log(`[paper.runtime.status] state=${status.state} warmup=${status.warmupReady} candles=${status.completedCandlesProcessed} noTrade=${status.noTradeEvaluations} filtered=${status.filteredSignals} orders=${status.paperOrdersCreated} active=${status.activeOrderCount} target=${status.targetExits} stop=${status.stopExits} time=${status.timeExits}`);
  };
  const statusTimer = setInterval(printStatus, runtimeStatusIntervalMs);
  statusTimer.unref();

  const drainPendingDurableExit = async (): Promise<boolean> => {
    return paperMarketDataAdapter.drainDurableExitQueue(Number(process.env.PAPER_EXECUTION_SHUTDOWN_WAIT_MS ?? 5_000));
  };

  const reportShutdownObservability = (stopResult: { openOrdersRemaining: number }): void => {
    printStatus();
    console.log(`Open paper orders left open by design: ${stopResult.openOrdersRemaining}`);
    const observedOrders = Array.from(createdOrderIds)
      .map((id) => orderManager.getById(id))
      .filter((order): order is NonNullable<typeof order> => order !== undefined);
    if (observedOrders.length === 0) console.log('No paper orders were created during this live session.');
    else {
      console.log('Paper orders created during this harness run:');
      observedOrders.forEach((order) => {
        console.log(`  ${order.id} | ${order.status} | ${order.signalType} | ${order.contract.tradingSymbol} | entry ${order.entry.simulatedEntryPremium.toFixed(2)}${order.exit ? ` | exit ${order.exit.simulatedExitPremium.toFixed(2)} (${order.exit.exitReason})` : ''}`);
      });
    }

    connectionManager.off('message', handleWebSocketMessage);
    bus.off('market.tick', handleMarketTick);
    bus.off('market.depth', handleMarketDepth);
    bus.off('market.candle.completed', handleCompletedFiveMinuteCandle);
    bus.off('paper.strategy.evaluated', handleStrategyEvaluated);
    bus.off('paper.order.action', handlePaperOrderAction);
    bus.off('paper.strategy.error', handleStrategyError);
  };

  const shutdown = async (reason: string, onCloseOutComplete?: () => void, invalidData = false): Promise<void> => {
    // Cancelled unconditionally and before anything else, on every terminal trigger (including
    // a duplicate/racing one) -- cancel() is idempotent, so this is the one place that
    // guarantees the source-boundary trigger can never fire once terminalization has started.
    sourceBoundaryTrigger.cancel();
    // Proposed unconditionally, even if a different trigger already owns the
    // close-out work below -- this is the only way a racing fault can still
    // escalate the eventual commit()'d outcome.
    terminalOutcomeArbiter.propose(reason, resolveSessionOutcome({ reason, invalidData }).status);
    if (shuttingDown) return;
    shuttingDown = true; eodRequestedForRisk = true; riskGate.transition('HALTED');
    health.stop(); recovery.stop(); recoveryWatchdog.stop();
    const durableExitDrained = await drainPendingDurableExit();
    let reconciliationRequired = false;
    // sealAfterCloseOut() is the single production seam: it runs this fallible
    // close-out (draining state, stopping adapters, unsubscribing, disconnecting,
    // and all required observability/listener-removal, including any
    // trigger-specific pre-seal observability via onCloseOutComplete) fully to
    // completion -- or, if it throws, escalates to FAULTED and still durably
    // seals that reason -- BEFORE the SUMMARY/CLEAN_SHUTDOWN write below ever
    // runs. Nothing capable of throwing runs after sealAfterCloseOut() resolves:
    // the durable SUMMARY append inside the writer below is the final
    // potentially-throwing operation in this terminal path, so a successful
    // VALID_COMPLETED SUMMARY can never be followed by a lifecycle failure that
    // would leave the host FAULTED next to it.
    await terminalOutcomeArbiter.sealAfterCloseOut(
      () => {
        if (!durableExitDrained) {
          riskGate.transition('HALTED');
          forwardJournal.appendEvent(istDate(new Date()), 'EXECUTION_RECONCILIATION_REQUIRED', ['EXECUTION_RECONCILIATION_REQUIRED'], { reason: 'EXIT_TRANSACTION_DRAIN_TIMEOUT' });
          console.error('[PAPER_EXECUTION_DURABILITY_FAILURE] pending durable exit transaction did not settle before shutdown timeout; reconciliation is required.');
        }
        // Computed before any fallible cleanup below so it stays correct even if
        // a later step (e.g. connectionManager.disconnect()) throws.
        reconciliationRequired = orderManager.getActiveOrders().some((order) => order.status === PaperOrderStatus.RECONCILIATION_REQUIRED || order.status === PaperOrderStatus.EXIT_PENDING);
        clearInterval(statusTimer);
        paperRuntimeCandleAdapter.stop();
        const stopResult = runtime.stop(); // Runtime stops PaperMarketDataAdapterService.
        liveCandleEventAdapter.stop();
        paperMarketDataAdapter.stop(); // Explicit idempotent stop for standalone cleanup.
        subscriptionManager.unsubscribeMany(subscriptionManager.getSubscriptions().map((subscription) => subscription.instrumentKey));
        connectionManager.disconnect();
        // Status/order observability and listener removal are all part of this
        // trigger's own close-out: they must finish (or fault the session) BEFORE
        // the seal below, never after it.
        reportShutdownObservability(stopResult);
        // Trigger-specific pre-seal observability (e.g. performDurableEodExit's own
        // V2_EOD_SUMMARY log) -- still close-out work, so it must finish (or fault
        // the session) before the seal below, never after it.
        onCloseOutComplete?.();
      },
      (finalReason) => {
        // commit() (inside sealAfterCloseOut) reads the arbiter's authoritative reason at this
        // exact instant -- a fault that raced in via propose() any time before this line (including
        // during the drain above, or during close-out itself) wins here even though this call
        // originated from a different trigger's own local `reason`.
        const outcome = resolveSessionOutcome({
          reason: finalReason,
          reconciliationRequired,
          durableExitDrained,
          invalidData,
        });
        const portfolioSnapshot = portfolio.logSessionSummary(istDate(new Date()));
        // CLEAN_SHUTDOWN (non-authoritative) must be durable before SUMMARY (the
        // A9-authoritative eligibility record): a failure appending CLEAN_SHUTDOWN
        // must never leave a durable VALID_COMPLETED SUMMARY with no corresponding
        // shutdown evidence.
        if (outcome.status === 'VALID_COMPLETED') forwardJournal.appendEvent(istDate(new Date()), 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason: finalReason });
        console.log(`\nGraceful shutdown requested (${finalReason}).`);
        // The durable SUMMARY append is the FINAL potentially-throwing operation in
        // this writer -- and, once sealAfterCloseOut() has run all close-out and
        // observability above, in the entire terminal path. Nothing follows it.
        forwardJournal.append({ recordType: 'SUMMARY', tradingDate: istDate(new Date()), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, sessionCompleted: outcome.sessionCompleted, eodReason: finalReason, status: outcome.status, indicators: { portfolioOpenCount: portfolioSnapshot?.openPositionCount ?? null, portfolioClosedCount: portfolioSnapshot?.closedPositionCount ?? null, portfolioRealizedPnl: portfolioSnapshot?.totalRealizedPnl ?? null } });
      },
    );
  };

  const performDurableEodExit = async (): Promise<void> => {
    // StrategyHostLifecycle owns the exactly-once EOD latch. Its wall-clock
    // path is already inside the shared coordinator callback; re-entering
    // runOnce here would make that callback wait on itself.
    eodRequested = true;
    paperRuntimeCandleAdapter.stop();
    liveCandleEventAdapter.finishSession(niftyInstrumentKey);
    const eodAt = new Date();
    // A7-H3: V2's 5-minute alignment can land its final live-construction handoff
    // boundary exactly on the canonical session close, leaving REST ownership of the
    // final 5m candle's source minutes unresolved when EOD fires. This barrier
    // must run -- and be awaited -- BEFORE shutdown() (which calls recovery.stop()
    // below), or a still-pending/in-flight reconciliation would be silently discarded
    // and the session could reach VALID_COMPLETED with that final completed bar never
    // proven, violating NO_PARTIAL_BAR / NO_SILENTLY_MISSING_COMPLETED_STRATEGY_BAR.
    // NONE_PENDING is safe only when no aligned requirement ever existed; a previously
    // proven requirement remains RECOVERED. Required work invalidated by disconnect/stop/
    // generation change is retained as NOT_RECOVERED, never erased into a benign no-op.
    //
    // A benign post-source-completion transport episode (see sourceRecoveryBypassActive in the
    // unexpectedDisconnect/reconnected handlers above) can advance the connection generation
    // AFTER the one required final evaluation already reached EVALUATED under an earlier
    // generation. completePendingBoundaryReconciliation()'s own generation-equality check
    // (obligation.generationId === activeGenerationId) would then report NOT_RECOVERED purely
    // from that generation drift -- never from any actual invalidation -- because that check has
    // no way to know about sourceBoundaryEvaluationCoverage's higher-level, session-scoped
    // truth. sourceBoundaryEvaluationCoverage reaching EVALUATED is strictly stronger, more
    // specific proof that the required work already completed (performSourceBoundaryEvaluation's
    // own Path A/B can only ever mark it EVALUATED after either building the candle locally or,
    // for Path B, after this exact barrier itself already returned RECOVERED) -- so it alone is
    // authoritative here, and the barrier is skipped (never distrusted or reinterpreted) in that
    // one case.
    const alreadyEvaluatedThisSession = sourceBoundaryEvaluationCoverage.getRecord()?.disposition === 'EVALUATED';
    const eodSourceBoundaryAt = nifty1mSourceCompletionBoundary(eodAt);
    const boundaryReconciliation = alreadyEvaluatedThisSession
      ? { outcome: 'RECOVERED' as const, reason: 'SOURCE_BOUNDARY_EVALUATION_ALREADY_COMPLETE' }
      : await recovery!.completePendingBoundaryReconciliation({
        generationId: connectionManager.getGenerationId(),
        boundaryAt: eodSourceBoundaryAt,
        requiredCompletedMinute: new Date(eodSourceBoundaryAt.getTime() - 60_000),
      });
    const canonicalCloseRecoveryFailed = boundaryReconciliation.outcome === 'NOT_RECOVERED';
    if (canonicalCloseRecoveryFailed) {
      forwardJournal.appendEvent(istDate(eodAt), 'V2_CANONICAL_CLOSE_RECOVERY_FAILED', ['V2_CANONICAL_CLOSE_RECOVERY_FAILED', 'CRITICAL_DATA_QUALITY'], { reason: boundaryReconciliation.reason, recoveryState: recovery!.getState() });
      console.error(`[V2_CANONICAL_CLOSE_RECOVERY] Failed to prove complete source coverage before the session's live-construction handoff (${boundaryReconciliation.reason}); session will fail closed as INVALID_DATA.`);
    }
    // A7-H6: SOURCE/DATA coverage (above) is not FORWARD EVALUATION coverage. require() is a
    // no-op if the source-boundary trigger already recorded EVALUATED/LOST for this exact
    // generation; if that trigger never ran at all (e.g. it never fired, or start-up happened
    // too late to arm it), this establishes REQUIRED_PENDING here, which is correctly
    // unsatisfied below -- a terminal-only recovery must never silently substitute for a
    // missed real-time evaluation opportunity. Skip the re-arm for the same reason as above:
    // an already-EVALUATED record must never be overwritten by a later generation's fresh
    // REQUIRED_PENDING.
    const finalGenerationId = connectionManager.getGenerationId();
    if (!alreadyEvaluatedThisSession) sourceBoundaryEvaluationCoverage.require(finalGenerationId, nifty1mSourceCompletionBoundary(eodAt));
    const evaluationCoverageLost = !alreadyEvaluatedThisSession && !sourceBoundaryEvaluationCoverage.isSatisfiedFor(finalGenerationId);
    if (evaluationCoverageLost) {
      forwardJournal.appendEvent(istDate(eodAt), 'V2_SOURCE_BOUNDARY_EVALUATION_LOST', ['V2_SOURCE_BOUNDARY_EVALUATION_LOST', 'CRITICAL_DATA_QUALITY'], { reason: sourceBoundaryEvaluationCoverage.getRecord()?.reason ?? 'UNKNOWN', disposition: sourceBoundaryEvaluationCoverage.disposition(finalGenerationId) });
      console.error(`[V2_SOURCE_BOUNDARY_EVALUATION] Forward-evaluation coverage for the final source-boundary candle was not proven (${sourceBoundaryEvaluationCoverage.disposition(finalGenerationId)}); session will fail closed as INVALID_DATA.`);
    }
    forwardJournal.appendEvent(istDate(eodAt), 'EOD_FORCED_EXIT', ['EOD_FORCED_EXIT']);
    // Drain an already-triggered target/stop/timeout transaction first, then
    // route remaining EOD exits through the exact same durable pipeline.
    const preEodDrained = await drainPendingDurableExit();
    if (!preEodDrained) {
      riskGate.transition('HALTED');
      forwardJournal.appendEvent(istDate(eodAt), 'EXECUTION_RECONCILIATION_REQUIRED', ['EXECUTION_RECONCILIATION_REQUIRED'], { reason: 'PRE_EOD_EXIT_TRANSACTION_DRAIN_TIMEOUT' });
    }
    const actions = await positionMonitor.closeAtSessionEndDurably(eodAt, (instrumentKey, entryPremium) => getCurrentLiveInstrumentValue(latestPremiumByInstrument, instrumentKey, connectionManager.getGenerationId()) ?? entryPremium);
    actions.forEach((action) => {
      bus.emit('paper.order.action', action);
      console.log(`[V2_EOD_EXIT] order=${action.orderId} reason=TIME_EXIT premium=${action.observedPremium.toFixed(2)} timestamp=${formatIst(action.timestamp)}`);
    });
    // The V2_EOD_SUMMARY status/order reads and log are pre-seal, trigger-specific
    // close-out observability -- passed into shutdown() so they always run BEFORE
    // the seal, never after: nothing may follow `await shutdown(...)` in this hook.
    await shutdown('EOD_NSE_SESSION_CLOSE', () => {
      const status = runtime.getStatus();
      const eodStatus = orderManager.getActiveOrders().some((order) => order.status === PaperOrderStatus.RECONCILIATION_REQUIRED || order.status === PaperOrderStatus.EXIT_PENDING) ? 'RECONCILIATION_REQUIRED' : 'COMPLETED';
      console.log(`[V2_EOD_SUMMARY]\ndate=${istDate(eodAt)}\nstrategyId=${process.env.PAPER_STRATEGY_ID ?? 'V2_TREND_DOWN_PE'}\ncompleted5m=${status.completedCandlesProcessed}\nnoTrade=${status.noTradeEvaluations}\nsignals=${status.paperOrdersCreated}\norders=${status.paperOrdersCreated}\ntargetExits=${status.targetExits}\nstopExits=${status.stopExits}\ntimeExits=${status.timeExits}\nactivePositions=${status.activeOrderCount}\nstatus=${eodStatus}`);
    }, canonicalCloseRecoveryFailed || evaluationCoverageLost);
  };
  connectionManager.on('unexpectedDisconnect', (details: { code?: number; reason?: string; generationId?: number; disconnectClean?: boolean }) => {
    // Decided HERE, at disconnect time -- not after a doomed handleReconnected() has already
    // faulted the coordinator. If the one required final source-boundary evaluation for this
    // session has ALREADY, positively, reached EVALUATED (sticky/terminal, independent of which
    // connection generation it happened under), this transport episode can never need a NEW
    // source-candle recovery regardless of when the matching reconnect lands -- so it is routed
    // through the alternate handleUnexpectedDisconnectSourceRecoveryNotRequired()/
    // handleReconnectedSourceRecoveryNotRequired() pair, which never creates/poisons a
    // boundaryReconciliationObligation and never reaches FAULTED for this episode. Otherwise
    // (LOST, still pending, or never armed) this is the ordinary, fully unchanged, fail-closed
    // handleUnexpectedDisconnect()/handleReconnected() pair.
    sourceRecoveryBypassActive = sourceBoundaryEvaluationCoverage.getRecord()?.disposition === 'EVALUATED';
    if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
    else recovery.handleUnexpectedDisconnect(details);
    paperMarketDataAdapter.setMarketDataAvailable(false);
    paperRuntimeCandleAdapter.stop(); liveCandleEventAdapter.stop();
    forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_DISCONNECTED', ['WEBSOCKET_DISCONNECTED'], { code: details.code ?? null, reason: details.reason ?? null });
  });
  connectionManager.on('reconnected', (details: { downtimeMs?: number; generationId?: number }) => {
    forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_RECONNECTED', ['WEBSOCKET_RECONNECTED'], { downtimeMs: details.downtimeMs ?? null });
    // handleReconnected() synchronously establishes the current-generation live-construction
    // boundary (via onLiveConstructionBoundary, called before this returns) -- restart the
    // candle adapter immediately so the first clean-boundary tick reaches LiveCandleBuilder
    // instead of being dropped while asynchronous backfill is still in flight. Idempotent
    // start(): the eventual onRecovered -> liveCandleEventAdapter.start() call is a no-op.
    // paperRuntimeCandleAdapter stays stopped until the existing recovery READY path so no
    // strategy evaluation can happen before recovery actually completes.
    if (sourceRecoveryBypassActive) recovery.handleReconnectedSourceRecoveryNotRequired(details);
    else recovery.handleReconnected(details);
    // Harmless either way: handleReconnectedSourceRecoveryNotRequired() already blocked live
    // construction through session close (onLiveConstructionUnavailable), so the builder will
    // never produce a "completed" candle for this episode regardless.
    liveCandleEventAdapter.start();
  });
  connectionManager.on('reconnectFailed', (details: { attempts?: number; downtimeMs?: number }) => {
    forwardJournal.appendEvent(forwardDate, 'RECONNECT_FAILED', ['RECONNECT_FAILED', 'DATA_GAP', 'CRITICAL_DATA_QUALITY'], { attempts: details.attempts ?? null, downtimeMs: details.downtimeMs ?? null });
    recovery.fault('RECONNECT_FAILED');
    // Once the arbiter has started (or finished) sealing a different outcome, this
    // external trigger must not flip the HOST's own state to FAULTED: that would
    // disagree with the outcome already durably recorded (or in the middle of being
    // recorded) for this session.
    if (!terminalOutcomeArbiter.isSealing()) void host?.fault(new Error('RECONNECT_FAILED'));
  });
  // ConnectionManager emits 'connected' on every successful open, cold start
  // and reconnect alike (and 'reconnected' fires immediately after it on a
  // reconnect). handleInitialConnected() only has an effect the very first
  // time it runs, so this cannot reset or race the reconnect state machine
  // driven by 'unexpectedDisconnect' / 'reconnected' above.
  connectionManager.on('connected', (details: { generationId: number }) => {
    recovery.handleInitialConnected({ generationId: details.generationId });
  });

  host = new StrategyHostLifecycle({
    strategyId: 'V2_TREND_DOWN_PE',
    runtimeId: 'paper:v2',
    eodCoordinator,
    hooks: {
      // Durable initialization and current-day warmup deliberately completed
      // before the host is constructed, preserving their established order.
      // The host verifies those gates before allowing RUNNING.
      warmup: (): void => {
        const executionHealth = prismaExecution.getHealth(executionSessionDate);
        if (!warmupResult.ready) throw new Error('V2_WARMUP_NOT_READY');
        if (!executionHealth.ready || executionHealth.reconciliationRequired) {
          throw new Error(`V2_EXECUTION_NOT_READY:${executionHealth.status}`);
        }
      },
      // Historical + durable-execution warmup is proven above. This is the
      // LIVE gate: RUNNING (reason=MARKET_DATA_READY) must not be granted
      // until an accepted, usable, current-generation NIFTY event has
      // actually been observed -- subscription success alone is not proof.
      onReady: (): Promise<void> => recovery.waitUntilReady(startupReadyTimeoutMs),
      onEod: performDurableEodExit,
      onShutdown: (reason): Promise<void> => shutdown(reason ?? requestedShutdownReason),
      onFault: (): Promise<void> => shutdown('FAULTED'),
    },
    log: (event): void => {
      console.log(`[STRATEGY_HOST_STATE] strategyId=${event.strategyId} runtimeId=${event.runtimeId} previous=${event.previous} state=${event.state} reason=${event.reason}`);
    },
  });

  process.once('SIGINT', () => { requestedShutdownReason = 'SIGINT'; void host?.shutdown('SIGINT'); });
  process.once('SIGTERM', () => { requestedShutdownReason = 'SIGTERM'; void host?.shutdown('SIGTERM'); });

  liveCandleEventAdapter.start();
  health.start();
  runtime.start(); // Starts PaperMarketDataAdapterService as part of the runtime lifecycle.
  paperRuntimeCandleAdapter.start();
  await subscriptionManager.subscribe(niftyInstrumentKey, MarketDataSubscriptionMode.FULL);
  await host.start();

  if (host.getState() !== 'RUNNING') return;
  // host.start() has now successfully returned RUNNING: the persistent
  // recovery listener may take over ownership of DEGRADED -> RUNNING for any
  // later, genuine reconnect recovery.
  startupComplete = true;
  // F-03: this runtime has now reached its durable live-ownership point. The finally below must
  // never release the channel merely because this async function itself finishes below --
  // listeners/timers registered above keep the strategy alive independently of this call stack.
  runtimeOwnsChannel = true;
  // A7-H6: armed only once startup has genuinely reached RUNNING. nifty1mSourceCompletionBoundary
  // always resolves to today's trading date -- if it has already passed (only reachable here
  // because a late-enough cold start would already have failed closed above), armAt() fires it
  // immediately rather than silently dropping the requirement.
  sourceBoundaryTrigger.armAt(nifty1mSourceCompletionBoundary(new Date()), performSourceBoundaryEvaluation);
  console.log('Live paper-trading harness is RUNNING. It is subscribed to NIFTY only and will subscribe to an option only after an actionable signal. Press Ctrl+C to stop.');
  printStatus();
  } finally {
    // F-03: releases this consumer's shared-gateway registration on every path that did not
    // reach durable RUNNING ownership above -- an early return (outside session, warmup/execution
    // not ready), a startup-readiness fault (already also released via onFault -> shutdown() ->
    // connectionManager.disconnect(), but this call is idempotent), or any thrown initialization
    // error. No-op in standalone mode (no options.channel).
    if (options.channel && !runtimeOwnsChannel) options.channel.disconnect();
  }
}

function formatIndicator(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}

function formatV2TradingLine(evaluation: StrategyEvaluatedEvent, values: LivePaperStrategyResult | undefined): string {
  const reason = evaluation.reasons.find((value) => value.startsWith('V2 ')) ?? 'V2_BLOCKED_NOT_READY';
  const decision = reason.match(/^V2\s+([A-Z_]+)/)?.[1] ?? evaluation.finalSignal;
  const proximity = reason.match(/proximity=([0-9.]+)/)?.[1] ?? 'N/A';
  const timestamp = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(evaluation.candleTimestamp);
  if (evaluation.finalSignal === 'BUY_PE') return `[V2 SIGNAL] ${timestamp} BUY_PE RSI=${formatIndicator(values?.rsi14)} proximity=${proximity}% reason=${decision}`;
  return `[V2] ${timestamp} ${decision} RSI=${formatIndicator(values?.rsi14)} proximity=${proximity}%`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}

function istDate(timestamp: Date): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Auto-runs ONLY when this file is itself the process entry point (`npm run test:live-paper-trading`
// / `npm run paper:v1` -- both invoke this file directly). The `paper:v2` wrapper
// (test-live-paper-trading-v2.ts) dynamically imports this module and calls run() itself after
// setting its own environment variables first -- require.main there is the wrapper, not this
// file, so this guard correctly stays silent and does not fire a second, duplicate invocation.
// The combined shared-gateway runtime imports run() directly the same way, supplying its own
// leased channel.
if (require.main === module) {
  void run().catch((error) => {
    console.error('Live paper-trading harness failed to start:', safeMessage(error));
    process.exitCode = 1;
  });
}
