import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import { SuperTrendValue } from '../modules/indicators/indicators/supertrend.indicator';
import { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import {
  ResearchRunConfig,
  ResearchRunResult,
  ResearchStrategyContext,
} from '../modules/research/dto/research-run.dto';
import { RegimePerformanceDto } from '../modules/research/dto/regime-strategy-report.dto';
import ResearchRunnerService from '../modules/research/services/research-runner.service';
import { StrategySignal, StrategySignalDto } from '../modules/strategies/dto/strategy-signal.dto';
import { Strategy } from '../modules/strategies/interfaces/strategy.interface';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';
import EmaTrendConfirmationStrategy from '../modules/strategies/strategies/ema-trend-confirmation.strategy';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const storedTimeframe = '1minute';
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

function noTrade(reason: string): StrategySignalDto {
  return { signal: StrategySignal.NO_TRADE, confidence: 0, reasons: [reason] };
}

function getIndicatorEntry(
  indicatorResults: IndicatorEngineResult,
  type: IndicatorType,
  timestamp: Date,
  period?: number
) {
  const matchingResults = indicatorResults.indicators.filter(
    (entry) =>
      entry.config.type === type &&
      (period === undefined || ('period' in entry.config && entry.config.period === period))
  );

  if (matchingResults.length !== 1) {
    return undefined;
  }

  return matchingResults[0].result.values.find(
    (entry) => entry.timestamp.getTime() === timestamp.getTime()
  );
}

function getScalar(
  indicatorResults: IndicatorEngineResult,
  type: IndicatorType,
  timestamp: Date,
  period: number
): number | undefined {
  const entry = getIndicatorEntry(indicatorResults, type, timestamp, period);

  return entry && 'value' in entry && typeof entry.value === 'number' ? entry.value : undefined;
}

function getStructured<TValue extends object>(
  indicatorResults: IndicatorEngineResult,
  type: IndicatorType,
  timestamp: Date,
  period?: number
): (TValue & { timestamp: Date }) | undefined {
  const entry = getIndicatorEntry(indicatorResults, type, timestamp, period);

  return entry && !('value' in entry) ? (entry as unknown as TValue & { timestamp: Date }) : undefined;
}

class EmaCrossResearchAdapter implements Strategy<ResearchStrategyContext> {
  readonly id = 'ema-cross';

  private readonly strategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });

  evaluate(context: ResearchStrategyContext): StrategySignalDto {
    const previousCandle = context.candles[context.candleIndex - 1];
    if (!previousCandle) {
      return noTrade('No previous candle is available for EMA crossover evaluation.');
    }

    const previousFast = getScalar(
      context.indicatorResults,
      IndicatorType.EMA,
      previousCandle.timestamp,
      fastPeriod
    );
    const currentFast = getScalar(
      context.indicatorResults,
      IndicatorType.EMA,
      context.candle.timestamp,
      fastPeriod
    );
    const previousSlow = getScalar(
      context.indicatorResults,
      IndicatorType.EMA,
      previousCandle.timestamp,
      slowPeriod
    );
    const currentSlow = getScalar(
      context.indicatorResults,
      IndicatorType.EMA,
      context.candle.timestamp,
      slowPeriod
    );

    if (
      previousFast === undefined ||
      currentFast === undefined ||
      previousSlow === undefined ||
      currentSlow === undefined
    ) {
      return noTrade('Required EMA20/EMA50 values are not yet aligned at this candle.');
    }

    return this.strategy.evaluate({
      fastEma: this.createEmaResult(fastPeriod, previousCandle.timestamp, previousFast, context.candle.timestamp, currentFast),
      slowEma: this.createEmaResult(slowPeriod, previousCandle.timestamp, previousSlow, context.candle.timestamp, currentSlow),
    });
  }

  private createEmaResult(
    period: number,
    previousTimestamp: Date,
    previousValue: number,
    currentTimestamp: Date,
    currentValue: number
  ): EmaResult {
    return {
      type: IndicatorType.EMA,
      period,
      values: [
        { timestamp: previousTimestamp, value: previousValue },
        { timestamp: currentTimestamp, value: currentValue },
      ],
    };
  }
}

class EmaTrendConfirmationResearchAdapter implements Strategy<ResearchStrategyContext> {
  readonly id = 'ema-trend-confirmation';

  private readonly strategy = new EmaTrendConfirmationStrategy();

  evaluate(context: ResearchStrategyContext): StrategySignalDto {
    const previousCandle = context.candles[context.candleIndex - 1];
    if (!previousCandle) {
      return noTrade('No previous candle is available for EMA trend confirmation.');
    }

    const previousEma20 = getScalar(context.indicatorResults, IndicatorType.EMA, previousCandle.timestamp, 20);
    const latestEma20 = getScalar(context.indicatorResults, IndicatorType.EMA, context.candle.timestamp, 20);
    const previousEma50 = getScalar(context.indicatorResults, IndicatorType.EMA, previousCandle.timestamp, 50);
    const latestEma50 = getScalar(context.indicatorResults, IndicatorType.EMA, context.candle.timestamp, 50);
    const latestRsi14 = getScalar(context.indicatorResults, IndicatorType.RSI, context.candle.timestamp, 14);
    const latestAdx14 = getStructured<AdxValue>(
      context.indicatorResults,
      IndicatorType.ADX,
      context.candle.timestamp,
      14
    );
    const latestSuperTrend = getStructured<SuperTrendValue>(
      context.indicatorResults,
      IndicatorType.SUPER_TREND,
      context.candle.timestamp
    );

    if (
      previousEma20 === undefined ||
      latestEma20 === undefined ||
      previousEma50 === undefined ||
      latestEma50 === undefined ||
      latestRsi14 === undefined ||
      !latestAdx14 ||
      !latestSuperTrend
    ) {
      return noTrade('Required EMA, RSI, ADX, or SuperTrend values are not yet aligned at this candle.');
    }

    return this.strategy.evaluate({
      previousEma20: { timestamp: previousCandle.timestamp, value: previousEma20 },
      latestEma20: { timestamp: context.candle.timestamp, value: latestEma20 },
      previousEma50: { timestamp: previousCandle.timestamp, value: previousEma50 },
      latestEma50: { timestamp: context.candle.timestamp, value: latestEma50 },
      latestRsi14: { timestamp: context.candle.timestamp, value: latestRsi14 },
      latestAdx14,
      latestSuperTrend,
    });
  }
}

function createConfig(
  strategy: Strategy<ResearchStrategyContext>,
  strategyName: string,
  fromDate: string,
  toDate: string,
  includeRsi: boolean
): ResearchRunConfig<ResearchStrategyContext> {
  return {
    strategy,
    strategyName,
    instrumentKey,
    timeframe: '5m',
    fromDate,
    toDate,
    indicatorRequests: [
      { type: IndicatorType.EMA, period: 20 },
      { type: IndicatorType.EMA, period: 50 },
      ...(includeRsi ? [{ type: IndicatorType.RSI, period: 14 } as const] : []),
      { type: IndicatorType.ADX, period: 14 },
      { type: IndicatorType.ATR, period: 14 },
      { type: IndicatorType.SUPER_TREND, period: 10, multiplier: 3 },
    ],
    marketRegimeConfig: {
      highVolatilityThreshold: 0.15,
      lowVolatilityThreshold: 0.05,
    },
    createStrategyInput: (context) => context,
  };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function printRegimeMetrics(label: string, group: RegimePerformanceDto<string>): void {
  const metrics = group.performanceMetrics;
  console.log(
    `${label}: signals=${group.signalCount}, evaluable=${group.evaluableSignalCount}, ` +
      `accuracy(5/15/30/60)=${formatNumber(metrics.accuracy5m)}/${formatNumber(metrics.accuracy15m)}/${formatNumber(metrics.accuracy30m)}/${formatNumber(metrics.accuracy60m)}, ` +
      `avgMove(5/15/30/60)=${formatNumber(metrics.avg5m)}/${formatNumber(metrics.avg15m)}/${formatNumber(metrics.avg30m)}/${formatNumber(metrics.avg60m)}, ` +
      `MFE=${formatNumber(metrics.avgMFE)}, MAE=${formatNumber(metrics.avgMAE)}`
  );
}

function printReport(result: ResearchRunResult): void {
  const metrics = result.strategyReport.performanceMetrics;
  const regimes = result.regimeStrategyReport;

  console.log(`\n${result.strategyName}`);
  console.log(`Instrument: ${result.instrumentKey}`);
  console.log(`Date range: ${result.fromDate} to ${result.toDate}`);
  console.log(`Session count: ${result.sessionCount}`);
  console.log(`5m candle count: ${result.candleCount}`);
  console.log(`Emitted signals: ${result.emittedSignals}`);
  console.log(`Evaluable signals: ${metrics.evaluableSignals}`);
  console.log(
    `Accuracy (5/15/30/60): ${formatNumber(metrics.accuracy5m)}% / ${formatNumber(metrics.accuracy15m)}% / ${formatNumber(metrics.accuracy30m)}% / ${formatNumber(metrics.accuracy60m)}%`
  );
  console.log(
    `Average move (5/15/30/60): ${formatNumber(metrics.avg5m)} / ${formatNumber(metrics.avg15m)} / ${formatNumber(metrics.avg30m)} / ${formatNumber(metrics.avg60m)}`
  );
  console.log(`Average MFE: ${formatNumber(metrics.avgMFE)}`);
  console.log(`Average MAE: ${formatNumber(metrics.avgMAE)}`);
  console.log(`Best directional regime: ${regimes.bestDirectionalRegime ?? '-'}`);
  console.log(`Worst directional regime: ${regimes.worstDirectionalRegime ?? '-'}`);
  console.log(`Best volatility regime: ${regimes.bestVolatilityRegime ?? '-'}`);
  console.log(`Worst volatility regime: ${regimes.worstVolatilityRegime ?? '-'}`);
  console.log('Directional regime breakdown:');
  printRegimeMetrics('TREND_UP', regimes.directionalRegimePerformance.TREND_UP);
  printRegimeMetrics('TREND_DOWN', regimes.directionalRegimePerformance.TREND_DOWN);
  printRegimeMetrics('SIDEWAYS', regimes.directionalRegimePerformance.SIDEWAYS);
  console.log('Volatility regime breakdown:');
  printRegimeMetrics('HIGH_VOLATILITY', regimes.volatilityRegimePerformance.HIGH_VOLATILITY);
  printRegimeMetrics('NORMAL_VOLATILITY', regimes.volatilityRegimePerformance.NORMAL_VOLATILITY);
  printRegimeMetrics('LOW_VOLATILITY', regimes.volatilityRegimePerformance.LOW_VOLATILITY);
}

function printComparison(first: ResearchRunResult, second: ResearchRunResult): void {
  const firstMetrics = first.strategyReport.performanceMetrics;
  const secondMetrics = second.strategyReport.performanceMetrics;

  console.log('\nStrategy comparison');
  console.log('Strategy | Signals | Evaluable | Acc 5m | Acc 15m | Acc 30m | Acc 60m | Avg 60m | Avg MFE | Avg MAE');
  [
    [first.strategyName, firstMetrics],
    [second.strategyName, secondMetrics],
  ].forEach(([strategyName, metrics]) => {
    const typedMetrics = metrics as ResearchRunResult['strategyReport']['performanceMetrics'];
    const result = strategyName === first.strategyName ? first : second;
    console.log(
      `${strategyName} | ${result.emittedSignals} | ${typedMetrics.evaluableSignals} | ${formatNumber(typedMetrics.accuracy5m)}% | ${formatNumber(typedMetrics.accuracy15m)}% | ${formatNumber(typedMetrics.accuracy30m)}% | ${formatNumber(typedMetrics.accuracy60m)}% | ${formatNumber(typedMetrics.avg60m)} | ${formatNumber(typedMetrics.avgMFE)} | ${formatNumber(typedMetrics.avgMAE)}`
    );
  });
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const runner = new ResearchRunnerService();

  logger.info('Starting Research Runner integration test', { instrumentKey, timeframe: storedTimeframe });

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
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate));

  if (completeSessions.length === 0) {
    throw new Error(`No complete 09:15-15:29 IST sessions are stored for ${instrumentKey}.`);
  }

  const oneMinuteCandles = completeSessions
    .flatMap(([, candles]) => candles)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map(toInternalCandle);
  const fromDate = completeSessions[0][0];
  const toDate = completeSessions[completeSessions.length - 1][0];

  if (oneMinuteCandles.length < 255) {
    throw new Error('Insufficient complete candle data for EMA50 research execution.');
  }

  const emaCrossResult = runner.run(
    oneMinuteCandles,
    createConfig(new EmaCrossResearchAdapter(), 'EMA Cross Strategy', fromDate, toDate, false)
  );
  const emaTrendConfirmationResult = runner.run(
    oneMinuteCandles,
    createConfig(
      new EmaTrendConfirmationResearchAdapter(),
      'EMA Trend Confirmation Strategy',
      fromDate,
      toDate,
      true
    )
  );

  printReport(emaCrossResult);
  printReport(emaTrendConfirmationResult);
  printComparison(emaCrossResult, emaTrendConfirmationResult);

  logger.info('Research Runner integration test completed', {
    instrumentKey,
    sessionCount: completeSessions.length,
    fiveMinuteCandleCount: emaCrossResult.candleCount,
    emaCrossSignals: emaCrossResult.emittedSignals,
    emaTrendConfirmationSignals: emaTrendConfirmationResult.emittedSignals,
  });
}

run().catch((error) => {
  logger.error('Research Runner integration test failed', { error });
  console.error('Research Runner integration test failed.', error);
  process.exitCode = 1;
});
