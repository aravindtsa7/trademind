import { HistoricalAssetType } from './historical-asset.types';
import { CanonicalSessionExclusion } from './canonical-session.types';

export enum DatasetHealthStatus {
  HEALTHY = 'HEALTHY',
  NORMALIZED_WITH_EXCLUSIONS = 'NORMALIZED_WITH_EXCLUSIONS',
  INCOMPLETE = 'INCOMPLETE',
  INVALID = 'INVALID',
  SPECIAL_SESSION_EXCLUDED = 'SPECIAL_SESSION_EXCLUDED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  METADATA_INCOMPLETE = 'METADATA_INCOMPLETE',
}

/**
 * Typed, machine-readable reason a canonical row set failed a structural
 * health check. Primary reason contract for `DatasetHealthReport.issues` --
 * explanatory strings are secondary (see `DatasetHealthIssue.detail`).
 */
export enum DatasetHealthIssueReason {
  MISSING_CANONICAL_MINUTE = 'MISSING_CANONICAL_MINUTE',
  DUPLICATE_TIMESTAMP = 'DUPLICATE_TIMESTAMP',
  NON_MINUTE_ALIGNED_TIMESTAMP = 'NON_MINUTE_ALIGNED_TIMESTAMP',
  NON_MONOTONIC_ORDER = 'NON_MONOTONIC_ORDER',
  NON_FINITE_VALUE = 'NON_FINITE_VALUE',
  INVALID_OHLC = 'INVALID_OHLC',
  NEGATIVE_VOLUME = 'NEGATIVE_VOLUME',
  NEGATIVE_OPEN_INTEREST = 'NEGATIVE_OPEN_INTEREST',
  CROSS_SESSION_CONTAMINATION = 'CROSS_SESSION_CONTAMINATION',
}

export interface DatasetHealthIssue {
  readonly reason: DatasetHealthIssueReason;
  readonly candleTime?: Date;
  readonly detail: string;
}

/**
 * Health report for one canonical session's candle rows. Deliberately
 * carries both the projector's exclusion evidence (`excludedRowCount`,
 * `exclusions`) and this validator's own structural findings (`issues`) so
 * a caller never has to reassemble a full picture from two disconnected
 * sources.
 */
export interface DatasetHealthReport {
  readonly status: DatasetHealthStatus;
  readonly assetType: HistoricalAssetType;
  readonly instrumentKey: string;
  readonly tradingDate: string;
  readonly sourceRowCount: number;
  readonly canonicalRowCount: number;
  readonly expectedRowCount: number;
  readonly excludedRowCount: number;
  readonly exclusions: readonly CanonicalSessionExclusion[];
  readonly duplicateTimestampCount: number;
  readonly missingMinuteCount: number;
  readonly invalidOhlcCount: number;
  readonly issues: readonly DatasetHealthIssue[];
}
