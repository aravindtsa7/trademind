import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification, SourceDocumentType } from './exchange-calendar.types';
import { ExchangeCalendarCoverageFixture, ExchangeCalendarFixtureValidationError, validateAndNormalizeCoverageFixture } from './exchange-calendar-fixture.types';

const SOURCE_CHECKSUM = 'a'.repeat(64);

function baseFixture(overrides: Partial<ExchangeCalendarCoverageFixture> = {}): ExchangeCalendarCoverageFixture {
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: 2031,
    coverageFrom: '2031-01-01',
    coverageTo: '2031-12-31',
    version: 1,
    status: CalendarCoverageStatus.DRAFT,
    sourceAuthority: 'NSE',
    sourceDocuments: [{ documentReference: 'SYN-DOC-A', documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR, contentChecksumSha256: SOURCE_CHECKSUM }],
    days: [{ tradingDate: '2031-01-01', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'SYN-DOC-A' }],
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected ExchangeCalendarFixtureValidationError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof ExchangeCalendarFixtureValidationError, `Expected ExchangeCalendarFixtureValidationError, got ${error}`);
    assert.equal((error as ExchangeCalendarFixtureValidationError).code, code);
  }
}

test('a valid fixture normalizes without throwing', () => {
  const normalized = validateAndNormalizeCoverageFixture(baseFixture());
  assert.equal(normalized.version, 1);
  assert.equal(normalized.days.length, 1);
});

test('rejects unknown exchange/segment/status/version', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ exchange: 'BSE' as Exchange })), 'INVALID_EXCHANGE');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ segment: 'CURRENCY' as ExchangeSegment })), 'INVALID_SEGMENT');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ status: 'ACTIVE' as CalendarCoverageStatus })), 'INVALID_STATUS');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ version: 0 })), 'INVALID_VERSION');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ version: 1.5 })), 'INVALID_VERSION');
});

test('rejects an invalid coverage range (coverageFrom after coverageTo)', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageFrom: '2031-12-31', coverageTo: '2031-01-01' })), 'INVALID_COVERAGE_RANGE');
});

test('rejects malformed date strings', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageFrom: '2031/01/01' })), 'INVALID_DATE_FORMAT');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: 'bad-date', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY }] })), 'INVALID_DATE_FORMAT');
});

test('fixture import rejects CERTIFIED/DEPRECATED lifecycle requests explicitly', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ status: CalendarCoverageStatus.CERTIFIED })), 'UNSUPPORTED_IMPORT_STATUS');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ status: CalendarCoverageStatus.DEPRECATED })), 'UNSUPPORTED_IMPORT_STATUS');
});

test('DRAFT status may be imported without source provenance for later completion', () => {
  const normalized = validateAndNormalizeCoverageFixture(baseFixture({ sourceDocuments: [], days: [] }));
  assert.equal(normalized.sourceDocuments.length, 0);
});

test('rejects a day outside the coverage range', () => {
  expectCode(
    () => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: '2032-01-01', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY }] })),
    'DATE_OUTSIDE_COVERAGE_RANGE'
  );
});

test('(I) duplicate explicit date definitions are rejected (identical content)', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          days: [
            { tradingDate: '2031-03-03', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'SYN-DOC-A' },
            { tradingDate: '2031-03-03', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'SYN-DOC-A' },
          ],
        })
      ),
    'DUPLICATE_EXPLICIT_DATE'
  );
});

test('(J) conflicting duplicate classification for the same date is rejected', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          days: [
            { tradingDate: '2031-03-03', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'SYN-DOC-A' },
            { tradingDate: '2031-03-03', classification: ExplicitCalendarClassification.REGULAR_SESSION },
          ],
        })
      ),
    'DUPLICATE_EXPLICIT_DATE'
  );
});

test('(K) SPECIAL_SESSION with zero windows is rejected', () => {
  expectCode(
    () => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: '2031-01-04', classification: ExplicitCalendarClassification.SPECIAL_SESSION, sourceDocumentReference: 'SYN-DOC-A' }] })),
    'SPECIAL_SESSION_WITHOUT_WINDOWS'
  );
});

test('(L) a non-SPECIAL_SESSION (CLOSED) day carrying windows is rejected', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          days: [{ tradingDate: '2031-01-01', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'SYN-DOC-A', windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }] }],
        })
      ),
    'NON_SPECIAL_SESSION_WITH_WINDOWS'
  );
});

test('(M) overlapping special-session windows are rejected', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          days: [
            {
              tradingDate: '2031-01-04',
              classification: ExplicitCalendarClassification.SPECIAL_SESSION,
              sourceDocumentReference: 'SYN-DOC-A',
              windows: [
                { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 700 },
                { windowIndex: 1, openMinuteIst: 650, closeMinuteIst: 750 },
              ],
            },
          ],
        })
      ),
    'INVALID_SESSION_WINDOW'
  );
});

test('(N) an invalid minute boundary is rejected', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          days: [{ tradingDate: '2031-01-04', classification: ExplicitCalendarClassification.SPECIAL_SESSION, sourceDocumentReference: 'SYN-DOC-A', windows: [{ windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 600 }] }],
        })
      ),
    'INVALID_SESSION_WINDOW'
  );
});

test('(O policy) an explicit REGULAR_SESSION on a Saturday is rejected -- SPECIAL_SESSION must be used instead', () => {
  // 2031-01-04 is a Saturday.
  expectCode(
    () => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: '2031-01-04', classification: ExplicitCalendarClassification.REGULAR_SESSION }] })),
    'REGULAR_SESSION_ON_WEEKEND_REJECTED'
  );
});

test('(D) an explicit SPECIAL_SESSION on a Saturday is accepted with its windows preserved', () => {
  const normalized = validateAndNormalizeCoverageFixture(
    baseFixture({
      days: [
        {
          tradingDate: '2031-01-04',
          classification: ExplicitCalendarClassification.SPECIAL_SESSION,
          sourceDocumentReference: 'SYN-DOC-A',
          windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 780 }],
        },
      ],
    })
  );
  assert.equal(normalized.days[0].classification, ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.equal(normalized.days[0].windows.length, 1);
});

test('rejects a duplicate source document reference within one fixture', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({
          sourceDocuments: [
            { documentReference: 'SYN-DOC-A', documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR, contentChecksumSha256: SOURCE_CHECKSUM },
            { documentReference: 'SYN-DOC-A', documentType: SourceDocumentType.AMENDMENT, contentChecksumSha256: 'b'.repeat(64) },
          ],
        })
      ),
    'DUPLICATE_SOURCE_DOCUMENT_REFERENCE'
  );
});

test('rejects a day referencing an unknown source document', () => {
  expectCode(
    () => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: '2031-01-01', classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference: 'MISSING' }] })),
    'UNKNOWN_SOURCE_DOCUMENT_REFERENCE'
  );
});

test('strict ISO validation rejects impossible dates and accepts a valid leap day', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageFrom: '2031-02-29' })), 'INVALID_DATE_FORMAT');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageTo: '2031-04-31' })), 'INVALID_DATE_FORMAT');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageFrom: '2031-13-01' })), 'INVALID_DATE_FORMAT');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageFrom: '2031-00-10' })), 'INVALID_DATE_FORMAT');
  assert.doesNotThrow(() =>
    validateAndNormalizeCoverageFixture(
      baseFixture({ calendarYear: 2032, coverageFrom: '2032-02-29', coverageTo: '2032-02-29', days: [] })
    )
  );
});

test('coverage boundaries must stay inside calendarYear and cannot cross years', () => {
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ calendarYear: 2030 })), 'INVALID_CALENDAR_YEAR');
  expectCode(() => validateAndNormalizeCoverageFixture(baseFixture({ coverageTo: '2032-01-01' })), 'INVALID_CALENDAR_YEAR');
});

test('source document immutable content checksum is required and must be lowercase SHA-256 hex', () => {
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({ sourceDocuments: [{ documentReference: 'SYN-DOC-A', documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR, contentChecksumSha256: '' }] })
      ),
    'INVALID_SOURCE_DOCUMENT_CHECKSUM'
  );
  expectCode(
    () =>
      validateAndNormalizeCoverageFixture(
        baseFixture({ sourceDocuments: [{ documentReference: 'SYN-DOC-A', documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR, contentChecksumSha256: 'G'.repeat(64) }] })
      ),
    'INVALID_SOURCE_DOCUMENT_CHECKSUM'
  );
});

test('explicit exceptional dates require direct same-coverage source attribution', () => {
  for (const classification of [
    ExplicitCalendarClassification.EXCHANGE_HOLIDAY,
    ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE,
    ExplicitCalendarClassification.SPECIAL_SESSION,
  ]) {
    const windows = classification === ExplicitCalendarClassification.SPECIAL_SESSION ? [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }] : undefined;
    expectCode(
      () => validateAndNormalizeCoverageFixture(baseFixture({ days: [{ tradingDate: '2031-01-08', classification, windows }] })),
      'MISSING_EXCEPTIONAL_DAY_PROVENANCE'
    );
  }
});

test('does not invent or hardcode real NSE dates/circulars -- fixture content here is entirely synthetic', () => {
  const normalized = validateAndNormalizeCoverageFixture(baseFixture());
  assert.ok(normalized.sourceDocuments.every((doc) => doc.documentReference.startsWith('SYN-')));
});
