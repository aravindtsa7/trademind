/**
 * Deterministic IST calendar-date/minute-of-day extraction shared by the
 * projector and validator. Mirrors the `Intl.DateTimeFormat`-based approach
 * already established in
 * `historical-candles/utils/historical-session-completeness.util.ts`
 * (`istDate`/`istMinuteOfDay`) rather than inventing a different technique;
 * duplicated locally because that file does not export those helpers, and
 * B-F1 is additive-only with respect to existing historical-candles code.
 */
const istDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const istMinuteFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function istCalendarDate(value: Date): string {
  const parts = Object.fromEntries(istDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function istMinuteOfDay(value: Date): number {
  const parts = Object.fromEntries(istMinuteFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export const NORMAL_SESSION_START_MINUTE = 9 * 60 + 15; // 09:15 IST

/**
 * Full IST calendar-day bounds for `tradingDate` (`YYYY-MM-DD`), expressed as
 * absolute instants. IST has a fixed +05:30 offset (no DST), so an explicit
 * offset string suffices -- no host-timezone dependence (B-F5 task section
 * 2). Used to re-fetch exactly the persisted rows recorded against one
 * trading date for manifest generation/verification, independent of the
 * narrower 09:15-15:29 canonical session window (this covers the whole
 * calendar day, so an unexpected out-of-window row is still detected rather
 * than silently excluded from the re-read).
 */
export function istTradingDayUtcBounds(tradingDate: string): { start: Date; end: Date } {
  return {
    start: new Date(`${tradingDate}T00:00:00.000+05:30`),
    end: new Date(`${tradingDate}T23:59:59.999+05:30`),
  };
}
