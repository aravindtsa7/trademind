import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import UpstoxHistoricalClient from '../modules/historical-candles/client/upstox-historical.client';
import { UpstoxHistoricalCandleDto } from '../modules/historical-candles/dto/upstox-historical-candle.dto';
import HistoricalCandleRepository, { HistoricalCandleUpsertInput } from '../modules/historical-candles/repositories/historical-candle.repository';
import { auditBankNiftyUnderlying, BankNiftyAuditRow, calendarWeekdays, istDate, istMinute, reconstructDerivedBarCounts } from '../modules/research/banknifty-data-audit';

dotenv.config();
logger.silent = true;

export const BANK_NIFTY_INSTRUMENT = 'NSE_INDEX|Nifty Bank';
export const BANK_NIFTY_TIMEFRAME = '1minute';
export const BANK_NIFTY_FROM = '2026-03-02';
export const BANK_NIFTY_TO = '2026-08-04';
const SESSION_START = 9 * 60 + 15;
const SESSION_END = 15 * 60 + 29;
const ARTIFACT_DIR = 'artifacts/banknifty-data-prep';

interface SessionValidation {
  tradingDate: string;
  classification: 'CLEAN_SESSION' | 'PARTIAL_SESSION' | 'NO_DATA' | 'MARKET_HOLIDAY_OR_UNKNOWN';
  candleCount: number;
  missingMinutes: number;
  duplicateTimestamps: string[];
  invalidOhlc: number;
  unexpectedTimestamps: string[];
  firstIst: string | null;
  lastIst: string | null;
  monotonic: boolean;
  flatPriceSequenceCount: number;
}

interface DownloadStats {
  networkRequests: number;
  retryCount: number;
  successfulSessionFetches: number;
  failedSessionFetches: number;
  rawDownloadedRows: number;
  regularRowsAccepted: number;
  cacheWrites: number;
  insertedRows: number;
  updatedRows: number;
  failedRanges: Array<{ fromDate: string; toDate: string; error: string }>;
}

function rangeDate(fromDate: string, toDate: string): { from: Date; to: Date } {
  return { from: new Date(`${fromDate}T00:00:00+05:30`), to: new Date(`${toDate}T23:59:59.999+05:30`) };
}

function monthChunks(fromDate: string, toDate: string): Array<{ fromDate: string; toDate: string }> {
  const chunks: Array<{ fromDate: string; toDate: string }> = [];
  let cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push({ fromDate: cursor.toISOString().slice(0, 10), toDate: chunkEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function toAuditRow(candle: UpstoxHistoricalCandleDto): BankNiftyAuditRow {
  return { instrumentKey: BANK_NIFTY_INSTRUMENT, timeframe: BANK_NIFTY_TIMEFRAME, candleTime: candle.candleTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
}

function formatIst(candleTime: Date): string {
  const minute = istMinute(candleTime);
  return `${istDate(candleTime)} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST`;
}

function validateSession(tradingDate: string, rows: readonly BankNiftyAuditRow[], rawRows: readonly BankNiftyAuditRow[]): SessionValidation {
  const ordered = [...rows].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  const expected = new Set<number>();
  for (let minute = SESSION_START; minute <= SESSION_END; minute += 1) expected.add(minute);
  const seen = new Map<number, number>();
  const duplicateTimestamps: string[] = [];
  const invalidOhlc = ordered.reduce((count, row) => {
    const minute = istMinute(row.candleTime);
    seen.set(minute, (seen.get(minute) ?? 0) + 1);
    if ((seen.get(minute) ?? 0) > 1) duplicateTimestamps.push(formatIst(row.candleTime));
    return count + (!Number.isFinite(row.open) || !Number.isFinite(row.high) || !Number.isFinite(row.low) || !Number.isFinite(row.close) || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high) || row.high < row.low ? 1 : 0);
  }, 0);
  const missingMinutes = [...expected].filter((minute) => (seen.get(minute) ?? 0) !== 1).length;
  const monotonic = ordered.every((row, index) => index === 0 || row.candleTime.getTime() > ordered[index - 1].candleTime.getTime());
  let flatPriceSequenceCount = 0;
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index].open === ordered[index].high && ordered[index].high === ordered[index].low && ordered[index].low === ordered[index].close && ordered[index - 1].close === ordered[index].close) flatPriceSequenceCount += 1;
  const unexpectedTimestamps = rawRows.filter((row) => istDate(row.candleTime) !== tradingDate || istMinute(row.candleTime) < SESSION_START || istMinute(row.candleTime) > SESSION_END).map((row) => formatIst(row.candleTime));
  const complete = ordered.length === 375 && missingMinutes === 0 && duplicateTimestamps.length === 0 && invalidOhlc === 0 && monotonic && ordered[0] !== undefined && istMinute(ordered[0].candleTime) === SESSION_START && istMinute(ordered.at(-1)!.candleTime) === SESSION_END;
  return { tradingDate, classification: complete ? 'CLEAN_SESSION' : ordered.length === 0 ? 'NO_DATA' : 'PARTIAL_SESSION', candleCount: ordered.length, missingMinutes, duplicateTimestamps, invalidOhlc, unexpectedTimestamps, firstIst: ordered[0] ? formatIst(ordered[0].candleTime) : null, lastIst: ordered.at(-1) ? formatIst(ordered.at(-1)!.candleTime) : null, monotonic, flatPriceSequenceCount };
}

function toUpsert(instrumentKey: string, candle: UpstoxHistoricalCandleDto): HistoricalCandleUpsertInput {
  const { candleTime, open, high, low, close, volume, openInterest } = candle;
  const data = { open, high, low, close, volume, openInterest, source: 'REST' };
  return { create: { instrumentKey, timeframe: BANK_NIFTY_TIMEFRAME, candleTime, ...data }, update: data };
}

async function fetchWithRetry(client: UpstoxHistoricalClient, chunk: { fromDate: string; toDate: string }, stats: DownloadStats): Promise<UpstoxHistoricalCandleDto[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    stats.networkRequests += 1;
    try { return await client.fetchOneMinuteCandles(BANK_NIFTY_INSTRUMENT, chunk.toDate, chunk.fromDate); } catch (error) {
      lastError = error;
      if (attempt < 3) { stats.retryCount += 1; await new Promise((resolve) => setTimeout(resolve, attempt * 500)); }
    }
  }
  throw lastError;
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const client = new UpstoxHistoricalClient(process.env.UPSTOX_ACCESS_TOKEN?.trim());
  const requestedWeekdays = calendarWeekdays(BANK_NIFTY_FROM, BANK_NIFTY_TO);
  const existing = await repository.findRange(BANK_NIFTY_INSTRUMENT, BANK_NIFTY_TIMEFRAME, rangeDate(BANK_NIFTY_FROM, BANK_NIFTY_TO).from, rangeDate(BANK_NIFTY_FROM, BANK_NIFTY_TO).to);
  const existingRows = existing.map((row) => ({ instrumentKey: row.instrumentKey, timeframe: row.timeframe, candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
  const existingAudit = auditBankNiftyUnderlying(existingRows, BANK_NIFTY_INSTRUMENT, BANK_NIFTY_TIMEFRAME, BANK_NIFTY_FROM, BANK_NIFTY_TO);
  const completeDates = new Set(existingAudit.sessions.filter((session) => session.complete && session.candleCount === 375 && session.missingMinutes === 0).map((session) => session.tradingDate));
  const chunks = completeDates.size === 0 ? monthChunks(BANK_NIFTY_FROM, BANK_NIFTY_TO) : requestedWeekdays.filter((date) => !completeDates.has(date)).map((date) => ({ fromDate: date, toDate: date }));
  const stats: DownloadStats = { networkRequests: 0, retryCount: 0, successfulSessionFetches: 0, failedSessionFetches: 0, rawDownloadedRows: 0, regularRowsAccepted: 0, cacheWrites: 0, insertedRows: 0, updatedRows: 0, failedRanges: [] };
  const returnedByDate = new Map<string, BankNiftyAuditRow[]>();
  const rawByDate = new Map<string, BankNiftyAuditRow[]>();
  for (const chunk of chunks) {
    try {
      const candles = await fetchWithRetry(client, chunk, stats);
      stats.rawDownloadedRows += candles.length;
      candles.map(toAuditRow).forEach((row) => {
        const date = istDate(row.candleTime);
        rawByDate.set(date, [...(rawByDate.get(date) ?? []), row]);
        if (date >= BANK_NIFTY_FROM && date <= BANK_NIFTY_TO && istMinute(row.candleTime) >= SESSION_START && istMinute(row.candleTime) <= SESSION_END) returnedByDate.set(date, [...(returnedByDate.get(date) ?? []), row]);
      });
    } catch (error) {
      stats.failedSessionFetches += requestedWeekdays.filter((date) => date >= chunk.fromDate && date <= chunk.toDate && !completeDates.has(date)).length;
      stats.failedRanges.push({ ...chunk, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const validations: SessionValidation[] = [];
  for (const date of requestedWeekdays) validations.push(validateSession(date, returnedByDate.get(date) ?? existingRows.filter((row) => istDate(row.candleTime) === date), rawByDate.get(date) ?? []));
  const cleanDates = validations.filter((session) => session.classification === 'CLEAN_SESSION').map((session) => session.tradingDate);
  for (const date of cleanDates) {
    if (completeDates.has(date)) continue;
    const rows = (returnedByDate.get(date) ?? []).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
    const candles = rows.map((row) => ({ candleTime: row.candleTime, open: row.open, high: row.high, low: row.low, close: row.close, volume: 0n }));
    const existingTimes = new Set(existingRows.filter((row) => istDate(row.candleTime) === date).map((row) => row.candleTime.getTime()));
    const inputs = candles.map((candle) => toUpsert(BANK_NIFTY_INSTRUMENT, candle));
    if (inputs.length) { await repository.bulkUpsert(inputs); stats.cacheWrites += inputs.length; stats.insertedRows += inputs.filter((row) => !existingTimes.has(new Date(row.create.candleTime as Date).getTime())).length; stats.updatedRows += inputs.filter((row) => existingTimes.has(new Date(row.create.candleTime as Date).getTime())).length; stats.regularRowsAccepted += inputs.length; stats.successfulSessionFetches += 1; }
  }
  const finalRows = await repository.findRange(BANK_NIFTY_INSTRUMENT, BANK_NIFTY_TIMEFRAME, rangeDate(BANK_NIFTY_FROM, BANK_NIFTY_TO).from, rangeDate(BANK_NIFTY_FROM, BANK_NIFTY_TO).to);
  const finalAuditRows = finalRows.map((row) => ({ instrumentKey: row.instrumentKey, timeframe: row.timeframe, candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
  const finalAudit = auditBankNiftyUnderlying(finalAuditRows, BANK_NIFTY_INSTRUMENT, BANK_NIFTY_TIMEFRAME, BANK_NIFTY_FROM, BANK_NIFTY_TO);
  const finalValidations = requestedWeekdays.map((date) => validateSession(date, finalAuditRows.filter((row) => istDate(row.candleTime) === date), rawByDate.get(date) ?? []));
  const cleanSessions = finalValidations.filter((session) => session.classification === 'CLEAN_SESSION');
  const partialSessions = finalValidations.filter((session) => session.classification === 'PARTIAL_SESSION');
  const noDataWeekdays = finalValidations.filter((session) => session.classification === 'NO_DATA').map((session) => session.tradingDate);
  const derived = cleanSessions.length === 0 ? { valid: false, sessionCount: 0, countsPerSession: { '2m': 0, '3m': 0, '5m': 0 } } : { valid: cleanSessions.every((session) => { const rows = finalAuditRows.filter((row) => istDate(row.candleTime) === session.tradingDate); return reconstructDerivedBarCounts(rows).valid; }), sessionCount: cleanSessions.length, countsPerSession: reconstructDerivedBarCounts(finalAuditRows.filter((row) => istDate(row.candleTime) === cleanSessions[0].tradingDate)) };
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(`${ARTIFACT_DIR}/download-manifest.json`, JSON.stringify({ instrumentKey: BANK_NIFTY_INSTRUMENT, timeframe: BANK_NIFTY_TIMEFRAME, requestedDateRange: { fromDate: BANK_NIFTY_FROM, toDate: BANK_NIFTY_TO }, plannedChunks: chunks, existingRowsBefore: existing.length, ...stats, noDataWeekdays, failedDates: partialSessions.map((session) => session.tradingDate), filterPolicy: 'persist only 09:15-15:29 IST; out-of-session rows are reported and excluded', idempotent: true }, null, 2));
  await writeFile(`${ARTIFACT_DIR}/session-validation.json`, JSON.stringify({ requestedWeekdays, sessions: finalValidations, weekendsExcluded: true, finalAudit }, null, 2));
  await writeFile(`${ARTIFACT_DIR}/data-quality-summary.json`, JSON.stringify({ instrumentKey: BANK_NIFTY_INSTRUMENT, totalStored1mRows: finalRows.length, firstDownloadedDate: cleanSessions[0]?.tradingDate ?? null, lastDownloadedDate: cleanSessions.at(-1)?.tradingDate ?? null, totalSessionsWithData: finalValidations.filter((session) => session.candleCount > 0).length, cleanSessions: cleanSessions.length, partialOrBadSessions: partialSessions.length, noDataWeekdays, cleanSessionPercentage: requestedWeekdays.length ? (cleanSessions.length / requestedWeekdays.length) * 100 : 0, invalidOhlc: finalValidations.reduce((sum, session) => sum + session.invalidOhlc, 0), duplicateTimestamps: finalValidations.reduce((sum, session) => sum + session.duplicateTimestamps.length, 0), derivedBars: derived, networkRequests: stats.networkRequests, verdict: cleanSessions.length > 0 && partialSessions.length === 0 ? 'READY_FOR_OPTION_AUDIT' : 'NEEDS_DATA_REPAIR' }, null, 2));
  console.log(JSON.stringify({ exactInstrumentKey: BANK_NIFTY_INSTRUMENT, firstDownloadedDate: cleanSessions[0]?.tradingDate ?? null, lastDownloadedDate: cleanSessions.at(-1)?.tradingDate ?? null, totalSessionsWithData: finalValidations.filter((session) => session.candleCount > 0).length, cleanSessions: cleanSessions.length, partialOrBadSessions: partialSessions.length, cleanSessionPercentage: requestedWeekdays.length ? Number(((cleanSessions.length / requestedWeekdays.length) * 100).toFixed(2)) : 0, total1mRows: finalRows.length, networkRequests: stats.networkRequests, successfulSessionFetches: stats.successfulSessionFetches, failedSessionFetches: stats.failedSessionFetches, retryCount: stats.retryCount, downloadedRows: stats.rawDownloadedRows, cacheWrites: stats.cacheWrites, failedDates: partialSessions.map((session) => session.tradingDate), noDataWeekdays, derivedBars: derived, verdict: cleanSessions.length > 0 && partialSessions.length === 0 ? 'READY_FOR_OPTION_AUDIT' : 'NEEDS_DATA_REPAIR' }, null, 2));
}

run().catch((error) => { console.error('BANK NIFTY underlying preparation failed.', error); process.exitCode = 1; });
