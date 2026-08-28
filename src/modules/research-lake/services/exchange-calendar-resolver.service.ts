import { CalendarClassification, Exchange, ExchangeSegment, ExplicitCalendarClassification, isWeekend } from '../domain/exchange-calendar.types';
import { CertifiedCoverageIdentity, TradingDayResolution } from '../domain/exchange-calendar-resolution.types';
import ExchangeCalendarRepository, { ExchangeCalendarAmbiguousCoverageError, PersistedCalendarDay, PersistedCoverageIdentity } from '../repositories/exchange-calendar.repository';
import { addExchangeCalendarDays, ExchangeCalendarDateInvariantError, parseExchangeCalendarDate } from '../domain/exchange-calendar-date';

export class ExchangeCalendarResolutionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarResolutionInputError';
  }
}

function assertValidExchange(exchange: Exchange): void {
  if (!Object.values(Exchange).includes(exchange)) {
    throw new ExchangeCalendarResolutionInputError(`'${exchange}' is not a recognized Exchange.`);
  }
}

function assertValidSegment(segment: ExchangeSegment): void {
  if (!Object.values(ExchangeSegment).includes(segment)) {
    throw new ExchangeCalendarResolutionInputError(`'${segment}' is not a recognized ExchangeSegment.`);
  }
}

function assertValidDate(label: string, value: string): void {
  try {
    parseExchangeCalendarDate(value, label);
  } catch (error) {
    if (!(error instanceof ExchangeCalendarDateInvariantError)) throw error;
    throw new ExchangeCalendarResolutionInputError(`${label} '${value}' is not a valid YYYY-MM-DD date string.`);
  }
}

function toCoverageIdentity(exchange: Exchange, segment: ExchangeSegment, coverage: PersistedCoverageIdentity): CertifiedCoverageIdentity {
  return {
    exchange,
    segment,
    calendarYear: coverage.calendarYear,
    version: coverage.version,
    coverageFrom: coverage.coverageFrom,
    coverageTo: coverage.coverageTo,
    sourceAuthority: coverage.sourceAuthority,
    sourceBundleChecksum: coverage.sourceBundleChecksum,
  };
}

/**
 * Applies the LOCKED resolution precedence (task section 2): explicit
 * authoritative date definition > certified coverage's generic
 * weekday/weekend inference. Assumes certified coverage has already been
 * established to cover `tradingDate` by the caller.
 */
function resolveWithinCertifiedCoverage(
  exchange: Exchange,
  segment: ExchangeSegment,
  tradingDate: string,
  coverage: PersistedCoverageIdentity,
  explicitDay: PersistedCalendarDay | null
): TradingDayResolution {
  const coverageIdentity = toCoverageIdentity(exchange, segment, coverage);

  if (explicitDay) {
    const classification = explicitDay.classification as unknown as CalendarClassification;
    const isSpecialSession = explicitDay.classification === ExplicitCalendarClassification.SPECIAL_SESSION;
    const isTradingDay = explicitDay.classification === ExplicitCalendarClassification.REGULAR_SESSION || isSpecialSession;
    return {
      exchange,
      segment,
      tradingDate,
      classification,
      isTradingDay,
      isSpecialSession,
      sessionWindows: isSpecialSession ? explicitDay.windows : [],
      explicitReason: explicitDay.reason,
      sourceDocument: explicitDay.sourceDocument,
      coverage: coverageIdentity,
    };
  }

  const weekend = isWeekend(tradingDate);
  return {
    exchange,
    segment,
    tradingDate,
    classification: weekend ? CalendarClassification.WEEKEND : CalendarClassification.REGULAR_SESSION,
    isTradingDay: !weekend,
    isSpecialSession: false,
    sessionWindows: [],
    explicitReason: null,
    sourceDocument: null,
    coverage: coverageIdentity,
  };
}

function uncertifiedResolution(exchange: Exchange, segment: ExchangeSegment, tradingDate: string): TradingDayResolution {
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

function enumerateDates(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    dates.push(cursor);
    cursor = addExchangeCalendarDays(cursor, 1);
  }
  return dates;
}

/**
 * B-F7A CORE deterministic, DB-backed resolver (task section 9). No
 * provider/network dependency of any kind (task section 9/13.Z) -- every
 * fact this service returns comes from `ExchangeCalendarRepository` alone.
 */
export default class ExchangeCalendarResolverService {
  private readonly repository: ExchangeCalendarRepository;

  constructor(repository: ExchangeCalendarRepository = new ExchangeCalendarRepository()) {
    this.repository = repository;
  }

  async resolveTradingDay(exchange: Exchange, segment: ExchangeSegment, tradingDate: string): Promise<TradingDayResolution> {
    assertValidExchange(exchange);
    assertValidSegment(segment);
    assertValidDate('tradingDate', tradingDate);

    const coverage = await this.repository.findCertifiedCoverageForDate(exchange, segment, tradingDate);
    if (!coverage) return uncertifiedResolution(exchange, segment, tradingDate);

    const explicitDay = await this.repository.findExplicitDay(coverage.id, tradingDate);
    return resolveWithinCertifiedCoverage(exchange, segment, tradingDate, coverage, explicitDay);
  }

  /**
   * Iterates EVERY calendar date in `[fromDate, toDate]` inclusive --
   * Saturdays and Sundays included, never skipped (task section 9: required
   * so an explicit special Saturday/Sunday session is discoverable; proven
   * by test 13.X). Returns results in deterministic ascending `tradingDate`
   * order (a direct consequence of enumerating dates ascending).
   */
  async resolveRange(exchange: Exchange, segment: ExchangeSegment, fromDate: string, toDate: string): Promise<TradingDayResolution[]> {
    assertValidExchange(exchange);
    assertValidSegment(segment);
    assertValidDate('fromDate', fromDate);
    assertValidDate('toDate', toDate);
    if (fromDate > toDate) {
      throw new ExchangeCalendarResolutionInputError(`fromDate (${fromDate}) must not be after toDate (${toDate}).`);
    }

    const dates = enumerateDates(fromDate, toDate);
    const coverages = await this.repository.findCertifiedCoverageOverlappingRange(exchange, segment, fromDate, toDate);
    const daysByCoverageId = new Map<string, Map<string, PersistedCalendarDay>>();
    for (const coverage of coverages) {
      daysByCoverageId.set(coverage.id, await this.repository.findExplicitDaysByCoverageId(coverage.id));
    }

    const results: TradingDayResolution[] = [];
    for (const date of dates) {
      const matches = coverages.filter((candidate) => candidate.coverageFrom <= date && candidate.coverageTo >= date);
      if (matches.length > 1) {
        throw new ExchangeCalendarAmbiguousCoverageError(
          exchange,
          segment,
          Number(date.slice(0, 4)),
          matches.map((m) => m.version)
        );
      }
      if (matches.length === 0) {
        results.push(uncertifiedResolution(exchange, segment, date));
        continue;
      }
      const coverage = matches[0];
      const explicitDay = daysByCoverageId.get(coverage.id)?.get(date) ?? null;
      results.push(resolveWithinCertifiedCoverage(exchange, segment, date, coverage, explicitDay));
    }
    return results;
  }
}
