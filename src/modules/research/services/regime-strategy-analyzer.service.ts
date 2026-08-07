import {
  RegimePerformanceDto,
  RegimeSignalPerformanceResultDto,
  RegimeStrategyAnalysisInputDto,
  RegimeStrategyReportDto,
} from '../dto/regime-strategy-report.dto';
import PerformanceAnalyzerService from './performance-analyzer.service';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../types/market-regime.types';

const directionalRegimes = [
  DirectionalMarketRegime.TREND_UP,
  DirectionalMarketRegime.TREND_DOWN,
  DirectionalMarketRegime.SIDEWAYS,
] as const;
const volatilityRegimes = [
  VolatilityMarketRegime.HIGH_VOLATILITY,
  VolatilityMarketRegime.NORMAL_VOLATILITY,
  VolatilityMarketRegime.LOW_VOLATILITY,
] as const;

interface PerformanceAnalyzer {
  analyze: PerformanceAnalyzerService['analyze'];
}

export default class RegimeStrategyAnalyzerService {
  constructor(private readonly performanceAnalyzer: PerformanceAnalyzer = new PerformanceAnalyzerService()) {}

  analyze(input: RegimeStrategyAnalysisInputDto): RegimeStrategyReportDto {
    const directionalRegimePerformance = this.groupDirectionalRegimes(input.signalResults);
    const volatilityRegimePerformance = this.groupVolatilityRegimes(input.signalResults);

    return {
      strategyId: input.strategyId,
      strategyName: input.strategyName,
      instrumentKey: input.instrumentKey,
      timeframe: input.timeframe,
      fromDate: input.fromDate,
      toDate: input.toDate,
      overallPerformance: this.performanceAnalyzer.analyze(input.signalResults),
      directionalRegimePerformance,
      volatilityRegimePerformance,
      bestDirectionalRegime: this.selectRegime(
        Object.values(directionalRegimePerformance),
        'best'
      ),
      worstDirectionalRegime: this.selectRegime(
        Object.values(directionalRegimePerformance),
        'worst'
      ),
      bestVolatilityRegime: this.selectRegime(Object.values(volatilityRegimePerformance), 'best'),
      worstVolatilityRegime: this.selectRegime(Object.values(volatilityRegimePerformance), 'worst'),
    };
  }

  private groupDirectionalRegimes(
    signalResults: readonly RegimeSignalPerformanceResultDto[]
  ): Record<DirectionalMarketRegime, RegimePerformanceDto<DirectionalMarketRegime>> {
    return this.createGroups(
      directionalRegimes,
      signalResults,
      (signalResult) => signalResult.directionalRegime
    );
  }

  private groupVolatilityRegimes(
    signalResults: readonly RegimeSignalPerformanceResultDto[]
  ): Record<VolatilityMarketRegime, RegimePerformanceDto<VolatilityMarketRegime>> {
    return this.createGroups(
      volatilityRegimes,
      signalResults,
      (signalResult) => signalResult.volatilityRegime
    );
  }

  private createGroups<TRegime extends string>(
    regimes: readonly TRegime[],
    signalResults: readonly RegimeSignalPerformanceResultDto[],
    getRegime: (signalResult: RegimeSignalPerformanceResultDto) => TRegime
  ): Record<TRegime, RegimePerformanceDto<TRegime>> {
    return Object.fromEntries(
      regimes.map((regime) => {
        const groupSignalResults = signalResults.filter((signalResult) => getRegime(signalResult) === regime);
        const performanceMetrics = this.performanceAnalyzer.analyze(groupSignalResults);

        return [
          regime,
          {
            regime,
            signalCount: groupSignalResults.length,
            evaluableSignalCount: performanceMetrics.evaluableSignals,
            performanceMetrics,
          },
        ];
      })
    ) as Record<TRegime, RegimePerformanceDto<TRegime>>;
  }

  private selectRegime<TRegime extends string>(
    regimePerformance: readonly RegimePerformanceDto<TRegime>[],
    selection: 'best' | 'worst'
  ): TRegime | null {
    const candidates = regimePerformance.filter(
      (performance) => performance.evaluableSignalCount > 0
    );

    if (candidates.length === 0) {
      return null;
    }

    const accuracyWinnerValue = candidates.reduce(
      (value, performance) =>
        selection === 'best'
          ? Math.max(value, performance.performanceMetrics.accuracy60m)
          : Math.min(value, performance.performanceMetrics.accuracy60m),
      candidates[0].performanceMetrics.accuracy60m
    );
    const accuracyWinners = candidates.filter(
      (performance) => performance.performanceMetrics.accuracy60m === accuracyWinnerValue
    );

    if (accuracyWinners.length === 1) {
      return accuracyWinners[0].regime;
    }

    const movementWinnerValue = accuracyWinners.reduce(
      (value, performance) =>
        selection === 'best'
          ? Math.max(value, performance.performanceMetrics.avg60m)
          : Math.min(value, performance.performanceMetrics.avg60m),
      accuracyWinners[0].performanceMetrics.avg60m
    );
    const movementWinners = accuracyWinners.filter(
      (performance) => performance.performanceMetrics.avg60m === movementWinnerValue
    );

    return movementWinners.length === 1 ? movementWinners[0].regime : null;
  }
}
