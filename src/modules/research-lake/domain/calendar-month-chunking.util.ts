/** A [fromDate, toDate] pair, both inclusive, `YYYY-MM-DD` (IST calendar date). */
export interface CalendarDateRange {
  readonly fromDate: string;
  readonly toDate: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertValidDate(field: string, value: string): RegExpExecArray {
  const match = DATE_PATTERN.exec(value);
  if (!match || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date; received '${value}'.`);
  }
  return match;
}

function calendarMonthEndDate(date: string): string {
  const match = assertValidDate('date', date);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Splits `[fromDate, toDate]` into calendar-month chunks, each never
 * spanning more than one calendar month (matching the Upstox 1-minute
 * provider's documented maximum request date span). Independently
 * implemented rather than imported from
 * `HistoricalCandleSyncService.splitIntoMonthlyChunks` -- that method is
 * private, and this task must not modify the existing operational sync
 * service. Deterministic, pure, no wall-clock dependency; never produces
 * overlapping or gapped chunks.
 *
 * Examples:
 *   ('2022-01-01', '2022-03-15') -> [Jan 1-31, Feb 1-28, Mar 1-15]
 *   ('2024-01-15', '2024-02-10') -> [Jan 15-31, Feb 1-10]  (2024 is a leap year; Feb still ends on the 29th when the chunk covers it)
 */
export function splitIntoCalendarMonthChunks(fromDate: string, toDate: string): CalendarDateRange[] {
  assertValidDate('fromDate', fromDate);
  assertValidDate('toDate', toDate);
  if (fromDate > toDate) {
    throw new Error(`fromDate (${fromDate}) must not be after toDate (${toDate}).`);
  }

  const chunks: CalendarDateRange[] = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const monthEnd = calendarMonthEndDate(cursor);
    const chunkEnd = monthEnd < toDate ? monthEnd : toDate;
    chunks.push({ fromDate: cursor, toDate: chunkEnd });
    cursor = shiftDate(chunkEnd, 1);
  }
  return chunks;
}
