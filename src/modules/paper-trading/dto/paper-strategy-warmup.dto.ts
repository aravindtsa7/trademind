import { Candle } from '../../indicators/types';

export const paperStrategyWarmupInstrumentKey = 'NSE_INDEX|Nifty 50';
export const paperStrategyWarmupTimeframe = '1minute';
export const minimumLivePaperStrategyCandles = 36;
export const preferredLivePaperStrategyCandles = 50;

export interface HistoricalCandleWarmupRecord {
  candleTime: Date;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
  openInterest?: unknown;
}

export interface PaperStrategyWarmupRepository {
  findByInstrumentAndTimeframe(
    instrumentKey: string,
    timeframe: string
  ): Promise<readonly HistoricalCandleWarmupRecord[]>;
}

export interface PaperStrategyWarmupTarget {
  seedHistoricalCandles(candles: readonly Candle[]): void;
  isWarmupReady(): boolean;
}

export interface PaperStrategyWarmupOptions {
  minimumFiveMinuteCandles?: number;
  preferredFiveMinuteCandles?: number;
}

export interface PaperStrategyWarmupResult {
  instrumentKey: string;
  requestedMinimumCandles: number;
  oneMinuteCandlesLoaded: number;
  fiveMinuteCandlesProduced: number;
  firstFiveMinuteTimestamp: Date;
  lastFiveMinuteTimestamp: Date;
  warmupReady: boolean;
}
