export interface HistoricalCandleSyncSummary {
  instrumentKey: string;
  timeframe: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  downloaded: number;
  inserted: number;
  updated: number;
}
