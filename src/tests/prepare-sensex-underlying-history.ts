import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalCandleSyncService from '../modules/historical-candles/services/historical-candle-sync.service';
import { auditSensexUnderlyingSessions, calendarWeekdays } from './helpers/sensex-underlying-session-audit';

dotenv.config();
logger.silent = true;

const instrumentKey = 'BSE_INDEX|SENSEX';
const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const fromDate = '2026-03-02';
const toDate = '2026-08-04';

async function reportAudit(repository: HistoricalCandleRepository): Promise<void> {
  const rows = await repository.findRange(
    instrumentKey,
    timeframe,
    new Date(`${fromDate}T00:00:00+05:30`),
    new Date(`${toDate}T23:59:59.999+05:30`),
  );
  const audit = auditSensexUnderlyingSessions(
    rows.map((row) => ({
      instrumentKey: row.instrumentKey,
      timeframe: row.timeframe,
      candleTime: row.candleTime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    })),
    instrumentKey,
    timeframe,
  );
  const niftyRows = await repository.findRange(
    niftyInstrumentKey,
    timeframe,
    new Date(`${fromDate}T00:00:00+05:30`),
    new Date(`${toDate}T23:59:59.999+05:30`),
  );
  const niftyAudit = auditSensexUnderlyingSessions(
    niftyRows.map((row) => ({
      instrumentKey: row.instrumentKey,
      timeframe: row.timeframe,
      candleTime: row.candleTime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    })),
    niftyInstrumentKey,
    timeframe,
  );
  const weekdays = calendarWeekdays(fromDate, toDate);
  const datesWithData = new Set(audit.sessions.map((session) => session.tradingDate));
  const zeroDataWeekdays = weekdays.filter((date) => !datesWithData.has(date));
  const niftyDates = new Set(niftyAudit.sessions.map((session) => session.tradingDate));
  const missingComparedWithNifty = [...niftyDates].filter((date) => !datesWithData.has(date));
  const extraComparedWithNifty = [...datesWithData].filter((date) => !niftyDates.has(date));
  const incomplete = audit.sessions.filter((session) => !session.complete);
  const unusual = audit.sessions.filter(
    (session) =>
      !audit.normalSession ||
      session.rowCount !== audit.normalSession.rowCount ||
      session.missingMinuteCount > 0 ||
      session.duplicateTimestamps.length > 0 ||
      session.invalidOhlcCount > 0,
  );
  const actualRange = audit.sessions.length === 0
    ? null
    : { start: audit.sessions[0].tradingDate, end: audit.sessions.at(-1)?.tradingDate };
  const normalSessionIst = audit.normalSession
    ? {
        rowCount: audit.normalSession.rowCount,
        start: `${String(Math.floor(audit.normalSession.firstMinute / 60)).padStart(2, '0')}:${String(audit.normalSession.firstMinute % 60).padStart(2, '0')} IST`,
        end: `${String(Math.floor(audit.normalSession.lastMinute / 60)).padStart(2, '0')}:${String(audit.normalSession.lastMinute % 60).padStart(2, '0')} IST`,
      }
    : null;
  const ready =
    audit.sessions.length > 0 &&
    audit.normalSession !== null &&
    incomplete.length === 0 &&
    missingComparedWithNifty.length === 0;
  console.log('SENSEX UNDERLYING CACHE', {
    instrumentKey,
    timeframe,
    totalStored1mRows: rows.length,
    earliestCandle: audit.sessions[0]?.earliestIst ?? null,
    latestCandle: audit.sessions.at(-1)?.latestIst ?? null,
    totalSessionDates: audit.sessions.length,
    completeSessions: audit.sessions.filter((session) => session.complete).length,
    incompleteSessions: incomplete.length,
    zeroDataWeekdays,
    dateRangeActuallyAvailable: actualRange,
    normalSessionDerivedFromData: normalSessionIst,
    calendarAlignmentWithNifty: { missingComparedWithNifty, extraComparedWithNifty },
    ignoredNonSensexRows: audit.ignoredRows,
  });
  console.log('SESSION DISTRIBUTION', {
    totalCalendarWeekdays: weekdays.length,
    datesWithData: audit.sessions.map((session) => session.tradingDate),
    incompleteDates: incomplete,
    unusualSessions: unusual,
    zeroDataWeekdays: zeroDataWeekdays.map((date) => ({ date, classification: 'NO_DATA_WEEKDAY' })),
    weekends: Array.from({ length: Math.floor((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000) + 1 }, (_, index) => {
      const date = new Date(`${fromDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index);
      return date;
    }).filter((date) => [0, 6].includes(date.getUTCDay())).map((date) => date.toISOString().slice(0, 10)),
  });
  console.log('SENSEX SESSION AUDIT', audit.sessions);
  console.log(`SENSEX_UNDERLYING_READY_FOR_RESEARCH = ${ready}`);
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const service = new HistoricalCandleSyncService();
  const plan = await service.plan(instrumentKey, fromDate, toDate);
  console.log('SENSEX UNDERLYING DOWNLOAD PLAN', {
    requestedInstrumentKey: instrumentKey,
    requestedTimeframe: timeframe,
    requestedDateRange: { fromDate, toDate },
    existingLocalRows: plan.existingRowCount,
    remoteRequestChunks: plan.chunks,
    writeMode: process.env.SENSEX_UNDERLYING_FILL_AUTHORIZED === 'true',
  });
  if (process.env.SENSEX_UNDERLYING_FILL_AUTHORIZED !== 'true') return;
  const summary = await service.sync(instrumentKey, fromDate, toDate);
  console.log('SENSEX UNDERLYING SYNC', summary);
  await reportAudit(repository);
}

run().catch((error) => {
  console.error('SENSEX underlying preparation failed.', error);
  process.exitCode = 1;
});
