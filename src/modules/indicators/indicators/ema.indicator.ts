import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

export interface EmaConfig extends IndicatorConfig {
  type: IndicatorType.EMA;
  period: number;
}

export interface EmaResult extends IndicatorResult<number> {
  type: IndicatorType.EMA;
  period: number;
}

export default class EmaIndicator implements Indicator<EmaConfig, EmaResult> {
  calculate(candles: readonly Candle[], config: EmaConfig): EmaResult {
    this.validatePeriod(config.period);

    if (candles.length < config.period) {
      throw new Error(`EMA requires at least ${config.period} candles.`);
    }

    const values: EmaResult['values'] = [];
    const multiplier = 2 / (config.period + 1);
    let currentEma = this.calculateSeed(candles, config.period);

    values.push({
      timestamp: candles[config.period - 1].timestamp,
      value: currentEma,
    });

    for (let index = config.period; index < candles.length; index += 1) {
      currentEma = (candles[index].close - currentEma) * multiplier + currentEma;
      values.push({
        timestamp: candles[index].timestamp,
        value: currentEma,
      });
    }

    return {
      type: IndicatorType.EMA,
      period: config.period,
      values,
    };
  }

  private calculateSeed(candles: readonly Candle[], period: number): number {
    const closeSum = candles
      .slice(0, period)
      .reduce((total, candle) => total + candle.close, 0);

    return closeSum / period;
  }

  private validatePeriod(period: number): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('EMA period must be a positive integer.');
    }
  }
}
