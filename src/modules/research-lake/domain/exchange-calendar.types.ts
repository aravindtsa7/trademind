import { parseExchangeCalendarDate } from './exchange-calendar-date';

/**
 * B-F7A CORE: provider-agnostic exchange/segment/classification vocabulary
 * for the authoritative trading-calendar domain. Deliberately NOT coupled to
 * Upstox/Groww identifiers (task section 3) -- these are stable exchange
 * concepts that outlive any one broker/provider integration.
 */
export enum Exchange {
  NSE = 'NSE',
}

export enum ExchangeSegment {
  EQUITY = 'EQUITY',
  EQUITY_DERIVATIVES = 'EQUITY_DERIVATIVES',
}

/**
 * Statuses a coverage version can carry (task section 4). Only `CERTIFIED`
 * coverage is ever resolvable as authoritative -- `DRAFT` and `DEPRECATED`
 * both resolve as `UNCERTIFIED` from the default resolver (task section
 * 13.F/13.G). Fixture import is DRAFT-only. The repository's audited
 * activation transaction is the sole path from DRAFT to CERTIFIED and
 * atomically deprecates any previously-certified version for the same
 * exchange/segment/calendarYear scope.
 */
export enum CalendarCoverageStatus {
  DRAFT = 'DRAFT',
  CERTIFIED = 'CERTIFIED',
  DEPRECATED = 'DEPRECATED',
}

/**
 * Classifications that can be AUTHORITATIVELY DECLARED via an explicit
 * `ExchangeCalendarDay` row. `WEEKEND` and `UNCERTIFIED` are deliberately
 * excluded from this type -- they are never persisted, only ever inferred by
 * the resolver (task section 1: "generic Saturday/Sunday closure only when no
 * explicit authoritative override exists" / "calendar truth is unavailable").
 */
export enum ExplicitCalendarClassification {
  REGULAR_SESSION = 'REGULAR_SESSION',
  EXCHANGE_HOLIDAY = 'EXCHANGE_HOLIDAY',
  SPECIAL_SESSION = 'SPECIAL_SESSION',
  EXCEPTIONAL_CLOSURE = 'EXCEPTIONAL_CLOSURE',
}

/**
 * The full resolved classification set a `resolveTradingDay` call can return
 * (task section 1). Superset of `ExplicitCalendarClassification` plus the two
 * resolver-inferred values.
 */
export enum CalendarClassification {
  REGULAR_SESSION = 'REGULAR_SESSION',
  EXCHANGE_HOLIDAY = 'EXCHANGE_HOLIDAY',
  SPECIAL_SESSION = 'SPECIAL_SESSION',
  EXCEPTIONAL_CLOSURE = 'EXCEPTIONAL_CLOSURE',
  WEEKEND = 'WEEKEND',
  UNCERTIFIED = 'UNCERTIFIED',
}

/**
 * Normalized provenance-document kind (task section 5: "smallest safe
 * provenance model", multiple documents per coverage version). `OTHER` exists
 * so the importer never has to reject a document whose kind does not fit the
 * anticipated NSE circular taxonomy -- it must still be traceable, just not
 * strongly typed beyond "not one of the known kinds".
 */
export enum SourceDocumentType {
  ANNUAL_HOLIDAY_CIRCULAR = 'ANNUAL_HOLIDAY_CIRCULAR',
  AMENDMENT = 'AMENDMENT',
  EXTRAORDINARY_CLOSURE_NOTICE = 'EXTRAORDINARY_CLOSURE_NOTICE',
  SPECIAL_SESSION_CIRCULAR = 'SPECIAL_SESSION_CIRCULAR',
  OTHER = 'OTHER',
}

/**
 * One deterministic trading window for an explicit `SPECIAL_SESSION` day
 * (task section 6). `openMinuteIst`/`closeMinuteIst` are minutes-since-IST-
 * midnight -- the sole canonical representation (never duplicated as a
 * `"HH:mm"` string field; use `formatMinuteOfDayIst` below to derive a
 * presentation form on demand).
 *
 * BOUNDARY SEMANTICS (task section 6, "define clearly"): `closeMinuteIst` is
 * an EXCLUSIVE session boundary, not an inclusive candle-start minute. A
 * window `{ openMinuteIst: 555, closeMinuteIst: 615 }` means candle-start
 * minutes 555..614 (09:15..10:14 IST) belong to this window; minute 615
 * (10:15) does not. This mirrors the conventional half-open
 * `[open, close)` interval and keeps adjacent windows' boundaries
 * non-ambiguous (one window's `closeMinuteIst` may equal the next window's
 * `openMinuteIst` without overlapping).
 */
export interface SessionWindow {
  readonly windowIndex: number;
  readonly openMinuteIst: number;
  readonly closeMinuteIst: number;
}

/**
 * Explicit, calendar-authoritative session windows for a set of trading
 * dates, keyed by `YYYY-MM-DD`. Domain-neutral (not manifest-specific,
 * not acquisition-specific): the single shared shape every calendar-aware
 * consumer of `SessionWindow` data uses -- `DatasetManifestService`/
 * `DatasetSessionManifestBuilderService` (manifest health scoring),
 * `GrowwOptionCandleAcquisitionService` (option session projection/health),
 * and `ResearchYearRunnerService` (manifest generation from acquisition
 * output) -- so there is exactly one "session windows by date" contract
 * rather than each consumer inventing its own.
 */
export type CalendarSessionWindowsByDate = Readonly<Record<string, readonly SessionWindow[]>>;

export interface SourceDocumentIdentity {
  readonly documentReference: string;
  readonly documentType: SourceDocumentType;
  readonly contentChecksumSha256: string;
  readonly referenceUrl: string | null;
}

const SOURCE_DOCUMENT_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Single shared runtime rule set for source-document identity fields, used by
 * BOTH fixture/import validation and repository persisted-read validation so
 * the two paths cannot silently diverge (B-F7A provenance fail-closed
 * correction). `documentReference` must be non-blank after trimming (but is
 * never itself trimmed/repaired -- callers reject, they do not sanitize);
 * `documentType` must be a real `SourceDocumentType` member, never an
 * unchecked cast; `contentChecksumSha256` must be exactly 64 lowercase hex
 * characters.
 */
export function isValidSourceDocumentReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidSourceDocumentType(value: unknown): value is SourceDocumentType {
  return typeof value === 'string' && Object.values(SourceDocumentType).includes(value as SourceDocumentType);
}

export function isValidSourceDocumentChecksum(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_DOCUMENT_CHECKSUM_PATTERN.test(value);
}

export function isValidSourceDocumentIdentityShape(candidate: {
  readonly documentReference: unknown;
  readonly documentType: unknown;
  readonly contentChecksumSha256: unknown;
}): candidate is { documentReference: string; documentType: SourceDocumentType; contentChecksumSha256: string } {
  return (
    isValidSourceDocumentReference(candidate.documentReference) &&
    isValidSourceDocumentType(candidate.documentType) &&
    isValidSourceDocumentChecksum(candidate.contentChecksumSha256)
  );
}

const MINUTES_PER_DAY = 24 * 60;

export class ExchangeCalendarWindowInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarWindowInvariantError';
  }
}

/** Derives a `"HH:mm"` presentation string from a minute-of-day value. Never persisted -- see `SessionWindow` doc. */
export function formatMinuteOfDayIst(minuteOfDay: number): string {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > MINUTES_PER_DAY) {
    throw new ExchangeCalendarWindowInvariantError(`formatMinuteOfDayIst: ${minuteOfDay} is not a valid minute-of-day (expected an integer in [0, ${MINUTES_PER_DAY}]).`);
  }
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Validates one window's own boundary invariants (task section 6):
 * `0 <= openMinuteIst < 1440`, `0 < closeMinuteIst <= 1440`,
 * `openMinuteIst < closeMinuteIst`. Does NOT check cross-window overlap or
 * duplicate `windowIndex` -- see `validateSessionWindows` for the set-level
 * invariants.
 */
export function validateSessionWindow(window: SessionWindow): void {
  if (!Number.isInteger(window.windowIndex) || window.windowIndex < 0) {
    throw new ExchangeCalendarWindowInvariantError(`Session window has an invalid windowIndex ${window.windowIndex}: must be a non-negative integer.`);
  }
  if (!Number.isInteger(window.openMinuteIst) || window.openMinuteIst < 0 || window.openMinuteIst >= MINUTES_PER_DAY) {
    throw new ExchangeCalendarWindowInvariantError(`Session window ${window.windowIndex} has an invalid openMinuteIst ${window.openMinuteIst}: must satisfy 0 <= openMinuteIst < ${MINUTES_PER_DAY}.`);
  }
  if (!Number.isInteger(window.closeMinuteIst) || window.closeMinuteIst <= 0 || window.closeMinuteIst > MINUTES_PER_DAY) {
    throw new ExchangeCalendarWindowInvariantError(`Session window ${window.windowIndex} has an invalid closeMinuteIst ${window.closeMinuteIst}: must satisfy 0 < closeMinuteIst <= ${MINUTES_PER_DAY}.`);
  }
  if (window.openMinuteIst >= window.closeMinuteIst) {
    throw new ExchangeCalendarWindowInvariantError(`Session window ${window.windowIndex} has openMinuteIst (${window.openMinuteIst}) >= closeMinuteIst (${window.closeMinuteIst}); a window must have a strictly positive duration.`);
  }
}

/**
 * Validates the FULL set of a day's session windows (task section 6):
 * unique `windowIndex`, no overlap, and DETERMINISTIC ORDER -- defined here
 * as "ascending `windowIndex` corresponds to non-decreasing time": sorting by
 * `windowIndex` must already yield chronological (non-overlapping,
 * non-decreasing) windows. This ties "deterministic order" to a concrete,
 * checkable rule rather than leaving `windowIndex` a free-floating label
 * unrelated to actual window timing.
 *
 * Returns the windows sorted ascending by `windowIndex` (the canonical
 * storage/hashing order) -- callers should use the returned array, not the
 * input array, downstream.
 */
export function validateSessionWindows(windows: readonly SessionWindow[]): SessionWindow[] {
  for (const window of windows) validateSessionWindow(window);

  const seenIndexes = new Set<number>();
  for (const window of windows) {
    if (seenIndexes.has(window.windowIndex)) {
      throw new ExchangeCalendarWindowInvariantError(`Duplicate windowIndex ${window.windowIndex} in session window set.`);
    }
    seenIndexes.add(window.windowIndex);
  }

  const sorted = [...windows].sort((left, right) => left.windowIndex - right.windowIndex);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.openMinuteIst < previous.closeMinuteIst) {
      throw new ExchangeCalendarWindowInvariantError(
        `Session windows overlap or are out of deterministic windowIndex order: window ${previous.windowIndex} [${previous.openMinuteIst}, ${previous.closeMinuteIst}) and window ${current.windowIndex} [${current.openMinuteIst}, ${current.closeMinuteIst}) are not disjoint and ordered.`
      );
    }
  }
  return sorted;
}

/**
 * Deterministic IST calendar weekday test over a `YYYY-MM-DD` string,
 * independent of host timezone (parses the string directly rather than
 * constructing a host-local `Date`). Used ONLY as the fallback when no
 * explicit `ExchangeCalendarDay` row exists for a certified-covered date
 * (task section 1/2 precedence: explicit definition always wins over this
 * inference).
 */
export function isWeekend(tradingDate: string): boolean {
  const { year, month, day } = parseExchangeCalendarDate(tradingDate, 'isWeekend date');
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  const dayOfWeek = date.getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}
