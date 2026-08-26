import assert from 'node:assert/strict';
import test from 'node:test';
import NiftyUnderlyingAcquisitionService, {
  NIFTY_INDEX_INSTRUMENT_KEY,
  NIFTY_UNDERLYING_TIMEFRAME,
} from './nifty-underlying-acquisition.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import { HistoricalDataProvider, HistoricalUnderlyingCandleRangeRequest } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import HistoricalCandleRepository, { HistoricalCandleUpsertInput } from '../../historical-candles/repositories/historical-candle.repository';

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

function buildService(
  respond: (request: HistoricalUnderlyingCandleRangeRequest) => FakeResponse,
  repository: FakeHistoricalCandleRepository = new FakeHistoricalCandleRepository()
): { service: NiftyUnderlyingAcquisitionService; provider: FakeHistoricalDataProvider; repository: FakeHistoricalCandleRepository } {
  const provider = new FakeHistoricalDataProvider(respond);
  const service = new NiftyUnderlyingAcquisitionService({
    provider,
    repository: repository as unknown as HistoricalCandleRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return { service, provider, repository };
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

test('a weekend date with no rows is simply not enumerated as unresolved (calendarWeekdays excludes it)', async () => {
  const saturday = '2022-01-15';
  const { service } = buildService(() => []);
  const result = await service.acquire({ fromDate: saturday, toDate: saturday });

  assert.deepEqual(result.sessions.unresolvedNoData, []);
});
