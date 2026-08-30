import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification } from '../exchange-calendar.types';
import { validateAndNormalizeCoverageFixture } from '../exchange-calendar-fixture.types';
import { computeCoverageSourceBundleChecksum } from '../exchange-calendar-checksum';
import {
  AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES,
  AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURE_YEARS,
  findAuthoritativeNseEquityCalendarFixture,
} from './authoritative-nse-equity-calendar-fixtures';

/**
 * B-F7A-SOURCE-EVIDENCE-1 golden-truth fixture tests. Every checksum below
 * was computed FROM the production `computeCoverageSourceBundleChecksum`
 * over the real fixture data (never hand-typed/guessed) and is re-derived
 * again in this suite so a future accidental edit to any fixture's
 * days/sourceDocuments/windows is caught as a checksum mismatch.
 */
const EXPECTED_SOURCE_BUNDLE_CHECKSUMS: Readonly<Record<number, string>> = {
  2022: 'a62683cbc499c28092de66ab6b8523d8985ef24f1ecd8954e7520100033372a8',
  2023: 'a09bd6c488b0774bf92fd00cb5c481137534690f46252082a022ae4cb80745f7',
  2024: '66fb15531fe934a27a43ae865479f87d4034cdface75630113c88e05c7255043',
  2025: '0d02cbbb851810e1a333cfffbc993e59301f0a824e3519f8ddfa0b8867038791',
  2026: '2bcd9ab9a39be160f6896c7505ec29cdd2de26334540d4521c42a0e74cc96fba',
};

function fixtureFor(year: number) {
  const fixture = AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES.find((candidate) => candidate.calendarYear === year);
  assert.ok(fixture, `expected a registered fixture for calendarYear ${year}`);
  return fixture!;
}

test('the registry contains exactly one fixture for each of 2022-2026, in ascending order, no more, no fewer', () => {
  assert.equal(AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES.length, 5);
  assert.deepEqual(
    AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES.map((f) => f.calendarYear),
    [2022, 2023, 2024, 2025, 2026]
  );
});

test('the lookup helper resolves every accepted year and returns undefined for anything else', () => {
  for (const year of AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURE_YEARS) {
    assert.ok(findAuthoritativeNseEquityCalendarFixture(year) !== undefined, `expected a fixture for ${year}`);
  }
  assert.equal(findAuthoritativeNseEquityCalendarFixture(1999), undefined);
  assert.equal(findAuthoritativeNseEquityCalendarFixture(2027), undefined);
});

test('every fixture is NSE/EQUITY, DRAFT, version 1, and passes production validation', () => {
  for (const fixture of AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES) {
    assert.equal(fixture.exchange, Exchange.NSE);
    assert.equal(fixture.segment, ExchangeSegment.EQUITY);
    assert.equal(fixture.status, CalendarCoverageStatus.DRAFT);
    assert.equal(fixture.version, 1);
    assert.doesNotThrow(() => validateAndNormalizeCoverageFixture(fixture), `fixture ${fixture.calendarYear} must pass production validation`);
  }
});

test('every source document carries a genuine (non-placeholder) 64-lowercase-hex checksum, and no two documents across the whole registry share a checksum by accident', () => {
  const seen = new Map<string, string>();
  for (const fixture of AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES) {
    for (const doc of fixture.sourceDocuments) {
      assert.match(doc.contentChecksumSha256, /^[a-f0-9]{64}$/, `${doc.documentReference} checksum must be 64 lowercase hex chars`);
      assert.notEqual(doc.contentChecksumSha256, '0'.repeat(64), `${doc.documentReference} must not carry a placeholder all-zero checksum`);
      const priorOwner = seen.get(doc.contentChecksumSha256);
      assert.ok(priorOwner === undefined || priorOwner === doc.documentReference, `checksum collision between ${priorOwner} and ${doc.documentReference} -- distinct documents must never share a hash`);
      seen.set(doc.contentChecksumSha256, doc.documentReference);
    }
  }
});

test('no two registered fixtures ever share a calendarYear', () => {
  const years = AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES.map((fixture) => fixture.calendarYear);
  assert.equal(new Set(years).size, years.length);
});

// ============================================================
// 2022
// ============================================================
test('2022: coverage, source document count, explicit day set, and provenance are exact', () => {
  const fixture = fixtureFor(2022);
  assert.equal(fixture.coverageFrom, '2022-01-01');
  assert.equal(fixture.coverageTo, '2022-12-31');
  assert.equal(fixture.sourceDocuments.length, 2);
  assert.deepEqual(
    new Set(fixture.sourceDocuments.map((d) => d.documentReference)),
    new Set(['NSE/CMTR/50560', 'NSE/CMTR/54023'])
  );

  const explicitHolidays = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.deepEqual(
    explicitHolidays.map((d) => d.tradingDate).sort(),
    ['2022-01-26', '2022-03-01', '2022-03-18', '2022-04-14', '2022-04-15', '2022-05-03', '2022-08-09', '2022-08-15', '2022-08-31', '2022-10-05', '2022-10-26', '2022-11-08']
  );
  assert.ok(explicitHolidays.every((d) => d.sourceDocumentReference === 'NSE/CMTR/50560'));

  const special = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.equal(special.length, 1);
  assert.equal(special[0].tradingDate, '2022-10-24');
  assert.equal(special[0].sourceDocumentReference, 'NSE/CMTR/54023');
  assert.deepEqual(special[0].windows, [{ windowIndex: 0, openMinuteIst: 1095, closeMinuteIst: 1155 }]);
});

// ============================================================
// 2023
// ============================================================
test('2023: the June holiday amendment lands on June 29 (not June 28), attributed to NSE/CMTR/57285', () => {
  const fixture = fixtureFor(2023);
  assert.equal(fixture.days.some((d) => d.tradingDate === '2023-06-28'), false, '2023-06-28 must NOT be an explicit day');

  const june29 = fixture.days.find((d) => d.tradingDate === '2023-06-29');
  assert.ok(june29);
  assert.equal(june29!.classification, ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.equal(june29!.sourceDocumentReference, 'NSE/CMTR/57285');
});

test('2023: coverage, source document count, explicit day set (15 holidays + 1 special), and special session window are exact', () => {
  const fixture = fixtureFor(2023);
  assert.equal(fixture.coverageFrom, '2023-01-01');
  assert.equal(fixture.coverageTo, '2023-12-31');
  assert.equal(fixture.sourceDocuments.length, 3);
  assert.deepEqual(
    new Set(fixture.sourceDocuments.map((d) => d.documentReference)),
    new Set(['NSE/CMTR/54757', 'NSE/CMTR/57285', 'NSE/CMTR/59124'])
  );

  const explicitHolidays = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.equal(explicitHolidays.length, 15);
  assert.deepEqual(
    explicitHolidays.map((d) => d.tradingDate).sort(),
    ['2023-01-26', '2023-03-07', '2023-03-30', '2023-04-04', '2023-04-07', '2023-04-14', '2023-05-01', '2023-06-29', '2023-08-15', '2023-09-19', '2023-10-02', '2023-10-24', '2023-11-14', '2023-11-27', '2023-12-25']
  );

  const special = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.equal(special.length, 1);
  assert.equal(special[0].tradingDate, '2023-11-12');
  assert.equal(special[0].sourceDocumentReference, 'NSE/CMTR/59124');
  assert.deepEqual(special[0].windows, [{ windowIndex: 0, openMinuteIst: 1095, closeMinuteIst: 1155 }]);
});

// ============================================================
// 2024
// ============================================================
test('2024: the Jan-20 lineage is retained in full for provenance, but only NSE/MSD/60340 (FINAL) is referenced by the day row', () => {
  const fixture = fixtureFor(2024);
  const jan20LineageRefs = ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318', 'NSE/MSD/60340'];
  for (const reference of jan20LineageRefs) {
    assert.ok(fixture.sourceDocuments.some((d) => d.documentReference === reference), `expected lineage document ${reference} to remain in sourceDocuments`);
  }
  const jan20 = fixture.days.find((d) => d.tradingDate === '2024-01-20');
  assert.ok(jan20);
  assert.equal(jan20!.classification, ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.equal(jan20!.sourceDocumentReference, 'NSE/MSD/60340');
  assert.deepEqual(jan20!.windows, [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }]);
});

test('2024: coverage, source document count (11, the EQUITY-applicable subset), explicit day set, exceptional closures, and special sessions are exact', () => {
  const fixture = fixtureFor(2024);
  assert.equal(fixture.coverageFrom, '2024-01-01');
  assert.equal(fixture.coverageTo, '2024-12-31');
  assert.equal(fixture.sourceDocuments.length, 11);

  const explicitHolidays = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.deepEqual(
    explicitHolidays.map((d) => d.tradingDate).sort(),
    ['2024-01-26', '2024-03-08', '2024-03-25', '2024-03-29', '2024-04-11', '2024-04-17', '2024-05-01', '2024-06-17', '2024-07-17', '2024-08-15', '2024-10-02', '2024-11-15', '2024-12-25']
  );
  assert.ok(explicitHolidays.every((d) => d.sourceDocumentReference === 'NSE/CMTR/59722'));

  const exceptionalClosures = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE);
  assert.deepEqual(
    exceptionalClosures.map((d) => [d.tradingDate, d.sourceDocumentReference]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    [
      ['2024-01-22', 'NSE/CMTR/60338'],
      ['2024-05-20', 'NSE/CMTR/61518'],
      ['2024-11-20', 'NSE/CMTR/64960'],
    ]
  );

  const special = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.SPECIAL_SESSION);
  const byDate = new Map(special.map((d) => [d.tradingDate, d]));
  assert.equal(special.length, 4);
  assert.deepEqual(byDate.get('2024-01-20')!.windows, [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }]);
  assert.deepEqual(byDate.get('2024-03-02')!.windows, [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ]);
  assert.deepEqual(byDate.get('2024-05-18')!.windows, [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ]);
  assert.deepEqual(byDate.get('2024-11-01')!.windows, [{ windowIndex: 0, openMinuteIst: 1080, closeMinuteIst: 1140 }]);
  assert.equal(byDate.get('2024-03-02')!.sourceDocumentReference, 'NSE/MSD/60677');
  assert.equal(byDate.get('2024-05-18')!.sourceDocumentReference, 'NSE/MSD/61893');
  assert.equal(byDate.get('2024-11-01')!.sourceDocumentReference, 'NSE/CMTR/64628');
});

// ============================================================
// 2025
// ============================================================
test('2025: June 6/7 (Bakri Id, weekend) carry no explicit row', () => {
  const fixture = fixtureFor(2025);
  assert.equal(fixture.days.some((d) => d.tradingDate === '2025-06-06'), false);
  assert.equal(fixture.days.some((d) => d.tradingDate === '2025-06-07'), false);
});

test('2025: coverage, source document count, explicit holiday set (13), and both special session windows are exact', () => {
  const fixture = fixtureFor(2025);
  assert.equal(fixture.coverageFrom, '2025-01-01');
  assert.equal(fixture.coverageTo, '2025-12-31');
  assert.equal(fixture.sourceDocuments.length, 3);

  const explicitHolidays = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.deepEqual(
    explicitHolidays.map((d) => d.tradingDate).sort(),
    ['2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-22', '2025-11-05', '2025-12-25']
  );
  assert.ok(explicitHolidays.every((d) => d.sourceDocumentReference === 'NSE/CMTR/65587'));

  const special = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.SPECIAL_SESSION);
  const byDate = new Map(special.map((d) => [d.tradingDate, d]));
  assert.equal(special.length, 2);
  assert.deepEqual(byDate.get('2025-02-01')!.windows, [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }]);
  assert.equal(byDate.get('2025-02-01')!.sourceDocumentReference, 'NSE/CMTR/65729');
  assert.deepEqual(byDate.get('2025-10-21')!.windows, [{ windowIndex: 0, openMinuteIst: 825, closeMinuteIst: 885 }]);
  assert.equal(byDate.get('2025-10-21')!.sourceDocumentReference, 'NSE/CMTR/70319');
});

// ============================================================
// 2026 V1 cutoff
// ============================================================
test('2026 V1: coverageTo is exactly 2026-08-28, and no explicit day exceeds that cutoff', () => {
  const fixture = fixtureFor(2026);
  assert.equal(fixture.coverageFrom, '2026-01-01');
  assert.equal(fixture.coverageTo, '2026-08-28');
  const maxExplicitDay = fixture.days.reduce((max, d) => (d.tradingDate > max ? d.tradingDate : max), '');
  assert.ok(maxExplicitDay <= '2026-08-28', `max explicit day ${maxExplicitDay} must not exceed the V1 cutoff`);
  assert.ok(
    fixture.days.every((d) => d.tradingDate <= '2026-08-28'),
    'no explicit day may fall after the V1 cutoff'
  );
});

test('2026 V1: the annual circular is full-year, but only the pre-cutoff subset of its holidays (9) is certified here, plus the exceptional closure and special session', () => {
  const fixture = fixtureFor(2026);
  assert.equal(fixture.sourceDocuments.length, 3);

  const explicitHolidays = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCHANGE_HOLIDAY);
  assert.deepEqual(
    explicitHolidays.map((d) => d.tradingDate).sort(),
    ['2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26']
  );
  assert.ok(explicitHolidays.every((d) => d.sourceDocumentReference === 'NSE/CMTR/71775'));

  const exceptional = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE);
  assert.equal(exceptional.length, 1);
  assert.equal(exceptional[0].tradingDate, '2026-01-15');
  assert.equal(exceptional[0].sourceDocumentReference, 'NSE/CMTR/72260');

  const special = fixture.days.filter((d) => d.classification === ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.equal(special.length, 1);
  assert.equal(special[0].tradingDate, '2026-02-01');
  assert.equal(special[0].sourceDocumentReference, 'NSE/CMTR/72349');
  assert.deepEqual(special[0].windows, [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }]);
});

// ============================================================
// Golden checksums
// ============================================================
test('every fixture reproduces its locked, deterministic sourceBundleChecksum', () => {
  for (const fixture of AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES) {
    const normalized = validateAndNormalizeCoverageFixture(fixture);
    const checksum = computeCoverageSourceBundleChecksum(normalized);
    assert.equal(checksum, EXPECTED_SOURCE_BUNDLE_CHECKSUMS[fixture.calendarYear], `sourceBundleChecksum for ${fixture.calendarYear} must match the locked golden value`);
  }
});

test('checksum determinism: recomputing twice over independently-ordered copies of the same fixture yields the identical checksum (task section 10.U/V/W)', () => {
  for (const fixture of AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES) {
    const reordered = {
      ...fixture,
      sourceDocuments: [...fixture.sourceDocuments].reverse(),
      days: [...fixture.days].reverse(),
    };
    const a = computeCoverageSourceBundleChecksum(validateAndNormalizeCoverageFixture(fixture));
    const b = computeCoverageSourceBundleChecksum(validateAndNormalizeCoverageFixture(reordered));
    assert.equal(a, b, `${fixture.calendarYear}: checksum must be independent of input array order`);
  }
});
