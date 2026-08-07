import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';
import AtrIndicator from './atr.indicator';

export enum SuperTrendDirection {
  UP = 'UP',
  DOWN = 'DOWN',
}

export interface SuperTrendConfig extends IndicatorConfig {
  type: IndicatorType.SUPER_TREND;
  period: number;
  multiplier: number;
}

export interface SuperTrendValue {
  supertrend: number;
  trend: SuperTrendDirection;
  upperBand: number;
  lowerBand: number;
}

export interface SuperTrendResult extends IndicatorResult<SuperTrendValue> {
  type: IndicatorType.SUPER_TREND;
  period: number;
  multiplier: number;
}

interface BandState {
  upperBand: number;
  lowerBand: number;
  supertrend: number;
  trend: SuperTrendDirection;
}

export default class SuperTrendIndicator
  implements Indicator<SuperTrendConfig, SuperTrendResult>
{
  private readonly atrIndicator = new AtrIndicator();

  calculate(candles: readonly Candle[], config: SuperTrendConfig): SuperTrendResult {
    this.validateConfig(config);

    if (candles.length < config.period) {
      throw new Error(`SuperTrend requires at least ${config.period} candles.`);
    }

    candles.forEach((candle) => this.validateCandle(candle));

    const atrResult = this.atrIndicator.calculate(candles, {
      type: IndicatorType.ATR,
      period: config.period,
    });
    const candleOffset = config.period - 1;
    let previousState: BandState | undefined;

    const values: SuperTrendResult['values'] = atrResult.values.map((atrEntry, index) => {
      const candle = candles[candleOffset + index];
      const previousCandle = index > 0 ? candles[candleOffset + index - 1] : undefined;
      const hl2 = (candle.high + candle.low) / 2;
      const basicUpperBand = hl2 + config.multiplier * atrEntry.value;
      const basicLowerBand = hl2 - config.multiplier * atrEntry.value;
      const currentState = this.calculateBandState(
        candle.close,
        previousCandle?.close,
        basicUpperBand,
        basicLowerBand,
        previousState
      );

      previousState = currentState;

      return {
        timestamp: candle.timestamp,
        supertrend: currentState.supertrend,
        trend: currentState.trend,
        upperBand: currentState.upperBand,
        lowerBand: currentState.lowerBand,
      };
    });

    return {
      type: IndicatorType.SUPER_TREND,
      period: config.period,
      multiplier: config.multiplier,
      values,
    };
  }

  private calculateBandState(
    close: number,
    previousClose: number | undefined,
    basicUpperBand: number,
    basicLowerBand: number,
    previousState: BandState | undefined
  ): BandState {
    if (!previousState || previousClose === undefined) {
      return {
        upperBand: basicUpperBand,
        lowerBand: basicLowerBand,
        supertrend: basicUpperBand,
        trend: SuperTrendDirection.DOWN,
      };
    }

    const upperBand =
      basicUpperBand < previousState.upperBand || previousClose > previousState.upperBand
        ? basicUpperBand
        : previousState.upperBand;
    const lowerBand =
      basicLowerBand > previousState.lowerBand || previousClose < previousState.lowerBand
        ? basicLowerBand
        : previousState.lowerBand;
    const trend = this.calculateTrend(close, upperBand, lowerBand, previousState.trend);

    return {
      upperBand,
      lowerBand,
      supertrend: trend === SuperTrendDirection.UP ? lowerBand : upperBand,
      trend,
    };
  }

  private calculateTrend(
    close: number,
    upperBand: number,
    lowerBand: number,
    previousTrend: SuperTrendDirection
  ): SuperTrendDirection {
    if (previousTrend === SuperTrendDirection.DOWN) {
      return close > upperBand ? SuperTrendDirection.UP : SuperTrendDirection.DOWN;
    }

    return close < lowerBand ? SuperTrendDirection.DOWN : SuperTrendDirection.UP;
  }

  private validateConfig(config: SuperTrendConfig): void {
    if (!Number.isInteger(config.period) || config.period <= 0) {
      throw new Error('SuperTrend period must be a positive integer.');
    }

    if (!Number.isFinite(config.multiplier) || config.multiplier <= 0) {
      throw new Error('SuperTrend multiplier must be a positive finite number.');
    }
  }

  private validateCandle(candle: Candle): void {
    if (
      !(candle.timestamp instanceof Date) ||
      Number.isNaN(candle.timestamp.getTime()) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < candle.low
    ) {
      throw new Error('SuperTrend received an invalid candle.');
    }
  }
}
