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
import {
  NseSessionEodCoordinator,
  isAtOrAfterNseSessionClose,
  isWithinNseSession,
} from '../modules/market-data/services/nse-session-calendar.service';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { LiveGenerationCacheScope } from '../modules/market-data/utils/live-generation-cache';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import LivePaperFreshWarmupService from '../modules/paper-trading/services/live-paper-fresh-warmup.service';
import { PaperStrategyWarmupTarget } from '../modules/paper-trading/dto/paper-strategy-warmup.dto';
import MarketDataHealthMonitorService from '../modules/market-data/services/market-data-health-monitor.service';
import V8BullishReclaimShadowEvaluatorService, {
  isV8CompletedUnderlyingCandleEvent,
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
    return;
  }
  const evaluator = new V8BullishReclaimShadowEvaluatorService(frozen.candidate.config);
  evaluator.seedHistoricalOneMinute(warmup.seededOneMinuteCandles);
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
  const websocket = new MarketDataWebSocketClient(token),
    connection = new ConnectionManager(token, websocket),
    subscriptions = new SubscriptionManager(token, connection),
    decoder = new ProtobufDecoder(),
    ticks = new TickProcessor(),
    candles = new LiveCandleEventAdapterService(new LiveCandleBuilderService(), eventBus, () => connection.getGenerationId()),
    tracker = new V8ShadowObservationTracker(frozen.candidate.policy),
    contracts = new CurrentNiftyCeContracts(),
    counters = new V8ShadowRuntimeCounters();
  let closing = false,
    eod = false;
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
      health.noteNiftyTick(t.generationId);
      recovery.handleLiveTick(at, t.generationId);
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
  };
  type RecoveryWarmup = Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryWarmup>({
    backfill: async () => {
      const r = await new LivePaperFreshWarmupService(
        new HistoricalCandleRepository(),
        new WarmupTarget(),
      ).warmUp();
      return {
        ready: r.ready,
        reason: r.freshnessReason,
        missingMinutes: r.currentDayMissingMinuteCount,
        duplicateMinutes: r.currentDayDuplicateCount,
        recoveryData: r,
      };
    },
    onRecovered: (_generationId,recoveryWarmup) => { if (recoveryWarmup?.ready) evaluator.recoverHistoricalOneMinute(recoveryWarmup.seededOneMinuteCandles); candles.start(); return undefined; },
    onEvent: (type, details) => journal.appendEvent(date, type, [type], details),
  });
  const health = new MarketDataHealthMonitorService(connection, {
    onStall: (s) => {
      candles.stop();
      recovery.handleUnexpectedDisconnect({
        generationId: s.generationId,
        reason: 'STALL',
        lastMessageAgeMs: s.lastRawMessageAgeMs,
        lastTickAgeMs: s.lastNiftyTickAgeMs,
      });
      journal.appendEvent(date, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], s);
    },
  });
  const emitStatus = () => {
    const value = counters.snapshot();
    console.log(
      `[V8_SHADOW_STATUS] completed2m=${value.completed2m} signals=${value.signals} open=${tracker.getOpenCount()} closed=${value.closed}`,
    );
  };
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    eod = true;
    if (statusTimer) clearInterval(statusTimer);
    health.stop();
    recovery.stop();
    const at = new Date();
    tracker.closeAtEod(at).forEach(writeExit);
    journal.append({
      recordType: 'SUMMARY',
      tradingDate: date,
      strategyId: STRATEGY,
      fingerprint,
      sessionCompleted: true,
      eodReason: reason,
      signals,
      resolvedTrades: 0,
      unresolvedTrades: tracker.getOpenCount(),
      status: 'COMPLETED',
      flags: ['SHADOW_ONLY', 'ZERO_ORDER'],
    });
    journal.appendEvent(date, 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason });
    candles.stop();
    eventBus.off('market.tick', handleTick);
    eventBus.off('market.depth', handleDepth);
    eventBus.off('market.candle.completed', handleCandle);
    await subscriptions.unsubscribeMany(
      subscriptions.getSubscriptions().map((s) => s.instrumentKey),
    );
    connection.disconnect();
    const value = counters.snapshot();
    console.log(
      `[V8_EOD_SUMMARY] date=${date} completed2m=${value.completed2m} signals=${value.signals} closed=${value.closed} open=${tracker.getOpenCount()} status=COMPLETED`,
    );
  };
  connection.on('unexpectedDisconnect', (d: any) => {
    candles.stop();
    recovery.handleUnexpectedDisconnect(d);
    journal.appendEvent(date, 'RECONNECT_STARTED', ['WEBSOCKET_DISCONNECTED']);
  });
  connection.on('reconnected', (d: any) => {
    recovery.handleReconnected(d);
    journal.appendEvent(date, 'RECONNECT_SUCCEEDED', ['WEBSOCKET_RECONNECTED']);
  });
  connection.on('reconnectFailed', () => {
    recovery.fault('RECONNECT_FAILED');
    journal.appendEvent(date, 'RECONNECT_FAILED', [
      'RECONNECT_FAILED',
      'DATA_GAP_UNRECOVERABLE',
      'CRITICAL_DATA_QUALITY',
    ]);
    void host?.fault(new Error('RECONNECT_FAILED'));
  });
  host = new StrategyHostLifecycle({
    strategyId: STRATEGY,
    runtimeId: 'shadow:v8:reclaim',
    eodCoordinator,
    hooks: { warmup: () => undefined, onEod: () => shutdown('EOD'), onShutdown: () => shutdown('SIGINT'), onFault: () => shutdown('FAULTED') },
    log: (value) => console.log(`[STRATEGY_HOST_STATE] strategyId=${value.strategyId} runtimeId=${value.runtimeId} previous=${value.previous} state=${value.state} reason=${value.reason}`),
  });
  recovery.on('stateChanged', (state) => {
    if (state === 'DEGRADED') void host?.degrade('MARKET_DATA_DEGRADED');
    if (state === 'READY') {
      if (health.confirmRecoveryReady(recovery.getGenerationId())) void host?.recovered('MARKET_DATA_READY');
      else connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');
    }
    if (state === 'FAULTED') connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_COORDINATOR_FAULTED');
  });
  await host.start();
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
  eventBus.on('market.candle.completed', handleCandle);
  candles.start();
  health.start();
  statusTimer = setInterval(emitStatus, 60_000);
  statusTimer.unref();
  await subscriptions.subscribe(NIFTY, MarketDataSubscriptionMode.FULL);
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
