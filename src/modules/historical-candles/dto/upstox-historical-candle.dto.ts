export type UpstoxHistoricalCandleRow = [
  string,
  number,
  number,
  number,
  number,
  number,
  number?
];

export interface UpstoxHistoricalCandleApiResponseDto {
  status: string;
  data: {
    candles: UpstoxHistoricalCandleRow[];
  };
}

export interface UpstoxHistoricalCandleDto {
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  openInterest?: bigint;
}
