import {
  ComparablePerformanceMetric,
  ParameterAnalysisInputDto,
  ParameterAnalysisReportDto,
  ParameterMetricResultDto,
} from '../dto/parameter-analysis-report.dto';
import { PerformanceMetricsDto } from '../dto/performance-metrics.dto';

interface ConfigurationPerformanceMetrics {
  configurationId: string;
  metrics: PerformanceMetricsDto;
}

export default class ParameterAnalyzerService {
  analyze(input: ParameterAnalysisInputDto): ParameterAnalysisReportDto {
    const configurationMetrics = this.getConfigurationMetrics(input);
    const bestAccuracy5m = this.findBest(configurationMetrics, 'accuracy5m', 'highest');
    const bestAccuracy15m = this.findBest(configurationMetrics, 'accuracy15m', 'highest');
    const bestAccuracy30m = this.findBest(configurationMetrics, 'accuracy30m', 'highest');
    const bestAccuracy60m = this.findBest(configurationMetrics, 'accuracy60m', 'highest');
    const bestAverage60mMove = this.findBest(configurationMetrics, 'avg60m', 'highest');
    const bestAverageMFE = this.findBest(configurationMetrics, 'avgMFE', 'highest');
    const lowestAverageMAE = this.findBest(configurationMetrics, 'avgMAE', 'lowest');

    return {
      strategyName: input.strategyName,
      testedConfigurations: input.parameterSets.map((parameterSet) => parameterSet.id),
      bestAccuracy5m,
      bestAccuracy15m,
      bestAccuracy30m,
      bestAccuracy60m,
      bestAverage60mMove,
      bestAverageMFE,
      lowestAverageMAE,
      overallRecommendation: this.getOverallRecommendation([
        bestAccuracy5m,
        bestAccuracy15m,
        bestAccuracy30m,
        bestAccuracy60m,
        bestAverage60mMove,
        bestAverageMFE,
        lowestAverageMAE,
      ]),
    };
  }

  private getConfigurationMetrics(
    input: ParameterAnalysisInputDto
  ): ConfigurationPerformanceMetrics[] {
    return input.parameterSets.flatMap((parameterSet, index) => {
      const metrics = input.reports[index]?.performanceMetrics;

      return metrics ? [{ configurationId: parameterSet.id, metrics }] : [];
    });
  }

  private findBest(
    configurationMetrics: readonly ConfigurationPerformanceMetrics[],
    metric: ComparablePerformanceMetric,
    direction: 'highest' | 'lowest'
  ): ParameterMetricResultDto {
    const candidates = configurationMetrics.filter((configuration) =>
      Number.isFinite(configuration.metrics[metric])
    );

    if (candidates.length === 0) {
      return { configurationId: null, value: null };
    }

    const bestValue = candidates.reduce(
      (currentBest, candidate) =>
        direction === 'highest'
          ? Math.max(currentBest, candidate.metrics[metric])
          : Math.min(currentBest, candidate.metrics[metric]),
      candidates[0].metrics[metric]
    );
    const winners = candidates.filter((candidate) => candidate.metrics[metric] === bestValue);

    return winners.length === 1
      ? { configurationId: winners[0].configurationId, value: bestValue }
      : { configurationId: null, value: bestValue };
  }

  private getOverallRecommendation(metricResults: readonly ParameterMetricResultDto[]): string | null {
    const uniqueWinners = metricResults
      .map((result) => result.configurationId)
      .filter((configurationId): configurationId is string => configurationId !== null);

    if (uniqueWinners.length === 0) {
      return null;
    }

    const winCounts = new Map<string, number>();
    uniqueWinners.forEach((configurationId) => {
      winCounts.set(configurationId, (winCounts.get(configurationId) ?? 0) + 1);
    });
    const highestWinCount = Math.max(...winCounts.values());
    const overallWinners = Array.from(winCounts.entries()).filter(
      ([, winCount]) => winCount === highestWinCount
    );

    return overallWinners.length === 1 && highestWinCount > metricResults.length / 2
      ? overallWinners[0][0]
      : null;
  }
}
