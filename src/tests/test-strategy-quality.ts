import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import AdxIndicator, { AdxResult } from '../modules/indicators/indicators/adx.indicator';
import EmaIndicator, { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import RsiIndicator, { RsiResult } from '../modules/indicators/indicators/rsi.indicator';
import SuperTrendIndicator, {
  SuperTrendResult,
} from '../modules/indicators/indicators/supertrend.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { StrategySignal, StrategySignalDto } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';
import EmaTrendConfirmationStrategy from '../modules/strategies/strategies/ema-trend-confirmation.strategy';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const fastPeriod = 20;
const slowPeriod = 50;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const expectedOneMinuteCandleCount = 375;
const horizons = [5, 15, 30, 60] as const;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

type Horizon = (typeof horizons)[number];
type DirectionalPoints = Record<Horizon, number | null>;

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}

interface EmaPair {
  fast: EmaResult['values'][number];
  slow: EmaResult['values'][number];
}

interface SignalQualityRecord {
  strategy: 'EmaCrossStrategy' | 'EmaTrendConfirmationStrategy';
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  confidence: number;
  reasons: string[];
  timestamp: Date;
  signalClose: number;
  directionalPoints: DirectionalPoints;
  mfe: number | null;
  mae: number | null;
}

interface StrategyQualitySummary {
  totalSignals: number;
  evaluableSignals: number;
  buyCeCount: number;
  buyPeCount: number;
  correctCounts: Record<Horizon, number>;
  averageDirectionalPoints: Record<Horizon, number | null>;
  averageMfe: number | null;
  averageMae: number | null;
}

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

  const sortedCandles = [...candles].sort(
    (left, right) => left.candleTime.getTime() - right.candleTime.getTime()
  );
  const firstCandle = getMarketDateAndMinute(sortedCandles[0].candleTime);
  const lastCandle = getMarketDateAndMinute(sortedCandles[sortedCandles.length - 1].candleTime);

  return (
    firstCandle.minuteOfDay === marketSessionStartMinute &&
    lastCandle.minuteOfDay === marketSessionEndMinute &&
    sortedCandles.every(
      (candle, index) =>
        index === 0 ||
        candle.candleTime.getTime() - sortedCandles[index - 1].candleTime.getTime() === 60_000
    )
  );
}

function toInternalCandle(candle: StoredCandle): Candle {
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
}

function getAlignedEmaPairs(fastEma: EmaResult, slowEma: EmaResult): EmaPair[] {
  const fastByTimestamp = new Map(fastEma.values.map((entry) => [entry.timestamp.getTime(), entry]));

  return slowEma.values.flatMap((slow) => {
    const fast = fastByTimestamp.get(slow.timestamp.getTime());

    return fast ? [{ fast, slow }] : [];
  });
}

function createValueMap<T extends { timestamp: Date }>(values: readonly T[]): Map<number, T> {
  return new Map(values.map((value) => [value.timestamp.getTime(), value]));
}

function createDirectionalPoints(): DirectionalPoints {
  return { 5: null, 15: null, 30: null, 60: null };
}

function calculateDirectionalPoints(
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE,
  signalClose: number,
  futureClose: number
): number {
  return signal === StrategySignal.BUY_CE
    ? futureClose - signalClose
    : signalClose - futureClose;
}

function evaluateSignal(
  strategy: SignalQualityRecord['strategy'],
  signalResult: StrategySignalDto,
  signalCandle: Candle,
  sessionCandles: readonly Candle[],
  signalIndex: number
): SignalQualityRecord {
  const signal = signalResult.signal;
  if (signal !== StrategySignal.BUY_CE && signal !== StrategySignal.BUY_PE) {
    throw new Error('Only BUY_CE and BUY_PE signals can be evaluated for strategy quality.');
  }

  const directionalPoints = createDirectionalPoints();
  horizons.forEach((horizon) => {
    const futureCandle = sessionCandles[signalIndex + horizon / 5];
    if (futureCandle) {
      directionalPoints[horizon] = calculateDirectionalPoints(
        signal,
        signalCandle.close,
        futureCandle.close
      );
    }
  });

  const futureWindow = sessionCandles.slice(signalIndex + 1, signalIndex + 13);
  const hasFullSixtyMinuteWindow = futureWindow.length === 12;
  const mfe = hasFullSixtyMinuteWindow
    ? signal === StrategySignal.BUY_CE
      ? Math.max(...futureWindow.map((candle) => candle.high)) - signalCandle.close
      : signalCandle.close - Math.min(...futureWindow.map((candle) => candle.low))
    : null;
  const mae = hasFullSixtyMinuteWindow
    ? signal === StrategySignal.BUY_CE
      ? signalCandle.close - Math.min(...futureWindow.map((candle) => candle.low))
      : Math.max(...futureWindow.map((candle) => candle.high)) - signalCandle.close
    : null;

  return {
    strategy,
    signal,
    confidence: signalResult.confidence,
    reasons: signalResult.reasons,
    timestamp: signalCandle.timestamp,
    signalClose: signalCandle.close,
    directionalPoints,
    mfe,
    mae,
  };
}

function calculateAverage(values: Array<number | null>): number | null {
  const validValues = values.filter((value): value is number => value !== null);

  return validValues.length === 0
    ? null
    : validValues.reduce((total, value) => total + value, 0) / validValues.length;
}

function summarize(records: readonly SignalQualityRecord[]): StrategyQualitySummary {
  return {
    totalSignals: records.length,
    evaluableSignals: records.filter((record) => record.directionalPoints[60] !== null).length,
    buyCeCount: records.filter((record) => record.signal === StrategySignal.BUY_CE).length,
    buyPeCount: records.filter((record) => record.signal === StrategySignal.BUY_PE).length,
    correctCounts: {
      5: records.filter((record) => (record.directionalPoints[5] ?? 0) > 0).length,
      15: records.filter((record) => (record.directionalPoints[15] ?? 0) > 0).length,
      30: records.filter((record) => (record.directionalPoints[30] ?? 0) > 0).length,
      60: records.filter((record) => (record.directionalPoints[60] ?? 0) > 0).length,
    },
    averageDirectionalPoints: {
      5: calculateAverage(records.map((record) => record.directionalPoints[5])),
      15: calculateAverage(records.map((record) => record.directionalPoints[15])),
      30: calculateAverage(records.map((record) => record.directionalPoints[30])),
      60: calculateAverage(records.map((record) => record.directionalPoints[60])),
    },
    averageMfe: calculateAverage(records.map((record) => record.mfe)),
    averageMae: calculateAverage(records.map((record) => record.mae)),
  };
}

function formatNumber(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(2);
}

function printSignal(record: SignalQualityRecord): void {
  console.log(`Timestamp: ${record.timestamp.toISOString()}`);
  console.log(`Strategy: ${record.strategy}`);
  console.log(`Signal: ${record.signal}`);
  console.log(`Confidence: ${record.confidence}`);
  console.log(`Signal close: ${record.signalClose}`);
  console.log(`5m directional points: ${formatNumber(record.directionalPoints[5])}`);
  console.log(`15m directional points: ${formatNumber(record.directionalPoints[15])}`);
  console.log(`30m directional points: ${formatNumber(record.directionalPoints[30])}`);
  console.log(`60m directional points: ${formatNumber(record.directionalPoints[60])}`);
  console.log(`MFE: ${formatNumber(record.mfe)}`);
  console.log(`MAE: ${formatNumber(record.mae)}`);
  console.log('');
}

function printSummary(strategy: SignalQualityRecord['strategy'], summary: StrategyQualitySummary): void {
  console.log(`${strategy}:`);
  console.log(`Total signals: ${summary.totalSignals}`);
  console.log(`Evaluable signals: ${summary.evaluableSignals}`);
  console.log(`BUY_CE count: ${summary.buyCeCount}`);
  console.log(`BUY_PE count: ${summary.buyPeCount}`);
  console.log(`5m correct count: ${summary.correctCounts[5]}`);
  console.log(`15m correct count: ${summary.correctCounts[15]}`);
  console.log(`30m correct count: ${summary.correctCounts[30]}`);
  console.log(`60m correct count: ${summary.correctCounts[60]}`);
  console.log(`Average 5m directional points: ${formatNumber(summary.averageDirectionalPoints[5])}`);
  console.log(`Average 15m directional points: ${formatNumber(summary.averageDirectionalPoints[15])}`);
  console.log(`Average 30m directional points: ${formatNumber(summary.averageDirectionalPoints[30])}`);
  console.log(`Average 60m directional points: ${formatNumber(summary.averageDirectionalPoints[60])}`);
  console.log(`Average MFE: ${formatNumber(summary.averageMfe)}`);
  console.log(`Average MAE: ${formatNumber(summary.averageMae)}`);
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const emaIndicator = new EmaIndicator();
  const rsiIndicator = new RsiIndicator();
  const adxIndicator = new AdxIndicator();
  const superTrendIndicator = new SuperTrendIndicator();
  const emaCrossStrategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });
  const trendConfirmationStrategy = new EmaTrendConfirmationStrategy();

  logger.info('Starting historical strategy-quality evaluation', { instrumentKey, timeframe });

  const storedCandles = await repository.findByInstrumentAndTimeframe(instrumentKey, timeframe);
  const candlesByTradingDate = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const tradingDate = getMarketDateAndMinute(candle.candleTime).date;
    const dailyCandles = candlesByTradingDate.get(tradingDate) ?? [];
    dailyCandles.push(candle);
    candlesByTradingDate.set(tradingDate, dailyCandles);
  });
  const completeSessions = Array.from(candlesByTradingDate.entries())
    .filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate));

  if (completeSessions.length === 0) {
    throw new Error(`No complete 09:15-15:29 IST sessions are stored for ${instrumentKey}.`);
  }

  const oneMinuteCandles = completeSessions
    .flatMap(([, candles]) => candles)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map(toInternalCandle);
  const fiveMinuteCandles = aggregator.aggregate(oneMinuteCandles, '5m');

  if (fiveMinuteCandles.length < slowPeriod + 1) {
    throw new Error(
      `Insufficient complete historical data: quality evaluation requires at least ${slowPeriod + 1} five-minute candles.`
    );
  }

  const fastEma = emaIndicator.calculate(fiveMinuteCandles, {
    type: IndicatorType.EMA,
    period: fastPeriod,
  });
  const slowEma = emaIndicator.calculate(fiveMinuteCandles, {
    type: IndicatorType.EMA,
    period: slowPeriod,
  });
  const rsi = rsiIndicator.calculate(fiveMinuteCandles, { type: IndicatorType.RSI, period: 14 });
  const adx = adxIndicator.calculate(fiveMinuteCandles, { type: IndicatorType.ADX, period: 14 });
  const superTrend = superTrendIndicator.calculate(fiveMinuteCandles, {
    type: IndicatorType.SUPER_TREND,
    period: 10,
    multiplier: 3,
  });
  const alignedEmaPairs = getAlignedEmaPairs(fastEma, slowEma);
  const rsiByTimestamp = createValueMap<RsiResult['values'][number]>(rsi.values);
  const adxByTimestamp = createValueMap<AdxResult['values'][number]>(adx.values);
  const superTrendByTimestamp = createValueMap<SuperTrendResult['values'][number]>(
    superTrend.values
  );
  const candleLocations = new Map<number, { sessionCandles: Candle[]; index: number }>();

  const fiveMinuteCandlesByTradingDate = new Map<string, Candle[]>();
  fiveMinuteCandles.forEach((candle) => {
    const tradingDate = getMarketDateAndMinute(candle.timestamp).date;
    const sessionCandles = fiveMinuteCandlesByTradingDate.get(tradingDate) ?? [];
    sessionCandles.push(candle);
    fiveMinuteCandlesByTradingDate.set(tradingDate, sessionCandles);
  });
  fiveMinuteCandlesByTradingDate.forEach((sessionCandles) => {
    sessionCandles.forEach((candle, index) => {
      candleLocations.set(candle.timestamp.getTime(), { sessionCandles, index });
    });
  });

  if (alignedEmaPairs.length < 2) {
    throw new Error('Insufficient aligned EMA20 and EMA50 values for strategy-quality evaluation.');
  }

  const emaCrossRecords: SignalQualityRecord[] = [];
  const trendConfirmationRecords: SignalQualityRecord[] = [];

  for (let index = 1; index < alignedEmaPairs.length; index += 1) {
    const previousPair = alignedEmaPairs[index - 1];
    const currentPair = alignedEmaPairs[index];
    const timestamp = currentPair.fast.timestamp.getTime();
    const latestRsi14 = rsiByTimestamp.get(timestamp);
    const latestAdx14 = adxByTimestamp.get(timestamp);
    const latestSuperTrend = superTrendByTimestamp.get(timestamp);
    const location = candleLocations.get(timestamp);

    if (!latestRsi14 || !latestAdx14 || !latestSuperTrend || !location) {
      throw new Error(
        `Missing aligned indicator or candle data at ${currentPair.fast.timestamp.toISOString()}.`
      );
    }

    const rawSignal = emaCrossStrategy.evaluate({
      fastEma: {
        type: IndicatorType.EMA,
        period: fastPeriod,
        values: [previousPair.fast, currentPair.fast],
      },
      slowEma: {
        type: IndicatorType.EMA,
        period: slowPeriod,
        values: [previousPair.slow, currentPair.slow],
      },
    });
    const confirmedSignal = trendConfirmationStrategy.evaluate({
      previousEma20: previousPair.fast,
      latestEma20: currentPair.fast,
      previousEma50: previousPair.slow,
      latestEma50: currentPair.slow,
      latestRsi14,
      latestAdx14,
      latestSuperTrend,
    });

    if (rawSignal.signal === StrategySignal.BUY_CE || rawSignal.signal === StrategySignal.BUY_PE) {
      emaCrossRecords.push(
        evaluateSignal(
          'EmaCrossStrategy',
          rawSignal,
          location.sessionCandles[location.index],
          location.sessionCandles,
          location.index
        )
      );
    }

    if (
      confirmedSignal.signal === StrategySignal.BUY_CE ||
      confirmedSignal.signal === StrategySignal.BUY_PE
    ) {
      trendConfirmationRecords.push(
        evaluateSignal(
          'EmaTrendConfirmationStrategy',
          confirmedSignal,
          location.sessionCandles[location.index],
          location.sessionCandles,
          location.index
        )
      );
    }
  }

  [...emaCrossRecords, ...trendConfirmationRecords]
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
    .forEach(printSignal);

  const emaCrossSummary = summarize(emaCrossRecords);
  const trendConfirmationSummary = summarize(trendConfirmationRecords);

  printSummary('EmaCrossStrategy', emaCrossSummary);
  printSummary('EmaTrendConfirmationStrategy', trendConfirmationSummary);

  logger.info('Historical strategy-quality evaluation completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    fiveMinuteCandleCount: fiveMinuteCandles.length,
    emaCrossSummary,
    trendConfirmationSummary,
  });
}

run().catch((error) => {
  logger.error('Historical strategy-quality evaluation failed', { error });
  console.error('Historical strategy-quality evaluation failed.', error);
  process.exitCode = 1;
});
