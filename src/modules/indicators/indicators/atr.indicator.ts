import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

export interface AtrConfig extends IndicatorConfig {
  type: IndicatorType.ATR;
  period: number;
}

export interface AtrResult extends IndicatorResult<number> {
  type: IndicatorType.ATR;
  period: number;
}

export default class AtrIndicator implements Indicator<AtrConfig, AtrResult> {
  calculate(candles: readonly Candle[], config: AtrConfig): AtrResult {
    this.validatePeriod(config.period);

    if (candles.length < config.period) {
      throw new Error(`ATR requires at least ${config.period} candles.`);
    }

    const trueRanges = candles.map((candle, index) => {
      this.validateCandle(candle);
      const previousClose = index > 0 ? candles[index - 1].close : undefined;

      return this.calculateTrueRange(candle, previousClose);
    });
    const values: AtrResult['values'] = [];
    let currentAtr = trueRanges.slice(0, config.period).reduce((total, range) => total + range, 0);
    currentAtr /= config.period;

    values.push({
      timestamp: candles[config.period - 1].timestamp,
      value: currentAtr,
    });

    for (let index = config.period; index < candles.length; index += 1) {
      currentAtr = (currentAtr * (config.period - 1) + trueRanges[index]) / config.period;
      values.push({
        timestamp: candles[index].timestamp,
        value: currentAtr,
      });
    }

    return {
      type: IndicatorType.ATR,
      period: config.period,
      values,
    };
  }

  private calculateTrueRange(candle: Candle, previousClose: number | undefined): number {
    const highLowRange = candle.high - candle.low;
    if (previousClose === undefined) {
      return highLowRange;
    }

    return Math.max(
      highLowRange,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  }

  private validateCandle(candle: Candle): void {
    if (
      Number.isNaN(candle.timestamp.getTime()) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < candle.low
    ) {
      throw new Error('ATR received an invalid candle.');
    }
  }

  private validatePeriod(period: number): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('ATR period must be a positive integer.');
    }
  }
}
