import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import OptionPremiumPathAnalysisService from '../modules/options/services/option-premium-path-analysis.service';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import { OptionContract, OptionContractType } from '../modules/options/types';
import { CrossSessionPreparedSession, filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import { PreparedOptionSignalResolution, prepareOptionSignalResolution } from './helpers/prepared-option-signal-resolution';
import { chooseHistoricalOptionExpiry } from './helpers/v3-option-cache-diagnostics';
import { matchesTrendDirectionalEma35Pullback } from './helpers/trend-directional-ema35-pullback';
import { assertV4NoLookAhead, createV4Configs, generateV4Signals, V4Config, V4Family, V4IndicatorContext, V4Signal, v4ConfigKey, v4MarketMinute } from './helpers/v4-structural-signal-generation';

dotenv.config();
logger.silent = true;

const instrumentKey = 'NSE_INDEX|Nifty 50';
const endDate = process.env.RESEARCH_END_DATE?.trim() || '2026-08-04';
const policyValues = [2, 3, 4, 5] as const;
const holds = [5, 7, 10, 15] as const;
const costs = [0.2, 0.4, 0.6] as const;
const qualityMinimum = 30;
type Family = 'OPENING_RANGE' | 'MOMENTUM_EXPANSION';
interface Resolved { entryPremium: number; mfe5: number | null; mae5: number | null; exits: Map<string, OptionExitPolicyEvaluationResult>; }
interface RecordValue { signal: V4Signal; resolution: Resolved; }
interface Report { config: V4Config; signals: V4Signal[]; resolved: RecordValue[]; failed: number; }
interface Metric { target: number; stop: number; hold: number; total: number; targetCount: number; stopCount: number; timeCount: number; ambiguous: number; unavailable: number; targetRate: number; stopRate: number; grossAverage: number; grossMedian: number; returns: number[]; }
interface Candidate { report: Report; metric: Metric; }
interface IndexedContract { contract: OptionContract; expiryDate: string; }
interface ExpiryContractIndex { underlying: string; byDirection: ReadonlyMap<OptionContractType, readonly IndexedContract[]>; }

const istDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw new Error('V4 outcomes require RESEARCH_LOCAL_ONLY=true.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env.');
  const underlyingRepository = new HistoricalCandleRepository();
  const optionRepository = new HistoricalOptionCandleRepository();
  const cache = new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token));
  const preloader = new HistoricalOptionResearchPreloaderService(underlyingRepository, optionRepository, cache, true);
  const engine = new IndicatorEngineService();
  const aggregator = new CandleTimeframeAggregatorService();
  const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.1, lowVolatilityThreshold: 0.05 });
  const underlying = await preloader.preloadUnderlying(instrumentKey, '1minute');
  const complete = [...underlying.underlyingByDate.entries()].filter(([, candles]) => completeSession(candles)).sort(([a], [b]) => a.localeCompare(b));
  const sessions = filterCrossSessionResearchTargets(prepareCrossSessionIndicatorWarmup(complete.map(([date, candles]) => ({ date, candles })), aggregator, engine, regimeService), endDate);
  if (sessions.length !== 104) throw new Error(`Expected 104 NIFTY V4 target sessions through ${endDate}; found ${sessions.length}.`);
  const indicators = createIndicators(sessions, engine);
  const grids = createV4Configs();
  const signalSets = new Map<string, V4Signal[]>();
  const configs: V4Config[] = [...grids.OPENING_RANGE, ...grids.MOMENTUM_EXPANSION];
  configs.forEach((config) => {
    const signals = generateV4Signals(sessions, config, indicators);
    assertV4NoLookAhead(signals);
    signalSets.set(v4ConfigKey(config), signals);
  });
  const uniqueSignals = uniqueDirectionalSignals([...signalSets.values()].flat());
  console.log('NIFTY V4 STRUCTURAL OUTCOME RESEARCH', { targetSessions: sessions.length, endDate, openingRangeConfigs: grids.OPENING_RANGE.length, momentumConfigs: grids.MOMENTUM_EXPANSION.length, uniqueDirectionalSignalTimestamps: uniqueSignals.length, localOnly: true });
  console.log('No-look-ahead validation passed for all V4 signals.');

  const metadataClient = new UpstoxExpiredOptionClient(token);
  const expiries = new Map<string, Promise<string[]>>();
  const contracts = new Map<string, Promise<ExpiryContractIndex>>();
  const prepared = await mapConcurrent(uniqueSignals, 3, (signal) => prepare(signal, metadataClient, expiries, contracts));
  await preloader.preloadOptionSessions(prepared);
  const resolutionBySignal = new Map<string, Resolved>();
  const failures: Array<{ signal: V4Signal; error: string }> = [];
  await mapConcurrent(prepared, 12, async (item) => {
    try { resolutionBySignal.set(signalKey(item.signal), await resolve(item, preloader)); }
    catch (error) { failures.push({ signal: item.signal, error: error instanceof Error ? error.message : String(error) }); }
  });
  // A completed entry candle at 15:29 is available only at 15:30, outside the
  // validated 09:15–15:29 option session. Keep that signal in its configuration's
  // signal count but exclude it from resolved-premium metrics, as the existing
  // research runners do for an unavailable historical entry premium.
  if (failures.length > 0) {
    const reasons = [...new Map(failures.map((failure) => [failure.error, 0])).keys()]
      .slice(0, 3);
    console.log('UNRESOLVED OPTION ENTRIES', { count: failures.length, treatment: 'excluded from resolved outcome metrics', examples: reasons });
  }
  const reports = configs.map((config) => {
    const signals = signalSets.get(v4ConfigKey(config)) ?? [];
    const resolved = signals.flatMap((signal) => { const resolution = resolutionBySignal.get(signalKey(signal)); return resolution ? [{ signal, resolution }] : []; });
    return { config, signals, resolved, failed: signals.length - resolved.length };
  });
  if (process.env.RESEARCH_VALIDATION_MATRIX === 'true') writeV4SessionResultMatrix(reports, sessions);
  const v2Signals = frozenV2Signals(sessions);
  const openingRangeReports = reports.filter((report) => report.config.family === 'OPENING_RANGE');
  printFamily('OPENING RANGE — ALL SUBFAMILIES', openingRangeReports, sessions, v2Signals);
  printFamily('OPENING RANGE A1 — BREAKOUT + RETEST', openingRangeReports.filter((report) => report.config.family === 'OPENING_RANGE' && report.config.setup.startsWith('BREAKOUT_RETEST')), sessions, v2Signals);
  printFamily('OPENING RANGE A2 — FAILED BREAKOUT', openingRangeReports.filter((report) => report.config.family === 'OPENING_RANGE' && report.config.setup.startsWith('FAILED_BREAKOUT')), sessions, v2Signals);
  printFamily('MOMENTUM EXPANSION', reports.filter((report) => report.config.family === 'MOMENTUM_EXPANSION'), sessions, v2Signals);
  const preload = preloader.getStats();
  console.log('V4 PERFORMANCE / CACHE', { uniquePathAnalyses: resolutionBySignal.size, policiesDerived: resolutionBySignal.size * 64, preloader: preload, upstoxDownloads: preload.upstoxMissingSessionDownloads, dbFallbackHits: preload.dbFallbackHits, inMemoryLookupHits: preload.inMemoryLookupHits });
  if (preload.upstoxMissingSessionDownloads !== 0 || preload.dbFallbackHits !== 0) throw new Error('V4 outcome run violated local-preloaded cache expectations.');
}

function createIndicators(sessions: readonly CrossSessionPreparedSession[], engine: IndicatorEngineService): V4IndicatorContext {
  const vwapByFrame = new Map(([1, 2, 3, 5] as const).map((timeframe) => [timeframe, new Map(sessions.flatMap((session) => scalar(engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.VWAP }] }), IndicatorType.VWAP)))]));
  const atr14ByFrame = new Map(([1, 2, 3, 5] as const).map((timeframe) => [timeframe, new Map(sessions.flatMap((session) => { const values = new Map(scalar(engine.calculate(session.frames[timeframe].allCandles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }), IndicatorType.ATR, 14)); return session.frames[timeframe].candles.flatMap((candle) => values.has(candle.timestamp.getTime()) ? [[candle.timestamp.getTime(), values.get(candle.timestamp.getTime())!] as [number, number]] : []); }))]));
  return { vwapByFrame, atr14ByFrame };
}

async function prepare(signal: V4Signal, client: UpstoxExpiredOptionClient, expiryCache: Map<string, Promise<string[]>>, contractCache: Map<string, Promise<ExpiryContractIndex>>): Promise<PreparedOptionSignalResolution<V4Signal>> {
  const list = await cached(expiryCache, instrumentKey, () => client.fetchAvailableExpiries(instrumentKey));
  const expiry = chooseHistoricalOptionExpiry(list, signal.date);
  const available = await cached(contractCache, expiry, async () => indexContracts(await client.fetchExpiredOptionContracts(instrumentKey, expiry)));
  const contract = selectIndexedContract(available, signal);
  return prepareOptionSignalResolution(signal, contract, signal.date);
}

// Equivalent to OptionContractSelectorService.select for this expired-contract
// response. It moves invariant expiry conversion and direction filtering outside
// the per-signal hot path; expiry, ATM, and tie-break semantics are unchanged.
function indexContracts(contracts: readonly OptionContract[]): ExpiryContractIndex {
  const underlying = contracts[0]?.underlying;
  if (!underlying) throw new Error('Missing historical option underlying metadata.');
  const byDirection = new Map<OptionContractType, readonly IndexedContract[]>();
  (['CE', 'PE'] as const).forEach((direction) => {
    byDirection.set(direction, contracts
      .filter((contract) => contract.underlying === underlying && contract.optionType === direction && Number.isFinite(contract.strikePrice) && contract.strikePrice > 0)
      .map((contract) => ({ contract, expiryDate: istDate(contract.expiry) })));
  });
  return { underlying, byDirection };
}

function selectIndexedContract(index: ExpiryContractIndex, signal: V4Signal): OptionContract {
  const matching = (index.byDirection.get(signal.direction) ?? []).filter((candidate) => candidate.expiryDate >= signal.date);
  if (matching.length === 0) throw new Error(`No non-expired ${signal.direction} contract is available for ${signal.date}.`);
  const nearestExpiryDate = matching.reduce((nearest, candidate) => candidate.expiryDate < nearest ? candidate.expiryDate : nearest, matching[0].expiryDate);
  return matching
    .filter((candidate) => candidate.expiryDate === nearestExpiryDate)
    .sort((left, right) =>
      Math.abs(left.contract.strikePrice - signal.spotPrice) - Math.abs(right.contract.strikePrice - signal.spotPrice)
      || left.contract.strikePrice - right.contract.strikePrice
      || left.contract.instrumentKey.localeCompare(right.contract.instrumentKey)
      || left.contract.tradingSymbol.localeCompare(right.contract.tradingSymbol),
    )[0].contract;
}

function istDate(value: Date): string {
  const parts = Object.fromEntries(istDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function resolve(prepared: PreparedOptionSignalResolution<V4Signal>, preloader: HistoricalOptionResearchPreloaderService): Promise<Resolved> {
  // The required instrument/date session was validated and bulk-preloaded above.
  // getOptionSession therefore returns only the in-memory session and cannot issue a
  // database fallback or a remote download in this local-only outcome run.
  const candles = await preloader.getOptionSession(prepared);
  const path = new OptionPremiumPathAnalysisService(prepared.signal.timestamp, candles);
  const analytics = path.researchAnalytics({
    changeHorizons: [],
    excursionHorizons: [5],
    upsideTargets: [],
    downsideStops: [],
  });
  const exits = new Map<string, OptionExitPolicyEvaluationResult>();
  for (const target of policyValues) for (const stop of policyValues) for (const hold of holds) {
    exits.set(policyKey(target, stop, hold), path.evaluate({
      type: 'TARGET_STOP',
      targetPercent: target,
      stopLossPercent: stop,
      maximumHoldingMinutes: hold,
    }));
  }
  const excursion = analytics.excursions.get(5);
  return { entryPremium: analytics.entryPremium, mfe5: excursion?.mfe ?? null, mae5: excursion?.mae ?? null, exits };
}

function metric(records: readonly RecordValue[], target: number, stop: number, hold: number): Metric {
  const exits = records.map((record) => record.resolution.exits.get(policyKey(target, stop, hold))).filter((exit): exit is OptionExitPolicyEvaluationResult => !!exit);
  const settled = exits.filter((exit) => !exit.ambiguous && !exit.unavailable && exit.premiumChangePercent !== null);
  const returns = settled.map((exit) => exit.premiumChangePercent as number);
  const targetCount = exits.filter((exit) => exit.exitReason === 'TARGET').length;
  const stopCount = exits.filter((exit) => exit.exitReason === 'STOP_LOSS').length;
  return { target, stop, hold, total: exits.length, targetCount, stopCount, timeCount: exits.filter((exit) => exit.exitReason === 'TIME_EXIT').length, ambiguous: exits.filter((exit) => exit.ambiguous).length, unavailable: exits.filter((exit) => exit.unavailable).length, targetRate: settled.length ? targetCount / settled.length * 100 : 0, stopRate: settled.length ? stopCount / settled.length * 100 : 0, grossAverage: average(returns), grossMedian: median(returns), returns };
}

function candidates(reports: readonly Report[]): Candidate[] { return reports.flatMap((report) => policyValues.flatMap((target) => policyValues.flatMap((stop) => holds.map((hold) => ({ report, metric: metric(report.resolved, target, stop, hold) })))).filter((candidate) => candidate.metric.total >= qualityMinimum)); }
function viable(candidate: Candidate): boolean { const m = candidate.metric; return m.grossMedian > 0 && m.grossAverage - 0.4 > 0 && m.targetRate > m.stopRate; }
function rank(a: Candidate, b: Candidate): number { return (b.metric.grossAverage - 0.4) - (a.metric.grossAverage - 0.4) || b.metric.grossMedian - a.metric.grossMedian || b.metric.targetRate - a.metric.targetRate || a.metric.stopRate - b.metric.stopRate || b.report.resolved.length - a.report.resolved.length; }
function printFamily(name: string, reports: readonly Report[], sessions: readonly CrossSessionPreparedSession[], v2: readonly V4Signal[]): void {
  const all = candidates(reports); const passed = all.filter(viable); const pool = passed.length ? passed : all; const ranked = [...pool].sort(rank); const frequency = [...pool].sort((a, b) => b.report.resolved.length - a.report.resolved.length || rank(a, b))[0]; const balanced = [...pool].filter((candidate) => candidate.report.resolved.length / sessions.length >= 1).sort(rank)[0] ?? ranked[0];
  console.log(`\n${name} | configs=${reports.length} policies/config=64`, { policyCandidates: all.length, viableAfter040Cost: passed.length, highestSustainableFrequencyPerSession: round(Math.max(0, ...passed.map((candidate) => candidate.report.resolved.length / sessions.length)))});
  if (!ranked[0]) { console.log('No candidate met the 30-trade policy minimum.'); return; }
  console.log('Highest frequency:', line(frequency, sessions)); console.log('Highest quality / cost-adjusted:', line(ranked[0], sessions)); console.log('Best balanced:', line(balanced, sessions));
  console.log('TOP 20'); ranked.slice(0, 20).forEach((candidate, index) => console.log(`${index + 1}. ${line(candidate, sessions)}`));
  const unique = [...new Map([ranked[0], frequency, balanced].map((candidate) => [id(candidate), candidate])).values()];
  unique.forEach((candidate, index) => {
    console.log(`ROBUSTNESS LEADER ${index + 1}:`, line(candidate, sessions));
    console.log('ROBUSTNESS', robustness(candidate, sessions));
    console.log('V2 OVERLAP', viable(candidate) ? overlap(candidate, v2, sessions) : 'Not evaluated: candidate does not pass the V4 0.40%-cost viability screen.');
  });
}
function line(candidate: Candidate, sessions: readonly CrossSessionPreparedSession[]): string { const m = candidate.metric; return `${v4ConfigKey(candidate.report.config)} | +${m.target}/-${m.stop}/${m.hold}m | resolved=${candidate.report.resolved.length} freq=${(candidate.report.resolved.length / sessions.length).toFixed(2)}/session active=${frequency(candidate, sessions).averageTradesPerActiveSession.toFixed(2)} | target=${m.targetRate.toFixed(2)} stop=${m.stopRate.toFixed(2)} time=${m.timeCount} ambiguous=${m.ambiguous} unavailable=${m.unavailable} | gross=${m.grossAverage.toFixed(2)} median=${m.grossMedian.toFixed(2)} net20=${(m.grossAverage - .2).toFixed(2)} net40=${(m.grossAverage - .4).toFixed(2)} net60=${(m.grossAverage - .6).toFixed(2)} | MFE5=${average(candidate.report.resolved.map((r) => r.resolution.mfe5).filter((v): v is number => v !== null)).toFixed(2)} MAE5=${average(candidate.report.resolved.map((r) => r.resolution.mae5).filter((v): v is number => v !== null)).toFixed(2)}`; }
function frequency(candidate: Candidate, sessions: readonly CrossSessionPreparedSession[]) { const counts = sessions.map((session) => candidate.report.resolved.filter((record) => record.signal.date === session.date).length); const active = counts.filter((count) => count > 0); return { tradesPerSession: round(candidate.report.resolved.length / sessions.length), averageTradesPerActiveSession: round(candidate.report.resolved.length / Math.max(1, active.length)), daysWith0Trades: counts.filter((count) => count === 0).length, daysWith1To4Trades: counts.filter((count) => count >= 1 && count <= 4).length, daysWith5To9Trades: counts.filter((count) => count >= 5 && count <= 9).length, daysWith10PlusTrades: counts.filter((count) => count >= 10).length, maximumTradesInOneDay: Math.max(...counts) }; }
function robustness(candidate: Candidate, sessions: readonly CrossSessionPreparedSession[]) { const m = candidate.metric; const summarize = (records: readonly RecordValue[]) => { const x = metric(records, m.target, m.stop, m.hold); return { trades: records.length, grossAverage: round(x.grossAverage), netAverageAt040: round(x.grossAverage - .4), grossMedian: round(x.grossMedian), targetRate: round(x.targetRate), stopRate: round(x.stopRate) }; }; const months = [['March','2026-03'],['April','2026-04'],['May','2026-05'],['June','2026-06'],['July','2026-07'],['Aug 1-4','2026-08']].map(([month,prefix]) => ({ month, ...summarize(candidate.report.resolved.filter((r) => r.signal.date.startsWith(prefix)))})); const mid = Math.floor(sessions.length / 2); const h1 = new Set(sessions.slice(0, mid).map((s) => s.date)); const h2 = new Set(sessions.slice(mid).map((s) => s.date)); const returns = m.returns; const sorted = [...returns].sort((a,b) => a-b); const daily = sessions.map((s) => candidate.report.resolved.filter((r) => r.signal.date === s.date).map((r) => r.resolution.exits.get(policyKey(m.target,m.stop,m.hold))).filter((e): e is OptionExitPolicyEvaluationResult => !!e && !e.ambiguous && !e.unavailable && e.premiumChangePercent !== null).reduce((sum,e) => sum + (e.premiumChangePercent ?? 0),0)); const positive = returns.filter((v) => v > 0).reduce((a,b) => a+b,0); return { monthly: months, halves: [{ period:'First half',...summarize(candidate.report.resolved.filter((r) => h1.has(r.signal.date)))},{period:'Second half',...summarize(candidate.report.resolved.filter((r) => h2.has(r.signal.date)))}], frequency: frequency(candidate,sessions), profitableDayPercent: round(daily.filter((v) => v > 0).length / Math.max(1,daily.filter((v) => v !== 0).length) * 100), maximumLosingTradeStreak: streak([...candidate.report.resolved].sort((a,b) => a.signal.timestamp.getTime()-b.signal.timestamp.getTime()).map((r) => (r.resolution.exits.get(policyKey(m.target,m.stop,m.hold))?.premiumChangePercent ?? 0) < 0)), maximumLosingDayStreak: streak(daily.map((v) => v < 0)), averageExcludingBest5: round(average(sorted.slice(0, Math.max(0,sorted.length-5)))), best5ContributionPercent: round(positive ? sorted.slice(-5).filter((v) => v > 0).reduce((a,b) => a+b,0) / positive *100 : 0), largestWinner: round(sorted.at(-1) ?? 0), largestLoser: round(sorted[0] ?? 0) }; }
function writeV4SessionResultMatrix(reports: readonly Report[], sessions: readonly CrossSessionPreparedSession[]): void {
  const frozen = reports.find((report) => report.config.family === 'MOMENTUM_EXPANSION' && report.config.timeframe === 3 && report.config.compressionBars === 3 && report.config.compressionRangeAtr === 2 && report.config.bodyAtr === 1 && report.config.breakoutAtr === 0.1 && !report.config.requireVwapAlignment && report.config.requirePrimaryRegimeAlignment && report.config.cooldownMinutes === 5 && report.config.direction === 'PE');
  if (!frozen) throw new Error('Frozen V4 Momentum PE configuration was not present in the generated grid.');
  const costs = [0.2, 0.4, 0.6, 0.8, 1.0] as const;
  const rows = sessions.map((session, sessionIndex) => {
    const records = frozen.resolved.filter((record) => record.signal.date === session.date).sort((left, right) => left.signal.timestamp.getTime() - right.signal.timestamp.getTime());
    const exits = records.map((record) => record.resolution.exits.get(policyKey(5, 5, 15)));
    const settled = exits.filter((exit): exit is OptionExitPolicyEvaluationResult => !!exit && !exit.ambiguous && !exit.unavailable && exit.premiumChangePercent !== null);
    const returns = settled.map((exit) => exit.premiumChangePercent as number);
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    returns.forEach((value) => { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); });
    const gross = returns.reduce((sum, value) => sum + value, 0);
    return {
      sessionIndex,
      date: session.date,
      signalCount: frozen.signals.filter((signal) => signal.date === session.date).length,
      settledTrades: settled.length,
      grossDailyReturn: round(gross),
      netDailyReturnByCost: Object.fromEntries(costs.map((cost) => [`netAt${Math.round(cost * 100).toString().padStart(3, '0')}`, round(gross - cost * settled.length)])),
      targetCount: exits.filter((exit) => exit?.exitReason === 'TARGET').length,
      stopCount: exits.filter((exit) => exit?.exitReason === 'STOP_LOSS').length,
      timeoutCount: exits.filter((exit) => exit?.exitReason === 'TIME_EXIT').length,
      ambiguousCount: exits.filter((exit) => exit?.ambiguous).length,
      unavailableCount: exits.filter((exit) => exit?.unavailable).length,
      maxIntradayDrawdown: round(maxDrawdown),
      tradeReferences: records.map((record) => { const exit = record.resolution.exits.get(policyKey(5, 5, 15)); return { timestamp: record.signal.timestamp.toISOString(), direction: record.signal.direction, outcome: exit?.exitReason ?? 'UNAVAILABLE', returnPercent: round(exit?.premiumChangePercent ?? 0) }; }),
    };
  });
  const directory = resolvePath(process.cwd(), 'artifacts', 'research-validation');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolvePath(directory, 'v4-session-result-matrix.json'), `${JSON.stringify({ version: 'research-session-result-matrix-v1', strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW', family: 'V4', configId: '3m|compression3|range<=2ATR|body>=1ATR|breakout0.1ATR|TREND_DOWN|cooldown5m', policy: { target: 5, stop: 5, holdMinutes: 15 }, splitManifestVersion: 'nifty-104-split-v1', costScenarios: costs, sessions: rows, resultMatrix: { sessions: rows.map((row) => row.date), configurations: ['V4_NIFTY_MOMENTUM_PE_SHADOW|+5/-5/15'], costPercent: 0.4, values: rows.map((row) => [row.netDailyReturnByCost.netAt040]) } }, null, 2)}\n`);
}
function overlap(candidate: Candidate, v2: readonly V4Signal[], sessions: readonly CrossSessionPreparedSession[]) {
  // Frozen V2 is a PE-only strategy. CE signals are structurally independent of it,
  // even if their completed-candle timestamps happen to coincide.
  const comparable = candidate.report.resolved.filter((record) => record.signal.direction === 'PE');
  const v2Times = new Set(v2.map((signal) => signal.timestamp.getTime()));
  const exact = comparable.filter((record) => v2Times.has(record.signal.timestamp.getTime())).length;
  const near = comparable.filter((record) => v2.some((signal) => Math.abs(signal.timestamp.getTime() - record.signal.timestamp.getTime()) <= 5 * 60_000)).length;
  return {
    comparablePeTrades: comparable.length,
    exactSameTimestampOverlaps: exact,
    overlapsWithinPlusMinus5Minutes: near,
    independentPercent: round((candidate.report.resolved.length - exact) / Math.max(1, candidate.report.resolved.length) * 100),
    incrementalTradesPerSessionAfterExactDuplicateRemoval: round((candidate.report.resolved.length - exact) / sessions.length),
  };
}
function frozenV2Signals(sessions: readonly CrossSessionPreparedSession[]): V4Signal[] { const result: V4Signal[]=[]; sessions.forEach((session) => { let last: number|undefined; session.frames[5].candles.forEach((candle) => { const timestamp=candle.timestamp.getTime()+5*60_000; const regime=latestRegime(session,timestamp); const key=candle.timestamp.getTime(); const ema=session.frames[5].ema35.get(key); const rsi=session.frames[5].rsi14.get(key); if (regime?.regime!==AdaptivePrimaryMarketRegime.TREND_DOWN || ema===undefined || rsi===undefined || !matchesTrendDirectionalEma35Pullback({direction:'DOWN',close:candle.close,high:candle.high,low:candle.low,ema35:ema,rsi,proximity:.2,rsiFilter:'RSI_LT_35'}) || (last!==undefined && timestamp-last<10*60_000)) return; result.push({family:'MOMENTUM_EXPANSION',configKey:'FROZEN_V2',date:session.date,timestamp:new Date(timestamp),spotPrice:candle.close,direction:'PE',regimeAvailableAt:regime.availableAt}); last=timestamp; }); }); return result; }
function latestRegime(session: CrossSessionPreparedSession, time: number) { return [...session.regimePoints].reverse().find((r) => r.availableAt.getTime() <= time); }
function scalar(results: IndicatorEngineResult, type: IndicatorType, period?: number): Array<[number,number]> { const found=results.indicators.find((x) => x.config.type===type && (period===undefined || ('period'in x.config&&x.config.period===period))); if(!found) throw new Error(`Missing ${type}`); return found.result.values.flatMap((v)=>'value'in v&&typeof v.value==='number'?[[v.timestamp.getTime(),v.value] as [number,number]]:[]); }
function completeSession(candles: readonly {timestamp:Date}[]) { if(candles.length!==375)return false; const s=[...candles].sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime()); return v4MarketMinute(s[0].timestamp)===555&&v4MarketMinute(s[374].timestamp)===929&&s.every((x,i)=>i===0||x.timestamp.getTime()-s[i-1].timestamp.getTime()===60_000); }
function uniqueDirectionalSignals(signals:readonly V4Signal[]) { return [...new Map(signals.map((s)=>[signalKey(s),s])).values()]; }
function signalKey(signal:V4Signal){return `${signal.direction}\u0000${signal.timestamp.getTime()}`;} function policyKey(t:number,s:number,h:number){return `${t}|${s}|${h}`;} function cached<T>(m:Map<string,Promise<T>>,k:string,f:()=>Promise<T>){const x=m.get(k);if(x)return x;const y=f();m.set(k,y);return y;} async function mapConcurrent<T,R>(items:readonly T[],n:number,f:(x:T)=>Promise<R>){const r=new Array<R>(items.length);let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(true){const j=i++;if(j>=items.length)return;r[j]=await f(items[j]);}}));return r;} function average(v:readonly number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;} function median(v:readonly number[]){if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;} function round(v:number){return Number(v.toFixed(2));} function streak(v:readonly boolean[]){let c=0,b=0;v.forEach((x)=>{c=x?c+1:0;b=Math.max(b,c);});return b;} function id(c:Candidate){return `${v4ConfigKey(c.report.config)}|${policyKey(c.metric.target,c.metric.stop,c.metric.hold)}`;}

run().catch((error)=>{console.error('NIFTY V4 structural outcome research failed.',error);process.exitCode=1;});
