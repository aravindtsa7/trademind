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
import V4NiftyMomentumShadowEvaluatorService, { v4MomentumShadowPolicy, v4MomentumShadowStrategyId } from '../modules/adaptive-intraday/services/v4-nifty-momentum-shadow-evaluator.service';
import V4MomentumShadowTrackerService, { assertV4ShadowRuntimeGuards, V4ShadowTradeJournalEntry } from '../modules/adaptive-intraday/services/v4-momentum-shadow-tracker.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract } from '../modules/options/types';
import LivePaperFreshWarmupService from '../modules/paper-trading/services/live-paper-fresh-warmup.service';
import { PaperStrategyWarmupTarget } from '../modules/paper-trading/dto/paper-strategy-warmup.dto';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { NseSessionEodCoordinator, isAtOrAfterNseSessionClose, isWithinNseSession } from '../modules/market-data/services/nse-session-calendar.service';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import { StrategyHostLifecycle } from '../modules/market-data/services/strategy-host-lifecycle.service';
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

  const websocket = new MarketDataWebSocketClient(token); const connection = new ConnectionManager(token, websocket); const subscriptions = new SubscriptionManager(token, connection); const decoder = new ProtobufDecoder(); const ticks = new TickProcessor(); const candleEvents = new LiveCandleEventAdapterService(new LiveCandleBuilderService(), eventBus, () => connection.getGenerationId()); const tracker = new V4MomentumShadowTrackerService(); const contracts = new CurrentNiftyPeContracts();
  let completed3m = 0; let opportunities = 0; let signals = 0; let closing = false; let eodStarted = false; let eodTimer: NodeJS.Timeout | undefined; let eodWatchdog: NodeJS.Timeout | undefined; let host: StrategyHostLifecycle | undefined;
  // Bounds the wait for the first accepted current-generation NIFTY event after subscribing on cold start. Reuses the same 45s figure MarketDataHealthMonitorService already treats as "stalled" for an established connection (MARKET_DATA_STALL_MS). On a genuinely silent feed during an active session, this bound -- not the health monitor's periodic stall check -- is what owns and reports the startup failure.
  const startupReadyTimeoutMs = positiveTimeoutMs('MARKET_DATA_STARTUP_READY_TIMEOUT_MS', process.env.MARKET_DATA_STARTUP_READY_TIMEOUT_MS, 45_000);
  // Before host.start() has successfully returned, host.start() itself is the sole owner of the initial RUNNING transition (via onReady -> recovery.waitUntilReady()). Calling host.recovered() from the persistent recovery listener too, while the host is still transiting through READY/DEGRADED during startup, races start()'s own unconditional RUNNING transition and produces an illegal RUNNING->RUNNING transition.
  let startupComplete = false;
  type RecoveryWarmup = Awaited<ReturnType<LivePaperFreshWarmupService['warmUp']>>;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryWarmup>({
    backfill: async () => {
      const recoveryWarmup = await new LivePaperFreshWarmupService(new HistoricalCandleRepository(), new ShadowWarmupTarget()).warmUp();
      return { ready: recoveryWarmup.ready, reason: recoveryWarmup.freshnessReason, missingMinutes: recoveryWarmup.currentDayMissingMinuteCount, duplicateMinutes: recoveryWarmup.currentDayDuplicateCount, recoveryData:recoveryWarmup };
    },
    onRecovered: (_generationId,recoveryWarmup) => { if (recoveryWarmup) { evaluator.recoverHistoricalOneMinute(recoveryWarmup.seededOneMinuteCandles); candleEvents.start(); } return undefined; },
    onEvent: (eventType, details) => { const unsafe = eventType === 'DATA_GAP_UNRECOVERABLE'; forwardJournal.appendEvent(forwardDate, eventType, [eventType, ...(unsafe ? ['CRITICAL_DATA_QUALITY'] : [])], details); console.log(`[MARKET_DATA_BACKFILL] event=${eventType} state=${recovery.getState()}`); },
  });
  const health = new MarketDataHealthMonitorService(connection, { onStall: (snapshot) => {
    recovery.handleUnexpectedDisconnect({ generationId: snapshot.generationId, reason: 'STALL', lastMessageAgeMs: snapshot.lastRawMessageAgeMs, lastTickAgeMs: snapshot.lastNiftyTickAgeMs });
    candleEvents.stop(); forwardJournal.appendEvent(forwardDate, 'MARKET_DATA_DEGRADED', ['MARKET_DATA_DEGRADED'], { ...snapshot });
  } });
  const eodCoordinator = new NseSessionEodCoordinator();
  const append = (entry: V4ShadowTradeJournalEntry): void => { mkdirSync(dirname(journalPath), { recursive: true }); appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, 'utf8'); forwardJournal.append({ recordType: 'EXIT', tradingDate: entry.tradingDate, strategyId: v4MomentumShadowStrategyId, fingerprint: forwardFingerprint, signalId: `V4-${entry.signalTimestamp.getTime()}`, signalTimestampIst: format(entry.signalTimestamp), selectedOptionInstrument: entry.optionInstrument, theoreticalEntryPrice: entry.referencePremium || null, theoreticalExitPrice: entry.exitPremium, executableEntryPrice: entry.referencePremium || null, executableExitPrice: entry.exitPremium, entryPriceSource: 'ESTIMATED_LTP', exitPriceSource: 'ESTIMATED_LTP', theoreticalReturn: entry.grossReturnPercent, executableEstimatedReturn: entry.grossReturnPercent, totalEstimatedSlippage: 0, totalExecutionFrictionPercent: 0, exitReason: entry.exitReason === 'STOP_LOSS' ? 'STOP' : entry.exitReason === 'TIMEOUT' ? 'TIMEOUT' : entry.exitReason === 'AMBIGUOUS' ? 'AMBIGUOUS' : entry.exitReason === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'TARGET', executionQuoteQuality: 'LTP_ONLY', flags: ['FORWARD_EVALUATION_ONLY', 'LTP_ONLY'] }); console.log(`[V4_PAPER_TRADE_CLOSED] ${entry.exitReason} ${entry.optionInstrument} gross=${entry.grossReturnPercent ?? 'N/A'} net40=${entry.netReturnAt040 ?? 'N/A'}`); };
  const flush = (entries: readonly V4ShadowTradeJournalEntry[]) => entries.forEach(append);
  const onMessage = (buffer: Buffer, details: { generationId: number }) => { try { ticks.process(decoder.decode(buffer), details.generationId); } catch (error) { console.error('[V4_MARKET_DATA_ERROR]', message(error)); } };
  const onTick = (event: unknown) => { const tick = event as Partial<MarketTickEvent>; if (!isCurrentLiveGeneration(tick.generationId, connection.getGenerationId())) return; if (typeof tick.instrumentKey !== 'string' || typeof tick.ltp !== 'number' || typeof tick.timestamp !== 'string') return; const at = new Date(tick.timestamp); if (Number.isNaN(at.getTime())) return; health.noteValidMarketEvent(tick.generationId); if (isAtOrAfterNseSessionClose(at)) { eodStarted = true; void host?.eod('MARKET_EOD'); return; } if (eodStarted) return; if (tick.instrumentKey === nifty) { health.noteNiftyTick(tick.generationId, at); recovery.handleLiveTick({ sourceTimestamp: at, receivedAt: new Date(), generationId: tick.generationId }); if(recovery.isEvaluationReady())health.confirmRecoveryReady(tick.generationId); } if (!recovery.isEvaluationReady()) return; flush(tracker.observePremium(tick.instrumentKey, tick.ltp, at)); };
  const onCandle = (event: unknown) => { void handleCandle(event); };
  const handleCandle = async (event: unknown): Promise<void> => {
    const candle = event as { instrumentKey?: string; timeframe?: string; completed?: boolean; candleTime?: Date; open?: number; high?: number; low?: number; close?: number };
    if (eodStarted || !host?.canEvaluate() || !recovery.isEvaluationReady() || candle.instrumentKey !== nifty || candle.completed !== true || !(candle.candleTime instanceof Date) || ![candle.open,candle.high,candle.low,candle.close].every((value) => typeof value === 'number' && Number.isFinite(value))) return;
    const value: Candle = { timestamp: new Date(candle.candleTime.getTime()), open: candle.open!, high: candle.high!, low: candle.low!, close: candle.close!, volume: 0 };
    if (candle.timeframe === '5m') { evaluator.processCompletedFiveMinute(value); return; }
    if (candle.timeframe !== '3m') return;
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
  const interval = setInterval(() => { if (recovery.isEvaluationReady()) flush(tracker.advance(new Date())); }, 15_000); interval.unref();
  const status = setInterval(() => console.log(`[V4_SHADOW_STATUS] completed3m=${completed3m} regimeAligned=${opportunities} signals=${signals} open=${tracker.getOpenCount()} closed=${tracker.getClosed().length}`), 60_000); status.unref();
  const shutdown = (reason = 'SESSION_END'): void => {
    if (closing) return;
    closing = true;
    const outcome = resolveSessionOutcome({ reason });
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
    const closed = tracker.getClosed();
    const settled = closed.filter((entry) => entry.grossReturnPercent !== null);
    const gross = settled.length ? settled.reduce((sum, entry) => sum + (entry.grossReturnPercent ?? 0), 0) / settled.length : 0;
    forwardJournal.append({
      recordType: 'SUMMARY',
      tradingDate: istDate(new Date()),
      strategyId: v4MomentumShadowStrategyId,
      fingerprint: forwardFingerprint,
      sessionCompleted: outcome.sessionCompleted,
      eodReason: reason,
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
    if (outcome.status === 'VALID_COMPLETED') forwardJournal.appendEvent(istDate(new Date()), 'CLEAN_SHUTDOWN', ['CLEAN_SHUTDOWN'], { reason });
    console.log(`V4 MOMENTUM SHADOW DAILY date=${istDate(new Date())} completed3m=${completed3m} regimeAligned=${opportunities} signals=${signals} resolved=${settled.length} targets=${closed.filter(x=>x.exitReason==='TARGET').length} stops=${closed.filter(x=>x.exitReason==='STOP_LOSS').length} timeouts=${closed.filter(x=>x.exitReason==='TIMEOUT').length} ambiguous=${closed.filter(x=>x.exitReason==='AMBIGUOUS').length} grossAvg=${gross.toFixed(2)} net40=${(settled.length ? gross - .4 : 0).toFixed(2)} fixedNotionalPnl=${(gross * 1000).toFixed(2)}`);
  };
  const finishEod = async (reason = 'VALID_COMPLETED'): Promise<void> => {
    await eodCoordinator.runOnce(new Date(), () => {
      eodStarted = true;
      forwardJournal.appendEvent(istDate(new Date()), 'EOD_FORCED_EXIT', ['EOD_FORCED_EXIT']);
      candleEvents.finishSession(nifty);
      flush(tracker.closeAtSessionEnd(new Date()));
      shutdown(reason);
      const closed = tracker.getClosed();
      console.log(`[V4_EOD_SUMMARY]\ndate=${istDate(new Date())}\nstrategyId=${v4MomentumShadowStrategyId}\ncompleted3m=${completed3m}\nregimeAligned=${opportunities}\nsignals=${signals}\nshadowOpened=${tracker.getOpenedCount()}\nshadowClosed=${closed.length}\ntarget=${closed.filter(x=>x.exitReason==='TARGET').length}\nstop=${closed.filter(x=>x.exitReason==='STOP_LOSS').length}\ntimeout=${closed.filter(x=>x.exitReason==='TIMEOUT').length}\nopen=${tracker.getOpenCount()}\nstatus=VALID_COMPLETED`);
    });
  };
  connection.on('unexpectedDisconnect', (details: { code?: number; reason?: string; generationId?: number; disconnectClean?: boolean }) => { recovery.handleUnexpectedDisconnect(details); candleEvents.stop(); forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_DISCONNECTED', ['WEBSOCKET_DISCONNECTED'], { code: details.code ?? null, reason: details.reason ?? null }); });
  connection.on('reconnected', (details: { downtimeMs?: number; generationId?: number }) => { forwardJournal.appendEvent(forwardDate, 'WEBSOCKET_RECONNECTED', ['WEBSOCKET_RECONNECTED'], { downtimeMs: details.downtimeMs ?? null }); recovery.handleReconnected(details); });
  connection.on('reconnectFailed', (details: { attempts?: number; downtimeMs?: number }) => { recovery.fault('RECONNECT_FAILED'); forwardJournal.appendEvent(forwardDate, 'RECONNECT_FAILED', ['RECONNECT_FAILED', 'DATA_GAP', 'CRITICAL_DATA_QUALITY'], { attempts: details.attempts ?? null, downtimeMs: details.downtimeMs ?? null }); void host?.fault(new Error('RECONNECT_FAILED')); });
  // ConnectionManager emits 'connected' on every successful open, cold start and reconnect alike ('reconnected' fires immediately after it on a reconnect). handleInitialConnected() only has an effect the very first time it runs, so this cannot reset or race the reconnect state machine driven by 'unexpectedDisconnect' / 'reconnected' above.
  connection.on('connected', (details: { generationId: number }) => { recovery.handleInitialConnected({ generationId: details.generationId }); });
  host = new StrategyHostLifecycle({ strategyId:v4MomentumShadowStrategyId, runtimeId:'shadow:v4:momentum', eodCoordinator, hooks:{warmup:()=>undefined,
    // Historical warmup already ran above. This is the LIVE gate: RUNNING (reason=MARKET_DATA_READY) must not be granted until an accepted, usable, current-generation NIFTY event has actually been observed.
    onReady: async () => { const ready = recovery.waitUntilReady(startupReadyTimeoutMs); ready.catch(() => undefined); await subscriptions.subscribe(nifty, MarketDataSubscriptionMode.FULL); await ready; },
    onEod:(reason)=>finishEod(reason ?? 'VALID_COMPLETED'),onShutdown:(reason)=>shutdown(reason ?? 'SESSION_END'),onFault:()=>shutdown('FAULTED')}, log:v=>console.log(`[STRATEGY_HOST_STATE] strategyId=${v.strategyId} runtimeId=${v.runtimeId} previous=${v.previous} state=${v.state} reason=${v.reason}`) });
  // host.start() itself owns the initial RUNNING transition via its onReady hook; only a genuine post-startup recovery may call host.recovered() here, gated by startupComplete.
  recovery.on('stateChanged',(state)=>{if(state==='DEGRADED')void host?.degrade('MARKET_DATA_DEGRADED');if(state==='READY'){if(!health.confirmRecoveryReady(recovery.getGenerationId()))connection.failRecovery(recovery.getGenerationId(),'RECOVERY_READY_WITHOUT_HEALTH_EVIDENCE');else if(startupComplete)void host?.recovered('MARKET_DATA_READY');}if(state==='FAULTED')connection.failRecovery(recovery.getGenerationId(),'RECOVERY_COORDINATOR_FAULTED');});
  process.once('SIGINT', () => { void host?.shutdown('SIGINT'); }); process.once('SIGTERM', () => { void host?.shutdown('SIGTERM'); });
  connection.on('message', onMessage); eventBus.on('market.tick', onTick); eventBus.on('market.candle.completed', onCandle); candleEvents.start(); health.start();
  await host.start();
  if (host.getState() !== 'RUNNING') return;
  startupComplete = true; // the persistent recovery listener may now own DEGRADED -> RUNNING for any later, genuine reconnect recovery
  console.log(`[V4_STARTUP] strategyId=${v4MomentumShadowStrategyId} shadowOnly=true paperOrders=false brokerOrders=false journal=${journalPath}`);
}
function isNifty(value: string): boolean { return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === 'NIFTY50' || value.trim().toUpperCase() === 'NIFTY'; }
function format(value: Date): string { return formatter.format(value); } function num(value: number | null): string { return value === null ? 'N/A' : value.toFixed(4); } function message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error.'; }
function istDate(value: Date): string { const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; }
void run().catch((error) => { console.error('[V4_SHADOW_FATAL]', message(error)); process.exitCode = 1; });
