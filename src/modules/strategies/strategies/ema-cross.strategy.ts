import { EmaResult } from '../../indicators/indicators/ema.indicator';
import { StrategySignal, StrategySignalDto } from '../dto/strategy-signal.dto';
import { Strategy } from '../interfaces/strategy.interface';

export interface EmaCrossStrategyConfig {
  fastPeriod: number;
  slowPeriod: number;
}

export interface EmaCrossStrategyInput {
  fastEma: EmaResult;
  slowEma: EmaResult;
}

interface EmaComparisonPoint {
  timestamp: Date;
  fast: number;
  slow: number;
}

export default class EmaCrossStrategy implements Strategy<EmaCrossStrategyInput> {
  readonly id = 'ema-cross';

  private readonly config: EmaCrossStrategyConfig;

  constructor(config: EmaCrossStrategyConfig = { fastPeriod: 20, slowPeriod: 50 }) {
    this.validateConfig(config);
    this.config = { ...config };
  }

  evaluate(input: EmaCrossStrategyInput): StrategySignalDto {
    this.validateEmaPeriods(input);

    const [previous, current] = this.getComparisonPoints(input);

    if (previous.fast <= previous.slow && current.fast > current.slow) {
      return {
        signal: StrategySignal.BUY_CE,
        confidence: 60,
        reasons: [
          `EMA ${this.config.fastPeriod} crossed above EMA ${this.config.slowPeriod} at ${current.timestamp.toISOString()}.`,
        ],
      };
    }

    if (previous.fast >= previous.slow && current.fast < current.slow) {
      return {
        signal: StrategySignal.BUY_PE,
        confidence: 60,
        reasons: [
          `EMA ${this.config.fastPeriod} crossed below EMA ${this.config.slowPeriod} at ${current.timestamp.toISOString()}.`,
        ],
      };
    }

    return {
      signal: StrategySignal.NO_TRADE,
      confidence: 0,
      reasons: [this.getNoTradeReason(current)],
    };
  }

  private getComparisonPoints(input: EmaCrossStrategyInput): [EmaComparisonPoint, EmaComparisonPoint] {
    if (input.fastEma.values.length < 2 || input.slowEma.values.length < 2) {
      throw new Error('EMA Cross requires at least two fast and slow EMA results.');
    }

    const fastValues = input.fastEma.values;
    const previousFast = fastValues[fastValues.length - 2];
    const currentFast = fastValues[fastValues.length - 1];
    this.validateEmaValue(previousFast.timestamp, previousFast.value);
    this.validateEmaValue(currentFast.timestamp, currentFast.value);

    if (currentFast.timestamp.getTime() <= previousFast.timestamp.getTime()) {
      throw new Error('EMA Cross requires chronologically ordered EMA results.');
    }

    const slowValuesByTimestamp = new Map(
      input.slowEma.values.map((entry) => [entry.timestamp.getTime(), entry])
    );
    const previousSlow = slowValuesByTimestamp.get(previousFast.timestamp.getTime());
    const currentSlow = slowValuesByTimestamp.get(currentFast.timestamp.getTime());

    if (!previousSlow || !currentSlow) {
      throw new Error('EMA Cross requires matching fast and slow EMA timestamps.');
    }

    this.validateEmaValue(previousSlow.timestamp, previousSlow.value);
    this.validateEmaValue(currentSlow.timestamp, currentSlow.value);

    return [
      {
        timestamp: previousFast.timestamp,
        fast: previousFast.value,
        slow: previousSlow.value,
      },
      {
        timestamp: currentFast.timestamp,
        fast: currentFast.value,
        slow: currentSlow.value,
      },
    ];
  }

  private getNoTradeReason(current: EmaComparisonPoint): string {
    if (current.fast > current.slow) {
      return `EMA ${this.config.fastPeriod} remains above EMA ${this.config.slowPeriod}; no new bullish crossover.`;
    }

    if (current.fast < current.slow) {
      return `EMA ${this.config.fastPeriod} remains below EMA ${this.config.slowPeriod}; no new bearish crossover.`;
    }

    return `EMA ${this.config.fastPeriod} equals EMA ${this.config.slowPeriod}; no crossover exists.`;
  }

  private validateConfig(config: EmaCrossStrategyConfig): void {
    if (!Number.isInteger(config.fastPeriod) || config.fastPeriod <= 0) {
      throw new Error('EMA Cross fastPeriod must be a positive integer.');
    }

    if (!Number.isInteger(config.slowPeriod) || config.slowPeriod <= 0) {
      throw new Error('EMA Cross slowPeriod must be a positive integer.');
    }

    if (config.fastPeriod >= config.slowPeriod) {
      throw new Error('EMA Cross fastPeriod must be less than slowPeriod.');
    }
  }

  private validateEmaPeriods(input: EmaCrossStrategyInput): void {
    if (input.fastEma.period !== this.config.fastPeriod || input.slowEma.period !== this.config.slowPeriod) {
      throw new Error('EMA Cross input EMA periods do not match the strategy configuration.');
    }
  }

  private validateEmaValue(timestamp: Date, value: number): void {
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime()) || !Number.isFinite(value)) {
      throw new Error('EMA Cross received an invalid EMA result value.');
    }
  }
}
