import assert from 'node:assert/strict';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const expectedOneMinuteCandleCount = 375;
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

  if (
    firstCandle.minuteOfDay !== marketSessionStartMinute ||
    lastCandle.minuteOfDay !== marketSessionEndMinute
  ) {
    return false;
  }

  return sortedCandles.every(
    (candle, index) =>
      index === 0 || candle.candleTime.getTime() - sortedCandles[index - 1].candleTime.getTime() === 60_000
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

function getLatestValue(
  result: ReturnType<IndicatorEngineService['calculate']>,
  type: IndicatorType,
  period?: number
): number | null {
  const indicator = result.indicators.find(
    (entry) =>
      entry.config.type === type &&
      (period === undefined || ('period' in entry.config && entry.config.period === period))
  );
  const latestValue = indicator?.result.values[indicator.result.values.length - 1];

  if (!latestValue) {
    throw new Error(`Indicator result is missing a latest value for ${type}.`);
  }

  if (!('value' in latestValue)) {
    throw new Error(`Indicator result for ${type} does not contain a scalar value.`);
  }

  return latestValue.value;
}

function requireLatestScalarValue(
  result: ReturnType<IndicatorEngineService['calculate']>,
  type: IndicatorType,
  period?: number
): number {
  const value = getLatestValue(result, type, period);

  if (value === null) {
    throw new Error(`Indicator result is unexpectedly null for ${type}.`);
  }

  return value;
}

function getLatestStructuredValue(
  result: ReturnType<IndicatorEngineService['calculate']>,
  type: IndicatorType
): Exclude<(typeof result.indicators)[number]['result']['values'][number], { value: unknown }> {
  const indicator = result.indicators.find((entry) => entry.config.type === type);
  const latestValue = indicator?.result.values[indicator.result.values.length - 1];

  if (!latestValue) {
    throw new Error(`Indicator result is missing a latest value for ${type}.`);
  }

  if ('value' in latestValue) {
    throw new Error(`Indicator result for ${type} does not contain a structured value.`);
  }

  return latestValue as Exclude<
    (typeof result.indicators)[number]['result']['values'][number],
    { value: unknown }
  >;
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const indicatorEngine = new IndicatorEngineService();

  logger.info('Starting Indicator Engine integration test', { instrumentKey, timeframe });

  const storedCandles = await repository.findByInstrumentAndTimeframe(instrumentKey, timeframe);
  const candlesByTradingDate = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const tradingDate = getMarketDateAndMinute(candle.candleTime).date;
    const dailyCandles = candlesByTradingDate.get(tradingDate) ?? [];
    dailyCandles.push(candle);
    candlesByTradingDate.set(tradingDate, dailyCandles);
  });

  const completeTradingDay = Array.from(candlesByTradingDate.entries())
    .sort(([leftDate], [rightDate]) => rightDate.localeCompare(leftDate))
    .find(([, candles]) => isCompleteTradingDay(candles));

  if (!completeTradingDay) {
    throw new Error(
      `No complete 09:15-15:29 IST one-minute trading day is stored for ${instrumentKey}.`
    );
  }

  const [tradingDate, dailyStoredCandles] = completeTradingDay;
  const oneMinuteCandles = dailyStoredCandles
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map(toInternalCandle);
  const originalCandles = oneMinuteCandles.map((candle) => ({ ...candle }));

  if (oneMinuteCandles.length < 255) {
    throw new Error('The complete trading day does not contain enough candles for EMA 50 on 5m data.');
  }

  const fiveMinuteCandles = aggregator.aggregate(oneMinuteCandles, '5m');
  const fifteenMinuteCandles = aggregator.aggregate(oneMinuteCandles, '15m');
  const fiveMinuteResults = indicatorEngine.calculate(fiveMinuteCandles, {
    indicators: [
      { type: IndicatorType.SMA, period: 20 },
      { type: IndicatorType.EMA, period: 20 },
      { type: IndicatorType.EMA, period: 50 },
      { type: IndicatorType.RSI, period: 14 },
      { type: IndicatorType.VWAP },
      { type: IndicatorType.ATR, period: 14 },
      {
        type: IndicatorType.MACD,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      },
      {
        type: IndicatorType.BOLLINGER_BANDS,
        period: 20,
        standardDeviationMultiplier: 2,
      },
      { type: IndicatorType.ADX, period: 14 },
      { type: IndicatorType.SUPER_TREND, period: 10, multiplier: 3 },
    ],
  });
  const fifteenMinuteResults = indicatorEngine.calculate(fifteenMinuteCandles, {
    indicators: [
      { type: IndicatorType.SMA, period: 5 },
      { type: IndicatorType.EMA, period: 5 },
    ],
  });

  assert.deepEqual(oneMinuteCandles, originalCandles);

  const latestFiveMinuteCandle = fiveMinuteCandles[fiveMinuteCandles.length - 1];
  const latestSma20 = requireLatestScalarValue(fiveMinuteResults, IndicatorType.SMA, 20);
  const latestEma20 = requireLatestScalarValue(fiveMinuteResults, IndicatorType.EMA, 20);
  const latestEma50 = requireLatestScalarValue(fiveMinuteResults, IndicatorType.EMA, 50);
  const latestRsi14 = requireLatestScalarValue(fiveMinuteResults, IndicatorType.RSI, 14);
  const latestVwap = getLatestValue(fiveMinuteResults, IndicatorType.VWAP);
  const latestAtr14 = requireLatestScalarValue(fiveMinuteResults, IndicatorType.ATR, 14);
  const latestMacd = getLatestStructuredValue(fiveMinuteResults, IndicatorType.MACD);
  const latestBollingerBands = getLatestStructuredValue(
    fiveMinuteResults,
    IndicatorType.BOLLINGER_BANDS
  );
  const latestAdx = getLatestStructuredValue(fiveMinuteResults, IndicatorType.ADX);
  const latestSuperTrend = getLatestStructuredValue(fiveMinuteResults, IndicatorType.SUPER_TREND);
  const latestFifteenMinuteSma = requireLatestScalarValue(
    fifteenMinuteResults,
    IndicatorType.SMA,
    5
  );
  const latestFifteenMinuteEma = requireLatestScalarValue(
    fifteenMinuteResults,
    IndicatorType.EMA,
    5
  );

  if (
    !('macd' in latestMacd) ||
    !('signal' in latestMacd) ||
    !('histogram' in latestMacd) ||
    !('upper' in latestBollingerBands) ||
    !('middle' in latestBollingerBands) ||
    !('lower' in latestBollingerBands) ||
    !('adx' in latestAdx) ||
    !('plusDI' in latestAdx) ||
    !('minusDI' in latestAdx) ||
    !('supertrend' in latestSuperTrend) ||
    !('trend' in latestSuperTrend)
  ) {
    throw new Error('One or more structured indicator results are missing expected fields.');
  }

  console.log(`Instrument: ${instrumentKey}`);
  console.log(`Trading date: ${tradingDate}`);
  console.log(`1m candle count: ${oneMinuteCandles.length}`);
  console.log(`5m candle count: ${fiveMinuteCandles.length}`);
  console.log(`15m candle count: ${fifteenMinuteCandles.length}`);
  console.log(`Latest close: ${latestFiveMinuteCandle.close}`);
  console.log(`SMA20: ${latestSma20}`);
  console.log(`EMA20: ${latestEma20}`);
  console.log(`EMA50: ${latestEma50}`);
  console.log(`RSI14: ${latestRsi14}`);
  console.log(`VWAP: ${latestVwap}`);
  console.log(`ATR14: ${latestAtr14}`);
  console.log(`MACD: ${latestMacd.macd}`);
  console.log(`MACD signal: ${latestMacd.signal}`);
  console.log(`MACD histogram: ${latestMacd.histogram}`);
  console.log(`Bollinger upper: ${latestBollingerBands.upper}`);
  console.log(`Bollinger middle: ${latestBollingerBands.middle}`);
  console.log(`Bollinger lower: ${latestBollingerBands.lower}`);
  console.log(`ADX14: ${latestAdx.adx}`);
  console.log(`+DI: ${latestAdx.plusDI}`);
  console.log(`-DI: ${latestAdx.minusDI}`);
  console.log(`SuperTrend: ${latestSuperTrend.supertrend}`);
  console.log(`SuperTrend direction: ${latestSuperTrend.trend}`);
  console.log(`15m SMA5 check: ${latestFifteenMinuteSma}`);
  console.log(`15m EMA5 check: ${latestFifteenMinuteEma}`);

  logger.info('Indicator Engine integration test completed', {
    instrumentKey,
    tradingDate,
    oneMinuteCandleCount: oneMinuteCandles.length,
    fiveMinuteCandleCount: fiveMinuteCandles.length,
    fifteenMinuteCandleCount: fifteenMinuteCandles.length,
  });
}

run().catch((error) => {
  logger.error('Indicator Engine integration test failed', { error });
  console.error('Indicator Engine integration test failed.', error);
  process.exitCode = 1;
});
