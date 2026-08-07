import { Indicator } from '../interfaces/indicator.interface';
import { Candle, IndicatorConfig, IndicatorResult, IndicatorType } from '../types';
import EmaIndicator from './ema.indicator';

export interface MacdConfig extends IndicatorConfig {
  type: IndicatorType.MACD;
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

export interface MacdResult extends IndicatorResult<MacdValue> {
  type: IndicatorType.MACD;
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export default class MacdIndicator implements Indicator<MacdConfig, MacdResult> {
  private readonly emaIndicator = new EmaIndicator();

  calculate(candles: readonly Candle[], config: MacdConfig): MacdResult {
    this.validateConfig(config);

    const minimumCandleCount = config.slowPeriod + config.signalPeriod - 1;
    if (candles.length < minimumCandleCount) {
      throw new Error(`MACD requires at least ${minimumCandleCount} candles.`);
    }

    const fastEma = this.emaIndicator.calculate(candles, {
      type: IndicatorType.EMA,
      period: config.fastPeriod,
    });
    const slowEma = this.emaIndicator.calculate(candles, {
      type: IndicatorType.EMA,
      period: config.slowPeriod,
    });
    const fastEmaOffset = config.slowPeriod - config.fastPeriod;
    const macdLine = slowEma.values.map((slowEntry, index) => ({
      timestamp: slowEntry.timestamp,
      value: fastEma.values[fastEmaOffset + index].value - slowEntry.value,
    }));

    const signalEma = this.emaIndicator.calculate(
      macdLine.map((entry) => ({
        timestamp: entry.timestamp,
        open: entry.value,
        high: entry.value,
        low: entry.value,
        close: entry.value,
        volume: 0,
      })),
      { type: IndicatorType.EMA, period: config.signalPeriod }
    );
    const signalOffset = config.signalPeriod - 1;

    return {
      type: IndicatorType.MACD,
      fastPeriod: config.fastPeriod,
      slowPeriod: config.slowPeriod,
      signalPeriod: config.signalPeriod,
      values: signalEma.values.map((signalEntry, index) => {
        const macd = macdLine[signalOffset + index].value;
        const signal = signalEntry.value;

        return {
          timestamp: signalEntry.timestamp,
          macd,
          signal,
          histogram: macd - signal,
        };
      }),
    };
  }

  private validateConfig(config: MacdConfig): void {
    this.validatePeriod(config.fastPeriod, 'fastPeriod');
    this.validatePeriod(config.slowPeriod, 'slowPeriod');
    this.validatePeriod(config.signalPeriod, 'signalPeriod');

    if (config.fastPeriod >= config.slowPeriod) {
      throw new Error('MACD fastPeriod must be less than slowPeriod.');
    }
  }

  private validatePeriod(period: number, name: string): void {
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`MACD ${name} must be a positive integer.`);
    }
  }
}
