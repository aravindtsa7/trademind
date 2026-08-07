import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

export interface AdxConfig extends IndicatorConfig {
  type: IndicatorType.ADX;
  period: number;
}

export interface AdxValue {
  adx: number;
  plusDI: number;
  minusDI: number;
}

export interface AdxResult extends IndicatorResult<AdxValue> {
  type: IndicatorType.ADX;
  period: number;
}

interface DirectionalMovement {
  trueRange: number;
  plusDM: number;
  minusDM: number;
}

interface DxValue {
  timestamp: Date;
  dx: number;
  plusDI: number;
  minusDI: number;
}

export default class AdxIndicator implements Indicator<AdxConfig, AdxResult> {
  calculate(candles: readonly Candle[], config: AdxConfig): AdxResult {
    this.validatePeriod(config.period);

    const minimumCandleCount = config.period * 2 - 1;
    if (candles.length < minimumCandleCount) {
      throw new Error(`ADX requires at least ${minimumCandleCount} candles.`);
    }

    candles.forEach((candle) => this.validateCandle(candle));

    const directionalMovements = candles.map((candle, index) =>
      this.calculateDirectionalMovement(candle, index > 0 ? candles[index - 1] : undefined)
    );
    let smoothedTrueRange = this.sum(directionalMovements, 'trueRange', 0, config.period);
    let smoothedPlusDM = this.sum(directionalMovements, 'plusDM', 0, config.period);
    let smoothedMinusDM = this.sum(directionalMovements, 'minusDM', 0, config.period);
    const dxValues: DxValue[] = [
      this.calculateDxValue(
        candles[config.period - 1].timestamp,
        smoothedTrueRange,
        smoothedPlusDM,
        smoothedMinusDM
      ),
    ];

    for (let index = config.period; index < candles.length; index += 1) {
      const movement = directionalMovements[index];
      smoothedTrueRange = this.wilderSmooth(smoothedTrueRange, movement.trueRange, config.period);
      smoothedPlusDM = this.wilderSmooth(smoothedPlusDM, movement.plusDM, config.period);
      smoothedMinusDM = this.wilderSmooth(smoothedMinusDM, movement.minusDM, config.period);
      dxValues.push(
        this.calculateDxValue(
          candles[index].timestamp,
          smoothedTrueRange,
          smoothedPlusDM,
          smoothedMinusDM
        )
      );
    }

    let currentAdx = dxValues
      .slice(0, config.period)
      .reduce((total, value) => total + value.dx, 0) / config.period;
    const firstAdxDxIndex = config.period - 1;
    const values: AdxResult['values'] = [
      this.toAdxValue(dxValues[firstAdxDxIndex], currentAdx),
    ];

    for (let index = config.period; index < dxValues.length; index += 1) {
      currentAdx = this.wilderSmooth(currentAdx, dxValues[index].dx, config.period);
      values.push(this.toAdxValue(dxValues[index], currentAdx));
    }

    return {
      type: IndicatorType.ADX,
      period: config.period,
      values,
    };
  }

  private calculateDirectionalMovement(
    candle: Candle,
    previousCandle: Candle | undefined
  ): DirectionalMovement {
    if (!previousCandle) {
      return {
        trueRange: candle.high - candle.low,
        plusDM: 0,
        minusDM: 0,
      };
    }

    const upMove = candle.high - previousCandle.high;
    const downMove = previousCandle.low - candle.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    return {
      trueRange: this.calculateTrueRange(candle, previousCandle.close),
      plusDM,
      minusDM,
    };
  }

  private calculateTrueRange(candle: Candle, previousClose: number): number {
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  }

  private calculateDxValue(
    timestamp: Date,
    smoothedTrueRange: number,
    smoothedPlusDM: number,
    smoothedMinusDM: number
  ): DxValue {
    const plusDI = smoothedTrueRange === 0 ? 0 : (100 * smoothedPlusDM) / smoothedTrueRange;
    const minusDI = smoothedTrueRange === 0 ? 0 : (100 * smoothedMinusDM) / smoothedTrueRange;
    const directionalIndexSum = plusDI + minusDI;
    const dx = directionalIndexSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / directionalIndexSum;

    return { timestamp, dx, plusDI, minusDI };
  }

  private sum(
    movements: readonly DirectionalMovement[],
    field: keyof DirectionalMovement,
    start: number,
    count: number
  ): number {
    return movements
      .slice(start, start + count)
      .reduce((total, movement) => total + movement[field], 0);
  }

  private wilderSmooth(previousValue: number, currentValue: number, period: number): number {
    return ((previousValue * (period - 1)) + currentValue) / period;
  }

  private toAdxValue(dxValue: DxValue, adx: number): AdxResult['values'][number] {
    return {
      timestamp: dxValue.timestamp,
      adx,
      plusDI: dxValue.plusDI,
      minusDI: dxValue.minusDI,
    };
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
      throw new Error('ADX received an invalid candle.');
    }
  }

  private validatePeriod(period: number): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('ADX period must be a positive integer.');
    }
  }
}
