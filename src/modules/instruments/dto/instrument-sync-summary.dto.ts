export interface InstrumentSyncSummary {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  downloaded: number;
  filtered: number;
  inserted: number;
  updated: number;
  inactivated: number;
}
