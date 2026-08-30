import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addExchangeCalendarDays,
  CalendarClassification,
  CertifiedCoverageIdentity,
  Exchange,
  ExchangeSegment,
  SessionWindow,
  SourceDocumentIdentity,
  SourceDocumentType,
  TradingDayResolution,
} from '../domain';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import { NIFTY_INDEX_INSTRUMENT_KEY } from './nifty-underlying-acquisition.service';
import NiftyUnderlyingIngestionPlannerService, {
  NIFTY_UNDERLYING_CALENDAR_EXCHANGE,
  NIFTY_UNDERLYING_CALENDAR_SEGMENT,
  NiftyIngestionPlanInputError,
  NiftyPlannedDateDisposition,
} from './nifty-underlying-ingestion-planner.service';

interface ResolveRangeCall {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly fromDate: string;
  readonly toDate: string;
}

/**
 * In-memory fake conforming to the subset of `ExchangeCalendarResolverService`
 * the planner actually calls (`resolveRange` only) -- same duck-typed
 * fixture convention as `FakeExchangeCalendarRepository` in
 * `exchange-calendar-resolver.service.test.ts`. Records every call so tests
 * can assert exactly which (exchange, segment, range) the planner requested,
 * without touching a live database.
 */
class FakeCalendarResolver {
  public readonly calls: ResolveRangeCall[] = [];

  constructor(private readonly byDate: ReadonlyMap<string, TradingDayResolution>) {}

  /**
   * Mirrors the REAL resolver's contract exactly (`exchange-calendar-
   * resolver.service.ts`): one `TradingDayResolution` per calendar date in
   * `[fromDate, toDate]` inclusive, defaulting any date this fixture never
   * registered to `UNCERTIFIED` -- it never silently omits a date the way a
   * naive "return only what I know about" fake would.
   */
  async resolveRange(exchange: Exchange, segment: ExchangeSegment, fromDate: string, toDate: string): Promise<TradingDayResolution[]> {
    this.calls.push({ exchange, segment, fromDate, toDate });
    const results: TradingDayResolution[] = [];
    let cursor = fromDate;
    while (cursor <= toDate) {
      results.push(this.byDate.get(cursor) ?? uncertifiedResolution(cursor));
      cursor = addExchangeCalendarDays(cursor, 1);
    }
    return results;
  }
}

function fakeCoverage(overrides: Partial<CertifiedCoverageIdentity> = {}): CertifiedCoverageIdentity {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: 2031,
    version: 1,
    coverageFrom: '2031-01-01',
    coverageTo: '2031-12-31',
    sourceAuthority: 'NSE',
    sourceBundleChecksum: 'synthetic-checksum-1',
    ...overrides,
  };
}

const fakeSourceDocument: SourceDocumentIdentity = {
  documentReference: 'SYN-DOC-A',
  documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  contentChecksumSha256: 'a'.repeat(64),
  referenceUrl: null,
};

function regularResolution(tradingDate: string): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    tradingDate,
    classification: CalendarClassification.REGULAR_SESSION,
    isTradingDay: true,
    isSpecialSession: false,
    sessionWindows: [],
    explicitReason: null,
    sourceDocument: null,
    coverage: fakeCoverage(),
  };
}

function weekendResolution(tradingDate: string): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    tradingDate,
    classification: CalendarClassification.WEEKEND,
    isTradingDay: false,
    isSpecialSession: false,
    sessionWindows: [],
    explicitReason: null,
    sourceDocument: null,
    coverage: fakeCoverage(),
  };
}

function explicitClosedResolution(
  tradingDate: string,
  classification: CalendarClassification.EXCHANGE_HOLIDAY | CalendarClassification.EXCEPTIONAL_CLOSURE
): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    tradingDate,
    classification,
    isTradingDay: false,
    isSpecialSession: false,
    sessionWindows: [],
    explicitReason: 'Synthetic reason',
    sourceDocument: fakeSourceDocument,
    coverage: fakeCoverage(),
  };
}

function specialSessionResolution(tradingDate: string, windows: readonly SessionWindow[]): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    tradingDate,
    classification: CalendarClassification.SPECIAL_SESSION,
    isTradingDay: true,
    isSpecialSession: true,
    sessionWindows: windows,
    explicitReason: 'Synthetic special session',
    sourceDocument: fakeSourceDocument,
    coverage: fakeCoverage(),
  };
}

function uncertifiedResolution(tradingDate: string): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    tradingDate,
    classification: CalendarClassification.UNCERTIFIED,
    isTradingDay: null,
    isSpecialSession: null,
    sessionWindows: [],
    explicitReason: null,
    sourceDocument: null,
    coverage: null,
  };
}

function newPlanner(resolutions: TradingDayResolution[]): { planner: NiftyUnderlyingIngestionPlannerService; resolver: FakeCalendarResolver } {
  const byDate = new Map(resolutions.map((resolution) => [resolution.tradingDate, resolution]));
  const resolver = new FakeCalendarResolver(byDate);
  const planner = new NiftyUnderlyingIngestionPlannerService({ calendarResolver: resolver as unknown as ExchangeCalendarResolverService });
  return { planner, resolver };
}

test('REGULAR_SESSION -> REGULAR_TRADING_DAY with 375 expected minutes under the current normal policy', async () => {
  const { planner } = newPlanner([regularResolution('2031-01-06')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-06' });
  assert.equal(plan.dates.length, 1);
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.REGULAR_TRADING_DAY);
  assert.equal(plan.dates[0].expectedMinuteCount, 375);
  assert.equal(plan.dates[0].expectedMinutesIst[0], 555);
  assert.equal(plan.dates[0].expectedMinutesIst[374], 929);
  assert.ok(plan.dates[0].calendarCoverage);
});

test('EXCHANGE_HOLIDAY -> CLOSED_HOLIDAY with 0 expected minutes', async () => {
  const { planner } = newPlanner([explicitClosedResolution('2031-01-07', CalendarClassification.EXCHANGE_HOLIDAY)]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-07', toDate: '2031-01-07' });
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.CLOSED_HOLIDAY);
  assert.equal(plan.dates[0].expectedMinuteCount, 0);
  assert.deepEqual(plan.dates[0].expectedMinutesIst, []);
  assert.deepEqual(plan.dates[0].sessionWindows, []);
});

test('EXCEPTIONAL_CLOSURE -> CLOSED_EXCEPTIONAL with 0 expected minutes', async () => {
  const { planner } = newPlanner([explicitClosedResolution('2031-01-08', CalendarClassification.EXCEPTIONAL_CLOSURE)]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-08', toDate: '2031-01-08' });
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL);
  assert.equal(plan.dates[0].expectedMinuteCount, 0);
});

test('WEEKEND -> CLOSED_WEEKEND with 0 expected minutes', async () => {
  const { planner } = newPlanner([weekendResolution('2031-01-11')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-11', toDate: '2031-01-11' });
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.CLOSED_WEEKEND);
  assert.equal(plan.dates[0].expectedMinuteCount, 0);
});

test('SPECIAL_SESSION single window -> exact expected range from TradingDayResolution.sessionWindows', async () => {
  const windows: SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 }]; // 16:45-17:45 Muhurat-style
  const { planner } = newPlanner([specialSessionResolution('2031-11-01', windows)]);
  const plan = await planner.buildPlan({ fromDate: '2031-11-01', toDate: '2031-11-01' });
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY);
  assert.equal(plan.dates[0].expectedMinuteCount, 60);
  assert.deepEqual(plan.dates[0].sessionWindows, windows);
  assert.equal(plan.dates[0].expectedMinutesIst[0], 1005);
  assert.equal(plan.dates[0].expectedMinutesIst[59], 1064);
});

test('SPECIAL_SESSION multi-window -> correct two-range union, gap between windows not filled', async () => {
  const windows: SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }, // 09:15-10:00
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 }, // 11:30-12:30
  ];
  const { planner } = newPlanner([specialSessionResolution('2031-06-01', windows)]);
  const plan = await planner.buildPlan({ fromDate: '2031-06-01', toDate: '2031-06-01' });
  assert.equal(plan.dates[0].expectedMinuteCount, 45 + 60);
  assert.equal(plan.dates[0].expectedMinutesIst.includes(600), false);
  assert.equal(plan.dates[0].expectedMinutesIst.includes(689), false);
});

test('UNCERTIFIED -> BLOCKED_UNCERTIFIED, coverage null, 0 expected minutes', async () => {
  const { planner } = newPlanner([uncertifiedResolution('2031-01-09')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-09', toDate: '2031-01-09' });
  assert.equal(plan.dates[0].disposition, NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED);
  assert.equal(plan.dates[0].calendarCoverage, null);
  assert.equal(plan.dates[0].expectedMinuteCount, 0);
  assert.equal(plan.hasBlockedDates, true);
  assert.equal(plan.blockedDateCount, 1);
});

test('mixed range produces exactly one output entry per requested calendar date', async () => {
  const { planner } = newPlanner([
    regularResolution('2031-01-06'),
    explicitClosedResolution('2031-01-07', CalendarClassification.EXCHANGE_HOLIDAY),
    weekendResolution('2031-01-11'),
    weekendResolution('2031-01-12'),
    regularResolution('2031-01-13'),
  ]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-13' });
  // 2031-01-06 through 2031-01-13 inclusive = 8 calendar dates.
  assert.equal(plan.dates.length, 8);
  assert.equal(plan.totalCalendarDateCount, 8);
  assert.equal(plan.regularTradingDateCount, 2);
  assert.equal(plan.closedDateCount, 3); // 1 holiday + 2 weekend
  assert.equal(plan.blockedDateCount, 3); // the 3 dates this fixture never registered resolve to nothing from the fake and are absent -- see next test for the true UNCERTIFIED path
});

test('a partially uncertified range preserves the full requested range and reports hasBlockedDates', async () => {
  const { planner } = newPlanner([
    regularResolution('2031-01-06'),
    regularResolution('2031-01-07'),
    uncertifiedResolution('2031-01-08'),
    uncertifiedResolution('2031-01-09'),
  ]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-09' });
  assert.equal(plan.requestedFromDate, '2031-01-06');
  assert.equal(plan.requestedToDate, '2031-01-09'); // never silently clamped
  assert.equal(plan.dates.length, 4);
  assert.equal(plan.hasBlockedDates, true);
  assert.equal(plan.blockedDateCount, 2);
  assert.equal(plan.regularTradingDateCount, 2);
});

test('determinism: repeated buildPlan calls against identical resolver state produce equivalent output', async () => {
  const { planner } = newPlanner([regularResolution('2031-01-06'), weekendResolution('2031-01-11')]);
  const first = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-11' });
  const second = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-11' });
  assert.deepEqual(first, second);
});

test('the chosen calendar segment (NSE / EQUITY) is locked: the resolver is called with it and the plan reports it', async () => {
  const { planner, resolver } = newPlanner([regularResolution('2031-01-06')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-06' });
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].exchange, Exchange.NSE);
  assert.equal(resolver.calls[0].segment, ExchangeSegment.EQUITY);
  assert.equal(resolver.calls[0].exchange, NIFTY_UNDERLYING_CALENDAR_EXCHANGE);
  assert.equal(resolver.calls[0].segment, NIFTY_UNDERLYING_CALENDAR_SEGMENT);
  assert.equal(plan.exchange, Exchange.NSE);
  assert.equal(plan.calendarSegment, ExchangeSegment.EQUITY);
});

test('the plan reports the authoritative NIFTY underlying instrument key without redeclaring it', async () => {
  const { planner } = newPlanner([regularResolution('2031-01-06')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-06' });
  assert.equal(plan.instrumentKey, NIFTY_INDEX_INSTRUMENT_KEY);
});

test('the resolver is called exactly once per buildPlan (a single resolveRange, not per-date calls)', async () => {
  const { planner, resolver } = newPlanner([regularResolution('2031-01-06'), regularResolution('2031-01-07'), regularResolution('2031-01-08')]);
  await planner.buildPlan({ fromDate: '2031-01-06', toDate: '2031-01-08' });
  assert.equal(resolver.calls.length, 1);
});

test('providerRequestChunks are the unmodified calendar-month chunk planner output for the full requested range', async () => {
  const { planner } = newPlanner([regularResolution('2031-01-15')]);
  const plan = await planner.buildPlan({ fromDate: '2031-01-01', toDate: '2031-02-15' });
  assert.equal(plan.providerRequestChunks.length, 2);
  assert.deepEqual(plan.providerRequestChunks[0], { fromDate: '2031-01-01', toDate: '2031-01-31' });
  assert.deepEqual(plan.providerRequestChunks[1], { fromDate: '2031-02-01', toDate: '2031-02-15' });
});

test('rejects a missing/malformed fromDate or toDate', async () => {
  const { planner } = newPlanner([]);
  await assert.rejects(() => planner.buildPlan({ fromDate: '', toDate: '2031-01-06' }), NiftyIngestionPlanInputError);
  await assert.rejects(() => planner.buildPlan({ fromDate: '2031-13-01', toDate: '2031-01-06' }), NiftyIngestionPlanInputError);
  await assert.rejects(() => planner.buildPlan({ fromDate: '2031-02-30', toDate: '2031-03-01' }), NiftyIngestionPlanInputError);
});

test('rejects fromDate after toDate', async () => {
  const { planner } = newPlanner([]);
  await assert.rejects(() => planner.buildPlan({ fromDate: '2031-02-01', toDate: '2031-01-01' }), NiftyIngestionPlanInputError);
});

test('B-F2-CAL-1 production modules never reference a historical-data provider, HistoricalCandle write path, or a network client', async () => {
  const fs = await import('node:fs/promises');
  const files = ['src/modules/research-lake/services/nifty-underlying-ingestion-planner.service.ts', 'src/modules/research-lake/domain/session-window-expected-minutes.util.ts'];
  const forbidden =
    /\baxios\b|\bhttps?:\/\/|\bfetch\(|node:http|require\(['"]http|UpstoxHistoricalClient|UpstoxHistoricalDataProviderService|HistoricalDataProvider|HistoricalCandleRepository|\bbulkUpsert\b/;
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    assert.equal(forbidden.test(content), false, `${file} references a provider/network/persistence dependency it must never have.`);
  }
});
