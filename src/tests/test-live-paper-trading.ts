import 'dotenv/config';
import { EventEmitter } from 'events';
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
import { IstSessionEodCoordinator, isAtOrAfterIstSessionEnd } from '../modules/market-data/services/ist-market-session-eod.service';
import { ForwardValidationJournal, normalizeQuote, strategyFingerprint } from '../modules/research-validation';

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
  const parts = getIstParts(timestamp);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
}

/**
 * Upstox protobuf timestamps are epoch milliseconds represented as strings.
 * Existing market adapters expect a Date-parseable string, so this listener
 * re-emits a cloned normalized tick only when that conversion is necessary.
 */
function installEpochTimestampNormalizer(bus: EventEmitter): () => void {
  const listener = (event: unknown): void => {
    if (!event || typeof event !== 'object') return;
    const tick = event as Partial<MarketTickEvent>;
    if (typeof tick.timestamp !== 'string' || !/^\d+$/.test(tick.timestamp)) return;
    const timestamp = new Date(Number(tick.timestamp));
    if (Number.isNaN(timestamp.getTime())) return;
    if (typeof tick.instrumentKey !== 'string') return;
    bus.emit('market.tick', {
      instrumentKey: tick.instrumentKey,
      timestamp: timestamp.toISOString(),
      ltp: tick.ltp,
      lastTradedTime: tick.lastTradedTime,
      lastTradedQuantity: tick.lastTradedQuantity,
      closePrice: tick.closePrice,
    } satisfies MarketTickEvent);
  };
  bus.prependListener('market.tick', listener);
  return () => bus.off('market.tick', listener);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN;
  if (!accessToken) throw new Error('UPSTOX_ACCESS_TOKEN must be set in .env before running the live paper-trading harness.');
  const forwardFingerprint = strategyFingerprint({ strategyId: 'V2_TREND_DOWN_PE', timeframe: '5m', regime: 'TREND_DOWN', ema: ['EMA15', 'EMA35'], proximityPercent: 0.2, rsi: 'RSI14<35', cooldownMinutes: 10, targetPercent: 5, stopPercent: 5, holdMinutes: 15 });
  console.log(`[V2_FORWARD_FINGERPRINT] strategyId=V2_TREND_DOWN_PE fingerprint=${forwardFingerprint}`);

  if (!isLikelyMarketSession(new Date())) {
    console.log('Live paper-trading harness was not started because the current IST time is outside the regular weekday market session (09:15-15:30).');
    console.log('No market data was fabricated. Run `npm run test:live-paper-trading` during the next live market session.');
    return;
  }

  const webSocketClient = new MarketDataWebSocketClient(accessToken);
  const connectionManager = new ConnectionManager(accessToken, webSocketClient);
  const subscriptionManager = new SubscriptionManager(accessToken, connectionManager);
  const protobufDecoder = new ProtobufDecoder();
  const tickProcessor = new TickProcessor();
  const liveCandleBuilder = new LiveCandleBuilderService();
  const liveCandleEventAdapter = new LiveCandleEventAdapterService(liveCandleBuilder, eventBus);

  const orderManager = new PaperOrderManagerService();
  const positionMonitor = new PaperPositionMonitorService(orderManager);
  const paperMarketDataAdapter = new PaperMarketDataAdapterService(positionMonitor, eventBus);
  const latestPremiumByInstrument = new Map<string, number>();
  const latestDepthByInstrument = new Map<string, MarketDepthEvent>();
  const orchestration = new PaperTradingOrchestratorService(
    undefined,
    orderManager,
    subscriptionManager,
    {
      async getObservedPremium(instrumentKey: string): Promise<number> {
        const premium = latestPremiumByInstrument.get(instrumentKey);
        if (!Number.isFinite(premium) || (premium as number) <= 0) {
          throw new Error(`No live option premium is available yet for ${instrumentKey}; wait for its first market tick before creating a paper order.`);
        }
        return premium as number;
      },
    }
  );
  const strategyAdapter = new LivePaperStrategyAdapterService(orchestration, undefined, undefined, () => orderManager.getActiveOrders().length > 0);
  const warmupResult = await new LivePaperFreshWarmupService(
    new HistoricalCandleRepository(),
    strategyAdapter,
  ).warmUp();
  console.log(`[paper.strategy.warmup] source=${warmupResult.currentDaySource} attempts=${warmupResult.intradayBackfillAttempts} lagMinutes=${warmupResult.currentDayLagMinutes ?? 'N/A'} retryReason=${warmupResult.intradayRetryReason ?? 'NONE'} now=${formatIst(warmupResult.currentIstTimestamp)} rowsReturned=${warmupResult.currentDayRowsReturned} firstCurrent=${warmupResult.firstCurrentDayCandle ? formatIst(warmupResult.firstCurrentDayCandle) : 'NONE'} lastCurrent=${warmupResult.lastCurrentDayCandle ? formatIst(warmupResult.lastCurrentDayCandle) : 'NONE'} latest1m=${warmupResult.latestUnderlyingHistoricalCandle ? formatIst(warmupResult.latestUnderlyingHistoricalCandle) : 'NONE'} expected1m=${warmupResult.latestCompletedOneMinuteExpected ? formatIst(warmupResult.latestCompletedOneMinuteExpected) : 'NONE'} latest5m=${warmupResult.latestCompletedFiveMinuteAvailable ? formatIst(warmupResult.latestCompletedFiveMinuteAvailable) : 'NONE'} ageMinutes=${warmupResult.warmupAgeMinutes?.toFixed(2) ?? 'N/A'} missingMinutes=${warmupResult.currentDayMissingMinuteCount} duplicates=${warmupResult.currentDayDuplicateCount} ready=${warmupResult.ready} reason=${warmupResult.freshnessReason}`);
  if (!warmupResult.ready) {
    console.log('[paper.strategy.warmup] Startup blocked: current-day historical warm-up is not fresh. No V1/V2 entries will be evaluated.');
    return;
  }
  const strategyResults = new Map<number, LivePaperStrategyResult>();
  const forwardJournal = new ForwardValidationJournal('V2_TREND_DOWN_PE', forwardFingerprint);
  const forwardDate = istDate(new Date());
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
  const paperRuntimeCandleAdapter = new PaperRuntimeCandleAdapterService(runtime, contractsProvider, eventBus);

  const createdOrderIds = new Set<string>();
  const eodCoordinator = new IstSessionEodCoordinator();
  let lastNiftyTickPrintedAt = 0;
  let shuttingDown = false;
  let requestEod: (() => void) | undefined;
  const cleanupEpochTimestampNormalizer = installEpochTimestampNormalizer(eventBus);

  const onWebSocketMessage = (buffer: Buffer): void => {
    try {
      tickProcessor.process(protobufDecoder.decode(buffer));
    } catch (error) {
      console.error('[market-data decode/process error]', safeMessage(error));
    }
  };
  const onMarketTick = (event: unknown): void => {
    const tick = event as Partial<MarketTickEvent>;
    if (typeof tick.instrumentKey !== 'string' || typeof tick.ltp !== 'number' || !Number.isFinite(tick.ltp) || tick.ltp <= 0 || typeof tick.timestamp !== 'string') return;
    const timestamp = new Date(tick.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;
    if (isAtOrAfterIstSessionEnd(timestamp)) { requestEod?.(); return; }
    latestPremiumByInstrument.set(tick.instrumentKey, tick.ltp);
    if (tick.instrumentKey === niftyInstrumentKey && Date.now() - lastNiftyTickPrintedAt >= tickPrintIntervalMs) {
      lastNiftyTickPrintedAt = Date.now();
      console.log(`[market.tick] NIFTY ${formatIst(timestamp)} | LTP ${tick.ltp.toFixed(2)}`);
    }
  };
  const onCompletedCandle = (event: unknown): void => {
    const candle = event as { instrumentKey?: string; timeframe?: string; candleTime?: Date; open?: number; high?: number; low?: number; close?: number; completed?: boolean };
    if (candle.instrumentKey !== niftyInstrumentKey || candle.timeframe !== '5m' || candle.completed !== true || !(candle.candleTime instanceof Date)) return;
    console.log(`[market.candle.completed] NIFTY 5m ${formatIst(candle.candleTime)} | O ${candle.open?.toFixed(2)} H ${candle.high?.toFixed(2)} L ${candle.low?.toFixed(2)} C ${candle.close?.toFixed(2)}`);
  };
  const onStrategyEvaluated = (event: unknown): void => {
    const evaluation = event as StrategyEvaluatedEvent;
    if (!(evaluation.candleTimestamp instanceof Date)) return;
    const indicatorValues = strategyResults.get(evaluation.candleTimestamp.getTime());
    if (evaluation.paperOrderId) createdOrderIds.add(evaluation.paperOrderId);
    if (evaluation.finalSignal === 'BUY_PE') forwardJournal.append({ recordType: 'SIGNAL', tradingDate: istDate(evaluation.candleTimestamp), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, signalId: `V2-${evaluation.candleTimestamp.getTime()}`, signalTimestampIst: formatIst(evaluation.candleTimestamp), signalTimestampUtc: evaluation.candleTimestamp.toISOString(), underlyingInstrument: niftyInstrumentKey, underlyingClose: evaluation.spotPrice, regime: 'TREND_DOWN', indicators: { ema15: indicatorValues?.ema15 ?? null, ema35: indicatorValues?.ema35 ?? null, rsi14: indicatorValues?.rsi14 ?? null }, signalReason: evaluation.reasons.join('|'), flags: ['FORWARD_EVALUATION_ONLY'] });
    console.log(`[paper.strategy.evaluated] ${formatIst(evaluation.candleTimestamp)} | EMA15 ${formatIndicator(indicatorValues?.ema15)} | EMA35 ${formatIndicator(indicatorValues?.ema35)} | RSI14 ${formatIndicator(indicatorValues?.rsi14)} | raw ${evaluation.rawSignal} | final ${evaluation.finalSignal} | time filter ${evaluation.timeFilterAllowed ? 'ALLOWED' : 'BLOCKED'}${evaluation.paperOrderId ? ` | order ${evaluation.paperOrderId}` : ''}`);
    if (evaluation.reasons.length > 0) console.log(`  reasons: ${evaluation.reasons.join(' | ')}`);
    if (process.env.TRADING_STRATEGY_VERSION === 'V2') console.log(formatV2TradingLine(evaluation, indicatorValues));
  };
  const onOrderAction = (event: unknown): void => {
    const action = event as PaperOrderActionEvent;
    if (typeof action.orderId !== 'string' || !(action.timestamp instanceof Date)) return;
    const recordType = action.action.toUpperCase().includes('EXIT') || action.action.toUpperCase().includes('CLOSE') ? 'EXIT' : 'ENTRY';
    const depth = latestDepthByInstrument.get(action.instrumentKey); const best = depth?.quotes?.[0]; const staleThreshold = Number(process.env.FORWARD_STALE_QUOTE_MS ?? '2000'); const quote = normalizeQuote({ ltp: action.observedPremium, bid: best?.bidPrice, ask: best?.askPrice, bidQuantity: best?.bidQuantity ? Number(best.bidQuantity) : undefined, askQuantity: best?.askQuantity ? Number(best.askQuantity) : undefined, timestamp: depth?.timestamp }, action.timestamp, Number.isFinite(staleThreshold) ? staleThreshold : 2000);
    forwardJournal.append({ recordType, tradingDate: istDate(action.timestamp), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, signalId: action.orderId, signalTimestampIst: formatIst(action.timestamp), selectedOptionInstrument: action.instrumentKey, executableEntryPrice: recordType === 'ENTRY' ? (quote.ask ?? quote.ltp) : undefined, executableExitPrice: recordType === 'EXIT' ? (quote.bid ?? quote.ltp) : undefined, entryPriceSource: recordType === 'ENTRY' ? (quote.ask !== null ? 'ASK' : quote.ltp !== null ? 'ESTIMATED_LTP' : 'UNAVAILABLE') : undefined, exitPriceSource: recordType === 'EXIT' ? (quote.bid !== null ? 'BID' : quote.ltp !== null ? 'ESTIMATED_LTP' : 'UNAVAILABLE') : undefined, executionQuoteQuality: quote.quality, quote, flags: ['FORWARD_EVALUATION_ONLY', ...(quote.quality === 'LTP_ONLY' ? ['LTP_ONLY'] : quote.quality === 'STALE_QUOTE' ? ['STALE_OPTION_QUOTE'] : quote.quality === 'UNAVAILABLE' ? ['EXECUTION_ESTIMATE_UNAVAILABLE'] : [])] });
    console.log(`[paper.order.action] ${action.action} | order ${action.orderId} | ${action.instrumentKey} | premium ${action.observedPremium.toFixed(2)} | ${formatIst(action.timestamp)}`);
  };
  const onMarketDepth = (event: unknown): void => { const depth = event as MarketDepthEvent; if (depth && typeof depth.instrumentKey === 'string') latestDepthByInstrument.set(depth.instrumentKey, depth); };
  const onStrategyError = (event: unknown): void => {
    const error = event as { instrumentKey?: string; candleTimestamp?: Date; message?: string };
    console.error(`[paper.strategy.error] ${error.instrumentKey ?? 'unknown'} | ${error.candleTimestamp instanceof Date ? formatIst(error.candleTimestamp) : 'unknown time'} | ${error.message ?? 'Unknown paper-strategy error.'}`);
  };

  webSocketClient.on('message', onWebSocketMessage);
  eventBus.on('market.tick', onMarketTick);
  eventBus.on('market.depth', onMarketDepth);
  eventBus.on('market.candle.completed', onCompletedCandle);
  eventBus.on('paper.strategy.evaluated', onStrategyEvaluated);
  eventBus.on('paper.order.action', onOrderAction);
  eventBus.on('paper.strategy.error', onStrategyError);

  const printStatus = (): void => {
    const status = runtime.getStatus();
    console.log(`[paper.runtime.status] state=${status.state} warmup=${status.warmupReady} candles=${status.completedCandlesProcessed} noTrade=${status.noTradeEvaluations} filtered=${status.filteredSignals} orders=${status.paperOrdersCreated} active=${status.activeOrderCount} target=${status.targetExits} stop=${status.stopExits} time=${status.timeExits}`);
  };
  const statusTimer = setInterval(printStatus, runtimeStatusIntervalMs);
  statusTimer.unref();

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    forwardJournal.append({ recordType: 'SUMMARY', tradingDate: istDate(new Date()), strategyId: 'V2_TREND_DOWN_PE', fingerprint: forwardFingerprint, sessionCompleted: true, eodReason: reason, status: 'COMPLETED' });
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

    webSocketClient.off('message', onWebSocketMessage);
    eventBus.off('market.tick', onMarketTick);
    eventBus.off('market.depth', onMarketDepth);
    eventBus.off('market.candle.completed', onCompletedCandle);
    eventBus.off('paper.strategy.evaluated', onStrategyEvaluated);
    eventBus.off('paper.order.action', onOrderAction);
    eventBus.off('paper.strategy.error', onStrategyError);
    cleanupEpochTimestampNormalizer();
  };

  const finishEod = async (): Promise<void> => {
    await eodCoordinator.runOnce(new Date(), async () => {
      // A candle completing exactly at 15:30 is observable, but cannot create a new entry.
      paperRuntimeCandleAdapter.stop();
      liveCandleEventAdapter.finishSession(niftyInstrumentKey);
      const eodAt = new Date();
      const actions = positionMonitor.closeAtSessionEnd(eodAt, (instrumentKey, entryPremium) => latestPremiumByInstrument.get(instrumentKey) ?? entryPremium);
      actions.forEach((action) => {
        eventBus.emit('paper.order.action', action);
        console.log(`[V2_EOD_EXIT] order=${action.orderId} reason=TIME_EXIT premium=${action.observedPremium.toFixed(2)} timestamp=${formatIst(action.timestamp)}`);
      });
      await shutdown('EOD_15_30_IST');
      const status = runtime.getStatus();
      console.log(`[V2_EOD_SUMMARY]\ndate=${istDate(eodAt)}\nstrategyId=${process.env.PAPER_STRATEGY_ID ?? 'V2_TREND_DOWN_PE'}\ncompleted5m=${status.completedCandlesProcessed}\nnoTrade=${status.noTradeEvaluations}\nsignals=${status.paperOrdersCreated}\norders=${status.paperOrdersCreated}\ntargetExits=${status.targetExits}\nstopExits=${status.stopExits}\ntimeExits=${status.timeExits}\nactivePositions=${status.activeOrderCount}\nstatus=COMPLETED`);
    });
  };
  requestEod = () => { void finishEod(); };
  const eodTimer = eodCoordinator.schedule(finishEod);

  process.once('SIGINT', () => { clearTimeout(eodTimer); void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { clearTimeout(eodTimer); void shutdown('SIGTERM'); });

  liveCandleEventAdapter.start();
  runtime.start(); // Starts PaperMarketDataAdapterService as part of the runtime lifecycle.
  paperRuntimeCandleAdapter.start();
  await subscriptionManager.subscribe(niftyInstrumentKey, MarketDataSubscriptionMode.FULL);

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
