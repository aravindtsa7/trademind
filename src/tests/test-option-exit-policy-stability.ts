import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicy, OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

dotenv.config();

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandleCount = 375;
const researchWindowSessions = 40;
const stepSessions = 20;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}

type CompleteSession = [date: string, candles: StoredCandle[]];

interface StrategySignalRecord {
  timestamp: Date;
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  spotPrice: number;
}

interface ResolvedOptionSignal extends StrategySignalRecord {
  candles: ExpiredOptionCandleDto[];
  entryPremium: number;
}

interface PolicyDefinition {
  id: string;
  label: string;
  policy: OptionExitPolicy;
}

interface WindowPolicyMetrics {
  definition: PolicyDefinition;
  strategySignalCount: number;
  resolvedOptionCount: number;
  evaluatedExitCount: number;
  unavailableCount: number;
  ambiguousCount: number;
  positiveOutcomeCount: number;
  negativeOutcomeCount: number;
  positiveOutcomePercent: number | null;
  averagePremiumChangePercent: number | null;
  medianPremiumChangePercent: number | null;
  bestPremiumChangePercent: number | null;
  worstPremiumChangePercent: number | null;
  averageHoldingMinutes: number | null;
  medianHoldingMinutes: number | null;
  targetCount: number;
  stopLossCount: number;
  timeExitCount: number;
  targetPercent: number | null;
  stopLossPercent: number | null;
  timeExitPercent: number | null;
}

interface WindowResult {
  fromDate: string;
  toDate: string;
  sessionCount: number;
  metrics: WindowPolicyMetrics[];
}

interface ResolutionCaches {
  expiryCache: Map<string, Promise<string[]>>;
  contractsCache: Map<string, Promise<OptionContract[]>>;
  candleCache: Map<string, Promise<ExpiredOptionCandleDto[]>>;
}

const policies: readonly PolicyDefinition[] = [
  { id: 'fixed-30m', label: 'FIXED_TIME 30m', policy: { type: 'FIXED_TIME', holdingMinutes: 30 } },
  { id: 'fixed-60m', label: 'FIXED_TIME 60m', policy: { type: 'FIXED_TIME', holdingMinutes: 60 } },
  { id: 'target20-stop15', label: 'TARGET 20% / STOP 15% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 20, stopLossPercent: 15, maximumHoldingMinutes: 60 } },
  { id: 'target25-stop15', label: 'TARGET 25% / STOP 15% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 25, stopLossPercent: 15, maximumHoldingMinutes: 60 } },
  { id: 'target30-stop20', label: 'TARGET 30% / STOP 20% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 } },
];

function getMarketDateAndMinute(timestamp: Date): { date: string; minuteOfDay: number } {
  const parts = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isCompleteTradingDay(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = getMarketDateAndMinute(sorted[0].candleTime);
  const last = getMarketDateAndMinute(sorted[sorted.length - 1].candleTime);
  return first.minuteOfDay === marketSessionStartMinute && last.minuteOfDay === marketSessionEndMinute &&
    sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}

function toInternalCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap(([, candles]) => candles)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map((candle) => {
      const volume = Number(candle.volume);
      const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
      if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
        throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
      }
      return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
    });
}

function getScalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  const value = indicator?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function getExpiryForDate(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((candidate) => candidate >= date).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`);
  return expiry;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const value = create();
  cache.set(key, value);
  return value;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

function format(value: number | null, suffix = ''): string {
  return value === null ? 'N/A' : `${value.toFixed(2)}${suffix}`;
}

function generateSignals(sessions: readonly CompleteSession[]): StrategySignalRecord[] {
  const oneMinuteCandles = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinuteCandles.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinuteCandles = new CandleTimeframeAggregatorService().aggregate(oneMinuteCandles, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinuteCandles, {
    indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }],
  });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: StrategySignalRecord[] = [];

  fiveMinuteCandles.forEach((candle, index) => {
    const previous = fiveMinuteCandles[index - 1];
    if (!previous) return;
    const previousFast = getScalar(indicators, IndicatorType.EMA, 15, previous.timestamp);
    const currentFast = getScalar(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = getScalar(indicators, IndicatorType.EMA, 35, previous.timestamp);
    const currentSlow = getScalar(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = getScalar(indicators, IndicatorType.RSI, 14, candle.timestamp);
    const spotPrice = spotByTimestamp.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spotPrice].some((value) => value === undefined)) return;

    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    const confirmed = (crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) ||
      (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45);
    if (confirmed && (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE)) {
      signals.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });
  return signals;
}

async function resolveSignals(
  signals: readonly StrategySignalRecord[],
  expiredOptionClient: UpstoxExpiredOptionClient,
  expiredCandleClient: UpstoxExpiredOptionCandleClient,
  selector: OptionContractSelectorService,
  caches: ResolutionCaches
): Promise<ResolvedOptionSignal[]> {
  const resolved: ResolvedOptionSignal[] = [];
  for (const signal of signals) {
    try {
      const signalDate = getMarketDateAndMinute(signal.timestamp).date;
      const expiries = await getOrCreate(caches.expiryCache, underlyingInstrumentKey, () => expiredOptionClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const expiry = getExpiryForDate(expiries, signalDate);
      const contracts = await getOrCreate(caches.contractsCache, `${underlyingInstrumentKey}|${expiry}`, () => expiredOptionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const candles = await getOrCreate(caches.candleCache, `${selected.instrumentKey}|${signalDate}`, () => expiredCandleClient.fetchCandles(selected.instrumentKey, signalDate, signalDate));
      const entryCandle = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entryCandle) throw new Error('No option candle aligns exactly with the signal timestamp.');
      resolved.push({ ...signal, candles, entryPremium: entryCandle.close });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.log(`UNAVAILABLE CONTRACT/CANDLES | ${signal.timestamp.toISOString()} | ${signal.signal} | ${message}`);
    }
  }
  return resolved;
}

function calculateMetrics(
  definition: PolicyDefinition,
  strategySignalCount: number,
  resolvedOptionCount: number,
  results: readonly OptionExitPolicyEvaluationResult[]
): WindowPolicyMetrics {
  const ambiguousCount = results.filter((result) => result.ambiguous).length;
  const evaluated = results.filter((result) => !result.unavailable && !result.ambiguous && result.premiumChangePercent !== null);
  const changes = evaluated.map((result) => result.premiumChangePercent as number);
  const holdings = evaluated.map((result) => result.holdingMinutes).filter((value): value is number => value !== null);
  const positiveOutcomeCount = changes.filter((value) => value > 0).length;
  const negativeOutcomeCount = changes.filter((value) => value < 0).length;
  const targetCount = results.filter((result) => result.exitReason === 'TARGET').length;
  const stopLossCount = results.filter((result) => result.exitReason === 'STOP_LOSS').length;
  const timeExitCount = results.filter((result) => result.exitReason === 'TIME_EXIT').length;
  const nonUnavailableOutcomes = results.filter((result) => !result.unavailable).length;
  return {
    definition,
    strategySignalCount,
    resolvedOptionCount,
    evaluatedExitCount: evaluated.length,
    unavailableCount: strategySignalCount - evaluated.length - ambiguousCount,
    ambiguousCount,
    positiveOutcomeCount,
    negativeOutcomeCount,
    positiveOutcomePercent: percentage(positiveOutcomeCount, evaluated.length),
    averagePremiumChangePercent: average(changes),
    medianPremiumChangePercent: median(changes),
    bestPremiumChangePercent: changes.length === 0 ? null : Math.max(...changes),
    worstPremiumChangePercent: changes.length === 0 ? null : Math.min(...changes),
    averageHoldingMinutes: average(holdings),
    medianHoldingMinutes: median(holdings),
    targetCount,
    stopLossCount,
    timeExitCount,
    targetPercent: definition.policy.type === 'TARGET_STOP' ? percentage(targetCount, nonUnavailableOutcomes) : null,
    stopLossPercent: definition.policy.type === 'TARGET_STOP' ? percentage(stopLossCount, nonUnavailableOutcomes) : null,
    timeExitPercent: definition.policy.type === 'TARGET_STOP' ? percentage(timeExitCount, nonUnavailableOutcomes) : null,
  };
}

function printWindow(result: WindowResult): void {
  console.log(`\nWindow ${result.fromDate} to ${result.toDate} (${result.sessionCount} sessions)`);
  console.log('Policy | Signals | Resolved | Evaluated | Unavailable | Ambiguous | Positive | Negative | Positive % | Avg % | Median % | Best % | Worst % | Avg Hold');
  result.metrics.forEach((metric) => {
    console.log(`${metric.definition.label} | ${metric.strategySignalCount} | ${metric.resolvedOptionCount} | ${metric.evaluatedExitCount} | ${metric.unavailableCount} | ${metric.ambiguousCount} | ${metric.positiveOutcomeCount} | ${metric.negativeOutcomeCount} | ${format(metric.positiveOutcomePercent, '%')} | ${format(metric.averagePremiumChangePercent, '%')} | ${format(metric.medianPremiumChangePercent, '%')} | ${format(metric.bestPremiumChangePercent, '%')} | ${format(metric.worstPremiumChangePercent, '%')} | ${format(metric.averageHoldingMinutes)}`);
    if (metric.definition.policy.type === 'TARGET_STOP') {
      console.log(`  TARGET=${metric.targetCount} (${format(metric.targetPercent, '%')}) | STOP_LOSS=${metric.stopLossCount} (${format(metric.stopLossPercent, '%')}) | TIME_EXIT=${metric.timeExitCount} (${format(metric.timeExitPercent, '%')})`);
    }
  });
}

function findHighest(metrics: readonly WindowPolicyMetrics[], field: 'averagePremiumChangePercent' | 'medianPremiumChangePercent'): Set<string> {
  const values = metrics.map((metric) => metric[field]).filter((value): value is number => value !== null);
  if (values.length === 0) return new Set();
  const highest = Math.max(...values);
  return new Set(metrics.filter((metric) => metric[field] !== null && Math.abs((metric[field] as number) - highest) < 1e-10).map((metric) => metric.definition.id));
}

function printStabilitySummary(windows: readonly WindowResult[]): void {
  console.log('\nExit-policy stability summary');
  console.log('Policy | Windows | Avg Evaluated | Avg Positive % | Avg Return % | Avg Median % | Avg Hold | Ambiguous | Avg-return wins | Median-return wins | Positive avg windows | Positive median windows');
  const summary = policies.map((definition) => {
    const metrics = windows.map((window) => window.metrics.find((metric) => metric.definition.id === definition.id)).filter((metric): metric is WindowPolicyMetrics => Boolean(metric));
    const averageWinners = windows.reduce((count, window) => count + Number(findHighest(window.metrics, 'averagePremiumChangePercent').has(definition.id)), 0);
    const medianWinners = windows.reduce((count, window) => count + Number(findHighest(window.metrics, 'medianPremiumChangePercent').has(definition.id)), 0);
    const averageReturns = metrics.map((metric) => metric.averagePremiumChangePercent).filter((value): value is number => value !== null);
    const medianReturns = metrics.map((metric) => metric.medianPremiumChangePercent).filter((value): value is number => value !== null);
    return {
      definition,
      windowCount: metrics.length,
      averageEvaluated: average(metrics.map((metric) => metric.evaluatedExitCount)),
      averagePositive: average(metrics.map((metric) => metric.positiveOutcomePercent).filter((value): value is number => value !== null)),
      averageReturn: average(averageReturns),
      averageMedian: average(medianReturns),
      averageHolding: average(metrics.map((metric) => metric.averageHoldingMinutes).filter((value): value is number => value !== null)),
      totalAmbiguous: metrics.reduce((sum, metric) => sum + metric.ambiguousCount, 0),
      totalResolved: metrics.reduce((sum, metric) => sum + metric.resolvedOptionCount, 0),
      averageWinners,
      medianWinners,
      positiveAverageWindows: averageReturns.filter((value) => value > 0).length,
      positiveMedianWindows: medianReturns.filter((value) => value > 0).length,
    };
  });
  const ranked = [...summary].sort((left, right) =>
    right.positiveAverageWindows - left.positiveAverageWindows ||
    right.positiveMedianWindows - left.positiveMedianWindows ||
    (right.averageReturn ?? -Infinity) - (left.averageReturn ?? -Infinity) ||
    (right.averageMedian ?? -Infinity) - (left.averageMedian ?? -Infinity) ||
    (right.averageEvaluated ?? -Infinity) - (left.averageEvaluated ?? -Infinity) ||
    (left.totalResolved === 0 ? Infinity : left.totalAmbiguous / left.totalResolved) - (right.totalResolved === 0 ? Infinity : right.totalAmbiguous / right.totalResolved) ||
    left.definition.label.localeCompare(right.definition.label)
  );
  ranked.forEach((entry) => console.log(`${entry.definition.label} | ${entry.windowCount} | ${format(entry.averageEvaluated)} | ${format(entry.averagePositive, '%')} | ${format(entry.averageReturn, '%')} | ${format(entry.averageMedian, '%')} | ${format(entry.averageHolding)} | ${entry.totalAmbiguous} | ${entry.averageWinners} | ${entry.medianWinners} | ${entry.positiveAverageWindows} | ${entry.positiveMedianWindows}`));
  const mostCompetitive = ranked[0];
  if (mostCompetitive) {
    console.log(`\nMost consistently competitive: ${mostCompetitive.definition.label}. This is a stability-research result only, not a production recommendation.`);
  }
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting option exit-policy stability research', { underlyingInstrumentKey, researchWindowSessions, stepSessions });

  const repository = new HistoricalCandleRepository();
  const storedCandles = await repository.findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe);
  const grouped = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const date = getMarketDateAndMinute(candle.candleTime).date;
    grouped.set(date, [...(grouped.get(date) ?? []), candle]);
  });
  const sessions = Array.from(grouped.entries()).filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length < researchWindowSessions) {
    throw new Error(`At least ${researchWindowSessions} complete NIFTY sessions are required; found ${sessions.length}.`);
  }

  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const evaluator = new OptionExitPolicyEvaluatorService();
  const caches: ResolutionCaches = { expiryCache: new Map(), contractsCache: new Map(), candleCache: new Map() };
  const windows: WindowResult[] = [];

  for (let start = 0; start + researchWindowSessions <= sessions.length; start += stepSessions) {
    const windowSessions = sessions.slice(start, start + researchWindowSessions);
    const signals = generateSignals(windowSessions);
    const resolved = await resolveSignals(signals, expiredOptionClient, expiredCandleClient, selector, caches);
    const metrics = policies.map((definition) => {
      const results = resolved.map((signal) => evaluator.evaluate({ signalTimestamp: signal.timestamp, entryPremium: signal.entryPremium, candles: signal.candles, exitPolicy: definition.policy }));
      return calculateMetrics(definition, signals.length, resolved.length, results);
    });
    const result = { fromDate: windowSessions[0][0], toDate: windowSessions[windowSessions.length - 1][0], sessionCount: windowSessions.length, metrics };
    windows.push(result);
    printWindow(result);
  }

  if (windows.length === 0) throw new Error('No chronological research windows could be created.');
  printStabilitySummary(windows);
  logger.info('Option exit-policy stability research completed', { windowCount: windows.length });
}

run().catch((error) => {
  logger.error('Option exit-policy stability research failed', { error });
  console.error('Option exit-policy stability research failed.', error);
  process.exitCode = 1;
});
