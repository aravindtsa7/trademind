import { istCalendarDate, istMinuteOfDay, NORMAL_SESSION_START_MINUTE } from '../domain/ist-session-clock';
import { NIFTY_1M_SOURCE_HORIZON_END_MINUTE, isCompleteHistoricalSession } from '../../historical-candles/utils/historical-session-completeness.util';
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
  /** Canonical 1m rows for exactly one trading session, in any order (task section 19: order-independent). Every row must already be canonical -- same trading date, 09:15-15:29 IST window, minute-aligned, no duplicate minute -- or `resampleSession` fails closed. */
  readonly sourceRows: readonly PersistedManifestCandleRow[];
}

export interface ResampleSessionResult {
  /** Sorted ascending by `bucketStart`. Only ever contains buckets whose every expected constituent minute was present -- never a fabricated/partial candle (task section 4/17/18). */
  readonly candles: readonly ResampledCandle[];
  readonly descriptor: HistoricalCandleResamplingDescriptor;
}

interface CandidateBucket {
  readonly startMinute: number;
  /** Expected constituent minute-of-day values, clamped to the 09:15-15:29 regular session end. */
  readonly expectedConstituentMinutes: readonly number[];
  /** True when this bucket falls entirely within the regular session (a full bucket is structurally possible here). False only for the legitimate trailing remainder (e.g. the lone 15:29 minute for 2m). */
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
 * Session anchor is always 09:15:00 IST (task section 1); bucket boundaries
 * are derived purely from `istMinuteOfDay`/`istCalendarDate`
 * (`ist-session-clock.ts`), never from host timezone or Unix-epoch modulo.
 * Never fabricates a missing minute, never forward-fills open interest,
 * never fabricates the legitimate 2m trailing 15:29 remainder into a
 * partial candle, and never certifies an incomplete source session as
 * complete (task sections 2/5/6/7/17/18).
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

    const sourceRows = this.validateAndSort(request.sourceRows, request.tradingDate);

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

    const candidateBuckets = this.buildCandidateBuckets(bucketSize);

    const candles: ResampledCandle[] = [];
    let completeBucketCount = 0;
    let partialBucketCount = 0;
    let excludedTrailingRowCount = 0;

    for (const bucket of candidateBuckets) {
      const constituents = bucket.expectedConstituentMinutes
        .map((minute) => rowsByMinute.get(minute))
        .filter((row): row is PersistedManifestCandleRow => row !== undefined);

      if (!bucket.isFullSessionEligible) {
        // Legitimate regular-session arithmetic remainder (task section 2/7A)
        // -- never a candidate for a fabricated candle, regardless of
        // whether its lone constituent minute happens to be present.
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

    const missingSourceMinuteCount = this.countMissingCanonicalMinutes(rowsByMinute);
    const sourceComplete = isCompleteHistoricalSession(sourceRows);

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
      sourceRowCount: sourceRows.length,
      expectedConstituentRowsPerBucket: bucketSize,
      completeBucketCount,
      partialBucketCount,
      excludedTrailingRowCount,
      missingSourceMinuteCount,
      derivedContentChecksum,
      status: sourceComplete ? ResampleSessionStatus.COMPLETE_REGULAR_SESSION : ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION,
    };

    return { candles, descriptor };
  }

  /**
   * Fails closed on any structurally non-canonical input row: cross-date,
   * pre-market, post-market/post-source, non-minute-aligned, or a duplicate
   * minute (task section 6/17/18/W/X/Y/U). B-F7 consumes already-canonical
   * research data -- it never repairs or silently excludes a malformed
   * input row the way `CanonicalSessionProjectorService` does for raw
   * provider data. Returns a fresh array sorted ascending by `candleTime`
   * so the result is independent of input order (task section 19).
   */
  private validateAndSort(rows: readonly PersistedManifestCandleRow[], tradingDate: string): PersistedManifestCandleRow[] {
    if (!TRADING_DATE_PATTERN.test(tradingDate)) {
      throw new Error(`HistoricalCandleResamplerService requires tradingDate as 'YYYY-MM-DD'; received '${tradingDate}'.`);
    }

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
      if (minuteOfDay < NORMAL_SESSION_START_MINUTE) {
        throw new Error(`HistoricalCandleResamplerService received a pre-market row ${row.candleTime.toISOString()}: before 09:15 IST.`);
      }
      if (minuteOfDay > NIFTY_1M_SOURCE_HORIZON_END_MINUTE) {
        throw new Error(`HistoricalCandleResamplerService received a post-market row ${row.candleTime.toISOString()}: after 15:29 IST.`);
      }
      if (seenMinutes.has(minuteOfDay)) {
        throw new Error(`HistoricalCandleResamplerService received a duplicate source minute at ${row.candleTime.toISOString()}.`);
      }
      seenMinutes.add(minuteOfDay);
    }

    return [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  }

  /**
   * Every structurally-possible bucket start-minute across the full regular
   * 09:15-15:29 session, anchored at 09:15 IST (task section 1), regardless
   * of which minutes the caller's `sourceRows` actually cover -- so
   * `completeBucketCount`/`partialBucketCount`/`excludedTrailingRowCount`
   * are always computed against the fixed canonical session shape, never
   * against however much of it the caller happened to supply.
   */
  private buildCandidateBuckets(bucketSize: number): CandidateBucket[] {
    const buckets: CandidateBucket[] = [];
    for (let startMinute = NORMAL_SESSION_START_MINUTE; startMinute <= NIFTY_1M_SOURCE_HORIZON_END_MINUTE; startMinute += bucketSize) {
      const constituents: number[] = [];
      for (let minute = startMinute; minute < startMinute + bucketSize && minute <= NIFTY_1M_SOURCE_HORIZON_END_MINUTE; minute += 1) {
        constituents.push(minute);
      }
      buckets.push({
        startMinute,
        expectedConstituentMinutes: constituents,
        isFullSessionEligible: constituents.length === bucketSize,
      });
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

  private countMissingCanonicalMinutes(rowsByMinute: ReadonlyMap<number, PersistedManifestCandleRow>): number {
    let missing = 0;
    for (let minute = NORMAL_SESSION_START_MINUTE; minute <= NIFTY_1M_SOURCE_HORIZON_END_MINUTE; minute += 1) {
      if (!rowsByMinute.has(minute)) missing += 1;
    }
    return missing;
  }
}
