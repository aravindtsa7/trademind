import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import {
  ResearchRunConfig,
  ResearchRunResult,
  ResearchStrategyContext,
} from '../modules/research/dto/research-run.dto';
import ParameterAnalyzerService from '../modules/research/services/parameter-analyzer.service';
import ResearchRunnerService from '../modules/research/services/research-runner.service';
import { StrategySignal, StrategySignalDto } from '../modules/strategies/dto/strategy-signal.dto';
import { Strategy } from '../modules/strategies/interfaces/strategy.interface';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const storedTimeframe = '1minute';
const minimumSessionCount = 40;
const parameterConfigurations = [
  { id: 'EMA10 / EMA30', fastPeriod: 10, slowPeriod: 30 },
  { id: 'EMA12 / EMA26', fastPeriod: 12, slowPeriod: 26 },
  { id: 'EMA15 / EMA35', fastPeriod: 15, slowPeriod: 35 },
  { id: 'EMA20 / EMA50', fastPeriod: 20, slowPeriod: 50 },
  { id: 'EMA25 / EMA75', fastPeriod: 25, slowPeriod: 75 },
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

function noTrade(reason: string): StrategySignalDto {
  return { signal: StrategySignal.NO_TRADE, confidence: 0, reasons: [reason] };
}

function getEmaValue(
  indicatorResults: IndicatorEngineResult,
  timestamp: Date,
  period: number
): number | undefined {
  const matchingResults = indicatorResults.indicators.filter(
    (entry) =>
      entry.config.type === IndicatorType.EMA &&
      'period' in entry.config &&
      entry.config.period === period
  );
  if (matchingResults.length !== 1) {
    return undefined;
  }

  const entry = matchingResults[0].result.values.find(
    (value) => value.timestamp.getTime() === timestamp.getTime()
  );

  return entry && 'value' in entry && typeof entry.value === 'number' ? entry.value : undefined;
}

class ConfiguredEmaCrossResearchAdapter implements Strategy<ResearchStrategyContext> {
  readonly id: string;

  private readonly strategy: EmaCrossStrategy;

  constructor(
    private readonly fastPeriod: number,
    private readonly slowPeriod: number
  ) {
    this.id = `ema-cross-${fastPeriod}-${slowPeriod}`;
    this.strategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });
  }

  evaluate(context: ResearchStrategyContext): StrategySignalDto {
    const previousCandle = context.candles[context.candleIndex - 1];
    if (!previousCandle) {
      return noTrade('No previous candle is available for EMA crossover evaluation.');
    }

    const previousFast = getEmaValue(
      context.indicatorResults,
      previousCandle.timestamp,
      this.fastPeriod
    );
    const currentFast = getEmaValue(context.indicatorResults, context.candle.timestamp, this.fastPeriod);
    const previousSlow = getEmaValue(
      context.indicatorResults,
      previousCandle.timestamp,
      this.slowPeriod
    );
    const currentSlow = getEmaValue(context.indicatorResults, context.candle.timestamp, this.slowPeriod);
    const regimeEma20 = getEmaValue(context.indicatorResults, context.candle.timestamp, 20);
    const regimeEma50 = getEmaValue(context.indicatorResults, context.candle.timestamp, 50);

    if (
      previousFast === undefined ||
      currentFast === undefined ||
      previousSlow === undefined ||
      currentSlow === undefined ||
      regimeEma20 === undefined ||
      regimeEma50 === undefined
    ) {
      return noTrade('Required strategy or regime EMA values are not yet aligned at this candle.');
    }

    return this.strategy.evaluate({
      fastEma: {
        type: IndicatorType.EMA,
        period: this.fastPeriod,
        values: [
          { timestamp: previousCandle.timestamp, value: previousFast },
          { timestamp: context.candle.timestamp, value: currentFast },
        ],
      },
      slowEma: {
        type: IndicatorType.EMA,
        period: this.slowPeriod,
        values: [
          { timestamp: previousCandle.timestamp, value: previousSlow },
          { timestamp: context.candle.timestamp, value: currentSlow },
        ],
      },
    });
  }
}

function createConfig(
  strategy: Strategy<ResearchStrategyContext>,
  configuration: (typeof parameterConfigurations)[number],
  fromDate: string,
  toDate: string
): ResearchRunConfig<ResearchStrategyContext> {
  const emaPeriods = Array.from(new Set([configuration.fastPeriod, configuration.slowPeriod, 20, 50]));

  return {
    strategy,
    strategyName: `EMA Cross ${configuration.fastPeriod}/${configuration.slowPeriod}`,
    instrumentKey,
    timeframe: '5m',
    fromDate,
    toDate,
    indicatorRequests: [
      ...emaPeriods.map((period) => ({ type: IndicatorType.EMA as const, period })),
      { type: IndicatorType.ADX as const, period: 14 },
      { type: IndicatorType.ATR as const, period: 14 },
      { type: IndicatorType.SUPER_TREND as const, period: 10, multiplier: 3 },
    ],
    marketRegimeConfig: { highVolatilityThreshold: 0.15, lowVolatilityThreshold: 0.05 },
    createStrategyInput: (context) => context,
  };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function printResearchResults(results: Array<{ configuration: string; run: ResearchRunResult }>): void {
  console.log('Configuration | Signals | Evaluable | Acc 5m | Acc 15m | Acc 30m | Acc 60m | Avg 60m | Avg MFE | Avg MAE');
  results.forEach(({ configuration, run }) => {
    const metrics = run.strategyReport.performanceMetrics;
    console.log(
      `${configuration} | ${metrics.totalSignals} | ${metrics.evaluableSignals} | ${formatNumber(metrics.accuracy5m)}% | ${formatNumber(metrics.accuracy15m)}% | ${formatNumber(metrics.accuracy30m)}% | ${formatNumber(metrics.accuracy60m)}% | ${formatNumber(metrics.avg60m)} | ${formatNumber(metrics.avgMFE)} | ${formatNumber(metrics.avgMAE)}`
    );
  });
}

function printParameterMetricWinners(
  analysis: ReturnType<ParameterAnalyzerService['analyze']>
): void {
  const winners = [
    ['Best accuracy 5m', analysis.bestAccuracy5m],
    ['Best accuracy 15m', analysis.bestAccuracy15m],
    ['Best accuracy 30m', analysis.bestAccuracy30m],
    ['Best accuracy 60m', analysis.bestAccuracy60m],
    ['Best average 60m move', analysis.bestAverage60mMove],
    ['Best average MFE', analysis.bestAverageMFE],
    ['Lowest average MAE', analysis.lowestAverageMAE],
  ] as const;

  console.log('\nParameter metric winners:');
  winners.forEach(([label, winner]) => {
    const configuration = winner.configurationId ?? 'NONE (tie or unavailable)';
    const value = winner.value === null ? 'N/A' : formatNumber(winner.value);
    console.log(`${label}: ${configuration} (${value})`);
  });
}

function printValidationResult(result: ResearchRunResult): void {
  const metrics = result.strategyReport.performanceMetrics;

  console.log(`Selected configuration: ${result.strategyName}`);
  console.log(`Total signals: ${metrics.totalSignals}`);
  console.log(`Evaluable signals: ${metrics.evaluableSignals}`);
  console.log(`BUY_CE / BUY_PE: ${metrics.buyCeSignals} / ${metrics.buyPeSignals}`);
  console.log(
    `Accuracy (5/15/30/60): ${formatNumber(metrics.accuracy5m)}% / ${formatNumber(metrics.accuracy15m)}% / ${formatNumber(metrics.accuracy30m)}% / ${formatNumber(metrics.accuracy60m)}%`
  );
  console.log(
    `Average movement (5/15/30/60): ${formatNumber(metrics.avg5m)} / ${formatNumber(metrics.avg15m)} / ${formatNumber(metrics.avg30m)} / ${formatNumber(metrics.avg60m)}`
  );
  console.log(`Average MFE: ${formatNumber(metrics.avgMFE)}`);
  console.log(`Average MAE: ${formatNumber(metrics.avgMAE)}`);
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const runner = new ResearchRunnerService();
  const parameterAnalyzer = new ParameterAnalyzerService();

  logger.info('Starting EMA walk-forward research integration test', {
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

  if (completeSessions.length < minimumSessionCount) {
    throw new Error(
      `Walk-forward EMA research requires at least ${minimumSessionCount} complete sessions; found ${completeSessions.length}.`
    );
  }

  const researchSessionCount = Math.floor(completeSessions.length * 0.7);
  const researchSessions = completeSessions.slice(0, researchSessionCount);
  const validationSessions = completeSessions.slice(researchSessionCount);
  if (researchSessions.length === 0 || validationSessions.length === 0) {
    throw new Error('Walk-forward EMA research requires non-empty chronological research and validation windows.');
  }

  const researchFromDate = researchSessions[0][0];
  const researchToDate = researchSessions[researchSessions.length - 1][0];
  const validationFromDate = validationSessions[0][0];
  const validationToDate = validationSessions[validationSessions.length - 1][0];
  const researchCandles = toInternalCandles(researchSessions);
  const validationCandles = toInternalCandles(validationSessions);

  const researchResults = parameterConfigurations.map((configuration) => {
    const strategy = new ConfiguredEmaCrossResearchAdapter(
      configuration.fastPeriod,
      configuration.slowPeriod
    );
    const runResult = runner.run(
      researchCandles,
      createConfig(strategy, configuration, researchFromDate, researchToDate)
    );

    return { configuration: configuration.id, run: runResult };
  });
  const parameterAnalysis = parameterAnalyzer.analyze({
    strategyName: 'EMA Cross Strategy',
    parameterSets: parameterConfigurations.map((configuration) => ({
      id: configuration.id,
      parameters: { fastPeriod: configuration.fastPeriod, slowPeriod: configuration.slowPeriod },
    })),
    reports: researchResults.map(({ run: runResult }) => runResult.strategyReport),
  });

  console.log(`Research window: ${researchFromDate} to ${researchToDate} (${researchSessions.length} sessions)`);
  printResearchResults(researchResults);
  printParameterMetricWinners(parameterAnalysis);

  const selectedConfigurationId = parameterAnalysis.overallRecommendation;
  if (!selectedConfigurationId) {
    console.log('\nOverall Recommendation:');
    console.log('NONE (No unique winner)');
    logger.info('EMA walk-forward research completed without a unique recommendation', {
      instrumentKey,
      researchSessionCount: researchSessions.length,
    });
    return;
  }

  console.log(`\nOverall Recommendation: ${selectedConfigurationId}`);
  const selectedConfiguration = parameterConfigurations.find(
    (configuration) => configuration.id === selectedConfigurationId
  );
  const selectedResearchResult = researchResults.find(
    (result) => result.configuration === selectedConfigurationId
  );
  if (!selectedConfiguration || !selectedResearchResult) {
    throw new Error(`Selected EMA configuration ${selectedConfigurationId} cannot be resolved.`);
  }

  const validationResult = runner.run(
    validationCandles,
    createConfig(
      new ConfiguredEmaCrossResearchAdapter(
        selectedConfiguration.fastPeriod,
        selectedConfiguration.slowPeriod
      ),
      selectedConfiguration,
      validationFromDate,
      validationToDate
    )
  );
  const researchMetrics = selectedResearchResult.run.strategyReport.performanceMetrics;
  const validationMetrics = validationResult.strategyReport.performanceMetrics;

  console.log(`\nValidation window: ${validationFromDate} to ${validationToDate} (${validationSessions.length} sessions)`);
  printValidationResult(validationResult);
  console.log('\nSelected configuration research-to-validation deltas');
  console.log(`60m accuracy delta: ${formatNumber(validationMetrics.accuracy60m - researchMetrics.accuracy60m)} percentage points`);
  console.log(`Avg 60m move delta: ${formatNumber(validationMetrics.avg60m - researchMetrics.avg60m)}`);
  console.log(`Avg MFE delta: ${formatNumber(validationMetrics.avgMFE - researchMetrics.avgMFE)}`);
  console.log(`Avg MAE delta: ${formatNumber(validationMetrics.avgMAE - researchMetrics.avgMAE)}`);

  logger.info('EMA walk-forward research integration test completed', {
    instrumentKey,
    researchSessionCount: researchSessions.length,
    validationSessionCount: validationSessions.length,
    selectedConfiguration: selectedConfigurationId,
  });
}

run().catch((error) => {
  logger.error('EMA walk-forward research integration test failed', { error });
  console.error('EMA walk-forward research integration test failed.', error);
  process.exitCode = 1;
});
