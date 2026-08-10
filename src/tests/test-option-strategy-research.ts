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
import { OptionOutcomeDto } from '../modules/options/dto/option-outcome.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionOutcomeEvaluatorService from '../modules/options/services/option-outcome-evaluator.service';
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

interface EvaluatedSignal extends StrategySignalRecord {
  outcome: OptionOutcomeDto;
}

interface FailedSignal extends StrategySignalRecord {
  error: string;
}

type CompleteSession = [date: string, candles: StoredCandle[]];

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
  if (candles.length !== expectedOneMinuteCandleCount) {
    return false;
  }

  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = getMarketDateAndMinute(sorted[0].candleTime);
  const last = getMarketDateAndMinute(sorted[sorted.length - 1].candleTime);

  return (
    first.minuteOfDay === marketSessionStartMinute &&
    last.minuteOfDay === marketSessionEndMinute &&
    sorted.every(
      (candle, index) =>
        index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000
    )
  );
}

function toInternalCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions
    .flatMap(([, candles]) => candles)
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

function getScalar(
  indicatorResults: IndicatorEngineResult,
  type: IndicatorType,
  period: number,
  timestamp: Date
): number | undefined {
  const matches = indicatorResults.indicators.filter(
    (entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period
  );
  const value = matches.length === 1
    ? matches[0].result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime())
    : undefined;

  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function getExpiryForDate(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((candidate) => candidate >= date).sort((a, b) => a.localeCompare(b))[0];
  if (!expiry) {
    throw new Error(`No expired option expiry is available on or after ${date}.`);
  }

  return expiry;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const value = create();
  cache.set(key, value);
  return value;
}

function formatPercent(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(2)}%`;
}

function calculateMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function calculateAverage(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function printSignal(record: EvaluatedSignal): void {
  const { outcome } = record;
  console.log(
    `${record.timestamp.toISOString()} | ${record.signal} | spot=${record.spotPrice.toFixed(2)} | expiry=${outcome.expiry.toISOString().slice(0, 10)} | strike=${outcome.strikePrice} | ${outcome.tradingSymbol} | entry=${outcome.entryPremium.toFixed(2)} | 5m=${formatPercent(outcome.at5m?.changePercent ?? null)} | 15m=${formatPercent(outcome.at15m?.changePercent ?? null)} | 30m=${formatPercent(outcome.at30m?.changePercent ?? null)} | 60m=${formatPercent(outcome.at60m?.changePercent ?? null)} | MFE=${outcome.mfePercent.toFixed(2)}% | MAE=${outcome.maePercent.toFixed(2)}%`
  );
}

function printMetrics(signals: readonly StrategySignalRecord[], evaluated: readonly EvaluatedSignal[], failed: readonly FailedSignal[]): void {
  console.log('\nOption premium research metrics');
  console.log(`Total strategy signals: ${signals.length}`);
  console.log(`Successfully evaluated option signals: ${evaluated.length}`);
  console.log(`Failed/unavailable option signals: ${failed.length}`);
  console.log(`BUY_CE count: ${signals.filter((signal) => signal.signal === StrategySignal.BUY_CE).length}`);
  console.log(`BUY_PE count: ${signals.filter((signal) => signal.signal === StrategySignal.BUY_PE).length}`);

  ([5, 15, 30, 60] as const).forEach((horizon) => {
    const key = `at${horizon}m` as const;
    const changes = evaluated
      .map((record) => record.outcome[key]?.changePercent ?? null)
      .filter((value): value is number => value !== null);
    const positive = changes.filter((value) => value > 0).length;
    const negative = changes.filter((value) => value < 0).length;
    const neutral = changes.filter((value) => value === 0).length;

    console.log(
      `${horizon}m: positive=${positive}, negative=${negative}, neutral=${neutral}, positivePct=${changes.length === 0 ? '0.00' : ((positive / changes.length) * 100).toFixed(2)}%, avgChangePct=${calculateAverage(changes).toFixed(2)}%, medianChangePct=${calculateMedian(changes).toFixed(2)}%`
    );
  });

  const mfePercentages = evaluated.map((record) => record.outcome.mfePercent);
  const maePercentages = evaluated.map((record) => record.outcome.maePercent);
  console.log(`Average MFE %: ${calculateAverage(mfePercentages).toFixed(2)}%`);
  console.log(`Median MFE %: ${calculateMedian(mfePercentages).toFixed(2)}%`);
  console.log(`Average MAE %: ${calculateAverage(maePercentages).toFixed(2)}%`);
  console.log(`Median MAE %: ${calculateMedian(maePercentages).toFixed(2)}%`);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  }

  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const indicatorEngine = new IndicatorEngineService();
  const emaCross = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const outcomeEvaluator = new OptionOutcomeEvaluatorService();

  logger.info('Starting real historical option strategy research', { underlyingInstrumentKey });
  const storedCandles = await repository.findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe);
  const byDate = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const date = getMarketDateAndMinute(candle.candleTime).date;
    const session = byDate.get(date) ?? [];
    session.push(candle);
    byDate.set(date, session);
  });
  const sessions = Array.from(byDate.entries())
    .filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) {
    throw new Error('No complete NIFTY sessions are available for option strategy research.');
  }

  const oneMinuteCandles = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinuteCandles.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinuteCandles = aggregator.aggregate(oneMinuteCandles, '5m');
  const indicators = indicatorEngine.calculate(fiveMinuteCandles, {
    indicators: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
    ],
  });
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

    const crossover = emaCross.evaluate({
      fastEma: {
        type: IndicatorType.EMA,
        period: 15,
        values: [
          { timestamp: previous.timestamp, value: previousFast as number },
          { timestamp: candle.timestamp, value: currentFast as number },
        ],
      } as EmaResult,
      slowEma: {
        type: IndicatorType.EMA,
        period: 35,
        values: [
          { timestamp: previous.timestamp, value: previousSlow as number },
          { timestamp: candle.timestamp, value: currentSlow as number },
        ],
      } as EmaResult,
    });
    const isConfirmed =
      (crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) ||
      (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45);
    if (isConfirmed && (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE)) {
      signals.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });

  const expiryCache = new Map<string, Promise<string[]>>();
  const contractsCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const evaluated: EvaluatedSignal[] = [];
  const failed: FailedSignal[] = [];

  for (const signal of signals) {
    try {
      const signalDate = getMarketDateAndMinute(signal.timestamp).date;
      const expiries = await getOrCreate(expiryCache, underlyingInstrumentKey, () =>
        expiredOptionClient.fetchAvailableExpiries(underlyingInstrumentKey)
      );
      const expiry = getExpiryForDate(expiries, signalDate);
      const contracts = await getOrCreate(contractsCache, `${underlyingInstrumentKey}|${expiry}`, () =>
        expiredOptionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry)
      );
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selected = selector.select({
        underlying,
        spotPrice: signal.spotPrice,
        signal: signal.signal,
        timestamp: signal.timestamp,
        contracts,
      });
      const optionCandles = await getOrCreate(candleCache, `${selected.instrumentKey}|${signalDate}`, () =>
        expiredCandleClient.fetchCandles(selected.instrumentKey, signalDate, signalDate)
      );
      const outcome = outcomeEvaluator.evaluate({
        signalTimestamp: signal.timestamp,
        signalType: signal.signal,
        selectedContract: {
          instrumentKey: selected.instrumentKey,
          tradingSymbol: selected.tradingSymbol,
          underlying: selected.underlying,
          optionType: selected.optionType,
          strikePrice: selected.strikePrice,
          expiry: selected.expiry,
          exchange: contracts.find((contract) => contract.instrumentKey === selected.instrumentKey)?.exchange ?? '',
          segment: contracts.find((contract) => contract.instrumentKey === selected.instrumentKey)?.segment ?? '',
        },
        candles: optionCandles,
      });
      const record = { ...signal, outcome };
      evaluated.push(record);
      printSignal(record);
    } catch (error) {
      const failure = { ...signal, error: error instanceof Error ? error.message : 'Unknown error' };
      failed.push(failure);
      console.log(`FAILED | ${signal.timestamp.toISOString()} | ${signal.signal} | ${failure.error}`);
    }
  }

  if (evaluated.length === 0) {
    throw new Error('No strategy signal could be evaluated with historical option premium data.');
  }

  printMetrics(signals, evaluated, failed);
  if (failed.length > 0) {
    console.log('\nUnavailable option signals');
    failed.forEach((failure) => console.log(`${failure.timestamp.toISOString()} | ${failure.signal} | ${failure.error}`));
  }
  console.log('These are raw option premium outcomes only, not final trading profitability or P&L.');
  logger.info('Real historical option strategy research completed', {
    totalSignals: signals.length,
    evaluatedSignals: evaluated.length,
    failedSignals: failed.length,
  });
}

run().catch((error) => {
  logger.error('Real historical option strategy research failed', { error });
  console.error('Real historical option strategy research failed.', error);
  process.exitCode = 1;
});
