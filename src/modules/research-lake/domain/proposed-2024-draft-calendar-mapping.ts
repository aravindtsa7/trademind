import { ReviewedRawSourceManifest, RawSourceLifecycleStatus } from './raw-source-archive.types';

/**
 * B-F7A-ARCHIVE-1 PROPOSED DRAFT archive-to-calendar mapping (task section
 * 16/23.O). This is NOT an `ExchangeCalendarCoverageFixture` and is never
 * passed to `validateAndNormalizeCoverageFixture` / `ExchangeCalendarImporterService`
 * / `ExchangeCalendarRepository.importDraftFixture` -- its shape is
 * deliberately incompatible with that type (grouped by classification, no
 * `status`/`version`/`coverageFrom`/`coverageTo` fields) precisely so it
 * cannot be mistaken for one and fed into the real import path. It exists
 * only "for later review" (task section 3/16): a human-readable proposal of
 * which archived raw sources would support which 2024 calendar facts, built
 * from the ALREADY-ACCEPTED 2024 semantics the task handed this milestone
 * for provenance-validation purposes only (task section 22).
 */

export const PROPOSAL_STATUS_NOT_FOR_IMPORT = 'PROPOSAL_NOT_FOR_IMPORT';

export interface ProposedDraftCalendarFact {
  readonly tradingDate: string;
  /** The FINAL/authoritative raw-source references that would back this fact if imported -- withdrawn/superseded predecessors are deliberately excluded here (see `historicalReferences`). */
  readonly supportingReferences: readonly string[];
  /** Withdrawn/superseded predecessor references retained for audit trail only -- never proposed as import-time provenance. */
  readonly historicalReferences: readonly string[];
}

export interface ProposedDraftSpecialSessionFact extends ProposedDraftCalendarFact {
  readonly windows: readonly { readonly openMinuteIst: number; readonly closeMinuteIst: number }[];
}

export interface Proposed2024DraftCalendarMappingOutline {
  readonly proposalStatus: typeof PROPOSAL_STATUS_NOT_FOR_IMPORT;
  readonly exchange: 'NSE';
  readonly calendarYear: 2024;
  readonly annualHolidays: readonly ProposedDraftCalendarFact[];
  readonly exceptionalClosures: readonly ProposedDraftCalendarFact[];
  readonly specialSessions: readonly ProposedDraftSpecialSessionFact[];
  readonly generationNote: string;
}

/** Task section 22's accepted 2024 EXCHANGE_HOLIDAY dates -- provenance-validation context only, never activated here. */
const ACCEPTED_2024_ANNUAL_HOLIDAYS: readonly string[] = [
  '2024-01-26',
  '2024-03-08',
  '2024-03-25',
  '2024-03-29',
  '2024-04-11',
  '2024-04-17',
  '2024-05-01',
  '2024-06-17',
  '2024-07-17',
  '2024-08-15',
  '2024-10-02',
  '2024-11-15',
  '2024-12-25',
];

const ACCEPTED_2024_EXCEPTIONAL_CLOSURES: readonly { readonly tradingDate: string; readonly supportingReferences: readonly string[] }[] = [
  { tradingDate: '2024-01-22', supportingReferences: ['NSE/CMTR/60338', 'NSE/FAOP/60337'] },
  { tradingDate: '2024-05-20', supportingReferences: ['NSE/CMTR/61518', 'NSE/FAOP/61517'] },
  { tradingDate: '2024-11-20', supportingReferences: ['NSE/CMTR/64960', 'NSE/FAOP/64959'] },
];

const ACCEPTED_2024_SPECIAL_SESSIONS: readonly {
  readonly tradingDate: string;
  readonly supportingReferences: readonly string[];
  readonly historicalReferences: readonly string[];
  readonly windows: readonly { readonly openMinuteIst: number; readonly closeMinuteIst: number }[];
}[] = [
  {
    tradingDate: '2024-01-20',
    supportingReferences: ['NSE/MSD/60340'],
    historicalReferences: ['NSE/MSD/59999', 'NSE/MSD/60300', 'NSE/MSD/60318'],
    windows: [{ openMinuteIst: 555, closeMinuteIst: 930 }], // 09:15-15:30
  },
  {
    tradingDate: '2024-03-02',
    supportingReferences: ['NSE/MSD/60677'],
    historicalReferences: [],
    windows: [
      { openMinuteIst: 555, closeMinuteIst: 600 }, // 09:15-10:00
      { openMinuteIst: 690, closeMinuteIst: 750 }, // 11:30-12:30
    ],
  },
  {
    tradingDate: '2024-05-18',
    supportingReferences: ['NSE/MSD/61893'],
    historicalReferences: [],
    windows: [
      { openMinuteIst: 555, closeMinuteIst: 600 }, // 09:15-10:00
      { openMinuteIst: 690, closeMinuteIst: 750 }, // 11:30-12:30
    ],
  },
  {
    tradingDate: '2024-11-01',
    supportingReferences: ['NSE/CMTR/64628', 'NSE/FAOP/64630'],
    historicalReferences: [],
    windows: [{ openMinuteIst: 1080, closeMinuteIst: 1140 }], // 18:00-19:00
  },
];

/**
 * Builds the DRAFT proposal from `manifest` -- fails closed if any reference
 * the proposal wants to cite is missing from the manifest, or if a cited
 * "supporting" reference is not actually `FINAL` in the manifest's own
 * lifecycle graph (a withdrawn/superseded document must never be proposed as
 * live provenance). Pure/synchronous; performs no I/O and calls no
 * repository/import/certification path (task section 16).
 */
export function buildProposed2024DraftCalendarMappingOutline(manifest: ReviewedRawSourceManifest): Proposed2024DraftCalendarMappingOutline {
  const byReference = new Map(manifest.entries.map((entry) => [entry.reference, entry]));

  const assertFinalReferences = (references: readonly string[]): void => {
    for (const reference of references) {
      const entry = byReference.get(reference);
      if (entry === undefined) {
        throw new Error(`Proposed draft mapping cites reference '${reference}', which is not present in the supplied manifest.`);
      }
      if (entry.lifecycleStatus !== RawSourceLifecycleStatus.FINAL) {
        throw new Error(`Proposed draft mapping cites '${reference}' as authoritative supporting evidence, but its manifest lifecycleStatus is '${entry.lifecycleStatus}', not FINAL.`);
      }
    }
  };

  const annualHolidays: ProposedDraftCalendarFact[] = ACCEPTED_2024_ANNUAL_HOLIDAYS.map((tradingDate) => {
    const supportingReferences = ['NSE/CMTR/59722', 'NSE/FAOP/59723'];
    assertFinalReferences(supportingReferences);
    return { tradingDate, supportingReferences, historicalReferences: [] };
  });

  const exceptionalClosures: ProposedDraftCalendarFact[] = ACCEPTED_2024_EXCEPTIONAL_CLOSURES.map((closure) => {
    assertFinalReferences(closure.supportingReferences);
    return { tradingDate: closure.tradingDate, supportingReferences: closure.supportingReferences, historicalReferences: [] };
  });

  const specialSessions: ProposedDraftSpecialSessionFact[] = ACCEPTED_2024_SPECIAL_SESSIONS.map((session) => {
    assertFinalReferences(session.supportingReferences);
    return {
      tradingDate: session.tradingDate,
      supportingReferences: session.supportingReferences,
      historicalReferences: session.historicalReferences,
      windows: session.windows,
    };
  });

  return {
    proposalStatus: PROPOSAL_STATUS_NOT_FOR_IMPORT,
    exchange: 'NSE',
    calendarYear: 2024,
    annualHolidays,
    exceptionalClosures,
    specialSessions,
    generationNote:
      'PROPOSAL ONLY -- not an ExchangeCalendarCoverageFixture, never passed to validateAndNormalizeCoverageFixture/ExchangeCalendarImporterService/ExchangeCalendarRepository.importDraftFixture. For human review ahead of a future, separate DRAFT fixture-import milestone.',
  };
}
