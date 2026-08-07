import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

export interface RsiConfig extends IndicatorConfig {
  type: IndicatorType.RSI;
  period: number;
}

export interface RsiResult extends IndicatorResult<number> {
  type: IndicatorType.RSI;
  period: number;
}

export default class RsiIndicator implements Indicator<RsiConfig, RsiResult> {
  calculate(candles: readonly Candle[], config: RsiConfig): RsiResult {
    this.validatePeriod(config.period);

    if (candles.length < config.period + 1) {
      throw new Error(`RSI requires at least ${config.period + 1} candles.`);
    }

    const values: RsiResult['values'] = [];
    let averageGain = 0;
    let averageLoss = 0;

    for (let index = 1; index <= config.period; index += 1) {
      const { gain, loss } = this.getGainAndLoss(candles[index].close - candles[index - 1].close);
      averageGain += gain;
      averageLoss += loss;
    }

    averageGain /= config.period;
    averageLoss /= config.period;
    values.push({
      timestamp: candles[config.period].timestamp,
      value: this.calculateRsi(averageGain, averageLoss),
    });

    for (let index = config.period + 1; index < candles.length; index += 1) {
      const { gain, loss } = this.getGainAndLoss(candles[index].close - candles[index - 1].close);
      averageGain = (averageGain * (config.period - 1) + gain) / config.period;
      averageLoss = (averageLoss * (config.period - 1) + loss) / config.period;

      values.push({
        timestamp: candles[index].timestamp,
        value: this.calculateRsi(averageGain, averageLoss),
      });
    }

    return {
      type: IndicatorType.RSI,
      period: config.period,
      values,
    };
  }

  private getGainAndLoss(change: number): { gain: number; loss: number } {
    return {
      gain: change > 0 ? change : 0,
      loss: change < 0 ? Math.abs(change) : 0,
    };
  }

  private calculateRsi(averageGain: number, averageLoss: number): number {
    if (averageLoss === 0 && averageGain > 0) {
      return 100;
    }

    if (averageGain === 0 && averageLoss > 0) {
      return 0;
    }

    if (averageGain === 0 && averageLoss === 0) {
      return 50;
    }

    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  }

  private validatePeriod(period: number): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('RSI period must be a positive integer.');
    }
  }
}
