import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarClassification, CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification, SourceDocumentType } from '../domain/exchange-calendar.types';
import ExchangeCalendarRepository, { ExchangeCalendarAmbiguousCoverageError, PersistedCalendarDay, PersistedCoverageIdentity } from '../repositories/exchange-calendar.repository';
import ExchangeCalendarResolverService, { ExchangeCalendarResolutionInputError } from './exchange-calendar-resolver.service';

interface FakeCoverage extends PersistedCoverageIdentity {
  readonly days: Map<string, PersistedCalendarDay>;
}

/**
 * In-memory fake conforming to the subset of `ExchangeCalendarRepository`'s
 * method surface the resolver actually calls -- same convention as
 * `FakeHistoricalCandleRepository` in `dataset-manifest.service.test.ts`
 * (duck-typed via `as unknown as ExchangeCalendarRepository`, no real DB).
 */
class FakeExchangeCalendarRepository {
  private coverages: FakeCoverage[] = [];

  addCoverage(coverage: PersistedCoverageIdentity, days: PersistedCalendarDay[] = []): void {
    const map = new Map<string, PersistedCalendarDay>();
    for (const day of days) map.set(day.tradingDate, day);
    this.coverages.push({ ...coverage, days: map });
  }

  async findCertifiedCoverageForDate(exchange: string, segment: string, tradingDate: string): Promise<PersistedCoverageIdentity | null> {
    const calendarYear = Number(tradingDate.slice(0, 4));
    const matches = this.coverages.filter((c) => c.exchange === exchange && c.segment === segment && c.calendarYear === calendarYear && c.status === CalendarCoverageStatus.CERTIFIED);
    if (matches.length > 1) throw new ExchangeCalendarAmbiguousCoverageError(exchange, segment, calendarYear, matches.map((coverage) => coverage.version));
    const match = matches[0];
    return match && match.coverageFrom <= tradingDate && match.coverageTo >= tradingDate ? match : null;
  }

  async findCertifiedCoverageOverlappingRange(exchange: string, segment: string, fromDate: string, toDate: string): Promise<PersistedCoverageIdentity[]> {
    const candidates = this.coverages.filter((c) => c.exchange === exchange && c.segment === segment && c.status === CalendarCoverageStatus.CERTIFIED && c.calendarYear >= Number(fromDate.slice(0, 4)) && c.calendarYear <= Number(toDate.slice(0, 4)));
    for (const calendarYear of new Set(candidates.map((coverage) => coverage.calendarYear))) {
      const matches = candidates.filter((coverage) => coverage.calendarYear === calendarYear);
      if (matches.length > 1) throw new ExchangeCalendarAmbiguousCoverageError(exchange, segment, calendarYear, matches.map((coverage) => coverage.version));
    }
    return candidates.filter((coverage) => coverage.coverageFrom <= toDate && coverage.coverageTo >= fromDate);
  }

  async findExplicitDay(coverageId: string, tradingDate: string): Promise<PersistedCalendarDay | null> {
    const coverage = this.coverages.find((c) => c.id === coverageId);
    return coverage?.days.get(tradingDate) ?? null;
  }

  async findExplicitDaysByCoverageId(coverageId: string): Promise<Map<string, PersistedCalendarDay>> {
    const coverage = this.coverages.find((c) => c.id === coverageId);
    return coverage ? new Map(coverage.days) : new Map();
  }
}

function certifiedCoverage(overrides: Partial<PersistedCoverageIdentity> = {}): PersistedCoverageIdentity {
  return {
    id: 'cov-1',
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: 2031,
    coverageFrom: '2031-01-01',
    coverageTo: '2031-12-31',
    version: 1,
    status: CalendarCoverageStatus.CERTIFIED,
    sourceAuthority: 'NSE',
    sourceBundleChecksum: 'synthetic-checksum-1',
    ...overrides,
  };
}

const sourceDocument = {
  documentReference: 'SYN-DOC-A',
  documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  contentChecksumSha256: 'a'.repeat(64),
  referenceUrl: null,
};

function newResolver(): { resolver: ExchangeCalendarResolverService; repo: FakeExchangeCalendarRepository } {
  const repo = new FakeExchangeCalendarRepository();
  const resolver = new ExchangeCalendarResolverService(repo as unknown as ExchangeCalendarRepository);
  return { resolver, repo };
}

test('(A) certified normal Monday with no explicit row -> REGULAR_SESSION', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage());
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-01-06'); // Monday
  assert.equal(result.classification, CalendarClassification.REGULAR_SESSION);
  assert.equal(result.isTradingDay, true);
  assert.ok(result.coverage);
  assert.equal(result.coverage?.version, 1);
});

test('(B) certified explicit weekday holiday -> EXCHANGE_HOLIDAY', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage(), [{ tradingDate: '2031-01-08', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, reason: 'Synthetic holiday', sourceDocument, windows: [] }]);
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-01-08'); // Wednesday
  assert.equal(result.classification, CalendarClassification.EXCHANGE_HOLIDAY);
  assert.equal(result.isTradingDay, false);
  assert.equal(result.explicitReason, 'Synthetic holiday');
  assert.deepEqual(result.sourceDocument, sourceDocument);
});

test('(C) certified ordinary Saturday -> WEEKEND', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage());
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-01-04'); // Saturday
  assert.equal(result.classification, CalendarClassification.WEEKEND);
  assert.equal(result.isTradingDay, false);
});

test('(D) certified explicit special Saturday -> SPECIAL_SESSION, overrides weekend rule, returns windows', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage(), [
    {
      tradingDate: '2031-01-04',
      classification: ExplicitCalendarClassification.SPECIAL_SESSION,
      reason: 'Synthetic special session',
      sourceDocument,
      windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 780 }],
    },
  ]);
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-01-04');
  assert.equal(result.classification, CalendarClassification.SPECIAL_SESSION);
  assert.equal(result.isTradingDay, true);
  assert.equal(result.isSpecialSession, true);
  assert.equal(result.sessionWindows.length, 1);
});

test('(E) weekday outside any certified coverage -> UNCERTIFIED', async () => {
  const { resolver } = newResolver();
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-06-15');
  assert.equal(result.classification, CalendarClassification.UNCERTIFIED);
  assert.equal(result.isTradingDay, null);
  assert.equal(result.isSpecialSession, null);
  assert.equal(result.coverage, null);
});

test('(F) DRAFT coverage only -> UNCERTIFIED', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage({ status: CalendarCoverageStatus.DRAFT }));
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-06-15');
  assert.equal(result.classification, CalendarClassification.UNCERTIFIED);
});

test('(G) DEPRECATED coverage only -> UNCERTIFIED (default resolver never uses non-CERTIFIED truth)', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage({ status: CalendarCoverageStatus.DEPRECATED }));
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-06-15');
  assert.equal(result.classification, CalendarClassification.UNCERTIFIED);
});

test('(H) EQUITY and EQUITY_DERIVATIVES resolve the same date differently', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage({ id: 'cov-equity', segment: ExchangeSegment.EQUITY }), [
    { tradingDate: '2031-03-10', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, reason: null, sourceDocument, windows: [] },
  ]);
  repo.addCoverage(certifiedCoverage({ id: 'cov-deriv', segment: ExchangeSegment.EQUITY_DERIVATIVES }));

  const equityResult = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-03-10');
  const derivativesResult = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY_DERIVATIVES, '2031-03-10');
  assert.equal(equityResult.classification, CalendarClassification.EXCHANGE_HOLIDAY);
  assert.equal(derivativesResult.classification, CalendarClassification.REGULAR_SESSION);
});

test('(X) resolveRange includes a Saturday special-session override, proving whole-calendar (not Mon-Fri) iteration', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage(), [
    {
      tradingDate: '2031-01-04', // Saturday
      classification: ExplicitCalendarClassification.SPECIAL_SESSION,
      reason: 'Synthetic special Saturday',
      sourceDocument,
      windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 780 }],
    },
  ]);
  const results = await resolver.resolveRange(Exchange.NSE, ExchangeSegment.EQUITY, '2031-01-01', '2031-01-07');
  assert.equal(results.length, 7);
  // Ascending order.
  assert.deepEqual(
    results.map((r) => r.tradingDate),
    ['2031-01-01', '2031-01-02', '2031-01-03', '2031-01-04', '2031-01-05', '2031-01-06', '2031-01-07']
  );
  const saturday = results.find((r) => r.tradingDate === '2031-01-04');
  assert.equal(saturday?.classification, CalendarClassification.SPECIAL_SESSION);
  const sunday = results.find((r) => r.tradingDate === '2031-01-05');
  assert.equal(sunday?.classification, CalendarClassification.WEEKEND);
});

test('(Y) invalid tradingDate input is rejected before any repository call', async () => {
  const { resolver, repo } = newResolver();
  let called = false;
  repo.findCertifiedCoverageForDate = async () => {
    called = true;
    return null;
  };
  await assert.rejects(() => resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, 'not-a-date'), ExchangeCalendarResolutionInputError);
  await assert.rejects(() => resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-02-29'), ExchangeCalendarResolutionInputError);
  await assert.rejects(() => resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-04-31'), ExchangeCalendarResolutionInputError);
  assert.equal(called, false);
});

test('(Y) invalid exchange/segment input is rejected', async () => {
  const { resolver } = newResolver();
  await assert.rejects(() => resolver.resolveTradingDay('BSE' as Exchange, ExchangeSegment.EQUITY, '2031-01-01'), ExchangeCalendarResolutionInputError);
  await assert.rejects(() => resolver.resolveTradingDay(Exchange.NSE, 'CURRENCY' as ExchangeSegment, '2031-01-01'), ExchangeCalendarResolutionInputError);
});

test('(Y) resolveRange rejects fromDate after toDate before any repository call', async () => {
  const { resolver, repo } = newResolver();
  let called = false;
  repo.findCertifiedCoverageOverlappingRange = async () => {
    called = true;
    return [];
  };
  await assert.rejects(() => resolver.resolveRange(Exchange.NSE, ExchangeSegment.EQUITY, '2031-02-01', '2031-01-01'), ExchangeCalendarResolutionInputError);
  assert.equal(called, false);
});

test('a single CERTIFIED snapshot outside its explicit covered interval resolves UNCERTIFIED', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage({ coverageFrom: '2031-01-01', coverageTo: '2031-06-30' }));
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-07-01');
  assert.equal(result.classification, CalendarClassification.UNCERTIFIED);
  assert.equal(result.isTradingDay, null);
});

test('multiple CERTIFIED versions in one scope/year fail closed without selecting max(version)', async () => {
  const { resolver, repo } = newResolver();
  repo.addCoverage(certifiedCoverage({ id: 'cov-v1', version: 1 }));
  repo.addCoverage(certifiedCoverage({ id: 'cov-v2', version: 2 }));
  await assert.rejects(
    () => resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, '2031-06-01'),
    ExchangeCalendarAmbiguousCoverageError
  );
});
