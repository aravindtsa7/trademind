export type PerformanceSignal = 'BUY_CE' | 'BUY_PE';

export interface SignalPerformanceResultDto {
  signal: PerformanceSignal;
  directionalPoints: {
    '5m': number | null;
    '15m': number | null;
    '30m': number | null;
    '60m': number | null;
  };
  mfe: number | null;
  mae: number | null;
}

export interface PerformanceMetricsDto {
  totalSignals: number;
  evaluableSignals: number;
  buyCeSignals: number;
  buyPeSignals: number;
  correct5m: number;
  correct15m: number;
  correct30m: number;
  correct60m: number;
  accuracy5m: number;
  accuracy15m: number;
  accuracy30m: number;
  accuracy60m: number;
  avg5m: number;
  avg15m: number;
  avg30m: number;
  avg60m: number;
  avgMFE: number;
  avgMAE: number;
}
