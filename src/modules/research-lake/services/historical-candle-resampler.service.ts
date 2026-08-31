import { istCalendarDate, istMinuteOfDay } from '../domain/ist-session-clock';
import { formatMinuteOfDayIst, SessionWindow, validateSessionWindows } from '../domain/exchange-calendar.types';
import { expectedMinutesForWindows, regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import { isCompleteCalendarSession } from '../domain/calendar-session-completeness.util';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestCandleContent,
  ManifestDatasetKind,
  SessionContentIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import {
  HistoricalCandleResamplingDescriptor,
  RESAMPLING_SCHEMA_VERSION,
  RESAMPLING_SEMANTICS_VERSION,
  ResampleSessionStatus,
  ResampleTargetTimeframe,
  ResampledCandle,
  computeDerivedContentChecksum,
  resampleBucketMinutes,
  resampledCandleToManifestContent,
} from '../domain/resampled-candle.types';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';

const MINUTE_MS = 60_000;
const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ResampleSessionRequest {
  readonly targetTimeframe: ResampleTargetTimeframe;
  readonly tradingDate: string;
  readonly sourceDatasetKind: ManifestDatasetKind;
  readonly sourceSessionIdentity: SessionContentIdentity;
  /** The source B-F5 `SessionManifest.contentChecksum` this request's `sourceRows` are claimed to represent -- verified against the supplied `sourceRows` via `computeSessionContentChecksum` before derivation (fails closed on mismatch). */
  readonly sourceSessionContentChecksum: string;
  /**
   * B-F7 CALENDAR FIX (task invariant A): the exact, calendar-authoritative
   * session windows `sourceRows` belong to -- the SAME `SessionManifest.
   * calendarSessionWindows` a calendar-aware caller (B-F5's
   * `ManifestCalendarSessionResolverService`) already resolved and recorded
   * for this session, never re-derived or re-looked-up here (B-F7 makes no
   * calendar/provider/DB call of its own). Omitted or `[]` (preserving every
   * pre-existing caller's behavior exactly): defaults to
   * `[regularSessionWindow()]` -- the fixed 09:15-15:29 IST, 375-minute
   * regular-session contract, provably identical to the certified calendar's
   * own REGULAR_SESSION window. REQUIRED for a genuine SPECIAL_SESSION date
   * so its real window(s) -- never the fixed regular contract -- govern
   * bucket anchoring, partial-bucket policy, and completeness below.
   */
  readonly sessionWindows?: readonly SessionWindow[];
  /** Canonical 1m rows for exactly one trading session, in any order (task section 19: order-independent). Every row must already be canonical -- same trading date, inside a declared `sessionWindows` window, minute-aligned, no duplicate minute -- or `resampleSession` fails closed. */
  readonly sourceRows: readonly PersistedManifestCandleRow[];
}

export interface ResampleSessionResult {
  /** Sorted ascending by `bucketStart`. Only ever contains buckets whose every expected constituent minute was present -- never a fabricated/partial candle (task section 4/17/18). */
  readonly candles: readonly ResampledCandle[];
  readonly descriptor: HistoricalCandleResamplingDescriptor;
}

interface CandidateBucket {
  readonly startMinute: number;
  /** Expected constituent minute-of-day values, clamped to this bucket's OWN declared session window's close -- never extends into a different window or a closed gap. */
  readonly expectedConstituentMinutes: readonly number[];
  /** True when this bucket falls entirely within its declared session window (a full bucket is structurally possible here). False only for the legitimate trailing remainder of that window (e.g. the lone final minute when a window's length does not evenly divide the target bucket size) -- never for a bucket that would bridge into a different window or a closed gap (`buildCandidateBuckets` never generates such a bucket). */
  readonly isFullSessionEligible: boolean;
}

/**
 * Deterministic, source-neutral 1m -> {2m,3m,5m} research resampler (B-F7).
 *
 * Consumes `PersistedManifestCandleRow[]` -- the SAME normalized row shape a
 * direct DB read (`HistoricalCandle`/`HistoricalOptionCandle`, structurally
 * compatible with no mapping needed, exactly as `DatasetSessionManifestBuilderService`
 * already relies on) and a B-F6 Parquet round-trip
 * (`manifestCandleContentToPersistedRow`) both produce -- so a source's
 * physical origin can never influence the result (task section 12). Pure:
 * no Prisma client, no hyparquet, no provider API awareness anywhere in
 * this class.
 *
 * CALENDAR-AUTHORITATIVE SESSION WINDOWS (B-F7 CALENDAR FIX, task invariant
 * A/B/C): bucket boundaries are derived purely from `istMinuteOfDay`/
 * `istCalendarDate` (`ist-session-clock.ts`), never from host timezone or
 * Unix-epoch modulo -- but WHICH minutes are even eligible now comes from
 * `request.sessionWindows` (defaulting to the fixed 09:15-15:29 IST regular
 * window when omitted), not a single hard-coded 09:15-15:29 constant.
 *
 * BUCKET ANCHOR POLICY (task invariant B): each declared session window is
 * an INDEPENDENT bucket anchor -- the first bucket of every window starts
 * exactly at that window's own `openMinuteIst`, never continuing a running
 * offset from a previous window. A bucket's constituent minutes are always
 * drawn from exactly one window; a bucket can never cross from one window
 * into another, and can never bridge a closed gap between two disjoint
 * windows (`buildCandidateBuckets` walks each window's own
 * `[openMinuteIst, closeMinuteIst)` range independently).
 *
 * PARTIAL-FINAL-BUCKET POLICY (task invariant C): when a window's length is
 * not evenly divisible by the target bucket size, the legitimate trailing
 * remainder within THAT window (e.g. the lone 15:29 minute for a 375-minute
 * regular session at 2m) is never fabricated into a partial candle, never
 * bridged into the next window, and never borrows a minute from outside the
 * window -- it is excluded and counted in `excludedTrailingRowCount`,
 * exactly mirroring the pre-existing regular-session policy, now applied
 * per-window.
 *
 * Never fabricates a missing minute, never forward-fills open interest, and
 * never certifies an incomplete source session as complete (task sections
 * 2/5/6/7/17/18) -- completeness (task invariant D) is judged against the
 * EXACT expected-minute set for the declared windows
 * (`expectedMinutesForWindows`/`isCompleteCalendarSession`), never a fixed
 * 375-row assumption.
 */
export default class HistoricalCandleResamplerService {
  resampleSession(request: ResampleSessionRequest): ResampleSessionResult {
    const bucketSize = resampleBucketMinutes(request.targetTimeframe);

    if (request.tradingDate !== request.sourceSessionIdentity.tradingDate) {
      throw new Error(
        `HistoricalCandleResamplerService received mismatched tradingDate: request.tradingDate='${request.tradingDate}' !== request.sourceSessionIdentity.tradingDate='${request.sourceSessionIdentity.tradingDate}'.`
      );
    }
    if (request.sourceDatasetKind !== request.sourceSessionIdentity.datasetKind) {
      throw new Error(
        `HistoricalCandleResamplerService received mismatched datasetKind: request.sourceDatasetKind='${request.sourceDatasetKind}' !== request.sourceSessionIdentity.datasetKind='${request.sourceSessionIdentity.datasetKind}'.`
      );
    }

    const sessionWindows = this.resolveSessionWindows(request.sessionWindows);
    const sourceRows = this.validateAndSort(request.sourceRows, request.tradingDate, sessionWindows);

    const manifestCandles: ManifestCandleContent[] = sourceRows.map((row) => toManifestCandleContent(row));
    const computedSourceChecksum = computeSessionContentChecksum({
      identity: request.sourceSessionIdentity,
      canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
      healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
      candles: manifestCandles,
    });
    if (computedSourceChecksum !== request.sourceSessionContentChecksum) {
      throw new Error(
        `SOURCE_SESSION_CONTENT_CHECKSUM_MISMATCH: claimed sourceSessionContentChecksum '${request.sourceSessionContentChecksum}' does not match computed B-F5 checksum '${computedSourceChecksum}' for the supplied source rows.`
      );
    }

    const rowsByMinute = new Map<number, PersistedManifestCandleRow>();
    for (const row of sourceRows) rowsByMinute.set(istMinuteOfDay(row.candleTime), row);

    const candidateBuckets = this.buildCandidateBuckets(bucketSize, sessionWindows);

    const candles: ResampledCandle[] = [];
    let completeBucketCount = 0;
    let partialBucketCount = 0;
    let excludedTrailingRowCount = 0;

    for (const bucket of candidateBuckets) {
      const constituents = bucket.expectedConstituentMinutes
        .map((minute) => rowsByMinute.get(minute))
        .filter((row): row is PersistedManifestCandleRow => row !== undefined);

      if (!bucket.isFullSessionEligible) {
        // Legitimate per-window session arithmetic remainder (task invariant
        // C / section 2/7A) -- never a candidate for a fabricated candle,
        // regardless of whether its lone constituent minute happens to be
        // present, and never bridged into the next window.
        excludedTrailingRowCount += constituents.length;
        continue;
      }

      if (constituents.length === bucketSize) {
        candles.push(this.aggregateBucket(constituents));
        completeBucketCount += 1;
      } else {
        // A full bucket was structurally possible here but at least one
        // constituent minute is missing (task section 7B/17) -- never
        // fabricated, counted only.
        partialBucketCount += 1;
      }
    }

    const expectedMinutesIst = expectedMinutesForWindows(sessionWindows);
    const missingSourceMinuteCount = this.countMissingCanonicalMinutes(rowsByMinute, expectedMinutesIst);
    const sourceComplete = isCompleteCalendarSession(sourceRows, request.tradingDate, expectedMinutesIst);

    const derivedContentChecksum = computeDerivedContentChecksum({
      identity: {
        sourceSessionIdentity: request.sourceSessionIdentity,
        sourceSessionContentChecksum: request.sourceSessionContentChecksum,
        resamplingSemanticsVersion: RESAMPLING_SEMANTICS_VERSION,
        targetTimeframeMinutes: bucketSize,
      },
      candles: candles.map(resampledCandleToManifestContent),
    });

    const descriptor: HistoricalCandleResamplingDescriptor = {
      resamplingSchemaVersion: RESAMPLING_SCHEMA_VERSION,
      resamplingSemanticsVersion: RESAMPLING_SEMANTICS_VERSION,
      sourceDatasetKind: request.sourceDatasetKind,
      sourceSessionIdentity: request.sourceSessionIdentity,
      sourceSessionContentChecksum: request.sourceSessionContentChecksum,
      targetTimeframeMinutes: bucketSize,
      tradingDate: request.tradingDate,
      sessionWindows,
      sourceRowCount: sourceRows.length,
      expectedConstituentRowsPerBucket: bucketSize,
      completeBucketCount,
      partialBucketCount,
      excludedTrailingRowCount,
      missingSourceMinuteCount,
      derivedContentChecksum,
      status: sourceComplete ? ResampleSessionStatus.COMPLETE_SESSION : ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION,
    };

    return { candles, descriptor };
  }

  /**
   * B-F7 CALENDAR FIX (task invariant A): resolves the effective, validated
   * session windows for this request -- `request.sessionWindows` when
   * supplied and non-empty (a calendar-aware caller's REAL declaration),
   * else `[regularSessionWindow()]` (the fixed 09:15-15:29 IST default,
   * preserving every pre-existing caller's exact behavior). Delegates
   * overlap/order/shape validation to `validateSessionWindows` -- an
   * explicitly-supplied malformed window set fails closed here, before any
   * row is even inspected (never silently repaired or ignored).
   */
  private resolveSessionWindows(sessionWindows: readonly SessionWindow[] | undefined): readonly SessionWindow[] {
    const windows = sessionWindows && sessionWindows.length > 0 ? sessionWindows : [regularSessionWindow()];
    return validateSessionWindows(windows);
  }

  /**
   * Fails closed on any structurally non-canonical input row: cross-date,
   * before the earliest declared window, at/after the latest declared
   * window's close, inside a closed gap between two disjoint windows,
   * non-minute-aligned, or a duplicate minute (task section 6/17/18/W/X/Y/U,
   * task invariant A/I). B-F7 consumes already-canonical research data -- it
   * never repairs or silently excludes a malformed input row the way
   * `CanonicalSessionProjectorService` does for raw provider data. Returns a
   * fresh array sorted ascending by `candleTime` so the result is
   * independent of input order (task section 19).
   *
   * `windows` is always non-empty and pre-validated (`resolveSessionWindows`)
   * -- sorted ascending, non-overlapping. For the default regular window this
   * reproduces the exact prior "pre-market row"/"post-market row" wording
   * (before 09:15 IST / at-or-after 15:30 IST) so every pre-existing caller's
   * error-message contract is unchanged.
   */
  private validateAndSort(rows: readonly PersistedManifestCandleRow[], tradingDate: string, windows: readonly SessionWindow[]): PersistedManifestCandleRow[] {
    if (!TRADING_DATE_PATTERN.test(tradingDate)) {
      throw new Error(`HistoricalCandleResamplerService requires tradingDate as 'YYYY-MM-DD'; received '${tradingDate}'.`);
    }

    const earliestOpenMinute = windows[0].openMinuteIst;
    const latestCloseMinute = windows[windows.length - 1].closeMinuteIst;

    const seenMinutes = new Set<number>();
    for (const row of rows) {
      const timestamp = row.candleTime.getTime();
      if (Number.isNaN(timestamp) || timestamp % MINUTE_MS !== 0) {
        throw new Error(`HistoricalCandleResamplerService received a non-minute-aligned candleTime: ${row.candleTime.toISOString()}.`);
      }
      if (istCalendarDate(row.candleTime) !== tradingDate) {
        throw new Error(`HistoricalCandleResamplerService received a cross-date row ${row.candleTime.toISOString()}: expected trading date ${tradingDate}.`);
      }
      const minuteOfDay = istMinuteOfDay(row.candleTime);
      if (minuteOfDay < earliestOpenMinute) {
        throw new Error(`HistoricalCandleResamplerService received a pre-market row ${row.candleTime.toISOString()}: before ${formatMinuteOfDayIst(earliestOpenMinute)} IST.`);
      }
      if (minuteOfDay >= latestCloseMinute) {
        throw new Error(`HistoricalCandleResamplerService received a post-market row ${row.candleTime.toISOString()}: at or after ${formatMinuteOfDayIst(latestCloseMinute)} IST.`);
      }
      if (!windows.some((window) => minuteOfDay >= window.openMinuteIst && minuteOfDay < window.closeMinuteIst)) {
        throw new Error(
          `HistoricalCandleResamplerService received a row ${row.candleTime.toISOString()} outside every declared calendar session window: it falls in a closed gap between two disjoint windows and is never bridged.`
        );
      }
      if (seenMinutes.has(minuteOfDay)) {
        throw new Error(`HistoricalCandleResamplerService received a duplicate source minute at ${row.candleTime.toISOString()}.`);
      }
      seenMinutes.add(minuteOfDay);
    }

    return [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  }

  /**
   * Every structurally-possible bucket start-minute across ALL declared
   * session windows (task invariant B), regardless of which minutes the
   * caller's `sourceRows` actually cover -- so `completeBucketCount`/
   * `partialBucketCount`/`excludedTrailingRowCount` are always computed
   * against the fixed canonical session shape, never against however much of
   * it the caller happened to supply.
   *
   * Each window is walked independently, anchored at its OWN `openMinuteIst`
   * -- a bucket's constituent minutes never extend past that window's own
   * `closeMinuteIst`, so a bucket can never cross into a different window or
   * bridge a closed gap between two disjoint windows. `windows` is expected
   * pre-validated (non-overlapping, ascending) by `resolveSessionWindows`.
   */
  private buildCandidateBuckets(bucketSize: number, windows: readonly SessionWindow[]): CandidateBucket[] {
    const buckets: CandidateBucket[] = [];
    for (const window of windows) {
      for (let startMinute = window.openMinuteIst; startMinute < window.closeMinuteIst; startMinute += bucketSize) {
        const constituents: number[] = [];
        for (let minute = startMinute; minute < startMinute + bucketSize && minute < window.closeMinuteIst; minute += 1) {
          constituents.push(minute);
        }
        buckets.push({
          startMinute,
          expectedConstituentMinutes: constituents,
          isFullSessionEligible: constituents.length === bucketSize,
        });
      }
    }
    return buckets;
  }

  /**
   * OHLCV aggregation (task section 4): open = first constituent's open,
   * high = exact `Prisma.Decimal` max, low = exact `Prisma.Decimal` min,
   * close = last constituent's close, volume = exact bigint sum.
   * `openInterest` = the FINAL constituent's own value, never summed,
   * averaged, or forward-filled over an earlier non-null value (task
   * section 5) -- `null` stays `null`, `0n` stays `0n`. `constituents` is
   * exactly `bucketSize` already-validated, already-deduplicated rows.
   */
  private aggregateBucket(constituents: readonly PersistedManifestCandleRow[]): ResampledCandle {
    const sorted = [...constituents].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    let high = first.high;
    let low = first.low;
    let volume = 0n;
    for (const row of sorted) {
      if (row.high.greaterThan(high)) high = row.high;
      if (row.low.lessThan(low)) low = row.low;
      volume += row.volume;
    }

    return {
      bucketStart: first.candleTime,
      bucketEnd: last.candleTime,
      availableAt: new Date(last.candleTime.getTime() + MINUTE_MS),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      openInterest: last.openInterest,
    };
  }

  /** Counts against the exact `expectedMinutesIst` set for the declared session windows (task invariant D) -- never a fixed 375-minute assumption. */
  private countMissingCanonicalMinutes(rowsByMinute: ReadonlyMap<number, PersistedManifestCandleRow>, expectedMinutesIst: readonly number[]): number {
    let missing = 0;
    for (const minute of expectedMinutesIst) {
      if (!rowsByMinute.has(minute)) missing += 1;
    }
    return missing;
  }
}
