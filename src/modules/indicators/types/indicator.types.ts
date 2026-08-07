export enum IndicatorType {
  EMA = 'EMA',
  SMA = 'SMA',
  RSI = 'RSI',
  VWAP = 'VWAP',
  MACD = 'MACD',
  ATR = 'ATR',
  ADX = 'ADX',
  SUPER_TREND = 'SUPER_TREND',
  BOLLINGER_BANDS = 'BOLLINGER_BANDS',
}

export interface IndicatorConfig {
  type: IndicatorType;
}

export interface TimestampedIndicatorValue {
  timestamp: Date;
}

export type IndicatorValue<TValue> = TValue extends object
  ? TimestampedIndicatorValue & TValue
  : TimestampedIndicatorValue & {
      value: TValue;
    };

export interface IndicatorResultBase {
  type: IndicatorType;
  values: TimestampedIndicatorValue[];
}

export interface IndicatorResult<TValue = number> extends IndicatorResultBase {
  values: Array<IndicatorValue<TValue>>;
}
