import {
  PerformanceMetricsDto,
  PerformanceSignal,
  SignalPerformanceResultDto,
} from './performance-metrics.dto';

export type DominantSignalDirection = PerformanceSignal | 'BALANCED' | 'NONE';

export interface StrategyAnalysisInputDto {
  strategyId: string;
  strategyName: string;
  instrumentKey: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  signalResults: readonly SignalPerformanceResultDto[];
  sessionCount?: number;
}

export interface StrategyReportDto {
  strategyId: string;
  strategyName: string;
  instrumentKey: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  performanceMetrics: PerformanceMetricsDto;
  signalFrequencyPerSession?: number;
  dominantSignalDirection: DominantSignalDirection;
  generatedAt: Date;
}
