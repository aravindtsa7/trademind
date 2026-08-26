import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import eventBus from '../core/events';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import { Candle } from '../modules/indicators/types';
import MarketDataWebSocketClient from '../modules/market-data/client/websocket.client';
import ConnectionManager from '../modules/market-data/managers/connection.manager';
import SubscriptionManager, { MarketDataSubscriptionMode } from '../modules/market-data/managers/subscription.manager';
import ProtobufDecoder from '../modules/market-data/protobuf/protobuf.decoder';
import TickProcessor, { MarketTickEvent } from '../modules/market-data/processors/tick.processor';
import LiveCandleBuilderService from '../modules/market-data/services/live-candle-builder.service';
import LiveCandleEventAdapterService from '../modules/market-data/services/live-candle-event-adapter.service';
import V4NiftyMomentumShadowEvaluatorService, { v4MomentumShadowConfig, v4MomentumShadowPolicy, v4MomentumShadowStrategyId } from '../modules/adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service';
import V4MomentumShadowTrackerService, { assertV4ShadowRuntimeGuards, V4ShadowTradeJournalEntry } from '../modules/adaptive-intraday/services/v4-momentum-shadow-tracker.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract } from '../modules/options/types';
import LivePaperFreshWarmupService from '../modules/paper-trading/services/live-paper-fresh-warmup.service';
import { PaperStrategyWarmupTarget } from '../modules/paper-trading/dto/paper-strategy-warmup.dto';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { NseSessionEodCoordinator, OneShotWallClockTrigger, isAtOrAfterNseSessionClose, isWithinNseSession } from '../modules/market-data/services/nse-session-calendar.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import { nifty1mSourceCompletionBoundary } from '../modules/historical-candles/utils/historical-session-completeness.util';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
import { StrategyTerminalOutcomeArbiter } from '../modules/market-data/services/strategy-terminal-outcome-arbiter.service';
import { SourceBoundaryEvaluationCoverageTracker } from '../modules/market-data/services/source-boundary-evaluation-coverage';
import { isCurrentLiveGeneration } from '../modules/market-data/utils/live-generation';
import MarketDataHealthMonitorService from '../modules/market-data/services/market-data-health-monitor.service';
import { ForwardValidationJournal, resolveSessionOutcome, strategyFingerprint } from '../modules/research-validation';

const nifty = 'NSE_INDEX|Nifty 50';
const journalPath = resolve(process.cwd(), process.env.V4_SHADOW_JOURNAL_PATH ?? 'artifacts/v4-nifty-momentum-shadow.jsonl');
const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' });

/** Validates at the environment/config boundary, naming the offending variable, matching the style already used by ConnectionManager/MarketDataHealthMonitorService. */
function positiveTimeoutMs(name: string, environmentValue: string | undefined, fallback: number): number {
  const value = environmentValue === undefined ? fallback : Number(environmentValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}

class ShadowWarmupTarget implements PaperStrategyWarmupTarget {
  private count = 0;
  seedHistoricalCandles(candles: readonly Candle[]): void { this.count = candles.length; }
  isWarmupReady(): boolean { return this.count >= 36; }
}
class CurrentNiftyPeContracts {
  constructor(private readonly instruments = new InstrumentRepository(), private readonly selector = new OptionContractSelectorService()) {}
  async resolve(spotPrice: number, timestamp: Date): Promise<OptionContract> {
    const contracts = (await this.instruments.findActive()).filter((instrument) => isNifty(instrument.underlyingSymbol) && instrument.instrumentType === 'PE').map((instrument): OptionContract => ({ instrumentKey: instrument.instrumentKey, tradingSymbol: instrument.tradingSymbol, underlying: 'NIFTY 50', strikePrice: Number(instrument.strikePrice), expiry: new Date(instrument.expiry.getTime()), optionType: 'PE', exchange: instrument.exchange, segment: instrument.segment, lotSize: instrument.lotSize }));
    if (!contracts.length) throw new Error('No active NIFTY PE contracts are available for shadow observation.');
    const chosen = this.selector.select({ underlying: 'NIFTY 50', spotPrice, signal: StrategySignal.BUY_PE, timestamp, contracts });
    const contract = contracts.find((value) => value.instrumentKey === chosen.instrumentKey); if (!contract) throw new Error('Live NIFTY PE selection returned an unknown contract.');
    return contract;
  }
}

async function run(): Promise<void> {
  assertV4ShadowRuntimeGuards();
  const forwardFingerprint = strategyFingerprint({ strategyId: v4MomentumShadowStrategyId, timeframe: '3m', compressionBars: 3, compressionRangeAtr: 2, bodyAtr: 1, breakoutAtr: 0.1, regime: 'TREND_DOWN', cooldownMinutes: 5, targetPercent: 5, stopPercent: 5, holdMinutes: 15, shadowOnly: true });
  console.log(`[V4_FORWARD_FINGERPRINT] strategyId=${v4MomentumShadowStrategyId} fingerprint=${forwardFingerprint}`);
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is required for shadow market-data observation.');
  if (!isWithinNseSession(new Date())) { console.log('[V4_STARTUP] Shadow runtime was not started outside the configured NSE derivatives session. No data was fabricated.'); return; }

  const liveConstructionAlignmentMinutes = 15;
  const alignedHandoffWaitMs = liveConstructionAlignmentMinutes * 60_000;
  const startupReadyTimeoutMs = positiveTimeoutMs('MARKET_DATA_STARTUP_READY_TIMEOUT_MS', process.env.MARKET_DATA_STARTUP_READY_TIMEOUT_MS, 45_000) + alignedHandoffWaitMs;
  const healthGraceMs = positiveTimeoutMs('MARKET_DATA_HEALTH_GRACE_MS', process.env.MARKET_DATA_HEALTH_GRACE_MS, 45_000) + alignedHandoffWaitMs;
  const reconnectDurationMs = positiveTimeoutMs('MARKET_DATA_MAX_RECONNECT_DURATION_MS', process.env.MARKET_DATA_MAX_RECONNECT_DURATION_MS, 60_000) + alignedHandoffWaitMs;

  const evaluator = new V4NiftyMomentumShadowEvaluatorService();
  const forwardJournal = new ForwardValidationJournal(v4MomentumShadowStrategyId, forwardFingerprint);
  const warmup = await new LivePaperFreshWarmupService(new HistoricalCandleRepository(), new ShadowWarmupTarget()).warmUp();
  console.log(`[V4_WARMUP_READY] source=${warmup.currentDaySource} attempts=${warmup.intradayBackfillAttempts} lagMinutes=${warmup.currentDayLagMinutes ?? 'N/A'} retryReason=${warmup.intradayRetryReason ?? 'NONE'} now=${format(warmup.currentIstTimestamp)} rowsReturned=${warmup.currentDayRowsReturned} firstCurrent=${warmup.firstCurrentDayCandle ? format(warmup.firstCurrentDayCandle) : 'NONE'} lastCurrent=${warmup.lastCurrentDayCandle ? format(warmup.lastCurrentDayCandle) : 'NONE'} latest1m=${warmup.latestUnderlyingHistoricalCandle ? format(warmup.latestUnderlyingHistoricalCandle) : 'NONE'} expected1m=${warmup.latestCompletedOneMinuteExpected ? format(warmup.latestCompletedOneMinuteExpected) : 'NONE'} latest5m=${warmup.latestCompletedFiveMinuteAvailable ? format(warmup.latestCompletedFiveMinuteAvailable) : 'NONE'} ageMinutes=${warmup.warmupAgeMinutes?.toFixed(2) ?? 'N/A'} missingMinutes=${warmup.currentDayMissingMinuteCount} duplicates=${warmup.currentDayDuplicateCount} ready=${warmup.ready} reason=${warmup.freshnessReason}`);
  if (!warmup.ready) {
    console.log('[V4_STARTUP] BLOCKED_NOT_READY: no V4 entries will be evaluated.');
    const forwardDate = istDate(new Date());
    const outcome = resolveSessionOutcome({
      reason: warmup.freshnessReason,
      invalidData: true,
    });
    forwardJournal.append({
      recordType: 'SUMMARY',
      tradingDate: forwardDate,
      strategyId: v4MomentumShadowStrategyId,
      fingerprint: forwardFingerprint,
      sessionCompleted: outcome.sessionCompleted,
      eodReason: warmup.freshnessReason,
      status: outcome.status,
      flags: ['FORWARD_EVALUATION_ONLY', 'SHADOW_ONLY', 'STARTUP_DATA_BLOCKED'],
    });
    return;
  }
  const forwardDate = istDate(new Date());
  if (forwardJournal.hasRecordsForDate(forwardDate)) forwardJournal.appendEvent(forwardDate, 'MANUAL_RESTART', ['MANUAL_RESTART'], { reason: 'existing_session_journal' });
  forwardJournal.append({ recordType: 'SESSION', tradingDate: forwardDate, strategyId: v4MomentumShadowStrategyId, fingerprint: forwardFingerprint, runtimeStartedAt: new Date().toISOString(), warmupReadyAt: new Date().toISOString(), marketDataHealthy: true, sessionCompleted: false, flags: ['FORWARD_EVALUATION_ONLY', 'SHADOW_ONLY'] });
  evaluator.seedHistoricalOneMinute(warmup.seededOneMinuteCandles);

  const websocket = new MarketDataWebSocketClient(token); const connection = new ConnectionManager(token, websocket, { maximumReconnectDurationMs:reconnectDurationMs }); const subscriptions = new SubscriptionManager(token, connection); const decoder = new ProtobufDecoder(); const ticks = new TickProcessor(); const liveCandleBuilder = new LiveCandleBuilderService(); const candleEvents = new LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connection.getGenerationId()); const tracker = new V4MomentumShadowTrackerService(); const contracts = new CurrentNiftyPeContracts();
  let completed3m = 0; let opportunities = 0; let signals = 0; let closing = false; let eodStarted = false; let eodTimer: NodeJS.Timeout | undefined; let eodWatchdog: NodeJS.Timeout | undefined; let host: StrategyHostLifecycle | undefined;
  // Separates each terminal trigger's own close-out work (still gated by the `closing` latch
  // below, run at most once) from the single durable SUMMARY/CLEAN_SHUTDOWN write: a racing
  // fault can still escalate the outcome for as long as commit() has not yet run.
  const terminalOutcomeArbiter = new StrategyTerminalOutcomeArbiter();
  // Bounds the wait for the first accepted current-generation NIFTY event after subscribing on cold start. Reuses the same 45s figure MarketDataHealthMonitorService already treats as "stalled" for an established connection (MARKET_DATA_STALL_MS). On a genuinely silent feed during an active session, this bound -- not the health monitor's periodic stall check -- is what owns and reports the startup failure.
  // Before host.start() has successfully returned, host.start() itself is the sole owner of the initial RUNNING transition (via onReady -> recovery.waitUntilReady()). Calling host.recovered() from the persistent recovery listener too, while the host is still transiting through READY/DEGRADED during startup, races start()'s own unconditional RUNNING transition and produces an illegal RUNNING->RUNNING transition.
  let startupComplete = false;
  // Decided once, at the START of each disconnect/reconnect episode, from the coordinator's OWN
  // generation-independent authoritative truth (sourceBoundaryEvaluationCoverage), and reused
  // consistently through the matching reconnect -- never decided after the fact from a FAULTED
  // coordinator. See health's onStall and connection.on('unexpectedDisconnect'/'reconnected') below.
  let sourceRecoveryBypassActive = false;
  // A7-H6: set only when a recovery reconstructs data reaching exactly the NIFTY
  // source-completion boundary (15:29 IST) -- the one 3m bucket recoverHistoricalOneMinute()
  // below is told to withhold so the source-boundary trigger's own evaluateCompletedThreeMinute()
  // call is never rejected as "already seeded". Read and cleared by performSourceBoundaryEvaluation().
  let pendingSourceBoundaryCandle: Candle | undefined;
  const isNiftyFinalSourceMinute = (candidate: Date | null | undefined): boolean =>
    candidate != null && candidate.getTime() === nifty1mSourceCompletionBoundary(candidate).getTime() - 60_000;
  type RecoveryWarmup = Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryWarmup>({
    getLastSeededCompletedMinute: () => warmup.lastCurrentDayCandle,
    liveConstructionAlignmentMinutes,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (recoveryWarmup) => recoveryWarmup?.lastCurrentDayCandle,
    backfill: async (requiredCompletedMinute) => {
      const recoveryWarmup = await new LivePaperFreshWarmupService(new HistoricalCandleRepository(), new ShadowWarmupTarget())
        .warmUp(requiredCompletedMinute ? new Date(requiredCompletedMinute.getTime() + 60_000) : undefined);
      return { ready: recoveryWarmup.ready, reason: recoveryWarmup.freshnessReason, missingMinutes: recoveryWarmup.currentDayMissingMinuteCount, duplicateMinutes: recoveryWarmup.currentDayDuplicateCount, recoveryData:recoveryWarmup };
    },
    onRecovered: (_generationId,recoveryWarmup) => {
      if (recoveryWarmup) {
        // Recovery only seeds indicator history; it never evaluates a historical signal, EXCEPT
        // that a recovery reaching exactly the source horizon withholds its final 3m bucket here
        // (see isNiftyFinalSourceMinute) so performSourceBoundaryEvaluation() can deliver it
        // through the normal completed-3m evaluation path exactly once.
        const isTerminalRecovery = isNiftyFinalSourceMinute(recoveryWarmup.lastCurrentDayCandle);
        const finalThreeMinuteBucketStart = isTerminalRecovery && recoveryWarmup.lastCurrentDayCandle
          ? new Date(nifty1mSourceCompletionBoundary(recoveryWarmup.lastCurrentDayCandle).getTime() - v4MomentumShadowConfig.timeframeMinutes * 60_000)
          : undefined;
        evaluator.recoverHistoricalOneMinute(recoveryWarmup.seededOneMinuteCandles, finalThreeMinuteBucketStart);
        if (finalThreeMinuteBucketStart) pendingSourceBoundaryCandle = evaluator.getReconstructedThreeMinuteBucket(finalThreeMinuteBucketStart);
        // Once EOD/terminal close-out has begun, do not restart live candle delivery.
        if (!eodStarted && !closing) candleEvents.start();
      }
      return undefined;
    },
    // A7-H2: exclude any bucket, on any timeframe, that starts before the first minute
    // guaranteed observable from its very start on this connection -- otherwise a
    // WebSocket that connects/reconnects mid-minute could silently emit a partial
    // "completed" candle into the live 3m/5m evaluation path.
    onLiveConstructionBoundary: (boundary) => liveCandleBuilder.setLiveConstructionBoundary(nifty, boundary.getTime()),
    onLiveConstructionUnavailable: (sessionClose) => liveCandleBuilder.blockLiveConstructionForSession(nifty, sessionClose.getTime()),
    onEvent: (eventType, details) => { const unsafe = eventType === 'DATA_GAP_UNRECOVERABLE'; forwardJournal.appendEvent(forwardDate, eventType, [eventType, ...(unsafe ? ['CRITICAL_DATA_QUALITY'] : [])], details); console.log(`[MARKET_DATA_BACKFILL] event=${eventType} state=${recovery.getState()}`); },
  });
  const health = new MarketDataHealthMonitorService(connection, {
    generationGraceMs:healthGraceMs,
    // NIFTY_INDEX genuinely stops publishing 1m source candles at the canonical 15:30 IST
    // source-completion boundary, well before the wider 09:15-15:40 operational session ends.
    // A STALL detected at/after that boundary must not solicit a reconnect the recovery
    // coordinator can never satisfy for a new candle. Reuses the canonical
    // nifty1mSourceCompletionBoundary utility -- no duplicate hardcoded boundary here.
    isSourceFresh: (value) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime(),
    onStall: (snapshot, { reason, reconnectSolicited }) => {
    if (!reconnectSolicited) {
      // Expected post-source-completion condition: transport (raw/option) traffic is
      // genuinely healthy -- only the NIFTY source itself has naturally stopped. Must NOT
      // start a coordinator disconnect episode or stop candle events for this (see PROVEN
      // BLOCKER 1) -- retain observability only.
      forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_SOURCE_STALE_EXPECTED', ['MARKET_DATA_SOURCE_STALE_EXPECTED'], { ...snapshot, reason });
      return;
    }
    // Fires (and calls handleUnexpectedDisconnect directly) BEFORE ConnectionManager's own
    // 'unexpectedDisconnect' event -- this is the real first mover for a health-triggered
    // STALL/HEALTH_GRACE_EXPIRED, so the bypass decision must be made identically here too
    // (see connection.on('unexpectedDisconnect', ...) below for the full rationale).
    sourceRecoveryBypassActive = sourceBoundaryEvaluationCoverage.getRecord()?.disposition === 'EVALUATED';
    const details = { generationId: snapshot.generationId, reason, lastMessageAgeMs: snapshot.lastRawMessageAgeMs, lastTickAgeMs: snapshot.lastNiftyTickAgeMs };
    if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
    else recovery.handleUnexpectedDisconnect(details);
    candleEvents.stop(); forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], { ...snapshot });
  } });
  const eodCoordinator = new NseSessionEodCoordinator();
  const append = (entry: V4ShadowTradeJournalEntry): void => { mkdirSync(dirname(journalPath), { recursive: true }); appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, 'utf8'); forwardJournal.append({ recordType: 'EXIT', tradingDate: entry.tradingDate, strategyId: v4MomentumShadowStrategyId, fingerprint: forwardFingerprint, signalId: `V4-${entry.signalTimestamp.getTime()}`, signalTimestampIst: format(entry.signalTimestamp), selectedOptionInstrument: entry.optionInstrument, theoreticalEntryPrice: entry.referencePremium || null, theoreticalExitPrice: entry.exitPremium, executableEntryPrice: entry.referencePremium || null, executableExitPrice: entry.exitPremium, entryPriceSource: 'ESTIMATED_LTP', exitPriceSource: 'ESTIMATED_LTP', theoreticalReturn: entry.grossReturnPercent, executableEstimatedReturn: entry.grossReturnPercent, totalEstimatedSlippage: 0, totalExecutionFrictionPercent: 0, exitReason: entry.exitReason === 'STOP_LOSS' ? 'STOP' : entry.exitReason === 'TIMEOUT' ? 'TIMEOUT' : entry.exitReason === 'AMBIGUOUS' ? 'AMBIGUOUS' : entry.exitReason === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'TARGET', executionQuoteQuality: 'LTP_ONLY', flags: ['FORWARD_EVALUATION_ONLY', 'LTP_ONLY'] }); console.log(`[V4_PAPER_TRADE_CLOSED] ${entry.exitReason} ${entry.optionInstrument} gross=${entry.grossReturnPercent ?? 'N/A'} net40=${entry.netReturnAt040 ?? 'N/A'}`); };
  const flush = (entries: readonly V4ShadowTradeJournalEntry[]) => entries.forEach(append);
  const onMessage = (buffer: Buffer, details: { generationId: number }) => { try { ticks.process(decoder.decode(buffer), details.generationId); } catch (error) { console.error('[V4_MARKET_DATA_ERROR]', message(error)); } };
  const onTick = (event: unknown) => { const tick = event as Partial<MarketTickEvent>; if (!isCurrentLiveGeneration(tick.generationId, connection.getGenerationId())) return; if (typeof tick.instrumentKey !== 'string' || typeof tick.ltp !== 'number' || typeof tick.timestamp !== 'string') return; const at = new Date(tick.timestamp); if (Number.isNaN(at.getTime())) return; health.noteValidMarketEvent(tick.generationId); if (recovery.getState() === 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT' && health.confirmPostSourceTransportReady(tick.generationId)) recovery.handleTransportReadySourceRecoveryNotRequired(tick.generationId); if (isAtOrAfterNseSessionClose(at)) { eodStarted = true; void host?.eod('MARKET_EOD'); return; } if (eodStarted) return; if (tick.instrumentKey === nifty) { health.noteNiftyTick(tick.generationId, at); recovery.handleLiveTick({ sourceTimestamp: at, receivedAt: new Date(), generationId: tick.generationId }); if(recovery.isEvaluationReady())health.confirmRecoveryReady(tick.generationId); } if (!recovery.isEvaluationReady()) return; flush(tracker.observePremium(tick.instrumentKey, tick.ltp, at)); };
  const onCandle = (event: unknown) => { void handleCandle(event); };
  /**
   * Shared actionable evaluation for one completed 3m candle -- used by the normal live
   * `handleCandle` path below AND (A7-H6) by performSourceBoundaryEvaluation(), so the
   * source-boundary trigger's final candle is evaluated through the exact same call, not a
   * reimplementation of it.
   */
  const evaluateThreeMinuteCandle = async (value: Candle): Promise<void> => {
    completed3m += 1; const decision = evaluator.evaluateCompletedThreeMinute(value); if (decision.regimeAligned) opportunities += 1;
    console.log(`[V4_ENTRY_EVALUATION] ${format(decision.timestamp)} close=${decision.close.toFixed(2)} regime=${decision.regime ?? 'NOT_READY'} atr=${num(decision.atr)} compression=${num(decision.compressionRange)} ratio=${num(decision.compressionRangeAtr)} body=${num(decision.body)} bodyAtr=${num(decision.bodyAtr)} threshold=${num(decision.breakoutThreshold)} breakout=${decision.breakoutPassed} regimePass=${decision.regimeAligned} cooldown=${decision.cooldownEligible} signal=${decision.signal} reason=${decision.rejectionReason}`);
    if (!decision.signal) return;
    signals += 1;
    forwardJournal.append({ recordType: 'SIGNAL', tradingDate: istDate(decision.timestamp), strategyId: v4MomentumShadowStrategyId, fingerprint: forwardFingerprint, signalId: `V4-${decision.timestamp.getTime()}`, signalTimestampIst: format(decision.timestamp), signalTimestampUtc: decision.timestamp.toISOString(), underlyingInstrument: nifty, underlyingClose: decision.close, regime: decision.regime ?? 'NOT_READY', indicators: { atr: decision.atr, compressionRange: decision.compressionRange, compressionRangeAtr: decision.compressionRangeAtr, body: decision.body, bodyAtr: decision.bodyAtr, breakoutThreshold: decision.breakoutThreshold, breakoutPass: decision.breakoutPassed, regimePass: decision.regimeAligned, cooldownEligible: decision.cooldownEligible }, optionType: 'PE', signalReason: decision.rejectionReason, flags: ['FORWARD_EVALUATION_ONLY'] });
    console.log(`[V4 SIGNAL] ${format(decision.timestamp)} PE bodyATR=${num(decision.bodyAtr)} breakout=${decision.breakoutPassed} regime=${decision.regime ?? 'NOT_READY'}`);
    const signalGenerationId = connection.getGenerationId();
    try { const contract = await contracts.resolve(decision.close, decision.timestamp); if (!isCurrentLiveGeneration(signalGenerationId, connection.getGenerationId()) || !host?.canEvaluate() || !recovery.isEvaluationReady()) return; tracker.registerSignal(decision.timestamp, contract); forwardJournal.append({ recordType: 'ENTRY', tradingDate: istDate(decision.timestamp), strategyId: v4MomentumShadowStrategyId, fingerprint: forwardFingerprint, signalId: `V4-${decision.timestamp.getTime()}`, signalTimestampIst: format(decision.timestamp), selectedOptionInstrument: contract.instrumentKey, optionType: 'PE', strike: contract.strikePrice, expiry: contract.expiry.toISOString(), flags: ['FORWARD_EVALUATION_ONLY', 'LTP_ONLY'] }); await subscriptions.subscribe(contract.instrumentKey, MarketDataSubscriptionMode.FULL); console.log(`[V4_SHADOW_OPTION_SUBSCRIBED] ${contract.tradingSymbol} ${contract.instrumentKey}`); console.log(`[V4_ENTER_PE_SHADOW] ${format(decision.timestamp)} ${contract.tradingSymbol} target=${v4MomentumShadowPolicy.targetPercent}% stop=${v4MomentumShadowPolicy.stopLossPercent}% hold=${v4MomentumShadowPolicy.maximumHoldingMinutes}m`); }
    catch (error) { console.error('[V4_SHADOW_CONTRACT_RESOLUTION_FAILED]', message(error)); }
  };
  const handleCandle = async (event: unknown): Promise<void> => {
    const candle = event as { instrumentKey?: string; timeframe?: string; completed?: boolean; candleTime?: Date; open?: number; high?: number; low?: number; close?: number };
    if (eodStarted || !host?.canEvaluate() || !recovery.isEvaluationReady() || candle.instrumentKey !== nifty || candle.completed !== true || !(candle.candleTime instanceof Date) || ![candle.open,candle.high,candle.low,candle.close].every((value) => typeof value === 'number' && Number.isFinite(value))) return;
    const value: Candle = { timestamp: new Date(candle.candleTime.getTime()), open: candle.open!, high: candle.high!, low: candle.low!, close: candle.close!, volume: 0 };
    if (candle.timeframe === '5m') { evaluator.processCompletedFiveMinute(value); return; }
    if (candle.timeframe !== '3m') return;
    await evaluateThreeMinuteCandle(value);
  };
  // A7-H6: owned evidence for whether the one required final forward-strategy evaluation at
  // the NIFTY source-completion boundary actually ran.
  const sourceBoundaryEvaluationCoverage = new SourceBoundaryEvaluationCoverageTracker('shadow:v4:momentum', v4MomentumShadowStrategyId);
  // One-shot, generation-owned, cancellable trigger for the NIFTY source-completion boundary --
  // never a hardcoded literal (see nifty1mSourceCompletionBoundary), cancelled unconditionally in
  // shutdown()'s close-out below so it can never fire after terminalization has started.
  const sourceBoundaryTrigger = new OneShotWallClockTrigger();
  /**
   * Fires once at the NIFTY source-completion boundary (15:30 IST) rather than waiting for the
   * 15:40 operational EOD barrier, so the final genuine V4 3m opportunity (15:27-15:29,
   * requiring the completed 15:25-15:29 5m regime state) is never silently substituted by
   * non-evaluating terminal recovery. Reads connection.getGenerationId() fresh at fire time
   * (never a value captured at arm time).
   */
  const performSourceBoundaryEvaluation = async (): Promise<void> => {
    if (eodStarted || closing) return;
    const generationId = connection.getGenerationId();
    const boundaryAt = nifty1mSourceCompletionBoundary(new Date());
    const finalBucketStart = new Date(boundaryAt.getTime() - v4MomentumShadowConfig.timeframeMinutes * 60_000);
    sourceBoundaryEvaluationCoverage.require(generationId, boundaryAt);

    let candle: Candle | undefined;
    // Path A: ticks flowed normally all session and already built this exact final 3m bucket
    // locally -- use it directly rather than re-deriving it from REST.
    const active = liveCandleBuilder.getActiveCandle(nifty, '3m');
    if (active && active.candleTime.getTime() === finalBucketStart.getTime()) {
      candle = { timestamp: new Date(active.candleTime.getTime()), open: active.open, high: active.high, low: active.low, close: active.close, volume: 0 };
      // Consumed here -- must not also be flushed a second time by the 15:40 EOD finishSession().
      liveCandleBuilder.reset(nifty, '3m');
    } else {
      // Path B: no locally-built candle exists for this bucket -- positively recover/confirm
      // authoritative source through 15:29 via the exact same barrier the 15:40 EOD path uses.
      // Idempotent: a second call from EOD after this one already succeeded returns the same
      // RECOVERED outcome without re-running backfill.
      const result = await recovery.completePendingBoundaryReconciliation();
      if (eodStarted || closing || connection.getGenerationId() !== generationId) {
        sourceBoundaryEvaluationCoverage.markLost(generationId, 'TERMINALIZED_OR_SUPERSEDED_DURING_RECOVERY');
        return;
      }
      if (result.outcome !== 'RECOVERED') {
        sourceBoundaryEvaluationCoverage.markLost(generationId, result.reason);
        return;
      }
      candle = pendingSourceBoundaryCandle;
      pendingSourceBoundaryCandle = undefined;
      if (!candle) {
        sourceBoundaryEvaluationCoverage.markLost(generationId, 'TERMINAL_CANDLE_NOT_RECONSTRUCTED');
        return;
      }
    }

    if (eodStarted || closing || !host?.canEvaluate() || !recovery.isEvaluationReady() || connection.getGenerationId() !== generationId) {
      sourceBoundaryEvaluationCoverage.markLost(generationId, 'HOST_NOT_RUNNING_AT_SOURCE_BOUNDARY');
      return;
    }
    try {
      // The exact same actionable path an ordinary completed live 3m candle uses.
      await evaluateThreeMinuteCandle(candle);
      // NO_TRADE/a rejected signal still counts as evaluated -- the opportunity was genuinely
      // evaluated through the actionable path exactly once.
      sourceBoundaryEvaluationCoverage.markEvaluated(generationId, candle.timestamp, 'SOURCE_BOUNDARY_EVALUATION_COMPLETED');
    } catch (error) {
      sourceBoundaryEvaluationCoverage.markLost(generationId, error instanceof Error ? error.message : 'SOURCE_BOUNDARY_EVALUATION_FAILED');
    }
  };
  const interval = setInterval(() => { if (recovery.isEvaluationReady()) flush(tracker.advance(new Date())); }, 15_000); interval.unref();
  const status = setInterval(() => console.log(`[V4_SHADOW_STATUS] completed3m=${completed3m} regimeAligned=${opportunities} signals=${signals} open=${tracker.getOpenCount()} closed=${tracker.getClosed().length}`), 60_000); status.unref();
  const shutdown = async (reason = 'SESSION_END', onCloseOutComplete?: () => void, invalidData = false): Promise<void> => {
    // Cancelled unconditionally and before anything else, on every terminal trigger (including
    // a duplicate/racing one) -- cancel() is idempotent, so this is the one place that
    // guarantees the source-boundary trigger can never fire once terminalization has started.
    sourceBoundaryTrigger.cancel();
    // Proposed unconditionally, even if a different trigger already owns the close-out work
    // below -- this is the only way a racing fault can still escalate the eventual commit()'d
    // outcome.
    terminalOutcomeArbiter.propose(reason, resolveSessionOutcome({ reason, invalidData }).status);
    if (closing) return;
    closing = true;
    // sealAfterCloseOut() is the single production seam: it runs this fallible close-out
    // (including any trigger-specific pre-seal observability via onCloseOutComplete) fully to
    // completion -- or, if it throws, escalates to FAULTED and still durably seals that reason --
    // BEFORE the SUMMARY/CLEAN_SHUTDOWN write below ever runs. Nothing capable of throwing runs
    // after sealAfterCloseOut() resolves: the durable SUMMARY append inside the writer below is
    // the final potentially-throwing operation in this terminal path, so a successful
    // VALID_COMPLETED SUMMARY can never be followed by a lifecycle failure that would leave the
    // host FAULTED next to it.
    await terminalOutcomeArbiter.sealAfterCloseOut(
      () => {
        health.stop();
        recovery.stop();
        clearInterval(interval);
        clearInterval(status);
        if (eodTimer) clearTimeout(eodTimer);
        if (eodWatchdog) clearInterval(eodWatchdog);
        flush(tracker.advance(new Date()));
        candleEvents.stop();
        connection.off('message', onMessage);
        eventBus.off('market.tick', onTick);
        eventBus.off('market.candle.completed', onCandle);
        subscriptions.unsubscribeMany(subscriptions.getSubscriptions().map((value) => value.instrumentKey));
        connection.disconnect();
        // Trigger-specific pre-seal observability (e.g. finishEod's own EOD summary log) --
        // still close-out work, so it must finish (or fault the session) before the seal below.
        onCloseOutComplete?.();
      },
      (finalReason) => {
        // commit() (inside sealAfterCloseOut) reads the arbiter's authoritative reason at this
        // exact instant -- a fault that raced in via propose() any time before this line (including
        // during close-out itself) wins here even though this call originated from a different
        // trigger's own local `reason`.
        const closed = tracker.getClosed();
        const settled = closed.filter((entry) => entry.grossReturnPercent !== null);
        const gross = settled.length ? settled.reduce((sum, entry) => sum + (entry.grossReturnPercent ?? 0), 0) / settled.length : 0;
        const outcome = resolveSessionOutcome({ reason: finalReason, invalidData });
        // CLEAN_SHUTDOWN (non-authoritative) must be durable before SUMMARY (the A9-authoritative
        // eligibility record): a failure appending CLEAN_SHUTDOWN must never leave a durable
        // VALID_COMPLETED SUMMARY with no corresponding shutdown evidence.
        if (outcome.status === 'VALID_COMPLETED') forwardJournal.appendEvent(istDate(new Date()), 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason: finalReason });
        console.log(`V4 MOMENTUM SHADOW DAILY date=${istDate(new Date())} completed3m=${completed3m} regimeAligned=${opportunities} signals=${signals} resolved=${settled.length} targets=${closed.filter(x=>x.exitReason==='TARGET').length} stops=${closed.filter(x=>x.exitReason==='STOP_LOSS').length} timeouts=${closed.filter(x=>x.exitReason==='TIMEOUT').length} ambiguous=${closed.filter(x=>x.exitReason==='AMBIGUOUS').length} grossAvg=${gross.toFixed(2)} net40=${(settled.length ? gross - .4 : 0).toFixed(2)} fixedNotionalPnl=${(gross * 1000).toFixed(2)}`);
        // The durable SUMMARY append is the FINAL potentially-throwing operation in this writer --
        // and, once sealAfterCloseOut() has run all close-out and observability above, in the
        // entire terminal path. Nothing follows it.
        forwardJournal.append({
          recordType: 'SUMMARY',
          tradingDate: istDate(new Date()),
          strategyId: v4MomentumShadowStrategyId,
          fingerprint: forwardFingerprint,
          sessionCompleted: outcome.sessionCompleted,
          eodReason: finalReason,
          signals,
          resolvedTrades: settled.length,
          unresolvedTrades: closed.length - settled.length,
          target: closed.filter(x=>x.exitReason==='TARGET').length,
          stop: closed.filter(x=>x.exitReason==='STOP_LOSS').length,
          timeout: closed.filter(x=>x.exitReason==='TIMEOUT').length,
          eod: closed.filter(x=>x.exitReason==='TIMEOUT').length,
          averageTheoretical: gross,
          averageExecutable: gross,
          averageFriction: 0,
          status: outcome.status,
        });
      },
    );
  };
  const finishEod = async (reason = 'VALID_COMPLETED'): Promise<void> => {
    await eodCoordinator.runOnce(new Date(), async () => {
      eodStarted = true;
      forwardJournal.appendEvent(istDate(new Date()), 'EOD_FORCED_EXIT', ['EOD_FORCED_EXIT']);
      candleEvents.finishSession(nifty);
      // V4's final valid common 3m/5m handoff is 15:30, requiring authoritative NIFTY
      // source coverage through 15:29. No post-15:29 source tick is guaranteed to arrive
      // and trigger it, so terminalization must consume the coordinator's positive barrier
      // before shutdown() calls recovery.stop(). Recovered history remains non-actionable:
      // eodStarted is already true and onRecovered above cannot restart candle delivery.
      // A benign post-source-completion transport episode (see sourceRecoveryBypassActive in the
      // onStall/unexpectedDisconnect/reconnected handlers above) can advance the connection
      // generation AFTER the one required final evaluation already reached EVALUATED under an
      // earlier generation. completePendingBoundaryReconciliation()'s own generation-equality
      // check would then report NOT_RECOVERED purely from that generation drift, never from any
      // actual invalidation. sourceBoundaryEvaluationCoverage reaching EVALUATED is strictly
      // stronger, more specific proof that the required work already completed, so it alone is
      // authoritative here, and the barrier is skipped (never distrusted or reinterpreted) in
      // that one case.
      const alreadyEvaluatedThisSession = sourceBoundaryEvaluationCoverage.getRecord()?.disposition === 'EVALUATED';
      const boundaryReconciliation = alreadyEvaluatedThisSession
        ? { outcome: 'RECOVERED' as const, reason: 'SOURCE_BOUNDARY_EVALUATION_ALREADY_COMPLETE' }
        : await recovery.completePendingBoundaryReconciliation();
      const sourceCloseRecoveryFailed = boundaryReconciliation.outcome === 'NOT_RECOVERED';
      if (sourceCloseRecoveryFailed) {
        forwardJournal.appendEvent(forwardDate, 'V4_SOURCE_CLOSE_RECOVERY_FAILED', ['V4_SOURCE_CLOSE_RECOVERY_FAILED', 'CRITICAL_DATA_QUALITY'], { reason: boundaryReconciliation.reason, recoveryState: recovery.getState() });
        console.error(`[V4_SOURCE_CLOSE_RECOVERY] Failed to prove complete source coverage (${boundaryReconciliation.reason}); session will fail closed as INVALID_DATA.`);
      }
      // A7-H6: SOURCE/DATA coverage (above) is not FORWARD EVALUATION coverage. require() is a
      // no-op if the source-boundary trigger already recorded EVALUATED/LOST for this exact
      // generation; if that trigger never ran at all, this establishes REQUIRED_PENDING here,
      // which is correctly unsatisfied below -- a terminal-only recovery must never silently
      // substitute for a missed real-time evaluation opportunity. Skip the re-arm for the same
      // reason as above.
      const finalGenerationId = connection.getGenerationId();
      if (!alreadyEvaluatedThisSession) sourceBoundaryEvaluationCoverage.require(finalGenerationId, nifty1mSourceCompletionBoundary(new Date()));
      const evaluationCoverageLost = !alreadyEvaluatedThisSession && !sourceBoundaryEvaluationCoverage.isSatisfiedFor(finalGenerationId);
      if (evaluationCoverageLost) {
        forwardJournal.appendEvent(forwardDate, 'V4_SOURCE_BOUNDARY_EVALUATION_LOST', ['V4_SOURCE_BOUNDARY_EVALUATION_LOST', 'CRITICAL_DATA_QUALITY'], { reason: sourceBoundaryEvaluationCoverage.getRecord()?.reason ?? 'UNKNOWN', disposition: sourceBoundaryEvaluationCoverage.disposition(finalGenerationId) });
        console.error(`[V4_SOURCE_BOUNDARY_EVALUATION] Forward-evaluation coverage for the final source-boundary candle was not proven (${sourceBoundaryEvaluationCoverage.disposition(finalGenerationId)}); session will fail closed as INVALID_DATA.`);
      }
      flush(tracker.closeAtSessionEnd(new Date()));
      // The EOD summary log is pre-seal, trigger-specific close-out observability -- passed into
      // shutdown() so it always runs BEFORE the seal, never after: nothing may follow
      // `await shutdown(...)` in this hook.
      await shutdown(reason, () => {
        const closed = tracker.getClosed();
        console.log(`[V4_EOD_SUMMARY]\ndate=${istDate(new Date())}\nstrategyId=${v4MomentumShadowStrategyId}\ncompleted3m=${completed3m}\nregimeAligned=${opportunities}\nsignals=${signals}\nshadowOpened=${tracker.getOpenedCount()}\nshadowClosed=${closed.length}\ntarget=${closed.filter(x=>x.exitReason==='TARGET').length}\nstop=${closed.filter(x=>x.exitReason==='STOP_LOSS').length}\ntimeout=${closed.filter(x=>x.exitReason==='TIMEOUT').length}\nopen=${tracker.getOpenCount()}\nstatus=${(sourceCloseRecoveryFailed || evaluationCoverageLost) ? 'INVALID_DATA' : 'VALID_COMPLETED'}`);
      }, sourceCloseRecoveryFailed || evaluationCoverageLost);
    });
  };
  connection.on('unexpectedDisconnect', (details: { code?: number; reason?: string; generationId?: number; disconnectClean?: boolean }) => {
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
    candleEvents.stop(); forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_DISCONNECTED', ['WEBSOCKET_DISCONNECTED'], { code: details.code ?? null, reason: details.reason ?? null });
  });
  connection.on('reconnected', (details: { downtimeMs?: number; generationId?: number }) => {
    forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_RECONNECTED', ['WEBSOCKET_RECONNECTED'], { downtimeMs: details.downtimeMs ?? null });
    if (sourceRecoveryBypassActive) recovery.handleReconnectedSourceRecoveryNotRequired(details);
    else recovery.handleReconnected(details);
  });
  connection.on('reconnectFailed', (details: { attempts?: number; downtimeMs?: number }) => { recovery.fault('RECONNECT_FAILED'); forwardJournal.appendEvent(forwardDate, 'RECONNECT_FAILED', ['RECONNECT_FAILED', 'DATA_GAP', 'CRITICAL_DATA_QUALITY'], { attempts: details.attempts ?? null, downtimeMs: details.downtimeMs ?? null }); if (!terminalOutcomeArbiter.isSealing()) void host?.fault(new Error('RECONNECT_FAILED')); });
  // ConnectionManager emits 'connected' on every successful open, cold start and reconnect alike ('reconnected' fires immediately after it on a reconnect). handleInitialConnected() only has an effect the very first time it runs, so this cannot reset or race the reconnect state machine driven by 'unexpectedDisconnect' / 'reconnected' above.
  connection.on('connected', (details: { generationId: number }) => { recovery.handleInitialConnected({ generationId: details.generationId }); });
  host = new StrategyHostLifecycle({ strategyId:v4MomentumShadowStrategyId, runtimeId:'shadow:v4:momentum', eodCoordinator, hooks:{warmup:()=>undefined,
    // Historical warmup already ran above. This is the LIVE gate: RUNNING (reason=MARKET_DATA_READY) must not be granted until an accepted, usable, current-generation NIFTY event has actually been observed.
    onReady: async () => { const ready = recovery.waitUntilReady(startupReadyTimeoutMs); ready.catch(() => undefined); await subscriptions.subscribe(nifty, MarketDataSubscriptionMode.FULL); await ready; },
    onEod:(reason)=>finishEod(reason ?? 'VALID_COMPLETED'),onShutdown:(reason)=>shutdown(reason ?? 'SESSION_END'),onFault:()=>shutdown('FAULTED')}, log:v=>console.log(`[STRATEGY_HOST_STATE] strategyId=${v.strategyId} runtimeId=${v.runtimeId} previous=${v.previous} state=${v.state} reason=${v.reason}`) });
  // host.start() itself owns the initial RUNNING transition via its onReady hook; only a genuine post-startup recovery may call host.recovered() here, gated by startupComplete.
  // FAULTED escalation is handled in the coordinator's onEvent MARKET_DATA_RECOVERY_FAILED
  // branch above, where the real fail reason is available (see comment there).
  // A FAULTED coordinator here always means a source-candle recovery was genuinely attempted and
  // genuinely failed -- a benign post-source-completion transport episode never reaches
  // handleReconnected()/FAULTED at all; see the sourceRecoveryBypassActive-gated onStall/
  // unexpectedDisconnect/reconnected handlers above.
  recovery.on('stateChanged',(state)=>{if(state==='DEGRADED')void host?.degrade('MARKET_DATA_DEGRADED');if((state==='READY'||state==='SOURCE_COMPLETE_READY')&&!eodStarted&&!closing){const healthConfirmed=state==='READY'?health.confirmRecoveryReady(recovery.getGenerationId()):health.confirmPostSourceTransportReady(recovery.getGenerationId());if(!healthConfirmed)connection.failRecovery(recovery.getGenerationId(),'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');else if(startupComplete)void host?.recovered('MARKET_DATA_READY');}if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');});
  process.once('SIGINT', () => { void host?.shutdown('SIGINT'); }); process.once('SIGTERM', () => { void host?.shutdown('SIGTERM'); });
  connection.on('message', onMessage); eventBus.on('market.tick', onTick); eventBus.on('market.candle.completed', onCandle); candleEvents.start(); health.start();
  await host.start();
  if (host.getState() !== 'RUNNING') return;
  startupComplete = true; // the persistent recovery listener may now own DEGRADED -> RUNNING for any later, genuine reconnect recovery
  // A7-H6: armed only once startup has genuinely reached RUNNING.
  sourceBoundaryTrigger.armAt(nifty1mSourceCompletionBoundary(new Date()), performSourceBoundaryEvaluation);
  console.log(`[V4_STARTUP] strategyId=${v4MomentumShadowStrategyId} shadowOnly=true paperOrders=false brokerOrders=false journal=${journalPath}`);
}
function isNifty(value: string): boolean { return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === 'NIFTY50' || value.trim().toUpperCase() === 'NIFTY'; }
function format(value: Date): string { return formatter.format(value); } function num(value: number | null): string { return value === null ? 'N/A' : value.toFixed(4); } function message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error.'; }
function istDate(value: Date): string { const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; }
void run().catch((error) => { console.error('[V4_SHADOW_FATAL]', message(error)); process.exitCode = 1; });
