import { Candle } from '../../indicators';
import { IndicatorEngineRequest, IndicatorEngineResult } from '../../indicators/services/indicator-engine.service';
import { OptionContract } from '../../options/types';
import { StrategySignal, StrategySignalDto } from '../../strategies/dto/strategy-signal.dto';
import { PaperTradingOrchestrationResult } from './paper-trading-orchestrator.dto';

export interface LivePaperCompletedCandleInput {
  candle: Candle;
  completed: boolean;
  contracts: readonly OptionContract[];
}

export interface LivePaperStrategyResult {
  candleTimestamp: Date;
  spotPrice: number;
  ema15: number | null;
  ema35: number | null;
  rsi14: number | null;
  rawEmaSignal: StrategySignal;
  timeFilterAllowed: boolean;
  finalSignal: StrategySignal;
  orchestration?: PaperTradingOrchestrationResult;
  reasons: string[];
  processed: boolean;
}

export interface LivePaperIndicatorEngine {
  calculate(candles: readonly Candle[], request: IndicatorEngineRequest): IndicatorEngineResult;
}

export interface LivePaperEmaCrossStrategy {
  evaluate(input: unknown): StrategySignalDto;
}

export interface LivePaperOrchestrator {
  createFromSignal(input: {
    signal: { signalTimestamp: Date; signalType: StrategySignal; underlying: string; spotPrice: number };
    contracts: readonly OptionContract[];
    exitPolicy: { targetPercent: number; stopLossPercent: number; maximumHoldingMinutes: number };
  }): Promise<PaperTradingOrchestrationResult>;
}
