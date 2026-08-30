import { istCalendarDate, istMinuteOfDay } from './ist-session-clock';

export interface CalendarSessionCompletenessRow {
  readonly candleTime: Date;
}

/**
 * Calendar-aware generalization of `isCompleteHistoricalSession`
 * (`historical-candles/utils/historical-session-completeness.util.ts`) for a
 * trading date whose expected minute set is NOT the fixed 09:15-15:29/375
 * regular contract -- i.e. a `SPECIAL_SESSION_DAY` (task B-F2-CAL-2 section
 * 11/29/30: single- or multi-window special sessions with an arbitrary
 * expected-minute count).
 *
 * Deliberately NOT a replacement for `isCompleteHistoricalSession`: that
 * function stays the authoritative completeness contract for
 * `REGULAR_TRADING_DAY` (task section 22 -- must not disturb already
 * persisted 2026 regular-session data or the frozen 375-row contract other
 * callers, e.g. the V8 strategy shadow service, depend on). This function is
 * used ONLY for the `SPECIAL_SESSION_DAY` path, where `expectedMinutesIst`
 * comes directly from the certified `ExchangeCalendar` plan (never
 * re-derived here).
 *
 * "Complete" means: exactly one row per minute in `expectedMinutesIst`, no
 * duplicates, no rows on a different IST calendar date, and no rows outside
 * the expected minute set -- mirroring `isCompleteHistoricalSession`'s
 * exactness (never a superset/subset match).
 */
export function isCompleteCalendarSession(
  rows: readonly CalendarSessionCompletenessRow[],
  tradingDate: string,
  expectedMinutesIst: readonly number[]
): boolean {
  if (expectedMinutesIst.length === 0) return false;
  if (rows.length !== expectedMinutesIst.length) return false;

  const expected = new Set(expectedMinutesIst);
  const seen = new Set<number>();
  for (const row of rows) {
    if (istCalendarDate(row.candleTime) !== tradingDate) return false;
    const minute = istMinuteOfDay(row.candleTime);
    if (!expected.has(minute)) return false;
    if (seen.has(minute)) return false;
    seen.add(minute);
  }
  return seen.size === expectedMinutesIst.length;
}
