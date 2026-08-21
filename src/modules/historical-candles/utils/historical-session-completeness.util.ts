const SESSION_ROW_COUNT = 375;
const SESSION_START_MINUTE = 9 * 60 + 15; // 09:15 IST
const SESSION_END_MINUTE = 15 * 60 + 29; // 15:29 IST
const MINUTE_MS = 60_000;

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

export interface HistoricalSessionRow {
  candleTime: Date;
}

function isMinuteAligned(value: Date): boolean {
  const time = value.getTime();
  return Number.isFinite(time) && time % MINUTE_MS === 0;
}

function istDate(value: Date): string {
  const parts = Object.fromEntries(istDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function istMinuteOfDay(value: Date): number {
  const parts = Object.fromEntries(istMinuteFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * Established historical completeness contract for a single NIFTY 1-minute
 * closed session: exactly 375 rows, every timestamp minute-aligned, all on
 * the same IST calendar date, the first row at exactly 09:15 IST, the last
 * at exactly 15:29 IST, and every consecutive pair (sorted ascending)
 * exactly 60,000ms apart -- which alone also rules out any duplicate or
 * gapped timestamp. This mirrors `isV8CompleteClosedSession` in
 * `v8-bullish-reclaim-shadow.service.ts` (same contract, independently
 * defined here rather than imported) so the historical-candle sync path
 * never adds a dependency onto the frozen/protected V8 strategy file.
 */
export function isCompleteHistoricalSession(rows: readonly HistoricalSessionRow[]): boolean {
  if (rows.length !== SESSION_ROW_COUNT) return false;
  const sorted = [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  if (!sorted.every((row) => isMinuteAligned(row.candleTime))) return false;
  const sessionDate = istDate(sorted[0].candleTime);
  if (!sorted.every((row) => istDate(row.candleTime) === sessionDate)) return false;
  if (istMinuteOfDay(sorted[0].candleTime) !== SESSION_START_MINUTE) return false;
  if (istMinuteOfDay(sorted[sorted.length - 1].candleTime) !== SESSION_END_MINUTE) return false;
  return sorted.every(
    (row, index) => index === 0 || row.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === MINUTE_MS
  );
}

export const HISTORICAL_SESSION_ROW_COUNT = SESSION_ROW_COUNT;
