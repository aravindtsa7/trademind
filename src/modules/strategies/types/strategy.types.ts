import { StrategySignalDto } from '../dto/strategy-signal.dto';

export type StrategyId = string;

export interface StrategyExecutionResult<TSignal extends StrategySignalDto = StrategySignalDto> {
  strategyId: StrategyId;
  result: TSignal;
}

export interface StrategyExecutionResults<TSignal extends StrategySignalDto = StrategySignalDto> {
  results: StrategyExecutionResult<TSignal>[];
}
