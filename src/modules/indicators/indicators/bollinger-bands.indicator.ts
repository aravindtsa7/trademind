import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';
import SmaIndicator from './sma.indicator';

export interface BollingerBandsConfig extends IndicatorConfig {
  type: IndicatorType.BOLLINGER_BANDS;
  period: number;
  standardDeviationMultiplier: number;
}

export interface BollingerBandsValue {
  middle: number;
  upper: number;
  lower: number;
  standardDeviation: number;
}

export interface BollingerBandsResult extends IndicatorResult<BollingerBandsValue> {
  type: IndicatorType.BOLLINGER_BANDS;
  period: number;
  standardDeviationMultiplier: number;
}

export default class BollingerBandsIndicator
  implements Indicator<BollingerBandsConfig, BollingerBandsResult>
{
  private readonly smaIndicator = new SmaIndicator();

  calculate(candles: readonly Candle[], config: BollingerBandsConfig): BollingerBandsResult {
    this.validateConfig(config);

    if (candles.length < config.period) {
      throw new Error(`Bollinger Bands requires at least ${config.period} candles.`);
    }

    candles.forEach((candle, index) => {
      if (!Number.isFinite(candle.close)) {
        throw new Error(`Bollinger Bands candle close at index ${index} must be finite.`);
      }
    });

    const smaResult = this.smaIndicator.calculate(candles, {
      type: IndicatorType.SMA,
      period: config.period,
    });

    return {
      type: IndicatorType.BOLLINGER_BANDS,
      period: config.period,
      standardDeviationMultiplier: config.standardDeviationMultiplier,
      values: smaResult.values.map((smaEntry, resultIndex) => {
        const windowStart = resultIndex;
        const closeWindow = candles.slice(windowStart, windowStart + config.period);
        const standardDeviation = this.calculatePopulationStandardDeviation(
          closeWindow.map((candle) => candle.close),
          smaEntry.value
        );
        const bandOffset = standardDeviation * config.standardDeviationMultiplier;

        return {
          timestamp: smaEntry.timestamp,
          middle: smaEntry.value,
          upper: smaEntry.value + bandOffset,
          lower: smaEntry.value - bandOffset,
          standardDeviation,
        };
      }),
    };
  }

  private calculatePopulationStandardDeviation(values: readonly number[], mean: number): number {
    const squaredDifferenceSum = values.reduce(
      (total, value) => total + (value - mean) ** 2,
      0
    );

    return Math.sqrt(squaredDifferenceSum / values.length);
  }

  private validateConfig(config: BollingerBandsConfig): void {
    if (!Number.isInteger(config.period) || config.period <= 0) {
      throw new Error('Bollinger Bands period must be a positive integer.');
    }

    if (
      !Number.isFinite(config.standardDeviationMultiplier) ||
      config.standardDeviationMultiplier <= 0
    ) {
      throw new Error(
        'Bollinger Bands standardDeviationMultiplier must be a positive finite number.'
      );
    }
  }
}
