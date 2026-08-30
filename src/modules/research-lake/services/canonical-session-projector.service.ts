import { HistoricalAssetType } from '../domain/historical-asset.types';
import { CanonicalHistoricalCandle, HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import {
  CanonicalExclusionReason,
  CanonicalSessionDeclaration,
  CanonicalSessionExclusion,
  CanonicalSessionProjectionOutcome,
  CanonicalSessionProjectionRequest,
  CanonicalSessionProjectionResult,
  CanonicalSourceOrderAnomaly,
  CanonicalSourceOrderAnomalyReason,
} from '../domain/canonical-session.types';
import { SessionWindow, validateSessionWindows } from '../domain/exchange-calendar.types';
import { NIFTY_1M_SOURCE_HORIZON_END_MINUTE } from '../../historical-candles/utils/historical-session-completeness.util';
import { istCalendarDate, istMinuteOfDay, NORMAL_SESSION_START_MINUTE } from '../domain/ist-session-clock';

/**
 * Deterministically classifies raw provider source rows against a declared
 * canonical NIFTY session window (09:15:00-15:29:59 IST). Never fabricates
 * rows, never fills gaps, never mutates `sourceRows` or any row object it
 * receives, and never silently trims -- every excluded row is retained with
 * typed evidence. `NORMAL_SESSION_END_MINUTE` (15:29) is reused directly
 * from `historical-session-completeness.util.ts`
 * (`NIFTY_1M_SOURCE_HORIZON_END_MINUTE`) rather than re-declared, so the two
 * session-boundary definitions can never drift apart.
 */
export default class CanonicalSessionProjectorService {
  project(request: CanonicalSessionProjectionRequest): CanonicalSessionProjectionResult {
    const { assetType, instrumentKey, tradingDate, sessionDeclaration, sourceRows } = request;

    if (sessionDeclaration === CanonicalSessionDeclaration.UNDECLARED_SPECIAL_SESSION) {
      return {
        outcome: CanonicalSessionProjectionOutcome.SPECIAL_SESSION_EXCLUDED,
        assetType,
        instrumentKey,
        tradingDate,
        sourceRowCount: sourceRows.length,
        acceptedRows: [],
        excludedRows: [],
        sourceOrderAnomalies: [],
      };
    }

    const calendarWindows =
      sessionDeclaration === CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION
        ? this.assertCalendarWindows(request.sessionWindows)
        : null;

    const accepted: CanonicalHistoricalCandle[] = [];
    const excluded: CanonicalSessionExclusion[] = [];
    const sourceOrderAnomalies = this.detectSourceOrderAnomalies(sourceRows);

    for (const row of sourceRows) {
      const reason = calendarWindows
        ? this.classifyAgainstCalendarWindows(row, tradingDate, calendarWindows)
        : this.classify(row, assetType, tradingDate);
      if (reason === null) {
        accepted.push({
          assetType,
          instrumentKey,
          candleTime: new Date(row.candleTime.getTime()),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          openInterest: row.openInterest,
        });
      } else {
        excluded.push({
          sourceIndex: row.sourceIndex,
          candleTime: new Date(row.candleTime.getTime()),
          reason,
        });
      }
    }

    return {
      outcome: CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED,
      assetType,
      instrumentKey,
      tradingDate,
      sourceRowCount: sourceRows.length,
      acceptedRows: this.sortByCandleTime(accepted, (row) => row.candleTime),
      excludedRows: this.sortByCandleTime(excluded, (row) => row.candleTime, (row) => row.sourceIndex),
      sourceOrderAnomalies,
    };
  }

  /**
   * Detects chronologically-adjacent rows in the RAW `sourceRows` array
   * (in the order given, before any sorting) that arrived out of order.
   * This is the only mechanism that can ever produce this evidence --
   * `acceptedRows` is sorted for downstream convenience and can no longer
   * reveal that the provider itself delivered rows non-monotonically.
   */
  private detectSourceOrderAnomalies(sourceRows: readonly HistoricalSourceCandleRow[]): CanonicalSourceOrderAnomaly[] {
    const anomalies: CanonicalSourceOrderAnomaly[] = [];
    for (let index = 1; index < sourceRows.length; index += 1) {
      const previous = sourceRows[index - 1];
      const current = sourceRows[index];
      if (current.candleTime.getTime() < previous.candleTime.getTime()) {
        anomalies.push({
          reason: CanonicalSourceOrderAnomalyReason.NON_MONOTONIC_ORDER,
          sourceIndex: current.sourceIndex,
          previousSourceCandleTime: new Date(previous.candleTime.getTime()),
          currentSourceCandleTime: new Date(current.candleTime.getTime()),
        });
      }
    }
    return anomalies;
  }

  /**
   * Fails closed rather than defaulting to an empty/implicit window set: a
   * `CALENDAR_DECLARED_SESSION` request with no (or malformed) windows is a
   * caller bug, not a legitimate "no session" state -- `CLOSED_*`/
   * `BLOCKED_UNCERTIFIED` dates must never reach the projector at all (task
   * B-F2-CAL-2 section 12/15).
   */
  private assertCalendarWindows(sessionWindows: readonly SessionWindow[] | undefined): readonly SessionWindow[] {
    if (!sessionWindows || sessionWindows.length === 0) {
      throw new Error('CanonicalSessionProjectorService: CALENDAR_DECLARED_SESSION requires a non-empty sessionWindows array.');
    }
    return validateSessionWindows(sessionWindows);
  }

  /**
   * Classifies one row against an explicit, calendar-certified window set
   * (task section 10/11/19): accepted only if it falls on the declared
   * trading date AND inside at least one half-open `[openMinuteIst,
   * closeMinuteIst)` window -- a row in the gap between two disjoint windows
   * (e.g. [600,690) between a multi-window special session's two windows)
   * is excluded, never bridged.
   */
  private classifyAgainstCalendarWindows(
    row: HistoricalSourceCandleRow,
    tradingDate: string,
    windows: readonly SessionWindow[]
  ): CanonicalExclusionReason | null {
    if (istCalendarDate(row.candleTime) !== tradingDate) {
      return CanonicalExclusionReason.OUTSIDE_DECLARED_SESSION;
    }
    const minuteOfDay = istMinuteOfDay(row.candleTime);
    const insideAWindow = windows.some((window) => minuteOfDay >= window.openMinuteIst && minuteOfDay < window.closeMinuteIst);
    return insideAWindow ? null : CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW;
  }

  private classify(
    row: HistoricalSourceCandleRow,
    assetType: HistoricalAssetType,
    tradingDate: string
  ): CanonicalExclusionReason | null {
    if (istCalendarDate(row.candleTime) !== tradingDate) {
      return CanonicalExclusionReason.OUTSIDE_DECLARED_SESSION;
    }

    const minuteOfDay = istMinuteOfDay(row.candleTime);
    if (minuteOfDay < NORMAL_SESSION_START_MINUTE) {
      return CanonicalExclusionReason.PRE_MARKET_ROW;
    }
    if (minuteOfDay > NIFTY_1M_SOURCE_HORIZON_END_MINUTE) {
      return assetType === HistoricalAssetType.NIFTY_INDEX
        ? CanonicalExclusionReason.POST_SOURCE_ROW
        : CanonicalExclusionReason.POST_MARKET_ROW;
    }
    return null;
  }

  /**
   * Stable sort ascending by candle time. When `sourceIndexOf` is supplied
   * (excluded rows, which carry `sourceIndex`), ties break on it; otherwise
   * ties break on original array-encounter order, which is itself
   * deterministic for a fixed input array.
   */
  private sortByCandleTime<T>(rows: T[], candleTimeOf: (row: T) => Date, sourceIndexOf?: (row: T) => number): T[] {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const timeDiff = candleTimeOf(left.row).getTime() - candleTimeOf(right.row).getTime();
        if (timeDiff !== 0) return timeDiff;
        if (sourceIndexOf) return sourceIndexOf(left.row) - sourceIndexOf(right.row);
        return left.index - right.index;
      })
      .map(({ row }) => row);
  }
}
