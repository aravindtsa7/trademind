import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalendarClassification,
  CalendarCoverageStatus,
  Exchange,
  ExchangeSegment,
  ExplicitCalendarClassification,
  SessionWindow,
  SourceDocumentType,
  TradingDayResolution,
} from '../domain';
import { ExchangeCalendarCoverageFixture } from '../domain/exchange-calendar-fixture.types';
import ExchangeCalendarCertificationService, { ActivateExchangeCalendarVersionRequest } from './exchange-calendar-certification.service';
import ExchangeCalendarImporterService from './exchange-calendar-importer.service';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import ExchangeCalendarRepository, { ExchangeCalendarActivationOutcome, ExchangeCalendarImportOutcome, PersistedCoverageIdentity } from '../repositories/exchange-calendar.repository';
import { CALENDAR_SCHEMA_NOT_DEPLOYED } from './exchange-calendar-ops-schema-error.util';
import ExchangeCalendarOpsRunnerService, { DEFAULT_VERIFY_PROBES } from './exchange-calendar-ops-runner.service';
import { AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURE_YEARS } from '../domain/data/authoritative-nse-equity-calendar-fixtures';

const SCHEMA_NOT_DEPLOYED_ERROR = { code: 'P2021', message: 'The table `exchangecalendarcoverage` does not exist in the current database.' };

function syntheticFixture(calendarYear: number, overrides: Partial<ExchangeCalendarCoverageFixture> = {}): ExchangeCalendarCoverageFixture {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    coverageFrom: `${calendarYear}-01-01`,
    coverageTo: `${calendarYear}-12-31`,
    calendarYear,
    version: 1,
    status: CalendarCoverageStatus.DRAFT,
    sourceAuthority: 'NSE',
    sourceDocuments: [{ documentReference: `SYN-${calendarYear}-A`, documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR, contentChecksumSha256: 'a'.repeat(64), referenceUrl: null }],
    days: [{ tradingDate: `${calendarYear}-01-26`, classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: `SYN-${calendarYear}-A` }],
    ...overrides,
  };
}

class FakeImporter {
  public readonly calls: ExchangeCalendarCoverageFixture[] = [];
  public result: ExchangeCalendarImportOutcome = { kind: 'CREATED', coverageId: 'cov-1', sourceBundleChecksum: 'b'.repeat(64) };
  public throwError: unknown = null;
  async importCoverage(fixture: ExchangeCalendarCoverageFixture): Promise<ExchangeCalendarImportOutcome> {
    this.calls.push(fixture);
    if (this.throwError) throw this.throwError;
    return this.result;
  }
}

class FakeCertifier {
  public readonly calls: ActivateExchangeCalendarVersionRequest[] = [];
  public result: ExchangeCalendarActivationOutcome = { kind: 'ACTIVATED', coverageId: 'cov-1', deprecatedCoverageId: null };
  async activateCertifiedVersion(request: ActivateExchangeCalendarVersionRequest): Promise<ExchangeCalendarActivationOutcome> {
    this.calls.push(request);
    return this.result;
  }
}

class FakeRepository {
  public readonly calls: Array<{ exchange: string; segment: string; calendarYear: number; version: number }> = [];
  public coverage: PersistedCoverageIdentity | null = null;
  public throwError: unknown = null;
  async findCoverageByVersion(exchange: string, segment: string, calendarYear: number, version: number): Promise<PersistedCoverageIdentity | null> {
    this.calls.push({ exchange, segment, calendarYear, version });
    if (this.throwError) throw this.throwError;
    return this.coverage;
  }
}

class FakeResolver {
  public readonly calls: Array<{ exchange: string; segment: string; tradingDate: string }> = [];
  constructor(private readonly byDate: ReadonlyMap<string, TradingDayResolution>) {}
  async resolveTradingDay(exchange: Exchange, segment: ExchangeSegment, tradingDate: string): Promise<TradingDayResolution> {
    this.calls.push({ exchange, segment, tradingDate });
    const found = this.byDate.get(tradingDate);
    if (found) return found;
    return {
      exchange,
      segment,
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
}

function regular(tradingDate: string): TradingDayResolution {
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
    coverage: { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: 2024, version: 1, coverageFrom: '2024-01-01', coverageTo: '2024-12-31', sourceAuthority: 'NSE', sourceBundleChecksum: 'c'.repeat(64) },
  };
}

function special(tradingDate: string, windows: readonly SessionWindow[]): TradingDayResolution {
  return { ...regular(tradingDate), classification: CalendarClassification.SPECIAL_SESSION, isSpecialSession: true, sessionWindows: windows };
}

function newRunner(overrides: {
  fixtures?: readonly ExchangeCalendarCoverageFixture[];
  importer?: FakeImporter;
  certifier?: FakeCertifier;
  repository?: FakeRepository;
  resolverResponses?: ReadonlyMap<string, TradingDayResolution>;
}) {
  const importer = overrides.importer ?? new FakeImporter();
  const certifier = overrides.certifier ?? new FakeCertifier();
  const repository = overrides.repository ?? new FakeRepository();
  const resolver = new FakeResolver(overrides.resolverResponses ?? new Map());
  const runner = new ExchangeCalendarOpsRunnerService({
    fixtures: overrides.fixtures ?? [],
    importer: importer as unknown as ExchangeCalendarImporterService,
    certifier: certifier as unknown as ExchangeCalendarCertificationService,
    repository: repository as unknown as ExchangeCalendarRepository,
    resolver: resolver as unknown as ExchangeCalendarResolverService,
  });
  return { runner, importer, certifier, repository, resolver };
}

// ---------------------------------------------------------------- VALIDATE

test('VALIDATE: ALL selection validates every injected fixture and reports correct summaries', async () => {
  const { runner, importer, certifier, repository, resolver } = newRunner({ fixtures: [syntheticFixture(2022), syntheticFixture(2023)] });
  const result = await runner.runValidate('ALL');
  assert.equal(result.fixturesConsidered, 2);
  assert.equal(result.valid.length, 2);
  assert.equal(result.invalid.length, 0);
  assert.equal(result.allValid, true);
  const y2022 = result.valid.find((v) => v.calendarYear === 2022)!;
  assert.equal(y2022.exchange, Exchange.NSE);
  assert.equal(y2022.segment, ExchangeSegment.EQUITY);
  assert.equal(y2022.coverageFrom, '2022-01-01');
  assert.equal(y2022.coverageTo, '2022-12-31');
  assert.equal(y2022.explicitDayCount, 1);
  assert.equal(y2022.sourceDocumentCount, 1);
  assert.equal(y2022.specialSessionCount, 0);
  assert.equal(/^[a-f0-9]{64}$/.test(y2022.sourceBundleChecksum), true);
  // VALIDATE must never touch the importer/certifier/repository/resolver.
  assert.equal(importer.calls.length, 0);
  assert.equal(certifier.calls.length, 0);
  assert.equal(repository.calls.length, 0);
  assert.equal(resolver.calls.length, 0);
});

test('VALIDATE: a single-year selection filters correctly', async () => {
  const { runner } = newRunner({ fixtures: [syntheticFixture(2022), syntheticFixture(2023)] });
  const result = await runner.runValidate(2023);
  assert.equal(result.fixturesConsidered, 1);
  assert.equal(result.valid[0].calendarYear, 2023);
});

test('VALIDATE: an invalid fixture is captured with its errorCode, not thrown, and does not block other valid fixtures in the batch', async () => {
  const badFixture = syntheticFixture(2024, { days: [{ tradingDate: '2024-01-26', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'MISSING-REF' }] });
  const { runner } = newRunner({ fixtures: [syntheticFixture(2022), badFixture] });
  const result = await runner.runValidate('ALL');
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].calendarYear, 2022);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].calendarYear, 2024);
  assert.equal(result.invalid[0].errorCode, 'UNKNOWN_SOURCE_DOCUMENT_REFERENCE');
  assert.equal(result.allValid, false);
});

test('VALIDATE: computed checksum is deterministic across repeated calls', async () => {
  const { runner } = newRunner({ fixtures: [syntheticFixture(2022)] });
  const first = await runner.runValidate(2022);
  const second = await runner.runValidate(2022);
  assert.equal(first.valid[0].sourceBundleChecksum, second.valid[0].sourceBundleChecksum);
});

test('VALIDATE against the real authoritative registry (populated by B-F7A-SOURCE-EVIDENCE-1) considers all 5 registered years and every one is valid', async () => {
  const runner = new ExchangeCalendarOpsRunnerService(); // real default dependencies, but VALIDATE never touches them
  const result = await runner.runValidate('ALL');
  assert.equal(result.fixturesConsidered, 5);
  assert.equal(result.valid.length, 5);
  assert.equal(result.invalid.length, 0);
  assert.equal(result.allValid, true);
  assert.deepEqual(
    result.valid.map((v) => v.calendarYear).sort((a, b) => a - b),
    [2022, 2023, 2024, 2025, 2026]
  );
});

// ------------------------------------------------------------- IMPORT_DRAFT

test('IMPORT_DRAFT: the exact selected fixture is passed to the importer, for only the one requested year', async () => {
  const y2022 = syntheticFixture(2022);
  const y2023 = syntheticFixture(2023);
  const { runner, importer, certifier } = newRunner({ fixtures: [y2022, y2023] });
  const result = await runner.runImportDraft(2023);
  assert.equal(importer.calls.length, 1);
  assert.deepEqual(importer.calls[0], y2023);
  assert.equal(result.outcome, 'IMPORTED');
  // no certification call follows an import
  assert.equal(certifier.calls.length, 0);
});

test('IMPORT_DRAFT: an unregistered year returns NO_FIXTURE_REGISTERED without ever calling the importer', async () => {
  const { runner, importer } = newRunner({ fixtures: [syntheticFixture(2022)] });
  const result = await runner.runImportDraft(2099);
  assert.deepEqual(result, { outcome: 'NO_FIXTURE_REGISTERED', calendarYear: 2099 });
  assert.equal(importer.calls.length, 0);
});

test('IMPORT_DRAFT: an invalid registered fixture returns INVALID_FIXTURE without ever calling the importer', async () => {
  const badFixture = syntheticFixture(2024, { days: [{ tradingDate: '2024-01-26', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'MISSING-REF' }] });
  const { runner, importer } = newRunner({ fixtures: [badFixture] });
  const result = await runner.runImportDraft(2024);
  assert.equal(result.outcome, 'INVALID_FIXTURE');
  assert.equal(importer.calls.length, 0);
});

test('IMPORT_DRAFT: a schema-not-deployed error from the importer is classified, never converted into a false success', async () => {
  const importer = new FakeImporter();
  importer.throwError = SCHEMA_NOT_DEPLOYED_ERROR;
  const { runner } = newRunner({ fixtures: [syntheticFixture(2022)], importer });
  const result = await runner.runImportDraft(2022);
  assert.deepEqual(result, { outcome: CALENDAR_SCHEMA_NOT_DEPLOYED, calendarYear: 2022 });
});

test('IMPORT_DRAFT: an unrelated importer error is rethrown, not swallowed', async () => {
  const importer = new FakeImporter();
  importer.throwError = new Error('unrelated failure');
  const { runner } = newRunner({ fixtures: [syntheticFixture(2022)], importer });
  await assert.rejects(() => runner.runImportDraft(2022), /unrelated failure/);
});

// ------------------------------------------------------------------ CERTIFY

test('CERTIFY: passes the exact NSE/EQUITY/year/version request, and no import call automatically precedes or follows it', async () => {
  const repository = new FakeRepository();
  repository.coverage = { id: 'cov-9', exchange: 'NSE', segment: 'EQUITY', calendarYear: 2024, coverageFrom: '2024-01-01', coverageTo: '2024-12-31', version: 1, status: 'DRAFT' as never, sourceAuthority: 'NSE', sourceBundleChecksum: 'd'.repeat(64) };
  const { runner, certifier, importer } = newRunner({ repository });
  const result = await runner.runCertify(2024, 1);
  assert.equal(certifier.calls.length, 1);
  assert.deepEqual(certifier.calls[0], { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: 2024, version: 1 });
  assert.equal(importer.calls.length, 0);
  assert.equal(result.outcome, 'ACTIVATED_OR_NOOP');
  if (result.outcome === 'ACTIVATED_OR_NOOP') assert.equal(result.kind, 'ACTIVATED');
});

test('CERTIFY: result kind (ACTIVATED / REPLACED / ALREADY_CERTIFIED_NOOP) is propagated honestly, never collapsed', async () => {
  const repository = new FakeRepository();
  repository.coverage = { id: 'cov-9', exchange: 'NSE', segment: 'EQUITY', calendarYear: 2024, coverageFrom: '2024-01-01', coverageTo: '2024-12-31', version: 2, status: 'DRAFT' as never, sourceAuthority: 'NSE', sourceBundleChecksum: 'd'.repeat(64) };
  const certifier = new FakeCertifier();
  certifier.result = { kind: 'REPLACED', coverageId: 'cov-9', deprecatedCoverageId: 'cov-8' };
  const { runner } = newRunner({ repository, certifier });
  const result = await runner.runCertify(2024, 2);
  assert.equal(result.outcome, 'ACTIVATED_OR_NOOP');
  if (result.outcome === 'ACTIVATED_OR_NOOP') {
    assert.equal(result.kind, 'REPLACED');
    assert.equal(result.deprecatedCoverageId, 'cov-8');
  }
});

test('CERTIFY: a missing DRAFT (no coverage row found) returns DRAFT_NOT_FOUND and never calls the certifier', async () => {
  const { runner, certifier } = newRunner({});
  const result = await runner.runCertify(2024, 1);
  assert.deepEqual(result, { outcome: 'DRAFT_NOT_FOUND', calendarYear: 2024, version: 1 });
  assert.equal(certifier.calls.length, 0);
});

test('CERTIFY: a schema-not-deployed error from the precheck read is classified, never converted into a false success', async () => {
  const repository = new FakeRepository();
  repository.throwError = SCHEMA_NOT_DEPLOYED_ERROR;
  const { runner, certifier } = newRunner({ repository });
  const result = await runner.runCertify(2024, 1);
  assert.deepEqual(result, { outcome: CALENDAR_SCHEMA_NOT_DEPLOYED, calendarYear: 2024, version: 1 });
  assert.equal(certifier.calls.length, 0);
});

// ------------------------------------------------------------------- VERIFY

test('VERIFY: only calls the resolver -- zero mutation, importer/certifier untouched', async () => {
  const responses = new Map([['2024-01-19', regular('2024-01-19')]]);
  const { runner, importer, certifier, resolver } = newRunner({ resolverResponses: responses });
  await runner.runVerify([{ tradingDate: '2024-01-19', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.REGULAR_SESSION } }]);
  assert.equal(importer.calls.length, 0);
  assert.equal(certifier.calls.length, 0);
  assert.equal(resolver.calls.length, 1);
  assert.deepEqual(resolver.calls[0], { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, tradingDate: '2024-01-19' });
});

test('VERIFY: a matching CLASSIFICATION probe (with windows) passes', async () => {
  const windows: SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }];
  const responses = new Map([['2024-01-20', special('2024-01-20', windows)]]);
  const { runner } = newRunner({ resolverResponses: responses });
  const result = await runner.runVerify([{ tradingDate: '2024-01-20', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.SPECIAL_SESSION, sessionWindows: windows } }]);
  assert.equal(result.probes[0].pass, true);
  assert.equal(result.allPassed, true);
});

test('VERIFY: a mismatched probe fails with an informative detail, and allPassed is false', async () => {
  const responses = new Map([['2024-01-21', regular('2024-01-21')]]); // resolver says REGULAR, probe expects WEEKEND
  const { runner } = newRunner({ resolverResponses: responses });
  const result = await runner.runVerify([{ tradingDate: '2024-01-21', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.WEEKEND } }]);
  assert.equal(result.probes[0].pass, false);
  assert.equal(result.allPassed, false);
  assert.ok(result.probes[0].detail.includes('WEEKEND'));
});

test('VERIFY: ANY_CERTIFIED passes for any non-UNCERTIFIED classification with non-null coverage', async () => {
  const responses = new Map([['2026-08-28', regular('2026-08-28')]]);
  const { runner } = newRunner({ resolverResponses: responses });
  const result = await runner.runVerify([{ tradingDate: '2026-08-28', expectation: { kind: 'ANY_CERTIFIED' } }]);
  assert.equal(result.probes[0].pass, true);
});

test('VERIFY: UNCERTIFIED expectation passes only when classification is UNCERTIFIED and coverage is null', async () => {
  const { runner } = newRunner({ resolverResponses: new Map() }); // FakeResolver defaults unknown dates to UNCERTIFIED
  const result = await runner.runVerify([{ tradingDate: '2026-08-29', expectation: { kind: 'UNCERTIFIED' } }]);
  assert.equal(result.probes[0].pass, true);
  assert.equal(result.probes[0].actualCoverageIsNull, true);
});

test('DEFAULT_VERIFY_PROBES encodes exactly the 17 probes from the accepted truth (2+9+2+4 across 2023/2024/2025/2026), in the documented order', () => {
  assert.equal(DEFAULT_VERIFY_PROBES.length, 17);
  assert.equal(DEFAULT_VERIFY_PROBES[0].tradingDate, '2023-06-28');
  assert.equal(DEFAULT_VERIFY_PROBES[DEFAULT_VERIFY_PROBES.length - 1].tradingDate, '2026-08-29');
  const uncertifiedProbe = DEFAULT_VERIFY_PROBES.find((probe) => probe.tradingDate === '2026-08-29')!;
  assert.equal(uncertifiedProbe.expectation.kind, 'UNCERTIFIED');
  const jan20 = DEFAULT_VERIFY_PROBES.find((probe) => probe.tradingDate === '2024-01-20')!;
  assert.equal(jan20.expectation.kind, 'CLASSIFICATION');
  if (jan20.expectation.kind === 'CLASSIFICATION') {
    assert.deepEqual(jan20.expectation.sessionWindows, [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }]);
  }
});

test('registry year list matches the five accepted calendar years, in order, independent of whether they are populated yet', () => {
  assert.deepEqual(AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURE_YEARS, [2022, 2023, 2024, 2025, 2026]);
});
