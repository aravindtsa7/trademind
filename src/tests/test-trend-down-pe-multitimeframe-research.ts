import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService, { HistoricalOptionCandleCacheAuthorizedOverfullNormalization, HistoricalOptionCandleCacheSessionResult } from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionPremiumPathAnalysisService from '../modules/options/services/option-premium-path-analysis.service';
import { OptionContract } from '../modules/options/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { CrossSessionPreparedSession, filterCrossSessionResearchTargets, isCooldownEligible, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import { PreparedOptionSignalResolution, prepareOptionSignalResolution } from './helpers/prepared-option-signal-resolution';
import { trendDownRobustnessConfigs } from './helpers/trend-down-robustness-configs';
import { matchesTrendDirectionalEma35Pullback, TrendDirectionalRsiFilter } from './helpers/trend-directional-ema35-pullback';
import { chooseHistoricalOptionExpiry, optionDirectionForResearch } from './helpers/v3-option-cache-diagnostics';

dotenv.config();
logger.silent = true;

const instrumentKey = process.env.RESEARCH_UNDERLYING_INSTRUMENT_KEY?.trim() || 'NSE_INDEX|Nifty 50';
const expectedOneMinuteCandlesPerSession = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const entryTimeframes = [1, 2, 3, 5] as const;
const proximities = [0.05, 0.1, 0.15, 0.2, 0.25] as const;
const v3FastProximities = [0.1, 0.15, 0.2, 0.25, 0.3] as const;
const cooldowns = [0, 2, 3, 5, 10] as const;
const outcomeHorizons = [1, 2, 3, 4, 5, 10, 15] as const;
const excursionHorizons = [3, 5, 10, 15] as const;
const upsideTargets = [3, 5, 7.5, 10, 15, 20] as const;
const downsideStops = [3, 5, 7.5, 10, 15, 20] as const;
const targetStopPairs = [
  [5, 5],
  [7.5, 5],
  [10, 5],
  [10, 7.5],
  [15, 7.5],
  [15, 10],
  [20, 10],
] as const;
const maximumHolds = [3, 5, 10, 15] as const;
const v3TargetStopPairs = [2, 3, 4, 5].flatMap((target) => [2, 3, 4, 5].map((stop) => [target, stop] as const));
const v3MaximumHolds = [5, 7, 10, 15] as const;
const v3CostScenarios = [0.2, 0.4, 0.6] as const;
const qualityMinimumSampleSize = 30;
const resolutionConcurrency = (() => {
  const value = Number(process.env.RESEARCH_OPTION_METADATA_CONCURRENCY ?? '12');
  if (!Number.isInteger(value) || value <= 0) throw new Error('RESEARCH_OPTION_METADATA_CONCURRENCY must be a positive integer.');
  return value;
})();
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const approvedOutOfSessionCleanupCandidates = [
  { instrumentKey: 'NSE_FO|65861|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65859|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65868|04-08-2026', tradingDate: '2026-08-04' },
] as const;
const authorizedTrendUpCeOverfullNormalizations: readonly HistoricalOptionCandleCacheAuthorizedOverfullNormalization[] = [
  { instrumentKey: 'NSE_FO|65867|04-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'NSE_FO|65871|04-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'NSE_FO|65891|04-08-2026', tradingDate: '2026-08-03' },
];

type EntryTimeframe = (typeof entryTimeframes)[number];
type Proximity = (typeof proximities)[number] | (typeof v3FastProximities)[number];
type OutcomeHorizon = (typeof outcomeHorizons)[number];
type ExcursionHorizon = (typeof excursionHorizons)[number];
type RsiFilter = TrendDirectionalRsiFilter;
type TimeBucket = '09:15-10:30' | '10:30-12:00' | '12:00-13:30' | '13:30-15:30';

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}
interface EntryFrame {
  minutes: EntryTimeframe;
  candles: Candle[];
  ema15: Map<number, number>;
  ema35: Map<number, number>;
  rsi14: Map<number, number>;
}
interface RegimePoint {
  availableAt: Date;
  regime: AdaptivePrimaryMarketRegime | undefined;
}
type Session = CrossSessionPreparedSession;
interface EntryConfig {
  timeframe: EntryTimeframe;
  proximity: Proximity;
  rsiFilter: RsiFilter;
  cooldown: number;
}
interface Signal {
  configKey: string;
  config: EntryConfig;
  date: string;
  timestamp: Date;
  spotPrice: number;
  regimeAvailableAt: Date;
}
interface Resolution {
  entryPremium: number;
  changes: Map<OutcomeHorizon, number | null>;
  excursions: Map<ExcursionHorizon, { mfe: number | null; mae: number | null }>;
  reaches: Map<number, number | null>;
  stops: Map<number, number | null>;
  exits: Map<string, OptionExitPolicyEvaluationResult>;
}
interface FailedResolution {
  error: string;
}
interface PercentMetric {
  count: number;
  positive: number;
  negative: number;
  neutral: number;
  positivePercent: number;
  average: number;
  median: number;
}
interface ConfigurationReport {
  config: EntryConfig;
  signals: Signal[];
  resolved: Array<{ signal: Signal; resolution: Resolution }>;
  failed: Signal[];
  outcomes: Record<OutcomeHorizon, PercentMetric>;
  excursions: Record<ExcursionHorizon, { mfe: PercentMetric; mae: PercentMetric }>;
  bestPolicy: PolicyMetric;
}
interface PolicyMetric {
  key: string;
  target: number;
  stop: number;
  hold: number;
  total: number;
  targetCount: number;
  stopCount: number;
  timeCount: number;
  ambiguous: number;
  unavailable: number;
  targetPercent: number;
  stopPercent: number;
  averageReturn: number;
  medianReturn: number;
}
interface ResearchProfile {
  expiryResolutionMs: number;
  optionContractResolutionMs: number;
  requiredSessionKeyConstructionMs: number;
  uniqueSignalResolutionConstructionMs: number;
  optionOutcomeEvaluationMs: number;
  inMemoryOptionSessionLookupMs: number;
  optionContractSelectionMs: number;
  premiumHorizonCalculationMs: number;
  mfeMaeCalculationMs: number;
  thresholdReachCalculationMs: number;
  targetStopPathPreparationMs: number;
  researchPathAnalyticsMs: number;
  policyOutcomeDerivationMs: number;
  configurationMetricCalculationMs: number;
  timeframeRankingConstructionMs: number;
  fastTradeRankingConstructionMs: number;
  targetReachSummaryConstructionMs: number;
  timeOfDaySummaryConstructionMs: number;
  finalFormattingStringConstructionMs: number;
  consoleOutputDurationMs: number;
  analyses: number;
  policies: number;
}

const researchDirection = process.env.RESEARCH_DIRECTION === 'UP' ? 'UP' : 'DOWN';
const rsiFilters: readonly TrendDirectionalRsiFilter[] = researchDirection === 'UP' ? ['NO_RSI_FILTER', 'RSI_GT_50', 'RSI_GT_55', 'RSI_GT_60', 'RSI_GT_65'] : ['NO_RSI_FILTER', 'RSI_LT_50', 'RSI_LT_45', 'RSI_LT_40', 'RSI_LT_35'];
const timeBuckets: readonly TimeBucket[] = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'];
const quiet = process.env.RESEARCH_QUIET === 'true';
const robustnessStudy = process.env.RESEARCH_ROBUSTNESS === 'true';
const v3FastAudit = process.env.RESEARCH_V3_FAST_AUDIT === 'true';
let activeProfile: ResearchProfile | undefined;

function activeTargetStopPairs(): readonly (readonly [number, number])[] {
  return v3FastAudit ? v3TargetStopPairs : targetStopPairs;
}

function activeMaximumHolds(): readonly number[] {
  return v3FastAudit ? v3MaximumHolds : maximumHolds;
}

function report(...values: unknown[]): void {
  const started = Date.now();
  console.log(...values);
  if (activeProfile) activeProfile.consoleOutputDurationMs += Date.now() - started;
}
function reportFillResults(fillResults: readonly HistoricalOptionCandleCacheSessionResult[]): void {
  const stored = fillResults.filter((result) => result.status === 'downloaded' || result.status === 'normalized');
  const normalized = fillResults.filter((result) => result.status === 'normalized');
  const overfull = fillResults.filter((result) => result.status === 'overfull');
  const failed = fillResults.filter((result) => result.status === 'failed');
  report('RESEARCH DATA PREPARATION FILL RESULTS', {
    requestedSessions: fillResults.filter((result) => result.status !== 'hit').length,
    successfulDownloads: stored.length,
    storedSessions: stored.filter((result) => result.storedCandleCount === 375).length,
    normalizedSessions: normalized,
    failedSessions: failed.length,
    overfullSessions: overfull.length,
    totalNewlyStoredCandleRows: stored.reduce((total, result) => total + result.storedCandleCount, 0),
    failures: failed,
    overfull,
  });
}
function measure<T>(profile: ResearchProfile, key: keyof ResearchProfile, work: () => T): T {
  const started = Date.now();
  try {
    return work();
  } finally {
    profile[key] = (profile[key] as number) + Date.now() - started;
  }
}
function parseResearchEndDate(value: string | undefined): string | undefined {
  const endDate = value?.trim();
  if (!endDate) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!match) throw new Error('RESEARCH_END_DATE must use YYYY-MM-DD.');
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error('RESEARCH_END_DATE must be a valid calendar date.');
  return endDate;
}

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } {
  const values = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}
function formatIstMinute(timestamp: Date): string {
  const value = marketDateAndMinute(timestamp);
  return `${value.date} ${String(Math.floor(value.minute / 60)).padStart(2, '0')}:${String(value.minute % 60).padStart(2, '0')}:00 IST`;
}
function isCompleteSession(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandlesPerSession) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = marketDateAndMinute(sorted[0].candleTime);
  const last = marketDateAndMinute(sorted[sorted.length - 1].candleTime);
  return first.minute === marketSessionStartMinute && last.minute === marketSessionEndMinute && sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}
function isCompleteInternalSession(candles: readonly Candle[]): boolean {
  if (candles.length !== expectedOneMinuteCandlesPerSession) return false;
  const sorted = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const first = marketDateAndMinute(sorted[0].timestamp);
  const last = marketDateAndMinute(sorted[sorted.length - 1].timestamp);
  return first.minute === marketSessionStartMinute && last.minute === marketSessionEndMinute && sorted.every((candle, index) => index === 0 || candle.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === 60_000);
}
function toCandle(candle: StoredCandle): Candle {
  const volume = Number(candle.volume);
  const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
  if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored volume or open interest exceeds JavaScript safe-integer precision.');
  return {
    timestamp: new Date(candle.candleTime.getTime()),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume,
    openInterest,
  };
}
function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  if (!indicator) throw new Error(`Missing ${type}${period}.`);
  const values = new Map<number, number>();
  indicator.result.values.forEach((entry) => {
    if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value);
  });
  return values;
}
function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> {
  const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14);
  if (!indicator) throw new Error('Missing ADX14.');
  const values = new Map<number, AdxValue>();
  indicator.result.values.forEach((entry) => {
    if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date });
  });
  return values;
}

function aggregateSessionAnchored(oneMinute: readonly Candle[], minutes: EntryTimeframe): Candle[] {
  if (minutes === 1) return [...oneMinute];
  const result: Candle[] = [];
  for (let index = 0; index + minutes <= oneMinute.length; index += minutes) {
    const slice = oneMinute.slice(index, index + minutes);
    if (slice.length !== minutes) continue;
    result.push({
      timestamp: new Date(slice[0].timestamp.getTime()),
      open: slice[0].open,
      high: Math.max(...slice.map((candle) => candle.high)),
      low: Math.min(...slice.map((candle) => candle.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((total, candle) => total + candle.volume, 0),
      openInterest: slice[slice.length - 1].openInterest,
    });
  }
  return result;
}
function createEntryFrame(candles: Candle[], minutes: EntryTimeframe, engine: IndicatorEngineService): EntryFrame {
  const results = engine.calculate(candles, {
    indicators: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
    ],
  });
  return {
    minutes,
    candles,
    ema15: scalarMap(results, IndicatorType.EMA, 15),
    ema35: scalarMap(results, IndicatorType.EMA, 35),
    rsi14: scalarMap(results, IndicatorType.RSI, 14),
  };
}
function configKey(config: EntryConfig): string {
  return `${config.timeframe}m|${config.proximity}|${config.rsiFilter}|${config.cooldown}`;
}
function rsiThreshold(filter: RsiFilter): number | undefined {
  return filter === 'NO_RSI_FILTER' ? undefined : Number(filter.replace('RSI_LT_', '').replace('RSI_GT_', ''));
}
function latestKnownRegime(session: Session, timestamp: Date): RegimePoint | undefined {
  for (let index = session.regimePoints.length - 1; index >= 0; index -= 1) {
    const point = session.regimePoints[index];
    if (point.availableAt.getTime() <= timestamp.getTime()) return point;
  }
  return undefined;
}
function assertNoLookAhead(signal: Signal): void {
  if (signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`Look-ahead detected for ${signal.timestamp.toISOString()}: regime became available after entry.`);
}
function assertNoLookAheadAtSessionBoundaries(sessions: readonly Session[]): void {
  sessions.forEach((session) => {
    const start = session.oneMinute[0]?.timestamp;
    if (!start) throw new Error(`Session ${session.date} has no candles.`);
    [0, 2, 5].forEach((offsetMinutes) => {
      const timestamp = new Date(start.getTime() + offsetMinutes * 60_000);
      const regime = latestKnownRegime(session, timestamp);
      if (regime && regime.availableAt.getTime() > timestamp.getTime()) throw new Error(`Boundary look-ahead detected at ${timestamp.toISOString()}.`);
    });
  });
}
function generateSignalsForConfig(sessions: readonly Session[], config: EntryConfig): Signal[] {
  const signals: Signal[] = [];
  const regimeDirection = researchDirection === 'UP' ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN;
  sessions.forEach((session) => {
    const frame = session.frames[config.timeframe];
    let lastTimestamp: number | undefined;
    frame.candles.forEach((candle) => {
      const entryTimestamp = new Date(candle.timestamp.getTime() + config.timeframe * 60_000);
      const regime = latestKnownRegime(session, entryTimestamp);
      if (regime?.regime !== regimeDirection) return;
      const key = candle.timestamp.getTime();
      const ema35 = frame.ema35.get(key);
      const rsi = frame.rsi14.get(key);
      if (
        ema35 === undefined ||
        rsi === undefined ||
        !matchesTrendDirectionalEma35Pullback({
          direction: researchDirection,
          close: candle.close,
          high: candle.high,
          low: candle.low,
          ema35,
          rsi,
          proximity: config.proximity,
          rsiFilter: config.rsiFilter,
        })
      )
        return;
      const timestamp = entryTimestamp.getTime();
      if (!isCooldownEligible(lastTimestamp, timestamp, config.cooldown)) return;
      const signal: Signal = {
        configKey: configKey(config),
        config,
        date: session.date,
        timestamp: entryTimestamp,
        spotPrice: candle.close,
        regimeAvailableAt: regime.availableAt,
      };
      assertNoLookAhead(signal);
      signals.push(signal);
      lastTimestamp = timestamp;
    });
  });
  return signals;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>, profile?: ResearchProfile, timer?: 'expiryResolutionMs' | 'optionContractResolutionMs'): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const started = Date.now();
  const pending = create().finally(() => {
    if (profile && timer) profile[timer] += Date.now() - started;
  });
  cache.set(key, pending);
  return pending;
}
function chooseExpiry(expiries: readonly string[], date: string): string {
  return chooseHistoricalOptionExpiry(expiries, date);
}
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      result[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return result;
}
function exitPolicyKey(target: number, stop: number, hold: number): string {
  return `${target}|${stop}|${hold}`;
}
async function resolveSignal(prepared: PreparedOptionSignalResolution<Signal>, preloader: HistoricalOptionResearchPreloaderService, profile: ResearchProfile): Promise<Resolution | FailedResolution> {
  try {
    const { signal, selectedContract: contract } = prepared;
    const candles = await (async () => {
      const started = Date.now();
      try {
        return await preloader.getOptionSession({
          instrumentKey: prepared.instrumentKey,
          tradingDate: prepared.tradingDate,
          metadata: prepared.metadata,
        });
      } finally {
        profile.inMemoryOptionSessionLookupMs += Date.now() - started;
      }
    })();
    const path = measure(profile, 'targetStopPathPreparationMs', () => new OptionPremiumPathAnalysisService(signal.timestamp, candles));
    profile.analyses += 1;
    const analytics = measure(profile, 'researchPathAnalyticsMs', () =>
      path.researchAnalytics({
        changeHorizons: outcomeHorizons,
        excursionHorizons,
        upsideTargets,
        downsideStops,
      }),
    );
    const changes = analytics.changes as Map<OutcomeHorizon, number | null>;
    const excursions = analytics.excursions as Map<ExcursionHorizon, { mfe: number | null; mae: number | null }>;
    const reaches = analytics.reaches as Map<number, number | null>;
    const exits = measure(profile, 'policyOutcomeDerivationMs', () => {
      const values = new Map<string, OptionExitPolicyEvaluationResult>();
      activeTargetStopPairs().forEach(([target, stop]) =>
        activeMaximumHolds().forEach((hold) =>
          values.set(
            exitPolicyKey(target, stop, hold),
            path.evaluate({
              type: 'TARGET_STOP',
              targetPercent: target,
              stopLossPercent: stop,
              maximumHoldingMinutes: hold,
            }),
          ),
        ),
      );
      return values;
    });
    profile.policies += exits.size;
    return {
      entryPremium: analytics.entryPremium,
      changes,
      excursions,
      reaches,
      stops: new Map(),
      exits,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown option resolution failure.' };
  }
}
async function prepareOptionSession(signal: Signal, optionClient: UpstoxExpiredOptionClient, selector: OptionContractSelectorService, expiryCache: Map<string, Promise<string[]>>, contractsCache: Map<string, Promise<OptionContract[]>>, profile: ResearchProfile): Promise<PreparedOptionSignalResolution<Signal>> {
  const expiries = await getOrCreate(expiryCache, instrumentKey, () => optionClient.fetchAvailableExpiries(instrumentKey), profile, 'expiryResolutionMs');
  const expiry = chooseExpiry(expiries, signal.date);
  const contracts = await getOrCreate(contractsCache, `${instrumentKey}|${expiry}`, () => optionClient.fetchExpiredOptionContracts(instrumentKey, expiry), profile, 'optionContractResolutionMs');
  const underlying = contracts[0]?.underlying;
  if (!underlying) throw new Error('Expired option contracts did not include underlying metadata.');
  const contract = measure(profile, 'optionContractSelectionMs', () => {
    const selection = selector.select({
      underlying,
      spotPrice: signal.spotPrice,
      signal: researchDirection === 'UP' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE,
      timestamp: signal.timestamp,
      contracts,
    });
    const selected = contracts.find((value) => value.instrumentKey === selection.instrumentKey);
    if (!selected) throw new Error(`Selected ATM ${researchDirection === 'UP' ? 'CE' : 'PE'} contract was not present.`);
    return selected;
  });
  return measure(profile, 'requiredSessionKeyConstructionMs', () => prepareOptionSignalResolution(signal, contract, signal.date));
}

function percentMetric(values: readonly number[]): PercentMetric {
  const positive = values.filter((value) => value > 0).length;
  const negative = values.filter((value) => value < 0).length;
  const neutral = values.filter((value) => value === 0).length;
  return {
    count: values.length,
    positive,
    negative,
    neutral,
    positivePercent: values.length === 0 ? 0 : (positive / values.length) * 100,
    average: average(values),
    median: median(values),
  };
}
function policyMetric(records: readonly { signal: Signal; resolution: Resolution }[], target: number, stop: number, hold: number): PolicyMetric {
  const exits = records.map((record) => record.resolution.exits.get(exitPolicyKey(target, stop, hold))).filter((value): value is OptionExitPolicyEvaluationResult => value !== undefined);
  const resolved = exits.filter((exit) => !exit.unavailable && !exit.ambiguous && exit.premiumChangePercent !== null);
  const returns = resolved.map((exit) => exit.premiumChangePercent as number);
  const targetCount = exits.filter((exit) => exit.exitReason === 'TARGET').length;
  const stopCount = exits.filter((exit) => exit.exitReason === 'STOP_LOSS').length;
  const timeCount = exits.filter((exit) => exit.exitReason === 'TIME_EXIT').length;
  return {
    key: exitPolicyKey(target, stop, hold),
    target,
    stop,
    hold,
    total: exits.length,
    targetCount,
    stopCount,
    timeCount,
    ambiguous: exits.filter((exit) => exit.ambiguous).length,
    unavailable: exits.filter((exit) => exit.unavailable).length,
    targetPercent: resolved.length === 0 ? 0 : (targetCount / resolved.length) * 100,
    stopPercent: resolved.length === 0 ? 0 : (stopCount / resolved.length) * 100,
    averageReturn: average(returns),
    medianReturn: median(returns),
  };
}
function bestPolicy(records: readonly { signal: Signal; resolution: Resolution }[]): PolicyMetric {
  const metrics = activeTargetStopPairs().flatMap(([target, stop]) => activeMaximumHolds().map((hold) => policyMetric(records, target, stop, hold)));
  return metrics.sort((left, right) => right.targetPercent - left.targetPercent || left.stopPercent - right.stopPercent || right.averageReturn - left.averageReturn || right.medianReturn - left.medianReturn)[0];
}
function reportForConfig(config: EntryConfig, signals: Signal[], resolutions: Map<number, Resolution | FailedResolution>): ConfigurationReport {
  const resolved: Array<{ signal: Signal; resolution: Resolution }> = [];
  const failed: Signal[] = [];
  signals.forEach((signal) => {
    const value = resolutions.get(signal.timestamp.getTime());
    if (value && !('error' in value)) resolved.push({ signal, resolution: value });
    else failed.push(signal);
  });
  const outcomes = Object.fromEntries(outcomeHorizons.map((horizon) => [horizon, percentMetric(resolved.map((record) => record.resolution.changes.get(horizon)).filter((value): value is number => value !== null && value !== undefined))])) as Record<OutcomeHorizon, PercentMetric>;
  const excursions = Object.fromEntries(
    excursionHorizons.map((horizon) => [
      horizon,
      {
        mfe: percentMetric(resolved.map((record) => record.resolution.excursions.get(horizon)?.mfe).filter((value): value is number => value !== null && value !== undefined)),
        mae: percentMetric(resolved.map((record) => record.resolution.excursions.get(horizon)?.mae).filter((value): value is number => value !== null && value !== undefined)),
      },
    ]),
  ) as Record<ExcursionHorizon, { mfe: PercentMetric; mae: PercentMetric }>;
  return {
    config,
    signals,
    resolved,
    failed,
    outcomes,
    excursions,
    bestPolicy: bestPolicy(resolved),
  };
}
function qualityRank(left: ConfigurationReport, right: ConfigurationReport): number {
  return right.outcomes[3].positivePercent - left.outcomes[3].positivePercent || right.outcomes[5].positivePercent - left.outcomes[5].positivePercent || right.outcomes[5].median - left.outcomes[5].median || right.bestPolicy.targetPercent - left.bestPolicy.targetPercent || left.bestPolicy.stopPercent - right.bestPolicy.stopPercent || right.excursions[5].mfe.average - left.excursions[5].mfe.average || left.excursions[5].mae.average - right.excursions[5].mae.average;
}
function formatConfig(config: EntryConfig): string {
  return `${config.timeframe}m proximity=${config.proximity.toFixed(2)}% ${config.rsiFilter} cooldown=${config.cooldown}m`;
}
function printConfiguration(configReport: ConfigurationReport, sessions: readonly Session[]): void {
  const perSession = sessions.map((session) => configReport.resolved.filter((record) => record.signal.date === session.date).length);
  report(`${formatConfig(configReport.config)} | raw=${configReport.signals.length} resolved=${configReport.resolved.length} avg/session=${average(perSession).toFixed(2)} median/session=${median(perSession).toFixed(2)} max/session=${Math.max(...perSession)} zero=${perSession.filter((value) => value === 0).length} | +1=${configReport.outcomes[1].positivePercent.toFixed(2)}% +3=${configReport.outcomes[3].positivePercent.toFixed(2)}% +5=${configReport.outcomes[5].positivePercent.toFixed(2)}% avg5=${configReport.outcomes[5].average.toFixed(2)}% median5=${configReport.outcomes[5].median.toFixed(2)}% | MFE5=${configReport.excursions[5].mfe.average.toFixed(2)}% MAE5=${configReport.excursions[5].mae.average.toFixed(2)}% | bestPolicy=+${configReport.bestPolicy.target}/-${configReport.bestPolicy.stop}/${configReport.bestPolicy.hold}m target=${configReport.bestPolicy.targetPercent.toFixed(2)}% stop=${configReport.bestPolicy.stopPercent.toFixed(2)}% return=${configReport.bestPolicy.averageReturn.toFixed(2)}%`);
}
function printTimeframeBest(timeframe: EntryTimeframe, reports: readonly ConfigurationReport[], sessionCount: number, profile: ResearchProfile): void {
  const ranked = measure(profile, 'timeframeRankingConstructionMs', () => {
    const matching = reports.filter((entry) => entry.config.timeframe === timeframe);
    return {
      frequency: [...matching].sort((left, right) => right.resolved.length - left.resolved.length)[0],
      quality: matching.filter((entry) => entry.resolved.length >= qualityMinimumSampleSize).sort(qualityRank)[0],
      balanced: matching.filter((entry) => entry.resolved.length / sessionCount >= 2 && entry.resolved.length >= qualityMinimumSampleSize).sort(qualityRank)[0],
    };
  });
  report(`\n${timeframe}m TIMEFRAME COMPARISON`);
  [
    ['Highest frequency', ranked.frequency],
    ['Highest quality', ranked.quality],
    ['Best balanced', ranked.balanced],
  ].forEach(([label, value]) => {
    if (!value) {
      report(`${label}: NONE`);
      return;
    }
    const entry = value as ConfigurationReport;
    const line = measure(profile, 'finalFormattingStringConstructionMs', () => `${label}: ${formatConfig(entry.config)} | resolved/session=${(entry.resolved.length / sessionCount).toFixed(2)} | +1=${entry.outcomes[1].positivePercent.toFixed(2)}% +3=${entry.outcomes[3].positivePercent.toFixed(2)}% +5=${entry.outcomes[5].positivePercent.toFixed(2)}% avg5=${entry.outcomes[5].average.toFixed(2)}% median5=${entry.outcomes[5].median.toFixed(2)}% MFE5=${entry.excursions[5].mfe.average.toFixed(2)}% MAE5=${entry.excursions[5].mae.average.toFixed(2)}%`);
    report(line);
  });
}
function bucket(timestamp: Date): TimeBucket {
  const minute = marketDateAndMinute(timestamp).minute;
  if (minute < 10 * 60 + 30) return '09:15-10:30';
  if (minute < 12 * 60) return '10:30-12:00';
  if (minute < 13 * 60 + 30) return '12:00-13:30';
  return '13:30-15:30';
}
function printReachMetrics(records: readonly { signal: Signal; resolution: Resolution }[], profile: ResearchProfile): void {
  const lines = measure(profile, 'targetReachSummaryConstructionMs', () => [
    ...upsideTargets.map((target) => {
      const values = records.map((record) => record.resolution.reaches.get(target)).filter((value): value is number => value !== null && value !== undefined);
      return `+${target}%: reached=${values.length}/${records.length} rate=${(records.length === 0 ? 0 : (values.length / records.length) * 100).toFixed(2)}% median=${median(values).toFixed(2)}m avg=${average(values).toFixed(2)}m`;
    }),
    ...downsideStops.map((stop) => {
      const values = records.map((record) => record.resolution.reaches.get(-stop)).filter((value): value is number => value !== null && value !== undefined);
      return `-${stop}%: reached=${values.length}/${records.length} rate=${(records.length === 0 ? 0 : (values.length / records.length) * 100).toFixed(2)}% median=${median(values).toFixed(2)}m avg=${average(values).toFixed(2)}m`;
    }),
  ]);
  report('\nFAST TARGET REACH TIMES');
  lines.forEach((line) => report(line));
}

type ResolvedRecord = ConfigurationReport['resolved'][number];
const robustnessMonths = [
  { label: 'March', prefix: '2026-03' },
  { label: 'April', prefix: '2026-04' },
  { label: 'May', prefix: '2026-05' },
  { label: 'June', prefix: '2026-06' },
  { label: 'July', prefix: '2026-07' },
  { label: 'Aug 1-4', prefix: '2026-08' },
] as const;
function round(value: number): number {
  return Number(value.toFixed(2));
}
function policyExit(record: ResolvedRecord): OptionExitPolicyEvaluationResult | undefined {
  return record.resolution.exits.get(exitPolicyKey(5, 5, 15));
}
function horizonValues(records: readonly ResolvedRecord[], horizon: OutcomeHorizon): number[] {
  return records.map((record) => record.resolution.changes.get(horizon)).filter((value): value is number => value !== null && value !== undefined);
}
function excursionValues(records: readonly ResolvedRecord[], kind: 'mfe' | 'mae'): number[] {
  return records.map((record) => record.resolution.excursions.get(5)?.[kind]).filter((value): value is number => value !== null && value !== undefined);
}
function policyReturnValues(records: readonly ResolvedRecord[]): number[] {
  return records
    .map(policyExit)
    .filter((exit): exit is OptionExitPolicyEvaluationResult => exit !== undefined && !exit.unavailable && !exit.ambiguous && exit.premiumChangePercent !== null)
    .map((exit) => exit.premiumChangePercent as number);
}
function policySummary(records: readonly ResolvedRecord[]): Record<string, number> {
  const metric = policyMetric(records, 5, 5, 15);
  return {
    targetCount: metric.targetCount,
    targetRate: round(metric.targetPercent),
    stopCount: metric.stopCount,
    stopRate: round(metric.stopPercent),
    timeExits: metric.timeCount,
    ambiguous: metric.ambiguous,
    unavailable: metric.unavailable,
    averagePolicyReturn: round(metric.averageReturn),
    medianPolicyReturn: round(metric.medianReturn),
  };
}
function overallSummary(records: readonly ResolvedRecord[], signalCount: number, sessionCount: number): Record<string, number> {
  const one = percentMetric(horizonValues(records, 1));
  const three = percentMetric(horizonValues(records, 3));
  const five = percentMetric(horizonValues(records, 5));
  const mfe = percentMetric(excursionValues(records, 'mfe'));
  const mae = percentMetric(excursionValues(records, 'mae'));
  return {
    signals: signalCount,
    resolved: records.length,
    resolvedPerSession: round(records.length / sessionCount),
    plus1PositiveRate: round(one.positivePercent),
    plus3PositiveRate: round(three.positivePercent),
    plus5PositiveRate: round(five.positivePercent),
    average5mReturn: round(five.average),
    median5mReturn: round(five.median),
    mfe5: round(mfe.average),
    mae5: round(mae.average),
    ...policySummary(records),
  };
}
function monthlySummary(records: readonly ResolvedRecord[]): Record<string, unknown>[] {
  return robustnessMonths.map(({ label, prefix }) => {
    const scoped = records.filter((record) => record.signal.date.startsWith(prefix));
    const three = percentMetric(horizonValues(scoped, 3));
    const five = percentMetric(horizonValues(scoped, 5));
    return {
      month: label,
      resolved: scoped.length,
      plus3PositiveRate: round(three.positivePercent),
      plus5PositiveRate: round(five.positivePercent),
      average5mReturn: round(five.average),
      median5mReturn: round(five.median),
      ...policySummary(scoped),
    };
  });
}
function chronologicalSummary(records: readonly ResolvedRecord[], sessions: readonly Session[]): Record<string, unknown>[] {
  const midpoint = Math.floor(sessions.length / 2);
  return [
    ['First half', new Set(sessions.slice(0, midpoint).map((session) => session.date))],
    ['Second half', new Set(sessions.slice(midpoint).map((session) => session.date))],
  ].map(([label, dates]) => {
    const scoped = records.filter((record) => (dates as Set<string>).has(record.signal.date));
    const three = percentMetric(horizonValues(scoped, 3));
    const five = percentMetric(horizonValues(scoped, 5));
    return {
      period: label,
      resolved: scoped.length,
      plus3PositiveRate: round(three.positivePercent),
      plus5PositiveRate: round(five.positivePercent),
      average5mReturn: round(five.average),
      median5mReturn: round(five.median),
      ...policySummary(scoped),
    };
  });
}
function sessionRobustness(records: readonly ResolvedRecord[]): Record<string, number> {
  const byDate = new Map<string, number[]>();
  records.forEach((record) => {
    const exit = policyExit(record);
    const value = exit && !exit.unavailable && !exit.ambiguous && exit.premiumChangePercent !== null ? exit.premiumChangePercent : 0;
    byDate.set(record.signal.date, [...(byDate.get(record.signal.date) ?? []), value]);
  });
  const totals = Array.from(byDate.values()).map((values) => values.reduce((total, value) => total + value, 0));
  const active = totals.length;
  const profitable = totals.filter((total) => total > 0).length;
  const losing = totals.filter((total) => total < 0).length;
  return {
    activeSessions: active,
    profitableSessions: profitable,
    losingSessions: losing,
    flatSessions: totals.filter((total) => total === 0).length,
    profitableSessionPercent: round(active === 0 ? 0 : (profitable / active) * 100),
    averageTradesPerActiveSession: round(active === 0 ? 0 : records.length / active),
  };
}
function longestStreak(values: readonly boolean[]): number {
  let current = 0;
  let best = 0;
  values.forEach((value) => {
    current = value ? current + 1 : 0;
    best = Math.max(best, current);
  });
  return best;
}
function sequenceRisk(records: readonly ResolvedRecord[]): Record<string, number> {
  const ordered = [...records].sort((left, right) => left.signal.timestamp.getTime() - right.signal.timestamp.getTime());
  const exits = ordered.map(policyExit);
  const five = ordered.map((record) => record.resolution.changes.get(5));
  return {
    maximumConsecutiveTargetTrades: longestStreak(exits.map((exit) => exit?.exitReason === 'TARGET')),
    maximumConsecutivePositive5mTrades: longestStreak(five.map((value) => value !== null && value !== undefined && value > 0)),
    maximumConsecutiveStopTrades: longestStreak(exits.map((exit) => exit?.exitReason === 'STOP_LOSS')),
    maximumConsecutiveNegative5mTrades: longestStreak(five.map((value) => value !== null && value !== undefined && value < 0)),
    maximumConsecutiveLosingPolicyTrades: longestStreak(exits.map((exit) => !!exit && !exit.unavailable && !exit.ambiguous && (exit.premiumChangePercent ?? 0) < 0)),
  };
}
function outlierDependence(records: readonly ResolvedRecord[]): Record<string, number> {
  const values = horizonValues(records, 5);
  const sorted = [...values].sort((left, right) => left - right);
  const best = sorted.slice(-5);
  const worst = sorted.slice(0, 5);
  const positiveTotal = values.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  return {
    normalAverage5mReturn: round(average(values)),
    averageExcludingBest5: round(average(sorted.slice(0, Math.max(0, sorted.length - 5)))),
    averageExcludingWorst5: round(average(sorted.slice(Math.min(5, sorted.length)))),
    median5mReturn: round(median(values)),
    total5mReturn: round(values.reduce((total, value) => total + value, 0)),
    best5ContributionToPositiveReturnPercent: round(positiveTotal === 0 ? 0 : (best.filter((value) => value > 0).reduce((total, value) => total + value, 0) / positiveTotal) * 100),
    largestWinner: round(sorted.at(-1) ?? 0),
    largestLoser: round(sorted[0] ?? 0),
  };
}
function robustnessClassification(records: readonly ResolvedRecord[], sessions: readonly Session[]): { classification: 'STRONG' | 'PROMISING' | 'UNSTABLE' | 'REJECT'; rationale: string } {
  const five = percentMetric(horizonValues(records, 5));
  const policy = policyMetric(records, 5, 5, 15);
  const monthly = monthlySummary(records);
  const halves = chronologicalSummary(records, sessions);
  const session = sessionRobustness(records);
  const outliers = outlierDependence(records);
  const positiveMonths = monthly.filter((entry) => Number(entry.average5mReturn) > 0 && Number(entry.median5mReturn) > 0).length;
  const halvesPositive = halves.every((entry) => Number(entry.average5mReturn) > 0 && Number(entry.median5mReturn) > 0);
  if (records.length < qualityMinimumSampleSize || five.average <= 0 || five.median <= 0)
    return {
      classification: 'REJECT',
      rationale: 'Insufficient sample or non-positive five-minute average/median.',
    };
  if (positiveMonths >= 4 && halvesPositive && session.profitableSessionPercent >= 55 && policy.averageReturn > 0 && outliers.best5ContributionToPositiveReturnPercent <= 50)
    return {
      classification: 'STRONG',
      rationale: 'Positive median, broad monthly and half-sample support, profitable sessions, and limited top-five dependence.',
    };
  if (positiveMonths >= 3 && policy.averageReturn > 0 && session.profitableSessionPercent >= 45)
    return {
      classification: 'PROMISING',
      rationale: 'Positive central performance with partial temporal support; continue monitoring stability.',
    };
  if (five.average > 0)
    return {
      classification: 'UNSTABLE',
      rationale: 'Positive average but insufficient consistency across months, halves, sessions, or outlier dependence.',
    };
  return { classification: 'REJECT', rationale: 'Does not meet minimum return consistency.' };
}
function tradeDetail(record: ResolvedRecord): Record<string, unknown> {
  const exit = policyExit(record);
  return {
    timestampIst: formatIstMinute(record.signal.timestamp),
    entryPremium: round(record.resolution.entryPremium),
    return5m: round(record.resolution.changes.get(5) ?? 0),
    mfe5: round(record.resolution.excursions.get(5)?.mfe ?? 0),
    mae5: round(record.resolution.excursions.get(5)?.mae ?? 0),
    policyOutcome: exit?.exitReason ?? 'UNAVAILABLE',
    policyReturn: round(exit?.premiumChangePercent ?? 0),
  };
}
function printDailyFixedCapital(reportValue: ConfigurationReport, sessions: readonly Session[], prepared: Map<number, PreparedOptionSignalResolution<Signal>>): void {
  const capital = 100000;
  if (reportValue.resolved.length !== 103) throw new Error(`Frozen V2 candidate reconciliation failed: expected 103 resolved trades, found ${reportValue.resolved.length}.`);
  const rows = reportValue.resolved.map((record) => {
    const exit = policyExit(record);
    const value = exit && !exit.ambiguous && !exit.unavailable && exit.premiumChangePercent !== null ? exit.premiumChangePercent : null;
    return {
      date: record.signal.date,
      timestampIst: formatIstMinute(record.signal.timestamp),
      instrument: prepared.get(record.signal.timestamp.getTime())?.selectedContract.tradingSymbol ?? 'UNKNOWN',
      instrumentKey: prepared.get(record.signal.timestamp.getTime())?.selectedContract.instrumentKey ?? 'UNKNOWN',
      entryPremium: record.resolution.entryPremium,
      exitPremium: exit?.exitPremium ?? null,
      exitReason: exit?.exitReason ?? 'UNAVAILABLE',
      returnPercent: value,
      pnl: value === null ? null : (capital * value) / 100,
    };
  });
  const byDate = new Map<string, typeof rows>();
  rows.forEach((row) => byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]));
  const daily = sessions.map((session) => {
    const trades = byDate.get(session.date) ?? [];
    const settledPnl = trades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
    const unsettledTrades = trades.filter((trade) => trade.pnl === null).length;
    return {
      date: session.date,
      trades,
      settledPnl,
      unsettledTrades,
      settledReturnPercent: (settledPnl / capital) * 100,
    };
  });
  const percent = (value: number | null) => (value === null ? 'N/A' : `${round(value)}%`);
  const rupees = (value: number | null) => (value === null ? 'N/A' : `₹${round(value)}`);
  report('\nDAILY TABLE');
  daily.forEach((day) => {
    const tradeDetails = day.trades.length === 0 ? 'no resolved trades' : day.trades.map((trade) => `${trade.timestampIst} | ${trade.instrument} (${trade.instrumentKey}) | entry=${round(trade.entryPremium)} | exit=${trade.exitPremium === null ? 'N/A' : round(trade.exitPremium)} | ${trade.exitReason} | return=${percent(trade.returnPercent)} | P&L=${rupees(trade.pnl)}`).join(' ; ');
    const total = day.unsettledTrades === 0 ? `return=${percent(day.settledReturnPercent)} P&L=${rupees(day.settledPnl)}` : `known return=${percent(day.settledReturnPercent)} known P&L=${rupees(day.settledPnl)}; ${day.unsettledTrades} AMBIGUOUS/UNAVAILABLE trade(s) unpriced`;
    report(`${day.date} | resolved=${day.trades.length} | ${tradeDetails} | daily ${total}`);
  });
  const active = daily.filter((day) => day.trades.length > 0);
  const counts = (n: number) => daily.filter((day) => day.trades.length === n).length;
  const max = Math.max(...daily.map((day) => day.trades.length));
  const settledPnls = rows.flatMap((row) => (row.pnl === null ? [] : [row.pnl]));
  const streak = (values: readonly number[], predicate: (value: number) => boolean) =>
    values.reduce(
      (state, value) => ({
        current: predicate(value) ? state.current + 1 : 0,
        best: Math.max(state.best, predicate(value) ? state.current + 1 : 0),
      }),
      { current: 0, best: 0 },
    ).best;
  const best = [...active].sort((a, b) => b.settledPnl - a.settledPnl)[0];
  const worst = [...active].sort((a, b) => a.settledPnl - b.settledPnl)[0];
  const busiest = daily.filter((day) => day.trades.length === max);
  const isPositivePnl = (value: number) => value > 0.005;
  const isNegativePnl = (value: number) => value < -0.005;
  const isFlatPnl = (value: number) => !isPositivePnl(value) && !isNegativePnl(value);
  report('DAILY TRADE DISTRIBUTION', {
    zero: counts(0),
    one: counts(1),
    two: counts(2),
    three: counts(3),
    four: counts(4),
    fivePlus: daily.filter((day) => day.trades.length >= 5).length,
    maximumTrades: max,
    maximumTradeDates: busiest.map((day) => day.date),
    averageAllSessions: round(rows.length / sessions.length),
    averageActiveSessions: round(rows.length / active.length),
  });
  report(
    'BEST DAY',
    best && {
      date: best.date,
      trades: best.trades.map((trade) => trade.returnPercent),
      knownTotalReturnPercent: round(best.settledReturnPercent),
      knownRupeePnl: round(best.settledPnl),
      unpricedAmbiguousOrUnavailableTrades: best.unsettledTrades,
    },
  );
  report(
    'WORST DAY',
    worst && {
      date: worst.date,
      trades: worst.trades.map((trade) => trade.returnPercent),
      knownTotalReturnPercent: round(worst.settledReturnPercent),
      knownRupeePnl: round(worst.settledPnl),
      unpricedAmbiguousOrUnavailableTrades: worst.unsettledTrades,
    },
  );
  report('BUSIEST DAY', {
    dates: busiest.map((day) => ({
      date: day.date,
      returns: day.trades.map((trade) => trade.returnPercent),
      knownRupeePnl: round(day.settledPnl),
      unpricedAmbiguousOrUnavailableTrades: day.unsettledTrades,
    })),
    theoreticalMaximumIfAllHit5Percent: capital * 0.05 * max,
  });
  report('₹100000 FIXED-CAPITAL SUMMARY', {
    targetSessions: sessions.length,
    activeSessions: active.length,
    zeroTradeSessions: daily.length - active.length,
    settledPolicyTrades: settledPnls.length,
    unpricedAmbiguousOrUnavailableTrades: rows.length - settledPnls.length,
    grossPnl: round(settledPnls.reduce((sum, value) => sum + value, 0)),
    averagePnlPerResolvedTrade: round(settledPnls.reduce((sum, value) => sum + value, 0) / rows.length),
    averagePnlPerSettledPolicyTrade: round(average(settledPnls)),
    averagePnlAllSessions: round(settledPnls.reduce((sum, value) => sum + value, 0) / sessions.length),
    averagePnlActiveSessions: round(settledPnls.reduce((sum, value) => sum + value, 0) / active.length),
    medianKnownDailyPnl: round(median(daily.map((day) => day.settledPnl))),
    profitableDays: active.filter((day) => day.unsettledTrades === 0 && isPositivePnl(day.settledPnl)).length,
    losingDays: active.filter((day) => day.unsettledTrades === 0 && isNegativePnl(day.settledPnl)).length,
    flatDays: active.filter((day) => day.unsettledTrades === 0 && isFlatPnl(day.settledPnl)).length,
    unclassifiedDaysWithAmbiguousOrUnavailableTrades: active.filter((day) => day.unsettledTrades > 0).length,
    profitableDayPercent: round(active.length === 0 ? 0 : (active.filter((day) => day.unsettledTrades === 0 && isPositivePnl(day.settledPnl)).length / active.length) * 100),
    maxWinningTradeStreak: streak(
      rows.map((row) => row.pnl ?? 0),
      isPositivePnl,
    ),
    maxLosingTradeStreak: streak(
      rows.map((row) => row.pnl ?? 0),
      isNegativePnl,
    ),
    maxProfitableDayStreak: streak(
      daily.map((day) => (day.unsettledTrades === 0 ? day.settledPnl : 0)),
      (value) => value > 0,
    ),
    maxLosingDayStreak: streak(
      daily.map((day) => (day.unsettledTrades === 0 ? day.settledPnl : 0)),
      (value) => value < 0,
    ),
    largestTradeProfit: round(Math.max(...settledPnls)),
    largestTradeLoss: round(Math.min(...settledPnls)),
  });
}

function writeV2SessionResultMatrix(reportValue: ConfigurationReport, sessions: readonly Session[]): void {
  const costs = [0.2, 0.4, 0.6, 0.8, 1.0] as const;
  const rows = sessions.map((session, sessionIndex) => {
    const records = reportValue.resolved.filter((record) => record.signal.date === session.date).sort((left, right) => left.signal.timestamp.getTime() - right.signal.timestamp.getTime());
    const exits = records.map(policyExit);
    const settled = exits.filter((exit): exit is OptionExitPolicyEvaluationResult => !!exit && !exit.ambiguous && !exit.unavailable && exit.premiumChangePercent !== null);
    const returns = settled.map((exit) => exit.premiumChangePercent as number);
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    returns.forEach((value) => { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); });
    return {
      sessionIndex,
      date: session.date,
      signalCount: reportValue.signals.filter((signal) => signal.date === session.date).length,
      settledTrades: settled.length,
      grossDailyReturn: round(returns.reduce((sum, value) => sum + value, 0)),
      netDailyReturnByCost: Object.fromEntries(costs.map((cost) => [`netAt${Math.round(cost * 100).toString().padStart(3, '0')}`, round(returns.reduce((sum, value) => sum + value, 0) - cost * settled.length)])),
      targetCount: exits.filter((exit) => exit?.exitReason === 'TARGET').length,
      stopCount: exits.filter((exit) => exit?.exitReason === 'STOP_LOSS').length,
      timeoutCount: exits.filter((exit) => exit?.exitReason === 'TIME_EXIT').length,
      ambiguousCount: exits.filter((exit) => exit?.ambiguous).length,
      unavailableCount: exits.filter((exit) => exit?.unavailable).length,
      maxIntradayDrawdown: round(maxDrawdown),
      tradeReferences: records.map((record) => ({ timestampIst: formatIstMinute(record.signal.timestamp), timestamp: record.signal.timestamp.toISOString(), outcome: policyExit(record)?.exitReason ?? 'UNAVAILABLE', returnPercent: round(policyExit(record)?.premiumChangePercent ?? 0) })),
    };
  });
  const matrix = {
    version: 'research-session-result-matrix-v1',
    strategyId: 'V2_TREND_DOWN_PE',
    family: 'V2',
    configId: '5m|EMA35 proximity 0.20%|RSI_LT_35|cooldown10m',
    policy: { target: 5, stop: 5, holdMinutes: 15 },
    splitManifestVersion: 'nifty-104-split-v1',
    costScenarios: costs,
    sessions: rows,
    resultMatrix: { sessions: rows.map((row) => row.date), configurations: ['V2_TREND_DOWN_PE|+5/-5/15'], costPercent: 0.4, values: rows.map((row) => [row.netDailyReturnByCost.netAt040]) },
  };
  const directory = resolvePath(process.cwd(), 'artifacts', 'research-validation');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolvePath(directory, 'v2-session-result-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
}
function printRobustnessStudy(reports: readonly ConfigurationReport[], sessions: readonly Session[]): void {
  report('\nTREND_DOWN TEMPORAL ROBUSTNESS STUDY | fixed policy=+5/-5 hold15m');
  const decisions = reports.map((configReport) => {
    const records = configReport.resolved;
    const decision = robustnessClassification(records, sessions);
    report(`\nROBUSTNESS CONFIGURATION | ${formatConfig(configReport.config)}`);
    report('OVERALL', overallSummary(records, configReport.signals.length, sessions.length));
    report('MONTHLY', monthlySummary(records));
    report('CHRONOLOGICAL STABILITY', chronologicalSummary(records, sessions));
    report('SESSION-LEVEL ROBUSTNESS', sessionRobustness(records));
    report('SEQUENCE RISK', sequenceRisk(records));
    report('OUTLIER DEPENDENCE', outlierDependence(records));
    report('CLASSIFICATION', decision);
    return { configuration: formatConfig(configReport.config), ...decision };
  });
  const leader = reports.find((configReport) => configReport.config.timeframe === 5 && configReport.config.proximity === 0.2 && configReport.config.rsiFilter === 'RSI_LT_35' && configReport.config.cooldown === 10);
  if (!leader) throw new Error('The requested leading robustness candidate was not included.');
  const trades = leader.resolved.filter((record) => record.resolution.changes.get(5) !== null && record.resolution.changes.get(5) !== undefined).sort((left, right) => (right.resolution.changes.get(5) ?? 0) - (left.resolution.changes.get(5) ?? 0));
  report('\nLEADING CANDIDATE TOP 10 TRADES', trades.slice(0, 10).map(tradeDetail));
  report('LEADING CANDIDATE BOTTOM 10 TRADES', trades.slice(-10).reverse().map(tradeDetail));
  const leaderDecision = decisions.find((decision) => decision.configuration === formatConfig(leader.config));
  report('\nDECISION SUMMARY', {
    decisions,
    currentLeader: formatConfig(leader.config),
    currentLeaderSurvives: leaderDecision?.classification === 'STRONG' || leaderDecision?.classification === 'PROMISING',
    currentLeaderClassification: leaderDecision?.classification,
  });
}

interface V3Candidate {
  report: ConfigurationReport;
  metric: PolicyMetric;
  grossReturns: number[];
  netAverageAt40: number;
  netMedianAt40: number;
}

function v3Costs(): readonly number[] {
  const configured = process.env.RESEARCH_ESTIMATED_COST_PERCENT?.trim();
  if (!configured) return v3CostScenarios;
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 0) throw new Error('RESEARCH_ESTIMATED_COST_PERCENT must be a non-negative number.');
  return [value];
}

function v3PolicyReturns(records: readonly ResolvedRecord[], metric: PolicyMetric): number[] {
  return records
    .map((record) => record.resolution.exits.get(metric.key))
    .filter((exit): exit is OptionExitPolicyEvaluationResult => !!exit && !exit.unavailable && !exit.ambiguous && exit.premiumChangePercent !== null)
    .map((exit) => exit.premiumChangePercent as number);
}

function v3Candidates(reports: readonly ConfigurationReport[]): V3Candidate[] {
  return reports.flatMap((report) =>
    activeTargetStopPairs().flatMap(([target, stop]) =>
      activeMaximumHolds().map((hold) => {
        const metric = policyMetric(report.resolved, target, stop, hold);
        const grossReturns = v3PolicyReturns(report.resolved, metric);
        return {
          report,
          metric,
          grossReturns,
          netAverageAt40: average(grossReturns) - 0.4,
          netMedianAt40: median(grossReturns) - 0.4,
        };
      }),
    ),
  );
}

function v3Frequency(candidate: V3Candidate, sessions: readonly Session[]): Record<string, number> {
  const counts = sessions.map((session) => candidate.report.resolved.filter((record) => record.signal.date === session.date).length);
  const active = counts.filter((count) => count > 0);
  return {
    tradesPerSession: round(candidate.report.resolved.length / sessions.length),
    averageTradesPerActiveSession: round(active.length === 0 ? 0 : candidate.report.resolved.length / active.length),
    daysWith0Trades: counts.filter((count) => count === 0).length,
    daysWith1To4Trades: counts.filter((count) => count >= 1 && count <= 4).length,
    daysWith5To9Trades: counts.filter((count) => count >= 5 && count <= 9).length,
    daysWith10PlusTrades: counts.filter((count) => count >= 10).length,
    maximumTradesInOneDay: Math.max(...counts),
  };
}

function v3CostSummary(candidate: V3Candidate): Record<string, number> {
  return Object.fromEntries(
    v3Costs().flatMap((cost) => [
      [`netAverageAt${cost.toFixed(2)}`, round(average(candidate.grossReturns) - cost)],
      [`netMedianAt${cost.toFixed(2)}`, round(median(candidate.grossReturns) - cost)],
    ]),
  );
}

function v3CandidateLine(candidate: V3Candidate, sessions: readonly Session[]): string {
  const { report: configReport, metric } = candidate;
  return `${formatConfig(configReport.config)} | +${metric.target}/-${metric.stop}/${metric.hold}m | resolved=${configReport.resolved.length} freq=${(configReport.resolved.length / sessions.length).toFixed(2)}/session | target=${metric.targetPercent.toFixed(2)}% stop=${metric.stopPercent.toFixed(2)}% time=${metric.timeCount} ambiguous=${metric.ambiguous} unavailable=${metric.unavailable} | gross avg=${metric.averageReturn.toFixed(2)}% med=${metric.medianReturn.toFixed(2)}% net@0.20=${(metric.averageReturn - 0.2).toFixed(2)}% net@0.40=${candidate.netAverageAt40.toFixed(2)}% net@0.60=${(metric.averageReturn - 0.6).toFixed(2)}% | MFE5=${configReport.excursions[5].mfe.average.toFixed(2)}% MAE5=${configReport.excursions[5].mae.average.toFixed(2)}%`;
}

function v3Robustness(candidate: V3Candidate, sessions: readonly Session[]): Record<string, unknown> {
  const summarize = (records: readonly ResolvedRecord[]) => {
    const metric = policyMetric(records, candidate.metric.target, candidate.metric.stop, candidate.metric.hold);
    const values = v3PolicyReturns(records, metric);
    return {
      trades: records.length,
      grossAverage: round(average(values)),
      netAverageAt040: round(average(values) - 0.4),
      grossMedian: round(median(values)),
      targetRate: round(metric.targetPercent),
      stopRate: round(metric.stopPercent),
    };
  };
  const monthly = robustnessMonths.map(({ label, prefix }) => ({ month: label, ...summarize(candidate.report.resolved.filter((record) => record.signal.date.startsWith(prefix))) }));
  const midpoint = Math.floor(sessions.length / 2);
  const firstHalf = new Set(sessions.slice(0, midpoint).map((session) => session.date));
  const secondHalf = new Set(sessions.slice(midpoint).map((session) => session.date));
  const exits = [...candidate.report.resolved]
    .sort((left, right) => left.signal.timestamp.getTime() - right.signal.timestamp.getTime())
    .map((record) => record.resolution.exits.get(candidate.metric.key));
  const values = candidate.grossReturns;
  const sorted = [...values].sort((left, right) => left - right);
  const positiveTotal = values.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const daily = new Map<string, number[]>();
  candidate.report.resolved.forEach((record) => {
    const exit = record.resolution.exits.get(candidate.metric.key);
    if (!exit || exit.unavailable || exit.ambiguous || exit.premiumChangePercent === null) return;
    daily.set(record.signal.date, [...(daily.get(record.signal.date) ?? []), exit.premiumChangePercent]);
  });
  const dailyReturns = sessions.map((session) => (daily.get(session.date) ?? []).reduce((total, value) => total + value, 0));
  return {
    monthly,
    halves: [
      { period: 'First half', ...summarize(candidate.report.resolved.filter((record) => firstHalf.has(record.signal.date))) },
      { period: 'Second half', ...summarize(candidate.report.resolved.filter((record) => secondHalf.has(record.signal.date))) },
    ],
    frequency: v3Frequency(candidate, sessions),
    risk: {
      profitableDayPercent: round(dailyReturns.filter((value) => value > 0).length / Math.max(1, dailyReturns.filter((value) => value !== 0).length) * 100),
      maximumLosingTradeStreak: longestStreak(exits.map((exit) => !!exit && !exit.unavailable && !exit.ambiguous && (exit.premiumChangePercent ?? 0) < 0)),
      maximumLosingDayStreak: longestStreak(dailyReturns.map((value) => value < 0)),
      averageExcludingBest5: round(average(sorted.slice(0, Math.max(0, sorted.length - 5)))),
      best5ContributionPercent: round(positiveTotal === 0 ? 0 : (sorted.slice(-5).filter((value) => value > 0).reduce((total, value) => total + value, 0) / positiveTotal) * 100),
      largestWinner: round(sorted.at(-1) ?? 0),
      largestLoser: round(sorted[0] ?? 0),
    },
  };
}

function printV3Research(reports: readonly ConfigurationReport[], sessions: readonly Session[]): void {
  const all = v3Candidates(reports).filter((candidate) => candidate.metric.total >= qualityMinimumSampleSize);
  const viable = all.filter((candidate) => candidate.metric.medianReturn > 0 && candidate.netAverageAt40 > 0 && candidate.metric.targetPercent > candidate.metric.stopPercent);
  const rank = (left: V3Candidate, right: V3Candidate) =>
    right.netAverageAt40 - left.netAverageAt40 || right.netMedianAt40 - left.netMedianAt40 || right.metric.targetPercent - left.metric.targetPercent || left.metric.stopPercent - right.metric.stopPercent || right.report.resolved.length - left.report.resolved.length;
  const ranked = [...(viable.length > 0 ? viable : all)].sort(rank);
  const highestFrequency = [...(viable.length > 0 ? viable : all)].sort((left, right) => right.report.resolved.length - left.report.resolved.length || rank(left, right))[0];
  const bestBalanced = [...(viable.length > 0 ? viable : all)].filter((candidate) => candidate.report.resolved.length / sessions.length >= 1).sort(rank)[0];
  const uniqueLeaders = Array.from(new Map([ranked[0], highestFrequency, bestBalanced].filter((value): value is V3Candidate => !!value).map((candidate) => [`${configKey(candidate.report.config)}|${candidate.metric.key}`, candidate])).values());
  report(`\n${instrumentKey} V3 ${researchDirection === 'UP' ? 'TREND_UP -> CE' : 'TREND_DOWN -> PE'} | configs=${reports.length} policies/config=64 | costs=${v3Costs().map((cost) => `${cost.toFixed(2)}%`).join(', ')}`);
  report('V3 CANDIDATE COUNTS', { policyCandidates: all.length, viableAfter040Cost: viable.length, highestSustainableFrequencyPerSession: round(Math.max(0, ...(viable.map((candidate) => candidate.report.resolved.length / sessions.length))) ) });
  if (!ranked[0]) { report('No V3 candidate met the minimum policy sample size.'); return; }
  report(`Highest-frequency configuration: ${v3CandidateLine(highestFrequency, sessions)}`);
  report(`Highest-quality configuration: ${v3CandidateLine(ranked[0], sessions)}`);
  report(`Best cost-adjusted configuration: ${v3CandidateLine(ranked[0], sessions)}`);
  report(`Best balanced configuration: ${v3CandidateLine(bestBalanced, sessions)}`);
  report('\nV3 TOP 20 CANDIDATES');
  ranked.slice(0, 20).forEach((candidate, index) => report(`${index + 1}. ${v3CandidateLine(candidate, sessions)}`));
  uniqueLeaders.forEach((candidate, index) => {
    report(`\nV3 ROBUSTNESS LEADER ${index + 1}: ${v3CandidateLine(candidate, sessions)}`);
    report('MONTHLY ROBUSTNESS / FREQUENCY / RISK', v3Robustness(candidate, sessions));
    report('COST SENSITIVITY', { grossAverage: round(candidate.metric.averageReturn), grossMedian: round(candidate.metric.medianReturn), ...v3CostSummary(candidate) });
  });
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const profile: ResearchProfile = {
    expiryResolutionMs: 0,
    optionContractResolutionMs: 0,
    requiredSessionKeyConstructionMs: 0,
    uniqueSignalResolutionConstructionMs: 0,
    optionOutcomeEvaluationMs: 0,
    inMemoryOptionSessionLookupMs: 0,
    optionContractSelectionMs: 0,
    premiumHorizonCalculationMs: 0,
    mfeMaeCalculationMs: 0,
    thresholdReachCalculationMs: 0,
    targetStopPathPreparationMs: 0,
    researchPathAnalyticsMs: 0,
    policyOutcomeDerivationMs: 0,
    configurationMetricCalculationMs: 0,
    timeframeRankingConstructionMs: 0,
    fastTradeRankingConstructionMs: 0,
    targetReachSummaryConstructionMs: 0,
    timeOfDaySummaryConstructionMs: 0,
    finalFormattingStringConstructionMs: 0,
    consoleOutputDurationMs: 0,
    analyses: 0,
    policies: 0,
  };
  activeProfile = profile;
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  const requestedAuthorizedNormalization = process.env.RESEARCH_PREPARE_NORMALIZE_AUTHORIZED_OVERFULL === 'true';
  if (requestedAuthorizedNormalization && (researchDirection !== 'UP' || process.env.RESEARCH_PREPARE_ONLY !== 'true')) throw new Error('RESEARCH_PREPARE_NORMALIZE_AUTHORIZED_OVERFULL is permitted only for TREND_UP preparation-only mode.');
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const engine = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({
    trendStrengthThreshold: 20,
    emaProximityPercent: 0.05,
    highVolatilityThreshold: 0.1,
    lowVolatilityThreshold: 0.05,
  });
  const optionClient = new UpstoxExpiredOptionClient(token);
  const candleClient = new UpstoxExpiredOptionCandleClient(token);
  const optionCandleRepository = new HistoricalOptionCandleRepository();
  const candleCacheService = new HistoricalOptionCandleCacheService(optionCandleRepository, candleClient, requestedAuthorizedNormalization ? authorizedTrendUpCeOverfullNormalizations : []);
  const preloader = new HistoricalOptionResearchPreloaderService(repository, optionCandleRepository, candleCacheService);
  const selector = new OptionContractSelectorService();
  const initializationDurationMs = Date.now() - startedAt;
  const underlyingStartedAt = Date.now();
  const underlying = await preloader.preloadUnderlying(instrumentKey, '1minute');
  const complete = Array.from(underlying.underlyingByDate.entries())
    .filter(([, candles]) => isCompleteInternalSession(candles))
    .sort(([left], [right]) => left.localeCompare(right));
  if (complete.length === 0) throw new Error(`No complete sessions are stored for ${instrumentKey}.`);
  const underlyingDurationMs = Date.now() - underlyingStartedAt;
  const requestedLimit = process.env.RESEARCH_SESSION_LIMIT === undefined ? undefined : Number(process.env.RESEARCH_SESSION_LIMIT);
  if (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit <= 0)) throw new Error('RESEARCH_SESSION_LIMIT must be a positive integer.');
  const requestedEndDate = parseResearchEndDate(process.env.RESEARCH_END_DATE);
  const preparationStartedAt = Date.now();
  const preparedSessions = prepareCrossSessionIndicatorWarmup(
    complete.map(([date, candles]) => ({ date, candles })),
    aggregator,
    engine,
    regimeService,
  );
  const dateBoundedSessions = filterCrossSessionResearchTargets(preparedSessions, requestedEndDate);
  const sessions = requestedLimit === undefined ? dateBoundedSessions : dateBoundedSessions.slice(0, requestedLimit);
  if (sessions.length === 0) throw new Error(`No target research sessions exist on or before ${requestedEndDate ?? 'the requested range'}.`);
  assertNoLookAheadAtSessionBoundaries(sessions);
  const readiness = {
    at0915: sessions.filter((session) => session.readiness.at0915).length,
    at0920: sessions.filter((session) => session.readiness.at0920).length,
    at0930: sessions.filter((session) => session.readiness.at0930).length,
  };
  report(`TARGET SESSION RANGE | start=${sessions[0].date} end=${sessions[sessions.length - 1].date} count=${sessions.length}${requestedEndDate === undefined ? '' : ` RESEARCH_END_DATE=${requestedEndDate}`}`);
  report(`CROSS-SESSION INDICATOR READINESS | 09:15=${((readiness.at0915 / sessions.length) * 100).toFixed(2)}% (${readiness.at0915}/${sessions.length}) | 09:20=${((readiness.at0920 / sessions.length) * 100).toFixed(2)}% (${readiness.at0920}/${sessions.length}) | 09:30=${((readiness.at0930 / sessions.length) * 100).toFixed(2)}% (${readiness.at0930}/${sessions.length})`);
  const dailyPnlReport = process.env.RESEARCH_DAILY_PNL_REPORT === 'true';
  const configs: EntryConfig[] = dailyPnlReport ? [{ timeframe: 5, proximity: 0.2, rsiFilter: 'RSI_LT_35', cooldown: 10 }] : v3FastAudit ? entryTimeframes.filter((timeframe) => timeframe < 5).flatMap((timeframe) => v3FastProximities.flatMap((proximity) => rsiFilters.flatMap((rsiFilter) => cooldowns.filter((cooldown) => cooldown < 10).map((cooldown) => ({ timeframe, proximity, rsiFilter, cooldown }))))) : robustnessStudy ? [...trendDownRobustnessConfigs] : (entryTimeframes.flatMap((timeframe) => proximities.flatMap((proximity) => rsiFilters.flatMap((rsiFilter) => cooldowns.map((cooldown) => ({ timeframe, proximity, rsiFilter, cooldown }))))) as EntryConfig[]);
  const signalsByConfig = new Map<string, Signal[]>();
  configs.forEach((config) => signalsByConfig.set(configKey(config), generateSignalsForConfig(sessions, config)));
  const preparationDurationMs = Date.now() - preparationStartedAt;
  const uniqueSignals = Array.from(
    new Map(
      Array.from(signalsByConfig.values())
        .flat()
        .map((signal) => [signal.timestamp.getTime(), signal]),
    ).values(),
  );
  report(`Instrument=${instrumentKey} sessions=${sessions.length} configurations=${configs.length} unique ${researchDirection === 'UP' ? 'CE' : 'PE'} entry timestamps=${uniqueSignals.length}`);
  timeBuckets.forEach((name) => report(`SIGNALS ${name}: ${uniqueSignals.filter((signal) => bucket(signal.timestamp) === name).length}`));
  report('No-look-ahead validation passed: every entry used a fully completed 5m regime candle available at or before the entry timestamp.');
  const optionSessionResolutionStartedAt = Date.now();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractsCache = new Map<string, Promise<OptionContract[]>>();
  const requiredOptionSessions = await mapConcurrent(uniqueSignals, resolutionConcurrency, (signal) => prepareOptionSession(signal, optionClient, selector, expiryCache, contractsCache, profile));
  if (process.env.RESEARCH_PREPARE_CLEAN_OVERFULL === 'true') {
    if (process.env.RESEARCH_PREPARE_ONLY !== 'true') throw new Error('RESEARCH_PREPARE_CLEAN_OVERFULL is permitted only with RESEARCH_PREPARE_ONLY=true.');
    const cleanupRequests = approvedOutOfSessionCleanupCandidates.map((candidate) => {
      const request = requiredOptionSessions.find((entry) => entry.instrumentKey === candidate.instrumentKey && entry.tradingDate === candidate.tradingDate);
      if (!request) throw new Error(`Approved cleanup session is not required by this research scope: instrumentKey=${candidate.instrumentKey} tradingDate=${candidate.tradingDate}.`);
      return request;
    });
    const cleaned = await preloader.removeVerifiedOutOfSessionRows(cleanupRequests);
    report(
      'RESEARCH OUT-OF-SESSION CLEANUP',
      cleaned.map((entry) => ({
        instrumentKey: entry.instrumentKey,
        tradingDate: entry.tradingDate,
        removedRows: entry.removedCandleTimes.length,
        removedCandleTimes: entry.removedCandleTimes.map(formatIstMinute),
      })),
    );
  }
  if (process.env.RESEARCH_PREPARE_DIAGNOSTICS === 'true') {
    const inspection = await preloader.inspectLocalOptionSessions(requiredOptionSessions);
    const unavailable = inspection.sessions.filter((session) => !session.complete);
    const direction = optionDirectionForResearch(researchDirection);
    const manifest = {
      underlyingInstrumentKey: instrumentKey,
      direction,
      targetSessions: sessions.length,
      configurationCount: configs.length,
      uniqueSignalTimestamps: uniqueSignals.length,
      requiredSessions: inspection.sessions.map((session) => ({
        instrumentKey: session.instrumentKey,
        tradingDate: session.tradingDate,
        direction,
        locallyAvailableCandleCount: session.locallyAvailableCandleCount,
        completenessState: session.complete
          ? 'COMPLETE'
          : session.locallyAvailableCandleCount === 0
            ? 'MISSING'
            : 'INCOMPLETE',
      })),
    };
    report('RESEARCH DATA PREPARATION DIAGNOSTICS', {
      targetSessions: sessions.length,
      uniqueSignalTimestamps: uniqueSignals.length,
      uniqueRequiredInstrumentDateSessions: inspection.uniqueRequiredSessions,
      completeLocalSessions: inspection.completeLocalSessions,
      incompleteLocalSessions: inspection.incompleteLocalSessions,
      missingLocalSessions: inspection.missingLocalSessions,
      expectedCandlesPerSession: 375,
      completeness: '375 continuous 1minute candles from 09:15 through 15:29 IST',
      missingOrIncompleteSessions: unavailable,
      optionCandleDownloads: 0,
    });
    report('RESEARCH DATA PREPARATION MANIFEST JSON', JSON.stringify(manifest));
    return;
  }
  try {
    await preloader.preloadOptionSessions(requiredOptionSessions);
  } catch (error) {
    if (process.env.RESEARCH_PREPARE_ONLY === 'true') reportFillResults(candleCacheService.getSessionResults());
    throw error;
  }
  const optionSessionResolutionDurationMs = Date.now() - optionSessionResolutionStartedAt;
  if (process.env.RESEARCH_PREPARE_ONLY === 'true') {
    const stats = preloader.getStats(startedAt);
    const fillResults = candleCacheService.getSessionResults();
    reportFillResults(fillResults);
    report('RESEARCH DATA PREPARATION', {
      targetSessions: sessions.length,
      uniqueSignalTimestamps: uniqueSignals.length,
      uniqueContracts: new Set(requiredOptionSessions.map((request) => request.instrumentKey)).size,
      uniqueContractDateSessions: stats.uniqueOptionContractDateSessions,
      completeLocal: stats.completeLocalSessions,
      incompleteLocal: stats.incompleteLocalSessions,
      missingLocal: stats.missingLocalSessions,
      downloaded: stats.upstoxMissingSessionDownloads,
      totalOptionCandlesStored: await optionCandleRepository.count(),
      totalDurationMs: Date.now() - startedAt,
      researchDataReady: true,
    });
    return;
  }
  const preparedByTimestamp = new Map(requiredOptionSessions.map((prepared) => [prepared.signal.timestamp.getTime(), prepared]));
  const resolutionStartedAt = Date.now();
  const resolvedValues = await mapConcurrent(uniqueSignals, resolutionConcurrency, (signal) => {
    const prepared = preparedByTimestamp.get(signal.timestamp.getTime());
    if (!prepared) throw new Error(`Missing prepared option resolution for ${signal.timestamp.toISOString()}.`);
    return resolveSignal(prepared, preloader, profile);
  });
  const resolutions = new Map<number, Resolution | FailedResolution>(uniqueSignals.map((signal, index) => [signal.timestamp.getTime(), resolvedValues[index]]));
  profile.uniqueSignalResolutionConstructionMs = Date.now() - resolutionStartedAt;
  const aggregationStartedAt = Date.now();
  const reports = configs.map((config) => reportForConfig(config, signalsByConfig.get(configKey(config)) ?? [], resolutions));
  profile.configurationMetricCalculationMs = Date.now() - aggregationStartedAt;
  if (process.env.RESEARCH_VALIDATION_MATRIX === 'true') {
    if (!dailyPnlReport || reports.length !== 1) throw new Error('RESEARCH_VALIDATION_MATRIX requires the single frozen V2 configuration via RESEARCH_DAILY_PNL_REPORT=true.');
    writeV2SessionResultMatrix(reports[0], sessions);
  }
  if (dailyPnlReport) printDailyFixedCapital(reports[0], sessions, preparedByTimestamp);
  if (v3FastAudit) printV3Research(reports, sessions);
  const summaryStartedAt = Date.now();
  if (!quiet) {
    report('\nALL ENTRY CONFIGURATION SUMMARIES');
    reports.forEach((configReport) => printConfiguration(configReport, sessions));
  }
  entryTimeframes.forEach((timeframe) => printTimeframeBest(timeframe, reports, sessions.length, profile));
  const quality = measure(profile, 'fastTradeRankingConstructionMs', () => reports.filter((configReport) => configReport.resolved.length >= qualityMinimumSampleSize).sort(qualityRank));
  report('\nFAST-TRADE QUALITY RANKING');
  quality.slice(0, 20).forEach((configReport, index) => report(measure(profile, 'finalFormattingStringConstructionMs', () => `${index + 1}. ${formatConfig(configReport.config)} | resolved=${configReport.resolved.length} session=${(configReport.resolved.length / sessions.length).toFixed(2)} +3=${configReport.outcomes[3].positivePercent.toFixed(2)}% +5=${configReport.outcomes[5].positivePercent.toFixed(2)}% avg5=${configReport.outcomes[5].average.toFixed(2)}% med5=${configReport.outcomes[5].median.toFixed(2)}% policy=+${configReport.bestPolicy.target}/-${configReport.bestPolicy.stop}/${configReport.bestPolicy.hold}m target=${configReport.bestPolicy.targetPercent.toFixed(2)}% stop=${configReport.bestPolicy.stopPercent.toFixed(2)}% MFE5=${configReport.excursions[5].mfe.average.toFixed(2)}% MAE5=${configReport.excursions[5].mae.average.toFixed(2)}%`)));
  if (!quiet) [3, 5, 10, 15].forEach((minimum) => report(`Configurations >=${minimum} resolved signals/session: ${reports.filter((configReport) => configReport.resolved.length / sessions.length >= minimum).length}`));
  const bestOverall = quality[0];
  if (!bestOverall) throw new Error('No configuration produced the minimum resolved option-premium sample.');
  report(measure(profile, 'finalFormattingStringConstructionMs', () => `\nBEST OVERALL FAST ENTRY: ${formatConfig(bestOverall.config)} | resolved=${bestOverall.resolved.length} (${(bestOverall.resolved.length / sessions.length).toFixed(2)}/session)`));
  printReachMetrics(bestOverall.resolved, profile);
  report('\nBEST OVERALL TIME-OF-DAY');
  const timeOfDayLines = measure(profile, 'timeOfDaySummaryConstructionMs', () =>
    timeBuckets.map((name) => {
      const records = bestOverall.resolved.filter((record) => bucket(record.signal.timestamp) === name);
      const plus3 = percentMetric(records.map((record) => record.resolution.changes.get(3)).filter((value): value is number => value !== null && value !== undefined));
      const plus5 = percentMetric(records.map((record) => record.resolution.changes.get(5)).filter((value): value is number => value !== null && value !== undefined));
      const mfe5 = percentMetric(records.map((record) => record.resolution.excursions.get(5)?.mfe).filter((value): value is number => value !== null && value !== undefined));
      const mae5 = percentMetric(records.map((record) => record.resolution.excursions.get(5)?.mae).filter((value): value is number => value !== null && value !== undefined));
      return `${name}: signals=${bestOverall.signals.filter((signal) => bucket(signal.timestamp) === name).length} resolved=${records.length} +3=${plus3.positivePercent.toFixed(2)}% +5=${plus5.positivePercent.toFixed(2)}% avg5=${plus5.average.toFixed(2)}% MFE5=${mfe5.average.toFixed(2)}% MAE5=${mae5.average.toFixed(2)}%`;
    }),
  );
  timeOfDayLines.forEach((line) => report(line));
  const policyRankingStartedAt = Date.now();
  const allPolicies = quality
    .flatMap((report) =>
      activeTargetStopPairs().flatMap(([target, stop]) =>
        activeMaximumHolds().map((hold) => ({
          report,
          metric: policyMetric(report.resolved, target, stop, hold),
        })),
      ),
    )
    .filter((entry) => entry.metric.total >= qualityMinimumSampleSize)
    .sort((left, right) => right.metric.targetPercent - left.metric.targetPercent || left.metric.stopPercent - right.metric.stopPercent || right.metric.averageReturn - left.metric.averageReturn);
  const policy = allPolicies[0];
  profile.policyOutcomeDerivationMs += Date.now() - policyRankingStartedAt;
  if (policy) report(measure(profile, 'finalFormattingStringConstructionMs', () => `\nBEST FAST TARGET/STOP: ${formatConfig(policy.report.config)} | +${policy.metric.target}%/-${policy.metric.stop}% hold=${policy.metric.hold}m | target=${policy.metric.targetPercent.toFixed(2)}% stop=${policy.metric.stopPercent.toFixed(2)}% time=${policy.metric.timeCount} ambiguous=${policy.metric.ambiguous} unavailable=${policy.metric.unavailable} avgReturn=${policy.metric.averageReturn.toFixed(2)}% medianReturn=${policy.metric.medianReturn.toFixed(2)}%`));
  if (robustnessStudy) printRobustnessStudy(reports, sessions);
  const cacheStats = candleCacheService.getStats();
  const totalCachedCandles = await optionCandleRepository.count();
  const summaryAndOutputDurationMs = Date.now() - summaryStartedAt;
  const preloadStats = preloader.getStats(startedAt);
  const totalDurationMs = Date.now() - startedAt;
  const accountedDurationMs = initializationDurationMs + underlyingDurationMs + preparationDurationMs + optionSessionResolutionDurationMs + profile.uniqueSignalResolutionConstructionMs + profile.configurationMetricCalculationMs + summaryAndOutputDurationMs;
  const unaccountedDurationMs = totalDurationMs - accountedDurationMs;
  report('PERFORMANCE PROFILE', {
    targetSessions: sessions.length,
    quiet,
    initializationDurationMs,
    underlyingPreloadMs: underlyingDurationMs,
    crossSessionWarmupIndicatorsAndCandidateGenerationMs: preparationDurationMs,
    uniqueOptionSessionResolutionMs: optionSessionResolutionDurationMs,
    expiryResolutionMs: profile.expiryResolutionMs,
    optionContractResolutionMs: profile.optionContractResolutionMs,
    requiredSessionKeyConstructionMs: profile.requiredSessionKeyConstructionMs,
    bulkPreloadMs: preloadStats.bulkPreloadDurationMs,
    uniqueSignalResolutionConstructionMs: profile.uniqueSignalResolutionConstructionMs,
    optionOutcomeEvaluationMs: profile.optionOutcomeEvaluationMs,
    inMemoryOptionSessionLookupMs: profile.inMemoryOptionSessionLookupMs,
    optionContractSelectionMs: profile.optionContractSelectionMs,
    premiumHorizonCalculationMs: profile.premiumHorizonCalculationMs,
    mfeMaeCalculationMs: profile.mfeMaeCalculationMs,
    thresholdReachCalculationMs: profile.thresholdReachCalculationMs,
    targetStopPathPreparationMs: profile.targetStopPathPreparationMs,
    researchPathAnalyticsMs: profile.researchPathAnalyticsMs,
    policyOutcomeDerivationMs: profile.policyOutcomeDerivationMs,
    configurationMetricCalculationMs: profile.configurationMetricCalculationMs,
    timeframeRankingConstructionMs: profile.timeframeRankingConstructionMs,
    fastTradeRankingConstructionMs: profile.fastTradeRankingConstructionMs,
    targetReachSummaryConstructionMs: profile.targetReachSummaryConstructionMs,
    timeOfDaySummaryConstructionMs: profile.timeOfDaySummaryConstructionMs,
    finalFormattingStringConstructionMs: profile.finalFormattingStringConstructionMs,
    summaryAndOutputDurationMs,
    consoleOutputDurationMs: profile.consoleOutputDurationMs,
    accountedDurationMs,
    unaccountedDurationMs,
    totalCandidateReferences: Array.from(signalsByConfig.values()).reduce((total, signals) => total + signals.length, 0),
    uniqueSignalTimestamps: uniqueSignals.length,
    uniqueOptionContractDateSessions: preloadStats.uniqueOptionContractDateSessions,
    optionSessionsLoadedFromMySql: preloadStats.optionSessionsLoadedFromMySql,
    optionCandlesLoadedFromMySql: preloadStats.optionCandlesLoadedFromMySql,
    completeLocalSessions: preloadStats.completeLocalSessions,
    incompleteLocalSessions: preloadStats.incompleteLocalSessions,
    missingLocalSessions: preloadStats.missingLocalSessions,
    inMemoryLookupHits: preloadStats.inMemoryLookupHits,
    dbFallbackHits: preloadStats.dbFallbackHits,
    upstoxDownloads: preloadStats.upstoxMissingSessionDownloads,
    bulkPreloadQueryCount: preloadStats.bulkPreloadQueryCount,
    bulkPreloadDurationMs: preloadStats.bulkPreloadDurationMs,
    optionPathAnalysesCreated: profile.analyses,
    policyOutcomesDerived: profile.policies,
    estimatedRawCandleScansAvoided: profile.policies - profile.analyses,
    totalDurationMs,
  });
  report(measure(profile, 'finalFormattingStringConstructionMs', () => `\nOPTION CANDLE CACHE | hits=${cacheStats.hits} misses=${cacheStats.misses} stored=${cacheStats.stored} totalStored=${totalCachedCandles} durationMs=${totalDurationMs}`));
  report('RESEARCH PRELOAD', preloader.getStats(startedAt));
  logger.info('TREND_DOWN multi-timeframe PE entry research completed', {
    sessions: sessions.length,
    configs: configs.length,
    uniqueSignals: uniqueSignals.length,
    cacheStats,
    totalCachedCandles,
    durationMs: totalDurationMs,
  });
  activeProfile = undefined;
}

run().catch((error) => {
  logger.error('TREND_DOWN multi-timeframe PE entry research failed', { error });
  console.error('TREND_DOWN multi-timeframe PE entry research failed.', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
