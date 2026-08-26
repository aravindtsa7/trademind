import { HistoricalAssetType } from './historical-asset.types';

/**
 * A single provider-neutral candle row exactly as read from a historical
 * source, before canonical session projection. Distinct from
 * `CanonicalHistoricalCandle`: a source row is not yet known to belong to
 * the declared trading session -- that determination is
 * `CanonicalSessionProjectorService`'s job. Field shape mirrors the
 * established DTOs (`UpstoxHistoricalCandleDto`, `ExpiredOptionCandleDto`)
 * so provider adapters can map into this with no unit/type conversion.
 *
 * `sourceIndex` is the row's position in the caller-supplied source array
 * (0-based); it is carried through to `CanonicalSessionExclusion` so an
 * excluded row remains traceable to exactly where it came from, independent
 * of timestamp collisions.
 */
export interface HistoricalSourceCandleRow {
  readonly sourceIndex: number;
  readonly candleTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
}

/**
 * A candle row confirmed by `CanonicalSessionProjectorService` to fall
 * inside the declared canonical session window. `openInterest` is `null`
 * (never merely absent/optional) both when the asset type has no OI concept
 * (`NIFTY_INDEX`) and when a `NIFTY_OPTION` provider did not supply it --
 * the type never lets "field omitted" and "explicitly no OI" diverge at
 * this boundary.
 */
export interface CanonicalHistoricalCandle {
  readonly assetType: HistoricalAssetType;
  readonly instrumentKey: string;
  readonly candleTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
}
