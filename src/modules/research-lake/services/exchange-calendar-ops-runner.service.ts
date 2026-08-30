import {
  CalendarClassification,
  Exchange,
  ExchangeSegment,
  SessionWindow,
} from '../domain/exchange-calendar.types';
import { computeCoverageSourceBundleChecksum } from '../domain/exchange-calendar-checksum';
import {
  ExchangeCalendarCoverageFixture,
  ExchangeCalendarFixtureValidationError,
  validateAndNormalizeCoverageFixture,
} from '../domain/exchange-calendar-fixture.types';
import { AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES } from '../domain/data/authoritative-nse-equity-calendar-fixtures';
import ExchangeCalendarCertificationService, { ActivateExchangeCalendarVersionRequest } from './exchange-calendar-certification.service';
import ExchangeCalendarImporterService from './exchange-calendar-importer.service';
import ExchangeCalendarRepository, { ExchangeCalendarActivationOutcome, ExchangeCalendarImportOutcome, PersistedCoverageIdentity } from '../repositories/exchange-calendar.repository';
import ExchangeCalendarResolverService from './exchange-calendar-resolver.service';
import { isCalendarSchemaNotDeployedError, CALENDAR_SCHEMA_NOT_DEPLOYED } from './exchange-calendar-ops-schema-error.util';

/**
 * B-F7A-FIXTURES-1: the exact scope this operator runner is locked to.
 * Intentionally declared locally (not imported from the NIFTY planner
 * module) -- this file is about the CALENDAR itself, not any one
 * consumer of it; the NIFTY planner depending on the calendar is the
 * correct dependency direction, not the reverse. The VALUE matches
 * B-F2-CAL-1's own already-locked `NIFTY_UNDERLYING_CALENDAR_EXCHANGE`/
 * `NIFTY_UNDERLYING_CALENDAR_SEGMENT` deliberately, since this task's own
 * scope is explicitly "NSE/EQUITY ONLY" (task section 2).
 */
export const EXCHANGE_CALENDAR_OPS_EXCHANGE = Exchange.NSE;
export const EXCHANGE_CALENDAR_OPS_SEGMENT = ExchangeSegment.EQUITY;

export interface ExchangeCalendarOpsFixtureSummary {
  readonly calendarYear: number;
  readonly version: number;
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly coverageFrom: string;
  readonly coverageTo: string;
  readonly explicitDayCount: number;
  readonly sourceDocumentCount: number;
  readonly specialSessionCount: number;
  readonly sourceBundleChecksum: string;
}

export interface ExchangeCalendarOpsValidateFailure {
  readonly calendarYear: number;
  readonly errorCode: string | null;
  readonly message: string;
}

export interface ExchangeCalendarOpsValidateResult {
  readonly requestedYear: number | 'ALL';
  readonly fixturesConsidered: number;
  readonly valid: readonly ExchangeCalendarOpsFixtureSummary[];
  readonly invalid: readonly ExchangeCalendarOpsValidateFailure[];
  readonly allValid: boolean;
}

export type ExchangeCalendarOpsImportDraftResult =
  | { readonly outcome: 'NO_FIXTURE_REGISTERED'; readonly calendarYear: number }
  | { readonly outcome: 'INVALID_FIXTURE'; readonly calendarYear: number; readonly errorCode: string | null; readonly message: string }
  | ({ readonly outcome: 'IMPORTED' } & ExchangeCalendarImportOutcome)
  | { readonly outcome: typeof CALENDAR_SCHEMA_NOT_DEPLOYED; readonly calendarYear: number };

export type ExchangeCalendarOpsCertifyResult =
  | { readonly outcome: 'DRAFT_NOT_FOUND'; readonly calendarYear: number; readonly version: number }
  | ({ readonly outcome: 'ACTIVATED_OR_NOOP' } & ExchangeCalendarActivationOutcome)
  | { readonly outcome: typeof CALENDAR_SCHEMA_NOT_DEPLOYED; readonly calendarYear: number; readonly version: number };

export interface ExchangeCalendarOpsVerifyProbe {
  readonly tradingDate: string;
  readonly expectation:
    | { readonly kind: 'CLASSIFICATION'; readonly classification: CalendarClassification; readonly sessionWindows?: readonly SessionWindow[] }
    | { readonly kind: 'ANY_CERTIFIED' }
    | { readonly kind: 'UNCERTIFIED' };
}

export interface ExchangeCalendarOpsVerifyProbeResult {
  readonly tradingDate: string;
  readonly pass: boolean;
  readonly actualClassification: CalendarClassification;
  readonly actualSessionWindows: readonly SessionWindow[];
  readonly actualCoverageIsNull: boolean;
  readonly detail: string;
}

export interface ExchangeCalendarOpsVerifyResult {
  readonly probes: readonly ExchangeCalendarOpsVerifyProbeResult[];
  readonly allPassed: boolean;
}

/**
 * B-F7A-FIXTURES-1 task section 31's exact literal probe set for NSE/
 * EQUITY, encoded as data so it can drive both this file's own unit tests
 * (against a fake resolver) and a later real post-deployment VERIFY run
 * (against the real resolver) without being re-transcribed.
 */
export const DEFAULT_VERIFY_PROBES: readonly ExchangeCalendarOpsVerifyProbe[] = [
  { tradingDate: '2023-06-28', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.REGULAR_SESSION } },
  { tradingDate: '2023-06-29', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.EXCHANGE_HOLIDAY } },
  { tradingDate: '2024-01-19', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.REGULAR_SESSION } },
  {
    tradingDate: '2024-01-20',
    expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.SPECIAL_SESSION, sessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }] },
  },
  { tradingDate: '2024-01-21', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.WEEKEND } },
  { tradingDate: '2024-01-22', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.EXCEPTIONAL_CLOSURE } },
  {
    tradingDate: '2024-03-02',
    expectation: {
      kind: 'CLASSIFICATION',
      classification: CalendarClassification.SPECIAL_SESSION,
      sessionWindows: [
        { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
        { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
      ],
    },
  },
  {
    tradingDate: '2024-05-18',
    expectation: {
      kind: 'CLASSIFICATION',
      classification: CalendarClassification.SPECIAL_SESSION,
      sessionWindows: [
        { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
        { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
      ],
    },
  },
  { tradingDate: '2024-05-20', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.EXCEPTIONAL_CLOSURE } },
  {
    tradingDate: '2024-11-01',
    expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.SPECIAL_SESSION, sessionWindows: [{ windowIndex: 0, openMinuteIst: 1080, closeMinuteIst: 1140 }] },
  },
  { tradingDate: '2024-11-20', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.EXCEPTIONAL_CLOSURE } },
  { tradingDate: '2025-06-06', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.REGULAR_SESSION } },
  { tradingDate: '2025-06-07', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.WEEKEND } },
  { tradingDate: '2026-01-15', expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.EXCEPTIONAL_CLOSURE } },
  {
    tradingDate: '2026-02-01',
    expectation: { kind: 'CLASSIFICATION', classification: CalendarClassification.SPECIAL_SESSION, sessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }] },
  },
  { tradingDate: '2026-08-28', expectation: { kind: 'ANY_CERTIFIED' } },
  { tradingDate: '2026-08-29', expectation: { kind: 'UNCERTIFIED' } },
];

export interface ExchangeCalendarOpsRunnerServiceDependencies {
  readonly importer?: ExchangeCalendarImporterService;
  readonly certifier?: ExchangeCalendarCertificationService;
  readonly resolver?: ExchangeCalendarResolverService;
  readonly repository?: ExchangeCalendarRepository;
  readonly fixtures?: readonly ExchangeCalendarCoverageFixture[];
}

/**
 * B-F7A-FIXTURES-1 orchestration layer. Deliberately thin: every mutating
 * or DB-reading call is delegated to the EXISTING, already-reviewed
 * `ExchangeCalendarImporterService` / `ExchangeCalendarCertificationService`
 * / `ExchangeCalendarResolverService` / `ExchangeCalendarRepository` --
 * this class adds no new import/certify/resolve logic of its own, only
 * selection (which fixture/year/version), reporting, and
 * schema-precondition classification.
 *
 * Callers (the CLI script) are responsible for running
 * `assertMutationApplyOptIn`/`assertLocalDevDatabaseTarget` BEFORE calling
 * `runImportDraft`/`runCertify` -- this class does not re-implement those
 * guards itself, so it must never be exposed to an untrusted caller
 * without them.
 */
export default class ExchangeCalendarOpsRunnerService {
  private readonly importer: ExchangeCalendarImporterService;
  private readonly certifier: ExchangeCalendarCertificationService;
  private readonly resolver: ExchangeCalendarResolverService;
  private readonly repository: ExchangeCalendarRepository;
  private readonly fixtures: readonly ExchangeCalendarCoverageFixture[];

  constructor(dependencies: ExchangeCalendarOpsRunnerServiceDependencies = {}) {
    this.importer = dependencies.importer ?? new ExchangeCalendarImporterService();
    this.certifier = dependencies.certifier ?? new ExchangeCalendarCertificationService();
    this.resolver = dependencies.resolver ?? new ExchangeCalendarResolverService();
    this.repository = dependencies.repository ?? new ExchangeCalendarRepository();
    this.fixtures = dependencies.fixtures ?? AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES;
  }

  /** Pure, synchronous, zero I/O -- safe to run before the calendar schema is even deployed (task section 24). */
  async runValidate(selection: number | 'ALL'): Promise<ExchangeCalendarOpsValidateResult> {
    const candidates = selection === 'ALL' ? this.fixtures : this.fixtures.filter((fixture) => fixture.calendarYear === selection);
    const valid: ExchangeCalendarOpsFixtureSummary[] = [];
    const invalid: ExchangeCalendarOpsValidateFailure[] = [];

    for (const fixture of candidates) {
      try {
        const normalized = validateAndNormalizeCoverageFixture(fixture);
        const checksum = computeCoverageSourceBundleChecksum(normalized);
        valid.push({
          calendarYear: normalized.calendarYear,
          version: normalized.version,
          exchange: normalized.exchange as Exchange,
          segment: normalized.segment as ExchangeSegment,
          coverageFrom: normalized.coverageFrom,
          coverageTo: normalized.coverageTo,
          explicitDayCount: normalized.days.length,
          sourceDocumentCount: normalized.sourceDocuments.length,
          specialSessionCount: normalized.days.filter((day) => day.windows.length > 0).length,
          sourceBundleChecksum: checksum,
        });
      } catch (error) {
        invalid.push({
          calendarYear: fixture.calendarYear,
          errorCode: error instanceof ExchangeCalendarFixtureValidationError ? error.code : null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { requestedYear: selection, fixturesConsidered: candidates.length, valid, invalid, allValid: invalid.length === 0 };
  }

  async runImportDraft(calendarYear: number): Promise<ExchangeCalendarOpsImportDraftResult> {
    const fixture = this.fixtures.find((candidate) => candidate.calendarYear === calendarYear);
    if (!fixture) return { outcome: 'NO_FIXTURE_REGISTERED', calendarYear };

    try {
      validateAndNormalizeCoverageFixture(fixture);
    } catch (error) {
      return {
        outcome: 'INVALID_FIXTURE',
        calendarYear,
        errorCode: error instanceof ExchangeCalendarFixtureValidationError ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const result = await this.importer.importCoverage(fixture);
      return { outcome: 'IMPORTED', ...result };
    } catch (error) {
      if (isCalendarSchemaNotDeployedError(error)) return { outcome: CALENDAR_SCHEMA_NOT_DEPLOYED, calendarYear };
      throw error;
    }
  }

  async runCertify(calendarYear: number, version: number): Promise<ExchangeCalendarOpsCertifyResult> {
    let existing: PersistedCoverageIdentity | null;
    try {
      existing = await this.repository.findCoverageByVersion(EXCHANGE_CALENDAR_OPS_EXCHANGE, EXCHANGE_CALENDAR_OPS_SEGMENT, calendarYear, version);
    } catch (error) {
      if (isCalendarSchemaNotDeployedError(error)) return { outcome: CALENDAR_SCHEMA_NOT_DEPLOYED, calendarYear, version };
      throw error;
    }
    if (!existing) return { outcome: 'DRAFT_NOT_FOUND', calendarYear, version };

    const request: ActivateExchangeCalendarVersionRequest = {
      exchange: EXCHANGE_CALENDAR_OPS_EXCHANGE,
      segment: EXCHANGE_CALENDAR_OPS_SEGMENT,
      calendarYear,
      version,
    };
    try {
      const result = await this.certifier.activateCertifiedVersion(request);
      return { outcome: 'ACTIVATED_OR_NOOP', ...result };
    } catch (error) {
      if (isCalendarSchemaNotDeployedError(error)) return { outcome: CALENDAR_SCHEMA_NOT_DEPLOYED, calendarYear, version };
      throw error;
    }
  }

  async runVerify(probes: readonly ExchangeCalendarOpsVerifyProbe[] = DEFAULT_VERIFY_PROBES): Promise<ExchangeCalendarOpsVerifyResult> {
    const results: ExchangeCalendarOpsVerifyProbeResult[] = [];
    for (const probe of probes) {
      // eslint-disable-next-line no-await-in-loop -- probes are independent reads; sequential keeps failure attribution simple and avoids unbounded concurrent DB reads
      const resolution = await this.resolver.resolveTradingDay(EXCHANGE_CALENDAR_OPS_EXCHANGE, EXCHANGE_CALENDAR_OPS_SEGMENT, probe.tradingDate);
      results.push(this.evaluateProbe(probe, resolution.classification, resolution.sessionWindows, resolution.coverage === null));
    }
    return { probes: results, allPassed: results.every((result) => result.pass) };
  }

  private evaluateProbe(
    probe: ExchangeCalendarOpsVerifyProbe,
    actualClassification: CalendarClassification,
    actualSessionWindows: readonly SessionWindow[],
    actualCoverageIsNull: boolean
  ): ExchangeCalendarOpsVerifyProbeResult {
    const base = { tradingDate: probe.tradingDate, actualClassification, actualSessionWindows, actualCoverageIsNull };
    if (probe.expectation.kind === 'UNCERTIFIED') {
      const pass = actualClassification === CalendarClassification.UNCERTIFIED && actualCoverageIsNull;
      return { ...base, pass, detail: pass ? 'matched UNCERTIFIED with null coverage' : `expected UNCERTIFIED/null coverage, got ${actualClassification}/coverageIsNull=${actualCoverageIsNull}` };
    }
    if (probe.expectation.kind === 'ANY_CERTIFIED') {
      const pass = actualClassification !== CalendarClassification.UNCERTIFIED && !actualCoverageIsNull;
      return { ...base, pass, detail: pass ? `matched a certified result (${actualClassification})` : `expected any certified (non-UNCERTIFIED) result, got ${actualClassification}/coverageIsNull=${actualCoverageIsNull}` };
    }
    const classificationMatches = actualClassification === probe.expectation.classification;
    const windowsMatch = probe.expectation.sessionWindows === undefined || this.sessionWindowsEqual(probe.expectation.sessionWindows, actualSessionWindows);
    const pass = classificationMatches && windowsMatch;
    return {
      ...base,
      pass,
      detail: pass
        ? `matched ${probe.expectation.classification}`
        : `expected ${probe.expectation.classification}${probe.expectation.sessionWindows ? ` windows=${JSON.stringify(probe.expectation.sessionWindows)}` : ''}, got ${actualClassification} windows=${JSON.stringify(actualSessionWindows)}`,
    };
  }

  private sessionWindowsEqual(expected: readonly SessionWindow[], actual: readonly SessionWindow[]): boolean {
    if (expected.length !== actual.length) return false;
    return expected.every((window, index) => window.windowIndex === actual[index]?.windowIndex && window.openMinuteIst === actual[index]?.openMinuteIst && window.closeMinuteIst === actual[index]?.closeMinuteIst);
  }
}
