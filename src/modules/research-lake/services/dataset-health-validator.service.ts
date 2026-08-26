import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import {
  CanonicalSessionProjectionOutcome,
  CanonicalSessionProjectionResult,
  CanonicalSourceOrderAnomaly,
} from '../domain/canonical-session.types';
import { DatasetHealthIssue, DatasetHealthIssueReason, DatasetHealthReport, DatasetHealthStatus } from '../domain/dataset-health.types';
import { istCalendarDate } from '../domain/ist-session-clock';
import {
  HISTORICAL_SESSION_ROW_COUNT,
  isCompleteHistoricalSession,
} from '../../historical-candles/utils/historical-session-completeness.util';

const MINUTE_MS = 60_000;

/**
 * Structural issue reasons that make a session's canonical rows untrustworthy
 * -- anything present here forces `INVALID`, taking priority over
 * `MISSING_CANONICAL_MINUTE` (which alone only means `INCOMPLETE`).
 */
const BLOCKING_ISSUE_REASONS = new Set<DatasetHealthIssueReason>([
  DatasetHealthIssueReason.DUPLICATE_TIMESTAMP,
  DatasetHealthIssueReason.NON_MINUTE_ALIGNED_TIMESTAMP,
  DatasetHealthIssueReason.NON_MONOTONIC_ORDER,
  DatasetHealthIssueReason.NON_FINITE_VALUE,
  DatasetHealthIssueReason.INVALID_OHLC,
  DatasetHealthIssueReason.NEGATIVE_VOLUME,
  DatasetHealthIssueReason.NEGATIVE_OPEN_INTEREST,
  DatasetHealthIssueReason.CROSS_SESSION_CONTAMINATION,
]);

/**
 * Validates canonical (already-projected) NIFTY 1-minute session rows
 * against the established 375-row 09:15-15:29 IST completeness contract,
 * plus OHLC/volume/OI structural validity. Consumes
 * `CanonicalSessionProjectionResult` -- canonical projected rows, never raw
 * provider rows -- so it never has to re-derive session-window membership
 * itself.
 *
 * Reuses `isCompleteHistoricalSession` from
 * `historical-session-completeness.util.ts` as the authoritative pass/fail
 * signal for "exactly the healthy 375-row contract": when it returns true,
 * no duplicate/missing/misaligned/non-monotonic breakdown is computed
 * (there is nothing to explain). When it returns false, this validator
 * computes the detailed diagnostics that utility deliberately does not
 * provide (which exact minute is missing, which timestamp is duplicated,
 * ...) so the same 375-row contract is never redefined, only explained.
 */
export default class DatasetHealthValidatorService {
  validate(projection: CanonicalSessionProjectionResult): DatasetHealthReport {
    const { instrumentKey, tradingDate, sourceRowCount, acceptedRows, excludedRows, outcome } = projection;

    if (outcome === CanonicalSessionProjectionOutcome.SPECIAL_SESSION_EXCLUDED) {
      return this.report(DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED, projection, [], 0, 0);
    }

    if (!this.hasUsableIdentity(instrumentKey, tradingDate)) {
      return this.report(DatasetHealthStatus.METADATA_INCOMPLETE, projection, [], 0, 0);
    }

    if (sourceRowCount === 0) {
      return this.report(DatasetHealthStatus.PROVIDER_UNAVAILABLE, projection, [], 0, 0);
    }

    const candleIssues = this.checkCandleValues(acceptedRows);
    const sourceOrderIssues = this.checkSourceOrderAnomalies(projection.sourceOrderAnomalies);
    const structurallyComplete = isCompleteHistoricalSession(acceptedRows);
    const structuralIssues = structurallyComplete ? [] : this.checkStructure(acceptedRows, tradingDate);

    const issues = [...structuralIssues, ...candleIssues, ...sourceOrderIssues].sort(this.byCandleTime);
    const duplicateTimestampCount = structuralIssues.filter(
      (issue) => issue.reason === DatasetHealthIssueReason.DUPLICATE_TIMESTAMP
    ).length;
    const missingMinuteCount = structuralIssues.filter(
      (issue) => issue.reason === DatasetHealthIssueReason.MISSING_CANONICAL_MINUTE
    ).length;

    const hasBlockingIssue = issues.some((issue) => BLOCKING_ISSUE_REASONS.has(issue.reason));
    const status = hasBlockingIssue
      ? DatasetHealthStatus.INVALID
      : missingMinuteCount > 0
        ? DatasetHealthStatus.INCOMPLETE
        : excludedRows.length > 0
          ? DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS
          : DatasetHealthStatus.HEALTHY;

    return this.report(status, projection, issues, duplicateTimestampCount, missingMinuteCount);
  }

  private report(
    status: DatasetHealthStatus,
    projection: CanonicalSessionProjectionResult,
    issues: readonly DatasetHealthIssue[],
    duplicateTimestampCount: number,
    missingMinuteCount: number
  ): DatasetHealthReport {
    return {
      status,
      assetType: projection.assetType,
      instrumentKey: projection.instrumentKey,
      tradingDate: projection.tradingDate,
      sourceRowCount: projection.sourceRowCount,
      canonicalRowCount: projection.acceptedRows.length,
      expectedRowCount: HISTORICAL_SESSION_ROW_COUNT,
      excludedRowCount: projection.excludedRows.length,
      exclusions: projection.excludedRows,
      duplicateTimestampCount,
      missingMinuteCount,
      invalidOhlcCount: issues.filter((issue) => issue.reason === DatasetHealthIssueReason.INVALID_OHLC).length,
      issues,
    };
  }

  private hasUsableIdentity(instrumentKey: string, tradingDate: string): boolean {
    return instrumentKey.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(tradingDate);
  }

  private checkStructure(rows: readonly CanonicalHistoricalCandle[], tradingDate: string): DatasetHealthIssue[] {
    const issues: DatasetHealthIssue[] = [];
    const countByTimestamp = new Map<number, number>();
    for (const row of rows) {
      const timestamp = row.candleTime.getTime();
      countByTimestamp.set(timestamp, (countByTimestamp.get(timestamp) ?? 0) + 1);
    }

    let previousTimestamp: number | null = null;
    for (const row of rows) {
      const timestamp = row.candleTime.getTime();

      if ((countByTimestamp.get(timestamp) ?? 0) > 1) {
        issues.push({
          reason: DatasetHealthIssueReason.DUPLICATE_TIMESTAMP,
          candleTime: row.candleTime,
          detail: `Canonical minute ${row.candleTime.toISOString()} appears ${countByTimestamp.get(timestamp)} times.`,
        });
      }
      if (timestamp % MINUTE_MS !== 0) {
        issues.push({
          reason: DatasetHealthIssueReason.NON_MINUTE_ALIGNED_TIMESTAMP,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} is not aligned to a whole minute.`,
        });
      }
      if (istCalendarDate(row.candleTime) !== tradingDate) {
        issues.push({
          reason: DatasetHealthIssueReason.CROSS_SESSION_CONTAMINATION,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} falls outside declared trading date ${tradingDate}.`,
        });
      }
      if (previousTimestamp !== null && timestamp < previousTimestamp) {
        issues.push({
          reason: DatasetHealthIssueReason.NON_MONOTONIC_ORDER,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} is out of order relative to the preceding canonical row.`,
        });
      }
      previousTimestamp = timestamp;
    }

    for (const expected of this.expectedCanonicalMinutes(tradingDate)) {
      if (!countByTimestamp.has(expected.getTime())) {
        issues.push({
          reason: DatasetHealthIssueReason.MISSING_CANONICAL_MINUTE,
          candleTime: expected,
          detail: `Expected canonical minute ${expected.toISOString()} is missing.`,
        });
      }
    }

    return issues;
  }

  private checkCandleValues(rows: readonly CanonicalHistoricalCandle[]): DatasetHealthIssue[] {
    const issues: DatasetHealthIssue[] = [];
    for (const row of rows) {
      const values = [row.open, row.high, row.low, row.close];
      if (!values.every((value) => Number.isFinite(value))) {
        issues.push({
          reason: DatasetHealthIssueReason.NON_FINITE_VALUE,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} has a non-finite OHLC value.`,
        });
        continue;
      }
      const maxOpenClose = Math.max(row.open, row.close);
      const minOpenClose = Math.min(row.open, row.close);
      if (row.high < maxOpenClose || row.low > minOpenClose || row.high < row.low) {
        issues.push({
          reason: DatasetHealthIssueReason.INVALID_OHLC,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} has an inconsistent OHLC relationship (open=${row.open}, high=${row.high}, low=${row.low}, close=${row.close}).`,
        });
      }
      if (row.volume < 0n) {
        issues.push({
          reason: DatasetHealthIssueReason.NEGATIVE_VOLUME,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} has negative volume ${row.volume}.`,
        });
      }
      if (row.openInterest !== null && row.openInterest < 0n) {
        issues.push({
          reason: DatasetHealthIssueReason.NEGATIVE_OPEN_INTEREST,
          candleTime: row.candleTime,
          detail: `${row.candleTime.toISOString()} has negative open interest ${row.openInterest}.`,
        });
      }
    }
    return issues;
  }

  /**
   * Translates the projector's raw-provider-order evidence into this
   * validator's own typed issue contract. Always run, independent of
   * `isCompleteHistoricalSession(acceptedRows)` -- `acceptedRows` is sorted
   * and can never itself reveal that the provider delivered rows out of
   * order, so this evidence must never be gated behind the sorted-rows fast
   * path (that gating was exactly the prior defect: a non-monotonic raw
   * response could resolve to HEALTHY once `acceptedRows` was sorted).
   */
  private checkSourceOrderAnomalies(anomalies: readonly CanonicalSourceOrderAnomaly[]): DatasetHealthIssue[] {
    return anomalies.map((anomaly) => ({
      reason: DatasetHealthIssueReason.NON_MONOTONIC_ORDER,
      candleTime: anomaly.currentSourceCandleTime,
      detail: `Raw provider source row sourceIndex=${anomaly.sourceIndex} arrived at ${anomaly.currentSourceCandleTime.toISOString()} immediately after ${anomaly.previousSourceCandleTime.toISOString()} in the raw response -- out of chronological order.`,
    }));
  }

  private expectedCanonicalMinutes(tradingDate: string): Date[] {
    const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
    return Array.from({ length: HISTORICAL_SESSION_ROW_COUNT }, (_, index) => new Date(start + index * MINUTE_MS));
  }

  private byCandleTime(left: DatasetHealthIssue, right: DatasetHealthIssue): number {
    const leftTime = left.candleTime?.getTime() ?? 0;
    const rightTime = right.candleTime?.getTime() ?? 0;
    return leftTime - rightTime;
  }
}
