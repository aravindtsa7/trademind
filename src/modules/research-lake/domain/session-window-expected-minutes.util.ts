import { NIFTY_1M_SOURCE_HORIZON_END_MINUTE } from '../../historical-candles/utils/historical-session-completeness.util';
import { SessionWindow, validateSessionWindow, validateSessionWindows } from './exchange-calendar.types';
import { NORMAL_SESSION_START_MINUTE } from './ist-session-clock';

/**
 * B-F2-CAL-1 Research Lake consumption helper: derives the exact set of
 * expected candle-start minutes-of-day (IST) for one `SessionWindow`, using
 * the calendar core's own half-open `[openMinuteIst, closeMinuteIst)`
 * semantics (`exchange-calendar.types.ts`). Delegates all boundary/shape
 * validation to `validateSessionWindow` rather than re-checking it here, so
 * this helper can never silently accept a window the calendar core itself
 * would reject.
 */
export function expectedMinutesForWindow(window: SessionWindow): readonly number[] {
  validateSessionWindow(window);
  const minutes: number[] = [];
  for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) {
    minutes.push(minute);
  }
  return minutes;
}

/**
 * Deterministic ascending union of expected minutes across every window in
 * `windows` (task section 15: "ordered union of each independent window",
 * gaps between windows never filled). Delegates overlap/duplicate-index/
 * shape validation to `validateSessionWindows` -- overlapping or malformed
 * windows are rejected fail-closed, never silently merged or deduplicated
 * at the minute level. Never mutates the input array (`validateSessionWindows`
 * itself operates on a copy).
 */
export function expectedMinutesForWindows(windows: readonly SessionWindow[]): readonly number[] {
  const orderedWindows = validateSessionWindows(windows);
  const minutes: number[] = [];
  for (const window of orderedWindows) {
    for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) {
      minutes.push(minute);
    }
  }
  return minutes;
}

/**
 * The canonical NIFTY regular-session window, DERIVED (never re-hardcoded)
 * from the two existing constants that already govern the 09:15-15:29 IST
 * contract elsewhere in the codebase: `NORMAL_SESSION_START_MINUTE` (555,
 * `ist-session-clock.ts`) and `NIFTY_1M_SOURCE_HORIZON_END_MINUTE` (929,
 * `historical-session-completeness.util.ts` -- the last INCLUSIVE expected
 * candle-start minute, so the half-open `closeMinuteIst` is that value + 1).
 *
 * SEAM FOR B-F2-CAL-2 / FUTURE CALENDAR-CORE EXTENSION: today,
 * `ExchangeCalendarResolverService.resolveTradingDay` never populates
 * `TradingDayResolution.sessionWindows` for an inferred `REGULAR_SESSION`
 * (only an explicit `SPECIAL_SESSION` row carries windows) -- the calendar
 * core treats "regular trading hours" as an implicit default outside its
 * own certified domain, not a per-date fact it certifies. This function is
 * therefore a RESEARCH-LAKE CONSUMPTION-LAYER default, not calendar-core
 * domain logic, and MUST NOT be moved into `exchange-calendar.types.ts` or
 * treated as calendar-certified truth. If the calendar core is ever
 * extended to certify an explicit per-year "regular session hours" window,
 * B-F2-CAL-2 should replace calls to this function with that certified
 * value instead.
 */
export function regularSessionWindow(): SessionWindow {
  return {
    windowIndex: 0,
    openMinuteIst: NORMAL_SESSION_START_MINUTE,
    closeMinuteIst: NIFTY_1M_SOURCE_HORIZON_END_MINUTE + 1,
  };
}

const MINUTE_MS = 60_000;

/**
 * B-F8 (gap repair) consumption helper: converts an ordered set of
 * minute-of-day (IST) values for one `tradingDate` into the exact ordered
 * set of canonical UTC candle-start `Date` timestamps those minutes denote.
 * Deliberately the SAME arithmetic `DatasetHealthValidatorService.
 * expectedCanonicalMinutes` already uses for its calendar-declared branch
 * (`dayStart + minuteOfDay * MINUTE_MS`) -- exported here as a standalone,
 * additive utility (never a modification of that validator's private
 * method) so `NiftyUnderlyingGapRepairService` can derive the identical
 * authoritative missing-minute timestamp vector without re-deriving its own
 * arithmetic or depending on a private implementation detail of a different
 * service.
 */
export function expectedCanonicalTimestamps(tradingDate: string, expectedMinutesIst: readonly number[]): readonly Date[] {
  const dayStart = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  return expectedMinutesIst.map((minuteOfDay) => new Date(dayStart + minuteOfDay * MINUTE_MS));
}
