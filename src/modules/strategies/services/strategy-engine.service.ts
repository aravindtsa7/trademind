import { StrategySignalDto } from '../dto/strategy-signal.dto';
import { Strategy } from '../interfaces/strategy.interface';
import { StrategyExecutionResult, StrategyExecutionResults, StrategyId } from '../types';

export default class StrategyEngineService<TInput = unknown> {
  private readonly strategies = new Map<StrategyId, Strategy<TInput>>();

  register<TResult extends StrategySignalDto>(strategy: Strategy<TInput, TResult>): void {
    if (this.strategies.has(strategy.id)) {
      throw new Error(`A strategy is already registered with id: ${strategy.id}`);
    }

    this.strategies.set(strategy.id, strategy);
  }

  execute(strategyId: StrategyId, input: TInput): StrategyExecutionResult {
    const strategy = this.strategies.get(strategyId);

    if (!strategy) {
      throw new Error(`No strategy is registered with id: ${strategyId}`);
    }

    return {
      strategyId,
      result: strategy.evaluate(input),
    };
  }

  executeAll(input: TInput): StrategyExecutionResults {
    return {
      results: Array.from(this.strategies.values()).map((strategy) => ({
        strategyId: strategy.id,
        result: strategy.evaluate(input),
      })),
    };
  }
}
