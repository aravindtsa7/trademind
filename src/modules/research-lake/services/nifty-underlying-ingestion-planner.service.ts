import {
  CalendarClassification,
  CertifiedCoverageIdentity,
  Exchange,
  ExchangeSegment,
  SessionWindow,
  SourceDocumentIdentity,
  TradingDayResolution,
} from '../domain';
import { CalendarDateRange, splitIntoCalendarMonthChunks } from '../domain/calendar-month-chunking.util';
import { ExchangeCalendarDateInvariantError, parseExchangeCalendarDate } from '../domain/exchange-calendar-date';
import { expectedMinutesForWindow, expectedMinutesForWindows, regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import { NIFTY_INDEX_INSTRUMENT_KEY } from './nifty-underlying-acquisition.service';

/**
 * The certified calendar identity that governs the NIFTY 50 UNDERLYING/INDEX
 * trading session, locked here rather than left caller-configurable (task
 * B-F2-CAL-1 section 7/27: "locked by test").
 *
 * RATIONALE (no contradicting repository evidence found -- see the B-F2-CAL-1
 * final report section 4): the NIFTY 50 index level is computed from its
 * constituent stocks, which trade on the `EQUITY` segment; the index only
 * moves when the `EQUITY` segment is open. `EQUITY_DERIVATIVES` governs NIFTY
 * *options/futures contracts* (a later, separate milestone -- task section
 * 7), not the underlying index itself. This repository's own certified 2024
 * NSE source-document evidence
 * (`domain/data/nse-2024-source-manifest.json`) confirms `EQUITY` and
 * `EQUITY_DERIVATIVES` are genuinely independent applicability domains for
 * individual circulars (some circulars apply to only one segment), so this
 * choice is not a cosmetic rename and must stay explicit.
 */
export const NIFTY_UNDERLYING_CALENDAR_EXCHANGE = Exchange.NSE;
export const NIFTY_UNDERLYING_CALENDAR_SEGMENT = ExchangeSegment.EQUITY;

export class NiftyIngestionPlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NiftyIngestionPlanInputError';
  }
}

export interface NiftyIngestionPlanRequest {
  /** Required, YYYY-MM-DD. Never implicitly defaulted -- no "today", no "current year", no open-ended range. */
  readonly fromDate: string;
  /** Required, YYYY-MM-DD. */
  readonly toDate: string;
}

export enum NiftyPlannedDateDisposition {
  REGULAR_TRADING_DAY = 'REGULAR_TRADING_DAY',
  SPECIAL_SESSION_DAY = 'SPECIAL_SESSION_DAY',
  CLOSED_HOLIDAY = 'CLOSED_HOLIDAY',
  CLOSED_EXCEPTIONAL = 'CLOSED_EXCEPTIONAL',
  CLOSED_WEEKEND = 'CLOSED_WEEKEND',
  /** Authoritative calendar truth is unavailable for this date -- NEVER equivalent to "market closed" or "market open". */
  BLOCKED_UNCERTIFIED = 'BLOCKED_UNCERTIFIED',
}

export interface NiftyPlannedDate {
  readonly tradingDate: string;
  readonly disposition: NiftyPlannedDateDisposition;
  readonly expectedMinuteCount: number;
  /** Ascending minute-of-day (IST) values; always `[]` for every closed or blocked disposition. */
  readonly expectedMinutesIst: readonly number[];
  /** `[]` unless `SPECIAL_SESSION_DAY` (calendar-declared windows, verbatim) or `REGULAR_TRADING_DAY` (the derived canonical window, see `regularSessionWindow`). */
  readonly sessionWindows: readonly SessionWindow[];
  readonly explicitReason: string | null;
  /** `null` if and only if `disposition === BLOCKED_UNCERTIFIED` (mirrors `TradingDayResolution.coverage`). */
  readonly calendarCoverage: CertifiedCoverageIdentity | null;
  readonly sourceDocument: SourceDocumentIdentity | null;
}

export interface NiftyIngestionPlan {
  readonly instrumentKey: string;
  readonly exchange: Exchange;
  readonly calendarSegment: ExchangeSegment;
  readonly requestedFromDate: string;
  readonly requestedToDate: string;
  readonly dates: readonly NiftyPlannedDate[];
  /**
   * Deterministic calendar-month provider request-BOUNDARY candidates (from
   * `splitIntoCalendarMonthChunks`, unchanged). This does NOT imply every
   * date inside a chunk is fetch-eligible -- a chunk may contain closed or
   * blocked dates. Consult `dates[].disposition` (or the summary counts
   * below) to determine which individual dates are actually
   * REGULAR_TRADING_DAY/SPECIAL_SESSION_DAY fetch candidates.
   */
  readonly providerRequestChunks: readonly CalendarDateRange[];
  readonly totalCalendarDateCount: number;
  readonly totalExpectedCandles: number;
  readonly regularTradingDateCount: number;
  readonly specialSessionDateCount: number;
  readonly closedDateCount: number;
  readonly blockedDateCount: number;
  readonly hasBlockedDates: boolean;
}

export interface NiftyUnderlyingIngestionPlannerServiceDependencies {
  readonly calendarResolver?: ExchangeCalendarResolverService;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CLOSED_DISPOSITIONS: ReadonlySet<NiftyPlannedDateDisposition> = new Set([
  NiftyPlannedDateDisposition.CLOSED_HOLIDAY,
  NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL,
  NiftyPlannedDateDisposition.CLOSED_WEEKEND,
]);

/**
 * B-F2-CAL-1: calendar-aware, provider-neutral, side-effect-free NIFTY
 * underlying ingestion planner. Consumes ONLY the certified
 * `ExchangeCalendarResolverService` (a single read-only `resolveRange` call)
 * and the existing `splitIntoCalendarMonthChunks` planner. Deliberately has
 * no dependency, direct or transitive, on any historical-data provider
 * adapter, any broker HTTP client, or any candle persistence repository --
 * this is the entire point of the slice (task section 20/21), enforced by a
 * source-text regression test in this file's `.test.ts`. This class MUST
 * NOT be extended with any such dependency; wiring a provider or a
 * persistence path in is explicitly a later, separate slice.
 */
export default class NiftyUnderlyingIngestionPlannerService {
  private readonly calendarResolver: ExchangeCalendarResolverService;

  constructor(dependencies: NiftyUnderlyingIngestionPlannerServiceDependencies = {}) {
    this.calendarResolver = dependencies.calendarResolver ?? new ExchangeCalendarResolverService();
  }

  async buildPlan(request: NiftyIngestionPlanRequest): Promise<NiftyIngestionPlan> {
    this.assertValidDate('fromDate', request.fromDate);
    this.assertValidDate('toDate', request.toDate);
    if (request.fromDate > request.toDate) {
      throw new NiftyIngestionPlanInputError(`fromDate (${request.fromDate}) must not be after toDate (${request.toDate}).`);
    }

    const resolutions = await this.calendarResolver.resolveRange(
      NIFTY_UNDERLYING_CALENDAR_EXCHANGE,
      NIFTY_UNDERLYING_CALENDAR_SEGMENT,
      request.fromDate,
      request.toDate
    );

    const dates = resolutions.map((resolution) => this.toPlannedDate(resolution));
    const providerRequestChunks = splitIntoCalendarMonthChunks(request.fromDate, request.toDate);

    const regularTradingDateCount = dates.filter((date) => date.disposition === NiftyPlannedDateDisposition.REGULAR_TRADING_DAY).length;
    const specialSessionDateCount = dates.filter((date) => date.disposition === NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY).length;
    const closedDateCount = dates.filter((date) => CLOSED_DISPOSITIONS.has(date.disposition)).length;
    const blockedDateCount = dates.filter((date) => date.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED).length;
    const totalExpectedCandles = dates.reduce((sum, date) => sum + date.expectedMinuteCount, 0);

    return {
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      exchange: NIFTY_UNDERLYING_CALENDAR_EXCHANGE,
      calendarSegment: NIFTY_UNDERLYING_CALENDAR_SEGMENT,
      requestedFromDate: request.fromDate,
      requestedToDate: request.toDate,
      dates,
      providerRequestChunks,
      totalCalendarDateCount: dates.length,
      totalExpectedCandles,
      regularTradingDateCount,
      specialSessionDateCount,
      closedDateCount,
      blockedDateCount,
      hasBlockedDates: blockedDateCount > 0,
    };
  }

  private toPlannedDate(resolution: TradingDayResolution): NiftyPlannedDate {
    const disposition = this.toDisposition(resolution.classification);
    const { sessionWindows, expectedMinutesIst } = this.expectedWindowsAndMinutes(disposition, resolution);

    return {
      tradingDate: resolution.tradingDate,
      disposition,
      expectedMinuteCount: expectedMinutesIst.length,
      expectedMinutesIst,
      sessionWindows,
      explicitReason: resolution.explicitReason,
      calendarCoverage: resolution.coverage,
      sourceDocument: resolution.sourceDocument,
    };
  }

  private toDisposition(classification: CalendarClassification): NiftyPlannedDateDisposition {
    switch (classification) {
      case CalendarClassification.REGULAR_SESSION:
        return NiftyPlannedDateDisposition.REGULAR_TRADING_DAY;
      case CalendarClassification.SPECIAL_SESSION:
        return NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY;
      case CalendarClassification.EXCHANGE_HOLIDAY:
        return NiftyPlannedDateDisposition.CLOSED_HOLIDAY;
      case CalendarClassification.EXCEPTIONAL_CLOSURE:
        return NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL;
      case CalendarClassification.WEEKEND:
        return NiftyPlannedDateDisposition.CLOSED_WEEKEND;
      case CalendarClassification.UNCERTIFIED:
        return NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED;
      default: {
        const exhaustive: never = classification;
        throw new Error(`Unhandled CalendarClassification: ${exhaustive}`);
      }
    }
  }

  private expectedWindowsAndMinutes(
    disposition: NiftyPlannedDateDisposition,
    resolution: TradingDayResolution
  ): { sessionWindows: readonly SessionWindow[]; expectedMinutesIst: readonly number[] } {
    if (disposition === NiftyPlannedDateDisposition.REGULAR_TRADING_DAY) {
      const window = regularSessionWindow();
      return { sessionWindows: [window], expectedMinutesIst: expectedMinutesForWindow(window) };
    }
    if (disposition === NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY) {
      return { sessionWindows: resolution.sessionWindows, expectedMinutesIst: expectedMinutesForWindows(resolution.sessionWindows) };
    }
    return { sessionWindows: [], expectedMinutesIst: [] };
  }

  private assertValidDate(field: string, value: string): void {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      throw new NiftyIngestionPlanInputError(`NiftyUnderlyingIngestionPlannerService requires ${field} to be a YYYY-MM-DD date string; received '${String(value)}'.`);
    }
    try {
      parseExchangeCalendarDate(value, field);
    } catch (error) {
      if (!(error instanceof ExchangeCalendarDateInvariantError)) throw error;
      throw new NiftyIngestionPlanInputError(`NiftyUnderlyingIngestionPlannerService requires ${field} to be a valid Gregorian YYYY-MM-DD date; received '${value}'.`);
    }
  }
}
