import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import EmaIndicator, { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

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

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const emaIndicator = new EmaIndicator();
  const strategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });

  logger.info('Starting EMA Cross Strategy integration test', { instrumentKey, timeframe });

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
      `Insufficient complete historical data: EMA Cross requires at least ${slowPeriod + 1} five-minute candles.`
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
  const alignedPairs = getAlignedEmaPairs(fastEma, slowEma);

  if (alignedPairs.length < 2) {
    throw new Error('Insufficient aligned EMA20 and EMA50 values for crossover evaluation.');
  }

  const crossoverSignals = alignedPairs.slice(1).flatMap((currentPair, index) => {
    const previousPair = alignedPairs[index];
    const result = strategy.evaluate({
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

    return result.signal === StrategySignal.NO_TRADE
      ? []
      : [
          {
            timestamp: currentPair.fast.timestamp,
            fastEma: currentPair.fast.value,
            slowEma: currentPair.slow.value,
            ...result,
          },
        ];
  });

  crossoverSignals.forEach((signal) => {
    console.log(`Timestamp: ${signal.timestamp.toISOString()}`);
    console.log(`Signal: ${signal.signal}`);
    console.log(`Confidence: ${signal.confidence}`);
    console.log(`Fast EMA: ${signal.fastEma}`);
    console.log(`Slow EMA: ${signal.slowEma}`);
    console.log(`Reasons: ${signal.reasons.join(' ')}`);
    console.log('');
  });

  const buyCeSignals = crossoverSignals.filter((signal) => signal.signal === StrategySignal.BUY_CE);
  const buyPeSignals = crossoverSignals.filter((signal) => signal.signal === StrategySignal.BUY_PE);

  console.log(`Total 5m candles: ${fiveMinuteCandles.length}`);
  console.log(`BUY_CE signals: ${buyCeSignals.length}`);
  console.log(`BUY_PE signals: ${buyPeSignals.length}`);
  console.log(`Total crossover signals: ${crossoverSignals.length}`);

  logger.info('EMA Cross Strategy integration test completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    fiveMinuteCandleCount: fiveMinuteCandles.length,
    buyCeSignalCount: buyCeSignals.length,
    buyPeSignalCount: buyPeSignals.length,
  });
}

run().catch((error) => {
  logger.error('EMA Cross Strategy integration test failed', { error });
  console.error('EMA Cross Strategy integration test failed.', error);
  process.exitCode = 1;
});
