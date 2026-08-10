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
const researchWindowSessions = 40;
const stepSessions = 20;
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

interface StabilityMetrics {
  windowsEvaluated: number;
  accuracy5mWins: number;
  accuracy15mWins: number;
  accuracy30mWins: number;
  accuracy60mWins: number;
  average60mMoveWins: number;
  mfeWins: number;
  lowestMaeWins: number;
  totalMetricWins: number;
  average60mAccuracy: number;
  average60mMove: number;
  averageMfe: number;
  averageMae: number;
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

function getRollingWindows(sessions: readonly CompleteSession[]): CompleteSession[][] {
  if (sessions.length < researchWindowSessions) {
    throw new Error(
      `EMA parameter stability research requires at least ${researchWindowSessions} complete sessions; found ${sessions.length}.`
    );
  }

  const windowStarts: number[] = [];
  for (let start = 0; start + researchWindowSessions <= sessions.length; start += stepSessions) {
    windowStarts.push(start);
  }

  const finalStart = sessions.length - researchWindowSessions;
  if (windowStarts[windowStarts.length - 1] !== finalStart) {
    windowStarts.push(finalStart);
  }

  return windowStarts.map((start) => sessions.slice(start, start + researchWindowSessions));
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function printWindowResults(
  windowNumber: number,
  sessions: readonly CompleteSession[],
  results: Array<{ configuration: string; run: ResearchRunResult }>,
  analysis: ReturnType<ParameterAnalyzerService['analyze']>
): void {
  console.log(
    `\nWindow ${windowNumber}: ${sessions[0][0]} to ${sessions[sessions.length - 1][0]} (${sessions.length} sessions)`
  );
  console.log(
    'Configuration | Signals | Evaluable | Acc 5m | Acc 15m | Acc 30m | Acc 60m | Avg 60m | Avg MFE | Avg MAE'
  );

  results.forEach(({ configuration, run }) => {
    const metrics = run.strategyReport.performanceMetrics;
    console.log(
      `${configuration} | ${metrics.totalSignals} | ${metrics.evaluableSignals} | ${formatNumber(metrics.accuracy5m)}% | ${formatNumber(metrics.accuracy15m)}% | ${formatNumber(metrics.accuracy30m)}% | ${formatNumber(metrics.accuracy60m)}% | ${formatNumber(metrics.avg60m)} | ${formatNumber(metrics.avgMFE)} | ${formatNumber(metrics.avgMAE)}`
    );
  });

  console.log('Metric winners:');
  const winners = [
    ['bestAccuracy5m', analysis.bestAccuracy5m],
    ['bestAccuracy15m', analysis.bestAccuracy15m],
    ['bestAccuracy30m', analysis.bestAccuracy30m],
    ['bestAccuracy60m', analysis.bestAccuracy60m],
    ['bestAverage60mMove', analysis.bestAverage60mMove],
    ['bestAverageMFE', analysis.bestAverageMFE],
    ['lowestAverageMAE', analysis.lowestAverageMAE],
  ] as const;
  winners.forEach(([metric, winner]) => {
    console.log(
      `- ${metric}: ${winner.configurationId ?? 'NONE (tie or unavailable)'} (${winner.value === null ? 'N/A' : formatNumber(winner.value)})`
    );
  });
}

function createStabilityMetrics(): StabilityMetrics {
  return {
    windowsEvaluated: 0,
    accuracy5mWins: 0,
    accuracy15mWins: 0,
    accuracy30mWins: 0,
    accuracy60mWins: 0,
    average60mMoveWins: 0,
    mfeWins: 0,
    lowestMaeWins: 0,
    totalMetricWins: 0,
    average60mAccuracy: 0,
    average60mMove: 0,
    averageMfe: 0,
    averageMae: 0,
  };
}

function addWinner(
  stabilityByConfiguration: Map<string, StabilityMetrics>,
  configurationId: string | null,
  metric:
    | 'accuracy5mWins'
    | 'accuracy15mWins'
    | 'accuracy30mWins'
    | 'accuracy60mWins'
    | 'average60mMoveWins'
    | 'mfeWins'
    | 'lowestMaeWins'
): void {
  if (!configurationId) {
    return;
  }

  const metrics = stabilityByConfiguration.get(configurationId);
  if (!metrics) {
    throw new Error(`Unknown parameter configuration returned by analyzer: ${configurationId}.`);
  }

  metrics[metric] += 1;
  metrics.totalMetricWins += 1;
}

function printStabilitySummary(stabilityByConfiguration: Map<string, StabilityMetrics>): void {
  const rankedConfigurations = Array.from(stabilityByConfiguration.entries()).sort(
    ([leftId, left], [rightId, right]) =>
      right.totalMetricWins - left.totalMetricWins ||
      right.average60mAccuracy - left.average60mAccuracy ||
      right.average60mMove - left.average60mMove ||
      leftId.localeCompare(rightId)
  );

  console.log('\nParameter stability summary');
  console.log(
    'Configuration | Windows | 5m wins | 15m wins | 30m wins | 60m wins | Avg60 wins | MFE wins | Low MAE wins | Total wins | Avg 60m acc | Avg 60m move | Avg MFE | Avg MAE'
  );
  rankedConfigurations.forEach(([configuration, metrics]) => {
    console.log(
      `${configuration} | ${metrics.windowsEvaluated} | ${metrics.accuracy5mWins} | ${metrics.accuracy15mWins} | ${metrics.accuracy30mWins} | ${metrics.accuracy60mWins} | ${metrics.average60mMoveWins} | ${metrics.mfeWins} | ${metrics.lowestMaeWins} | ${metrics.totalMetricWins} | ${formatNumber(metrics.average60mAccuracy)}% | ${formatNumber(metrics.average60mMove)} | ${formatNumber(metrics.averageMfe)} | ${formatNumber(metrics.averageMae)}`
    );
  });

  const highestTotalWins = rankedConfigurations[0]?.[1].totalMetricWins ?? 0;
  const mostCompetitive = rankedConfigurations
    .filter(([, metrics]) => metrics.totalMetricWins === highestTotalWins)
    .map(([configuration]) => configuration);
  console.log(
    `Most consistently competitive configuration(s): ${mostCompetitive.join(', ')}. This is a stability comparison, not a production recommendation or option P&L assessment.`
  );
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const runner = new ResearchRunnerService();
  const parameterAnalyzer = new ParameterAnalyzerService();

  logger.info('Starting EMA parameter stability research integration test', {
    instrumentKey,
    timeframe: storedTimeframe,
    researchWindowSessions,
    stepSessions,
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
  const windows = getRollingWindows(completeSessions);
  const stabilityByConfiguration = new Map(
    parameterConfigurations.map((configuration) => [configuration.id, createStabilityMetrics()])
  );

  windows.forEach((sessions, index) => {
    const fromDate = sessions[0][0];
    const toDate = sessions[sessions.length - 1][0];
    const candles = toInternalCandles(sessions);
    const results = parameterConfigurations.map((configuration) => {
      const runResult = runner.run(
        candles,
        createConfig(
          new ConfiguredEmaCrossResearchAdapter(configuration.fastPeriod, configuration.slowPeriod),
          configuration,
          fromDate,
          toDate
        )
      );

      return { configuration: configuration.id, run: runResult };
    });
    const analysis = parameterAnalyzer.analyze({
      strategyName: 'EMA Cross Strategy',
      parameterSets: parameterConfigurations.map((configuration) => ({
        id: configuration.id,
        parameters: { fastPeriod: configuration.fastPeriod, slowPeriod: configuration.slowPeriod },
      })),
      reports: results.map(({ run: runResult }) => runResult.strategyReport),
    });

    results.forEach(({ configuration, run: runResult }) => {
      const metrics = stabilityByConfiguration.get(configuration);
      if (!metrics) {
        throw new Error(`Missing stability metrics for ${configuration}.`);
      }

      const performance = runResult.strategyReport.performanceMetrics;
      metrics.windowsEvaluated += 1;
      metrics.average60mAccuracy += performance.accuracy60m;
      metrics.average60mMove += performance.avg60m;
      metrics.averageMfe += performance.avgMFE;
      metrics.averageMae += performance.avgMAE;
    });
    addWinner(stabilityByConfiguration, analysis.bestAccuracy5m.configurationId, 'accuracy5mWins');
    addWinner(stabilityByConfiguration, analysis.bestAccuracy15m.configurationId, 'accuracy15mWins');
    addWinner(stabilityByConfiguration, analysis.bestAccuracy30m.configurationId, 'accuracy30mWins');
    addWinner(stabilityByConfiguration, analysis.bestAccuracy60m.configurationId, 'accuracy60mWins');
    addWinner(stabilityByConfiguration, analysis.bestAverage60mMove.configurationId, 'average60mMoveWins');
    addWinner(stabilityByConfiguration, analysis.bestAverageMFE.configurationId, 'mfeWins');
    addWinner(stabilityByConfiguration, analysis.lowestAverageMAE.configurationId, 'lowestMaeWins');
    printWindowResults(index + 1, sessions, results, analysis);
  });

  stabilityByConfiguration.forEach((metrics) => {
    metrics.average60mAccuracy /= metrics.windowsEvaluated;
    metrics.average60mMove /= metrics.windowsEvaluated;
    metrics.averageMfe /= metrics.windowsEvaluated;
    metrics.averageMae /= metrics.windowsEvaluated;
  });
  printStabilitySummary(stabilityByConfiguration);

  logger.info('EMA parameter stability research integration test completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    windowCount: windows.length,
  });
}

run().catch((error) => {
  logger.error('EMA parameter stability research integration test failed', { error });
  console.error('EMA parameter stability research integration test failed.', error);
  process.exitCode = 1;
});
