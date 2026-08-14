export interface BankNiftyAuditRow {
  instrumentKey: string;
  timeframe: string;
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BankNiftySessionAudit {
  tradingDate: string;
  earliestIst: string | null;
  latestIst: string | null;
  candleCount: number;
  missingMinutes: number;
  duplicateTimestamps: string[];
  outOfSessionTimestamps: string[];
  nonMonotonicTimestamps: string[];
  invalidOhlc: number;
  flatPriceSequenceCount: number;
  complete: boolean;
}

const istFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

export function istDate(value: Date): string { const parts = Object.fromEntries(dateFormatter.formatToParts(value).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
export function istMinute(value: Date): number { const parts = Object.fromEntries(istFormatter.formatToParts(value).map((part) => [part.type, part.value])); return Number(parts.hour) * 60 + Number(parts.minute); }
export function istLabel(value: Date): string { return `${istDate(value)} ${String(Math.floor(istMinute(value) / 60)).padStart(2, '0')}:${String(istMinute(value) % 60).padStart(2, '0')} IST`; }

export function auditBankNiftyUnderlying(rows: readonly BankNiftyAuditRow[], instrumentKey: string, timeframe: string, startDate: string, endDate: string) {
  const scoped = rows.filter((row) => row.instrumentKey === instrumentKey && row.timeframe === timeframe && istDate(row.candleTime) >= startDate && istDate(row.candleTime) <= endDate);
  const byDate = new Map<string, BankNiftyAuditRow[]>();
  scoped.forEach((row) => byDate.set(istDate(row.candleTime), [...(byDate.get(istDate(row.candleTime)) ?? []), row]));
  const sessions = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tradingDate, sourceRows]) => auditSession(tradingDate, sourceRows));
  const cleanShape = sessions.length ? mostCommonShape(sessions) : null;
  sessions.forEach((session) => { session.complete = !!cleanShape && session.candleCount === cleanShape.candleCount && session.earliestMinute === cleanShape.firstMinute && session.latestMinute === cleanShape.lastMinute && session.missingMinutes === 0 && session.duplicateTimestamps.length === 0 && session.outOfSessionTimestamps.length === 0 && session.nonMonotonicTimestamps.length === 0 && session.invalidOhlc === 0; });
  const weekdays = calendarWeekdays(startDate, endDate);
  const datesWithData = new Set(sessions.map((session) => session.tradingDate));
  const cleanDates = sessions.filter((session) => session.complete).map((session) => session.tradingDate);
  return { instrumentKey, timeframe, requestedDateRange: { startDate, endDate }, expectedRegularSession: { firstIstMinute: 555, lastIstMinute: 929, expectedCandles: 375 }, rowsInScope: scoped.length, sessions, datesWithData: [...datesWithData].sort(), cleanSessionCount: cleanDates.length, totalSessionDates: sessions.length, firstUsableTradingDate: cleanDates[0] ?? null, lastUsableTradingDate: cleanDates.at(-1) ?? null, dateGaps: weekdays.filter((date) => !datesWithData.has(date)), zeroDataWeekdays: weekdays.filter((date) => !datesWithData.has(date)), normalSession: cleanShape ? { expectedCandles: cleanShape.candleCount, firstIstMinute: cleanShape.firstMinute, lastIstMinute: cleanShape.lastMinute } : null, invalidOhlcRows: sessions.reduce((sum, session) => sum + session.invalidOhlc, 0), suspiciousFlatPriceSequences: sessions.reduce((sum, session) => sum + session.flatPriceSequenceCount, 0), canDeterministicallyRebuild2m3m5m: sessions.length > 0 && sessions.every((session) => session.complete) };
}

function auditSession(tradingDate: string, sourceRows: readonly BankNiftyAuditRow[]): BankNiftySessionAudit & { earliestMinute: number; latestMinute: number } {
  const source = [...sourceRows]; const ordered = [...source].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()); const expectedStart = 555; const expectedEnd = 929; const timestamps = new Set<number>(); const duplicateTimestamps: string[] = []; const nonMonotonicTimestamps: string[] = [];
  source.forEach((row, index) => { const timestamp = row.candleTime.getTime(); if (timestamps.has(timestamp)) duplicateTimestamps.push(istLabel(row.candleTime)); timestamps.add(timestamp); if (index > 0 && timestamp <= source[index - 1].candleTime.getTime()) nonMonotonicTimestamps.push(istLabel(row.candleTime)); });
  let missingMinutes = 0; for (let index = 1; index < ordered.length; index += 1) { const gap = (ordered[index].candleTime.getTime() - ordered[index - 1].candleTime.getTime()) / 60_000 - 1; if (gap > 0) missingMinutes += gap; }
  const outOfSessionTimestamps = ordered.filter((row) => istMinute(row.candleTime) < expectedStart || istMinute(row.candleTime) > expectedEnd).map((row) => istLabel(row.candleTime));
  let flatPriceSequenceCount = 0; for (let index = 1; index < ordered.length; index += 1) if (ordered[index].open === ordered[index].high && ordered[index].high === ordered[index].low && ordered[index].low === ordered[index].close && ordered[index - 1].close === ordered[index].close) flatPriceSequenceCount += 1;
  return { tradingDate, earliestIst: ordered[0] ? istLabel(ordered[0].candleTime) : null, latestIst: ordered.at(-1) ? istLabel(ordered.at(-1)!.candleTime) : null, candleCount: ordered.length, missingMinutes, duplicateTimestamps, outOfSessionTimestamps, nonMonotonicTimestamps, invalidOhlc: ordered.filter((row) => !Number.isFinite(row.open) || !Number.isFinite(row.high) || !Number.isFinite(row.low) || !Number.isFinite(row.close) || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)).length, flatPriceSequenceCount, complete: false, earliestMinute: ordered[0] ? istMinute(ordered[0].candleTime) : -1, latestMinute: ordered.at(-1) ? istMinute(ordered.at(-1)!.candleTime) : -1 };
}

function mostCommonShape(sessions: readonly (BankNiftySessionAudit & { earliestMinute: number; latestMinute: number })[]) { const counts = new Map<string, { count: number; candleCount: number; firstMinute: number; lastMinute: number }>(); sessions.forEach((session) => { const key = `${session.candleCount}|${session.earliestMinute}|${session.latestMinute}`; const value = counts.get(key) ?? { count: 0, candleCount: session.candleCount, firstMinute: session.earliestMinute, lastMinute: session.latestMinute }; value.count += 1; counts.set(key, value); }); return [...counts.values()].sort((left, right) => right.count - left.count || right.candleCount - left.candleCount)[0] ?? null; }
export function calendarWeekdays(startDate: string, endDate: string): string[] { const dates: string[] = []; for (let cursor = new Date(`${startDate}T00:00:00Z`); cursor <= new Date(`${endDate}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10)); return dates; }
export function reconstructDerivedBarCounts(rows: readonly BankNiftyAuditRow[]) {
  const ordered = [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const continuous = ordered.every((row, index) => index === 0 || row.candleTime.getTime() - ordered[index - 1].candleTime.getTime() === 60_000);
  const result = { '2m': 0, '3m': 0, '5m': 0, continuous, valid: false };
  if (!continuous || ordered.length === 0) return result;
  for (const size of [2, 3, 5] as const) result[`${size}m`] = Math.floor(ordered.length / size);
  result.valid = true;
  return result;
}
export function proposedSplit(dates: readonly string[]) { const ordered = [...new Set(dates)].sort(); if (ordered.length !== 104) return { status: 'NOT_PROPOSED_SESSION_COUNT_IS_NOT_104', sessionCount: ordered.length, dates: ordered }; return { status: 'PROPOSED', policy: { train: 60, embargo1: 3, validation: 20, embargo2: 3, legacyContaminatedHoldout: 18 }, assignments: ordered.map((tradingDate, index) => ({ index, tradingDate, split: index < 60 ? 'TRAIN' : index < 63 ? 'EMBARGO_1' : index < 83 ? 'VALIDATION' : index < 86 ? 'EMBARGO_2' : 'LEGACY_CONTAMINATED_HOLDOUT' })) }; }
