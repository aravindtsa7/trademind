import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import {
  AdaptiveBreakoutDirection,
  AdaptivePrimaryMarketRegime,
  AdaptiveVolatilityRegime,
} from '../modules/adaptive-intraday/types/adaptive-market-regime.types';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandlesPerSession = 375;
const breakoutLookbackCandles = 12;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

interface ClassifiedCandle {
  timestamp: Date;
  tradingDate: string;
  primaryRegime: AdaptivePrimaryMarketRegime;
  volatilityRegime: AdaptiveVolatilityRegime;
  breakoutDirection: AdaptiveBreakoutDirection;
}

type CountMap<T extends string> = Record<T, number>;

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } {
  const parts = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isCompleteSession(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandlesPerSession) return false;
  const ordered = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = marketDateAndMinute(ordered[0].candleTime);
  const last = marketDateAndMinute(ordered[ordered.length - 1].candleTime);
  return first.minute === marketSessionStartMinute
    && last.minute === marketSessionEndMinute
    && ordered.every((candle, index) => index === 0 || candle.candleTime.getTime() - ordered[index - 1].candleTime.getTime() === 60_000);
}

function toCandle(candle: StoredCandle): Candle {
  const volume = Number(candle.volume);
  const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
  if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
    throw new Error('Stored volume or open interest exceeds JavaScript safe-integer precision.');
  }
  return {
    timestamp: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest,
  };
}

function scalarValues(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  if (!indicator) throw new Error(`Missing ${type}${period} indicator result.`);
  const values = new Map<number, number>();
  indicator.result.values.forEach((entry) => {
    if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value);
  });
  return values;
}

function adxValues(results: IndicatorEngineResult): Map<number, AdxValue> {
  const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14);
  if (!indicator) throw new Error('Missing ADX14 indicator result.');
  const values = new Map<number, AdxValue>();
  indicator.result.values.forEach((entry) => {
    if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date });
  });
  return values;
}

function emptyPrimaryCounts(): CountMap<AdaptivePrimaryMarketRegime> {
  return { TREND_UP: 0, TREND_DOWN: 0, SIDEWAYS: 0 };
}

function emptyVolatilityCounts(): CountMap<AdaptiveVolatilityRegime> {
  return { HIGH_VOLATILITY: 0, NORMAL_VOLATILITY: 0, LOW_VOLATILITY: 0 };
}

function emptyBreakoutCounts(): CountMap<AdaptiveBreakoutDirection> {
  return { BREAKOUT_UP: 0, BREAKOUT_DOWN: 0, NONE: 0 };
}

function percent(count: number, total: number): string {
  return total === 0 ? '0.00%' : `${((count / total) * 100).toFixed(2)}%`;
}

function dominantRegime(counts: CountMap<AdaptivePrimaryMarketRegime>): AdaptivePrimaryMarketRegime | 'MIXED' {
  const highest = Math.max(...Object.values(counts));
  const leaders = (Object.entries(counts) as Array<[AdaptivePrimaryMarketRegime, number]>).filter(([, count]) => count === highest);
  return leaders.length === 1 ? leaders[0][0] : 'MIXED';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function printCounts<T extends string>(title: string, counts: Record<T, number>, total: number): void {
  console.log(`\n${title}`);
  Object.entries(counts).forEach(([key, count]) => {
    const numericCount = count as number;
    console.log(`${key}: ${numericCount} (${percent(numericCount, total)})`);
  });
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const indicators = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({
    trendStrengthThreshold: 20,
    emaProximityPercent: 0.05,
    highVolatilityThreshold: 0.10,
    lowVolatilityThreshold: 0.05,
  });

  logger.info('Starting adaptive market regime distribution research', { instrumentKey, sourceTimeframe });
  const stored = await repository.findByInstrumentAndTimeframe(instrumentKey, sourceTimeframe) as StoredCandle[];
  const byDate = new Map<string, StoredCandle[]>();
  stored.forEach((candle) => {
    const date = marketDateAndMinute(candle.candleTime).date;
    const daily = byDate.get(date) ?? [];
    daily.push(candle);
    byDate.set(date, daily);
  });
  const completeSessions = Array.from(byDate.entries())
    .filter(([, candles]) => isCompleteSession(candles))
    .sort(([left], [right]) => left.localeCompare(right));
  if (completeSessions.length === 0) throw new Error(`No complete NIFTY 09:15-15:29 IST sessions are stored for ${instrumentKey}.`);

  const oneMinuteCandles = completeSessions
    .flatMap(([, session]) => session)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map(toCandle);
  const fiveMinuteCandles = aggregator.aggregate(oneMinuteCandles, '5m');
  const results = indicators.calculate(fiveMinuteCandles, {
    indicators: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
      { type: IndicatorType.ADX, period: 14 },
      { type: IndicatorType.ATR, period: 14 },
    ],
  });
  const ema15 = scalarValues(results, IndicatorType.EMA, 15);
  const ema35 = scalarValues(results, IndicatorType.EMA, 35);
  const rsi14 = scalarValues(results, IndicatorType.RSI, 14);
  const atr14 = scalarValues(results, IndicatorType.ATR, 14);
  const adx14 = adxValues(results);

  const classified: ClassifiedCandle[] = [];
  let currentDate = '';
  let sessionCandles: Candle[] = [];
  fiveMinuteCandles.forEach((candle) => {
    const { date } = marketDateAndMinute(candle.timestamp);
    if (date !== currentDate) {
      currentDate = date;
      sessionCandles = [];
    }
    const timestamp = candle.timestamp.getTime();
    const adx = adx14.get(timestamp);
    const fast = ema15.get(timestamp);
    const slow = ema35.get(timestamp);
    const rsi = rsi14.get(timestamp);
    const atr = atr14.get(timestamp);
    const recent = sessionCandles.slice(-breakoutLookbackCandles);
    sessionCandles.push(candle);
    if (fast === undefined || slow === undefined || rsi === undefined || atr === undefined || !adx) return;

    const regime = regimeService.classify({
      timestamp: candle.timestamp,
      close: candle.close,
      ema15: fast,
      ema35: slow,
      rsi14: rsi,
      adx14: adx.adx,
      atr14: atr,
      ...(recent.length === breakoutLookbackCandles
        ? { recentHigh: Math.max(...recent.map((value) => value.high)), recentLow: Math.min(...recent.map((value) => value.low)) }
        : {}),
    });
    classified.push({ timestamp: regime.timestamp, tradingDate: date, primaryRegime: regime.primaryRegime, volatilityRegime: regime.volatilityRegime, breakoutDirection: regime.breakoutDirection });
  });
  if (classified.length === 0) throw new Error('No 5-minute candles have all required EMA15, EMA35, RSI14, ADX14, and ATR14 values aligned.');

  const primaryCounts = emptyPrimaryCounts();
  const volatilityCounts = emptyVolatilityCounts();
  const breakoutCounts = emptyBreakoutCounts();
  classified.forEach((entry) => {
    primaryCounts[entry.primaryRegime] += 1;
    volatilityCounts[entry.volatilityRegime] += 1;
    breakoutCounts[entry.breakoutDirection] += 1;
  });

  console.log(`Instrument: ${instrumentKey}`);
  console.log(`Complete sessions: ${completeSessions.length}`);
  console.log(`5m candles: ${fiveMinuteCandles.length}`);
  console.log(`Classified 5m candles: ${classified.length}`);
  console.log(`Breakout lookback: previous ${breakoutLookbackCandles} completed 5m candles within the same IST session (current candle excluded).`);
  printCounts('Primary regime distribution', primaryCounts, classified.length);
  printCounts('Volatility distribution', volatilityCounts, classified.length);
  printCounts('Breakout distribution', breakoutCounts, classified.length);

  const sessionSummaries = new Map<string, CountMap<AdaptivePrimaryMarketRegime>>();
  classified.forEach((entry) => {
    const counts = sessionSummaries.get(entry.tradingDate) ?? emptyPrimaryCounts();
    counts[entry.primaryRegime] += 1;
    sessionSummaries.set(entry.tradingDate, counts);
  });
  const dominantDayCounts: Record<AdaptivePrimaryMarketRegime | 'MIXED', number> = { TREND_UP: 0, TREND_DOWN: 0, SIDEWAYS: 0, MIXED: 0 };
  console.log('\nPer-session primary regimes');
  completeSessions.forEach(([date]) => {
    const counts = sessionSummaries.get(date) ?? emptyPrimaryCounts();
    const dominant = dominantRegime(counts);
    dominantDayCounts[dominant] += 1;
    console.log(`${date}: total=${counts.TREND_UP + counts.TREND_DOWN + counts.SIDEWAYS} TREND_UP=${counts.TREND_UP} TREND_DOWN=${counts.TREND_DOWN} SIDEWAYS=${counts.SIDEWAYS} dominant=${dominant}`);
  });
  printCounts('Dominant daily-regime summary', dominantDayCounts, completeSessions.length);

  const runLengths: Record<AdaptivePrimaryMarketRegime, number[]> = { TREND_UP: [], TREND_DOWN: [], SIDEWAYS: [] };
  const transitions = new Map<string, number>();
  let previous: ClassifiedCandle | undefined;
  let runRegime: AdaptivePrimaryMarketRegime | undefined;
  let runLength = 0;
  const finishRun = (): void => {
    if (runRegime !== undefined) runLengths[runRegime].push(runLength);
  };
  classified.forEach((entry) => {
    const newSession = previous !== undefined && entry.tradingDate !== previous.tradingDate;
    if (!previous || newSession) {
      finishRun();
      runRegime = entry.primaryRegime;
      runLength = 1;
    } else if (entry.primaryRegime === runRegime) {
      runLength += 1;
    } else {
      finishRun();
      transitions.set(`${runRegime}->${entry.primaryRegime}`, (transitions.get(`${runRegime}->${entry.primaryRegime}`) ?? 0) + 1);
      runRegime = entry.primaryRegime;
      runLength = 1;
    }
    previous = entry;
  });
  finishRun();

  console.log('\nConsecutive primary-regime runs');
  (Object.values(AdaptivePrimaryMarketRegime) as AdaptivePrimaryMarketRegime[]).forEach((regime) => {
    const lengths = runLengths[regime];
    const longest = Math.max(0, ...lengths);
    const average = lengths.length === 0 ? 0 : lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    console.log(`${regime}: runs=${lengths.length} avg=${average.toFixed(2)} candles median=${median(lengths).toFixed(2)} longest=${longest} candles (${longest * 5} minutes)`);
  });
  console.log('\nPrimary-regime transitions');
  const transitionPairs = [
    'TREND_UP->SIDEWAYS', 'SIDEWAYS->TREND_UP', 'TREND_DOWN->SIDEWAYS',
    'SIDEWAYS->TREND_DOWN', 'TREND_UP->TREND_DOWN', 'TREND_DOWN->TREND_UP',
  ];
  transitionPairs.forEach((pair) => console.log(`${pair}: ${transitions.get(pair) ?? 0}`));

  const timeBuckets = [
    ['09:15-10:30', 9 * 60 + 15, 10 * 60 + 30],
    ['10:30-12:00', 10 * 60 + 30, 12 * 60],
    ['12:00-13:30', 12 * 60, 13 * 60 + 30],
    ['13:30-15:30', 13 * 60 + 30, 15 * 60 + 30],
  ] as const;
  console.log('\nIST time-of-day primary regime distribution');
  timeBuckets.forEach(([label, start, end]) => {
    const entries = classified.filter((entry) => {
      const minute = marketDateAndMinute(entry.timestamp).minute;
      return minute >= start && minute < end;
    });
    const counts = emptyPrimaryCounts();
    entries.forEach((entry) => { counts[entry.primaryRegime] += 1; });
    console.log(`${label}: total=${entries.length} TREND_UP=${percent(counts.TREND_UP, entries.length)} TREND_DOWN=${percent(counts.TREND_DOWN, entries.length)} SIDEWAYS=${percent(counts.SIDEWAYS, entries.length)}`);
  });

  logger.info('Adaptive market regime distribution research completed', {
    instrumentKey, completeSessions: completeSessions.length, classifiedCandles: classified.length,
  });
}

run().catch((error) => {
  logger.error('Adaptive market regime distribution research failed', { error });
  console.error('Adaptive market regime distribution research failed.', error);
  process.exitCode = 1;
});
