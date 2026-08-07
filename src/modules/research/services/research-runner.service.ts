import { AdxValue } from '../../indicators/indicators/adx.indicator';
import { SuperTrendDirection, SuperTrendValue } from '../../indicators/indicators/supertrend.indicator';
import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, {
  IndicatorEngineResult,
  SupportedIndicatorResult,
} from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import { StrategySignal, StrategySignalDto } from '../../strategies/dto/strategy-signal.dto';
import MarketRegimeAnalyzerService from './market-regime-analyzer.service';
import RegimeStrategyAnalyzerService from './regime-strategy-analyzer.service';
import StrategyAnalyzerService from './strategy-analyzer.service';
import {
  ResearchRunConfig,
  ResearchRunResult,
  ResearchSignalOutcomeDto,
} from '../dto/research-run.dto';

const horizons = [5, 15, 30, 60] as const;
const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface CandleLocation {
  sessionCandles: Candle[];
  index: number;
}

export default class ResearchRunnerService {
  private readonly candleAggregator = new CandleTimeframeAggregatorService();
  private readonly indicatorEngine = new IndicatorEngineService();
  private readonly strategyAnalyzer = new StrategyAnalyzerService();
  private readonly regimeStrategyAnalyzer = new RegimeStrategyAnalyzerService();

  constructor(private readonly now: () => Date = () => new Date()) {}

  run<TStrategyInput>(
    candles: readonly Candle[],
    config: ResearchRunConfig<TStrategyInput>
  ): ResearchRunResult {
    const aggregatedCandles = this.candleAggregator.aggregate(candles, config.timeframe);
    if (aggregatedCandles.length === 0) {
      throw new Error('Research Runner requires at least one aggregated candle.');
    }

    const indicatorResults = this.indicatorEngine.calculate(aggregatedCandles, {
      indicators: config.indicatorRequests,
    });
    const marketRegimeAnalyzer = new MarketRegimeAnalyzerService(config.marketRegimeConfig);
    const candleLocations = this.createCandleLocations(aggregatedCandles);
    const outcomes: ResearchSignalOutcomeDto[] = [];
    let totalRawEvaluations = 0;

    aggregatedCandles.forEach((candle, candleIndex) => {
      const strategyResult = config.strategy.evaluate(
        config.createStrategyInput({
          candle,
          candleIndex,
          candles: aggregatedCandles,
          indicatorResults,
        })
      );
      totalRawEvaluations += 1;

      if (
        strategyResult.signal !== StrategySignal.BUY_CE &&
        strategyResult.signal !== StrategySignal.BUY_PE
      ) {
        return;
      }

      const regime = marketRegimeAnalyzer.analyze(
        this.getMarketRegimeInput(candle.timestamp, candle.close, indicatorResults)
      );
      const location = candleLocations.get(candle.timestamp.getTime());
      if (!location) {
        throw new Error(`Research Runner cannot locate signal candle at ${candle.timestamp.toISOString()}.`);
      }

      outcomes.push(
        this.createSignalOutcome(config, strategyResult, candle, location, regime)
      );
    });

    const sessionCount = new Set(
      aggregatedCandles.map((candle) => this.getMarketDate(candle.timestamp))
    ).size;
    const strategyReport = this.strategyAnalyzer.analyze({
      strategyId: config.strategy.id,
      strategyName: config.strategyName,
      instrumentKey: config.instrumentKey,
      timeframe: config.timeframe,
      fromDate: config.fromDate,
      toDate: config.toDate,
      signalResults: outcomes,
      sessionCount,
    });
    const regimeStrategyReport = this.regimeStrategyAnalyzer.analyze({
      strategyId: config.strategy.id,
      strategyName: config.strategyName,
      instrumentKey: config.instrumentKey,
      timeframe: config.timeframe,
      fromDate: config.fromDate,
      toDate: config.toDate,
      signalResults: outcomes,
    });

    return {
      strategyId: config.strategy.id,
      strategyName: config.strategyName,
      instrumentKey: config.instrumentKey,
      timeframe: config.timeframe,
      fromDate: config.fromDate,
      toDate: config.toDate,
      sessionCount,
      candleCount: aggregatedCandles.length,
      totalRawEvaluations,
      emittedSignals: outcomes.length,
      signalOutcomes: outcomes,
      strategyReport,
      regimeStrategyReport,
      generatedAt: this.now(),
    };
  }

  private createSignalOutcome<TStrategyInput>(
    config: ResearchRunConfig<TStrategyInput>,
    strategyResult: StrategySignalDto,
    candle: Candle,
    location: CandleLocation,
    regime: ReturnType<MarketRegimeAnalyzerService['analyze']>
  ): ResearchSignalOutcomeDto {
    const signal = strategyResult.signal;
    if (signal !== StrategySignal.BUY_CE && signal !== StrategySignal.BUY_PE) {
      throw new Error('Research Runner only evaluates BUY_CE and BUY_PE signals.');
    }

    const directionalPoints = this.calculateDirectionalPoints(
      signal,
      candle.close,
      location.sessionCandles,
      location.index,
      config.timeframe
    );
    const futureWindow = this.getFutureWindow(
      location.sessionCandles,
      location.index,
      60,
      config.timeframe
    );
    const mfe = futureWindow
      ? signal === StrategySignal.BUY_CE
        ? Math.max(...futureWindow.map((futureCandle) => futureCandle.high)) - candle.close
        : candle.close - Math.min(...futureWindow.map((futureCandle) => futureCandle.low))
      : null;
    const mae = futureWindow
      ? signal === StrategySignal.BUY_CE
        ? candle.close - Math.min(...futureWindow.map((futureCandle) => futureCandle.low)
        )
        : Math.max(...futureWindow.map((futureCandle) => futureCandle.high)) - candle.close
      : null;

    return {
      signal,
      directionalRegime: regime.directionalRegime,
      volatilityRegime: regime.volatilityRegime,
      directionalPoints,
      mfe,
      mae,
      timestamp: candle.timestamp,
      strategyId: config.strategy.id,
      strategyName: config.strategyName,
      confidence: strategyResult.confidence,
      reasons: [...strategyResult.reasons],
      signalClose: candle.close,
    };
  }

  private calculateDirectionalPoints(
    signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE,
    signalClose: number,
    sessionCandles: readonly Candle[],
    signalIndex: number,
    timeframe: ResearchRunConfig<unknown>['timeframe']
  ): ResearchSignalOutcomeDto['directionalPoints'] {
    return Object.fromEntries(
      horizons.map((horizon) => {
        const futureCandle = this.getFutureCandle(
          sessionCandles,
          signalIndex,
          horizon,
          timeframe
        );
        const directionalPoints = futureCandle
          ? signal === StrategySignal.BUY_CE
            ? futureCandle.close - signalClose
            : signalClose - futureCandle.close
          : null;

        return [`${horizon}m`, directionalPoints];
      })
    ) as ResearchSignalOutcomeDto['directionalPoints'];
  }

  private getFutureWindow(
    sessionCandles: readonly Candle[],
    signalIndex: number,
    horizonMinutes: number,
    timeframe: ResearchRunConfig<unknown>['timeframe']
  ): Candle[] | null {
    const candleOffset = this.getCandleOffset(horizonMinutes, timeframe);
    const futureWindow = sessionCandles.slice(signalIndex + 1, signalIndex + candleOffset + 1);

    return futureWindow.length === candleOffset ? futureWindow : null;
  }

  private getFutureCandle(
    sessionCandles: readonly Candle[],
    signalIndex: number,
    horizonMinutes: number,
    timeframe: ResearchRunConfig<unknown>['timeframe']
  ): Candle | undefined {
    return sessionCandles[signalIndex + this.getCandleOffset(horizonMinutes, timeframe)];
  }

  private getCandleOffset(
    horizonMinutes: number,
    timeframe: ResearchRunConfig<unknown>['timeframe']
  ): number {
    const timeframeMinutes = Number.parseInt(timeframe, 10);
    if (!Number.isInteger(timeframeMinutes) || horizonMinutes % timeframeMinutes !== 0) {
      throw new Error(
        `Research Runner cannot evaluate a ${horizonMinutes}m horizon from ${timeframe} candles.`
      );
    }

    return horizonMinutes / timeframeMinutes;
  }

  private createCandleLocations(candles: readonly Candle[]): Map<number, CandleLocation> {
    const sessionCandlesByDate = new Map<string, Candle[]>();
    candles.forEach((candle) => {
      const marketDate = this.getMarketDate(candle.timestamp);
      const sessionCandles = sessionCandlesByDate.get(marketDate) ?? [];
      sessionCandles.push(candle);
      sessionCandlesByDate.set(marketDate, sessionCandles);
    });

    const locations = new Map<number, CandleLocation>();
    sessionCandlesByDate.forEach((sessionCandles) => {
      sessionCandles.forEach((candle, index) => {
        locations.set(candle.timestamp.getTime(), { sessionCandles, index });
      });
    });

    return locations;
  }

  private getMarketRegimeInput(
    timestamp: Date,
    close: number,
    indicatorResults: IndicatorEngineResult
  ) {
    const adx = this.getStructuredValue<AdxValue>(indicatorResults, IndicatorType.ADX, timestamp, 14);
    const superTrend = this.getStructuredValue<SuperTrendValue>(
      indicatorResults,
      IndicatorType.SUPER_TREND,
      timestamp
    );

    return {
      timestamp,
      close,
      ema20: this.getScalarValue(indicatorResults, IndicatorType.EMA, timestamp, 20),
      ema50: this.getScalarValue(indicatorResults, IndicatorType.EMA, timestamp, 50),
      adx14: adx.adx,
      atr14: this.getScalarValue(indicatorResults, IndicatorType.ATR, timestamp, 14),
      superTrendDirection: superTrend.trend as SuperTrendDirection,
    };
  }

  private getScalarValue(
    indicatorResults: IndicatorEngineResult,
    type: IndicatorType,
    timestamp: Date,
    period: number
  ): number {
    const value = this.getIndicatorValue(indicatorResults, type, timestamp, period);
    const scalarValue = 'value' in value ? value.value : undefined;
    if (typeof scalarValue !== 'number' || !Number.isFinite(scalarValue)) {
      throw new Error(`Research Runner is missing a scalar ${type} value at ${timestamp.toISOString()}.`);
    }

    return scalarValue;
  }

  private getStructuredValue<TValue extends object>(
    indicatorResults: IndicatorEngineResult,
    type: IndicatorType,
    timestamp: Date,
    period?: number
  ): TValue & { timestamp: Date } {
    const value = this.getIndicatorValue(indicatorResults, type, timestamp, period);
    if ('value' in value) {
      throw new Error(`Research Runner is missing a structured ${type} value at ${timestamp.toISOString()}.`);
    }

    return value as unknown as TValue & { timestamp: Date };
  }

  private getIndicatorValue(
    indicatorResults: IndicatorEngineResult,
    type: IndicatorType,
    timestamp: Date,
    period?: number
  ): SupportedIndicatorResult['values'][number] {
    const matchingResults = indicatorResults.indicators.filter(
      (entry) =>
        entry.config.type === type &&
        (period === undefined || ('period' in entry.config && entry.config.period === period))
    );
    if (matchingResults.length !== 1) {
      throw new Error(`Research Runner requires one ${type} indicator result for regime alignment.`);
    }

    const value = matchingResults[0].result.values.find(
      (entry) => entry.timestamp.getTime() === timestamp.getTime()
    );
    if (!value) {
      throw new Error(`Research Runner is missing ${type} alignment at ${timestamp.toISOString()}.`);
    }

    return value;
  }

  private getMarketDate(timestamp: Date): string {
    const values = Object.fromEntries(
      marketDateFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }
}
