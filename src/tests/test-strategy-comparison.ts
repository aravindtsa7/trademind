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
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';
import EmaTrendConfirmationStrategy from '../modules/strategies/strategies/ema-trend-confirmation.strategy';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const fastPeriod = 20;
const slowPeriod = 50;
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

interface EmaPair {
  fast: EmaResult['values'][number];
  slow: EmaResult['values'][number];
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

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const emaIndicator = new EmaIndicator();
  const rsiIndicator = new RsiIndicator();
  const adxIndicator = new AdxIndicator();
  const superTrendIndicator = new SuperTrendIndicator();
  const emaCrossStrategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });
  const trendConfirmationStrategy = new EmaTrendConfirmationStrategy();

  logger.info('Starting strategy comparison integration test', { instrumentKey, timeframe });

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
      `Insufficient complete historical data: comparison requires at least ${slowPeriod + 1} five-minute candles.`
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

  if (alignedEmaPairs.length < 2) {
    throw new Error('Insufficient aligned EMA20 and EMA50 values for strategy comparison.');
  }

  let emaCrossBuyCe = 0;
  let emaCrossBuyPe = 0;
  let trendConfirmationBuyCe = 0;
  let trendConfirmationBuyPe = 0;
  let rejectedRawCrossovers = 0;

  for (let index = 1; index < alignedEmaPairs.length; index += 1) {
    const previousPair = alignedEmaPairs[index - 1];
    const currentPair = alignedEmaPairs[index];
    const timestamp = currentPair.fast.timestamp.getTime();
    const latestRsi14 = rsiByTimestamp.get(timestamp);
    const latestAdx14 = adxByTimestamp.get(timestamp);
    const latestSuperTrend = superTrendByTimestamp.get(timestamp);

    if (!latestRsi14 || !latestAdx14 || !latestSuperTrend) {
      throw new Error(
        `Missing aligned RSI14, ADX14, or SuperTrend result at ${currentPair.fast.timestamp.toISOString()}.`
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

    if (rawSignal.signal === StrategySignal.BUY_CE) {
      emaCrossBuyCe += 1;
    } else if (rawSignal.signal === StrategySignal.BUY_PE) {
      emaCrossBuyPe += 1;
    } else {
      continue;
    }

    if (confirmedSignal.signal === StrategySignal.NO_TRADE) {
      rejectedRawCrossovers += 1;
      continue;
    }

    if (confirmedSignal.signal === StrategySignal.BUY_CE) {
      trendConfirmationBuyCe += 1;
    } else {
      trendConfirmationBuyPe += 1;
    }

    console.log(`Timestamp: ${currentPair.fast.timestamp.toISOString()}`);
    console.log(`Signal: ${confirmedSignal.signal}`);
    console.log(`Confidence: ${confirmedSignal.confidence}`);
    console.log(`EMA20: ${currentPair.fast.value}`);
    console.log(`EMA50: ${currentPair.slow.value}`);
    console.log(`RSI14: ${latestRsi14.value}`);
    console.log(`ADX14: ${latestAdx14.adx}`);
    console.log(`+DI: ${latestAdx14.plusDI}`);
    console.log(`-DI: ${latestAdx14.minusDI}`);
    console.log(`SuperTrend direction: ${latestSuperTrend.trend}`);
    console.log(`Reasons: ${confirmedSignal.reasons.join(' ')}`);
    console.log('');
  }

  const emaCrossTotal = emaCrossBuyCe + emaCrossBuyPe;
  const trendConfirmationTotal = trendConfirmationBuyCe + trendConfirmationBuyPe;

  console.log('EMA Cross:');
  console.log(`BUY_CE: ${emaCrossBuyCe}`);
  console.log(`BUY_PE: ${emaCrossBuyPe}`);
  console.log(`Total signals: ${emaCrossTotal}`);
  console.log('EMA Trend Confirmation:');
  console.log(`BUY_CE: ${trendConfirmationBuyCe}`);
  console.log(`BUY_PE: ${trendConfirmationBuyPe}`);
  console.log(`Total signals: ${trendConfirmationTotal}`);
  console.log(`Raw EMA crossover signals rejected by confirmation: ${rejectedRawCrossovers}`);

  logger.info('Strategy comparison integration test completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    fiveMinuteCandleCount: fiveMinuteCandles.length,
    emaCrossBuyCe,
    emaCrossBuyPe,
    trendConfirmationBuyCe,
    trendConfirmationBuyPe,
    rejectedRawCrossovers,
  });
}

run().catch((error) => {
  logger.error('Strategy comparison integration test failed', { error });
  console.error('Strategy comparison integration test failed.', error);
  process.exitCode = 1;
});
