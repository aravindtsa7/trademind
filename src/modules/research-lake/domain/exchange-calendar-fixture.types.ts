import {
  CalendarCoverageStatus,
  Exchange,
  ExchangeSegment,
  ExplicitCalendarClassification,
  SessionWindow,
  SourceDocumentType,
  isValidSourceDocumentChecksum,
  isValidSourceDocumentReference,
  isValidSourceDocumentType,
  isWeekend,
  validateSessionWindows,
} from './exchange-calendar.types';
import { NormalizedCalendarDayContent, NormalizedCoverageContent, NormalizedSourceDocumentContent } from './exchange-calendar-checksum';
import { ExchangeCalendarDateInvariantError, exchangeCalendarYear, parseExchangeCalendarDate } from './exchange-calendar-date';

/**
 * Typed validation failure for importer input (task section 10). Every
 * rejection the B-F7A importer can produce carries a stable `code` so tests
 * assert on WHICH rule fired, never just "it threw". Thrown BEFORE any
 * repository call (task section 9/10.Y: "reject before repository
 * mutation") -- this module has no I/O dependency at all.
 */
export type ExchangeCalendarFixtureErrorCode =
  | 'INVALID_EXCHANGE'
  | 'INVALID_SEGMENT'
  | 'INVALID_VERSION'
  | 'INVALID_CALENDAR_YEAR'
  | 'INVALID_STATUS'
  | 'UNSUPPORTED_IMPORT_STATUS'
  | 'INVALID_SOURCE_AUTHORITY'
  | 'INVALID_DATE_FORMAT'
  | 'INVALID_COVERAGE_RANGE'
  | 'DUPLICATE_SOURCE_DOCUMENT_REFERENCE'
  | 'INVALID_SOURCE_DOCUMENT_TYPE'
  | 'INVALID_SOURCE_DOCUMENT_CHECKSUM'
  | 'MISSING_SOURCE_PROVENANCE'
  | 'MISSING_EXCEPTIONAL_DAY_PROVENANCE'
  | 'DATE_OUTSIDE_COVERAGE_RANGE'
  | 'DUPLICATE_EXPLICIT_DATE'
  | 'INVALID_CLASSIFICATION'
  | 'UNKNOWN_SOURCE_DOCUMENT_REFERENCE'
  | 'SPECIAL_SESSION_WITHOUT_WINDOWS'
  | 'NON_SPECIAL_SESSION_WITH_WINDOWS'
  | 'REGULAR_SESSION_ON_WEEKEND_REJECTED'
  | 'INVALID_SESSION_WINDOW';

export class ExchangeCalendarFixtureValidationError extends Error {
  constructor(
    public readonly code: ExchangeCalendarFixtureErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExchangeCalendarFixtureValidationError';
  }
}

export interface ExchangeCalendarSourceDocumentFixture {
  readonly documentReference: string;
  readonly documentType: SourceDocumentType;
  readonly contentChecksumSha256: string;
  readonly referenceUrl?: string | null;
}

export interface ExchangeCalendarDayFixture {
  readonly tradingDate: string; // YYYY-MM-DD
  readonly classification: ExplicitCalendarClassification;
  readonly reason?: string | null;
  /** Required for every exceptional classification; optional for explicit REGULAR_SESSION. When present it must name a document in this coverage. */
  readonly sourceDocumentReference?: string | null;
  /** Required, non-empty for `SPECIAL_SESSION`; must be absent/empty for every other classification (task section 6/10.K/10.L). */
  readonly windows?: readonly SessionWindow[];
}

/**
 * Raw importer input (task section 10/13: SYNTHETIC fixtures only in this
 * pass -- no real NSE dates/circulars are ever hardcoded in production code
 * or fixtures here). One fixture describes exactly one coverage version.
 */
export interface ExchangeCalendarCoverageFixture {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly coverageFrom: string; // YYYY-MM-DD, inclusive
  readonly coverageTo: string; // YYYY-MM-DD, inclusive
  readonly calendarYear: number;
  readonly version: number;
  /**
   * Import is intentionally DRAFT-only. CERTIFIED/DEPRECATED are lifecycle
   * states owned by the repository activation transaction, never fixture
   * ingestion requests.
   */
  readonly status: CalendarCoverageStatus;
  readonly sourceAuthority: string;
  readonly sourceDocuments: readonly ExchangeCalendarSourceDocumentFixture[];
  readonly days: readonly ExchangeCalendarDayFixture[];
}

function assertValidDateString(code: ExchangeCalendarFixtureErrorCode, label: string, value: string): void {
  try {
    parseExchangeCalendarDate(value, label);
  } catch (error) {
    if (!(error instanceof ExchangeCalendarDateInvariantError)) throw error;
    throw new ExchangeCalendarFixtureValidationError(code, `${label} '${value}' is not a valid YYYY-MM-DD date string.`);
  }
}

/**
 * Validates and normalizes a raw fixture into the `NormalizedCoverageContent`
 * shape the checksum function consumes, applying every structural rule task
 * section 10 requires. Fails closed on the FIRST violation encountered
 * (never silently drops/coerces/deduplicates invalid input) and never
 * touches a repository -- pure, synchronous, unit-testable with zero I/O.
 */
export function validateAndNormalizeCoverageFixture(fixture: ExchangeCalendarCoverageFixture): NormalizedCoverageContent {
  if (!Object.values(Exchange).includes(fixture.exchange)) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_EXCHANGE', `'${fixture.exchange}' is not a recognized Exchange.`);
  }
  if (!Object.values(ExchangeSegment).includes(fixture.segment)) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_SEGMENT', `'${fixture.segment}' is not a recognized ExchangeSegment.`);
  }
  if (!Object.values(CalendarCoverageStatus).includes(fixture.status)) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_STATUS', `'${fixture.status}' is not a recognized CalendarCoverageStatus.`);
  }
  if (fixture.status !== CalendarCoverageStatus.DRAFT) {
    throw new ExchangeCalendarFixtureValidationError('UNSUPPORTED_IMPORT_STATUS', `Calendar fixture import is DRAFT-only; requested status ${fixture.status} must use the activation lifecycle instead.`);
  }
  if (!Number.isInteger(fixture.version) || fixture.version <= 0) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_VERSION', `version must be a positive integer, got ${fixture.version}.`);
  }
  if (typeof fixture.sourceAuthority !== 'string' || fixture.sourceAuthority.trim().length === 0) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_SOURCE_AUTHORITY', 'sourceAuthority must be a non-empty string.');
  }

  assertValidDateString('INVALID_DATE_FORMAT', 'coverageFrom', fixture.coverageFrom);
  assertValidDateString('INVALID_DATE_FORMAT', 'coverageTo', fixture.coverageTo);
  if (!Number.isInteger(fixture.calendarYear) || fixture.calendarYear < 1 || fixture.calendarYear > 9999) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_CALENDAR_YEAR', `calendarYear must be an integer in [1, 9999], got ${fixture.calendarYear}.`);
  }
  if (exchangeCalendarYear(fixture.coverageFrom) !== fixture.calendarYear || exchangeCalendarYear(fixture.coverageTo) !== fixture.calendarYear) {
    throw new ExchangeCalendarFixtureValidationError(
      'INVALID_CALENDAR_YEAR',
      `coverageFrom and coverageTo must both belong to calendarYear ${fixture.calendarYear}.`
    );
  }
  if (fixture.coverageFrom > fixture.coverageTo) {
    throw new ExchangeCalendarFixtureValidationError('INVALID_COVERAGE_RANGE', `coverageFrom (${fixture.coverageFrom}) must not be after coverageTo (${fixture.coverageTo}).`);
  }

  const sourceDocuments = normalizeSourceDocuments(fixture.sourceDocuments);
  const documentReferences = new Set(sourceDocuments.map((doc) => doc.documentReference));
  const days = normalizeDays(fixture, documentReferences);

  return {
    exchange: fixture.exchange,
    segment: fixture.segment,
    calendarYear: fixture.calendarYear,
    coverageFrom: fixture.coverageFrom,
    coverageTo: fixture.coverageTo,
    version: fixture.version,
    sourceAuthority: fixture.sourceAuthority,
    sourceDocuments,
    days,
  };
}

function normalizeSourceDocuments(documents: readonly ExchangeCalendarSourceDocumentFixture[]): NormalizedSourceDocumentContent[] {
  const seen = new Set<string>();
  const normalized: NormalizedSourceDocumentContent[] = [];
  for (const document of documents) {
    if (!isValidSourceDocumentReference(document.documentReference)) {
      throw new ExchangeCalendarFixtureValidationError('DUPLICATE_SOURCE_DOCUMENT_REFERENCE', 'documentReference must be a non-empty string.');
    }
    if (seen.has(document.documentReference)) {
      throw new ExchangeCalendarFixtureValidationError('DUPLICATE_SOURCE_DOCUMENT_REFERENCE', `Duplicate source document reference '${document.documentReference}' in one fixture.`);
    }
    if (!isValidSourceDocumentType(document.documentType)) {
      throw new ExchangeCalendarFixtureValidationError('INVALID_SOURCE_DOCUMENT_TYPE', `'${document.documentType}' is not a recognized SourceDocumentType.`);
    }
    if (!isValidSourceDocumentChecksum(document.contentChecksumSha256)) {
      throw new ExchangeCalendarFixtureValidationError(
        'INVALID_SOURCE_DOCUMENT_CHECKSUM',
        `Source document '${document.documentReference}' requires a lowercase 64-character SHA-256 content checksum.`
      );
    }
    seen.add(document.documentReference);
    normalized.push({
      documentReference: document.documentReference,
      documentType: document.documentType,
      contentChecksumSha256: document.contentChecksumSha256,
      referenceUrl: document.referenceUrl ?? null,
    });
  }
  return normalized;
}

function normalizeDays(fixture: ExchangeCalendarCoverageFixture, documentReferences: ReadonlySet<string>): NormalizedCalendarDayContent[] {
  const seenDates = new Set<string>();
  const normalized: NormalizedCalendarDayContent[] = [];

  for (const day of fixture.days) {
    assertValidDateString('INVALID_DATE_FORMAT', 'day.tradingDate', day.tradingDate);
    if (day.tradingDate < fixture.coverageFrom || day.tradingDate > fixture.coverageTo) {
      throw new ExchangeCalendarFixtureValidationError(
        'DATE_OUTSIDE_COVERAGE_RANGE',
        `Explicit date ${day.tradingDate} is outside the coverage range [${fixture.coverageFrom}, ${fixture.coverageTo}].`
      );
    }
    // (task section 10.I/10.J): ANY duplicate tradingDate in one fixture is
    // rejected outright -- never silently deduplicated, regardless of
    // whether the two entries agree or conflict on classification.
    if (seenDates.has(day.tradingDate)) {
      throw new ExchangeCalendarFixtureValidationError('DUPLICATE_EXPLICIT_DATE', `Duplicate explicit date definition for ${day.tradingDate}.`);
    }
    seenDates.add(day.tradingDate);

    if (!Object.values(ExplicitCalendarClassification).includes(day.classification)) {
      throw new ExchangeCalendarFixtureValidationError('INVALID_CLASSIFICATION', `'${day.classification}' is not an explicitly-declarable classification.`);
    }

    if (day.sourceDocumentReference != null && !documentReferences.has(day.sourceDocumentReference)) {
      throw new ExchangeCalendarFixtureValidationError(
        'UNKNOWN_SOURCE_DOCUMENT_REFERENCE',
        `Day ${day.tradingDate} references source document '${day.sourceDocumentReference}', which is not present in this fixture's sourceDocuments.`
      );
    }

    const requiresDirectProvenance =
      day.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY ||
      day.classification === ExplicitCalendarClassification.SPECIAL_SESSION ||
      day.classification === ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE;
    if (requiresDirectProvenance && day.sourceDocumentReference == null) {
      throw new ExchangeCalendarFixtureValidationError(
        'MISSING_EXCEPTIONAL_DAY_PROVENANCE',
        `Explicit ${day.classification} day ${day.tradingDate} requires a supporting source document from the same coverage version.`
      );
    }

    const windows = day.windows ?? [];
    if (day.classification === ExplicitCalendarClassification.SPECIAL_SESSION) {
      if (windows.length === 0) {
        throw new ExchangeCalendarFixtureValidationError('SPECIAL_SESSION_WITHOUT_WINDOWS', `SPECIAL_SESSION day ${day.tradingDate} must declare at least one session window (task section 10.K).`);
      }
    } else if (windows.length > 0) {
      throw new ExchangeCalendarFixtureValidationError(
        'NON_SPECIAL_SESSION_WITH_WINDOWS',
        `Day ${day.tradingDate} is classified ${day.classification} but carries ${windows.length} session window(s); only SPECIAL_SESSION may carry windows (task section 10.L).`
      );
    }

    let validatedWindows: readonly SessionWindow[] = [];
    if (windows.length > 0) {
      try {
        validatedWindows = validateSessionWindows(windows);
      } catch (error) {
        throw new ExchangeCalendarFixtureValidationError('INVALID_SESSION_WINDOW', `Day ${day.tradingDate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // POLICY (task section 13.O -- explicit choice, documented): an explicit
    // REGULAR_SESSION row is rejected on a calendar Saturday/Sunday. A
    // working weekend must be declared SPECIAL_SESSION, consistently, even
    // when its hours happen to match the normal session -- REGULAR_SESSION
    // always means "the ordinary weekday session contract applies", which a
    // weekend date structurally is not (task section 1: WEEKEND is the
    // generic weekend default; the only authoritative override for a weekend
    // this domain recognizes is SPECIAL_SESSION).
    if (day.classification === ExplicitCalendarClassification.REGULAR_SESSION && isWeekend(day.tradingDate)) {
      throw new ExchangeCalendarFixtureValidationError(
        'REGULAR_SESSION_ON_WEEKEND_REJECTED',
        `Day ${day.tradingDate} falls on a weekend and cannot be classified REGULAR_SESSION; declare it SPECIAL_SESSION instead (task section 13.O policy).`
      );
    }

    normalized.push({
      tradingDate: day.tradingDate,
      classification: day.classification,
      reason: day.reason ?? null,
      sourceDocumentReference: day.sourceDocumentReference ?? null,
      windows: validatedWindows,
    });
  }

  return normalized;
}

/**
 * Re-validates a normalized object at the repository boundary. This prevents
 * direct JavaScript/TypeScript callers from treating a structural type cast as
 * proof that calendar invariants were checked.
 */
export function validateNormalizedCoverageContent(content: NormalizedCoverageContent): NormalizedCoverageContent {
  return validateAndNormalizeCoverageFixture({
    exchange: content.exchange as Exchange,
    segment: content.segment as ExchangeSegment,
    calendarYear: content.calendarYear,
    coverageFrom: content.coverageFrom,
    coverageTo: content.coverageTo,
    version: content.version,
    status: CalendarCoverageStatus.DRAFT,
    sourceAuthority: content.sourceAuthority,
    sourceDocuments: content.sourceDocuments.map((document) => ({
      documentReference: document.documentReference,
      documentType: document.documentType as SourceDocumentType,
      contentChecksumSha256: document.contentChecksumSha256,
      referenceUrl: document.referenceUrl,
    })),
    days: content.days.map((day) => ({
      tradingDate: day.tradingDate,
      classification: day.classification as ExplicitCalendarClassification,
      reason: day.reason,
      sourceDocumentReference: day.sourceDocumentReference,
      windows: day.windows,
    })),
  });
}

export function validateNormalizedCoverageContentForCertification(content: NormalizedCoverageContent): NormalizedCoverageContent {
  const validated = validateNormalizedCoverageContent(content);
  if (validated.sourceDocuments.length === 0) {
    throw new ExchangeCalendarFixtureValidationError('MISSING_SOURCE_PROVENANCE', 'A CERTIFIED coverage version requires at least one immutable source document.');
  }
  return validated;
}
