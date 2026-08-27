import assert from 'node:assert/strict';
import test from 'node:test';
import GrowwOptionCandleAcquisitionService, { GrowwOptionAcquisitionFailureReason } from './groww-option-candle-acquisition.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import { HistoricalDataProvider, HistoricalOptionCandleRangeRequest } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { CanonicalHistoricalCandle, HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import { OptionCandleObservationState } from '../domain/historical-option-candle-observation.types';
import HistoricalOptionCandleLakeRepository, { HistoricalOptionCandleLakeIdentity } from '../repositories/historical-option-candle-lake.repository';
import { GrowwAuthenticationError } from '../providers/groww/groww-historical-client';

const SYMBOL = 'NSE-NIFTY-06Jan22-17200-PE';

// ---- Fakes ---------------------------------------------------------------

interface StoredRow { candleTime: Date; }

class FakeLakeRepository {
  private readonly rowsByDate = new Map<string, Map<number, StoredRow>>();
  upsertCallCount = 0;
  upsertedIdentities: HistoricalOptionCandleLakeIdentity[] = [];
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<StoredRow[]> {
    this.findRangeCallCount += 1;
    const rows: StoredRow[] = [];
    for (const map of this.rowsByDate.values()) for (const row of map.values()) if (row.candleTime >= from && row.candleTime <= to) rows.push(row);
    return rows.sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }

  async upsertCandles(identity: HistoricalOptionCandleLakeIdentity, _timeframe: string, candles: readonly CanonicalHistoricalCandle[]): Promise<number> {
    this.upsertCallCount += 1;
    this.upsertedIdentities.push(identity);
    for (const candle of candles) {
      const date = istDateKey(candle.candleTime);
      const map = this.rowsByDate.get(date) ?? new Map<number, StoredRow>();
      this.rowsByDate.set(date, map);
      map.set(candle.candleTime.getTime(), { candleTime: candle.candleTime });
    }
    return candles.length;
  }

  seedCompleteSession(date: string): void {
    const map = new Map<number, StoredRow>();
    for (const row of normalSessionRows(date)) map.set(row.candleTime.getTime(), { candleTime: row.candleTime });
    this.rowsByDate.set(date, map);
  }
}

function istDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

type FakeResponse = readonly HistoricalSourceCandleRow[] | { permanent: true } | { transient: true } | { auth: 401 | 403 };

class FakeProvider implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.GROWW;
  readonly calls: HistoricalOptionCandleRangeRequest[] = [];

  constructor(private readonly respond: (request: HistoricalOptionCandleRangeRequest) => FakeResponse) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.GROWW,
      earliestDocumentedUnderlyingHistory: null,
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: true,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: 30,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false,
      rateLimitPolicy: { policyId: 'FAKE_DEFAULT' },
    };
  }

  async fetchCompletedUnderlyingRange(): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('not supported by fake');
  }

  async fetchExpiredOptionRange(request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    this.calls.push(request);
    const result = this.respond(request);
    if ('auth' in (result as object)) {
      throw new GrowwAuthenticationError(`Groww authentication failed (HTTP ${(result as { auth: number }).auth})`, (result as { auth: number }).auth, undefined);
    }
    if ('permanent' in (result as object)) {
      throw Object.assign(new Error('Request failed with status code 400'), { isAxiosError: true, response: { status: 400, headers: {} }, config: {} });
    }
    if ('transient' in (result as object)) {
      throw Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503, headers: {} }, config: {} });
    }
    return result as readonly HistoricalSourceCandleRow[];
  }
}

function row(sourceIndex: number, isoTimeWithOffset: string, overrides: Partial<HistoricalSourceCandleRow> = {}): HistoricalSourceCandleRow {
  return { sourceIndex, candleTime: new Date(isoTimeWithOffset), open: 100, high: 101, low: 99, close: 100.5, volume: 1_000n, openInterest: null, ...overrides };
}

function normalSessionRows(date: string): HistoricalSourceCandleRow[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => row(index, new Date(start + index * 60_000).toISOString()));
}

function buildService(
  respond: (request: HistoricalOptionCandleRangeRequest) => FakeResponse,
  repository: FakeLakeRepository = new FakeLakeRepository()
): { service: GrowwOptionCandleAcquisitionService; provider: FakeProvider; repository: FakeLakeRepository } {
  const provider = new FakeProvider(respond);
  const service = new GrowwOptionCandleAcquisitionService({
    provider,
    repository: repository as unknown as HistoricalOptionCandleLakeRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return { service, provider, repository };
}

// ---- Identity parsing ------------------------------------------------------

test('rejects a malformed providerContractId before ever calling the provider', async () => {
  const { service, provider } = buildService(() => []);
  await assert.rejects(service.acquire({ providerContractId: 'not-a-groww-symbol', tradingDates: ['2022-01-03'] }));
  assert.equal(provider.calls.length, 0);
});

test('rejects an empty tradingDates array -- never defaults to a bulk range', async () => {
  const { service } = buildService(() => []);
  await assert.rejects(service.acquire({ providerContractId: SYMBOL, tradingDates: [] }));
});

// ---- (K) complete session ---------------------------------------------------

test('(K) a full 375-row session is persisted, reconciled, and bucketed NEWLY_COMPLETE / COMPLETE_SESSION', async () => {
  const date = '2022-01-03';
  const { service, repository } = buildService(() => normalSessionRows(date));
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.newlyComplete, [date]);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.observationState, OptionCandleObservationState.COMPLETE_SESSION);
  assert.equal(detail.persisted, true);
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(repository.upsertCallCount, 1);
  assert.equal(repository.upsertedIdentities[0].optionType, 'PE');
  assert.equal(repository.upsertedIdentities[0].strikePrice, 17200);
});

// ---- (L) partial session -----------------------------------------------------

test('(L) a partial session (100 of 375 minutes) is bucketed OBSERVED_PARTIAL / PARTIAL_OBSERVED_SESSION, never complete, but IS persisted', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date).slice(0, 100);
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.observedPartial, [date]);
  assert.deepEqual(result.sessions.newlyComplete, []);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.observationState, OptionCandleObservationState.PARTIAL_OBSERVED_SESSION);
  assert.equal(detail.canonicalRowCount, 100);
  assert.equal(detail.persisted, true);
  assert.equal(repository.upsertCallCount, 1);
});

// ---- (M) zero rows -----------------------------------------------------------

test('(M) zero observed candles is truthfully NO_OBSERVED_TRADING, not a provider failure, and nothing is persisted', async () => {
  const date = '2022-01-03';
  const { service, repository } = buildService(() => []);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.noObservedTrading, [date]);
  assert.deepEqual(result.failedSessions, []);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.observationState, OptionCandleObservationState.NO_OBSERVED_TRADING);
  assert.equal(detail.persisted, false);
  assert.equal(repository.upsertCallCount, 0);
});

// ---- (N) duplicate/gap/out-of-order --------------------------------------

test('(N) a duplicate timestamp fails closed as INVALID and is never persisted', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date);
  rows[1] = row(1, rows[0].candleTime.toISOString()); // duplicate of row 0's timestamp
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.invalid, [date]);
  assert.equal(repository.upsertCallCount, 0);
});

test('(N) an out-of-order raw delivery fails closed as INVALID', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date);
  [rows[0], rows[1]] = [rows[1], rows[0]]; // swap -> non-monotonic raw order
  const { service, repository } = buildService(() => rows);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.invalid, [date]);
  assert.equal(repository.upsertCallCount, 0);
});

// ---- (O) excluded pre/post rows are auditable -------------------------------

test('(O) pre/post-market rows are excluded but remain auditable, and the still-complete session is COMPLETE_SESSION', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date);
  rows.unshift(row(9998, `${date}T09:07:00+05:30`));
  rows.push(row(9999, `${date}T15:35:00+05:30`));
  const { service } = buildService(() => rows);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.observationState, OptionCandleObservationState.COMPLETE_SESSION);
  assert.equal(detail.canonicalRowCount, 375);
  assert.equal(detail.excludedRowCount, 2);
  assert.equal(result.excludedRows, 2);
});

// ---- (P) already-complete session is skipped --------------------------------

test('(P) an already-complete stored session is skipped -- no fetch, bucketed ALREADY_COMPLETE', async () => {
  const date = '2022-01-03';
  const repository = new FakeLakeRepository();
  repository.seedCompleteSession(date);
  const { service, provider } = buildService(() => normalSessionRows(date), repository);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.alreadyComplete, [date]);
  assert.equal(provider.calls.length, 0);
  assert.equal(result.requests, 0);
});

// ---- (Q) crash/restart resume ------------------------------------------------

test('(Q) a second run against the same (already-persisted) session detects completeness and skips -- simulating restart-after-crash resume', async () => {
  const date = '2022-01-03';
  const repository = new FakeLakeRepository();
  const { service: firstRun, provider: firstProvider } = buildService(() => normalSessionRows(date), repository);
  await firstRun.acquire({ providerContractId: SYMBOL, tradingDates: [date] });
  assert.equal(firstProvider.calls.length, 1);

  const { service: secondRun, provider: secondProvider } = buildService(() => normalSessionRows(date), repository);
  const result = await secondRun.acquire({ providerContractId: SYMBOL, tradingDates: [date] });
  assert.deepEqual(result.sessions.alreadyComplete, [date]);
  assert.equal(secondProvider.calls.length, 0); // never re-fetched
});

// ---- (R) a weaker response cannot overwrite a healthy stored session ------

test('(R) a weaker/invalid response can never overwrite an already-healthy stored session', async () => {
  const date = '2022-01-03';
  const repository = new FakeLakeRepository();
  repository.seedCompleteSession(date);
  const { service, provider } = buildService(() => [] /* would-be weaker empty response */, repository);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.deepEqual(result.sessions.alreadyComplete, [date]);
  assert.equal(provider.calls.length, 0); // never even fetched -- resume check alone prevents any overwrite risk
  const stored = await repository.findRange(SYMBOL, '1minute', new Date(`${date}T00:00:00+05:30`), new Date(`${date}T23:59:59+05:30`));
  assert.equal(stored.length, 375);
});

// ---- (S) every retry passes the shared limiter ------------------------------

test('(S) transient failures are retried and every attempt (including retries) passes through the shared rate limiter', async () => {
  const date = '2022-01-03';
  let attempt = 0;
  const scheduleCalls: number[] = [];
  const limiter = new HistoricalProviderRateLimiterService(0);
  const originalSchedule = limiter.schedule.bind(limiter);
  limiter.schedule = (async (task: () => Promise<unknown>) => {
    scheduleCalls.push(Date.now());
    return originalSchedule(task);
  }) as typeof limiter.schedule;

  const provider = new FakeProvider(() => {
    attempt += 1;
    return attempt < 3 ? { transient: true } : normalSessionRows(date);
  });
  const service = new GrowwOptionCandleAcquisitionService({
    provider,
    repository: new FakeLakeRepository() as unknown as HistoricalOptionCandleLakeRepository,
    rateLimiter: limiter,
    retryOptions: { sleep: async () => {}, maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.equal(attempt, 3);
  assert.equal(scheduleCalls.length, 3); // every attempt (including the 2 retries) went through the SAME limiter instance
  assert.equal(result.retries, 2);
  assert.deepEqual(result.sessions.newlyComplete, [date]);
});

// ---- (T) 401/403 fails closed, no token leakage, stops the run -------------

test('(T) a 401 fails closed, is classified AUTHENTICATION_FAILED, and stops the run without attempting remaining sessions', async () => {
  const { service, provider } = buildService(() => ({ auth: 401 }));
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: ['2022-01-03', '2022-01-04', '2022-01-05'] });

  assert.equal(result.authenticationFailed, true);
  assert.equal(result.failedSessions.length, 1);
  assert.equal(result.failedSessions[0].reason, GrowwOptionAcquisitionFailureReason.AUTHENTICATION_FAILED);
  assert.equal(provider.calls.length, 1); // stopped immediately -- never tried 01-04/01-05 against a known-bad token
  assert.ok(!result.failedSessions[0].detail.includes('Bearer'));
});

// ---- (U) dry run performs zero DB writes ------------------------------------

test('(U) dry run reports the true observation state but performs zero persistence', async () => {
  const date = '2022-01-03';
  const { service, repository } = buildService(() => normalSessionRows(date));
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date], dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(repository.upsertCallCount, 0);
  const detail = result.sessionDetails.find((d) => d.tradingDate === date)!;
  assert.equal(detail.observationState, OptionCandleObservationState.COMPLETE_SESSION); // truthfully computed even though nothing was written
  assert.equal(detail.persisted, false);
  assert.deepEqual(result.sessions.newlyComplete, [date]); // bucketed by observation state, independent of persistence
});

// ---- OI aggregation ----------------------------------------------------------

test('OI rows-with/without counts are aggregated truthfully across a session, never fabricated', async () => {
  const date = '2022-01-03';
  const rows = normalSessionRows(date).map((r, index) => (index < 5 ? row(r.sourceIndex, r.candleTime.toISOString(), { openInterest: 100n }) : r));
  const { service } = buildService(() => rows);
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: [date] });

  assert.equal(result.oi.rowsWithOi, 5);
  assert.equal(result.oi.rowsWithNullOi, 370);
});

// ---- Retry-exhausted classification -----------------------------------------

test('a permanent (non-auth) provider error is classified FETCH_PERMANENT and bucketed PROVIDER_UNAVAILABLE', async () => {
  const { service, repository } = buildService(() => ({ permanent: true }));
  const result = await service.acquire({ providerContractId: SYMBOL, tradingDates: ['2022-01-03'] });

  assert.deepEqual(result.sessions.providerUnavailable, ['2022-01-03']);
  assert.equal(result.failedSessions[0].reason, GrowwOptionAcquisitionFailureReason.FETCH_PERMANENT);
  assert.equal(repository.upsertCallCount, 0);
});
