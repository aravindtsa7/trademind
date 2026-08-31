import { DatasetHealthStatus } from './dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

/**
 * B-F2C invariant 2 (crash-truthful retrieval lifecycle) for one LOGICAL
 * provider request (e.g. one monthly chunk) -- never one row per internal
 * HTTP retry attempt. Created as `STARTED` BEFORE the provider is ever
 * called; a crash before the next transition leaves a truthful `STARTED`
 * row, never a fabricated accepted claim.
 */
export enum HistoricalDataRetrievalStatus {
  /** Durable evidence exists; the provider has not been called yet (or its response has not yet been recorded). */
  STARTED = 'STARTED',
  /** The provider call succeeded and returned rows; per-date session evidence may still be in progress. */
  FETCHED = 'FETCHED',
  /** Every date this retrieval covered reached a clean, persistable outcome (no conflict/invalid/incomplete date). */
  PROCESSED = 'PROCESSED',
  /** The provider call succeeded, but at least one date reached CONFLICT/INVALID/INCOMPLETE -- never silently folded into PROCESSED. */
  COMPLETED_WITH_ISSUES = 'COMPLETED_WITH_ISSUES',
  /** The provider call itself failed (timeout/retry-exhaustion/permanent error) -- never ACCEPTED, per invariant 14. */
  FAILED = 'FAILED',
}

/**
 * Per-trading-date persistence outcome, kept deliberately distinct from
 * `NiftySessionAcquisitionBucket` (the caller-facing acquisition result
 * bucket) -- this is the durable evidence-table vocabulary. `CONFLICT` is
 * never collapsed into `INCOMPLETE`/`INVALID` (task requirement: "a
 * conflict is materially different and must be explicit").
 */
export enum HistoricalCandleSessionPersistenceOutcome {
  ACCEPTED_NEW = 'ACCEPTED_NEW',
  ACCEPTED_IDEMPOTENT = 'ACCEPTED_IDEMPOTENT',
  INCOMPLETE = 'INCOMPLETE',
  INVALID = 'INVALID',
  CONFLICT = 'CONFLICT',
  /** The provider chunk succeeded, but this specific fetch-eligible date had zero rows in the response (mirrors the acquisition-level UNRESOLVED_NO_DATA bucket, kept as a distinct evidence-table value). */
  NO_PROVIDER_DATA_FOR_DATE = 'NO_PROVIDER_DATA_FOR_DATE',
}

export enum HistoricalDataRetrievalErrorCategory {
  PERMANENT = 'PERMANENT',
  RETRY_EXHAUSTED = 'RETRY_EXHAUSTED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * B-F2C invariant 13 ("stable SEMANTIC evidence checksum/identity, not
 * random attempt IDs or wall-clock timestamps"): every field here is a
 * DETERMINISTIC fact about what was observed for one trading date --
 * deliberately excludes the session evidence row's own `id`, its parent
 * `retrievalId`, and `createdAt`/`updatedAt`, so two semantically-identical
 * retrievals (same provider content, re-fetched later) produce the
 * IDENTICAL checksum despite different wall-clock timestamps/random IDs.
 */
export const EVIDENCE_SEMANTIC_CHECKSUM_VERSION = 1;

export interface EvidenceSemanticChecksumInput {
  readonly providerId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly expectedMinuteCount: number;
  readonly providerRowCountForDate: number;
  readonly acceptedRowCount: number;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly healthStatus: DatasetHealthStatus;
  readonly persistenceOutcome: HistoricalCandleSessionPersistenceOutcome;
  readonly sourceRowsSemanticChecksum: string | null;
  readonly canonicalContentChecksum: string | null;
}

export function computeEvidenceSemanticChecksum(input: EvidenceSemanticChecksumInput): string {
  return sha256Hex(canonicalManifestJson({ version: EVIDENCE_SEMANTIC_CHECKSUM_VERSION, ...input }));
}
