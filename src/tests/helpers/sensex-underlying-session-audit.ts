export interface SensexUnderlyingRow {
  instrumentKey: string;
  timeframe: string;
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SensexSessionAudit {
  tradingDate: string;
  earliestIst: string | null;
  latestIst: string | null;
  rowCount: number;
  duplicateTimestamps: string[];
  missingMinuteCount: number;
  gaps: Array<{ afterIst: string; beforeIst: string; missingMinutes: number }>;
  invalidOhlcCount: number;
  weekend: boolean;
  complete: boolean;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(value: Date): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
}

function date(value: Date): string {
  const valueParts = parts(value);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}`;
}

function minute(value: Date): number {
  const valueParts = parts(value);
  return Number(valueParts.hour) * 60 + Number(valueParts.minute);
}

function ist(value: Date): string {
  const valueParts = parts(value);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day} ${valueParts.hour}:${valueParts.minute} IST`;
}

function isoWeekday(tradingDate: string): number {
  return new Date(`${tradingDate}T00:00:00Z`).getUTCDay();
}

function validOhlc(row: SensexUnderlyingRow): boolean {
  return (
    Number.isFinite(row.open) &&
    Number.isFinite(row.high) &&
    Number.isFinite(row.low) &&
    Number.isFinite(row.close) &&
    row.high >= Math.max(row.open, row.close, row.low) &&
    row.low <= Math.min(row.open, row.close, row.high)
  );
}

export function auditSensexUnderlyingSessions(
  rows: readonly SensexUnderlyingRow[],
  instrumentKey: string,
  timeframe: string,
): { sessions: SensexSessionAudit[]; ignoredRows: number; normalSession: { rowCount: number; firstMinute: number; lastMinute: number } | null } {
  const scoped = rows.filter((row) => row.instrumentKey === instrumentKey && row.timeframe === timeframe);
  const byDate = new Map<string, SensexUnderlyingRow[]>();
  scoped.forEach((row) => byDate.set(date(row.candleTime), [...(byDate.get(date(row.candleTime)) ?? []), row]));
  const preliminary = Array.from(byDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tradingDate, sessionRows]) => {
      const ordered = [...sessionRows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
      const first = ordered[0];
      const last = ordered.at(-1);
      const timestamps = new Set<number>();
      const duplicates: string[] = [];
      ordered.forEach((row) => {
        if (timestamps.has(row.candleTime.getTime())) duplicates.push(ist(row.candleTime));
        timestamps.add(row.candleTime.getTime());
      });
      const gaps: SensexSessionAudit['gaps'] = [];
      for (let index = 1; index < ordered.length; index += 1) {
        const difference = ordered[index].candleTime.getTime() - ordered[index - 1].candleTime.getTime();
        if (difference > 60_000)
          gaps.push({
            afterIst: ist(ordered[index - 1].candleTime),
            beforeIst: ist(ordered[index].candleTime),
            missingMinutes: difference / 60_000 - 1,
          });
      }
      return {
        tradingDate,
        earliestIst: first ? ist(first.candleTime) : null,
        latestIst: last ? ist(last.candleTime) : null,
        rowCount: ordered.length,
        duplicateTimestamps: duplicates,
        missingMinuteCount: gaps.reduce((total, gap) => total + gap.missingMinutes, 0),
        gaps,
        invalidOhlcCount: ordered.filter((row) => !validOhlc(row)).length,
        weekend: [0, 6].includes(isoWeekday(tradingDate)),
        firstMinute: first ? minute(first.candleTime) : -1,
        lastMinute: last ? minute(last.candleTime) : -1,
      };
    });
  const shapes = new Map<string, { count: number; rowCount: number; firstMinute: number; lastMinute: number }>();
  preliminary
    .filter((session) => session.duplicateTimestamps.length === 0 && session.missingMinuteCount === 0 && session.invalidOhlcCount === 0)
    .forEach((session) => {
      const key = `${session.rowCount}|${session.firstMinute}|${session.lastMinute}`;
      const current = shapes.get(key) ?? { count: 0, rowCount: session.rowCount, firstMinute: session.firstMinute, lastMinute: session.lastMinute };
      current.count += 1;
      shapes.set(key, current);
    });
  const normalSession = [...shapes.values()].sort((left, right) => right.count - left.count || right.rowCount - left.rowCount)[0] ?? null;
  return {
    ignoredRows: rows.length - scoped.length,
    normalSession: normalSession && { rowCount: normalSession.rowCount, firstMinute: normalSession.firstMinute, lastMinute: normalSession.lastMinute },
    sessions: preliminary.map(({ firstMinute, lastMinute, ...session }) => ({
      ...session,
      complete:
        !!normalSession &&
        session.rowCount === normalSession.rowCount &&
        firstMinute === normalSession.firstMinute &&
        lastMinute === normalSession.lastMinute &&
        session.duplicateTimestamps.length === 0 &&
        session.missingMinuteCount === 0 &&
        session.invalidOhlcCount === 0,
    })),
  };
}

export function calendarWeekdays(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  for (let cursor = new Date(`${fromDate}T00:00:00Z`); cursor <= new Date(`${toDate}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}
