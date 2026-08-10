import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import {
  ResearchRunConfig,
  ResearchRunResult,
  ResearchStrategyContext,
} from '../modules/research/dto/research-run.dto';
import ResearchRunnerService from '../modules/research/services/research-runner.service';
import { StrategySignal, StrategySignalDto } from '../modules/strategies/dto/strategy-signal.dto';
import { Strategy } from '../modules/strategies/interfaces/strategy.interface';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const storedTimeframe = '1minute';
const rsiConfigurations = [
  { id: 'RSI 50/50', upperThreshold: 50, lowerThreshold: 50 },
  { id: 'RSI 55/45', upperThreshold: 55, lowerThreshold: 45 },
  { id: 'RSI 60/40', upperThreshold: 60, lowerThreshold: 40 },
  { id: 'RSI 65/35', upperThreshold: 65, lowerThreshold: 35 },
] as const;
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

  const sortedCandles = [...candles].sort(
    (left, right) => left.candleTime.getTime() - right.candleTime.getTime()
  );
  const first = getMarketDateAndMinute(sortedCandles[0].candleTime);
  const last = getMarketDateAndMinute(sortedCandles[sortedCandles.length - 1].candleTime);

  return (
    first.minuteOfDay === marketSessionStartMinute &&
    last.minuteOfDay === marketSessionEndMinute &&
    sortedCandles.every(
      (candle, index) =>
        index === 0 ||
        candle.candleTime.getTime() - sortedCandles[index - 1].candleTime.getTime() === 60_000
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

      if (
        !Number.isSafeInteger(volume) ||
        (openInterest !== undefined && !Number.isSafeInteger(openInterest))
      ) {
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

function getIndicatorValue(
  indicatorResults: IndicatorEngineResult,
  timestamp: Date,
  type: IndicatorType,
  period?: number
): number | undefined {
  const matchingResults = indicatorResults.indicators.filter(
    (entry) =>
      entry.config.type === type &&
      (period === undefined || ('period' in entry.config && entry.config.period === period))
  );
  if (matchingResults.length !== 1) {
    return undefined;
  }

  const entry = matchingResults[0].result.values.find(
    (value) => value.timestamp.getTime() === timestamp.getTime()
  );

  return entry && 'value' in entry && typeof entry.value === 'number' ? entry.value : undefined;
}

function noTrade(reason: string): StrategySignalDto {
  return { signal: StrategySignal.NO_TRADE, confidence: 0, reasons: [reason] };
}

class RsiFilteredEmaCrossStrategy implements Strategy<ResearchStrategyContext> {
  readonly id: string;

  private readonly emaCross = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });

  constructor(
    private readonly upperThreshold: number,
    private readonly lowerThreshold: number
  ) {
    this.id = `ema-15-35-rsi-${upperThreshold}-${lowerThreshold}`;
  }

  evaluate(context: ResearchStrategyContext): StrategySignalDto {
    const previousCandle = context.candles[context.candleIndex - 1];
    if (!previousCandle) {
      return noTrade('No previous candle is available for EMA crossover evaluation.');
    }

    const previousFast = getIndicatorValue(
      context.indicatorResults,
      previousCandle.timestamp,
      IndicatorType.EMA,
      15
    );
    const currentFast = getIndicatorValue(
      context.indicatorResults,
      context.candle.timestamp,
      IndicatorType.EMA,
      15
    );
    const previousSlow = getIndicatorValue(
      context.indicatorResults,
      previousCandle.timestamp,
      IndicatorType.EMA,
      35
    );
    const currentSlow = getIndicatorValue(
      context.indicatorResults,
      context.candle.timestamp,
      IndicatorType.EMA,
      35
    );
    const rsi = getIndicatorValue(context.indicatorResults, context.candle.timestamp, IndicatorType.RSI, 14);
    const regimeEma20 = getIndicatorValue(
      context.indicatorResults,
      context.candle.timestamp,
      IndicatorType.EMA,
      20
    );
    const regimeEma50 = getIndicatorValue(
      context.indicatorResults,
      context.candle.timestamp,
      IndicatorType.EMA,
      50
    );

    if (
      previousFast === undefined ||
      currentFast === undefined ||
      previousSlow === undefined ||
      currentSlow === undefined ||
      rsi === undefined ||
      regimeEma20 === undefined ||
      regimeEma50 === undefined
    ) {
      return noTrade('Required EMA, RSI, or regime values are not yet aligned at this candle.');
    }

    const emaCrossSignal = this.emaCross.evaluate({
      fastEma: {
        type: IndicatorType.EMA,
        period: 15,
        values: [
          { timestamp: previousCandle.timestamp, value: previousFast },
          { timestamp: context.candle.timestamp, value: currentFast },
        ],
      },
      slowEma: {
        type: IndicatorType.EMA,
        period: 35,
        values: [
          { timestamp: previousCandle.timestamp, value: previousSlow },
          { timestamp: context.candle.timestamp, value: currentSlow },
        ],
      },
    });

    if (emaCrossSignal.signal === StrategySignal.BUY_CE) {
      return rsi > this.upperThreshold
        ? {
            ...emaCrossSignal,
            reasons: [...emaCrossSignal.reasons, `RSI 14 ${rsi.toFixed(2)} is above ${this.upperThreshold}.`],
          }
        : noTrade(
            `Bullish EMA15/35 crossover rejected: RSI 14 ${rsi.toFixed(2)} is not above ${this.upperThreshold}.`
          );
    }

    if (emaCrossSignal.signal === StrategySignal.BUY_PE) {
      return rsi < this.lowerThreshold
        ? {
            ...emaCrossSignal,
            reasons: [...emaCrossSignal.reasons, `RSI 14 ${rsi.toFixed(2)} is below ${this.lowerThreshold}.`],
          }
        : noTrade(
            `Bearish EMA15/35 crossover rejected: RSI 14 ${rsi.toFixed(2)} is not below ${this.lowerThreshold}.`
          );
    }

    return emaCrossSignal;
  }
}

function createConfig(
  strategy: Strategy<ResearchStrategyContext>,
  fromDate: string,
  toDate: string
): ResearchRunConfig<ResearchStrategyContext> {
  return {
    strategy,
    strategyName: strategy.id,
    instrumentKey,
    timeframe: '5m',
    fromDate,
    toDate,
    indicatorRequests: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
      // Required by the existing ResearchRunner market-regime attachment for emitted signals.
      { type: IndicatorType.EMA, period: 20 },
      { type: IndicatorType.EMA, period: 50 },
      { type: IndicatorType.ADX, period: 14 },
      { type: IndicatorType.ATR, period: 14 },
      { type: IndicatorType.SUPER_TREND, period: 10, multiplier: 3 },
    ],
    marketRegimeConfig: { highVolatilityThreshold: 0.15, lowVolatilityThreshold: 0.05 },
    createStrategyInput: (context) => context,
  };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function rankResults(
  results: Array<{ configuration: (typeof rsiConfigurations)[number]; run: ResearchRunResult }>
): Array<{ configuration: (typeof rsiConfigurations)[number]; run: ResearchRunResult }> {
  return [...results].sort((left, right) => {
    const leftMetrics = left.run.strategyReport.performanceMetrics;
    const rightMetrics = right.run.strategyReport.performanceMetrics;

    return (
      rightMetrics.accuracy60m - leftMetrics.accuracy60m ||
      rightMetrics.avg60m - leftMetrics.avg60m ||
      rightMetrics.avgMFE - leftMetrics.avgMFE ||
      leftMetrics.avgMAE - rightMetrics.avgMAE ||
      left.configuration.id.localeCompare(right.configuration.id)
    );
  });
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const runner = new ResearchRunnerService();

  logger.info('Starting RSI filter parameter research integration test', {
    instrumentKey,
    timeframe: storedTimeframe,
  });

  const storedCandles = await repository.findByInstrumentAndTimeframe(instrumentKey, storedTimeframe);
  const candlesByTradingDate = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const tradingDate = getMarketDateAndMinute(candle.candleTime).date;
    const dailyCandles = candlesByTradingDate.get(tradingDate) ?? [];
    dailyCandles.push(candle);
    candlesByTradingDate.set(tradingDate, dailyCandles);
  });
  const completeSessions = Array.from(candlesByTradingDate.entries())
    .filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate)) as CompleteSession[];

  if (completeSessions.length === 0) {
    throw new Error('RSI filter parameter research requires at least one complete NIFTY trading session.');
  }

  const fromDate = completeSessions[0][0];
  const toDate = completeSessions[completeSessions.length - 1][0];
  const candles = toInternalCandles(completeSessions);
  const results = rsiConfigurations.map((configuration) => ({
    configuration,
    run: runner.run(
      candles,
      createConfig(
        new RsiFilteredEmaCrossStrategy(configuration.upperThreshold, configuration.lowerThreshold),
        fromDate,
        toDate
      )
    ),
  }));
  const rankedResults = rankResults(results);

  console.log(
    `RSI Filter Research: ${fromDate} to ${toDate} (${completeSessions.length} complete sessions, ${results[0].run.candleCount} 5m candles)`
  );
  console.log(
    'Rank | Configuration | Signals | BUY_CE | BUY_PE | Acc 5m | Acc 15m | Acc 30m | Acc 60m | Avg 60m | Avg MFE | Avg MAE'
  );
  rankedResults.forEach(({ configuration, run: runResult }, index) => {
    const metrics = runResult.strategyReport.performanceMetrics;
    console.log(
      `${index + 1} | ${configuration.id} | ${metrics.totalSignals} | ${metrics.buyCeSignals} | ${metrics.buyPeSignals} | ${formatNumber(metrics.accuracy5m)}% | ${formatNumber(metrics.accuracy15m)}% | ${formatNumber(metrics.accuracy30m)}% | ${formatNumber(metrics.accuracy60m)}% | ${formatNumber(metrics.avg60m)} | ${formatNumber(metrics.avgMFE)} | ${formatNumber(metrics.avgMAE)}`
    );
  });

  const best = rankedResults[0];
  console.log(
    `Best configuration by 60m accuracy, then avg 60m movement, MFE, and lowest MAE: ${best.configuration.id}`
  );
  console.log('These are NIFTY directional research metrics, not option profit or loss.');

  logger.info('RSI filter parameter research integration test completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    bestConfiguration: best.configuration.id,
  });
}

run().catch((error) => {
  logger.error('RSI filter parameter research integration test failed', { error });
  console.error('RSI filter parameter research integration test failed.', error);
  process.exitCode = 1;
});
