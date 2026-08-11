export type TrendResearchDirection = 'DOWN' | 'UP';
export type TrendDirectionalRsiFilter = 'NO_RSI_FILTER' | 'RSI_LT_50' | 'RSI_LT_45' | 'RSI_LT_40' | 'RSI_LT_35' | 'RSI_GT_50' | 'RSI_GT_55' | 'RSI_GT_60' | 'RSI_GT_65';

export interface TrendDirectionalEma35PullbackInput {
  direction: TrendResearchDirection;
  close: number;
  high: number;
  low: number;
  ema35: number;
  rsi: number;
  proximity: number;
  rsiFilter: TrendDirectionalRsiFilter;
}

export function matchesTrendDirectionalEma35Pullback(input: TrendDirectionalEma35PullbackInput): boolean {
  const threshold = input.rsiFilter === 'NO_RSI_FILTER' ? undefined : Number(input.rsiFilter.replace('RSI_LT_', '').replace('RSI_GT_', ''));
  if (input.direction === 'DOWN') {
    const highDistance = Math.abs(input.high - input.ema35) / input.ema35 * 100;
    return input.close < input.ema35 && highDistance <= input.proximity && (threshold === undefined || input.rsi < threshold);
  }
  const lowDistance = Math.abs(input.low - input.ema35) / input.ema35 * 100;
  return input.close > input.ema35 && lowDistance <= input.proximity && (threshold === undefined || input.rsi > threshold);
}
