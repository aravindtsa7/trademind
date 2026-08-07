import { CandleTimeframe } from '../../indicators/types/timeframe.types';
import {
  IndicatorEngineResult,
  SupportedIndicatorConfig,
} from '../../indicators/services/indicator-engine.service';
import { Candle } from '../../indicators/types';
import { Strategy } from '../../strategies/interfaces/strategy.interface';
import { StrategySignalDto } from '../../strategies/dto/strategy-signal.dto';
import { MarketRegimeAnalyzerConfig } from '../types/market-regime.types';
import { RegimeSignalPerformanceResultDto, RegimeStrategyReportDto } from './regime-strategy-report.dto';
import { StrategyReportDto } from './strategy-report.dto';

export interface ResearchStrategyContext {
  candle: Candle;
  candleIndex: number;
  candles: readonly Candle[];
  indicatorResults: IndicatorEngineResult;
}

export interface ResearchRunConfig<TStrategyInput> {
  strategy: Strategy<TStrategyInput>;
  strategyName: string;
  instrumentKey: string;
  timeframe: CandleTimeframe;
  fromDate: string;
  toDate: string;
  indicatorRequests: readonly SupportedIndicatorConfig[];
  marketRegimeConfig: MarketRegimeAnalyzerConfig;
  createStrategyInput: (context: ResearchStrategyContext) => TStrategyInput;
}

export interface ResearchSignalOutcomeDto extends RegimeSignalPerformanceResultDto {
  timestamp: Date;
  strategyId: string;
  strategyName: string;
  confidence: number;
  reasons: string[];
  signalClose: number;
}

export interface ResearchRunResult {
  strategyId: string;
  strategyName: string;
  instrumentKey: string;
  timeframe: CandleTimeframe;
  fromDate: string;
  toDate: string;
  sessionCount: number;
  candleCount: number;
  totalRawEvaluations: number;
  emittedSignals: number;
  signalOutcomes: ResearchSignalOutcomeDto[];
  strategyReport: StrategyReportDto;
  regimeStrategyReport: RegimeStrategyReportDto;
  generatedAt: Date;
}
