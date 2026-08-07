import {
  PerformanceMetricsDto,
  SignalPerformanceResultDto,
} from './performance-metrics.dto';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../types/market-regime.types';

export interface RegimeSignalPerformanceResultDto extends SignalPerformanceResultDto {
  directionalRegime: DirectionalMarketRegime;
  volatilityRegime: VolatilityMarketRegime;
}

export interface RegimeStrategyAnalysisInputDto {
  strategyId: string;
  strategyName: string;
  instrumentKey: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  signalResults: readonly RegimeSignalPerformanceResultDto[];
}

export interface RegimePerformanceDto<TRegime extends string> {
  regime: TRegime;
  signalCount: number;
  evaluableSignalCount: number;
  performanceMetrics: PerformanceMetricsDto;
}

export interface RegimeStrategyReportDto {
  strategyId: string;
  strategyName: string;
  instrumentKey: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  overallPerformance: PerformanceMetricsDto;
  directionalRegimePerformance: Record<
    DirectionalMarketRegime,
    RegimePerformanceDto<DirectionalMarketRegime>
  >;
  volatilityRegimePerformance: Record<
    VolatilityMarketRegime,
    RegimePerformanceDto<VolatilityMarketRegime>
  >;
  bestDirectionalRegime: DirectionalMarketRegime | null;
  worstDirectionalRegime: DirectionalMarketRegime | null;
  bestVolatilityRegime: VolatilityMarketRegime | null;
  worstVolatilityRegime: VolatilityMarketRegime | null;
}
