import { HistoricalAssetType } from './historical-asset.types';
import { CanonicalHistoricalCandle, HistoricalSourceCandleRow } from './canonical-historical-candle';
import { SessionWindow } from './exchange-calendar.types';

/**
 * Typed, machine-readable reason a source row was excluded from the
 * canonical session window. Primary reason contract for exclusions --
 * explanatory strings are never the source of truth.
 *
 * `PRE_MARKET_ROW` / `POST_SOURCE_ROW` / `POST_MARKET_ROW` all describe rows
 * on the *same* IST calendar date as the declared trading date but outside
 * the 09:15-15:29 canonical minute window; `OUTSIDE_DECLARED_SESSION`
 * describes a row on a *different* IST calendar date entirely (cross-session
 * contamination). `POST_SOURCE_ROW` vs `POST_MARKET_ROW` preserves the
 * existing, already-authoritative distinction from
 * `historical-session-completeness.util.ts`: for `NIFTY_INDEX`, no
 * NSE_INDEX|Nifty 50 candle of any kind exists past 15:29 IST for any
 * trading day (`NIFTY_1M_SOURCE_HORIZON_END_MINUTE`) -- a late row there is
 * a *source-horizon* violation. `NIFTY_OPTION` has no such documented
 * source-horizon guarantee, so a late option row is classified as the more
 * general `POST_MARKET_ROW` instead.
 */
export enum CanonicalExclusionReason {
  PRE_MARKET_ROW = 'PRE_MARKET_ROW',
  POST_SOURCE_ROW = 'POST_SOURCE_ROW',
  POST_MARKET_ROW = 'POST_MARKET_ROW',
  OUTSIDE_DECLARED_SESSION = 'OUTSIDE_DECLARED_SESSION',
  /**
   * B-F2-CAL-2: a row on the correct IST trading date but outside every
   * `SessionWindow` a `CALENDAR_DECLARED_SESSION` declared -- e.g. a candle
   * falling in the [600,690) gap between a multi-window special session's
   * two windows. This is the typed quality classification for "provider
   * returned data outside the certified calendar session windows" (task
   * section 16): the row is retained as excluded evidence, never silently
   * accepted into the canonical/persisted set and never silently dropped.
   */
  OUTSIDE_CALENDAR_SESSION_WINDOW = 'OUTSIDE_CALENDAR_SESSION_WINDOW',
}

/**
 * Whether the caller is declaring this a normal NIFTY session (the
 * 09:15-15:29 IST / 375-row contract applies) or an undeclared
 * special/non-standard session. B-F1 does not implement the special-session
 * registry (which trading dates are special is not yet known
 * automatically) -- the caller must say so explicitly via this
 * declaration so the projector never silently forces a special session
 * through the normal-session contract.
 */
export enum CanonicalSessionDeclaration {
  NORMAL_NIFTY_SESSION = 'NORMAL_NIFTY_SESSION',
  UNDECLARED_SPECIAL_SESSION = 'UNDECLARED_SPECIAL_SESSION',
  /**
   * B-F2-CAL-2: the caller supplies the EXACT certified `SessionWindow`s for
   * this trading date (from `ExchangeCalendarResolverService`/
   * `NiftyUnderlyingIngestionPlannerService` -- one authoritative source,
   * never re-derived here), via `CanonicalSessionProjectionRequest.
   * sessionWindows`. Used for BOTH a certified regular day (windows =
   * `[regularSessionWindow()]`) and a certified special day (windows = the
   * calendar's explicit, possibly multi-window, set) so there is exactly one
   * per-row classification code path for every calendar-resolved date,
   * rather than a second implicit 09:15-15:29 derivation living alongside
   * the calendar's own truth.
   */
  CALENDAR_DECLARED_SESSION = 'CALENDAR_DECLARED_SESSION',
}

export enum CanonicalSessionProjectionOutcome {
  NORMAL_SESSION_PROJECTED = 'NORMAL_SESSION_PROJECTED',
  SPECIAL_SESSION_EXCLUDED = 'SPECIAL_SESSION_EXCLUDED',
}

/**
 * Audit evidence for one excluded source row: enough to reconstruct why it
 * was excluded without re-deriving it, and to trace it back to its original
 * position in the caller-supplied array.
 */
export interface CanonicalSessionExclusion {
  readonly sourceIndex: number;
  readonly candleTime: Date;
  readonly reason: CanonicalExclusionReason;
}

/**
 * A single-member reason enum, deliberately separate from
 * `DatasetHealthIssueReason` (which would create a circular import between
 * this file and `dataset-health.types.ts`). `DatasetHealthValidatorService`
 * translates this into its own `DatasetHealthIssueReason.NON_MONOTONIC_ORDER`
 * issue -- the two are the same concept, detected at two different layers.
 */
export enum CanonicalSourceOrderAnomalyReason {
  NON_MONOTONIC_ORDER = 'NON_MONOTONIC_ORDER',
}

/**
 * Evidence that two chronologically-adjacent rows in the RAW provider
 * response (as given, before any sorting) were out of order. `acceptedRows`
 * may still be sorted ascending for downstream convenience (see below) --
 * this is the only place that evidence survives that a provider actually
 * delivered rows out of order, which a validator working only from sorted
 * `acceptedRows` could never reconstruct.
 */
export interface CanonicalSourceOrderAnomaly {
  readonly reason: CanonicalSourceOrderAnomalyReason;
  readonly sourceIndex: number;
  readonly previousSourceCandleTime: Date;
  readonly currentSourceCandleTime: Date;
}

export interface CanonicalSessionProjectionRequest {
  readonly assetType: HistoricalAssetType;
  readonly instrumentKey: string;
  /** Declared IST trading date (YYYY-MM-DD) this projection is for. */
  readonly tradingDate: string;
  readonly sessionDeclaration: CanonicalSessionDeclaration;
  /**
   * Required (and non-empty) if and only if `sessionDeclaration ===
   * CALENDAR_DECLARED_SESSION`; ignored for every other declaration. Passed
   * through `validateSessionWindows` (task section 6 half-open/overlap
   * rules) before use, so a malformed set fails closed rather than silently
   * projecting against an unchecked window shape.
   */
  readonly sessionWindows?: readonly SessionWindow[];
  readonly sourceRows: readonly HistoricalSourceCandleRow[];
}

/**
 * Result of projecting raw source rows onto the declared canonical session.
 * When `outcome` is `SPECIAL_SESSION_EXCLUDED`, `acceptedRows` and
 * `excludedRows` are both empty -- the projector deliberately makes no
 * per-row window judgement for an undeclared special session, since the
 * normal-session window it would otherwise apply does not necessarily hold.
 *
 * `acceptedRows` and `excludedRows` are each sorted deterministically
 * ascending by `candleTime`, tie-broken by `sourceIndex`, regardless of the
 * order `sourceRows` arrived in. `sourceOrderAnomalies` is the exception --
 * it is evidence ABOUT the raw arrival order itself, so it is never sorted
 * away; it is always empty for `SPECIAL_SESSION_EXCLUDED`, since no per-row
 * judgement is made there at all.
 */
export interface CanonicalSessionProjectionResult {
  readonly outcome: CanonicalSessionProjectionOutcome;
  readonly assetType: HistoricalAssetType;
  readonly instrumentKey: string;
  readonly tradingDate: string;
  readonly sourceRowCount: number;
  readonly acceptedRows: readonly CanonicalHistoricalCandle[];
  readonly excludedRows: readonly CanonicalSessionExclusion[];
  readonly sourceOrderAnomalies: readonly CanonicalSourceOrderAnomaly[];
}
