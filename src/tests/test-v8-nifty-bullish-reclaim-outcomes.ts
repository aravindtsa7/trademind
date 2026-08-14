import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { Candle } from '../modules/indicators/types';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionPremiumPathAnalysisService from '../modules/options/services/option-premium-path-analysis.service';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import { OptionContract, OptionContractType } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { chooseHistoricalOptionExpiry } from './helpers/v3-option-cache-diagnostics';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup, CrossSessionPreparedSession } from './helpers/cross-session-indicator-warmup';
import { assertV8NoLookAhead, assertV8TrainOnlyDates, createV8BullishReclaimConfigs, generateV8BullishReclaimSignals, selectV8TrainOnlyWinner, V8BullishReclaimConfig, V8BullishReclaimSignal, V8IndicatorContext, V8PreparedSession, V8_STRATEGY_ID, V8_TRAIN_FREEZE_SELECTION_POLICY, v8ConfigKey, v8FrozenStrategyFingerprint, v8FrozenStrategyInputs } from '../modules/research/v8-nifty-bullish-reclaim';
import { deflatedSharpeRatio, resultMatrix, simplifiedPbo } from '../modules/research-validation';
import { ResearchSplitManifest } from '../modules/research-validation/types/research-validation.types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import logger from '../core/logger/logger';

logger.silent = true;

const UNDERLYING = 'NSE_INDEX|Nifty 50';
const END_DATE = process.env.RESEARCH_END_DATE?.trim() || '2026-08-04';
const TRAIN_ONLY_FREEZE = process.env.V8_TRAIN_ONLY_FREEZE === 'true';
const LEGACY_VALIDATION_DIAGNOSTIC = process.env.V8_LEGACY_VALIDATION_DIAGNOSTIC === 'true';
if (TRAIN_ONLY_FREEZE && LEGACY_VALIDATION_DIAGNOSTIC) throw new Error('V8 cannot run TRAIN freeze and legacy validation diagnostic together.');
const FREEZE_DIRECTORY = resolve(process.cwd(), 'artifacts', 'v8-nifty-bullish-reclaim', 'train-only-freeze-v1');
const DIRECTORY = LEGACY_VALIDATION_DIAGNOSTIC ? FREEZE_DIRECTORY : resolve(process.cwd(), 'artifacts', 'v8-nifty-bullish-reclaim', ...(TRAIN_ONLY_FREEZE ? ['train-only-freeze-v1'] : []));
const SPLIT_PATH = resolve(process.cwd(), 'artifacts', 'research-validation', 'nifty-104-split-v1.json');
const POLICIES = [
  { target: 4, stop: 4, hold: 10 }, { target: 4, stop: 4, hold: 15 }, { target: 4, stop: 4, hold: 20 },
  { target: 5, stop: 5, hold: 10 }, { target: 5, stop: 5, hold: 15 }, { target: 5, stop: 5, hold: 20 },
  { target: 6, stop: 5, hold: 10 }, { target: 6, stop: 5, hold: 15 }, { target: 6, stop: 5, hold: 20 },
] as const;
const COSTS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;
type Policy = typeof POLICIES[number];
type Split = 'TRAIN' | 'VALIDATION';
interface Prepared { signal: V8BullishReclaimSignal; selectedContract: OptionContract; instrumentKey: string; tradingDate: string; metadata: { tradingSymbol: string; optionType: OptionContractType; strikePrice: number; expiry: Date }; }
interface Resolution { selectedContract?: OptionContract; exits: ReadonlyMap<string, OptionExitPolicyEvaluationResult>; }
interface SubsetSummary { signals: number; resolvedTrades: number; settledTrades: number; unavailableTrades: number; grossAverage: number; grossMedian: number; netAt040: number; targetRate: number; stopRate: number; timeoutRate: number; ambiguousRate: number; unavailableRate: number; }
interface CandidateMetric { id: string; config: V8BullishReclaimConfig; policy: Policy; totalSignals: number; resolvedTrades: number; settledTrades: number; unavailableTrades: number; targetCount: number; stopCount: number; timeoutCount: number; ambiguousCount: number; grossAverage: number; grossMedian: number; netAt020: number; netAt040: number; netAt060: number; netAt080: number; netAt100: number; targetRate: number; stopRate: number; timeoutRate: number; ambiguousRate: number; unavailableRate: number; maxDrawdown: number; maxLosingStreak: number; profitableDayPercent: number; dailyGross: number[]; dailyNet40: number[]; train: SubsetSummary; validation: SubsetSummary; }
interface RecordValue { signal: V8BullishReclaimSignal; exit: OptionExitPolicyEvaluationResult; }

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw new Error('V8 Phase 2 requires RESEARCH_LOCAL_ONLY=true.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  const manifest = JSON.parse(readFileSync(SPLIT_PATH, 'utf8')) as ResearchSplitManifest;
  const splitByDate = new Map(manifest.sessions.map((entry) => [entry.tradingDate, entry.split]));
  const allowedDates = manifest.sessions.filter((entry) => (TRAIN_ONLY_FREEZE ? entry.split === 'TRAIN' : LEGACY_VALIDATION_DIAGNOSTIC ? entry.split === 'VALIDATION' : entry.split === 'TRAIN' || entry.split === 'VALIDATION') && entry.tradingDate <= END_DATE).map((entry) => entry.tradingDate);
  const expectedSessions = TRAIN_ONLY_FREEZE ? 60 : LEGACY_VALIDATION_DIAGNOSTIC ? 20 : 80;
  if (allowedDates.length !== expectedSessions) throw new Error(`Expected ${expectedSessions} allowed V8 sessions; found ${allowedDates.length}.`);
  const dates = [...allowedDates].sort();
  const dateIndex = new Map(dates.map((date, index) => [date, index]));

  const optionRepository = new HistoricalOptionCandleRepository();
  const underlyingRepository = new HistoricalCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(underlyingRepository, optionRepository, new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token ?? 'RESEARCH_LOCAL_ONLY_NO_NETWORK')), true);
  const sessions = await loadSessions(preloader, splitByDate, dates);
  const indicators = createIndicators(sessions, new IndicatorEngineService());
  const frozenInput = LEGACY_VALIDATION_DIAGNOSTIC ? JSON.parse(readFileSync(resolve(FREEZE_DIRECTORY, 'frozen-candidate.json'), 'utf8')) as { candidate: { id: string; config: V8BullishReclaimConfig; policy: Policy } } : undefined;
  const configs = createV8BullishReclaimConfigs().filter((config) => !frozenInput || v8ConfigKey(config) === v8ConfigKey(frozenInput.candidate.config));
  const policies = POLICIES.filter((policy) => !frozenInput || policyKey(policy) === policyKey(frozenInput.candidate.policy));
  if (LEGACY_VALIDATION_DIAGNOSTIC && (configs.length !== 1 || policies.length !== 1)) throw new Error('Frozen V8 candidate was not represented exactly once in the frozen grid.');
  const signalsByConfig = new Map<string, V8BullishReclaimSignal[]>();
  const uniqueSignals = new Map<string, V8BullishReclaimSignal>();
  configs.forEach((config) => {
    const signals = generateV8BullishReclaimSignals(sessions, config, indicators);
    assertV8NoLookAhead(signals);
    signalsByConfig.set(v8ConfigKey(config), signals);
    signals.forEach((signal) => uniqueSignals.set(signalKey(signal), uniqueSignals.get(signalKey(signal)) ?? signal));
  });

  const selector = new OptionContractSelectorService();
  const contractsByDate = localContractsByDate(await optionRepository.findContractMetadataForTradingDates(dates), dates);
  const preparedValues = await mapConcurrent([...uniqueSignals.values()], 4, async (signal) => prepare(signal, selector, contractsByDate));
  const required = [...new Map(preparedValues.map((item) => [`${item.instrumentKey}\u0000${item.tradingDate}`, item])).values()];
  const inspection = await preloader.inspectLocalOptionSessions(required);
  const coverage = { required: inspection.uniqueRequiredSessions, complete: inspection.completeLocalSessions, missing: inspection.missingLocalSessions, incomplete: inspection.incompleteLocalSessions };
  const completeKeys = new Set(inspection.sessions.filter((session) => session.complete).map((session) => `${session.instrumentKey}\u0000${session.tradingDate}`));
  const completePrepared = preparedValues.filter((item) => completeKeys.has(`${item.instrumentKey}\u0000${item.tradingDate}`));
  // Strictly local research: a missing cached option path is an unavailable
  // outcome, never a reason to contact Upstox or to discard the whole grid.
  await preloader.preloadOptionSessions(completePrepared);
  const preload = preloader.getStats();
  if (preload.upstoxMissingSessionDownloads !== 0 || preload.dbFallbackHits !== 0) throw new Error(`Unexpected option cache activity: ${JSON.stringify(preload)}.`);

  const resolutions = new Map<string, Resolution>();
  await mapConcurrent(preparedValues, 10, async (item) => {
    if (!completeKeys.has(`${item.instrumentKey}\u0000${item.tradingDate}`)) {
      const exits = new Map<string, OptionExitPolicyEvaluationResult>();
      policies.forEach((policy) => exits.set(policyKey(policy), unavailableExit(item.signal, policy)));
      resolutions.set(signalKey(item.signal), { selectedContract: item.selectedContract, exits });
      return;
    }
    try {
      const candles = await preloader.getOptionSession(item);
      const path = new OptionPremiumPathAnalysisService(item.signal.timestamp, candles);
      const exits = new Map<string, OptionExitPolicyEvaluationResult>();
      policies.forEach((policy) => exits.set(policyKey(policy), path.evaluate({ type: 'TARGET_STOP', targetPercent: policy.target, stopLossPercent: policy.stop, maximumHoldingMinutes: policy.hold })));
      resolutions.set(signalKey(item.signal), { selectedContract: item.selectedContract, exits });
    } catch {
      const exits = new Map<string, OptionExitPolicyEvaluationResult>();
      policies.forEach((policy) => exits.set(policyKey(policy), unavailableExit(item.signal, policy)));
      resolutions.set(signalKey(item.signal), { selectedContract: item.selectedContract, exits });
    }
  });

  const metrics: CandidateMetric[] = [];
  configs.forEach((config) => {
    const signals = signalsByConfig.get(v8ConfigKey(config)) ?? [];
    policies.forEach((policy) => metrics.push(calculateMetric(config, policy, signals, resolutions, dates, dateIndex, splitByDate)));
  });
  if (LEGACY_VALIDATION_DIAGNOSTIC) {
    const candidate = metrics[0];
    write('legacy-validation-diagnostic.json', {
      label: 'LEGACY_CONTAMINATED_DIAGNOSTIC',
      strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
      selectionInfluence: 'NONE',
      finalHoldoutAccessed: false,
      dates,
      candidate: serializeMetric(candidate, dates),
      monthly: monthlyBreakdown(candidate, dates),
      firstHalfSecondHalf: halfBreakdown(candidate, dates),
      coverage,
      cache: { ...preloader.getStats(), optionDownloads: 0, writes: 0 },
    });
    console.log(JSON.stringify({ mode: 'LEGACY_CONTAMINATED_DIAGNOSTIC', finalHoldoutAccessed: false, candidate: serializeMetric(candidate, dates), coverage }, null, 2));
    return;
  }
  const groups = candidateGroups(metrics, signalsByConfig, resolutions, dates, dateIndex, splitByDate);
  const frozen = TRAIN_ONLY_FREEZE ? selectV8TrainOnlyWinner(metrics) : undefined;
  const tiers = frequencyTiers(metrics, dates, signalsByConfig, resolutions);
  const parameterFamilies = familyAnalysis(metrics);
  const walkForward = walkForwardDiagnostics(metrics, dates, signalsByConfig, resolutions, dateIndex);
  const multipleTesting = multipleTestingDiagnostics(metrics, dates);
  const overlap = overlapReport(groups.bestBalanced, signalsByConfig);
  const verdict = finalVerdict(groups, multipleTesting);
  mkdirSync(DIRECTORY, { recursive: true });
  const serializedGroups = serializeGroups(groups, dates, signalsByConfig, resolutions, splitByDate);
  write('top-candidates.json', { groups: serializedGroups, frequencyTiers: tiers });
  write('validation-report.json', { split: { mode: TRAIN_ONLY_FREEZE ? 'TRAIN_ONLY_FREEZE' : 'TRAIN_VALIDATION_ONLY', dates: { train: dates.filter((date) => splitByDate.get(date) === 'TRAIN'), validation: TRAIN_ONLY_FREEZE ? [] : dates.filter((date) => splitByDate.get(date) === 'VALIDATION') }, finalHoldoutAccessed: false, validationStatus: TRAIN_ONLY_FREEZE ? 'LEGACY_CONTAMINATED_DIAGNOSTIC_NOT_READ' : undefined }, groups: serializedGroups, walkForward, multipleTesting, verdict });
  write('outcome-summary.json', { strategyId: V8_STRATEGY_ID, phase: TRAIN_ONLY_FREEZE ? 'TRAIN_ONLY_FROZEN_SELECTION' : 'PHASE_2_OUTCOME_RESEARCH', scope: { instrumentKey: UNDERLYING, start: dates[0], end: dates.at(-1), targetSessions: dates.length, includedSplits: TRAIN_ONLY_FREEZE ? ['TRAIN'] : ['TRAIN', 'VALIDATION'], excludedSplits: ['EMBARGO_1', 'EMBARGO_2', 'VALIDATION', 'FINAL_HOLDOUT'].filter((split) => !(!TRAIN_ONLY_FREEZE && split === 'VALIDATION')), currentSessionExcluded: '2026-08-13', finalHoldoutAccessed: false }, configurations: configs.length, policiesPerConfiguration: policies.length, totalPolicyEvaluations: metrics.length, coverage, cache: { ...preload, optionDownloads: preload.upstoxMissingSessionDownloads, writes: preload.newlyStoredOptionCandles }, groups: serializedGroups, frozenCandidate: frozen, frequencyTiers: tiers, parameterFamilies, multipleTesting, overlap, verdict, promotion: { shadowOnly: true, paperEligible: false, liveEligible: false } });
  if (frozen) write('frozen-candidate.json', { strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW', selectionScope: 'TRAIN_ONLY', selectionPolicy: V8_TRAIN_FREEZE_SELECTION_POLICY, finalHoldoutAccessed: false, validationStatus: 'LEGACY_CONTAMINATED_DIAGNOSTIC_NOT_READ', candidate: serializeMetric(frozen, dates), trainDiagnostics: { monthly: monthlyBreakdown(frozen, dates), firstHalfSecondHalf: halfBreakdown(frozen, dates) }, fingerprintInputs: v8FrozenStrategyInputs(frozen), fingerprint: v8FrozenStrategyFingerprint(frozen), promotionStatus: { mode: 'SHADOW_ONLY', paper: 'NOT_ELIGIBLE_FOR_PAPER', live: 'NOT_ELIGIBLE_FOR_LIVE' } });
  console.log(JSON.stringify({ strategyId: V8_STRATEGY_ID, mode: TRAIN_ONLY_FREEZE ? 'TRAIN_ONLY_FREEZE' : 'TRAIN_VALIDATION_ONLY', sessions: dates.length, configurations: configs.length, policiesPerConfiguration: policies.length, totalPolicyEvaluations: metrics.length, frozenCandidate: frozen, coverage, cache: { optionDownloads: preload.upstoxMissingSessionDownloads, newlyStoredRows: preload.newlyStoredOptionCandles, dbFallbackHits: preload.dbFallbackHits }, verdict }, null, 2));
}

async function loadSessions(preloader: HistoricalOptionResearchPreloaderService, splitByDate: ReadonlyMap<string, string>, dates: readonly string[]): Promise<V8PreparedSession[]> {
  if (TRAIN_ONLY_FREEZE) assertV8TrainOnlyDates(dates, splitByDate);
  const dataset = TRAIN_ONLY_FREEZE || LEGACY_VALIDATION_DIAGNOSTIC ? await preloader.preloadUnderlyingRange(UNDERLYING, '1minute', new Date(`${dates[0]}T00:00:00+05:30`), new Date(`${dates.at(-1)}T23:59:59.999+05:30`)) : await preloader.preloadUnderlying(UNDERLYING, '1minute');
  const complete = [...dataset.underlyingByDate.entries()].filter(([date, rows]) => dates.includes(date) && completeSession(rows)).sort(([left], [right]) => left.localeCompare(right));
  const all = prepareCrossSessionIndicatorWarmup(complete.map(([date, candles]) => ({ date, candles })), new CandleTimeframeAggregatorService(), new IndicatorEngineService(), new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 }));
  const allowed = new Set(dates);
  const result = filterCrossSessionResearchTargets(all, END_DATE).filter((session) => allowed.has(session.date)) as V8PreparedSession[];
  if (result.length !== dates.length || result.some((session) => TRAIN_ONLY_FREEZE ? splitByDate.get(session.date) !== 'TRAIN' : !['TRAIN', 'VALIDATION'].includes(splitByDate.get(session.date) ?? ''))) throw new Error('Protected V8 session preparation mismatch.');
  return result;
}

function createIndicators(sessions: readonly V8PreparedSession[], engine: IndicatorEngineService): V8IndicatorContext { const maps = ([2, 3] as const).map((timeframe) => { const values = new Map<number, number>(); sessions.forEach((session) => { const result = engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }); result.indicators.find((entry) => entry.config.type === IndicatorType.ATR)?.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); }); }); return [timeframe, values] as const; }); return { atr14ByFrame: new Map(maps) }; }

async function prepare(signal: V8BullishReclaimSignal, selector: OptionContractSelectorService, contractsByDate: ReadonlyMap<string, readonly OptionContract[]>): Promise<Prepared> {
  const dateContracts = contractsByDate.get(signal.date) ?? [];
  const expiryList = [...new Set(dateContracts.map((contract) => istDate(contract.expiry)))].sort();
  const expiry = chooseHistoricalOptionExpiry(expiryList, signal.date);
  const available = dateContracts.filter((contract) => istDate(contract.expiry) === expiry);
  const underlying = available[0]?.underlying;
  if (!underlying || !available.length) throw new Error(`Local-only V8 contract metadata missing for ${signal.date} expiry ${expiry}.`);
  const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: StrategySignal.BUY_CE, timestamp: signal.timestamp, contracts: available });
  const contract = available.find((entry) => entry.instrumentKey === selected.instrumentKey);
  if (!contract) throw new Error(`Selected local V8 contract ${selected.instrumentKey} was absent.`);
  return { signal, selectedContract: contract, instrumentKey: contract.instrumentKey, tradingDate: signal.date, metadata: { tradingSymbol: contract.tradingSymbol, optionType: contract.optionType, strikePrice: contract.strikePrice, expiry: contract.expiry } };
}

function localContractsByDate(rows: readonly { instrumentKey: string; tradingSymbol: string | null; optionType: string | null; strikePrice: unknown; expiry: Date | null }[], dates: readonly string[]): Map<string, readonly OptionContract[]> {
  const result = new Map<string, OptionContract[]>();
  const requested = new Set(dates);
  rows.forEach((row) => {
    if (!row.optionType || (row.optionType !== 'CE' && row.optionType !== 'PE') || row.strikePrice === null || !row.expiry) return;
    const expiry = new Date(row.expiry.getTime());
    const contract: OptionContract = { instrumentKey: row.instrumentKey, tradingSymbol: row.tradingSymbol ?? row.instrumentKey, underlying: 'NIFTY 50', strikePrice: Number(row.strikePrice), expiry, optionType: row.optionType, exchange: 'NSE', segment: 'FO' };
    dates.forEach((date) => { if (requested.has(date) && expiry.getTime() >= new Date(`${date}T00:00:00+05:30`).getTime()) result.set(date, [...(result.get(date) ?? []), contract]); });
  });
  dates.forEach((date) => { if (!(result.get(date)?.length)) throw new Error(`No local historical option contract metadata available for V8 date ${date}.`); });
  return result;
}
function istDate(timestamp: Date): string { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; }

function calculateMetric(config: V8BullishReclaimConfig, policy: Policy, signals: readonly V8BullishReclaimSignal[], resolutions: ReadonlyMap<string, Resolution>, dates: readonly string[], dateIndex: ReadonlyMap<string, number>, splitByDate: ReadonlyMap<string, string>): CandidateMetric {
  const records = signals.map((signal) => ({ signal, exit: resolutions.get(signalKey(signal))?.exits.get(policyKey(policy)) ?? unavailableExit(signal, policy) }));
  const settled = records.filter((record) => !record.exit.ambiguous && !record.exit.unavailable && record.exit.premiumChangePercent !== null);
  const returns = settled.map((record) => record.exit.premiumChangePercent!);
  const dailyGross = dates.map(() => 0); const dailyCount = dates.map(() => 0);
  settled.forEach((record) => { const index = dateIndex.get(record.signal.date); if (index !== undefined) { dailyGross[index] += record.exit.premiumChangePercent!; dailyCount[index] += 1; } });
  const dailyNet40 = dailyGross.map((value, index) => dailyCount[index] ? value - .4 * dailyCount[index] : 0);
  const train = subsetSummary(records.filter((record) => splitByDate.get(record.signal.date) === 'TRAIN'));
  const validation = subsetSummary(records.filter((record) => splitByDate.get(record.signal.date) === 'VALIDATION'));
  const targetCount = settled.filter((record) => record.exit.exitReason === 'TARGET').length;
  const stopCount = settled.filter((record) => record.exit.exitReason === 'STOP_LOSS').length;
  const timeoutCount = settled.filter((record) => record.exit.exitReason === 'TIME_EXIT').length;
  const ambiguousCount = records.filter((record) => record.exit.ambiguous).length;
  const unavailableCount = records.filter((record) => record.exit.unavailable).length;
  const grossAverage = average(returns);
  return { id: `${v8ConfigKey(config)}|${policyKey(policy)}`, config, policy, totalSignals: records.length, resolvedTrades: records.length - unavailableCount, settledTrades: settled.length, unavailableTrades: unavailableCount, targetCount, stopCount, timeoutCount, ambiguousCount, grossAverage, grossMedian: median(returns), netAt020: returns.length ? grossAverage - .2 : 0, netAt040: returns.length ? grossAverage - .4 : 0, netAt060: returns.length ? grossAverage - .6 : 0, netAt080: returns.length ? grossAverage - .8 : 0, netAt100: returns.length ? grossAverage - 1 : 0, targetRate: rate(targetCount, settled.length), stopRate: rate(stopCount, settled.length), timeoutRate: rate(timeoutCount, settled.length), ambiguousRate: rate(ambiguousCount, records.length), unavailableRate: rate(unavailableCount, records.length), maxDrawdown: maximumDrawdown(returns), maxLosingStreak: streak(returns, (value) => value < 0), profitableDayPercent: profitableDayPercentage(dailyGross), dailyGross, dailyNet40, train, validation };
}

function subsetSummary(records: readonly RecordValue[]): SubsetSummary { const settled = records.filter((record) => !record.exit.ambiguous && !record.exit.unavailable && record.exit.premiumChangePercent !== null); const returns = settled.map((record) => record.exit.premiumChangePercent!); const target = settled.filter((record) => record.exit.exitReason === 'TARGET').length; const stop = settled.filter((record) => record.exit.exitReason === 'STOP_LOSS').length; const timeout = settled.filter((record) => record.exit.exitReason === 'TIME_EXIT').length; return { signals: records.length, resolvedTrades: records.length - records.filter((record) => record.exit.unavailable).length, settledTrades: settled.length, unavailableTrades: records.filter((record) => record.exit.unavailable).length, grossAverage: average(returns), grossMedian: median(returns), netAt040: returns.length ? average(returns) - .4 : 0, targetRate: rate(target, settled.length), stopRate: rate(stop, settled.length), timeoutRate: rate(timeout, settled.length), ambiguousRate: rate(records.filter((record) => record.exit.ambiguous).length, records.length), unavailableRate: rate(records.filter((record) => record.exit.unavailable).length, records.length) }; }

function candidateGroups(metrics: readonly CandidateMetric[], signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>, dates: readonly string[], dateIndex: ReadonlyMap<string, number>, splitByDate: ReadonlyMap<string, string>) {
  const qualityPool = metrics.filter((metric) => metric.settledTrades >= 30);
  const positive = qualityPool.filter((metric) => metric.netAt040 > 0 && metric.grossMedian >= 0 && metric.targetRate > metric.stopRate);
  const rankQuality = [...qualityPool].sort((a, b) => b.netAt040 - a.netAt040 || b.grossMedian - a.grossMedian || b.validation.netAt040 - a.validation.netAt040 || b.settledTrades - a.settledTrades);
  const rankFrequency = [...metrics].sort((a, b) => b.settledTrades - a.settledTrades || b.netAt040 - a.netAt040);
  const rankBalanced = [...positive.filter((metric) => metric.settledTrades / dates.length >= .5)].sort((a, b) => b.netAt040 - a.netAt040 || b.settledTrades - a.settledTrades);
  const rankValidation = [...qualityPool].filter((metric) => metric.train.netAt040 > 0).sort((a, b) => b.validation.netAt040 - a.validation.netAt040 || b.netAt040 - a.netAt040);
  const rankCost = [...qualityPool].sort((a, b) => b.netAt060 - a.netAt060 || b.netAt040 - a.netAt040);
  return { highestFrequency: rankFrequency[0], highestQuality: rankQuality[0], bestBalanced: rankBalanced[0] ?? rankQuality[0], bestValidationStability: rankValidation[0] ?? rankQuality[0], bestCostRobustness: rankCost[0] ?? rankQuality[0], top20: rankQuality.slice(0, 20), credibleCount: positive.length };
}

function frequencyTiers(metrics: readonly CandidateMetric[], dates: readonly string[], signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>) { return [.5, 1, 2, 3, 5].map((threshold) => { const matching = metrics.filter((metric) => metric.settledTrades / dates.length >= threshold); const positive40 = matching.filter((metric) => metric.netAt040 > 0); const positive60 = matching.filter((metric) => metric.netAt060 > 0); const best40 = [...positive40].sort((a, b) => b.netAt040 - a.netAt040 || b.grossMedian - a.grossMedian)[0]; const best60 = [...positive60].sort((a, b) => b.netAt060 - a.netAt060 || b.grossMedian - a.grossMedian)[0]; return { minimumTradesPerSession: threshold, candidateCount: matching.length, positiveAt040Count: positive40.length, positiveAt060Count: positive60.length, bestNetAt040: best40 ? serializeMetric(best40, dates) : null, bestNetAt060: best60 ? serializeMetric(best60, dates) : null }; }); }

function familyAnalysis(metrics: readonly CandidateMetric[]) { const fields: Array<[string, (metric: CandidateMetric) => string]> = [['timeframe', (metric) => `${metric.config.timeframe}m`], ['levelFamily', (metric) => metric.config.levelFamily], ['reclaimBufferAtr', (metric) => String(metric.config.reclaimBufferAtr)], ['bullishBodyAtr', (metric) => String(metric.config.bullishBodyAtr)], ['rsiFilter', (metric) => String(metric.config.rsiMinimum)], ['regimeMode', (metric) => metric.config.regimeMode], ['cooldownMinutes', (metric) => `${metric.config.cooldownMinutes}m`], ['targetStop', (metric) => `+${metric.policy.target}/-${metric.policy.stop}`], ['holdMinutes', (metric) => `${metric.policy.hold}m`]]; return Object.fromEntries(fields.map(([name, select]) => { const groups = new Map<string, CandidateMetric[]>(); metrics.forEach((metric) => groups.set(select(metric), [...(groups.get(select(metric)) ?? []), metric])); return [name, Object.fromEntries([...groups.entries()].map(([key, values]) => [key, { candidates: values.length, averageNetAt040: average(values.map((value) => value.netAt040)), medianNetAt040: median(values.map((value) => value.netAt040)), positiveAt040: values.filter((value) => value.netAt040 > 0).length, averageSettledTradesPerSession: average(values.map((value) => value.settledTrades / 80)) }]))]; })); }

function walkForwardDiagnostics(metrics: readonly CandidateMetric[], dates: readonly string[], signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>, dateIndex: ReadonlyMap<string, number>) { const folds: unknown[] = []; for (let start = 0, fold = 1; start + 62 <= dates.length; start += 10, fold += 1) { const trainDates = new Set(dates.slice(start, start + 50)); const validationDates = new Set(dates.slice(start + 52, start + 62)); let selected: CandidateMetric | undefined; let selectedTrain: SubsetSummary | undefined; metrics.forEach((metric) => { const summary = subsetSummary(recordsFor(metric, trainDates, signalsByConfig, resolutions)); if (!selected || summary.netAt040 > selectedTrain!.netAt040) { selected = metric; selectedTrain = summary; } }); const validation = subsetSummary(recordsFor(selected!, validationDates, signalsByConfig, resolutions)); folds.push({ fold, trainStart: dates[start], trainEnd: dates[start + 49], embargoDates: dates.slice(start + 50, start + 52), validationStart: dates[start + 52], validationEnd: dates[start + 61], configsConsidered: metrics.length, selectedConfig: selected!.id, train: selectedTrain, validation, degradationNetAt040: validation.netAt040 - selectedTrain!.netAt040, signConsistent: Math.sign(selectedTrain!.netAt040) === Math.sign(validation.netAt040) }); } return { foldCount: folds.length, folds }; }

function multipleTestingDiagnostics(metrics: readonly CandidateMetric[], dates: readonly string[]) { const best = [...metrics].sort((a, b) => b.netAt040 - a.netAt040)[0]; const returns = best ? best.dailyNet40.filter((_, index) => best.dailyNet40[index] !== 0) : []; const observedSharpe = returns.length > 1 ? average(returns) / standardDeviation(returns) * Math.sqrt(returns.length) : 0; const trialSensitivity = [4608, 41472, 124416].map((trials) => ({ trials, dsr: deflatedSharpeRatio({ observedSharpe, numberOfTrials: trials, sampleLength: Math.max(2, returns.length) }) })); const matrix = resultMatrix(dates, metrics.map((metric) => metric.id), new Map(dates.map((date, index) => [date, new Map(metrics.map((metric) => [metric.id, metric.dailyNet40[index]]))])), .4); const pbo = simplifiedPbo(matrix); return { observedSharpe, selectedMetric: best?.id ?? null, trialSensitivity, simplifiedPbo: pbo, interpretation: trialSensitivity.at(-1)!.dsr < .05 || pbo.pbo >= .5 ? 'HIGH_OVERFIT_RISK' : trialSensitivity.at(-1)!.dsr < .2 || pbo.pbo > .25 ? 'MODERATE_OVERFIT_RISK' : 'LOW_OVERFIT_RISK', note: 'DSR and PBO are diagnostics, not proof of statistical independence.' }; }

function recordsFor(metric: CandidateMetric, dates: ReadonlySet<string>, signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>): RecordValue[] { return (signalsByConfig.get(v8ConfigKey(metric.config)) ?? []).filter((signal) => dates.has(signal.date)).map((signal) => ({ signal, exit: resolutions.get(signalKey(signal))?.exits.get(policyKey(metric.policy)) ?? unavailableExit(signal, metric.policy) })); }

function serializeGroups(groups: ReturnType<typeof candidateGroups>, dates: readonly string[], signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>, splitByDate: ReadonlyMap<string, string>) { const encode = (metric: CandidateMetric | undefined) => metric ? { ...serializeMetric(metric, dates), breakdown: detailedBreakdown(metric, signalsByConfig, resolutions, dates, splitByDate) } : null; return { credibleCandidateCount: groups.credibleCount, highestFrequency: encode(groups.highestFrequency), highestQuality: encode(groups.highestQuality), bestBalanced: encode(groups.bestBalanced), bestValidationStability: encode(groups.bestValidationStability), bestCostRobustness: encode(groups.bestCostRobustness), top20: groups.top20.map(encode) }; }
function serializeMetric(metric: CandidateMetric, dates: readonly string[]) { return { id: metric.id, config: metric.config, policy: metric.policy, totalSignals: metric.totalSignals, resolvedTrades: metric.resolvedTrades, settledTrades: metric.settledTrades, unavailableTrades: metric.unavailableTrades, tradesPerSession: dates.length ? metric.settledTrades / dates.length : 0, targetCount: metric.targetCount, stopCount: metric.stopCount, timeoutCount: metric.timeoutCount, ambiguousCount: metric.ambiguousCount, targetRate: metric.targetRate, stopRate: metric.stopRate, timeoutRate: metric.timeoutRate, ambiguousRate: metric.ambiguousRate, unavailableRate: metric.unavailableRate, grossAverage: metric.grossAverage, grossMedian: metric.grossMedian, netAt020: metric.netAt020, netAt040: metric.netAt040, netAt060: metric.netAt060, netAt080: metric.netAt080, netAt100: metric.netAt100, maxDrawdown: metric.maxDrawdown, maxLosingStreak: metric.maxLosingStreak, profitableDayPercent: metric.profitableDayPercent, train: metric.train, validation: metric.validation, trainToValidationDegradationNetAt040: metric.validation.netAt040 - metric.train.netAt040, dailyGross: dates.map((date, index) => ({ date, gross: metric.dailyGross[index], netAt040: metric.dailyNet40[index] })) }; }
function monthlyBreakdown(metric: CandidateMetric, dates: readonly string[]) { const groups = new Map<string, { gross: number[]; net40: number[] }>(); dates.forEach((date, index) => { const month = date.slice(0, 7); const value = groups.get(month) ?? { gross: [], net40: [] }; value.gross.push(metric.dailyGross[index]); value.net40.push(metric.dailyNet40[index]); groups.set(month, value); }); return [...groups.entries()].map(([month, values]) => ({ month, activeDays: values.gross.filter((value) => value !== 0).length, grossAveragePerSession: average(values.gross), netAt040AveragePerSession: average(values.net40), grossTotal: values.gross.reduce((sum, value) => sum + value, 0), netAt040Total: values.net40.reduce((sum, value) => sum + value, 0) })); }
function halfBreakdown(metric: CandidateMetric, dates: readonly string[]) { const midpoint = Math.ceil(dates.length / 2); const make = (start: number, end: number) => ({ sessions: end - start, grossAveragePerSession: average(metric.dailyGross.slice(start, end)), netAt040AveragePerSession: average(metric.dailyNet40.slice(start, end)), grossTotal: metric.dailyGross.slice(start, end).reduce((sum, value) => sum + value, 0), netAt040Total: metric.dailyNet40.slice(start, end).reduce((sum, value) => sum + value, 0) }); return { firstHalf: make(0, midpoint), secondHalf: make(midpoint, dates.length) }; }
function detailedBreakdown(metric: CandidateMetric, signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>, resolutions: ReadonlyMap<string, Resolution>, dates: readonly string[], splitByDate: ReadonlyMap<string, string>) { const records = recordsFor(metric, new Set(dates), signalsByConfig, resolutions); const months: Array<[string, string]> = [['March', '2026-03'], ['April', '2026-04'], ['May', '2026-05'], ['June', '2026-06'], ['July', '2026-07'], ['Aug 1-4', '2026-08']]; const midpoint = Math.floor(dates.length / 2); const firstDates = new Set(dates.slice(0, midpoint)); const summary = (items: readonly RecordValue[]) => subsetSummary(items); const timeBuckets: Array<[string, number, number]> = [['09:15-10:30', 555, 630], ['10:30-12:00', 630, 720], ['12:00-13:30', 720, 810], ['13:30-15:30', 810, 930]]; return { monthly: months.map(([month, prefix]) => ({ month, ...summary(records.filter((record) => record.signal.date.startsWith(prefix))) })), firstHalf: summary(records.filter((record) => firstDates.has(record.signal.date))), secondHalf: summary(records.filter((record) => !firstDates.has(record.signal.date))), timeOfDay: timeBuckets.map(([bucket, start, end]) => ({ bucket, ...summary(records.filter((record) => { const minute = istMinute(record.signal.timestamp); return minute >= start && minute < end; })) })), train: summary(records.filter((record) => splitByDate.get(record.signal.date) === 'TRAIN')), validation: summary(records.filter((record) => splitByDate.get(record.signal.date) === 'VALIDATION')) }; }
function overlapReport(metric: CandidateMetric | undefined, signalsByConfig: ReadonlyMap<string, readonly V8BullishReclaimSignal[]>) { if (!metric) return { status: 'OVERLAP_NOT_ESTIMABLE', reason: 'No candidate.' }; const v8 = [...new Set((signalsByConfig.get(v8ConfigKey(metric.config)) ?? []).map((signal) => signal.timestamp.getTime()))]; const refs = ['v2-session-result-matrix.json', 'v4-session-result-matrix.json'].map((file) => { try { const matrix = JSON.parse(readFileSync(resolve(process.cwd(), 'artifacts', 'research-validation', file), 'utf8')) as { sessions: Array<{ date: string; tradeReferences: Array<{ timestamp: string }> }> }; const timestamps = matrix.sessions.flatMap((session) => session.tradeReferences.map((reference) => new Date(reference.timestamp).getTime())); const exact = v8.filter((timestamp) => timestamps.includes(timestamp)).length; const near = v8.filter((timestamp) => timestamps.some((reference) => Math.abs(reference - timestamp) <= 5 * 60_000)).length; return { file, exactOverlap: exact, within5Minutes: near, independentSignals: v8.length - exact, v8Signals: v8.length }; } catch { return { file, status: 'OVERLAP_NOT_ESTIMABLE' }; } }); return { status: 'ESTIMATED_FROM_SESSION_MATRIX_TRADE_REFERENCES', candidate: metric.id, comparisons: refs }; }

function finalVerdict(groups: ReturnType<typeof candidateGroups>, multipleTesting: ReturnType<typeof multipleTestingDiagnostics>) { const candidate = groups.bestBalanced; if (!candidate || candidate.settledTrades < 30 || candidate.netAt040 <= 0 || candidate.grossMedian < 0 || candidate.validation.netAt040 <= 0) return 'REJECTED'; if (multipleTesting.interpretation === 'HIGH_OVERFIT_RISK') return 'WEAK'; if (candidate.netAt060 > 0 && candidate.validation.netAt040 > 0) return 'PROMISING'; return 'WEAK'; }
function unavailableExit(signal: V8BullishReclaimSignal, policy: Policy): OptionExitPolicyEvaluationResult { return { signalTimestamp: signal.timestamp, entryPremium: 0, exitTimestamp: null, exitPremium: null, exitReason: 'UNAVAILABLE', holdingMinutes: null, premiumChange: null, premiumChangePercent: null, targetPremium: 0, stopPremium: 0, ambiguous: false, unavailable: true }; }
function signalKey(signal: V8BullishReclaimSignal): string { return `${signal.date}\u0000${signal.timestamp.getTime()}`; }
function policyKey(policy: Policy): string { return `${policy.target}|${policy.stop}|${policy.hold}`; }
async function cached<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> { const found = cache.get(key); if (found) return found; const pending = work(); cache.set(key, pending); return pending; }
async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> { const values: R[] = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; values[index] = await work(items[index]); } })); return values; }
function completeSession(rows: readonly Candle[]): boolean { if (rows.length !== 375) return false; const sorted = [...rows].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); return istMinute(sorted[0].timestamp) === 555 && istMinute(sorted[374].timestamp) === 929 && sorted.every((row, index) => index === 0 || row.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === 60_000); }
function istMinute(value: Date): number { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map((part) => [part.type, part.value])); return Number(parts.hour) * 60 + Number(parts.minute); }
function average(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: readonly number[]): number { if (!values.length) return 0; const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function rate(value: number, total: number): number { return total ? value / total * 100 : 0; }
function maximumDrawdown(values: readonly number[]): number { let equity = 0; let peak = 0; let drawdown = 0; values.forEach((value) => { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }); return drawdown; }
function streak(values: readonly number[], predicate: (value: number) => boolean): number { let current = 0; let best = 0; values.forEach((value) => { current = predicate(value) ? current + 1 : 0; best = Math.max(best, current); }); return best; }
function profitableDayPercentage(values: readonly number[]): number { return rate(values.filter((value) => value > 0).length, values.filter((value) => value !== 0).length); }
function standardDeviation(values: readonly number[]): number { if (values.length < 2) return 0; const mean = average(values); return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); }
function write(name: string, value: unknown): void { mkdirSync(DIRECTORY, { recursive: true }); writeFileSync(resolve(DIRECTORY, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

void run().catch((error) => { console.error('V8 Phase 2 outcome research failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
