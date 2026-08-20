import 'dotenv/config';
import eventBus from '../core/events';
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
import { NseSessionEodCoordinator, isAtOrAfterNseSessionClose, isWithinNseSession } from '../modules/market-data/services/nse-session-calendar.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import MarketDataHealthMonitorService from '../modules/market-data/services/market-data-health-monitor.service';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import { cacheCurrentLiveDepth, getCurrentLiveDepth } from '../modules/market-data/utils/live-depth-cache';
import { cacheCurrentLiveInstrumentValue, getCurrentLiveInstrumentValue, LiveInstrumentValue } from '../modules/market-data/utils/live-instrument-value-cache';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { ForwardValidationJournal, normalizeQuote, strategyFingerprint } from '../modules/research-validation';
import RuntimeRiskGateService from '../modules/risk/runtime-risk-gate.service';
import PaperEntryQuoteWaiterService from '../modules/paper-trading/services/paper-entry-quote-waiter.service';
import PaperPortfolioService, { InMemoryPaperPortfolioRepository } from '../modules/paper-trading/services/paper-portfolio.service';
import PaperFillModelService from '../modules/paper-trading/services/paper-fill-model.service';
import PrismaExecutionRepository from '../modules/execution/prisma-execution.repository';
import { PaperOrderStatus } from '../modules/paper-trading/types/paper-trading.types';

const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';
const tickPrintIntervalMs = 30_000;
const runtimeStatusIntervalMs = 60_000;

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

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN;
  if (!accessToken) throw new Error('UPSTOX_ACCESS_TOKEN must be set in .env before running the live paper-trading harness.');
  const forwardFingerprint = strategyFingerprint({ strategyId: 'V2_TREND_DOWN_PE', timeframe: '5m', regime: 'TREND_DOWN', ema: ['EMA15', 'EMA35'], proximityPercent: 0.2, rsi: 'RSI14<35', cooldownMinutes: 10, targetPercent: 5, stopPercent: 5, holdMinutes: 15 });
  console.log(`[V2_FORWARD_FINGERPRINT] strategyId=V2_TREND_DOWN_PE fingerprint=${forwardFingerprint}`);

  if (!isLikelyMarketSession(new Date())) {
    console.log('Live paper-trading harness was not started because the current IST time is outside the configured NSE derivatives session.');
    console.log('No market data was fabricated. Run `npm run test:live-paper-trading` during the next live market session.');
    return;
  }

  const webSocketClient = new MarketDataWebSocketClient(accessToken);
  const connectionManager = new ConnectionManager(accessToken, webSocketClient);
  const subscriptionManager = new SubscriptionManager(accessToken, connectionManager);
  const protobufDecoder = new ProtobufDecoder();
  const tickProcessor = new TickProcessor();
  const liveCandleBuilder = new LiveCandleBuilderService();
  const liveCandleEventAdapter = new LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connectionManager.getGenerationId());

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
    eventBus,
    portfolio,
    2_000,
    () => new Date(),
    () => connectionManager.getGenerationId(),
  );
  const latestPremiumByInstrument = new Map<string, LiveInstrumentValue<number>>();
  const latestDepthByInstrument = new Map<string, MarketDepthEvent>();
  let recovery: MarketDataRecoveryCoordinatorService | undefined;
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
  const strategyAdapter = new LivePaperStrategyAdapterService(orchestration, undefined, undefined, () => orderManager.getActiveOrders().length > 0);
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
  const runtime = new PaperTradingRuntimeService(instrumentedStrategyAdapter, paperMarketDataAdapter, orderManager, eventBus);
  const contractsProvider = new CurrentNiftyOptionContractsProvider(new InstrumentRepository());
  const hostGatedRuntime = {
    getState: (): PaperTradingRuntimeState => host?.canEvaluate() ? runtime.getState() : PaperTradingRuntimeState.STOPPED,
    processCompletedCandle: (input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> => runtime.processCompletedCandle(input),
  };
  const paperRuntimeCandleAdapter = new PaperRuntimeCandleAdapterService(hostGatedRuntime, contractsProvider, eventBus);

  const createdOrderIds = new Set<string>();
  const eodCoordinator = new NseSessionEodCoordinator();
  let lastNiftyTickPrintedAt = 0;
  let shuttingDown = false;
  let eodRequested = false;
  let requestedShutdownReason = 'SESSION_END';
  let latestRecoveryWarmup: Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>> | undefined;
  const recoveryWarmupTarget = { count: 0, seedHistoricalCandles(candles: readonly import('../modules/indicators/types').Candle[]): void { this.count = candles.length; }, isWarmupReady(): boolean { return this.count >= 36; } };

  const performRecoveryBackfill = async (): Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number }> => {
    latestRecoveryWarmup = await new LivePaperFreshWarmupService(new HistoricalCandleRepository(), recoveryWarmupTarget).warmUp();
    return {
      ready: latestRecoveryWarmup.ready,
      reason: latestRecoveryWarmup.freshnessReason,
      missingMinutes: latestRecoveryWarmup.currentDayMissingMinuteCount,
      duplicateMinutes: latestRecoveryWarmup.currentDayDuplicateCount,
    };
  };
  const applyRecoveredHistoricalCandles = (): void => {
    if (!latestRecoveryWarmup) return;
    const completed = new CandleTimeframeAggregatorService().aggregate(latestRecoveryWarmup.seededOneMinuteCandles, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
    strategyAdapter.recoverHistoricalCandles(completed);
    liveCandleBuilder.reset(niftyInstrumentKey);
    liveCandleEventAdapter.start();
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
    if (state === 'READY' && !shuttingDown) {
      paperMarketDataAdapter.setMarketDataAvailable(true);
      paperRuntimeCandleAdapter.start();
      void host?.recovered('MARKET_DATA_READY');
    }
  };
  recovery = new MarketDataRecoveryCoordinatorService({
    backfill: performRecoveryBackfill,
    onRecovered: applyRecoveredHistoricalCandles,
    onEvent: handleRecoveryEvent,
  });
  const health = new MarketDataHealthMonitorService(connectionManager, {
    onStall: (snapshot) => {
      recovery.handleUnexpectedDisconnect({ generationId: snapshot.generationId, reason: 'STALL', lastMessageAgeMs: snapshot.lastRawMessageAgeMs, lastTickAgeMs: snapshot.lastNiftyTickAgeMs });
      paperMarketDataAdapter.setMarketDataAvailable(false); paperRuntimeCandleAdapter.stop(); liveCandleEventAdapter.stop();
      forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], { ...snapshot });
    },
  });
  recovery.on('stateChanged', handleRecoveryState);

  function handleWebSocketMessage(buffer: Buffer, details: { generationId: number }): void {
    try {
      tickProcessor.process(protobufDecoder.decode(buffer), details.generationId);
    } catch (error) {
      console.error('[market-data decode/process error]', safeMessage(error));
    }
  }
  function handleMarketTick(event: unknown): void {
    const tick = event as Partial<MarketTickEvent>;
    if (!isCurrentLiveGeneration(tick.generationId, connectionManager.getGenerationId())) return;
    if (typeof tick.instrumentKey !== 'string' || typeof tick.ltp !== 'number' || !Number.isFinite(tick.ltp) || tick.ltp <= 0 || typeof tick.timestamp !== 'string') return;
    const timestamp = new Date(tick.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;
    if (isAtOrAfterNseSessionClose(timestamp)) { eodRequested = true; eodRequestedForRisk = true; paperRuntimeCandleAdapter.stop(); void host?.eod('MARKET_EOD'); return; }
    health.noteValidMarketEvent(tick.generationId);
    if (tick.instrumentKey === niftyInstrumentKey) { health.noteNiftyTick(tick.generationId); recovery!.handleLiveTick(timestamp, tick.generationId); }
    cacheCurrentLiveInstrumentValue(latestPremiumByInstrument, tick.instrumentKey, tick.ltp, tick.generationId, connectionManager.getGenerationId());
    if (tick.instrumentKey === niftyInstrumentKey && Date.now() - lastNiftyTickPrintedAt >= tickPrintIntervalMs) {
      lastNiftyTickPrintedAt = Date.now();
      console.log(`[market.tick] NIFTY ${formatIst(timestamp)} | LTP ${tick.ltp.toFixed(2)}`);
    }
  }
  function handleCompletedFiveMinuteCandle(event: unknown): void {
    const candle = event as { instrumentKey?: string; timeframe?: string; candleTime?: Date; open?: number; high?: number; low?: number; close?: number; completed?: boolean };
    if (eodRequested) return;
    if (candle.instrumentKey !== niftyInstrumentKey || candle.timeframe !== '5m' || candle.completed !== true || !(candle.candleTime instanceof Date)) return;
    console.log(`[market.candle.completed] NIFTY 5m ${formatIst(candle.candleTime)} | O ${candle.open?.toFixed(2)} H ${candle.high?.toFixed(2)} L ${candle.low?.toFixed(2)} C ${candle.close?.toFixed(2)}`);
  }
  function handleStrategyEvaluated(event: unknown): void {
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
    if (process.env.TRADING_STRATEGY_VERSION === 'V2') console.log(formatV2TradingLine(evaluation, indicatorValues));
  }
  function handlePaperOrderAction(event: unknown): void {
    const action = event as PaperOrderActionEvent;
    if (typeof action.orderId !== 'string' || !(action.timestamp instanceof Date)) return;
    const settledOrder = orderManager.getById(action.orderId); if (settledOrder?.exit) riskGate.recordClosedOrder(istDate(action.timestamp), action.orderId);
    const recordType = action.action.toUpperCase().includes('EXIT') || action.action.toUpperCase().includes('CLOSE') ? 'EXIT' : 'ENTRY';
    const depth = getCurrentLiveDepth(latestDepthByInstrument, action.instrumentKey, connectionManager.getGenerationId()); const best = depth?.quotes?.[0]; const staleThreshold = Number(process.env.FORWARD_STALE_QUOTE_MS ?? '2000'); const quote = normalizeQuote({ ltp: action.observedPremium, bid: best?.bidPrice, ask: best?.askPrice, bidQuantity: best?.bidQuantity ? Number(best.bidQuantity) : undefined, askQuantity: best?.askQuantity ? Number(best.askQuantity) : undefined, timestamp: depth?.timestamp }, action.timestamp, Number.isFinite(staleThreshold) ? staleThreshold : 2000);
    const fill = recordType === 'ENTRY' ? settledOrder?.entry.executionFill : settledOrder?.exit?.executionFill;
    const entryFill = settledOrder?.entry.executionFill; const theoreticalReturn = settledOrder?.exit ? (settledOrder.exit.observedExitPremium - settledOrder.entry.observedEntryPremium) / settledOrder.entry.observedEntryPremium * 100 : null; const executableReturn = settledOrder?.exit && entryFill && fill ? (fill.averageFillPrice - entryFill.averageFillPrice) / entryFill.averageFillPrice * 100 : null;
    forwardJournal.append({ recordType, tradingDate: istDate(action.timestamp), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, signalId: action.orderId, signalTimestampIst: formatIst(action.timestamp), selectedOptionInstrument: action.instrumentKey, theoreticalEntryPrice: recordType === 'ENTRY' ? settledOrder?.entry.observedEntryPremium ?? action.observedPremium : undefined, theoreticalExitPrice: recordType === 'EXIT' ? action.observedPremium : undefined, executableEntryPrice: recordType === 'ENTRY' ? (fill?.averageFillPrice ?? null) : undefined, executableExitPrice: recordType === 'EXIT' ? (fill?.averageFillPrice ?? null) : undefined, entryPriceSource: recordType === 'ENTRY' ? (fill ? 'ASK' : 'UNAVAILABLE') : undefined, exitPriceSource: recordType === 'EXIT' ? (fill ? 'BID' : 'UNAVAILABLE') : undefined, theoreticalReturn:recordType === 'EXIT' ? theoreticalReturn : undefined, executableEstimatedReturn:recordType === 'EXIT' ? executableReturn : undefined, totalEstimatedSlippage:recordType === 'EXIT' && entryFill && fill ? (entryFill.totalExecutionSlippage + fill.totalExecutionSlippage) : undefined, totalExecutionFrictionPercent:recordType === 'EXIT' && theoreticalReturn !== null && executableReturn !== null ? theoreticalReturn - executableReturn : undefined, executionQuoteQuality: quote.quality, quote, indicators: { fillStatus: fill?.status ?? 'UNAVAILABLE', fillQuality: fill?.fillQuality ?? 'UNAVAILABLE', requestedQuantity: fill?.requestedQuantity ?? null, filledQuantity: fill?.filledQuantity ?? null, quotedBestPrice: fill?.quotedBestPrice ?? null, totalExecutionSlippage: fill?.totalExecutionSlippage ?? null, slippagePercent: fill?.slippagePercent ?? null }, flags: ['FORWARD_EVALUATION_ONLY', ...(fill ? [] : ['EXECUTION_ESTIMATE_UNAVAILABLE']), ...(quote.quality === 'STALE_QUOTE' ? ['STALE_OPTION_QUOTE'] : [])] });
    console.log(`[paper.order.action] ${action.action} | order ${action.orderId} | ${action.instrumentKey} | premium ${action.observedPremium.toFixed(2)} | ${formatIst(action.timestamp)}`);
  }
  function handleMarketDepth(event: unknown): void {
    cacheCurrentLiveDepth(latestDepthByInstrument, event, connectionManager.getGenerationId());
  }
  function handleStrategyError(event: unknown): void {
    const error = event as { instrumentKey?: string; candleTimestamp?: Date; message?: string };
    console.error(`[paper.strategy.error] ${error.instrumentKey ?? 'unknown'} | ${error.candleTimestamp instanceof Date ? formatIst(error.candleTimestamp) : 'unknown time'} | ${error.message ?? 'Unknown paper-strategy error.'}`);
  }

  connectionManager.on('message', handleWebSocketMessage);
  eventBus.on('market.tick', handleMarketTick);
  eventBus.on('market.depth', handleMarketDepth);
  eventBus.on('market.candle.completed', handleCompletedFiveMinuteCandle);
  eventBus.on('paper.strategy.evaluated', handleStrategyEvaluated);
  eventBus.on('paper.order.action', handlePaperOrderAction);
  eventBus.on('paper.strategy.error', handleStrategyError);

  const printStatus = (): void => {
    const status = runtime.getStatus();
    console.log(`[paper.runtime.status] state=${status.state} warmup=${status.warmupReady} candles=${status.completedCandlesProcessed} noTrade=${status.noTradeEvaluations} filtered=${status.filteredSignals} orders=${status.paperOrdersCreated} active=${status.activeOrderCount} target=${status.targetExits} stop=${status.stopExits} time=${status.timeExits}`);
  };
  const statusTimer = setInterval(printStatus, runtimeStatusIntervalMs);
  statusTimer.unref();

  const drainPendingDurableExit = async (): Promise<boolean> => {
    return paperMarketDataAdapter.drainDurableExitQueue(Number(process.env.PAPER_EXECUTION_SHUTDOWN_WAIT_MS ?? 5_000));
  };

  const finalizeShutdown = (reason: string, durableExitDrained: boolean): void => {
    if (!durableExitDrained) {
      riskGate.transition('HALTED');
      forwardJournal.appendEvent(istDate(new Date()), 'EXECUTION_RECONCILIATION_REQUIRED', ['EXECUTION_RECONCILIATION_REQUIRED'], { reason: 'EXIT_TRANSACTION_DRAIN_TIMEOUT' });
      console.error('[PAPER_EXECUTION_DURABILITY_FAILURE] pending durable exit transaction did not settle before shutdown timeout; reconciliation is required.');
    }
    const reconciliationRequired = orderManager.getActiveOrders().some((order) => order.status === PaperOrderStatus.RECONCILIATION_REQUIRED || order.status === PaperOrderStatus.EXIT_PENDING);
    const shutdownStatus = durableExitDrained && !reconciliationRequired ? 'COMPLETED' : 'RECONCILIATION_REQUIRED';
    const portfolioSnapshot = portfolio.logSessionSummary(istDate(new Date()));
    forwardJournal.append({ recordType: 'SUMMARY', tradingDate: istDate(new Date()), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, sessionCompleted: shutdownStatus === 'COMPLETED', eodReason: reason, status: shutdownStatus, indicators: { portfolioOpenCount: portfolioSnapshot?.openPositionCount ?? null, portfolioClosedCount: portfolioSnapshot?.closedPositionCount ?? null, portfolioRealizedPnl: portfolioSnapshot?.totalRealizedPnl ?? null } });
    if (shutdownStatus === 'COMPLETED') forwardJournal.appendEvent(istDate(new Date()), 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason });
    console.log(`\nGraceful shutdown requested (${reason}).`);
    clearInterval(statusTimer);

    paperRuntimeCandleAdapter.stop();
    const stopResult = runtime.stop(); // Runtime stops PaperMarketDataAdapterService.
    liveCandleEventAdapter.stop();
    paperMarketDataAdapter.stop(); // Explicit idempotent stop for standalone cleanup.
    subscriptionManager.unsubscribeMany(subscriptionManager.getSubscriptions().map((subscription) => subscription.instrumentKey));
    connectionManager.disconnect();

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
    eventBus.off('market.tick', handleMarketTick);
    eventBus.off('market.depth', handleMarketDepth);
    eventBus.off('market.candle.completed', handleCompletedFiveMinuteCandle);
    eventBus.off('paper.strategy.evaluated', handleStrategyEvaluated);
    eventBus.off('paper.order.action', handlePaperOrderAction);
    eventBus.off('paper.strategy.error', handleStrategyError);
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true; eodRequestedForRisk = true; riskGate.transition('HALTED');
    health.stop(); recovery.stop();
    const durableExitDrained = await drainPendingDurableExit();
    finalizeShutdown(reason, durableExitDrained);
  };

  const performDurableEodExit = async (): Promise<void> => {
    // StrategyHostLifecycle owns the exactly-once EOD latch. Its wall-clock
    // path is already inside the shared coordinator callback; re-entering
    // runOnce here would make that callback wait on itself.
    eodRequested = true;
    paperRuntimeCandleAdapter.stop();
    liveCandleEventAdapter.finishSession(niftyInstrumentKey);
    const eodAt = new Date();
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
      eventBus.emit('paper.order.action', action);
      console.log(`[V2_EOD_EXIT] order=${action.orderId} reason=TIME_EXIT premium=${action.observedPremium.toFixed(2)} timestamp=${formatIst(action.timestamp)}`);
    });
    await shutdown('EOD_NSE_SESSION_CLOSE');
    const status = runtime.getStatus();
    const eodStatus = orderManager.getActiveOrders().some((order) => order.status === PaperOrderStatus.RECONCILIATION_REQUIRED || order.status === PaperOrderStatus.EXIT_PENDING) ? 'RECONCILIATION_REQUIRED' : 'COMPLETED';
    console.log(`[V2_EOD_SUMMARY]\ndate=${istDate(eodAt)}\nstrategyId=${process.env.PAPER_STRATEGY_ID ?? 'V2_TREND_DOWN_PE'}\ncompleted5m=${status.completedCandlesProcessed}\nnoTrade=${status.noTradeEvaluations}\nsignals=${status.paperOrdersCreated}\norders=${status.paperOrdersCreated}\ntargetExits=${status.targetExits}\nstopExits=${status.stopExits}\ntimeExits=${status.timeExits}\nactivePositions=${status.activeOrderCount}\nstatus=${eodStatus}`);
  };
  connectionManager.on('unexpectedDisconnect', (details: { code?: number; reason?: string; generationId?: number; disconnectClean?: boolean }) => {
    recovery.handleUnexpectedDisconnect(details);
    paperMarketDataAdapter.setMarketDataAvailable(false);
    paperRuntimeCandleAdapter.stop(); liveCandleEventAdapter.stop();
    forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_DISCONNECTED', ['WEBSOCKET_DISCONNECTED'], { code: details.code ?? null, reason: details.reason ?? null });
  });
  connectionManager.on('reconnected', (details: { downtimeMs?: number; generationId?: number }) => {
    forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_RECONNECTED', ['WEBSOCKET_RECONNECTED'], { downtimeMs: details.downtimeMs ?? null });
    recovery.handleReconnected(details);
  });
  connectionManager.on('reconnectFailed', (details: { attempts?: number; downtimeMs?: number }) => {
    forwardJournal.appendEvent(forwardDate, 'RECONNECT_FAILED', ['RECONNECT_FAILED', 'DATA_GAP', 'CRITICAL_DATA_QUALITY'], { attempts: details.attempts ?? null, downtimeMs: details.downtimeMs ?? null });
    recovery.fault('RECONNECT_FAILED');
    void host?.fault(new Error('RECONNECT_FAILED'));
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
      onEod: performDurableEodExit,
      onShutdown: (): Promise<void> => shutdown(requestedShutdownReason),
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
  console.log('Live paper-trading harness is RUNNING. It is subscribed to NIFTY only and will subscribe to an option only after an actionable signal. Press Ctrl+C to stop.');
  printStatus();
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

void run().catch((error) => {
  console.error('Live paper-trading harness failed to start:', safeMessage(error));
  process.exitCode = 1;
});
