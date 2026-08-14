import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { ResearchSplitManifest } from '../modules/research-validation/types/research-validation.types';
import { buildV8StructuralLevels, createV8BullishReclaimConfigs, generateV8BullishReclaimSignals, V8BullishReclaimConfig, V8BullishReclaimSignal, V8IndicatorContext, V8PreparedSession, V8_STRATEGY_ID } from '../modules/research/v8-nifty-bullish-reclaim';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const endDate = '2026-08-04';
const splitPath = resolve(process.cwd(), 'artifacts', 'research-validation', 'nifty-104-split-v1.json');
const artifactPath = resolve(process.cwd(), 'artifacts', 'v8-nifty-bullish-reclaim', 'phase-1-signal-distribution.json');

interface ConfigResult { config: V8BullishReclaimConfig; configKey: string; signalCount: number; signalsPerSession: number; signals: V8BullishReclaimSignal[]; }

async function run(): Promise<void> {
  const manifest = JSON.parse(readFileSync(splitPath, 'utf8')) as ResearchSplitManifest;
  const allowedDates = new Set(manifest.sessions.filter((entry) => entry.split === 'TRAIN' || entry.split === 'VALIDATION').map((entry) => entry.tradingDate).filter((date) => date <= endDate));
  if (allowedDates.size !== 80) throw new Error(`Expected 80 TRAIN+VALIDATION sessions through ${endDate}; found ${allowedDates.size}.`);

  const repository = new HistoricalCandleRepository();
  const underlyingRows = await repository.findByInstrumentAndTimeframe(instrumentKey, '1minute');
  const byDate = new Map<string, ReturnType<typeof toCandle>[]>();
  underlyingRows.forEach((row) => { const candle = toCandle(row); const date = istDate(candle.timestamp); byDate.set(date, [...(byDate.get(date) ?? []), candle]); });
  const complete = [...byDate.entries()].filter(([, candles]) => isCompleteSession(candles)).sort(([left], [right]) => left.localeCompare(right));
  const allPrepared = prepareCrossSessionIndicatorWarmup(
    complete.map(([date, candles]) => ({ date, candles })),
    new CandleTimeframeAggregatorService(),
    new IndicatorEngineService(),
    new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.1, lowVolatilityThreshold: 0.05 }),
  );
  const prepared = filterCrossSessionResearchTargets(allPrepared, endDate).filter((session) => allowedDates.has(session.date)) as V8PreparedSession[];
  if (prepared.length !== 80) throw new Error(`Prepared protected target session count mismatch: ${prepared.length}.`);
  const engine = new IndicatorEngineService();
  const indicators = createIndicators(prepared, engine);
  const configs = createV8BullishReclaimConfigs();
  const results: ConfigResult[] = configs.map((config) => { const signals = generateV8BullishReclaimSignals(prepared, config, indicators); return { config, configKey: `${V8_STRATEGY_ID}|${config.timeframe}|${config.levelFamily}|${config.reclaimBufferAtr}|${config.bullishBodyAtr}|${config.rsiMinimum}|${config.regimeMode}|${config.cooldownMinutes}`, signalCount: signals.length, signalsPerSession: signals.length / prepared.length, signals }; });
  const noLookAheadViolations = results.flatMap((entry) => entry.signals.filter((signal) => signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()).map((signal) => `${entry.configKey}|${signal.timestamp.toISOString()}`));
  const suspicious = runSuspiciousChecks(results, prepared);
  const sorted = [...results].sort((left, right) => right.signalsPerSession - left.signalsPerSession || left.configKey.localeCompare(right.configKey));
  const midTargets = [0.5, 1, 1.5, 2];
  const mid = midTargets.map((target) => [...results].filter((entry) => entry.signalsPerSession >= 0.5 && entry.signalsPerSession <= 2).sort((left, right) => Math.abs(left.signalsPerSession - target) - Math.abs(right.signalsPerSession - target) || left.configKey.localeCompare(right.configKey))[0]).filter((entry, index, values) => entry !== undefined && values.findIndex((value) => value?.configKey === entry.configKey) === index);
  const artifact = {
    strategyId: V8_STRATEGY_ID,
    phase: 'PHASE_1_SIGNAL_DISTRIBUTION_ONLY',
    outcomeEvaluation: false,
    exitsEvaluated: false,
    optionDataRead: false,
    optionDownloads: 0,
    scope: { instrumentKey, startDate: prepared[0]?.date, endDate, targetSessions: prepared.length, splitManifest: 'nifty-104-split-v1', includedSplits: ['TRAIN', 'VALIDATION'], excludedSplits: ['EMBARGO_1', 'EMBARGO_2', 'FINAL_HOLDOUT'], currentSessionExcluded: '2026-08-13' },
    totalConfigurations: configs.length,
    frequencyBuckets: frequencyBuckets(results),
    frequencyDistribution: distribution(results.map((entry) => entry.signalsPerSession)),
    aggregates: { timeframe: aggregateBy(results, (entry) => `${entry.config.timeframe}m`), levelFamily: aggregateBy(results, (entry) => entry.config.levelFamily), reclaimBufferAtr: aggregateBy(results, (entry) => String(entry.config.reclaimBufferAtr)), bullishBodyAtr: aggregateBy(results, (entry) => String(entry.config.bullishBodyAtr)), rsiMinimum: aggregateBy(results, (entry) => String(entry.config.rsiMinimum)), regimeMode: aggregateBy(results, (entry) => entry.config.regimeMode), cooldownMinutes: aggregateBy(results, (entry) => `${entry.config.cooldownMinutes}m`) },
    highestFrequencyConfigurations: sorted.slice(0, 20).map(compact),
    representativeMidFrequencyConfigurations: mid.map(compact),
    highestFrequencySignalCountsByDate: sorted.slice(0, 5).map((entry) => ({ configKey: entry.configKey, byDate: countByDate(entry.signals) })),
    suspiciousChecks: { ...suspicious, regimeNewerThanSignalCompletion: noLookAheadViolations },
    recommendation: Object.values(suspicious).some((value) => Array.isArray(value) && value.length > 0) || noLookAheadViolations.length > 0 ? 'FIX_SIGNAL_ENGINE_FIRST' : 'SAFE_TO_RUN_OUTCOME_RESEARCH',
  };
  mkdirSync(resolve(process.cwd(), 'artifacts', 'v8-nifty-bullish-reclaim'), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ strategyId: V8_STRATEGY_ID, targetSessions: prepared.length, configurations: configs.length, frequencyBuckets: artifact.frequencyBuckets, frequencyDistribution: artifact.frequencyDistribution, suspiciousChecks: artifact.suspiciousChecks, recommendation: artifact.recommendation, artifact: 'artifacts/v8-nifty-bullish-reclaim/phase-1-signal-distribution.json', outcomeEvaluation: false, optionDownloads: 0 }, null, 2));
}

function createIndicators(sessions: readonly V8PreparedSession[], engine: IndicatorEngineService): V8IndicatorContext {
  const maps = ([2, 3] as const).map((timeframe) => {
    const values = new Map<number, number>();
    sessions.forEach((session) => {
      const result = engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] });
      const indicator = result.indicators.find((entry) => entry.config.type === IndicatorType.ATR);
      indicator?.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); });
    });
    return [timeframe, values] as const;
  });
  return { atr14ByFrame: new Map(maps) };
}

function runSuspiciousChecks(results: readonly ConfigResult[], sessions: readonly V8PreparedSession[]) {
  const duplicateSignalTimestamps: string[] = [];
  const duplicateEpisodes: string[] = [];
  const structuralLevelViolations: string[] = [];
  const openingRangeTimingViolations: string[] = [];
  const pdhViolations: string[] = [];
  const swingLookaheadViolations: string[] = [];
  const cooldownViolations: string[] = [];
  const sessionByDate = new Map(sessions.map((session) => [session.date, session]));
  results.forEach((entry) => {
    const timestamps = new Set<number>();
    const episodes = new Set<number>();
    let previous: number | undefined;
    entry.signals.forEach((signal) => {
      const timestamp = signal.timestamp.getTime();
      if (timestamps.has(timestamp)) duplicateSignalTimestamps.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      timestamps.add(timestamp);
      if (signal.interactionTimestamp !== undefined) {
        const episode = signal.interactionTimestamp.getTime();
        if (episodes.has(episode)) duplicateEpisodes.push(`${entry.configKey}|${signal.timestamp.toISOString()}|episode=${signal.interactionTimestamp.toISOString()}`);
        episodes.add(episode);
      }
      if (previous !== undefined && timestamp - previous < entry.config.cooldownMinutes * 60_000) cooldownViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      previous = timestamp;
      const session = sessionByDate.get(signal.date);
      if (!session) return;
      const levels = buildV8StructuralLevels(session, entry.config.timeframe, entry.config.levelFamily, previousDayHigh(sessions, signal.date));
      const candleKey = timestamp - entry.config.timeframe * 60_000;
      const expected = levels.get(candleKey);
      if (expected === undefined || Math.abs(expected - signal.structuralLevel) > 1e-9) structuralLevelViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      const minute = istMinute(signal.timestamp);
      if (entry.config.levelFamily === 'OR15_HIGH' && minute < 570) openingRangeTimingViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      if (entry.config.levelFamily === 'OR30_HIGH' && minute < 585) openingRangeTimingViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      if (entry.config.levelFamily === 'PDH' && signal.structuralLevel !== previousDayHigh(sessions, signal.date)) pdhViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
      if (entry.config.levelFamily === 'RECENT_SWING_HIGH' && expected !== undefined && expected >= signal.spotPrice && signal.interactionTimestamp && signal.interactionTimestamp.getTime() >= candleKey) swingLookaheadViolations.push(`${entry.configKey}|${signal.timestamp.toISOString()}`);
    });
  });
  return { duplicateSignalTimestamps, duplicateEpisodes, structuralLevelViolations, openingRangeTimingViolations, pdhViolations, recentSwingLookaheadViolations: swingLookaheadViolations, cooldownViolations };
}

function previousDayHigh(sessions: readonly V8PreparedSession[], date: string): number | undefined {
  const ordered = [...sessions].sort((left, right) => left.date.localeCompare(right.date));
  const index = ordered.findIndex((session) => session.date === date);
  return index > 0 ? Math.max(...ordered[index - 1].oneMinute.map((candle) => candle.high)) : undefined;
}
function compact(entry: ConfigResult) { return { configKey: entry.configKey, config: entry.config, signalCount: entry.signalCount, signalsPerSession: round(entry.signalsPerSession) }; }
function aggregateBy(results: readonly ConfigResult[], selector: (entry: ConfigResult) => string) { const groups = new Map<string, number[]>(); results.forEach((entry) => groups.set(selector(entry), [...(groups.get(selector(entry)) ?? []), entry.signalsPerSession])); return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, { configurations: values.length, average: round(values.reduce((sum, value) => sum + value, 0) / values.length), median: round(percentile(values, 0.5)), p90: round(percentile(values, 0.9)), max: round(Math.max(...values)) }])); }
function frequencyBuckets(results: readonly ConfigResult[]) { return { zero: results.filter((entry) => entry.signalCount === 0).length, below025: results.filter((entry) => entry.signalsPerSession > 0 && entry.signalsPerSession < 0.25).length, from025To05: results.filter((entry) => entry.signalsPerSession >= 0.25 && entry.signalsPerSession < 0.5).length, from05To1: results.filter((entry) => entry.signalsPerSession >= 0.5 && entry.signalsPerSession < 1).length, from1To2: results.filter((entry) => entry.signalsPerSession >= 1 && entry.signalsPerSession <= 2).length, from2To5: results.filter((entry) => entry.signalsPerSession > 2 && entry.signalsPerSession <= 5).length, above5: results.filter((entry) => entry.signalsPerSession > 5).length }; }
function distribution(values: readonly number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, 0.5)), p75: round(percentile(values, 0.75)), p90: round(percentile(values, 0.9)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) }; }
function percentile(values: readonly number[], p: number) { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0; }
function countByDate(signals: readonly V8BullishReclaimSignal[]) { return Object.fromEntries([...signals.reduce((map, signal) => map.set(signal.date, (map.get(signal.date) ?? 0) + 1), new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right))); }
function toCandle(row: { candleTime: Date; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown }) { return { timestamp: new Date(row.candleTime.getTime()), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }; }
function isCompleteSession(candles: readonly { timestamp: Date }[]) { const ordered = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); if (ordered.length !== 375) return false; return ordered.every((candle, index) => index === 0 || candle.timestamp.getTime() - ordered[index - 1].timestamp.getTime() === 60_000) && istMinute(ordered[0].timestamp) === 555 && istMinute(ordered[374].timestamp) === 929; }
function istDate(timestamp: Date) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return `${p.year}-${p.month}-${p.day}`; }
function istMinute(timestamp: Date) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return Number(p.hour) * 60 + Number(p.minute); }
function round(value: number) { return Number(value.toFixed(6)); }

void run().catch((error) => { console.error('V8 phase-1 signal distribution failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
