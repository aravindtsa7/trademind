export interface ExpiredOptionCandleDto {
  instrumentKey: string;
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  openInterest?: bigint;
}

export type UpstoxExpiredOptionCandleRow = [
  candleTime: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  openInterest?: number,
];

export interface UpstoxExpiredOptionCandleApiResponseDto {
  status: string;
  data: {
    candles: UpstoxExpiredOptionCandleRow[];
  };
}
