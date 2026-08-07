import { PerformanceMetricsDto } from './performance-metrics.dto';
import { StrategyReportDto } from './strategy-report.dto';

export interface ParameterSetDto {
  id: string;
  parameters: Readonly<Record<string, string | number | boolean>>;
}

export interface ParameterAnalysisInputDto {
  strategyName: string;
  parameterSets: readonly ParameterSetDto[];
  reports: readonly StrategyReportDto[];
}

export interface ParameterMetricResultDto {
  configurationId: string | null;
  value: number | null;
}

export interface ParameterAnalysisReportDto {
  strategyName: string;
  testedConfigurations: string[];
  bestAccuracy5m: ParameterMetricResultDto;
  bestAccuracy15m: ParameterMetricResultDto;
  bestAccuracy30m: ParameterMetricResultDto;
  bestAccuracy60m: ParameterMetricResultDto;
  bestAverage60mMove: ParameterMetricResultDto;
  bestAverageMFE: ParameterMetricResultDto;
  lowestAverageMAE: ParameterMetricResultDto;
  overallRecommendation: string | null;
}

export type ComparablePerformanceMetric =
  | keyof Pick<
      PerformanceMetricsDto,
      'accuracy5m' | 'accuracy15m' | 'accuracy30m' | 'accuracy60m' | 'avg60m' | 'avgMFE' | 'avgMAE'
    >;
