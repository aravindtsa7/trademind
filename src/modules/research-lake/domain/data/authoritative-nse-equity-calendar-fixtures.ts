import { CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification, SourceDocumentType } from '../exchange-calendar.types';
import { ExchangeCalendarCoverageFixture, ExchangeCalendarDayFixture, ExchangeCalendarSourceDocumentFixture } from '../exchange-calendar-fixture.types';

/**
 * B-F7A-SOURCE-EVIDENCE-1: the AUTHORITATIVE NSE/EQUITY executable calendar
 * fixture registry, populated for real (2022-2026 V1) now that genuine
 * source evidence exists.
 *
 * Every `contentChecksumSha256` below is the REAL SHA-256 of the actual
 * archived document bytes, produced by a live run of
 * `research:archive:equity-calendar-sources` against the official
 * `nsearchives.nseindia.com` host, re-verified receipt-to-blob afterward
 * (`artifacts/nse-raw-source-archive/receipts/receipt-index.json` +
 * `.../blobs/<sha256>.pdf`) -- never hand-typed or guessed. Two references
 * (`NSE/CMTR/57285`, `NSE/CMTR/60338`) are officially published as `.zip`
 * bundles; their checksum is over the extracted, reference-bound PDF member
 * (`raw-source-zip-envelope.util.ts`), not the zip container, matching what
 * `contentChecksumSha256` means for every other document here: the
 * authoritative source document's own bytes.
 *
 * Every date/holiday/session-window fact below was independently
 * cross-checked against the real circular text (via `pdftotext`) during
 * source acquisition, not merely copied from a task instruction.
 */

const NSE_EQUITY_SOURCE_AUTHORITY = 'NSE';

function circular(
  documentReference: string,
  documentType: SourceDocumentType,
  contentChecksumSha256: string,
  referenceUrl: string
): ExchangeCalendarSourceDocumentFixture {
  return { documentReference, documentType, contentChecksumSha256, referenceUrl };
}

function holiday(tradingDate: string, sourceDocumentReference: string, reason: string): ExchangeCalendarDayFixture {
  return { tradingDate, classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY, sourceDocumentReference, reason };
}

function exceptionalClosure(tradingDate: string, sourceDocumentReference: string, reason: string): ExchangeCalendarDayFixture {
  return { tradingDate, classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE, sourceDocumentReference, reason };
}

function specialSession(
  tradingDate: string,
  sourceDocumentReference: string,
  reason: string,
  windows: ReadonlyArray<{ readonly openMinuteIst: number; readonly closeMinuteIst: number }>
): ExchangeCalendarDayFixture {
  return {
    tradingDate,
    classification: ExplicitCalendarClassification.SPECIAL_SESSION,
    sourceDocumentReference,
    reason,
    windows: windows.map((window, index) => ({ windowIndex: index, ...window })),
  };
}

// ============================================================
// 2022
// ============================================================
const NSE_CMTR_50560 = circular(
  'NSE/CMTR/50560',
  SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  '731a4f0f3b3633e53ff344ffda23dab0277c4a6608f5a6da8874f931c9be4ead',
  'https://nsearchives.nseindia.com/content/circulars/CMTR50560.pdf'
);
const NSE_CMTR_54023 = circular(
  'NSE/CMTR/54023',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '01e579eac8e2dd4a870a9ebc9f08d60bc26fae28d0d35cf58891bf2a2964e0c7',
  'https://nsearchives.nseindia.com/content/circulars/CMTR54023.pdf'
);

const FIXTURE_2022: ExchangeCalendarCoverageFixture = {
  exchange: Exchange.NSE,
  segment: ExchangeSegment.EQUITY,
  coverageFrom: '2022-01-01',
  coverageTo: '2022-12-31',
  calendarYear: 2022,
  version: 1,
  status: CalendarCoverageStatus.DRAFT,
  sourceAuthority: NSE_EQUITY_SOURCE_AUTHORITY,
  sourceDocuments: [NSE_CMTR_50560, NSE_CMTR_54023],
  days: [
    holiday('2022-01-26', NSE_CMTR_50560.documentReference, 'Republic Day'),
    holiday('2022-03-01', NSE_CMTR_50560.documentReference, 'Mahashivratri'),
    holiday('2022-03-18', NSE_CMTR_50560.documentReference, 'Holi'),
    holiday('2022-04-14', NSE_CMTR_50560.documentReference, "Dr. Baba Saheb Ambedkar Jayanti/Mahavir Jayanti"),
    holiday('2022-04-15', NSE_CMTR_50560.documentReference, 'Good Friday'),
    holiday('2022-05-03', NSE_CMTR_50560.documentReference, 'Id-Ul-Fitr (Ramzan ID)'),
    holiday('2022-08-09', NSE_CMTR_50560.documentReference, 'Moharram'),
    holiday('2022-08-15', NSE_CMTR_50560.documentReference, 'Independence Day'),
    holiday('2022-08-31', NSE_CMTR_50560.documentReference, 'Ganesh Chaturthi'),
    holiday('2022-10-05', NSE_CMTR_50560.documentReference, 'Dussehra'),
    holiday('2022-10-26', NSE_CMTR_50560.documentReference, 'Diwali-Balipratipada'),
    holiday('2022-11-08', NSE_CMTR_50560.documentReference, 'Gurunanak Jayanti'),
    specialSession('2022-10-24', NSE_CMTR_54023.documentReference, 'Diwali Muhurat Trading -- Normal Market session', [{ openMinuteIst: 1095, closeMinuteIst: 1155 }]),
  ],
};

// ============================================================
// 2023
// ============================================================
const NSE_CMTR_54757 = circular(
  'NSE/CMTR/54757',
  SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  '035ea9a4178e322549b87c6d72f7fc74c7cec06e2d6074c01ac2a7e6a5a7b621',
  'https://nsearchives.nseindia.com/content/circulars/CMTR54757.pdf'
);
const NSE_CMTR_57285 = circular(
  'NSE/CMTR/57285',
  SourceDocumentType.AMENDMENT,
  'f8294598d95fb8b070d59272a06621f8ac2a16755767b59ef95a5dc82f48dec3',
  'https://nsearchives.nseindia.com/content/circulars/CMTR57285.zip'
);
const NSE_CMTR_59124 = circular(
  'NSE/CMTR/59124',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '09f80430f3ec95aeaeeb98938124273892abccc38a7aaa440b38a6426b428c21',
  'https://nsearchives.nseindia.com/content/circulars/CMTR59124.pdf'
);

const FIXTURE_2023: ExchangeCalendarCoverageFixture = {
  exchange: Exchange.NSE,
  segment: ExchangeSegment.EQUITY,
  coverageFrom: '2023-01-01',
  coverageTo: '2023-12-31',
  calendarYear: 2023,
  version: 1,
  status: CalendarCoverageStatus.DRAFT,
  sourceAuthority: NSE_EQUITY_SOURCE_AUTHORITY,
  sourceDocuments: [NSE_CMTR_54757, NSE_CMTR_57285, NSE_CMTR_59124],
  days: [
    holiday('2023-01-26', NSE_CMTR_54757.documentReference, 'Republic Day'),
    holiday('2023-03-07', NSE_CMTR_54757.documentReference, 'Holi'),
    holiday('2023-03-30', NSE_CMTR_54757.documentReference, 'Ram Navami'),
    holiday('2023-04-04', NSE_CMTR_54757.documentReference, 'Mahavir Jayanti'),
    holiday('2023-04-07', NSE_CMTR_54757.documentReference, 'Good Friday'),
    holiday('2023-04-14', NSE_CMTR_54757.documentReference, 'Dr. Baba Saheb Ambedkar Jayanti'),
    holiday('2023-05-01', NSE_CMTR_54757.documentReference, 'Maharashtra Day'),
    // 2023-06-28 is deliberately NOT an explicit row -- amended to 2023-06-29 by NSE/CMTR/57285.
    holiday('2023-06-29', NSE_CMTR_57285.documentReference, 'Bakri Id (Id-Ul-Zuha) -- moved from June 28 to June 29 per Maharashtra government notification'),
    holiday('2023-08-15', NSE_CMTR_54757.documentReference, 'Independence Day'),
    holiday('2023-09-19', NSE_CMTR_54757.documentReference, 'Ganesh Chaturthi'),
    holiday('2023-10-02', NSE_CMTR_54757.documentReference, 'Mahatma Gandhi Jayanti'),
    holiday('2023-10-24', NSE_CMTR_54757.documentReference, 'Dussehra'),
    holiday('2023-11-14', NSE_CMTR_54757.documentReference, 'Diwali-Balipratipada'),
    holiday('2023-11-27', NSE_CMTR_54757.documentReference, 'Gurunanak Jayanti'),
    holiday('2023-12-25', NSE_CMTR_54757.documentReference, 'Christmas'),
    specialSession('2023-11-12', NSE_CMTR_59124.documentReference, 'Diwali Muhurat Trading -- Normal Market session', [{ openMinuteIst: 1095, closeMinuteIst: 1155 }]),
  ],
};

// ============================================================
// 2024
// ============================================================
const NSE_CMTR_59722 = circular(
  'NSE/CMTR/59722',
  SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  '7157229ba94c179d280dd0d732da56d0992c482e862fac72d9d3879626c77c8a',
  'https://nsearchives.nseindia.com/content/circulars/CMTR59722.pdf'
);
const NSE_MSD_59999 = circular(
  'NSE/MSD/59999',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '614b965d1152ed636052e983a01206117ff6af224365348fa00b7165a6baa243',
  'https://nsearchives.nseindia.com/content/circulars/MSD59999.pdf'
);
const NSE_MSD_60300 = circular(
  'NSE/MSD/60300',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '96dc70980bcbc2fab13c10300aad16e0664bbca8b56b15a6a212145c1564e3be',
  'https://nsearchives.nseindia.com/content/circulars/MSD60300.pdf'
);
const NSE_MSD_60318 = circular(
  'NSE/MSD/60318',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '55f8f0a4597dac4d7635e790edc0972ac022b4da2bf25c9e1197f6c6d0f6bf40',
  'https://nsearchives.nseindia.com/content/circulars/MSD60318.pdf'
);
const NSE_MSD_60340 = circular(
  'NSE/MSD/60340',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '6d165b8d132b7b430ae79032356ea331fab3d852192b74df4bc9e56722f54cdd',
  'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf'
);
const NSE_CMTR_60338 = circular(
  'NSE/CMTR/60338',
  SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
  'e848537f183da42ed5adf355b520e5cfbeaae8355ba5c3384d451f23be45548c',
  'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip'
);
const NSE_MSD_60677 = circular(
  'NSE/MSD/60677',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '04b67f39314bae95672d86497c28cbed6cea698ad6f029ba47ef74feb9f6da91',
  'https://nsearchives.nseindia.com/content/circulars/MSD60677.pdf'
);
const NSE_CMTR_61518 = circular(
  'NSE/CMTR/61518',
  SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
  '8f44e5dab885e081e9809aa41cbc6017309cf35281d29655a219d822e6f31a39',
  'https://nsearchives.nseindia.com/content/circulars/CMTR61518.pdf'
);
const NSE_MSD_61893 = circular(
  'NSE/MSD/61893',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '2483f60d67c34231d6fd25024cf5767c031b234196a7a475535d434cd4e758c8',
  'https://nsearchives.nseindia.com/content/circulars/MSD61893.pdf'
);
const NSE_CMTR_64628 = circular(
  'NSE/CMTR/64628',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  'dd1b8bc34a4b3c2900002341c41e4b8f165af862a74fd2a5bfb1355b0afec4a8',
  'https://nsearchives.nseindia.com/content/circulars/CMTR64628.pdf'
);
const NSE_CMTR_64960 = circular(
  'NSE/CMTR/64960',
  SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
  '342b404b2f6631e8d2b74bb203e53faeb5e8b02abc21eb31094ef0c53b168e31',
  'https://nsearchives.nseindia.com/content/circulars/CMTR64960.pdf'
);

const FIXTURE_2024: ExchangeCalendarCoverageFixture = {
  exchange: Exchange.NSE,
  segment: ExchangeSegment.EQUITY,
  coverageFrom: '2024-01-01',
  coverageTo: '2024-12-31',
  calendarYear: 2024,
  version: 1,
  status: CalendarCoverageStatus.DRAFT,
  sourceAuthority: NSE_EQUITY_SOURCE_AUTHORITY,
  // Task section 22: all four Jan-20 lineage documents are retained here for
  // provenance/lineage even though only NSE/MSD/60340 (the FINAL, non-withdrawn
  // notice) is actually referenced by the 2024-01-20 day row below.
  sourceDocuments: [
    NSE_CMTR_59722,
    NSE_MSD_59999,
    NSE_MSD_60300,
    NSE_MSD_60318,
    NSE_MSD_60340,
    NSE_CMTR_60338,
    NSE_MSD_60677,
    NSE_CMTR_61518,
    NSE_MSD_61893,
    NSE_CMTR_64628,
    NSE_CMTR_64960,
  ],
  days: [
    holiday('2024-01-26', NSE_CMTR_59722.documentReference, 'Republic Day'),
    holiday('2024-03-08', NSE_CMTR_59722.documentReference, 'Mahashivratri'),
    holiday('2024-03-25', NSE_CMTR_59722.documentReference, 'Holi'),
    holiday('2024-03-29', NSE_CMTR_59722.documentReference, 'Good Friday'),
    holiday('2024-04-11', NSE_CMTR_59722.documentReference, 'Id-Ul-Fitr (Ramadan Eid)'),
    holiday('2024-04-17', NSE_CMTR_59722.documentReference, 'Shri Ram Navmi'),
    holiday('2024-05-01', NSE_CMTR_59722.documentReference, 'Maharashtra Day'),
    holiday('2024-06-17', NSE_CMTR_59722.documentReference, 'Bakri Id'),
    holiday('2024-07-17', NSE_CMTR_59722.documentReference, 'Moharram'),
    holiday('2024-08-15', NSE_CMTR_59722.documentReference, 'Independence Day/Parsi New Year'),
    holiday('2024-10-02', NSE_CMTR_59722.documentReference, 'Mahatma Gandhi Jayanti'),
    holiday('2024-11-15', NSE_CMTR_59722.documentReference, 'Gurunanak Jayanti'),
    holiday('2024-12-25', NSE_CMTR_59722.documentReference, 'Christmas'),
    specialSession('2024-01-20', NSE_MSD_60340.documentReference, 'Live trading session on Primary site -- final authority, withdraws the Jan-20 lineage (NSE/MSD/59999, NSE/MSD/60300, NSE/MSD/60318)', [
      { openMinuteIst: 555, closeMinuteIst: 930 },
    ]),
    exceptionalClosure('2024-01-22', NSE_CMTR_60338.documentReference, 'Holiday declared under Negotiable Instrument Act (Maharashtra Government/RBI notification)'),
    specialSession('2024-03-02', NSE_MSD_60677.documentReference, 'Special live trading session with intra-day switchover to DR site -- Capital Market Segment', [
      { openMinuteIst: 555, closeMinuteIst: 600 },
      { openMinuteIst: 690, closeMinuteIst: 750 },
    ]),
    specialSession('2024-05-18', NSE_MSD_61893.documentReference, 'Special live trading session with intra-day switchover to DR site -- Capital Market Segment', [
      { openMinuteIst: 555, closeMinuteIst: 600 },
      { openMinuteIst: 690, closeMinuteIst: 750 },
    ]),
    exceptionalClosure('2024-05-20', NSE_CMTR_61518.documentReference, 'Parliamentary Elections in Mumbai'),
    specialSession('2024-11-01', NSE_CMTR_64628.documentReference, 'Diwali Muhurat Trading -- Normal Market session', [{ openMinuteIst: 1080, closeMinuteIst: 1140 }]),
    exceptionalClosure('2024-11-20', NSE_CMTR_64960.documentReference, 'Assembly Elections in Maharashtra'),
  ],
};

// ============================================================
// 2025
// ============================================================
const NSE_CMTR_65587 = circular(
  'NSE/CMTR/65587',
  SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  '1e0f85615fbbcde9243dd6cafbbad4d9b581b8d2467fd9e27c0a4fe42a720c7d',
  'https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf'
);
const NSE_CMTR_65729 = circular(
  'NSE/CMTR/65729',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '84d12e29654e75f77baa0b9064a26f6d0e4c3ff58e64df14e01247a0c15a91be',
  'https://nsearchives.nseindia.com/content/circulars/CMTR65729.pdf'
);
const NSE_CMTR_70319 = circular(
  'NSE/CMTR/70319',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '19b7d88003cb05eb8c6abdc8d1bfad5df821a17e4f9ae36f75e327a68a48d258',
  'https://nsearchives.nseindia.com/content/circulars/CMTR70319.pdf'
);

const FIXTURE_2025: ExchangeCalendarCoverageFixture = {
  exchange: Exchange.NSE,
  segment: ExchangeSegment.EQUITY,
  coverageFrom: '2025-01-01',
  coverageTo: '2025-12-31',
  calendarYear: 2025,
  version: 1,
  status: CalendarCoverageStatus.DRAFT,
  sourceAuthority: NSE_EQUITY_SOURCE_AUTHORITY,
  sourceDocuments: [NSE_CMTR_65587, NSE_CMTR_65729, NSE_CMTR_70319],
  days: [
    holiday('2025-02-26', NSE_CMTR_65587.documentReference, 'Mahashivratri'),
    holiday('2025-03-14', NSE_CMTR_65587.documentReference, 'Holi'),
    holiday('2025-03-31', NSE_CMTR_65587.documentReference, 'Id-Ul-Fitr (Ramadan Eid)'),
    holiday('2025-04-10', NSE_CMTR_65587.documentReference, 'Shri Mahavir Jayanti'),
    holiday('2025-04-14', NSE_CMTR_65587.documentReference, 'Dr. Baba Saheb Ambedkar Jayanti'),
    holiday('2025-04-18', NSE_CMTR_65587.documentReference, 'Good Friday'),
    holiday('2025-05-01', NSE_CMTR_65587.documentReference, 'Maharashtra Day'),
    holiday('2025-08-15', NSE_CMTR_65587.documentReference, 'Independence Day'),
    holiday('2025-08-27', NSE_CMTR_65587.documentReference, 'Ganesh Chaturthi'),
    holiday('2025-10-02', NSE_CMTR_65587.documentReference, 'Mahatma Gandhi Jayanti/Dussehra'),
    holiday('2025-10-22', NSE_CMTR_65587.documentReference, 'Diwali-Balipratipada'),
    holiday('2025-11-05', NSE_CMTR_65587.documentReference, 'Prakash Gurpurb Sri Guru Nanak Dev'),
    holiday('2025-12-25', NSE_CMTR_65587.documentReference, 'Christmas'),
    // 2025-06-06/06-07 (Bakri Id, falling on a weekend) deliberately have no explicit row -- matches the annual circular, which lists it only under "holidays falling on Saturday/Sunday" with no separate trading closure.
    specialSession('2025-02-01', NSE_CMTR_65729.documentReference, 'Live trading session -- Presentation of Union Budget', [{ openMinuteIst: 555, closeMinuteIst: 930 }]),
    specialSession('2025-10-21', NSE_CMTR_70319.documentReference, 'Diwali Muhurat Trading -- Normal Market session', [{ openMinuteIst: 825, closeMinuteIst: 885 }]),
  ],
};

// ============================================================
// 2026 V1 (coverage capped at 2026-08-28 -- task section 21/26)
// ============================================================
const NSE_CMTR_71775 = circular(
  'NSE/CMTR/71775',
  SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
  'aa97e0afc0ce394097f2fc62631c68e3c2e4c7c23541ed35f21d9fc06b0dcacb',
  'https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf'
);
const NSE_CMTR_72260 = circular(
  'NSE/CMTR/72260',
  SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
  'c5d32a838b46d5044717b830a4793479a51a40f8e4e19d3896c65682d15b6ebc',
  'https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf'
);
const NSE_CMTR_72349 = circular(
  'NSE/CMTR/72349',
  SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
  '70458f7b8126f47584d4bc402a78dde357e42dbebaa5d53cfce0c70c82dabfc3',
  'https://nsearchives.nseindia.com/content/circulars/CMTR72349.pdf'
);

const FIXTURE_2026_V1: ExchangeCalendarCoverageFixture = {
  exchange: Exchange.NSE,
  segment: ExchangeSegment.EQUITY,
  coverageFrom: '2026-01-01',
  coverageTo: '2026-08-28',
  calendarYear: 2026,
  version: 1,
  status: CalendarCoverageStatus.DRAFT,
  sourceAuthority: NSE_EQUITY_SOURCE_AUTHORITY,
  sourceDocuments: [NSE_CMTR_71775, NSE_CMTR_72260, NSE_CMTR_72349],
  days: [
    // Only the subset of NSE/CMTR/71775's full-year (15-holiday) list that falls
    // on or before the V1 coverageTo cutoff (2026-08-28) is certified here --
    // the remaining 6 (Sep-Dec) are NOT included, per task section 21/26.
    holiday('2026-01-26', NSE_CMTR_71775.documentReference, 'Republic Day'),
    holiday('2026-03-03', NSE_CMTR_71775.documentReference, 'Holi'),
    holiday('2026-03-26', NSE_CMTR_71775.documentReference, 'Shri Ram Navmi'),
    holiday('2026-03-31', NSE_CMTR_71775.documentReference, 'Shri Mahavir Jayanti'),
    holiday('2026-04-03', NSE_CMTR_71775.documentReference, 'Good Friday'),
    holiday('2026-04-14', NSE_CMTR_71775.documentReference, 'Dr. Baba Saheb Ambedkar Jayanti'),
    holiday('2026-05-01', NSE_CMTR_71775.documentReference, 'Maharashtra Day'),
    holiday('2026-05-28', NSE_CMTR_71775.documentReference, 'Bakri Id'),
    holiday('2026-06-26', NSE_CMTR_71775.documentReference, 'Muharram'),
    exceptionalClosure('2026-01-15', NSE_CMTR_72260.documentReference, 'Municipal Corporation Election in Maharashtra (Capital Market Segment)'),
    specialSession('2026-02-01', NSE_CMTR_72349.documentReference, 'Live trading session -- Presentation of Union Budget', [{ openMinuteIst: 555, closeMinuteIst: 930 }]),
  ],
};

export const AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURE_YEARS = [2022, 2023, 2024, 2025, 2026] as const;

export const AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES: readonly ExchangeCalendarCoverageFixture[] = [FIXTURE_2022, FIXTURE_2023, FIXTURE_2024, FIXTURE_2025, FIXTURE_2026_V1];

/**
 * No implicit filesystem scanning, no dynamic code loading, no "latest
 * fixture" fuzzy selection -- a plain linear lookup over the explicit
 * array above. Returns `undefined` (never throws, never fabricates a
 * fixture) when no entry is registered for `calendarYear` -- the caller
 * (`ExchangeCalendarOpsRunnerService`) is responsible for turning an
 * `undefined` result into a typed, reportable outcome.
 */
export function findAuthoritativeNseEquityCalendarFixture(calendarYear: number): ExchangeCalendarCoverageFixture | undefined {
  return AUTHORITATIVE_NSE_EQUITY_CALENDAR_FIXTURES.find((fixture) => fixture.calendarYear === calendarYear);
}
