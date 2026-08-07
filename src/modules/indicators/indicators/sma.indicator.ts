import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

export interface SmaConfig extends IndicatorConfig {
  type: IndicatorType.SMA;
  period: number;
}

export interface SmaResult extends IndicatorResult<number> {
  type: IndicatorType.SMA;
  period: number;
}

export default class SmaIndicator implements Indicator<SmaConfig, SmaResult> {
  calculate(candles: readonly Candle[], config: SmaConfig): SmaResult {
    this.validatePeriod(config.period);

    if (candles.length < config.period) {
      throw new Error(`SMA requires at least ${config.period} candles.`);
    }

    const values: SmaResult['values'] = [];
    let rollingCloseSum = 0;

    candles.forEach((candle, index) => {
      rollingCloseSum += candle.close;

      if (index >= config.period) {
        rollingCloseSum -= candles[index - config.period].close;
      }

      if (index >= config.period - 1) {
        values.push({
          timestamp: candle.timestamp,
          value: rollingCloseSum / config.period,
        });
      }
    });

    return {
      type: IndicatorType.SMA,
      period: config.period,
      values,
    };
  }

  private validatePeriod(period: number): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('SMA period must be a positive integer.');
    }
  }
}
