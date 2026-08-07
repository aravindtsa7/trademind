import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';

const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface VwapConfig extends IndicatorConfig {
  type: IndicatorType.VWAP;
}

export interface VwapResult extends IndicatorResult<number | null> {
  type: IndicatorType.VWAP;
}

export default class VwapIndicator implements Indicator<VwapConfig, VwapResult> {
  calculate(candles: readonly Candle[], _config: VwapConfig): VwapResult {
    const values: VwapResult['values'] = [];
    let currentMarketDate: string | undefined;
    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;

    candles.forEach((candle) => {
      this.validateCandle(candle);

      const marketDate = this.getMarketDate(candle.timestamp);
      if (marketDate !== currentMarketDate) {
        currentMarketDate = marketDate;
        cumulativeTypicalPriceVolume = 0;
        cumulativeVolume = 0;
      }

      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTypicalPriceVolume += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;

      values.push({
        timestamp: candle.timestamp,
        value: cumulativeVolume === 0 ? null : cumulativeTypicalPriceVolume / cumulativeVolume,
      });
    });

    return {
      type: IndicatorType.VWAP,
      values,
    };
  }

  private validateCandle(candle: Candle): void {
    if (
      Number.isNaN(candle.timestamp.getTime()) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      !Number.isFinite(candle.volume) ||
      candle.volume < 0 ||
      candle.high < candle.low
    ) {
      throw new Error('VWAP received an invalid candle.');
    }
  }

  private getMarketDate(timestamp: Date): string {
    const values = Object.fromEntries(
      marketDateFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }
}
