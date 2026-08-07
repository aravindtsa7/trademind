import { StrategySignalDto } from '../dto/strategy-signal.dto';
import { StrategyId } from '../types';

export interface Strategy<TInput, TResult extends StrategySignalDto = StrategySignalDto> {
  readonly id: StrategyId;
  evaluate(input: TInput): TResult;
}
