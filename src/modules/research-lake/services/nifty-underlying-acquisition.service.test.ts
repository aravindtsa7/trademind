import assert from 'node:assert/strict';
import test from 'node:test';
import NiftyUnderlyingAcquisitionService, {
  NiftyAcquisitionCalendarBlockedError,
  NiftyAcquisitionCalendarPlanInvariantError,
  NiftyAcquisitionCalendarPlanInvariantReason,
  NIFTY_INDEX_INSTRUMENT_KEY,
  NIFTY_UNDERLYING_TIMEFRAME,
} from './nifty-underlying-acquisition.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import { HistoricalDataProvider, HistoricalUnderlyingCandleRangeRequest } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import HistoricalCandleRepository, { HistoricalCandleUpsertInput } from '../../historical-candles/repositories/historical-candle.repository';
import {
  addExchangeCalendarDays,
  CalendarClassification,
  CanonicalExclusionReason,
  CertifiedCoverageIdentity,
  Exchange,
  ExchangeSegment,
  expectedMinutesForWindow,
  expectedMinutesForWindows,
  regularSessionWindow,
  SessionWindow,
  TradingDayResolution,
} from '../domain';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import NiftyUnderlyingIngestionPlannerService, {
  NiftyIngestionPlan,
  NiftyIngestionPlanRequest,
  NiftyPlannedDate,
  NiftyPlannedDateDisposition,
} from './nifty-underlying-ingestion-planner.service';

const SECRET_TOKEN = 'super-secret-upstox-bearer-token-value';

// ---- Fakes ---------------------------------------------------------------

interface StoredRow {
  candleTime: Date;
}

class FakeHistoricalCandleRepository {
  private readonly rowsByDate = new Map<string, Map<number, StoredRow>>();
  bulkUpsertCallCount = 0;
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<StoredRow[]> {
    this.findRangeCallCount += 1;
    const rows: StoredRow[] = [];
    for (const map of this.rowsByDate.values()) {
      for (const row of map.values()) {
        if (row.candleTime >= from && row.candleTime <= to) rows.push(row);
      }
    }
    return rows.sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }

  async bulkUpsert(inputs: HistoricalCandleUpsertInput[]): Promise<StoredRow[]> {
    this.bulkUpsertCallCount += 1;
    const results: StoredRow[] = [];
    for (const input of inputs) {
      const date = istDateKey(input.create.candleTime as Date);
      const map = this.rowsByDate.get(date) ?? new Map<number, StoredRow>();
      this.rowsByDate.set(date, map);
      const row: StoredRow = { candleTime: input.create.candleTime as Date };
      map.set(row.candleTime.getTime(), row);
      results.push(row);
    }
    return results;
  }

  /** Test seam: preload a fully complete 375-row canonical session, simulating "already validated in a prior run". */
  seedCompleteSession(date: string): void {
    const map = new Map<number, StoredRow>();
    for (const row of normalSessionRows(date)) {
      map.set(row.candleTime.getTime(), { candleTime: row.candleTime });
    }
    this.rowsByDate.set(date, map);
  }
}

function istDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

type FakeResponse = readonly HistoricalSourceCandleRow[] | { permanent: true } | { transient: true };

class FakeHistoricalDataProvider implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.UPSTOX;
  readonly calls: HistoricalUnderlyingCandleRangeRequest[] = [];

  constructor(private readonly respond: (request: HistoricalUnderlyingCandleRangeRequest) => FakeResponse) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.UPSTOX,
      earliestDocumentedUnderlyingHistory: '2022-01-01',
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: 31,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: true,
      rateLimitPolicy: { policyId: 'FAKE_DEFAULT' },
    };
  }

  async fetchCompletedUnderlyingRange(request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    this.calls.push(request);
    const result = this.respond(request);
    if ('permanent' in (result as object)) {
      throw Object.assign(new Error('Request failed with status code 401'), {
        isAxiosError: true,
        response: { status: 401, headers: {} },
        config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
      });
    }
    if ('transient' in (result as object)) {
      throw Object.assign(new Error('Request failed with status code 503'), {
        isAxiosError: true,
        response: { status: 503, headers: {} },
        config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
      });
    }
    return result as readonly HistoricalSourceCandleRow[];
  }

  async fetchExpiredOptionRange(): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('not supported by fake');
  }
}

// ---- B-F2-CAL-2 calendar-plan fakes ---------------------------------------

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

function regularPlannedDate(tradingDate: string): NiftyPlannedDate {
  const window = regularSessionWindow();
  return {
    tradingDate,
    disposition: NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
    expectedMinuteCount: 375,
    expectedMinutesIst: expectedMinutesForWindow(window),
    sessionWindows: [window],
    explicitReason: null,
    calendarCoverage: fakeCoverage(),
    sourceDocument: null,
  };
}

function closedPlannedDate(tradingDate: string, disposition: NiftyPlannedDateDisposition): NiftyPlannedDate {
  return {
    tradingDate,
    disposition,
    expectedMinuteCount: 0,
    expectedMinutesIst: [],
    sessionWindows: [],
    explicitReason: disposition === NiftyPlannedDateDisposition.CLOSED_WEEKEND ? null : `synthetic ${disposition}`,
    calendarCoverage: fakeCoverage(),
    sourceDocument: null,
  };
}

function specialPlannedDate(tradingDate: string, windows: readonly SessionWindow[]): NiftyPlannedDate {
  return {
    tradingDate,
    disposition: NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY,
    expectedMinuteCount: expectedMinutesForWindows(windows).length,
    expectedMinutesIst: expectedMinutesForWindows(windows),
    sessionWindows: windows,
    explicitReason: 'synthetic special session',
    calendarCoverage: fakeCoverage(),
    sourceDocument: null,
  };
}

/**
 * Builds a plan entry that DELIBERATELY disagrees with itself -- e.g. a
 * `sessionWindows` of [555,600) (canonically 45 minutes) paired with an
 * `expectedMinuteCount`/`expectedMinutesIst` that lies about that. Used only
 * to reproduce Terra's B-F2-CAL-2-FIX-1 finding: a real
 * `NiftyUnderlyingIngestionPlannerService` would never construct one of
 * these (its own tests already prove `expectedMinutesForWindow(s)` derives
 * these fields correctly) -- this exists specifically to prove the
 * ACQUISITION BOUNDARY itself catches the inconsistency, not merely trusts
 * an assumed-correct planner.
 */
function inconsistentPlannedDate(base: NiftyPlannedDate, overrides: Partial<Pick<NiftyPlannedDate, 'expectedMinutesIst' | 'expectedMinuteCount' | 'sessionWindows'>>): NiftyPlannedDate {
  return { ...base, ...overrides };
}

function blockedPlannedDate(tradingDate: string): NiftyPlannedDate {
  return {
    tradingDate,
    disposition: NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED,
    expectedMinuteCount: 0,
    expectedMinutesIst: [],
    sessionWindows: [],
    explicitReason: null,
    calendarCoverage: null,
    sourceDocument: null,
  };
}

function buildPlanFromDates(request: NiftyIngestionPlanRequest, dates: readonly NiftyPlannedDate[]): NiftyIngestionPlan {
  const regularTradingDateCount = dates.filter((d) => d.disposition === NiftyPlannedDateDisposition.REGULAR_TRADING_DAY).length;
  const specialSessionDateCount = dates.filter((d) => d.disposition === NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY).length;
  const closedDateCount = dates.filter(
    (d) =>
      d.disposition === NiftyPlannedDateDisposition.CLOSED_HOLIDAY ||
      d.disposition === NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL ||
      d.disposition === NiftyPlannedDateDisposition.CLOSED_WEEKEND
  ).length;
  const blockedDateCount = dates.filter((d) => d.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED).length;
  return {
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    exchange: Exchange.NSE,
    calendarSegment: ExchangeSegment.EQUITY,
    requestedFromDate: request.fromDate,
    requestedToDate: request.toDate,
    dates,
    providerRequestChunks: [{ fromDate: request.fromDate, toDate: request.toDate }],
    totalCalendarDateCount: dates.length,
    totalExpectedCandles: dates.reduce((sum, d) => sum + d.expectedMinuteCount, 0),
    regularTradingDateCount,
    specialSessionDateCount,
    closedDateCount,
    blockedDateCount,
    hasBlockedDates: blockedDateCount > 0,
  };
}

/**
 * Marks EVERY date in the requested range `REGULAR_TRADING_DAY` (the classic
 * [555,930)/375-minute window). This is the default planner for every
 * pre-existing (pre-CAL-2) test in this file: those tests only ever exercise
 * plain weekday dates and were written against the OLD `calendarWeekdays()`
 * Mon-Fri heuristic, which always treated those same dates as candidates --
 * so this fake reproduces that exact behavior via the new, real calendar-plan
 * seam instead, without touching a live database.
 */
class FakeAllRegularPlanner {
  public readonly calls: NiftyIngestionPlanRequest[] = [];

  async buildPlan(request: NiftyIngestionPlanRequest): Promise<NiftyIngestionPlan> {
    this.calls.push(request);
    const dates: NiftyPlannedDate[] = [];
    let cursor = request.fromDate;
    while (cursor <= request.toDate) {
      dates.push(regularPlannedDate(cursor));
      cursor = addExchangeCalendarDays(cursor, 1);
    }
    return buildPlanFromDates(request, dates);
  }
}

/** Returns a caller-specified plan verbatim -- for tests that need explicit control over one or more dates' dispositions. */
class FakeExplicitPlanner {
  public readonly calls: NiftyIngestionPlanRequest[] = [];

  constructor(private readonly dates: readonly NiftyPlannedDate[]) {}

  async buildPlan(request: NiftyIngestionPlanRequest): Promise<NiftyIngestionPlan> {
    this.calls.push(request);
    return buildPlanFromDates(request, this.dates);
  }
}

function row(sourceIndex: number, isoTimeWithOffset: string, overrides: Partial<HistoricalSourceCandleRow> = {}): HistoricalSourceCandleRow {
  return {
    sourceIndex,
    candleTime: new Date(isoTimeWithOffset),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(date: string): HistoricalSourceCandleRow[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => row(index, new Date(start + index * 60_000).toISOString()));
}

function dateForMinuteOfDay(tradingDate: string, minuteOfDay: number): Date {
  const dayStart = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  return new Date(dayStart + minuteOfDay * 60_000);
}

/** One row per minute-of-day in `minutes`, in the given order -- used to build exact calendar-window-shaped (or deliberately out-of-window) provider responses. */
function rowsForMinutes(tradingDate: string, minutes: readonly number[], sourceIndexOffset = 0): HistoricalSourceCandleRow[] {
  return minutes.map((minute, index) => row(sourceIndexOffset + index, dateForMinuteOfDay(tradingDate, minute).toISOString()));
}

function buildService(
  respond: (request: HistoricalUnderlyingCandleRangeRequest) => FakeResponse,
  repository: FakeHistoricalCandleRepository = new FakeHistoricalCandleRepository(),
  plannerService: { buildPlan: NiftyUnderlyingIngestionPlannerService['buildPlan'] } = new FakeAllRegularPlanner()
): {
  service: NiftyUnderlyingAcquisitionService;
  provider: FakeHistoricalDataProvider;
  repository: FakeHistoricalCandleRepository;
  planner: { buildPlan: NiftyUnderlyingIngestionPlannerService['buildPlan'] };
} {
  const provider = new FakeHistoricalDataProvider(respond);
  const service = new NiftyUnderlyingAcquisitionService({
    provider,
    repository: repository as unknown as HistoricalCandleRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    plannerService: plannerService as unknown as NiftyUnderlyingIngestionPlannerService,
  });
  return { service, provider, repository, planner: plannerService };
}

// ---- E: 378-row 2022 regression ------------------------------------------

test('E: a 378-row provider response (09:07 + 375 canonical + 15:30 + 15:31) yields exactly 375 canonical rows, 3 exclusions, NORMALIZED_WITH_EXCLUSIONS, and persistence receives only the 375 canonical rows', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date);
  rows.unshift(row(9998, `${date}T09:07:00+05:30`));
  rows.push(row(9999, `${date}T15:30:00+05:30`), row(10000, `${date}T15:31:00+05:30`));

  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(result.instrumentKey, NIFTY_INDEX_INSTRUMENT_KEY);
  assert.equal(result.timeframe, NIFTY_UNDERLYING_TIMEFRAME);
  assert.deepEqual(result.sessions.normalizedWithExclusions, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(detail.excludedRowCount, 3);
  assert.equal(detail.persisted, true);
  assert.equal(repository.bulkUpsertCallCount, 1);

  const stored = await repository.findRange('', '', new Date(`${date}T00:00:00+05:30`), new Date(`${date}T23:59:59+05:30`));
  assert.equal(stored.length, 375); // only canonical rows reached persistence, never the 3 excluded ones
});

// ---- F: exact healthy session ---------------------------------------------

test('F: an exact healthy 375-row session is persisted and revalidated complete (NEWLY_COMPLETED)', async () => {
  const date = '2022-01-04';
  const { service, repository } = buildService(() => normalSessionRows(date));
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.newlyCompleted, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.persisted, true);
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(detail.excludedRowCount, 0);
  assert.equal(repository.bulkUpsertCallCount, 1);
});

// ---- G: missing minute -----------------------------------------------------

test('G: a session missing one canonical minute is NOT marked complete (fail closed, INCOMPLETE, never persisted)', async () => {
  const date = '2022-01-05';
  const rows = normalSessionRows(date).filter((_, index) => index !== 50);
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.incomplete, [date]);
  assert.deepEqual(result.sessions.newlyCompleted, []);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.persisted, false);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- H: duplicate -----------------------------------------------------------

test('H: a duplicate canonical minute is INVALID and NOT marked complete', async () => {
  const date = '2022-01-06';
  const rows = normalSessionRows(date);
  rows.push(row(9999, rows[0].candleTime.toISOString()));
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.invalid, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.persisted, false);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- I: raw out-of-order provider response ---------------------------------

test('I: a raw out-of-order provider response yields NON_MONOTONIC_ORDER, INVALID, and is not persisted as healthy', async () => {
  const date = '2022-01-07';
  const rows = normalSessionRows(date);
  [rows[1], rows[2]] = [rows[2], rows[1]];
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.invalid, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.ok(detail.issues.some((issue) => issue.reason === 'NON_MONOTONIC_ORDER'));
  assert.equal(detail.persisted, false);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- J: resume --------------------------------------------------------------

test('J: an existing complete session is skipped with no fetch and no unnecessary persistence', async () => {
  const date = '2022-01-10';
  const repository = new FakeHistoricalCandleRepository();
  repository.seedCompleteSession(date);

  const { service, provider } = buildService(() => {
    throw new Error('provider must not be called for an already-complete single-date request');
  }, repository);

  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(provider.calls.length, 0);
  assert.equal(repository.bulkUpsertCallCount, 0);
  assert.deepEqual(result.sessions.alreadyComplete, [date]);
  assert.equal(result.monthlyChunksSucceeded, 1);
  assert.equal(result.monthlyChunksFailed, 0);
});

// ---- K: crash/restart topology ----------------------------------------------

test('K: a session persisted by a prior run is detected complete and skipped on the next run, even without an explicit summary from the first run', async () => {
  const date = '2022-01-11';
  const sharedRepository = new FakeHistoricalCandleRepository();

  const { service: firstRun } = buildService(() => normalSessionRows(date), sharedRepository);
  const firstResult = await firstRun.acquire({ fromDate: date, toDate: date });
  assert.deepEqual(firstResult.sessions.newlyCompleted, [date]); // "process" completed persistence

  // Simulate a fresh process/run against the SAME underlying database state.
  const { service: secondRun, provider: secondProvider } = buildService(() => {
    throw new Error('second run must not re-fetch an already-complete date');
  }, sharedRepository);
  const secondResult = await secondRun.acquire({ fromDate: date, toDate: date });

  assert.equal(secondProvider.calls.length, 0);
  assert.deepEqual(secondResult.sessions.alreadyComplete, [date]);
});

// ---- L: invalid provider month must not corrupt other healthy dates --------

test('L: one chunk failing permanently does not prevent another healthy chunk in the same run from completing', async () => {
  const badDate = '2022-01-31'; // Monday
  const goodDate = '2022-02-01'; // Tuesday
  const { service, repository } = buildService((request) => {
    if (request.fromTradingDate === badDate) return { permanent: true };
    return normalSessionRows(goodDate);
  });

  const result = await service.acquire({ fromDate: badDate, toDate: goodDate });

  assert.equal(result.monthlyChunksFailed, 1);
  assert.equal(result.monthlyChunksSucceeded, 1);
  assert.equal(result.failedChunks.length, 1);
  assert.equal(result.failedChunks[0].fromDate, badDate);
  assert.deepEqual(result.sessions.newlyCompleted, [goodDate]);
  assert.equal(repository.bulkUpsertCallCount, 1);
  // The failed date must never appear fabricated in any bucket.
  for (const bucket of Object.values(result.sessions)) {
    assert.equal((bucket as readonly string[]).includes(badDate), false);
  }
});

// ---- M: no token leakage -----------------------------------------------------

test('M: SECURITY -- no bearer token ever appears in failedChunks error text or anywhere in the JSON-serialized result', async () => {
  const badDate = '2022-03-01';
  const { service } = buildService(() => ({ permanent: true }));

  const result = await service.acquire({ fromDate: badDate, toDate: badDate });

  assert.equal(result.failedChunks.length, 1);
  assert.ok(!result.failedChunks[0].error.includes(SECRET_TOKEN));

  const serialized = JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  assert.ok(!serialized.includes(SECRET_TOKEN));
});

// ---- dry run --------------------------------------------------------------

test('dryRun fetches from the provider as normal but never writes to the database', async () => {
  const date = '2022-01-12';
  const { service, repository } = buildService(() => normalSessionRows(date));
  const result = await service.acquire({ fromDate: date, toDate: date, dryRun: true });

  assert.deepEqual(result.sessions.newlyCompleted, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.persisted, false);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- validation -------------------------------------------------------------

test('requires a valid toDate and rejects fromDate after toDate', async () => {
  const { service } = buildService(() => []);
  await assert.rejects(service.acquire({ toDate: 'not-a-date' }));
  await assert.rejects(service.acquire({ fromDate: '2022-05-01', toDate: '2022-04-01' }));
});

// ---- unresolved no-data weekday -----------------------------------------------

test('a weekday with no provider rows and no existing DB coverage is bucketed UNRESOLVED_NO_DATA, not silently ignored or called a holiday', async () => {
  const date = '2022-01-17'; // Monday
  const { service } = buildService(() => []); // provider returns nothing at all
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.unresolvedNoData, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.healthStatus, null);
  assert.equal(detail.persisted, false);
});

test('a certified CLOSED_WEEKEND date causes no provider call and is bucketed closedNoDataExpected, never unresolvedNoData', async () => {
  const saturday = '2022-01-15';
  const planner = new FakeExplicitPlanner([closedPlannedDate(saturday, NiftyPlannedDateDisposition.CLOSED_WEEKEND)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must not be called for a certified closed date');
  }, undefined, planner);
  const result = await service.acquire({ fromDate: saturday, toDate: saturday });

  assert.equal(provider.calls.length, 0);
  assert.deepEqual(result.sessions.unresolvedNoData, []);
  assert.deepEqual(result.sessions.closedNoDataExpected, [saturday]);
});

// ============================================================================
// B-F2-CAL-2: calendar-aware historical acquisition + canonical projection
// ============================================================================

// ---- CAL-2 section 25: regular day ----------------------------------------

test('CAL-2 REGULAR: a certified REGULAR_TRADING_DAY is fetch-eligible, uses window [555,930) and the full 375-minute expected set', async () => {
  const date = '2024-01-19';
  const planner = new FakeExplicitPlanner([regularPlannedDate(date)]);
  const { service, provider, repository } = buildService(() => normalSessionRows(date), undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(provider.calls.length, 1);
  assert.deepEqual(result.sessions.newlyCompleted, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(detail.persisted, true);
  assert.equal(repository.bulkUpsertCallCount, 1);
});

// ---- CAL-2 section 26: holiday ---------------------------------------------

test('CAL-2 HOLIDAY: a certified CLOSED_HOLIDAY date (2023-06-29) causes zero provider calls, zero expected minutes, and no false missing-session error', async () => {
  const date = '2023-06-29';
  const planner = new FakeExplicitPlanner([closedPlannedDate(date, NiftyPlannedDateDisposition.CLOSED_HOLIDAY)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must not be called for a certified holiday');
  }, undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(provider.calls.length, 0);
  assert.deepEqual(result.sessions.closedNoDataExpected, [date]);
  assert.deepEqual(result.sessions.unresolvedNoData, []);
  assert.deepEqual(result.sessions.incomplete, []);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.canonicalRowCount, 0);
});

// ---- CAL-2 section 27: weekend ----------------------------------------------

test('CAL-2 WEEKEND: a certified CLOSED_WEEKEND date (2024-01-21) causes zero provider calls and zero expected minutes', async () => {
  const date = '2024-01-21';
  const planner = new FakeExplicitPlanner([closedPlannedDate(date, NiftyPlannedDateDisposition.CLOSED_WEEKEND)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must not be called for a certified weekend');
  }, undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(provider.calls.length, 0);
  assert.deepEqual(result.sessions.closedNoDataExpected, [date]);
});

// ---- CAL-2 section 28: exceptional closure ----------------------------------

test('CAL-2 EXCEPTIONAL: a certified CLOSED_EXCEPTIONAL date (2024-01-22) causes zero provider calls and zero expected minutes', async () => {
  const date = '2024-01-22';
  const planner = new FakeExplicitPlanner([closedPlannedDate(date, NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must not be called for a certified exceptional closure');
  }, undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.equal(provider.calls.length, 0);
  assert.deepEqual(result.sessions.closedNoDataExpected, [date]);
});

// ---- CAL-2 section 29: single-window special --------------------------------

test('CAL-2 SPECIAL SINGLE-WINDOW: 2024-11-01 expects exactly [1080,1140)/60 minutes; surplus provider rows outside the window are excluded, never silently accepted', async () => {
  const date = '2024-11-01';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 1080, closeMinuteIst: 1140 };
  const planner = new FakeExplicitPlanner([specialPlannedDate(date, [window])]);
  const inWindowRows = rowsForMinutes(date, expectedMinutesForWindow(window));
  const surplusRows = rowsForMinutes(date, [555, 929], 1000); // simulates a provider that also returned regular-hours data for the same date
  // Chronologically ordered raw response (surplus minutes 555/929 precede the 1080-1139 window) -- a genuinely
  // out-of-order raw response is already covered by test 'I' and is not what this test is exercising.
  const rows = [...surplusRows, ...inWindowRows].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  const { service, repository } = buildService(() => rows, undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.sourceRowCount, 62);
  assert.equal(detail.canonicalRowCount, 60);
  assert.equal(detail.excludedRowCount, 2);
  assert.ok(detail.exclusions.every((exclusion) => exclusion.reason === CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW));
  assert.deepEqual(result.sessions.normalizedWithExclusions, [date]);
  assert.equal(detail.persisted, true);
  assert.equal(repository.bulkUpsertCallCount, 1);
});

// ---- CAL-2 section 30: multi-window special ---------------------------------

test('CAL-2 SPECIAL MULTI-WINDOW: 2024-03-02 expects exactly [555,600)+[690,750)/105 minutes; the [600,690) gap is never bridged', async () => {
  const date = '2024-03-02';
  const windows: SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const planner = new FakeExplicitPlanner([specialPlannedDate(date, windows)]);
  const expectedMinutes = expectedMinutesForWindows(windows);
  assert.equal(expectedMinutes.length, 105); // 45 + 60, NOT 375 and NOT 195 (555..749 continuous)

  const validRows = rowsForMinutes(date, expectedMinutes);
  // 600 is the FIRST gap minute (immediately after window 0 closes), 689 is the LAST gap minute (immediately before window 1 opens) -- half-open boundary proof (task section 19).
  const gapRows = rowsForMinutes(date, [600, 645, 689], 2000);
  // Chronologically ordered raw response -- an out-of-order raw response is already covered by test 'I'.
  const rows = [...validRows, ...gapRows].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  const { service, repository } = buildService(() => rows, undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.canonicalRowCount, 105);
  assert.equal(detail.excludedRowCount, 3);
  assert.ok(detail.exclusions.every((exclusion) => exclusion.reason === CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW));
  assert.deepEqual(result.sessions.normalizedWithExclusions, [date]);
  assert.equal(repository.bulkUpsertCallCount, 1);
});

// ---- CAL-2 section 31: full-day special on a Saturday -----------------------

test('CAL-2 FULL-DAY SPECIAL ON SATURDAY: 2024-01-20 (a Saturday) is SPECIAL_SESSION_DAY [555,930)/375 minutes -- calendar truth wins over generic weekend inference', async () => {
  const date = '2024-01-20';
  const window = regularSessionWindow(); // the special session's own certified window happens to equal the classic [555,930)
  const planner = new FakeExplicitPlanner([specialPlannedDate(date, [window])]);
  const { service, repository } = buildService(() => normalSessionRows(date), undefined, planner);
  const result = await service.acquire({ fromDate: date, toDate: date });

  assert.deepEqual(result.sessions.newlyCompleted, [date]);
  assert.deepEqual(result.sessions.closedNoDataExpected, []); // never treated as a weekend closure
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(repository.bulkUpsertCallCount, 1);
});

// ---- CAL-2 section 32: uncertified (never inferred as weekend) --------------

test('CAL-2 UNCERTIFIED: a BLOCKED_UNCERTIFIED date fails the whole request closed BEFORE any provider call', async () => {
  const date = '2026-08-29';
  const planner = new FakeExplicitPlanner([blockedPlannedDate(date)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called for a blocked date');
  }, undefined, planner);

  await assert.rejects(service.acquire({ fromDate: date, toDate: date }), (error: unknown) => {
    assert.ok(error instanceof NiftyAcquisitionCalendarBlockedError);
    assert.deepEqual(error.blockedDates, [date]);
    return true;
  });
  assert.equal(provider.calls.length, 0);
});

// ---- CAL-2 section 33: blocked mixed range -----------------------------------

test('CAL-2 RANGE BLOCK: one blocked date anywhere in a multi-date range blocks the ENTIRE request, including its certified-regular sibling date', async () => {
  const regular = '2026-08-28';
  const blockedA = '2026-08-29';
  const blockedB = '2026-08-30';
  const planner = new FakeExplicitPlanner([regularPlannedDate(regular), blockedPlannedDate(blockedA), blockedPlannedDate(blockedB)]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called when the requested range contains any blocked date');
  }, undefined, planner);

  await assert.rejects(service.acquire({ fromDate: regular, toDate: blockedB }), (error: unknown) => {
    assert.ok(error instanceof NiftyAcquisitionCalendarBlockedError);
    assert.deepEqual(error.blockedDates, [blockedA, blockedB]);
    return true;
  });
  assert.equal(provider.calls.length, 0); // not even the certified-regular 2026-08-28 triggers a call
});

// ---- CAL-2 section 34: mixed certified closed/open range --------------------

test('CAL-2 MIXED RANGE: 2024-01-19..2024-01-22 fetches once for the whole chunk, credits 375+375 minutes to the two open dates, and reports zero expected minutes with zero false gaps for the two closed dates', async () => {
  const regular = '2024-01-19';
  const special = '2024-01-20';
  const weekend = '2024-01-21';
  const exceptional = '2024-01-22';
  const specialWindow = regularSessionWindow();
  const planner = new FakeExplicitPlanner([
    regularPlannedDate(regular),
    specialPlannedDate(special, [specialWindow]),
    closedPlannedDate(weekend, NiftyPlannedDateDisposition.CLOSED_WEEKEND),
    closedPlannedDate(exceptional, NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL),
  ]);
  const { service, provider, repository } = buildService(
    () => [...normalSessionRows(regular), ...normalSessionRows(special)],
    undefined,
    planner
  );
  const result = await service.acquire({ fromDate: regular, toDate: exceptional });

  assert.equal(provider.calls.length, 1); // one whole-chunk request, never one per date
  assert.deepEqual([...result.sessions.newlyCompleted].sort(), [regular, special].sort());
  assert.deepEqual([...result.sessions.closedNoDataExpected].sort(), [weekend, exceptional].sort());
  assert.equal(result.canonicalRowsAccepted, 750); // 375 + 375 + 0 + 0
  assert.deepEqual(result.sessions.unresolvedNoData, []);
  assert.deepEqual(result.sessions.incomplete, []);
  assert.equal(repository.bulkUpsertCallCount, 2);
});

// ---- CAL-2 section 44: real-chain test (real planner + real resolver-fake) --

interface RealChainResolveRangeCall {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly fromDate: string;
  readonly toDate: string;
}

function realChainUncertifiedResolution(tradingDate: string): TradingDayResolution {
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

function realChainResolution(overrides: Partial<TradingDayResolution> & { tradingDate: string }): TradingDayResolution {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    classification: CalendarClassification.REGULAR_SESSION,
    isTradingDay: true,
    isSpecialSession: false,
    sessionWindows: [],
    explicitReason: null,
    sourceDocument: null,
    coverage: fakeCoverage(),
    ...overrides,
  };
}

/** Duck-typed fake conforming to the subset of `ExchangeCalendarResolverService` the planner calls (`resolveRange` only) -- same convention as `nifty-underlying-ingestion-planner.service.test.ts`'s own fixture. */
class FakeCalendarResolverForRealChain {
  public readonly calls: RealChainResolveRangeCall[] = [];

  constructor(private readonly byDate: ReadonlyMap<string, TradingDayResolution> = new Map()) {}

  async resolveRange(exchange: Exchange, segment: ExchangeSegment, fromDate: string, toDate: string): Promise<TradingDayResolution[]> {
    this.calls.push({ exchange, segment, fromDate, toDate });
    const results: TradingDayResolution[] = [];
    let cursor = fromDate;
    while (cursor <= toDate) {
      results.push(this.byDate.get(cursor) ?? realChainUncertifiedResolution(cursor));
      cursor = addExchangeCalendarDays(cursor, 1);
    }
    return results;
  }
}

test('CAL-2 REAL CHAIN: certified regular + holiday + special dates flow through the REAL planner + a real-resolver-shaped fake + REAL acquisition orchestration + fake provider + REAL projector/validator', async () => {
  const regular = '2031-01-06';
  const holiday = '2031-01-07';
  const special = '2031-01-08';
  const specialWindows: SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }];

  const byDate = new Map<string, TradingDayResolution>([
    [regular, realChainResolution({ tradingDate: regular })],
    [
      holiday,
      realChainResolution({
        tradingDate: holiday,
        classification: CalendarClassification.EXCHANGE_HOLIDAY,
        isTradingDay: false,
        explicitReason: 'synthetic holiday',
      }),
    ],
    [
      special,
      realChainResolution({
        tradingDate: special,
        classification: CalendarClassification.SPECIAL_SESSION,
        isSpecialSession: true,
        sessionWindows: specialWindows,
        explicitReason: 'synthetic special session',
      }),
    ],
  ]);
  const fakeResolver = new FakeCalendarResolverForRealChain(byDate);
  const realPlanner = new NiftyUnderlyingIngestionPlannerService({ calendarResolver: fakeResolver as unknown as ExchangeCalendarResolverService });

  const repository = new FakeHistoricalCandleRepository();
  const provider = new FakeHistoricalDataProvider(() => [...normalSessionRows(regular), ...normalSessionRows(special)]);
  const service = new NiftyUnderlyingAcquisitionService({
    provider,
    repository: repository as unknown as HistoricalCandleRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    plannerService: realPlanner,
  });

  const result = await service.acquire({ fromDate: regular, toDate: special });

  assert.equal(fakeResolver.calls.length, 1);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual([...result.sessions.newlyCompleted].sort(), [regular, special].sort());
  assert.deepEqual(result.sessions.closedNoDataExpected, [holiday]);
  assert.equal(result.canonicalRowsAccepted, 750);
  assert.equal(repository.bulkUpsertCallCount, 2);
});

test('CAL-2 REAL CHAIN: an UNCERTIFIED date fails closed through the exact same real planner + real-resolver-shaped fake, zero provider calls', async () => {
  const tradingDate = '2031-02-01';
  const fakeResolver = new FakeCalendarResolverForRealChain(); // nothing registered -> every date resolves UNCERTIFIED
  const realPlanner = new NiftyUnderlyingIngestionPlannerService({ calendarResolver: fakeResolver as unknown as ExchangeCalendarResolverService });
  const provider = new FakeHistoricalDataProvider(() => {
    throw new Error('provider must never be called for an uncertified date');
  });
  const service = new NiftyUnderlyingAcquisitionService({
    provider,
    repository: new FakeHistoricalCandleRepository() as unknown as HistoricalCandleRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    plannerService: realPlanner,
  });

  await assert.rejects(service.acquire({ fromDate: tradingDate, toDate: tradingDate }), NiftyAcquisitionCalendarBlockedError);
  assert.equal(provider.calls.length, 0);
});

// ============================================================================
// B-F2-CAL-2-FIX-1: whole-plan pre-provider invariant validation
// ============================================================================

function rejectsWithPlanInvariant(
  resultPromise: Promise<unknown>,
  expectedReason: NiftyAcquisitionCalendarPlanInvariantReason,
  expectedTradingDate: string
): Promise<void> {
  return assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof NiftyAcquisitionCalendarPlanInvariantError);
    assert.equal(error.reason, expectedReason);
    assert.equal(error.tradingDate, expectedTradingDate);
    return true;
  });
}

// ---- Terra reproduction (task section 3/15) --------------------------------

test('CAL-2-FIX-1 TERRA 44-vs-45: sessionWindows=[555,600) (canonically 45 minutes) but expectedMinuteCount=44/expectedMinutesIst=555..598 fails closed BEFORE any provider call, zero writes', async () => {
  const date = '2024-11-05';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const broken = inconsistentPlannedDate(specialPlannedDate(date, [window]), {
    expectedMinuteCount: 44,
    expectedMinutesIst: Array.from({ length: 44 }, (_, i) => 555 + i), // 555..598 -- self-consistent with the wrong count, but not with the window
  });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider, repository } = buildService(() => {
    throw new Error('provider must never be called for an internally-inconsistent plan entry');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_COUNT_MISMATCH,
    date
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- Count-only mismatch (task section 16) ----------------------------------

test('CAL-2-FIX-1 COUNT-ONLY MISMATCH: expectedMinutesIst is canonically correct (555..599) but expectedMinuteCount lies as 44 -- rejected on count mismatch alone', async () => {
  const date = '2024-11-06';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const correctMinutes = Array.from({ length: 45 }, (_, i) => 555 + i);
  const broken = inconsistentPlannedDate(specialPlannedDate(date, [window]), { expectedMinuteCount: 44, expectedMinutesIst: correctMinutes });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_COUNT_MISMATCH,
    date
  );
  assert.equal(provider.calls.length, 0);
});

// ---- Equal-count/wrong-member mismatch (task section 17) --------------------

test('CAL-2-FIX-1 SET-MEMBERSHIP MISMATCH: equal length/count (45/45) but one wrong member (600 instead of 599) fails closed -- equal count is not enough', async () => {
  const date = '2024-11-07';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const wrongMember = [...Array.from({ length: 44 }, (_, i) => 555 + i), 600]; // 555..598 plus 600 -- 599 never appears
  const broken = inconsistentPlannedDate(specialPlannedDate(date, [window]), { expectedMinuteCount: 45, expectedMinutesIst: wrongMember });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_SET_MISMATCH,
    date
  );
  assert.equal(provider.calls.length, 0);
});

// ---- Duplicate expected minute (task section 18) ----------------------------

test('CAL-2-FIX-1 DUPLICATE EXPECTED MINUTE: 45 entries with one value duplicated and another missing fails closed (never Set-normalized into a false match)', async () => {
  const date = '2024-11-08';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const duplicated = [...Array.from({ length: 44 }, (_, i) => 555 + i), 570]; // 555..598 plus a duplicate of 570 -- 599 never appears
  const broken = inconsistentPlannedDate(specialPlannedDate(date, [window]), { expectedMinuteCount: 45, expectedMinutesIst: duplicated });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_SET_MISMATCH,
    date
  );
  assert.equal(provider.calls.length, 0);
});

// ---- Reordered vector (task section 19) -------------------------------------

test('CAL-2-FIX-1 REORDERED VECTOR: the exact same 45 values in a different order fails closed -- the canonical vector is positionally exact, not a multiset', async () => {
  const date = '2024-11-09';
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const correctMinutes = Array.from({ length: 45 }, (_, i) => 555 + i);
  const reordered = [...correctMinutes].reverse();
  const broken = inconsistentPlannedDate(specialPlannedDate(date, [window]), { expectedMinuteCount: 45, expectedMinutesIst: reordered });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider } = buildService(() => {
    throw new Error('provider must never be called');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_SET_MISMATCH,
    date
  );
  assert.equal(provider.calls.length, 0);
});

// ---- Closed-date contradiction (task section 20) ----------------------------

test('CAL-2-FIX-1 CLOSED-DATE CONTRADICTION: a CLOSED_HOLIDAY date claiming expectedMinuteCount=1 fails closed, provider=0, persisted=0', async () => {
  const date = '2024-11-10';
  const broken = inconsistentPlannedDate(closedPlannedDate(date, NiftyPlannedDateDisposition.CLOSED_HOLIDAY), { expectedMinuteCount: 1 });
  const planner = new FakeExplicitPlanner([broken]);
  const { service, provider, repository } = buildService(() => {
    throw new Error('provider must never be called');
  }, undefined, planner);

  await rejectsWithPlanInvariant(
    service.acquire({ fromDate: date, toDate: date }),
    NiftyAcquisitionCalendarPlanInvariantReason.CLOSED_DATE_HAS_SESSION_EXPECTATION,
    date
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(repository.bulkUpsertCallCount, 0);
});

// ---- Valid regular/special/Saturday/uncertified nonregressions (task 21-24) -
// already covered verbatim by the existing CAL-2 REGULAR / SPECIAL SINGLE-
// WINDOW / SPECIAL MULTI-WINDOW / FULL-DAY SPECIAL ON SATURDAY / UNCERTIFIED /
// RANGE BLOCK tests above -- all still pass unchanged (see full suite run),
// proving the new invariant validation accepts every internally-consistent
// plan the real planner (or a correctly-built fake) produces.

// ---- Mixed whole-chunk closed-row injection (task section 28) --------------

test('CAL-2-FIX-1 MIXED CHUNK CLOSED-ROW INJECTION: provider rows for certified-closed dates inside a mixed whole-chunk response are never persisted or classified as completed sessions', async () => {
  const regular = '2024-01-19';
  const special = '2024-01-20';
  const weekend = '2024-01-21';
  const exceptional = '2024-01-22';
  const specialWindow = regularSessionWindow();
  const planner = new FakeExplicitPlanner([
    regularPlannedDate(regular),
    specialPlannedDate(special, [specialWindow]),
    closedPlannedDate(weekend, NiftyPlannedDateDisposition.CLOSED_WEEKEND),
    closedPlannedDate(exceptional, NiftyPlannedDateDisposition.CLOSED_EXCEPTIONAL),
  ]);
  // The provider ALSO returns valid-looking rows for the two certified-closed
  // dates -- a realistic upstream anomaly (e.g. a monthly response spanning a
  // weekend) this correction must tolerate without ever persisting them.
  const { service, provider, repository } = buildService(
    () => [...normalSessionRows(regular), ...normalSessionRows(special), ...normalSessionRows(weekend), ...normalSessionRows(exceptional)],
    undefined,
    planner
  );
  const result = await service.acquire({ fromDate: regular, toDate: exceptional });

  assert.equal(provider.calls.length, 1);
  assert.deepEqual([...result.sessions.newlyCompleted].sort(), [regular, special].sort());
  assert.deepEqual([...result.sessions.closedNoDataExpected].sort(), [weekend, exceptional].sort());
  assert.ok(!result.sessionDetails.some((detail) => detail.tradingDate === weekend && detail.bucket !== 'CLOSED_NO_DATA_EXPECTED'));
  assert.ok(!result.sessionDetails.some((detail) => detail.tradingDate === exceptional && detail.bucket !== 'CLOSED_NO_DATA_EXPECTED'));
  assert.equal(repository.bulkUpsertCallCount, 2); // only regular + special persisted
  assert.equal(result.canonicalRowsAccepted, 750); // 375 + 375 -- the closed dates' rows are never counted
});
