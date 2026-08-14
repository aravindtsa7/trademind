import 'dotenv/config';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import OptionPremiumPathAnalysisService from '../modules/options/services/option-premium-path-analysis.service';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import { adaptV9OptionCandles } from '../modules/research/v9-nifty-volatility-expansion/v9-option-candle-adapter';
import { assertV9NoLookAhead, createV9Configs, generateV9Signals, V9Config, V9OptionCandle, V9OptionResolver, V9PreparedSession, V9Signal, v9ConfigKey } from '../modules/research/v9-nifty-volatility-expansion';
import ResearchMetricsService, { DEFAULT_COST_SCENARIOS, average, median } from '../modules/research-validation/services/research-metrics.service';
import ResearchSplitService from '../modules/research-validation/services/research-split.service';
import { deflatedSharpeRatio, resultMatrix, simplifiedPbo } from '../modules/research-validation/services/multiple-testing.service';

const INSTRUMENT = 'NSE_INDEX|Nifty 50';
const END_DATE = '2026-08-04';
const DIRECTORY = resolve(process.cwd(), 'artifacts', 'v9-nifty-volatility-expansion');
const POLICIES = [
  { target: 4, stop: 4, hold: 10 }, { target: 4, stop: 4, hold: 15 }, { target: 4, stop: 4, hold: 20 },
  { target: 5, stop: 5, hold: 10 }, { target: 5, stop: 5, hold: 15 }, { target: 5, stop: 5, hold: 20 },
  { target: 6, stop: 5, hold: 10 }, { target: 6, stop: 5, hold: 15 }, { target: 6, stop: 5, hold: 20 },
] as const;
type Policy = typeof POLICIES[number];
type Direction = 'CE' | 'PE';
type ContractSelection = { direction: Direction; instrumentKey: string; tradingDate: string; timestamp: string; expiry?: string; strikePrice?: number };
type Resolution = { signal: V9Signal; exits: ReadonlyMap<string, OptionExitPolicyEvaluationResult>; };
type Candidate = { config: V9Config; policy: Policy; id: string; CE: Summary; PE: Summary; ALL: Summary; records: Record<Direction, Resolution[]> };
type Summary = any;

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw new Error('V9 Phase 2 requires RESEARCH_LOCAL_ONLY=true.');
  const context = await loadProtectedContext();
  const configs = createV9Configs();
  assert.equal(configs.length, 960, 'V9 frozen signal grid must contain exactly 960 configurations.');
  assert.equal(POLICIES.length, 9, 'V9 frozen policy grid must contain exactly 9 policies.');

  const signalCache = new Map<string, V9Signal[]>();
  const pathCache = new Map<string, Resolution>();
  const candidates: Candidate[] = [];
  for (const config of configs) {
    const signals = generateV9Signals(context.sessions, config, { atrByFrame: context.atrByFrame }, context.resolver);
    assertV9NoLookAhead(signals);
    signalCache.set(v9ConfigKey(config), signals);
    const byDirection: Record<Direction, Resolution[]> = { CE: [], PE: [] };
    for (const signal of signals) {
      const key = `${signal.optionInstrumentKey}\u0000${signal.date}\u0000${signal.timestamp.getTime()}`;
      let resolution = pathCache.get(key);
      if (!resolution) { resolution = resolveSignal(signal, context.adaptedRowsBySession); pathCache.set(key, resolution); }
      byDirection[signal.direction].push(resolution);
    }
    for (const policy of POLICIES) {
      const ce = summarize(byDirection.CE, policy, context.trainDates, context.validationDates, context.sessionDates);
      const pe = summarize(byDirection.PE, policy, context.trainDates, context.validationDates, context.sessionDates);
      candidates.push({ config, policy, id: `${v9ConfigKey(config)}|${policyKey(policy)}`, CE: ce, PE: pe, ALL: combineSummary(ce, pe, context.sessionDates), records: byDirection });
    }
  }
  assert.equal(candidates.length, 8640, 'V9 Phase 2 must attempt exactly 8,640 configuration/policy evaluations.');
  assert.equal(context.finalHoldoutAccessCount, 0, 'FINAL_HOLDOUT must remain untouched.');
  assert.equal(context.currentDateAccessCount, 0, '2026-08-13 must remain untouched.');
  assert.equal(context.networkRequests, 0, 'V9 full outcome runner is local-cache only.');
  assert.equal(context.cacheWrites, 0, 'V9 full outcome runner must not write cache rows.');

  const ce = analyzeDirection('CE', candidates, context); const pe = analyzeDirection('PE', candidates, context);
  const frequencyTiers = tiers(candidates, context.sessionDates.length);
  const parameterFamilies = parameterFamilyDiagnostics(candidates);
  const combined = combineCredible(ce.bestBalanced, pe.bestBalanced, context);
  const dsrCandidate = [ce.bestBalanced && { candidate: ce.bestBalanced, direction: 'CE' as const }, pe.bestBalanced && { candidate: pe.bestBalanced, direction: 'PE' as const }].filter((value): value is { candidate: Candidate; direction: Direction } => !!value).sort((left, right) => Number(right.candidate[right.direction].net.netAt040) - Number(left.candidate[left.direction].net.netAt040))[0];
  const validation = {
    CE: directionValidation(ce, context), PE: directionValidation(pe, context),
    multipleTesting: dsrCandidate ? multipleTesting(dsrCandidate.candidate, dsrCandidate.direction, candidates, context) : null, overlap: overlapReport(),
  };
  const coverage = { localOptionRows: context.localOptionRows, adaptedOptionSessions: context.adaptedRowsBySession.size, missingLocalOptionSessions: context.missingLocalOptionSessions, networkRequests: context.networkRequests, cacheWrites: context.cacheWrites };
  const assertion = { configurationsProcessed: configs.length, policiesPerConfiguration: POLICIES.length, policyEvaluationsAttempted: candidates.length, finalHoldoutAccessCount: context.finalHoldoutAccessCount, currentDateAccessCount: context.currentDateAccessCount, networkRequests: context.networkRequests, cacheWrites: context.cacheWrites };
  const verdict = finalVerdict(ce, pe, combined, validation.multipleTesting?.overfitRisk ?? 'HIGH_OVERFIT_RISK');
  mkdirSync(DIRECTORY, { recursive: true });
  write('outcome-summary.json', { strategyId: 'V9_NIFTY_VOLATILITY_EXPANSION_CONFIRMATION', protectedMode: 'TRAIN_VALIDATION_ONLY', scope: { sessions: context.sessionDates.length, train: context.trainDates.size, validation: context.validationDates.size, excluded: ['EMBARGO_1', 'EMBARGO_2', 'FINAL_HOLDOUT', '2026-08-13'] }, assertion, coverage, CE: compactAnalysis(ce), PE: compactAnalysis(pe), combined, frequencyTiers, parameterNeighborhood: parameterFamilies.classification, verdict });
  write('top-candidates.json', { CE: detailedAnalysis(ce, context), PE: detailedAnalysis(pe, context), combined, frequencyTiers, parameterFamilies });
  write('validation-report.json', validation);
  console.log(JSON.stringify({ status: 'V9_PHASE_2_COMPLETE', assertion, coverage, CE: compactAnalysis(ce), PE: compactAnalysis(pe), combined, verdict }, null, 2));
}

async function loadProtectedContext(): Promise<{
  sessions: V9PreparedSession[]; sessionDates: string[]; trainDates: Set<string>; validationDates: Set<string>; atrByFrame: Map<any, Map<number, number>>;
  resolver: V9OptionResolver; adaptedRowsBySession: Map<string, ReturnType<typeof adaptV9OptionCandles>>; localOptionRows: number; missingLocalOptionSessions: string[];
  networkRequests: number; cacheWrites: number; finalHoldoutAccessCount: number; currentDateAccessCount: number;
}> {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'artifacts/research-validation/nifty-104-split-v1.json'), 'utf8'));
  const trainDates = new Set<string>(manifest.sessions.filter((row: any) => row.split === 'TRAIN' && row.tradingDate <= END_DATE).map((row: any) => row.tradingDate));
  const validationDates = new Set<string>(manifest.sessions.filter((row: any) => row.split === 'VALIDATION' && row.tradingDate <= END_DATE).map((row: any) => row.tradingDate));
  const sessionDates = [...trainDates, ...validationDates].sort();
  new ResearchSplitService().assertOutcomeAccess(manifest, sessionDates, 'TRAIN_VALIDATION_ONLY');
  assert.equal(sessionDates.length, 80, 'Protected V9 scope must contain 80 TRAIN+VALIDATION sessions.');
  const underlyingRows = await new HistoricalCandleRepository().findByInstrumentAndTimeframe(INSTRUMENT, '1minute');
  const byDate = new Map<string, any[]>();
  underlyingRows.forEach((row: any) => {
    const candle = { timestamp: new Date(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) };
    const date = istDate(candle.timestamp); byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  });
  const complete = [...byDate.entries()].filter(([, rows]) => completeSession(rows)).sort(([left], [right]) => left.localeCompare(right));
  const warmed = filterCrossSessionResearchTargets(prepareCrossSessionIndicatorWarmup(complete.map(([date, candles]) => ({ date, candles })), new CandleTimeframeAggregatorService(), new IndicatorEngineService(), new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 })), END_DATE).filter((session: any) => sessionDates.includes(session.date));
  assert.equal(warmed.length, 80, 'Cross-session preparation must retain exactly the protected V9 sessions.');
  const sessions = warmed.map((session: any) => ({ date: session.date, frames: { 2: session.frames[2].candles, 3: session.frames[3].candles }, regimePoints: session.regimePoints })) as V9PreparedSession[];
  const atrByFrame = buildAtrMaps(sessions);
  const v7Manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'artifacts/v7-option-impulse/required-option-cache-manifest.json'), 'utf8'));
  const contracts = (v7Manifest.selectedContracts as ContractSelection[]).filter((contract) => sessionDates.includes(contract.tradingDate));
  const unique = [...new Map(contracts.map((contract) => [`${contract.instrumentKey}|${contract.tradingDate}`, contract])).values()];
  const rawRows = await new HistoricalOptionCandleRepository().findByInstrumentDateSessions(unique.map((contract) => ({ instrumentKey: contract.instrumentKey, tradingDate: contract.tradingDate })), '1minute');
  const rawBySession = new Map<string, any[]>(); const signalCandles = new Map<string, V9OptionCandle[]>();
  rawRows.forEach((row: any) => { const key = `${row.instrumentKey}|${istDate(new Date(row.candleTime))}`; rawBySession.set(key, [...(rawBySession.get(key) ?? []), row]); signalCandles.set(key, [...(signalCandles.get(key) ?? []), { timestamp: new Date(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), instrumentKey: row.instrumentKey }]); });
  const missingLocalOptionSessions = unique.filter((contract) => (rawBySession.get(`${contract.instrumentKey}|${contract.tradingDate}`)?.length ?? 0) === 0).map((contract) => `${contract.instrumentKey}|${contract.tradingDate}`);
  if (missingLocalOptionSessions.length) throw new Error(`V9 local cache is incomplete; no download was attempted: ${missingLocalOptionSessions.join(', ')}.`);
  const adaptedRowsBySession = new Map<string, ReturnType<typeof adaptV9OptionCandles>>(); rawBySession.forEach((rows, key) => adaptedRowsBySession.set(key, adaptV9OptionCandles(rows)));
  const selectionByDirectionDate = new Map<string, ContractSelection[]>(); contracts.forEach((contract) => { const key = `${contract.direction}|${contract.tradingDate}`; selectionByDirectionDate.set(key, [...(selectionByDirectionDate.get(key) ?? []), contract]); });
  const resolver: V9OptionResolver = {
    resolve(direction, date, completedAt) { const values = (selectionByDirectionDate.get(`${direction}|${date}`) ?? []).filter((contract) => new Date(contract.timestamp).getTime() <= completedAt.getTime()).sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()); const selected = values[0] ?? selectionByDirectionDate.get(`${direction}|${date}`)?.[0]; return selected ? { instrumentKey: selected.instrumentKey, expiry: selected.expiry, strike: selected.strikePrice } : undefined; },
    candles(instrumentKey, date) { return signalCandles.get(`${instrumentKey}|${date}`) ?? []; },
  };
  return { sessions, sessionDates, trainDates, validationDates, atrByFrame, resolver, adaptedRowsBySession, localOptionRows: rawRows.length, missingLocalOptionSessions, networkRequests: 0, cacheWrites: 0, finalHoldoutAccessCount: 0, currentDateAccessCount: 0 };
}

function resolveSignal(signal: V9Signal, adapted: ReadonlyMap<string, ReturnType<typeof adaptV9OptionCandles>>): Resolution {
  const rows = adapted.get(`${signal.optionInstrumentKey}|${signal.date}`);
  if (!rows) return { signal, exits: unavailableExits(signal) };
  try {
    const path = new OptionPremiumPathAnalysisService(signal.timestamp, rows); const exits = new Map<string, OptionExitPolicyEvaluationResult>();
    POLICIES.forEach((policy) => exits.set(policyKey(policy), path.evaluate({ type: 'TARGET_STOP', targetPercent: policy.target, stopLossPercent: policy.stop, maximumHoldingMinutes: policy.hold })));
    return { signal, exits };
  } catch (error) { throw new Error(`V9 option-path failure for ${signal.optionInstrumentKey} ${signal.date} ${signal.timestamp.toISOString()}: ${error instanceof Error ? error.message : String(error)}`); }
}

function unavailableExits(signal: V9Signal): Map<string, OptionExitPolicyEvaluationResult> {
  return new Map(POLICIES.map((policy) => [policyKey(policy), { signalTimestamp: signal.timestamp, entryPremium: 0, exitTimestamp: null, exitPremium: null, exitReason: 'UNAVAILABLE' as const, holdingMinutes: null, premiumChange: null, premiumChangePercent: null, ambiguous: false, unavailable: true }]));
}

function summarize(records: readonly Resolution[], policy: Policy, trainDates: ReadonlySet<string>, validationDates: ReadonlySet<string>, sessionDates: readonly string[]) {
  const outcomes = records.map((record) => ({ signal: record.signal, exit: record.exits.get(policyKey(policy))! }));
  const settled = outcomes.filter((row) => !row.exit.ambiguous && !row.exit.unavailable && row.exit.premiumChangePercent !== null);
  const metric = new ResearchMetricsService().calculate(outcomes.map((row) => ({ tradingDate: row.signal.date, grossReturn: row.exit.premiumChangePercent ?? 0, outcome: row.exit.exitReason })), sessionDates.length, DEFAULT_COST_SCENARIOS);
  const subset = (dates: ReadonlySet<string>) => detail(outcomes.filter((row) => dates.has(row.signal.date)), dates.size);
  const midpoint = Math.floor(sessionDates.length / 2); const firstHalf = new Set(sessionDates.slice(0, midpoint)); const secondHalf = new Set(sessionDates.slice(midpoint));
  const returns = settled.map((row) => row.exit.premiumChangePercent!);
  return {
    totalSignals: records.length, settledTrades: settled.length, unavailableTrades: outcomes.filter((row) => row.exit.unavailable).length, ambiguousTrades: outcomes.filter((row) => row.exit.ambiguous).length,
    tradesPerSession: round(records.length / sessionDates.length), grossExpectancy: round(metric.averageGrossReturn), medianReturn: round(metric.medianReturn), net: netByCost(returns),
    targetRate: rate(settled.filter((row) => row.exit.exitReason === 'TARGET').length, settled.length), stopRate: rate(settled.filter((row) => row.exit.exitReason === 'STOP_LOSS').length, settled.length), timeoutRate: rate(settled.filter((row) => row.exit.exitReason === 'TIME_EXIT').length, settled.length), ambiguousRate: rate(outcomes.filter((row) => row.exit.ambiguous).length, outcomes.length),
    profitableDayPercent: round(metric.profitableDayPercentage), maxDrawdown: round(metric.maximumDrawdown), maxLosingStreak: metric.maxConsecutiveLosses,
    train: subset(trainDates), validation: subset(validationDates), trainToValidationChange: round(subset(validationDates).netAt040 - subset(trainDates).netAt040), halves: { first: subset(firstHalf), second: subset(secondHalf) },
    monthly: monthly(outcomes), dailyNetAt040: dailyNet(outcomes), records: outcomes, returns, sharpeLike: metric.sharpeLike,
  };
}

function detail(outcomes: readonly { signal: V9Signal; exit: OptionExitPolicyEvaluationResult }[], sessions: number) { const settled = outcomes.filter((row) => !row.exit.ambiguous && !row.exit.unavailable && row.exit.premiumChangePercent !== null); const values = settled.map((row) => row.exit.premiumChangePercent!); return { trades: settled.length, signals: outcomes.length, gross: round(average(values)), median: round(median(values)), netAt040: netAt(values, .4), sessions, tradesPerSession: round(outcomes.length / Math.max(1, sessions)) }; }
function combineSummary(ce: Summary, pe: Summary, sessionDates: readonly string[]) { return summarizeRecordsOnly([...ce.records, ...pe.records], sessionDates, ce, pe); }
function summarizeRecordsOnly(records: readonly { signal: V9Signal; exit: OptionExitPolicyEvaluationResult }[], sessionDates: readonly string[], ce?: Summary, pe?: Summary) { const settled = records.filter((row) => !row.exit.ambiguous && !row.exit.unavailable && row.exit.premiumChangePercent !== null); const values = settled.map((row) => row.exit.premiumChangePercent!); const calculated = new ResearchMetricsService().calculate(records.map((row) => ({ tradingDate: row.signal.date, grossReturn: row.exit.premiumChangePercent ?? 0, outcome: row.exit.exitReason })), sessionDates.length, DEFAULT_COST_SCENARIOS); return { totalSignals: records.length, settledTrades: settled.length, unavailableTrades: records.filter((row) => row.exit.unavailable).length, ambiguousTrades: records.filter((row) => row.exit.ambiguous).length, tradesPerSession: round(records.length / sessionDates.length), grossExpectancy: round(average(values)), medianReturn: round(median(values)), net: netByCost(values), targetRate: rate(settled.filter((row) => row.exit.exitReason === 'TARGET').length, settled.length), stopRate: rate(settled.filter((row) => row.exit.exitReason === 'STOP_LOSS').length, settled.length), timeoutRate: rate(settled.filter((row) => row.exit.exitReason === 'TIME_EXIT').length, settled.length), ambiguousRate: rate(records.filter((row) => row.exit.ambiguous).length, records.length), profitableDayPercent: round(calculated.profitableDayPercentage), maxDrawdown: round(calculated.maximumDrawdown), maxLosingStreak: calculated.maxConsecutiveLosses, train: ce?.train ?? null, validation: pe?.validation ?? null, trainToValidationChange: 0, halves: null, monthly: [], dailyNetAt040: dailyNet(records), records: [...records], returns: values, sharpeLike: calculated.sharpeLike }; }

function analyzeDirection(direction: Direction, candidates: readonly Candidate[], context: Awaited<ReturnType<typeof loadProtectedContext>>) {
  const get = (candidate: Candidate) => candidate[direction]; const values = candidates.filter((candidate) => get(candidate).totalSignals > 0); const credible = values.filter((candidate) => credibleMetric(get(candidate)));
  const pool = credible.length ? credible : values; const ranked = [...pool].sort((left, right) => rank(get(left), get(right)));
  const highestFrequency = [...values].sort((left, right) => get(right).totalSignals - get(left).totalSignals || rank(get(left), get(right)))[0];
  const highestQuality = ranked[0]; const bestBalanced = [...credible.filter((candidate) => get(candidate).tradesPerSession >= .5)].sort((left, right) => rank(get(left), get(right)))[0] ?? highestQuality;
  const bestValidationStability = [...pool].sort((left, right) => Math.abs(get(right).validation.netAt040) - Math.abs(get(left).validation.netAt040) || rank(get(left), get(right)))[0];
  const bestCostRobustness = [...pool].sort((left, right) => Number(get(right).net.netAt060) - Number(get(left).net.netAt060) || rank(get(left), get(right)))[0];
  return { direction, candidates: values, credible, highestFrequency, highestQuality, bestBalanced, bestValidationStability, bestCostRobustness, context };
}
function credibleMetric(metric: Summary) { return metric.settledTrades >= 30 && Number(metric.net.netAt040) > 0 && Number(metric.net.netAt060) > 0 && metric.medianReturn >= 0 && metric.train.netAt040 >= 0 && metric.validation.netAt040 >= 0 && metric.targetRate > metric.stopRate; }
function rank(left: Summary, right: Summary) { return Number(right.net.netAt040) - Number(left.net.netAt040) || right.medianReturn - left.medianReturn || right.targetRate - left.targetRate || left.stopRate - right.stopRate || right.settledTrades - left.settledTrades; }

function tiers(candidates: readonly Candidate[], sessionCount: number) { return [.5, 1, 1.5, 2].map((threshold) => { const rows = candidates.flatMap((candidate) => (['CE', 'PE'] as Direction[]).map((direction) => ({ candidate, direction, metric: candidate[direction] }))).filter((row) => row.metric.tradesPerSession >= threshold); const positive40 = rows.filter((row) => Number(row.metric.net.netAt040) > 0); const positive60 = rows.filter((row) => Number(row.metric.net.netAt060) > 0); const best40 = [...positive40].sort((left, right) => rank(left.metric, right.metric))[0]; const best60 = [...positive60].sort((left, right) => Number(right.metric.net.netAt060) - Number(left.metric.net.netAt060))[0]; return { minimumTradesPerSession: threshold, candidateCount: rows.length, positiveAt040: positive40.length, positiveAt060: positive60.length, bestNetAt040: best40 ? compactCandidate(best40.candidate, best40.direction) : null, bestNetAt060: best60 ? compactCandidate(best60.candidate, best60.direction) : null }; }); }

function parameterFamilyDiagnostics(candidates: readonly Candidate[]) {
  const fields: Array<[string, (candidate: Candidate, direction: Direction) => string]> = [
    ['direction', (_candidate, direction) => direction], ['timeframe', (candidate) => `${candidate.config.timeframe}m`], ['compressionLookback', (candidate) => String(candidate.config.compressionLookback)], ['compressionThreshold', (candidate) => String(candidate.config.compressionThreshold)], ['bodyThreshold', (candidate) => String(candidate.config.expansionBodyThreshold)], ['rangeThreshold', (candidate) => String(candidate.config.expansionRangeThreshold)], ['breakoutLookback', (candidate) => String(candidate.config.breakoutLookback)], ['regimeMode', (candidate) => candidate.config.regimeMode], ['optionConfirmation', (candidate) => candidate.config.optionConfirmation], ['cooldown', (candidate) => String(candidate.config.cooldownMinutes)], ['targetStop', (candidate) => `+${candidate.policy.target}/-${candidate.policy.stop}`], ['hold', (candidate) => `${candidate.policy.hold}m`],
  ];
  const all = candidates.flatMap((candidate) => (['CE', 'PE'] as Direction[]).map((direction) => ({ candidate, direction, metric: candidate[direction] })));
  const families = Object.fromEntries(fields.map(([name, selector]) => [name, Object.fromEntries([...new Set(all.map((row) => selector(row.candidate, row.direction)))].map((key) => { const rows = all.filter((row) => selector(row.candidate, row.direction) === key); return [key, { candidates: rows.length, averageNetAt040: round(average(rows.map((row) => Number(row.metric.net.netAt040)))), medianNetAt040: round(median(rows.map((row) => Number(row.metric.net.netAt040))),), positiveAt040: rows.filter((row) => Number(row.metric.net.netAt040) > 0).length }]; }))]));
  const robust = all.filter((row) => credibleMetric(row.metric)); return { classification: robust.length >= 20 ? 'BROAD_NEIGHBORHOOD' : 'SELECTED_POCKET', credibleDirectionalCandidates: robust.length, families };
}

function combineCredible(ceCandidate: Candidate | undefined, peCandidate: Candidate | undefined, context: Awaited<ReturnType<typeof loadProtectedContext>>) {
  if (!ceCandidate || !peCandidate || !credibleMetric(ceCandidate.CE) || !credibleMetric(peCandidate.PE)) return { status: 'NOT_COMBINED', reason: 'Both directions did not independently meet frozen historical credibility criteria.' };
  const records = [...ceCandidate.CE.records, ...peCandidate.PE.records].sort((left, right) => left.signal.timestamp.getTime() - right.signal.timestamp.getTime()); const metric = summarizeRecordsOnly(records, context.sessionDates);
  return { status: 'COMBINED', CE: compactCandidate(ceCandidate, 'CE'), PE: compactCandidate(peCandidate, 'PE'), ...compactMetric(metric), activeDays: new Set(records.map((row) => row.signal.date)).size, maxTradesPerDay: Math.max(0, ...[...metric.dailyNetAt040.values()].map((value: any) => value.trades)) };
}

function directionValidation(analysis: ReturnType<typeof analyzeDirection>, context: Awaited<ReturnType<typeof loadProtectedContext>>) {
  const leader = analysis.bestBalanced ?? analysis.highestQuality; if (!leader) return null; const metric = leader[analysis.direction]; const folds = new ResearchSplitService().buildWalkForwardFolds(context.sessionDates).map((fold) => { const train = new Set(fold.train.map((row) => row.tradingDate)); const validation = new Set(fold.validation.map((row) => row.tradingDate)); const trainMetric = detail(metric.records.filter((row: any) => train.has(row.signal.date)), train.size); const validationMetric = detail(metric.records.filter((row: any) => validation.has(row.signal.date)), validation.size); return { fold: fold.fold, trainDates: [fold.train[0]?.tradingDate, fold.train.at(-1)?.tradingDate], validationDates: [fold.validation[0]?.tradingDate, fold.validation.at(-1)?.tradingDate], train: trainMetric, validation: validationMetric, degradation: round(validationMetric.netAt040 - trainMetric.netAt040), signConsistent: Math.sign(trainMetric.netAt040) === Math.sign(validationMetric.netAt040) }; });
  return { leader: compactCandidate(leader, analysis.direction), train: metric.train, validation: metric.validation, monthly: metric.monthly, halves: metric.halves, walkForward: { folds, foldCount: folds.length, positiveValidationFolds: folds.filter((fold) => fold.validation.netAt040 > 0).length, signConsistentFolds: folds.filter((fold) => fold.signConsistent).length } };
}

function multipleTesting(candidate: Candidate, direction: Direction, all: readonly Candidate[], context: Awaited<ReturnType<typeof loadProtectedContext>>) {
  const metric = candidate[direction]; const directional = all.map((value) => ({ id: value.id, metric: value[direction] })); const dailyReturns = new Map<string, Map<string, number>>();
  context.sessionDates.forEach((date) => { const values = new Map<string, number>(); directional.forEach((candidateValue) => values.set(candidateValue.id, candidateValue.metric.dailyNetAt040.get(date)?.net ?? 0)); dailyReturns.set(date, values); });
  const matrix = resultMatrix(context.sessionDates, directional.map((row) => row.id), dailyReturns, .4); const dsr = [960, 8640, 25000].map((trials) => ({ trials, value: round(deflatedSharpeRatio({ observedSharpe: metric.sharpeLike ?? 0, numberOfTrials: trials, sampleLength: Math.max(2, metric.settledTrades) })) })); const pbo = simplifiedPbo(matrix); const bestDsr = dsr.at(-1)?.value ?? 0; return { selectedCandidate: candidate.id, selectedDirection: direction, observedSharpeLike: metric.sharpeLike ?? 0, dsrSensitivity: dsr, simplifiedPbo: pbo, overfitRisk: bestDsr < .1 || pbo.pbo >= .5 ? 'HIGH_OVERFIT_RISK' : bestDsr < .5 ? 'MODERATE_OVERFIT_RISK' : 'LOWER_OVERFIT_RISK', note: 'Legacy protected split diagnostics only; V9 family variants were inspected on this historical universe.' };
}

function compactAnalysis(analysis: ReturnType<typeof analyzeDirection>) { return { direction: analysis.direction, candidates: analysis.candidates.length, credible: analysis.credible.length, highestFrequency: analysis.highestFrequency ? compactCandidate(analysis.highestFrequency, analysis.direction) : null, highestQuality: analysis.highestQuality ? compactCandidate(analysis.highestQuality, analysis.direction) : null, bestBalanced: analysis.bestBalanced ? compactCandidate(analysis.bestBalanced, analysis.direction) : null, bestValidationStability: analysis.bestValidationStability ? compactCandidate(analysis.bestValidationStability, analysis.direction) : null, bestCostRobustness: analysis.bestCostRobustness ? compactCandidate(analysis.bestCostRobustness, analysis.direction) : null }; }
function detailedAnalysis(analysis: ReturnType<typeof analyzeDirection>, context: Awaited<ReturnType<typeof loadProtectedContext>>) { return { ...compactAnalysis(analysis), top20: [...analysis.credible.length ? analysis.credible : analysis.candidates].sort((left, right) => rank(left[analysis.direction], right[analysis.direction])).slice(0, 20).map((candidate) => detailedCandidate(candidate, analysis.direction, context)) }; }
function compactCandidate(candidate: Candidate, direction: Direction) { return { id: candidate.id, direction, config: candidate.config, policy: candidate.policy, ...compactMetric(candidate[direction]) }; }
function detailedCandidate(candidate: Candidate, direction: Direction, _context: Awaited<ReturnType<typeof loadProtectedContext>>) { const metric = candidate[direction]; return { ...compactCandidate(candidate, direction), train: metric.train, validation: metric.validation, trainToValidationChange: metric.trainToValidationChange, monthly: metric.monthly, halves: metric.halves }; }
function compactMetric(metric: Summary) { return { totalSignals: metric.totalSignals, settledTrades: metric.settledTrades, unavailableTrades: metric.unavailableTrades, ambiguousTrades: metric.ambiguousTrades, tradesPerSession: metric.tradesPerSession, grossExpectancy: metric.grossExpectancy, medianReturn: metric.medianReturn, net: metric.net, targetRate: metric.targetRate, stopRate: metric.stopRate, timeoutRate: metric.timeoutRate, ambiguousRate: metric.ambiguousRate, profitableDayPercent: metric.profitableDayPercent, maxDrawdown: metric.maxDrawdown, maxLosingStreak: metric.maxLosingStreak }; }

function monthly(outcomes: readonly { signal: V9Signal; exit: OptionExitPolicyEvaluationResult }[]) { return ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) => { const settled = outcomes.filter((row) => row.signal.date.startsWith(month) && !row.exit.ambiguous && !row.exit.unavailable && row.exit.premiumChangePercent !== null); const values = settled.map((row) => row.exit.premiumChangePercent!); return { month, trades: settled.length, gross: round(average(values)), netAt040: netAt(values, .4), median: round(median(values)), targetRate: rate(settled.filter((row) => row.exit.exitReason === 'TARGET').length, settled.length), stopRate: rate(settled.filter((row) => row.exit.exitReason === 'STOP_LOSS').length, settled.length) }; }); }
function dailyNet(outcomes: readonly { signal: V9Signal; exit: OptionExitPolicyEvaluationResult }[]) { const map = new Map<string, { trades: number; gross: number; net: number }>(); outcomes.filter((row) => !row.exit.ambiguous && !row.exit.unavailable && row.exit.premiumChangePercent !== null).forEach((row) => { const existing = map.get(row.signal.date) ?? { trades: 0, gross: 0, net: 0 }; existing.trades += 1; existing.gross += row.exit.premiumChangePercent!; existing.net += row.exit.premiumChangePercent! - .4; map.set(row.signal.date, existing); }); return map; }
function finalVerdict(ce: ReturnType<typeof analyzeDirection>, pe: ReturnType<typeof analyzeDirection>, combined: any, overfitRisk: string) { const leaders = [ce.bestBalanced && ce.bestBalanced.CE, pe.bestBalanced && pe.bestBalanced.PE].filter((metric): metric is Summary => !!metric && credibleMetric(metric)); if (!leaders.length) return 'REJECTED'; if (overfitRisk === 'HIGH_OVERFIT_RISK') return 'WEAK'; if (combined.status === 'COMBINED' && leaders.some((metric) => metric.settledTrades >= 50 && Number(metric.net.netAt060) > 0)) return 'PROMISING'; return 'WEAK'; }
function overlapReport() { const v2 = existsSync(resolve(process.cwd(), 'artifacts', 'research-validation', 'v2-session-result-matrix.json')); const v4 = existsSync(resolve(process.cwd(), 'artifacts', 'research-validation', 'v4-session-result-matrix.json')); return { status: 'OVERLAP_NOT_ESTIMABLE', V2: { timestampArtifactAvailable: false, sessionMatrixAvailable: v2 }, V4: { timestampArtifactAvailable: false, sessionMatrixAvailable: v4 }, note: 'Available V2/V4 artifacts contain session-level aggregates, not exact historical signal timestamps; no overlap was inferred.' }; }

function buildAtrMaps(sessions: readonly V9PreparedSession[]) { const engine = new IndicatorEngineService(); const maps = new Map<any, Map<number, number>>(); for (const timeframe of [2, 3] as const) { const values = new Map<number, number>(); sessions.forEach((session) => engine.calculate(session.frames[timeframe], { indicators: [{ type: IndicatorType.ATR, period: 14 }] }).indicators.find((indicator: any) => indicator.config.type === IndicatorType.ATR)?.result.values.forEach((value: any) => { if ('value' in value && typeof value.value === 'number') values.set(value.timestamp.getTime(), value.value); })); maps.set(timeframe, values); } return maps; }
function policyKey(policy: Policy) { return `${policy.target}|${policy.stop}|${policy.hold}`; }
function rate(value: number, total: number) { return round(value / Math.max(1, total) * 100); }
function netAt(values: readonly number[], cost: number) { return values.length ? round(average(values) - cost) : 0; }
function netByCost(values: readonly number[]) { return Object.fromEntries(DEFAULT_COST_SCENARIOS.map((cost) => [`netAt${String(Math.round(cost * 100)).padStart(3, '0')}`, netAt(values, cost)])); }
function round(value: number) { return Number(value.toFixed(4)); }
function completeSession(rows: readonly { timestamp: Date }[]) { const sorted = [...rows].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); return sorted.length === 375 && sorted.every((row, index) => index === 0 || row.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === 60_000); }
function istDate(value: Date) { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function write(name: string, value: unknown) { writeFileSync(resolve(DIRECTORY, name), `${JSON.stringify(value, null, 2)}\n`); }
void run().catch((error) => { console.error('V9 Phase 2 outcome research failed:', error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
