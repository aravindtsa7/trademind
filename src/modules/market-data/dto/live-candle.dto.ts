export type LiveCandleTimeframe = '1m' | '2m' | '3m' | '5m';

export interface NormalizedLiveTickDto {
  instrumentKey: string;
  timestamp: Date;
  ltp: number;
}

export interface LiveCandleDto {
  instrumentKey: string;
  timeframe: LiveCandleTimeframe;
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  completed: boolean;
}

export type LiveCandleTickIgnoreReason =
  | 'OUTSIDE_MARKET_SESSION'
  | 'DUPLICATE_TICK'
  | 'OUT_OF_ORDER_TICK'
  | 'BEFORE_LIVE_CONSTRUCTION_BOUNDARY'
  | 'AFTER_SOURCE_COMPLETION_BOUNDARY';

export interface LiveCandleProcessResult {
  completedCandle?: LiveCandleDto;
  activeCandle?: LiveCandleDto;
  ignored: boolean;
  ignoreReason?: LiveCandleTickIgnoreReason;
}
