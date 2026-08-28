import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification, SourceDocumentType } from '../domain/exchange-calendar.types';
import { ExchangeCalendarCoverageFixture } from '../domain/exchange-calendar-fixture.types';
import ExchangeCalendarRepository, {
  ExchangeCalendarImportOutcome,
  ExchangeCalendarVersionConflictError,
} from '../repositories/exchange-calendar.repository';
import ExchangeCalendarImporterService from './exchange-calendar-importer.service';

const SOURCE_CHECKSUM = 'a'.repeat(64);

class FakeExchangeCalendarImportRepository {
  private readonly byVersionKey = new Map<string, { checksum: string; coverageId: string }>();
  private nextId = 1;

  async importCoverage(
    content: Parameters<ExchangeCalendarRepository['importCoverage']>[0],
    status: CalendarCoverageStatus,
    sourceBundleChecksum: string
  ): Promise<ExchangeCalendarImportOutcome> {
    assert.equal(status, CalendarCoverageStatus.DRAFT);
    const versionKey = `${content.exchange}/${content.segment}/${content.calendarYear}/${content.version}`;
    const existing = this.byVersionKey.get(versionKey);
    if (existing) {
      if (existing.checksum === sourceBundleChecksum) return { kind: 'IDENTICAL_NOOP', coverageId: existing.coverageId, sourceBundleChecksum };
      throw new ExchangeCalendarVersionConflictError(content.exchange, content.segment, content.calendarYear, content.version);
    }
    const coverageId = `cov-${this.nextId++}`;
    this.byVersionKey.set(versionKey, { checksum: sourceBundleChecksum, coverageId });
    return { kind: 'CREATED', coverageId, sourceBundleChecksum };
  }
}

function fixture(overrides: Partial<ExchangeCalendarCoverageFixture> = {}): ExchangeCalendarCoverageFixture {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: 2031,
    coverageFrom: '2031-01-01',
    coverageTo: '2031-12-31',
    version: 1,
    status: CalendarCoverageStatus.DRAFT,
    sourceAuthority: 'NSE',
    sourceDocuments: [
      {
        documentReference: 'SYN-DOC-A',
        documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
        contentChecksumSha256: SOURCE_CHECKSUM,
      },
    ],
    days: [
      {
        tradingDate: '2031-01-01',
        classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY,
        sourceDocumentReference: 'SYN-DOC-A',
      },
    ],
    ...overrides,
  };
}

function newImporter(): ExchangeCalendarImporterService {
  return new ExchangeCalendarImporterService(new FakeExchangeCalendarImportRepository() as unknown as ExchangeCalendarRepository);
}

test('identical DRAFT fixture import is a true idempotent no-op', async () => {
  const importer = newImporter();
  const first = await importer.importCoverage(fixture());
  const second = await importer.importCoverage(fixture());
  assert.equal(first.kind, 'CREATED');
  assert.equal(second.kind, 'IDENTICAL_NOOP');
  assert.equal(first.coverageId, second.coverageId);
});

test('same year-scoped version with different semantic content rejects', async () => {
  const importer = newImporter();
  await importer.importCoverage(fixture());
  await assert.rejects(
    () =>
      importer.importCoverage(
        fixture({
          days: [
            {
              tradingDate: '2031-01-02',
              classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY,
              sourceDocumentReference: 'SYN-DOC-A',
            },
          ],
        })
      ),
    ExchangeCalendarVersionConflictError
  );
});

test('version namespace is local to calendarYear, so synthetic 2022/v1 and 2023/v1 coexist', async () => {
  const importer = newImporter();
  const y2022 = await importer.importCoverage(
    fixture({ calendarYear: 2022, coverageFrom: '2022-01-01', coverageTo: '2022-12-31', days: [] })
  );
  const y2023 = await importer.importCoverage(
    fixture({ calendarYear: 2023, coverageFrom: '2023-01-01', coverageTo: '2023-12-31', days: [] })
  );
  assert.equal(y2022.kind, 'CREATED');
  assert.equal(y2023.kind, 'CREATED');
  assert.notEqual(y2022.coverageId, y2023.coverageId);
});

test('DRAFT importer rejects a fixture that requests CERTIFIED before repository mutation', async () => {
  let called = false;
  const repository = {
    importCoverage: async () => {
      called = true;
      throw new Error('must not be called');
    },
  };
  const importer = new ExchangeCalendarImporterService(repository as unknown as ExchangeCalendarRepository);
  await assert.rejects(() => importer.importCoverage(fixture({ status: CalendarCoverageStatus.CERTIFIED })), /DRAFT-only/);
  assert.equal(called, false);
});

test('multiple immutable source documents remain supported', async () => {
  const importer = newImporter();
  const result = await importer.importCoverage(
    fixture({
      sourceDocuments: [
        {
          documentReference: 'SYN-DOC-A',
          documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
          contentChecksumSha256: SOURCE_CHECKSUM,
        },
        { documentReference: 'SYN-DOC-B', documentType: SourceDocumentType.AMENDMENT, contentChecksumSha256: 'b'.repeat(64) },
      ],
      days: [
        {
          tradingDate: '2031-01-01',
          classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY,
          sourceDocumentReference: 'SYN-DOC-B',
        },
      ],
    })
  );
  assert.equal(result.kind, 'CREATED');
});

test('importer/resolver/calendar core production modules do not reference network clients', async () => {
  const fs = await import('node:fs/promises');
  const files = [
    'src/modules/research-lake/services/exchange-calendar-importer.service.ts',
    'src/modules/research-lake/services/exchange-calendar-certification.service.ts',
    'src/modules/research-lake/services/exchange-calendar-resolver.service.ts',
    'src/modules/research-lake/repositories/exchange-calendar.repository.ts',
    'src/modules/research-lake/domain/exchange-calendar.types.ts',
    'src/modules/research-lake/domain/exchange-calendar-fixture.types.ts',
    'src/modules/research-lake/domain/exchange-calendar-checksum.ts',
  ];
  const forbidden = /\baxios\b|\bhttps?:\/\/|\bfetch\(|node:http|require\(['"]http/;
  for (const file of files) {
    assert.equal(forbidden.test(await fs.readFile(file, 'utf8')), false, `${file} references a network dependency.`);
  }
});
