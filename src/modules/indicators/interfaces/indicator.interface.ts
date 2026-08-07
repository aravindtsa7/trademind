import { Candle, IndicatorConfig, IndicatorResult, IndicatorResultBase } from '../types';

export interface Indicator<
  TConfig extends IndicatorConfig = IndicatorConfig,
  TResult extends IndicatorResultBase = IndicatorResult
> {
  calculate(candles: readonly Candle[], config: TConfig): TResult;
}
