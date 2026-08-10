import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { SuperTrendDirection } from '../modules/indicators/indicators/supertrend.indicator';
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
const researchWindowSessions = 40;
const stepSessions = 20;
const configurations: readonly SuperTrendFilterConfiguration[] = [
  { id: 'EMA15/35 + RSI55/45 baseline' },
  { id: 'SuperTrend 7/2', superTrendPeriod: 7, multiplier: 2 },
  { id: 'SuperTrend 10/2', superTrendPeriod: 10, multiplier: 2 },
  { id: 'SuperTrend 10/3', superTrendPeriod: 10, multiplier: 3 },
  { id: 'SuperTrend 14/3', superTrendPeriod: 14, multiplier: 3 },
];
const baselineConfigurationId = configurations[0].id;
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

interface SuperTrendFilterConfiguration {
  id: string;
  superTrendPeriod?: number;
  multiplier?: number;
}

interface StabilityMetrics {
  windowsEvaluated: number;
  totalSignals: number;
  average60mAccuracy: number;
  average60mMove: number;
  averageMfe: number;
  averageMae: number;
  beatsBaselineAccuracy60m: number;
  beatsBaselineAverage60mMove: number;
  lowerMaeThanBaseline: number;
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
  period: number
): number | undefined {
  const matchingResults = indicatorResults.indicators.filter(
    (entry) =>
      entry.config.type === type && 'period' in entry.config && entry.config.period === period
  );
  if (matchingResults.length !== 1) {
    return undefined;
  }

  const entry = matchingResults[0].result.values.find(
    (value) => value.timestamp.getTime() === timestamp.getTime()
  );

  return entry && 'value' in entry && typeof entry.value === 'number' ? entry.value : undefined;
}

function getSuperTrendDirection(
  indicatorResults: IndicatorEngineResult,
  timestamp: Date,
  period: number,
  multiplier: number
): SuperTrendDirection | undefined {
  const matchingResults = indicatorResults.indicators.filter(
    (entry) =>
      entry.config.type === IndicatorType.SUPER_TREND &&
      'period' in entry.config &&
      'multiplier' in entry.config &&
      entry.config.period === period &&
      entry.config.multiplier === multiplier
  );
  if (matchingResults.length !== 1) {
    return undefined;
  }

  const entry = matchingResults[0].result.values.find(
    (value) => value.timestamp.getTime() === timestamp.getTime()
  );

  return entry && 'trend' in entry && Object.values(SuperTrendDirection).includes(entry.trend)
    ? entry.trend
    : undefined;
}

function noTrade(reason: string): StrategySignalDto {
  return { signal: StrategySignal.NO_TRADE, confidence: 0, reasons: [reason] };
}

class EmaRsiWithOptionalSuperTrendFilter implements Strategy<ResearchStrategyContext> {
  readonly id: string;

  private readonly emaCross = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });

  constructor(private readonly configuration: SuperTrendFilterConfiguration) {
    this.id = configuration.id.toLowerCase().replace(/\s+/g, '-').replace('/', '-');
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

    if (emaCrossSignal.signal === StrategySignal.NO_TRADE) {
      return emaCrossSignal;
    }

    const rsiPasses =
      (emaCrossSignal.signal === StrategySignal.BUY_CE && rsi > 55) ||
      (emaCrossSignal.signal === StrategySignal.BUY_PE && rsi < 45);
    if (!rsiPasses) {
      const comparison = emaCrossSignal.signal === StrategySignal.BUY_CE ? 'above 55' : 'below 45';
      return noTrade(
        `${emaCrossSignal.signal} EMA15/35 crossover rejected: RSI 14 ${rsi.toFixed(2)} is not ${comparison}.`
      );
    }

    if (
      this.configuration.superTrendPeriod === undefined ||
      this.configuration.multiplier === undefined
    ) {
      return {
        ...emaCrossSignal,
        reasons: [...emaCrossSignal.reasons, `RSI 14 ${rsi.toFixed(2)} confirmed the crossover.`],
      };
    }

    const direction = getSuperTrendDirection(
      context.indicatorResults,
      context.candle.timestamp,
      this.configuration.superTrendPeriod,
      this.configuration.multiplier
    );
    if (!direction) {
      return noTrade('Configured SuperTrend value is not yet aligned at this candle.');
    }

    const expectedDirection =
      emaCrossSignal.signal === StrategySignal.BUY_CE
        ? SuperTrendDirection.UP
        : SuperTrendDirection.DOWN;

    return direction === expectedDirection
      ? {
          ...emaCrossSignal,
          reasons: [
            ...emaCrossSignal.reasons,
            `RSI 14 ${rsi.toFixed(2)} and SuperTrend ${this.configuration.superTrendPeriod}/${this.configuration.multiplier} ${direction} confirmed the crossover.`,
          ],
        }
      : noTrade(
          `${emaCrossSignal.signal} EMA15/35 + RSI55/45 signal rejected: SuperTrend ${this.configuration.superTrendPeriod}/${this.configuration.multiplier} is ${direction}, expected ${expectedDirection}.`
        );
  }
}

function createConfig(
  strategy: Strategy<ResearchStrategyContext>,
  configuration: SuperTrendFilterConfiguration,
  fromDate: string,
  toDate: string
): ResearchRunConfig<ResearchStrategyContext> {
  // ResearchRunner currently consumes exactly one SuperTrend result for regime alignment.
  // Use the tested configuration itself, falling back to 10/3 for the no-filter baseline.
  const superTrendRequest = {
    type: IndicatorType.SUPER_TREND as const,
    period: configuration.superTrendPeriod ?? 10,
    multiplier: configuration.multiplier ?? 3,
  };

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
      { type: IndicatorType.ADX, period: 14 },
      { type: IndicatorType.ATR, period: 14 },
      { type: IndicatorType.EMA, period: 20 },
      { type: IndicatorType.EMA, period: 50 },
      superTrendRequest,
    ],
    marketRegimeConfig: { highVolatilityThreshold: 0.15, lowVolatilityThreshold: 0.05 },
    createStrategyInput: (context) => context,
  };
}

function getRollingWindows(sessions: readonly CompleteSession[]): CompleteSession[][] {
  if (sessions.length < researchWindowSessions) {
    throw new Error(
      `SuperTrend filter stability research requires at least ${researchWindowSessions} complete sessions; found ${sessions.length}.`
    );
  }

  const starts: number[] = [];
  for (let start = 0; start + researchWindowSessions <= sessions.length; start += stepSessions) {
    starts.push(start);
  }

  const finalStart = sessions.length - researchWindowSessions;
  if (starts[starts.length - 1] !== finalStart) {
    starts.push(finalStart);
  }

  return starts.map((start) => sessions.slice(start, start + researchWindowSessions));
}

function createStabilityMetrics(): StabilityMetrics {
  return {
    windowsEvaluated: 0,
    totalSignals: 0,
    average60mAccuracy: 0,
    average60mMove: 0,
    averageMfe: 0,
    averageMae: 0,
    beatsBaselineAccuracy60m: 0,
    beatsBaselineAverage60mMove: 0,
    lowerMaeThanBaseline: 0,
  };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function printWindow(
  number: number,
  sessions: readonly CompleteSession[],
  results: Array<{ configuration: SuperTrendFilterConfiguration; run: ResearchRunResult }>
): void {
  console.log(
    `\nWindow ${number}: ${sessions[0][0]} to ${sessions[sessions.length - 1][0]} (${sessions.length} sessions)`
  );
  console.log(
    'Configuration | Signals | Evaluable | Acc 5m | Acc 15m | Acc 30m | Acc 60m | Avg 60m | Avg MFE | Avg MAE'
  );
  results.forEach(({ configuration, run }) => {
    const metrics = run.strategyReport.performanceMetrics;
    console.log(
      `${configuration.id} | ${metrics.totalSignals} | ${metrics.evaluableSignals} | ${formatNumber(metrics.accuracy5m)}% | ${formatNumber(metrics.accuracy15m)}% | ${formatNumber(metrics.accuracy30m)}% | ${formatNumber(metrics.accuracy60m)}% | ${formatNumber(metrics.avg60m)} | ${formatNumber(metrics.avgMFE)} | ${formatNumber(metrics.avgMAE)}`
    );
  });
}

function printStabilitySummary(stabilityByConfiguration: Map<string, StabilityMetrics>): void {
  const entries = Array.from(stabilityByConfiguration.entries());
  console.log('\nSuperTrend filter stability summary');
  console.log(
    'Configuration | Windows | Avg signals | Avg 60m acc | Avg 60m move | Avg MFE | Avg MAE | Beats base acc | Beats base move | Lower MAE'
  );
  entries.forEach(([configuration, metrics]) => {
    console.log(
      `${configuration} | ${metrics.windowsEvaluated} | ${formatNumber(metrics.totalSignals / metrics.windowsEvaluated)} | ${formatNumber(metrics.average60mAccuracy)}% | ${formatNumber(metrics.average60mMove)} | ${formatNumber(metrics.averageMfe)} | ${formatNumber(metrics.averageMae)} | ${metrics.beatsBaselineAccuracy60m} | ${metrics.beatsBaselineAverage60mMove} | ${metrics.lowerMaeThanBaseline}`
    );
  });

  const rankedConfigurations = entries
    .filter(([configuration]) => configuration !== baselineConfigurationId)
    .sort(
      ([leftId, left], [rightId, right]) =>
        right.beatsBaselineAccuracy60m - left.beatsBaselineAccuracy60m ||
        right.beatsBaselineAverage60mMove - left.beatsBaselineAverage60mMove ||
        right.lowerMaeThanBaseline - left.lowerMaeThanBaseline ||
        right.average60mAccuracy - left.average60mAccuracy ||
        right.average60mMove - left.average60mMove ||
        left.averageMae - right.averageMae ||
        leftId.localeCompare(rightId)
    );
  console.log(
    `Most consistently competitive SuperTrend configuration: ${rankedConfigurations[0][0]}. This is not a production promotion or option P&L conclusion.`
  );
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const runner = new ResearchRunnerService();

  logger.info('Starting SuperTrend filter stability research integration test', {
    instrumentKey,
    timeframe: storedTimeframe,
    researchWindowSessions,
    stepSessions,
  });

  const storedCandles = await repository.findByInstrumentAndTimeframe(instrumentKey, storedTimeframe);
  const candlesByTradingDate = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const date = getMarketDateAndMinute(candle.candleTime).date;
    const dailyCandles = candlesByTradingDate.get(date) ?? [];
    dailyCandles.push(candle);
    candlesByTradingDate.set(date, dailyCandles);
  });
  const completeSessions = Array.from(candlesByTradingDate.entries())
    .filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate)) as CompleteSession[];
  const windows = getRollingWindows(completeSessions);
  const stabilityByConfiguration = new Map(
    configurations.map((configuration) => [configuration.id, createStabilityMetrics()])
  );

  windows.forEach((sessions, index) => {
    const fromDate = sessions[0][0];
    const toDate = sessions[sessions.length - 1][0];
    const candles = toInternalCandles(sessions);
    const results = configurations.map((configuration) => ({
      configuration,
      run: runner.run(
        candles,
        createConfig(
          new EmaRsiWithOptionalSuperTrendFilter(configuration),
          configuration,
          fromDate,
          toDate
        )
      ),
    }));
    const baseline = results.find(({ configuration }) => configuration.id === baselineConfigurationId);
    if (!baseline) {
      throw new Error('EMA15/35 + RSI55/45 baseline result is missing.');
    }

    const baselineMetrics = baseline.run.strategyReport.performanceMetrics;
    results.forEach(({ configuration, run: runResult }) => {
      const metrics = stabilityByConfiguration.get(configuration.id);
      if (!metrics) {
        throw new Error(`Missing stability metrics for ${configuration.id}.`);
      }

      const performance = runResult.strategyReport.performanceMetrics;
      metrics.windowsEvaluated += 1;
      metrics.totalSignals += performance.totalSignals;
      metrics.average60mAccuracy += performance.accuracy60m;
      metrics.average60mMove += performance.avg60m;
      metrics.averageMfe += performance.avgMFE;
      metrics.averageMae += performance.avgMAE;

      if (configuration.id !== baselineConfigurationId) {
        metrics.beatsBaselineAccuracy60m += Number(
          performance.accuracy60m > baselineMetrics.accuracy60m
        );
        metrics.beatsBaselineAverage60mMove += Number(
          performance.avg60m > baselineMetrics.avg60m
        );
        metrics.lowerMaeThanBaseline += Number(performance.avgMAE < baselineMetrics.avgMAE);
      }
    });
    printWindow(index + 1, sessions, results);
  });

  stabilityByConfiguration.forEach((metrics) => {
    metrics.average60mAccuracy /= metrics.windowsEvaluated;
    metrics.average60mMove /= metrics.windowsEvaluated;
    metrics.averageMfe /= metrics.windowsEvaluated;
    metrics.averageMae /= metrics.windowsEvaluated;
  });
  printStabilitySummary(stabilityByConfiguration);

  logger.info('SuperTrend filter stability research integration test completed', {
    instrumentKey,
    completeSessionCount: completeSessions.length,
    windowCount: windows.length,
  });
}

run().catch((error) => {
  logger.error('SuperTrend filter stability research integration test failed', { error });
  console.error('SuperTrend filter stability research integration test failed.', error);
  process.exitCode = 1;
});
