import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import logger from '../../../core/logger/logger';
import {
  CalendarCoverageStatus,
  Exchange,
  ExchangeSegment,
  ExplicitCalendarClassification,
  SessionWindow,
  SourceDocumentIdentity,
  isValidSourceDocumentIdentityShape,
  isWeekend,
  validateSessionWindows,
} from '../domain/exchange-calendar.types';
import { NormalizedCoverageContent, computeCoverageSourceBundleChecksum } from '../domain/exchange-calendar-checksum';
import { exchangeCalendarDateToUtc, exchangeCalendarYear, parseExchangeCalendarDate } from '../domain/exchange-calendar-date';
import {
  validateNormalizedCoverageContent,
  validateNormalizedCoverageContentForCertification,
} from '../domain/exchange-calendar-fixture.types';

const defaultPrismaClient = new PrismaClient();

function toDateOnlyUtc(dateString: string): Date {
  return exchangeCalendarDateToUtc(dateString);
}

function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export interface PersistedCoverageIdentity {
  readonly id: string;
  readonly exchange: string;
  readonly segment: string;
  readonly calendarYear: number;
  readonly coverageFrom: string;
  readonly coverageTo: string;
  readonly version: number;
  readonly status: CalendarCoverageStatus;
  readonly sourceAuthority: string;
  readonly sourceBundleChecksum: string;
}

export interface PersistedCalendarDay {
  readonly tradingDate: string;
  readonly classification: ExplicitCalendarClassification;
  readonly reason: string | null;
  readonly sourceDocument: SourceDocumentIdentity | null;
  readonly windows: readonly SessionWindow[];
}

export type ExchangeCalendarImportOutcomeKind = 'CREATED' | 'IDENTICAL_NOOP';

export interface ExchangeCalendarImportOutcome {
  readonly kind: ExchangeCalendarImportOutcomeKind;
  readonly coverageId: string;
  readonly sourceBundleChecksum: string;
}

export type ExchangeCalendarActivationOutcomeKind = 'ACTIVATED' | 'REPLACED' | 'ALREADY_CERTIFIED_NOOP';

export interface ExchangeCalendarActivationOutcome {
  readonly kind: ExchangeCalendarActivationOutcomeKind;
  readonly coverageId: string;
  readonly deprecatedCoverageId: string | null;
}

export interface ExchangeCalendarActivationRequest {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly calendarYear: number;
  readonly version: number;
}

export class ExchangeCalendarVersionConflictError extends Error {
  constructor(exchange: string, segment: string, calendarYear: number, version: number) {
    super(`Coverage version ${exchange}/${segment}/${calendarYear}/v${version} already exists with different semantic content. Import a new year-scoped version to correct content.`);
    this.name = 'ExchangeCalendarVersionConflictError';
  }
}

export class ExchangeCalendarImportStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarImportStatusError';
  }
}

export class ExchangeCalendarLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarLifecycleError';
  }
}

export class ExchangeCalendarIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarIntegrityError';
  }
}

export class ExchangeCalendarAmbiguousCoverageError extends Error {
  constructor(exchange: string, segment: string, calendarYear: number, versions: readonly number[]) {
    super(`More than one CERTIFIED coverage version [${versions.join(', ')}] exists for ${exchange}/${segment}/${calendarYear}. Refusing to select one.`);
    this.name = 'ExchangeCalendarAmbiguousCoverageError';
  }
}

/**
 * Persistence boundary for year-scoped authoritative calendars. Imports are
 * DRAFT-only. Activation serializes on an exact stable scope-lock row and
 * atomically replaces the one active CERTIFIED version for that scope/year.
 */
export default class ExchangeCalendarRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  async findCertifiedCoverageForDate(exchange: string, segment: string, tradingDate: string): Promise<PersistedCoverageIdentity | null> {
    parseExchangeCalendarDate(tradingDate, 'tradingDate');
    const calendarYear = exchangeCalendarYear(tradingDate);
    return this.execute('find certified coverage for date', async () => {
      const rows = await this.prisma.exchangeCalendarCoverage.findMany({
        where: { exchange, segment, calendarYear, status: CalendarCoverageStatus.CERTIFIED },
      });
      this.assertUnambiguous(exchange, segment, calendarYear, rows);
      if (rows.length === 0) return null;
      const coverage = toCoverageIdentity(rows[0]);
      return coverage.coverageFrom <= tradingDate && coverage.coverageTo >= tradingDate ? coverage : null;
    });
  }

  async findCertifiedCoverageOverlappingRange(exchange: string, segment: string, fromDate: string, toDate: string): Promise<PersistedCoverageIdentity[]> {
    parseExchangeCalendarDate(fromDate, 'fromDate');
    parseExchangeCalendarDate(toDate, 'toDate');
    const fromYear = exchangeCalendarYear(fromDate);
    const toYear = exchangeCalendarYear(toDate);
    return this.execute('find certified coverage overlapping range', async () => {
      const rows = await this.prisma.exchangeCalendarCoverage.findMany({
        where: { exchange, segment, calendarYear: { gte: fromYear, lte: toYear }, status: CalendarCoverageStatus.CERTIFIED },
      });
      for (let year = fromYear; year <= toYear; year += 1) {
        this.assertUnambiguous(
          exchange,
          segment,
          year,
          rows.filter((row) => row.calendarYear === year)
        );
      }
      return rows.map(toCoverageIdentity).filter((coverage) => coverage.coverageFrom <= toDate && coverage.coverageTo >= fromDate);
    });
  }

  async findExplicitDaysByCoverageId(coverageId: string): Promise<Map<string, PersistedCalendarDay>> {
    return this.execute('find explicit days by coverage id', async () => {
      const rows = await this.prisma.exchangeCalendarDay.findMany({
        where: { coverageId },
        include: { sourceDocument: true, windows: { orderBy: { windowIndex: 'asc' } } },
      });
      return new Map(rows.map((row) => [toDateOnlyString(row.tradingDate), toPersistedDay(row, coverageId)]));
    });
  }

  async findExplicitDay(coverageId: string, tradingDate: string): Promise<PersistedCalendarDay | null> {
    parseExchangeCalendarDate(tradingDate, 'tradingDate');
    return this.execute('find explicit day', async () => {
      const row = await this.prisma.exchangeCalendarDay.findUnique({
        where: { coverageId_tradingDate: { coverageId, tradingDate: toDateOnlyUtc(tradingDate) } },
        include: { sourceDocument: true, windows: { orderBy: { windowIndex: 'asc' } } },
      });
      return row ? toPersistedDay(row, coverageId) : null;
    });
  }

  async findCoverageByVersion(exchange: string, segment: string, calendarYear: number, version: number): Promise<PersistedCoverageIdentity | null> {
    return this.execute('find coverage by version', async () => {
      const row = await this.prisma.exchangeCalendarCoverage.findUnique({
        where: { exchange_segment_calendarYear_version: { exchange, segment, calendarYear, version } },
      });
      return row ? toCoverageIdentity(row) : null;
    });
  }

  async importCoverage(content: NormalizedCoverageContent, status: CalendarCoverageStatus, sourceBundleChecksum: string): Promise<ExchangeCalendarImportOutcome> {
    if (status !== CalendarCoverageStatus.DRAFT) {
      throw new ExchangeCalendarImportStatusError(`Calendar import is DRAFT-only; requested ${status} must use activateCertifiedVersion where applicable.`);
    }
    const validated = validateNormalizedCoverageContent(content);
    const recomputedChecksum = computeCoverageSourceBundleChecksum(validated);
    if (sourceBundleChecksum !== recomputedChecksum) {
      throw new ExchangeCalendarIntegrityError('Caller-supplied sourceBundleChecksum does not match the repository-validated calendar content.');
    }

    return this.execute('import coverage', () =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.exchangeCalendarCoverage.findUnique({
            where: {
              exchange_segment_calendarYear_version: {
                exchange: validated.exchange,
                segment: validated.segment,
                calendarYear: validated.calendarYear,
                version: validated.version,
              },
            },
          });

          if (existing) {
            if (existing.sourceBundleChecksum !== recomputedChecksum) {
              throw new ExchangeCalendarVersionConflictError(validated.exchange, validated.segment, validated.calendarYear, validated.version);
            }
            if (existing.status !== CalendarCoverageStatus.DRAFT) {
              throw new ExchangeCalendarImportStatusError(
                `Identical ${validated.exchange}/${validated.segment}/${validated.calendarYear}/v${validated.version} exists as ${existing.status}; DRAFT import cannot masquerade as that lifecycle state.`
              );
            }
            return { kind: 'IDENTICAL_NOOP' as const, coverageId: existing.id, sourceBundleChecksum: recomputedChecksum };
          }

          const coverage = await tx.exchangeCalendarCoverage.create({
            data: {
              exchange: validated.exchange,
              segment: validated.segment,
              calendarYear: validated.calendarYear,
              coverageFrom: toDateOnlyUtc(validated.coverageFrom),
              coverageTo: toDateOnlyUtc(validated.coverageTo),
              version: validated.version,
              status: CalendarCoverageStatus.DRAFT,
              sourceAuthority: validated.sourceAuthority,
              sourceBundleChecksum: recomputedChecksum,
            },
          });

          const documentIdByReference = new Map<string, string>();
          for (const document of validated.sourceDocuments) {
            const created = await tx.exchangeCalendarSourceDocument.create({
              data: {
                coverageId: coverage.id,
                documentReference: document.documentReference,
                documentType: document.documentType,
                contentChecksumSha256: document.contentChecksumSha256,
                referenceUrl: document.referenceUrl,
              },
            });
            documentIdByReference.set(document.documentReference, created.id);
          }

          for (const day of validated.days) {
            const createdDay = await tx.exchangeCalendarDay.create({
              data: {
                coverageId: coverage.id,
                tradingDate: toDateOnlyUtc(day.tradingDate),
                classification: day.classification,
                reason: day.reason,
                sourceDocumentId: day.sourceDocumentReference ? documentIdByReference.get(day.sourceDocumentReference)! : null,
              },
            });
            for (const window of day.windows) {
              await tx.exchangeCalendarSessionWindow.create({
                data: {
                  calendarDayId: createdDay.id,
                  windowIndex: window.windowIndex,
                  openMinuteIst: window.openMinuteIst,
                  closeMinuteIst: window.closeMinuteIst,
                },
              });
            }
          }

          return { kind: 'CREATED' as const, coverageId: coverage.id, sourceBundleChecksum: recomputedChecksum };
        },
        { timeout: 30_000 }
      )
    );
  }

  async activateCertifiedVersion(request: ExchangeCalendarActivationRequest): Promise<ExchangeCalendarActivationOutcome> {
    assertActivationRequest(request);
    return this.execute('activate certified coverage version', () =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`INSERT INTO ExchangeCalendarScopeLock (id, exchange, segment, calendarYear, createdAt, updatedAt)
              VALUES (${randomUUID()}, ${request.exchange}, ${request.segment}, ${request.calendarYear}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
              ON DUPLICATE KEY UPDATE id = id`
          );
          const lockRows = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT id FROM ExchangeCalendarScopeLock
              WHERE exchange = ${request.exchange} AND segment = ${request.segment} AND calendarYear = ${request.calendarYear}
              FOR UPDATE`
          );
          if (lockRows.length !== 1) throw new ExchangeCalendarIntegrityError('Expected exactly one stable exchange-calendar scope lock row.');

          const target = await tx.exchangeCalendarCoverage.findUnique({
            where: {
              exchange_segment_calendarYear_version: {
                exchange: request.exchange,
                segment: request.segment,
                calendarYear: request.calendarYear,
                version: request.version,
              },
            },
          });
          if (!target) {
            throw new ExchangeCalendarLifecycleError(`Cannot activate missing DRAFT ${request.exchange}/${request.segment}/${request.calendarYear}/v${request.version}.`);
          }

          const certified = await tx.exchangeCalendarCoverage.findMany({
            where: {
              exchange: request.exchange,
              segment: request.segment,
              calendarYear: request.calendarYear,
              status: CalendarCoverageStatus.CERTIFIED,
            },
          });
          this.assertUnambiguous(request.exchange, request.segment, request.calendarYear, certified);

          if (target.status === CalendarCoverageStatus.CERTIFIED) {
            if (certified.length !== 1 || certified[0].id !== target.id) {
              throw new ExchangeCalendarIntegrityError('Target claims CERTIFIED status but is not the unique certified row for its scope.');
            }
            return { kind: 'ALREADY_CERTIFIED_NOOP' as const, coverageId: target.id, deprecatedCoverageId: null };
          }
          if (target.status !== CalendarCoverageStatus.DRAFT) {
            throw new ExchangeCalendarLifecycleError(`Cannot activate immutable ${target.status} version ${request.exchange}/${request.segment}/${request.calendarYear}/v${request.version}.`);
          }

          const persistedContent = await loadPersistedCoverageContent(tx, target);
          const validated = validateNormalizedCoverageContentForCertification(persistedContent);
          if (computeCoverageSourceBundleChecksum(validated) !== target.sourceBundleChecksum) {
            throw new ExchangeCalendarIntegrityError('Persisted DRAFT content no longer matches its immutable source-bundle checksum.');
          }

          const previous = certified[0] ?? null;
          if (previous) {
            const deprecated = await tx.exchangeCalendarCoverage.updateMany({
              where: { id: previous.id, status: CalendarCoverageStatus.CERTIFIED },
              data: { status: CalendarCoverageStatus.DEPRECATED },
            });
            if (deprecated.count !== 1) throw new ExchangeCalendarLifecycleError('Concurrent lifecycle change prevented deterministic deprecation.');
          }

          const activated = await tx.exchangeCalendarCoverage.updateMany({
            where: { id: target.id, status: CalendarCoverageStatus.DRAFT },
            data: { status: CalendarCoverageStatus.CERTIFIED },
          });
          if (activated.count !== 1) throw new ExchangeCalendarLifecycleError('Concurrent lifecycle change prevented deterministic activation.');

          return {
            kind: previous ? ('REPLACED' as const) : ('ACTIVATED' as const),
            coverageId: target.id,
            deprecatedCoverageId: previous?.id ?? null,
          };
        },
        { timeout: 30_000 }
      )
    );
  }

  private assertUnambiguous(
    exchange: string,
    segment: string,
    calendarYear: number,
    rows: ReadonlyArray<{ version: number }>
  ): void {
    if (rows.length > 1) {
      throw new ExchangeCalendarAmbiguousCoverageError(
        exchange,
        segment,
        calendarYear,
        rows.map((row) => row.version)
      );
    }
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof ExchangeCalendarVersionConflictError ||
        error instanceof ExchangeCalendarImportStatusError ||
        error instanceof ExchangeCalendarLifecycleError ||
        error instanceof ExchangeCalendarIntegrityError ||
        error instanceof ExchangeCalendarAmbiguousCoverageError
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Exchange calendar repository Prisma request failed', { operation, code: error.code, meta: error.meta, message: error.message });
      } else {
        logger.error('Exchange calendar repository operation failed', { operation, error });
      }
      throw error;
    }
  }
}

function assertActivationRequest(request: ExchangeCalendarActivationRequest): void {
  if (!Object.values(Exchange).includes(request.exchange)) throw new ExchangeCalendarLifecycleError(`Invalid exchange '${request.exchange}'.`);
  if (!Object.values(ExchangeSegment).includes(request.segment)) throw new ExchangeCalendarLifecycleError(`Invalid segment '${request.segment}'.`);
  if (!Number.isInteger(request.calendarYear) || request.calendarYear < 1 || request.calendarYear > 9999) {
    throw new ExchangeCalendarLifecycleError(`Invalid calendarYear ${request.calendarYear}.`);
  }
  if (!Number.isInteger(request.version) || request.version <= 0) throw new ExchangeCalendarLifecycleError(`Invalid version ${request.version}.`);
}

async function loadPersistedCoverageContent(
  tx: Prisma.TransactionClient,
  coverage: {
    id: string;
    exchange: string;
    segment: string;
    calendarYear: number;
    coverageFrom: Date;
    coverageTo: Date;
    version: number;
    sourceAuthority: string;
  }
): Promise<NormalizedCoverageContent> {
  const documents = await tx.exchangeCalendarSourceDocument.findMany({ where: { coverageId: coverage.id } });
  const referenceById = new Map(documents.map((document) => [document.id, document.documentReference]));
  const days = await tx.exchangeCalendarDay.findMany({
    where: { coverageId: coverage.id },
    include: { windows: true },
  });
  return {
    exchange: coverage.exchange,
    segment: coverage.segment,
    calendarYear: coverage.calendarYear,
    coverageFrom: toDateOnlyString(coverage.coverageFrom),
    coverageTo: toDateOnlyString(coverage.coverageTo),
    version: coverage.version,
    sourceAuthority: coverage.sourceAuthority,
    sourceDocuments: documents.map((document) => ({
      documentReference: document.documentReference,
      documentType: document.documentType,
      contentChecksumSha256: document.contentChecksumSha256,
      referenceUrl: document.referenceUrl,
    })),
    days: days.map((day) => {
      const sourceDocumentReference = day.sourceDocumentId ? referenceById.get(day.sourceDocumentId) : undefined;
      if (day.sourceDocumentId && !sourceDocumentReference) {
        throw new ExchangeCalendarIntegrityError(`Day ${day.id} references a source document outside coverage ${coverage.id}.`);
      }
      return {
        tradingDate: toDateOnlyString(day.tradingDate),
        classification: day.classification,
        reason: day.reason,
        sourceDocumentReference: sourceDocumentReference ?? null,
        windows: day.windows.map((window) => ({
          windowIndex: window.windowIndex,
          openMinuteIst: window.openMinuteIst,
          closeMinuteIst: window.closeMinuteIst,
        })),
      };
    }),
  };
}

function toCoverageIdentity(row: {
  id: string;
  exchange: string;
  segment: string;
  calendarYear: number;
  coverageFrom: Date;
  coverageTo: Date;
  version: number;
  status: string;
  sourceAuthority: string;
  sourceBundleChecksum: string;
}): PersistedCoverageIdentity {
  const coverageFrom = toDateOnlyString(row.coverageFrom);
  const coverageTo = toDateOnlyString(row.coverageTo);
  if (
    exchangeCalendarYear(coverageFrom) !== row.calendarYear ||
    exchangeCalendarYear(coverageTo) !== row.calendarYear ||
    coverageFrom > coverageTo
  ) {
    throw new ExchangeCalendarIntegrityError(`Persisted coverage ${row.id} has invalid calendarYear/range invariants.`);
  }
  return {
    id: row.id,
    exchange: row.exchange,
    segment: row.segment,
    calendarYear: row.calendarYear,
    coverageFrom,
    coverageTo,
    version: row.version,
    status: row.status as CalendarCoverageStatus,
    sourceAuthority: row.sourceAuthority,
    sourceBundleChecksum: row.sourceBundleChecksum,
  };
}

function toPersistedDay(row: {
  tradingDate: Date;
  classification: string;
  reason: string | null;
  sourceDocument: {
    coverageId: string;
    documentReference: string;
    documentType: string;
    contentChecksumSha256: string;
    referenceUrl: string | null;
  } | null;
  windows: Array<{ windowIndex: number; openMinuteIst: number; closeMinuteIst: number }>;
}, expectedCoverageId: string): PersistedCalendarDay {
  const tradingDate = toDateOnlyString(row.tradingDate);
  if (!Object.values(ExplicitCalendarClassification).includes(row.classification as ExplicitCalendarClassification)) {
    throw new ExchangeCalendarIntegrityError(`Persisted day ${tradingDate} has invalid classification '${row.classification}'.`);
  }
  const classification = row.classification as ExplicitCalendarClassification;
  const windows = validateSessionWindows(
    row.windows.map((window) => ({
      windowIndex: window.windowIndex,
      openMinuteIst: window.openMinuteIst,
      closeMinuteIst: window.closeMinuteIst,
    }))
  );
  if ((classification === ExplicitCalendarClassification.SPECIAL_SESSION) !== (windows.length > 0)) {
    throw new ExchangeCalendarIntegrityError(`Persisted day ${tradingDate} violates classification/window compatibility.`);
  }
  if (classification === ExplicitCalendarClassification.REGULAR_SESSION && isWeekend(tradingDate)) {
    throw new ExchangeCalendarIntegrityError(`Persisted day ${tradingDate} declares REGULAR_SESSION on a weekend.`);
  }
  const exceptional =
    classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY ||
    classification === ExplicitCalendarClassification.SPECIAL_SESSION ||
    classification === ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE;
  if (exceptional && !row.sourceDocument) {
    throw new ExchangeCalendarIntegrityError(`Persisted exceptional day ${tradingDate} has no source document.`);
  }
  return {
    tradingDate,
    classification,
    reason: row.reason,
    sourceDocument: toValidatedSourceDocument(row.sourceDocument, tradingDate, expectedCoverageId),
    windows,
  };
}

/**
 * One consistent persisted-source mapper for every classification (task:
 * fail-closed provenance correction) -- no classification-specific unchecked
 * cast. Validates coverage association and structural identity shape
 * (`isValidSourceDocumentIdentityShape`: non-blank `documentReference`, a
 * real `SourceDocumentType` member, a well-formed 64-hex-char checksum)
 * before a persisted source document is ever exposed as authoritative
 * provenance. Never sanitizes/repairs a corrupted value -- rejects outright.
 */
function toValidatedSourceDocument(
  sourceDocument: {
    coverageId: string;
    documentReference: string;
    documentType: string;
    contentChecksumSha256: string;
    referenceUrl: string | null;
  } | null,
  tradingDate: string,
  expectedCoverageId: string
): SourceDocumentIdentity | null {
  if (!sourceDocument) return null;
  if (sourceDocument.coverageId !== expectedCoverageId) {
    throw new ExchangeCalendarIntegrityError(`Persisted day ${tradingDate} references a source document from another coverage.`);
  }
  if (!isValidSourceDocumentIdentityShape(sourceDocument)) {
    throw new ExchangeCalendarIntegrityError(`Persisted day ${tradingDate} references a source document with invalid content identity.`);
  }
  return {
    documentReference: sourceDocument.documentReference,
    documentType: sourceDocument.documentType,
    contentChecksumSha256: sourceDocument.contentChecksumSha256,
    referenceUrl: sourceDocument.referenceUrl,
  };
}
