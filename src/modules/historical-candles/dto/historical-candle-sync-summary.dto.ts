export interface HistoricalCandleSyncSummary {
  instrumentKey: string;
  timeframe: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  downloaded: number;
  inserted: number;
  updated: number;
  /**
   * Present only when `sync()` was called with `options.tradingDates`: the
   * dates that were fetched/upserted and verified complete against the
   * historical session completeness contract after persistence.
   */
  reconciledDates?: string[];
  /**
   * Present only when `sync()` was called with `options.tradingDates`: the
   * requested dates that were already complete and therefore never
   * re-fetched from the broker.
   */
  skippedCompleteDates?: string[];
}
