import { CalendarClassification, Exchange, ExchangeSegment, SessionWindow, SourceDocumentIdentity } from './exchange-calendar.types';

/**
 * Identity of the CERTIFIED coverage version a resolution was answered from
 * (task section 8: "authoritative coverage/version identity" +
 * "source bundle checksum / provenance identity"). Both facts live on one
 * object -- never two independently-nullable fields -- because they are only
 * ever meaningful (or absent) together: a resolution either has certified
 * coverage (and therefore both a version identity and its checksum) or it
 * does not (`UNCERTIFIED`, `coverage: null`, task section 8).
 */
export interface CertifiedCoverageIdentity {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly calendarYear: number;
  readonly version: number;
  readonly coverageFrom: string; // YYYY-MM-DD
  readonly coverageTo: string; // YYYY-MM-DD
  readonly sourceAuthority: string;
  readonly sourceBundleChecksum: string;
}

/**
 * Full answer to `resolveTradingDay(exchange, segment, tradingDate)` (task
 * section 8/9). `coverage` is `null` if and only if `classification` is
 * `UNCERTIFIED` -- for every other classification (including
 * resolver-inferred `REGULAR_SESSION`/`WEEKEND`), `coverage` carries the
 * CERTIFIED coverage identity that made the resolution possible (task
 * section 8: "resolution still carries the certified coverage identity").
 */
export interface TradingDayResolution {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly tradingDate: string; // YYYY-MM-DD
  readonly classification: CalendarClassification;
  /** `null` means authoritative truth is unavailable; it never means certified closed. */
  readonly isTradingDay: boolean | null;
  /** `null` means authoritative truth is unavailable. */
  readonly isSpecialSession: boolean | null;
  /** Non-empty only when `classification === SPECIAL_SESSION`. */
  readonly sessionWindows: readonly SessionWindow[];
  /** Non-null only when this date carries an explicit `ExchangeCalendarDay` row (never populated for inferred `REGULAR_SESSION`/`WEEKEND`). */
  readonly explicitReason: string | null;
  /** Immutable supporting source identity for an explicit exceptional date. */
  readonly sourceDocument: SourceDocumentIdentity | null;
  readonly coverage: CertifiedCoverageIdentity | null;
}
