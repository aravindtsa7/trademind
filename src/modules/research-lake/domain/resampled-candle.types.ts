import { Prisma } from '@prisma/client';
import { ManifestCandleContent, ManifestDatasetKind, SessionContentIdentity, sortManifestCandles } from './dataset-manifest.types';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { SessionWindow } from './exchange-calendar.types';
import { PersistedManifestCandleRow } from '../services/dataset-session-manifest-builder.service';

/**
 * Semantic version of B-F7's resampling rules (session anchor, bucket
 * membership, timestamp convention, OHLCV rules, OI rule, partial-bucket
 * policy). Part of the derived content checksum -- deliberately a fourth,
 * orthogonal axis distinct from `CANONICALIZATION_SEMANTICS_VERSION`/
 * `HEALTH_SEMANTICS_VERSION` (B-F5: how 1m content is canonicalized/
 * validated) and `PARQUET_STORAGE_SCHEMA_VERSION` (B-F6: how that content is
 * physically stored). Bump this if the session anchor, bucket boundaries,
 * timestamp convention, OHLCV formula, OI rule, or partial-bucket policy
 * ever changes, so an old derived checksum never silently compares equal to
 * one produced under new semantics.
 *
 * Bumped 1 -> 2 for the B-F7 CALENDAR FIX: `HistoricalCandleResamplerService`
 * previously hard-coded a single fixed 09:15-15:29 IST regular-session
 * anchor/bucket-membership/partial-bucket contract (version 1's actual,
 * documented scope -- "session anchor, bucket boundaries... partial-bucket
 * policy"). Version 2 generalizes ALL of those to be calendar-session-window
 * aware (see `ResampleSessionRequest.sessionWindows`): each declared window
 * is now an independent bucket anchor, a window's own trailing remainder is
 * its own partial-bucket boundary, and a closed gap between windows is never
 * bridged. This is a genuine semantics change, not a defect repair of an
 * already-generic contract -- REGULAR_SESSION output (candle values, bucket
 * boundaries, counts) is bit-for-bit unchanged (see the resampler's own
 * regular-session parity tests), but `derivedContentChecksum` intentionally
 * changes for every session, regular or special, because this version number
 * is itself hashed into `DerivedSessionIdentity` -- exactly the mechanism
 * this field exists for (task invariant F/E: "unless resampling identity/
 * versioning intentionally requires it").
 */
export const RESAMPLING_SEMANTICS_VERSION = 2;

/** Envelope/shape version for `HistoricalCandleResamplingDescriptor` itself. Deliberately NOT part of the derived content checksum -- mirrors `MANIFEST_SCHEMA_VERSION`'s role for `SessionManifest`/`DatasetManifest`. */
export const RESAMPLING_SCHEMA_VERSION = 1;

/** The only target timeframes B-F7 supports (task section 23). Any other value fails closed via `resampleBucketMinutes`. */
export enum ResampleTargetTimeframe {
  TWO_MINUTE = '2m',
  THREE_MINUTE = '3m',
  FIVE_MINUTE = '5m',
}

const RESAMPLE_BUCKET_MINUTES: Readonly<Record<ResampleTargetTimeframe, number>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: 2,
  [ResampleTargetTimeframe.THREE_MINUTE]: 3,
  [ResampleTargetTimeframe.FIVE_MINUTE]: 5,
};

/** Fails closed on any target timeframe other than the three B-F7 supports -- never silently widens to an arbitrary N. */
export function resampleBucketMinutes(timeframe: ResampleTargetTimeframe): number {
  const minutes = RESAMPLE_BUCKET_MINUTES[timeframe];
  if (!minutes) {
    throw new Error(`Unsupported B-F7 resample target timeframe: '${String(timeframe)}'. Only '2m', '3m', '5m' are supported.`);
  }
  return minutes;
}

/**
 * One derived Nm candle. `bucketStart` is this candle's canonical
 * `candleTime` (open-time convention -- the same convention every existing
 * timeframe candle in this repo already uses, task section 3). `bucketEnd`
 * is the LAST constituent 1m candle's own `candleTime` (also open-time).
 * `availableAt` is one minute after `bucketEnd`: the instant the final
 * constituent 1m candle closes, and therefore the earliest instant this
 * derived candle may be treated as decided/available to a research or
 * replay consumer (task section 16: no-lookahead). OHLC are exact
 * `Prisma.Decimal` -- never a lossy JS `number` round-trip (task section
 * 10). `volume` is exact `bigint` (task section 11). `openInterest` is the
 * FINAL constituent 1m candle's own `openInterest` -- never summed,
 * averaged, or forward-filled (task section 5).
 */
export interface ResampledCandle {
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly availableAt: Date;
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
}

/**
 * Whether the SOURCE 1m session this derived result was computed from was
 * fully complete against its authoritative expected-minute set -- the fixed
 * 375-row 09:15-15:29 IST set for a REGULAR_SESSION, or the exact calendar-
 * declared `expectedMinutesForWindows(sessionWindows)` set for a
 * SPECIAL_SESSION (`isCompleteCalendarSession`; task invariant D).
 * `INCOMPLETE_SOURCE_SESSION` never means the derived candles that WERE
 * produced are wrong -- only that the overall session cannot be certified
 * complete (task section 6/31.6: "do not certify a complete resampled
 * dataset" from an incomplete source).
 *
 * Renamed from `COMPLETE_REGULAR_SESSION` (B-F7 CALENDAR FIX): the prior name
 * was accurate when only the fixed regular-session contract existed, but
 * would now be a misnomer for a fully complete SPECIAL_SESSION result -- this
 * status genuinely means "complete against whatever session this request
 * declared", regular or special, never only "regular".
 */
export enum ResampleSessionStatus {
  COMPLETE_SESSION = 'COMPLETE_SESSION',
  INCOMPLETE_SOURCE_SESSION = 'INCOMPLETE_SOURCE_SESSION',
}

/**
 * Small, read-only B-F7 derived-session descriptor (task section 20-21: "not
 * a huge new storage system"). Never carries candle payloads. Links back to
 * the B-F5 source session by identity + `sourceSessionContentChecksum`
 * (verified against the supplied source rows before resampling).
 */
export interface HistoricalCandleResamplingDescriptor {
  readonly resamplingSchemaVersion: number;
  readonly resamplingSemanticsVersion: number;
  readonly sourceDatasetKind: ManifestDatasetKind;
  readonly sourceSessionIdentity: SessionContentIdentity;
  readonly sourceSessionContentChecksum: string;
  readonly targetTimeframeMinutes: number;
  readonly tradingDate: string;
  /**
   * The exact, calendar-authoritative session windows this result was
   * computed against (task invariant A/G) -- always non-empty: defaults to
   * `[regularSessionWindow()]` (`session-window-expected-minutes.util.ts`)
   * when the request omits `sessionWindows`, so a REGULAR_SESSION result and
   * a SPECIAL_SESSION result carry the SAME kind of explicit, auditable
   * window declaration rather than one being implicit. Recorded here (not
   * only consumed) so a downstream reader can confirm/reproduce which
   * windows governed bucket anchoring/completeness without re-deriving them.
   */
  readonly sessionWindows: readonly SessionWindow[];
  readonly sourceRowCount: number;
  readonly expectedConstituentRowsPerBucket: number;
  /** Buckets whose every expected constituent minute was present -- these, and only these, produced a `ResampledCandle`. */
  readonly completeBucketCount: number;
  /** Buckets that fall entirely within one of the declared `sessionWindows` (so a full bucket was structurally possible there) but had at least one missing constituent minute -- distinct from `excludedTrailingRowCount` (task section 7: distinguish source incompleteness from legitimate session-arithmetic remainder). Never fabricated as a candle. */
  readonly partialBucketCount: number;
  /** Source rows that fall in a declared window's legitimate trailing remainder (e.g. the lone 15:29 minute for 2m on the regular 375-minute window) -- structurally excluded from any bucket by that window's own session arithmetic, never by data incompleteness, and never bridged into a different window (task invariant B/C, section 2/7). 0 whenever every declared window's length divides evenly by the target bucket size (e.g. always 0 for 3m/5m on the regular 375-minute window). */
  readonly excludedTrailingRowCount: number;
  /** Count of the `expectedMinutesForWindows(sessionWindows)` minutes not present anywhere in the source rows (task invariant D) -- 375 canonical 09:15-15:29 minutes for the default regular window, or the exact calendar-declared count for a special session. */
  readonly missingSourceMinuteCount: number;
  readonly derivedContentChecksum: string;
  readonly status: ResampleSessionStatus;
}

/** Exactly the content that determines a derived session's `derivedContentChecksum` -- mirrors `SessionContentPayload`'s identity/content split (B-F5). */
export interface DerivedSessionIdentity {
  readonly sourceSessionIdentity: SessionContentIdentity;
  readonly sourceSessionContentChecksum: string;
  readonly resamplingSemanticsVersion: number;
  readonly targetTimeframeMinutes: number;
}

export interface DerivedContentPayload {
  readonly identity: DerivedSessionIdentity;
  /** Sorted ascending by `candleTime` before hashing -- see `computeDerivedContentChecksum`. */
  readonly candles: readonly ManifestCandleContent[];
}

/** Maps one derived candle to the SAME `ManifestCandleContent` shape B-F5/B-F6 already hash/store (exact decimal/bigint strings) -- `bucketEnd`/`availableAt` are deterministic pure functions of `bucketStart` + `targetTimeframeMinutes` (already part of the hashed identity), so they are intentionally not duplicated into the hashed content. */
export function resampledCandleToManifestContent(candle: ResampledCandle): ManifestCandleContent {
  return {
    candleTime: candle.bucketStart.toISOString(),
    open: candle.open.toString(),
    high: candle.high.toString(),
    low: candle.low.toString(),
    close: candle.close.toString(),
    volume: candle.volume.toString(),
    openInterest: candle.openInterest === null ? null : candle.openInterest.toString(),
  };
}

/**
 * Content-addressed derived checksum: full SHA-256 over the source B-F5
 * session identity + `sourceSessionContentChecksum` + resampling semantics
 * version + target timeframe + sorted derived candle content (task section
 * 8). Reuses the SAME `canonicalManifestJson`/`sha256Hex` primitive B-F5
 * already established for exactly this purpose (bigint-safe, Date-safe,
 * ordinal key sort) -- never a new canonicalizer, never a random UUID.
 */
export function computeDerivedContentChecksum(payload: DerivedContentPayload): string {
  const sorted: DerivedContentPayload = { ...payload, candles: sortManifestCandles(payload.candles) };
  return sha256Hex(canonicalManifestJson(sorted));
}

/**
 * Parses one B-F6 `ManifestCandleContent` row (exact decimal/bigint
 * strings, as read back from a Parquet session file via
 * `ResearchLakeParquetReaderService`) into the SAME `PersistedManifestCandleRow`
 * shape a direct DB read already produces. This is the single normalization
 * point that lets `HistoricalCandleResamplerService` treat a DB-shaped
 * source and a Parquet-round-tripped source identically (task section 12) --
 * `Prisma.Decimal`'s own constructor normalizes "100"/"100.0"/"100.00" to
 * the same numeric value regardless of which source string produced it.
 */
export function manifestCandleContentToPersistedRow(content: ManifestCandleContent): PersistedManifestCandleRow {
  return {
    candleTime: new Date(content.candleTime),
    open: new Prisma.Decimal(content.open),
    high: new Prisma.Decimal(content.high),
    low: new Prisma.Decimal(content.low),
    close: new Prisma.Decimal(content.close),
    volume: BigInt(content.volume),
    openInterest: content.openInterest === null ? null : BigInt(content.openInterest),
  };
}
