import assert from 'node:assert/strict';
import test from 'node:test';
import { addExchangeCalendarDays, CalendarClassification, CertifiedCoverageIdentity, Exchange, ExchangeSegment, SessionWindow, SourceDocumentIdentity, SourceDocumentType, TradingDayResolution } from '../domain';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import NiftyUnderlyingIngestionPlannerService from './nifty-underlying-ingestion-planner.service';
import ManifestCalendarSessionResolverService, { ManifestCalendarBlockedError, ManifestCalendarSessionWindowLookupError } from './manifest-calendar-session-resolver.service';

interface ResolveRangeCall {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly fromDate: string;
  readonly toDate: string;
}

/** Same duck-typed fixture convention as `nifty-underlying-ingestion-planner.service.test.ts` -- defaults any unregistered date to UNCERTIFIED, never silently omitted. */
class FakeCalendarResolver {
  public readonly calls: ResolveRangeCall[] = [];

  constructor(private readonly byDate: ReadonlyMap<string, TradingDayResolution>) {}

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
    calendarYear: 2022,
    version: 1,
    coverageFrom: '2022-01-01',
    coverageTo: '2022-12-31',
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
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.REGULAR_SESSION, isTradingDay: true, isSpecialSession: false, sessionWindows: [], explicitReason: null, sourceDocument: null, coverage: fakeCoverage() };
}

function weekendResolution(tradingDate: string): TradingDayResolution {
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.WEEKEND, isTradingDay: false, isSpecialSession: false, sessionWindows: [], explicitReason: null, sourceDocument: null, coverage: fakeCoverage() };
}

function holidayResolution(tradingDate: string): TradingDayResolution {
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.EXCHANGE_HOLIDAY, isTradingDay: false, isSpecialSession: false, sessionWindows: [], explicitReason: 'Republic Day', sourceDocument: fakeSourceDocument, coverage: fakeCoverage() };
}

function exceptionalClosureResolution(tradingDate: string): TradingDayResolution {
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.EXCEPTIONAL_CLOSURE, isTradingDay: false, isSpecialSession: false, sessionWindows: [], explicitReason: 'Synthetic exceptional closure', sourceDocument: fakeSourceDocument, coverage: fakeCoverage() };
}

function specialSessionResolution(tradingDate: string, windows: readonly SessionWindow[]): TradingDayResolution {
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.SPECIAL_SESSION, isTradingDay: true, isSpecialSession: true, sessionWindows: windows, explicitReason: 'Synthetic special session', sourceDocument: fakeSourceDocument, coverage: fakeCoverage() };
}

function uncertifiedResolution(tradingDate: string): TradingDayResolution {
  return { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate, classification: CalendarClassification.UNCERTIFIED, isTradingDay: null, isSpecialSession: null, sessionWindows: [], explicitReason: null, sourceDocument: null, coverage: null };
}

function newResolverService(resolutions: TradingDayResolution[]): ManifestCalendarSessionResolverService {
  const byDate = new Map(resolutions.map((resolution) => [resolution.tradingDate, resolution]));
  const fakeCalendarResolver = new FakeCalendarResolver(byDate);
  const plannerService = new NiftyUnderlyingIngestionPlannerService({ calendarResolver: fakeCalendarResolver as unknown as ExchangeCalendarResolverService });
  return new ManifestCalendarSessionResolverService({ plannerService });
}

/** Every ordinary NSE trading weekday in January 2022 except the certified Republic Day holiday (2022-01-26). */
const JANUARY_2022_REGULAR_WEEKDAYS = [
  '2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06', '2022-01-07',
  '2022-01-10', '2022-01-11', '2022-01-12', '2022-01-13', '2022-01-14',
  '2022-01-17', '2022-01-18', '2022-01-19', '2022-01-20', '2022-01-21',
  '2022-01-24', '2022-01-25', /* 2022-01-26 EXCHANGE_HOLIDAY */ '2022-01-27', '2022-01-28', '2022-01-31',
];

/** Every Saturday/Sunday in January 2022 -- the fake resolver never infers weekend, so every calendar date in a tested range must be explicitly registered (same rigor as `nifty-underlying-ingestion-planner.service.test.ts`'s `FakeCalendarResolver`). */
const JANUARY_2022_WEEKENDS = ['2022-01-01', '2022-01-02', '2022-01-08', '2022-01-09', '2022-01-15', '2022-01-16', '2022-01-22', '2022-01-23', '2022-01-29', '2022-01-30'];

test('(1) January 2022 regression: 2022-01-26 exchange holiday is excluded -- requested sessions = 20, not 21', async () => {
  const resolutions = [...JANUARY_2022_REGULAR_WEEKDAYS.map(regularResolution), holidayResolution('2022-01-26'), ...JANUARY_2022_WEEKENDS.map(weekendResolution)];
  const resolverService = newResolverService(resolutions);

  const { tradingDates } = await resolverService.resolveRequestedSessions({ fromDate: '2022-01-03', toDate: '2022-01-31' });

  assert.equal(tradingDates.length, 20);
  assert.equal(tradingDates.includes('2022-01-26'), false);
});

test('(2) an ordinary weekday holiday/closure is simply absent from requested sessions -- never a "session" that could be marked PROVIDER_UNAVAILABLE', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), holidayResolution('2031-01-07'), regularResolution('2031-01-08'), regularResolution('2031-01-09'), regularResolution('2031-01-10')]);
  const { tradingDates, calendarSessionWindows } = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-06', toDate: '2031-01-10' });
  assert.deepEqual(tradingDates, ['2031-01-06', '2031-01-08', '2031-01-09', '2031-01-10']);
  assert.equal('2031-01-07' in calendarSessionWindows, false);
});

test('(3) a weekend SPECIAL_SESSION date is included, with its declared windows', async () => {
  const windows: SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }]; // Saturday special session, e.g. a T+1 go-live mock trading day
  const resolverService = newResolverService([specialSessionResolution('2031-01-11', windows)]); // 2031-01-11 is a Saturday
  const { tradingDates, calendarSessionWindows } = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-11', toDate: '2031-01-11' });
  assert.deepEqual(tradingDates, ['2031-01-11']);
  assert.deepEqual(calendarSessionWindows['2031-01-11'], windows);
});

test('(6) an ordinary (non-special) weekend date remains excluded', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-10'), weekendResolution('2031-01-11'), weekendResolution('2031-01-12'), regularResolution('2031-01-13')]);
  const { tradingDates } = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-10', toDate: '2031-01-13' });
  assert.deepEqual(tradingDates, ['2031-01-10', '2031-01-13']);
});

test('(7) an EXCEPTIONAL_CLOSURE date is excluded', async () => {
  const resolverService = newResolverService([regularResolution('2031-03-10'), exceptionalClosureResolution('2031-03-11'), regularResolution('2031-03-12')]);
  const { tradingDates } = await resolverService.resolveRequestedSessions({ fromDate: '2031-03-10', toDate: '2031-03-12' });
  assert.deepEqual(tradingDates, ['2031-03-10', '2031-03-12']);
});

test('(8) an UNCERTIFIED date anywhere in the range fails the whole request closed, before returning any sessions', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), regularResolution('2031-01-07')]); // 2031-01-08/09 never registered -> UNCERTIFIED
  await assert.rejects(() => resolverService.resolveRequestedSessions({ fromDate: '2031-01-06', toDate: '2031-01-09' }), (error: unknown) => {
    assert.ok(error instanceof ManifestCalendarBlockedError);
    assert.deepEqual(error.blockedDates, ['2031-01-08', '2031-01-09']);
    return true;
  });
});

test('(9) an ordinary regular-session range with no closed dates returns every date requested', async () => {
  const dates = ['2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06', '2022-01-07'];
  const resolverService = newResolverService(dates.map(regularResolution));
  const { tradingDates } = await resolverService.resolveRequestedSessions({ fromDate: '2022-01-03', toDate: '2022-01-07' });
  assert.deepEqual(tradingDates, dates);
});

test('a REGULAR_SESSION date carries the calendar-derived regular session window (09:15-15:29 IST, 375 minutes) rather than no window at all', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06')]);
  const { calendarSessionWindows } = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-06', toDate: '2031-01-06' });
  assert.equal(calendarSessionWindows['2031-01-06'].length, 1);
  assert.equal(calendarSessionWindows['2031-01-06'][0].openMinuteIst, 555);
  assert.equal(calendarSessionWindows['2031-01-06'][0].closeMinuteIst, 930);
});

test('determinism: repeated resolution against identical calendar state produces the identical requested-session result', async () => {
  const resolverService = newResolverService([
    regularResolution('2031-01-06'),
    regularResolution('2031-01-07'),
    regularResolution('2031-01-08'),
    regularResolution('2031-01-09'),
    regularResolution('2031-01-10'),
    specialSessionResolution('2031-01-11', [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }]),
    weekendResolution('2031-01-12'),
  ]);
  const first = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-06', toDate: '2031-01-12' });
  const second = await resolverService.resolveRequestedSessions({ fromDate: '2031-01-06', toDate: '2031-01-12' });
  assert.deepEqual(first, second);
});

// ============================================================================
// resolveSessionWindowsForDates -- GAP 1 (year-runner typed orchestration
// boundary repair): recovers calendar session windows for an
// ALREADY-DETERMINED set of dates (e.g. a year run's healthyTradingDates).
// ============================================================================

test('resolveSessionWindowsForDates returns [] immediately for an empty date list (no calendar call for nothing to resolve)', async () => {
  const resolverService = newResolverService([]);
  const result = await resolverService.resolveSessionWindowsForDates([]);
  assert.deepEqual(result, {});
});

test('resolveSessionWindowsForDates returns the calendar-derived regular window for REGULAR_SESSION dates', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), regularResolution('2031-01-07')]);
  const result = await resolverService.resolveSessionWindowsForDates(['2031-01-06', '2031-01-07']);
  assert.equal(result['2031-01-06'].length, 1);
  assert.equal(result['2031-01-06'][0].openMinuteIst, 555);
  assert.equal(result['2031-01-06'][0].closeMinuteIst, 930);
  assert.equal(result['2031-01-07'][0].openMinuteIst, 555);
});

test('resolveSessionWindowsForDates returns exact certified windows for a SPECIAL_SESSION date, including a certified weekend', async () => {
  const windows: SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 }];
  const resolverService = newResolverService([regularResolution('2031-01-06'), specialSessionResolution('2031-01-11', windows)]); // 2031-01-11 is a Saturday
  const result = await resolverService.resolveSessionWindowsForDates(['2031-01-06', '2031-01-11']);
  assert.deepEqual(result['2031-01-11'], windows);
});

test('resolveSessionWindowsForDates fails closed (ManifestCalendarSessionWindowLookupError) when a supplied date is UNCERTIFIED', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06')]); // 2031-01-07 never registered -> UNCERTIFIED
  await assert.rejects(() => resolverService.resolveSessionWindowsForDates(['2031-01-06', '2031-01-07']), (error: unknown) => {
    assert.ok(error instanceof ManifestCalendarSessionWindowLookupError);
    assert.deepEqual(error.uncertifiedDates, ['2031-01-07']);
    assert.deepEqual(error.unexpectedlyClosedDates, []);
    return true;
  });
});

test('resolveSessionWindowsForDates fails closed when a supplied "already healthy" date unexpectedly resolves CLOSED against current calendar truth', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), holidayResolution('2031-01-07')]);
  await assert.rejects(() => resolverService.resolveSessionWindowsForDates(['2031-01-06', '2031-01-07']), (error: unknown) => {
    assert.ok(error instanceof ManifestCalendarSessionWindowLookupError);
    assert.deepEqual(error.unexpectedlyClosedDates, ['2031-01-07']);
    return true;
  });
});

test('resolveSessionWindowsForDates does not filter/omit closed dates from its scope -- it only ever accepts a caller-supplied set already believed to be trading sessions', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), weekendResolution('2031-01-11')]);
  await assert.rejects(() => resolverService.resolveSessionWindowsForDates(['2031-01-06', '2031-01-11']), ManifestCalendarSessionWindowLookupError);
});

test('resolveSessionWindowsForDates deduplicates and is order-independent in its input', async () => {
  const resolverService = newResolverService([regularResolution('2031-01-06'), regularResolution('2031-01-07')]);
  const result = await resolverService.resolveSessionWindowsForDates(['2031-01-07', '2031-01-06', '2031-01-06']);
  assert.deepEqual(Object.keys(result).sort(), ['2031-01-06', '2031-01-07']);
});
