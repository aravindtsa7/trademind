export const marketReplaySchemaVersion = 1;
export type MarketReplayEventType = 'TICK'|'DEPTH'|'CONNECTION_STATE'|'DISCONNECT'|'RECONNECT'|'SUBSCRIPTION_RESTORED'|'SUBSCRIPTION_INTENT'|'BACKFILL_STARTED'|'BACKFILL_COMPLETED'|'FRESH_TICK_READY'|'EOD';
export interface MarketReplayEventEnvelope { schemaVersion: number; eventId: string; eventType: MarketReplayEventType; instrumentKey: string | null; sourceTimestamp: string | null; receivedTimestamp: string; sequenceNumber: number | null; connectionGenerationId: number | null; runtimeId: string; sessionId: string; payload: Readonly<Record<string, unknown>>; }
export interface MarketReplayResult { sourceFingerprint: string; eventCounts: Record<string, number>; candleCounts: Record<string, number>; duplicateEvents: number; outOfOrderEvents: number; v2Evaluations: number; v2Signals: number; v4Evaluations: number; v4Signals: number; v8Evaluations: number; v8Signals: number; riskApprovals: number; riskDenials: number; paperOutcomes: number; shadowOutcomes: number; reconnects: number; eodEvents: number; outputDigest: string; dataQualityWarnings: string[]; firstDivergence?: { eventIndex: number; component: string; expected: string; actual: string; }; }

/** Optional result emitted by a real strategy adapter supplied to the replay harness. */
export interface MarketReplayStrategyOutput {
  strategy: 'V2' | 'V4' | 'V8' | 'V12';
  evaluated?: number;
  signals?: number;
  riskDecision?: 'APPROVED' | 'DENIED';
  paperOutcome?: boolean;
  shadowOutcome?: boolean;
  subscriptionIntent?: string;
}
