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

interface StrategySignalRecord {
  timestamp: Date;
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  spotPrice: number;
}

interface ResolvedOptionSignal extends StrategySignalRecord {
  instrumentKey: string;
  tradingSymbol: string;
  candles: ExpiredOptionCandleDto[];
  entryPremium: number;
}

interface FailedSignal extends StrategySignalRecord {
  error: string;
}

interface PolicyDefinition {
  id: string;
  label: string;
  policy: OptionExitPolicy;
}

interface PolicyMetrics {
  definition: PolicyDefinition;
  totalStrategySignals: number;
  evaluatedTrades: number;
  unavailableTrades: number;
  ambiguousTrades: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  neutralOutcomes: number;
  targetCount: number;
  stopLossCount: number;
  timeExitCount: number;
  targetHitPercent: number;
  stopHitPercent: number;
  timeExitPercent: number;
  ambiguousPercent: number;
  positiveOutcomePercent: number;
  averagePremiumChangePercent: number | null;
  medianPremiumChangePercent: number | null;
  bestPremiumChangePercent: number | null;
  worstPremiumChangePercent: number | null;
  averageHoldingMinutes: number | null;
  medianHoldingMinutes: number | null;
}

type CompleteSession = [date: string, candles: StoredCandle[]];

const policies: readonly PolicyDefinition[] = [
  { id: 'fixed-5m', label: 'FIXED_TIME 5m', policy: { type: 'FIXED_TIME', holdingMinutes: 5 } },
  { id: 'fixed-15m', label: 'FIXED_TIME 15m', policy: { type: 'FIXED_TIME', holdingMinutes: 15 } },
  { id: 'fixed-30m', label: 'FIXED_TIME 30m', policy: { type: 'FIXED_TIME', holdingMinutes: 30 } },
  { id: 'fixed-60m', label: 'FIXED_TIME 60m', policy: { type: 'FIXED_TIME', holdingMinutes: 60 } },
  { id: 'target10-stop10', label: 'TARGET 10% / STOP 10% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 10, maximumHoldingMinutes: 60 } },
  { id: 'target15-stop10', label: 'TARGET 15% / STOP 10% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 15, stopLossPercent: 10, maximumHoldingMinutes: 60 } },
  { id: 'target20-stop10', label: 'TARGET 20% / STOP 10% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 20, stopLossPercent: 10, maximumHoldingMinutes: 60 } },
  { id: 'target20-stop15', label: 'TARGET 20% / STOP 15% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 20, stopLossPercent: 15, maximumHoldingMinutes: 60 } },
  { id: 'target25-stop15', label: 'TARGET 25% / STOP 15% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 25, stopLossPercent: 15, maximumHoldingMinutes: 60 } },
  { id: 'target30-stop20', label: 'TARGET 30% / STOP 20% / 60m', policy: { type: 'TARGET_STOP', targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 } },
];

function getMarketDateAndMinute(timestamp: Date): { date: string; minuteOfDay: number } {
  const values = Object.fromEntries(
    marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isCompleteTradingDay(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;

  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = getMarketDateAndMinute(sorted[0].candleTime);
  const last = getMarketDateAndMinute(sorted[sorted.length - 1].candleTime);
  return first.minuteOfDay === marketSessionStartMinute &&
    last.minuteOfDay === marketSessionEndMinute &&
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
      return {
        timestamp: candle.candleTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume,
        openInterest,
      };
    });
}

function getScalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const entry = results.indicators.find(
    (candidate) => candidate.config.type === type && 'period' in candidate.config && candidate.config.period === period
  );
  const value = entry?.result.values.find((candidate) => candidate.timestamp.getTime() === timestamp.getTime());
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

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function formatNumber(value: number | null, suffix = ''): string {
  return value === null ? 'N/A' : `${value.toFixed(2)}${suffix}`;
}

function calculatePolicyMetrics(
  definition: PolicyDefinition,
  totalStrategySignals: number,
  results: readonly OptionExitPolicyEvaluationResult[],
  resolutionUnavailableTrades: number
): PolicyMetrics {
  const unavailableTrades = results.filter((result) => result.unavailable).length + resolutionUnavailableTrades;
  const ambiguousTrades = results.filter((result) => result.ambiguous).length;
  const evaluated = results.filter((result) => !result.unavailable && !result.ambiguous && result.premiumChangePercent !== null);
  const changes = evaluated.map((result) => result.premiumChangePercent as number);
  const holdings = evaluated.map((result) => result.holdingMinutes).filter((value): value is number => value !== null);
  const positiveOutcomes = changes.filter((value) => value > 0).length;
  const negativeOutcomes = changes.filter((value) => value < 0).length;
  const neutralOutcomes = changes.filter((value) => value === 0).length;
  const countedOutcomes = results.filter((result) => !result.unavailable);
  const targetCount = results.filter((result) => result.exitReason === 'TARGET').length;
  const stopLossCount = results.filter((result) => result.exitReason === 'STOP_LOSS').length;
  const timeExitCount = results.filter((result) => result.exitReason === 'TIME_EXIT').length;

  return {
    definition,
    totalStrategySignals,
    evaluatedTrades: evaluated.length,
    unavailableTrades,
    ambiguousTrades,
    positiveOutcomes,
    negativeOutcomes,
    neutralOutcomes,
    targetCount,
    stopLossCount,
    timeExitCount,
    targetHitPercent: percent(targetCount, countedOutcomes.length),
    stopHitPercent: percent(stopLossCount, countedOutcomes.length),
    timeExitPercent: percent(timeExitCount, countedOutcomes.length),
    ambiguousPercent: percent(ambiguousTrades, countedOutcomes.length),
    positiveOutcomePercent: percent(positiveOutcomes, evaluated.length),
    averagePremiumChangePercent: average(changes),
    medianPremiumChangePercent: median(changes),
    bestPremiumChangePercent: changes.length === 0 ? null : Math.max(...changes),
    worstPremiumChangePercent: changes.length === 0 ? null : Math.min(...changes),
    averageHoldingMinutes: average(holdings),
    medianHoldingMinutes: median(holdings),
  };
}

function printPolicyMetrics(metrics: PolicyMetrics): void {
  const { definition } = metrics;
  console.log(`\n${definition.label}`);
  console.log(`Total strategy signals: ${metrics.totalStrategySignals}`);
  console.log(`Evaluated trades: ${metrics.evaluatedTrades}; unavailable: ${metrics.unavailableTrades}; ambiguous: ${metrics.ambiguousTrades}`);
  if (definition.policy.type === 'FIXED_TIME') {
    console.log(`Positive: ${metrics.positiveOutcomes}; negative: ${metrics.negativeOutcomes}; neutral: ${metrics.neutralOutcomes}; positive outcome %: ${formatNumber(metrics.positiveOutcomePercent, '%')}`);
  } else {
    console.log(`TARGET: ${metrics.targetCount} (${formatNumber(metrics.targetHitPercent, '%')}); STOP_LOSS: ${metrics.stopLossCount} (${formatNumber(metrics.stopHitPercent, '%')}); TIME_EXIT: ${metrics.timeExitCount} (${formatNumber(metrics.timeExitPercent, '%')}); AMBIGUOUS: ${metrics.ambiguousTrades} (${formatNumber(metrics.ambiguousPercent, '%')}); UNAVAILABLE: ${metrics.unavailableTrades}`);
  }
  console.log(`Return %: avg=${formatNumber(metrics.averagePremiumChangePercent, '%')}; median=${formatNumber(metrics.medianPremiumChangePercent, '%')}; best=${formatNumber(metrics.bestPremiumChangePercent, '%')}; worst=${formatNumber(metrics.worstPremiumChangePercent, '%')}`);
  console.log(`Holding minutes: avg=${formatNumber(metrics.averageHoldingMinutes)}; median=${formatNumber(metrics.medianHoldingMinutes)}`);
}

function compareMetrics(left: PolicyMetrics, right: PolicyMetrics): number {
  const compareDescending = (first: number | null, second: number | null): number => (second ?? -Infinity) - (first ?? -Infinity);
  const compareAscending = (first: number, second: number): number => first - second;
  return compareDescending(left.averagePremiumChangePercent, right.averagePremiumChangePercent) ||
    compareDescending(left.medianPremiumChangePercent, right.medianPremiumChangePercent) ||
    compareAscending(left.stopHitPercent, right.stopHitPercent) ||
    compareAscending(left.ambiguousPercent, right.ambiguousPercent) ||
    left.definition.label.localeCompare(right.definition.label);
}

function printComparison(metrics: readonly PolicyMetrics[]): void {
  console.log('\nExit-policy comparison (ranked by average %, median %, lower stop-loss %, lower ambiguity %)');
  console.log('Rank | Policy | Evaluated | Unavailable | Ambiguous | Avg % | Median % | Best % | Worst % | Avg Hold | Stop % | Ambiguous %');
  [...metrics].sort(compareMetrics).forEach((metric, index) => {
    console.log(`${index + 1} | ${metric.definition.label} | ${metric.evaluatedTrades} | ${metric.unavailableTrades} | ${metric.ambiguousTrades} | ${formatNumber(metric.averagePremiumChangePercent, '%')} | ${formatNumber(metric.medianPremiumChangePercent, '%')} | ${formatNumber(metric.bestPremiumChangePercent, '%')} | ${formatNumber(metric.worstPremiumChangePercent, '%')} | ${formatNumber(metric.averageHoldingMinutes)} | ${formatNumber(metric.stopHitPercent, '%')} | ${formatNumber(metric.ambiguousPercent, '%')}`);
  });
  console.log('This ranks raw historical option-premium exits only; it does not establish profitability or production readiness.');
}

async function generateSignals(repository: HistoricalCandleRepository): Promise<StrategySignalRecord[]> {
  const storedCandles = await repository.findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe);
  const grouped = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const date = getMarketDateAndMinute(candle.candleTime).date;
    grouped.set(date, [...(grouped.get(date) ?? []), candle]);
  });
  const sessions = Array.from(grouped.entries()).filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for option exit-policy research.');

  const oneMinuteCandles = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinuteCandles.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinuteCandles = new CandleTimeframeAggregatorService().aggregate(oneMinuteCandles, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinuteCandles, {
    indicators: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
    ],
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

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');

  logger.info('Starting option exit-policy research', { underlyingInstrumentKey, policyCount: policies.length });
  const signals = await generateSignals(new HistoricalCandleRepository());
  if (signals.length === 0) throw new Error('The EMA15/35 + RSI55/45 baseline produced no historical signals.');

  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const exitEvaluator = new OptionExitPolicyEvaluatorService();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractsCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const resolved: ResolvedOptionSignal[] = [];
  const failures: FailedSignal[] = [];

  for (const signal of signals) {
    try {
      const signalDate = getMarketDateAndMinute(signal.timestamp).date;
      const expiries = await getOrCreate(expiryCache, underlyingInstrumentKey, () => expiredOptionClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const expiry = getExpiryForDate(expiries, signalDate);
      const contracts = await getOrCreate(contractsCache, `${underlyingInstrumentKey}|${expiry}`, () => expiredOptionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const candles = await getOrCreate(candleCache, `${selected.instrumentKey}|${signalDate}`, () => expiredCandleClient.fetchCandles(selected.instrumentKey, signalDate, signalDate));
      const entryCandle = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entryCandle) throw new Error('No option candle aligns exactly with the signal timestamp.');
      resolved.push({ ...signal, instrumentKey: selected.instrumentKey, tradingSymbol: selected.tradingSymbol, candles, entryPremium: entryCandle.close });
    } catch (error) {
      const failure = { ...signal, error: error instanceof Error ? error.message : 'Unknown error' };
      failures.push(failure);
      console.log(`UNAVAILABLE CONTRACT/CANDLES | ${signal.timestamp.toISOString()} | ${signal.signal} | ${failure.error}`);
    }
  }

  if (resolved.length === 0) throw new Error('No strategy signal could be resolved to historical option premium candles.');

  const allMetrics = policies.map((definition) => {
    const results = resolved.map((signal) => exitEvaluator.evaluate({
      signalTimestamp: signal.timestamp,
      entryPremium: signal.entryPremium,
      candles: signal.candles,
      exitPolicy: definition.policy,
    }));
    return calculatePolicyMetrics(definition, signals.length, results, failures.length);
  });

  console.log(`\nBaseline signals: ${signals.length}; resolved option signals: ${resolved.length}; unavailable contracts/candles: ${failures.length}`);
  allMetrics.forEach(printPolicyMetrics);
  printComparison(allMetrics);
  if (failures.length > 0) {
    console.log('\nUnavailable contracts/candles');
    failures.forEach((failure) => console.log(`${failure.timestamp.toISOString()} | ${failure.signal} | ${failure.error}`));
  }
  logger.info('Option exit-policy research completed', { totalSignals: signals.length, resolvedSignals: resolved.length, unavailableSignals: failures.length });
}

run().catch((error) => {
  logger.error('Option exit-policy research failed', { error });
  console.error('Option exit-policy research failed.', error);
  process.exitCode = 1;
});
