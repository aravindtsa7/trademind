import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { SessionWindow } from '../modules/research-lake/domain/exchange-calendar.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import NiftyUnderlyingResearchAssemblyService, { NiftyUnderlyingResearchAssemblyResult, RequestedSessionsResolver } from '../modules/research-lake/services/nifty-underlying-research-assembly.service';
import ManifestCalendarSessionResolverService, { ManifestRequestedSessions } from '../modules/research-lake/services/manifest-calendar-session-resolver.service';

dotenv.config();
logger.silent = true;

/**
 * B-M11 operator runner: assembles the deterministic NIFTY underlying
 * research-layer overlay for locked year 2025. UNLIKE 2024 (exactly ONE
 * composite-repaired session), 2025 carries exactly THREE controlled,
 * reviewed composite-repaired canonical sessions -- 2025-03-25, 2025-04-04,
 * 2025-04-23 -- each accepted through the existing
 * `NiftyUnderlyingGapRepairService` composite-repair path (the same 2025-03-25
 * repair the B-M11 Groww null-volume correction unblocked) and now verified
 * 375/375 in the canonical store. This CLI does NOT hardcode an assumption
 * that all 249 sessions are pure primary -- it asserts the exact expected
 * per-tier topology (246 real-canonical / 3 composite-repaired / 0
 * authorized-derived / 0 unavailable) and independently pins the composite-
 * repaired trading-date SET to exactly those three dates, failing closed if
 * any OTHER date unexpectedly appears in that tier, or if the count is off
 * by even one. Reuses `NiftyUnderlyingResearchAssemblyService` unmodified --
 * no second source-selection algorithm; the actual tier classification for
 * each repaired date comes entirely from the existing, already-reviewed
 * `selectResearchSessionSource` composite-repair precedence path.
 *
 * Zero provider calls, zero database writes. Every operation is either a
 * read-only reconstruction from the already-persisted canonical store or an
 * idempotent, content-addressed write of this milestone's own research-
 * assembly artifact.
 *
 * Builds the assembly WITHOUT persisting it, independently validates a fixed
 * set of locked production postconditions against the in-memory result, and
 * ONLY THEN persists the trusted content-addressed artifact -- mirroring the
 * 2022/2023/2024 BLOCKER-04 discipline.
 *
 * TERRA BLOCKER CORRECTION (carried forward from 2023/2024): per-tier COUNT
 * postconditions alone are necessary but not sufficient -- a forged/incorrect
 * assembly can contain entirely wrong trading dates while still summing to
 * the right per-tier counts. This runner therefore ALSO independently
 * re-derives the exact certified 2025 trading-date set from
 * `ManifestCalendarSessionResolverService` (the SAME authoritative
 * calendar/session source `NiftyUnderlyingResearchAssemblyService` itself
 * consults internally -- never a second parallel calendar model) and
 * requires exact set equality against the assembly's own session dates
 * BEFORE persistence, plus exact window validation for both certified 2025
 * special sessions (2025-02-01 Union Budget session, 2025-10-21 Diwali
 * Muhurat), using the authoritative calendar resolver rather than inventing
 * windows.
 *
 * Usage (PowerShell), once reviewed:
 *   npm run research:nifty-2025:assemble
 */

const LOCKED_YEAR = 2025;
const EXPECTED_SESSIONS = 249;
const EXPECTED_REAL_CANONICAL_SESSIONS = 246;
const EXPECTED_COMPOSITE_REPAIRED_SESSIONS = 3;
const EXPECTED_AUTHORIZED_DERIVED_SESSIONS = 0;
const EXPECTED_UNAVAILABLE_SESSIONS = 0;
const EXPECTED_DERIVED_TRADING_DATES: readonly string[] = [];
/** The three controlled, reviewed 2025 composite repairs (task-locked facts), each now 375/375 REPAIR_ACCEPTED. */
const EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];

/** Certified 2025 special sessions (task-locked facts, cross-checked against the authoritative NSE/EQUITY fixture). */
const FEB1_DATE = '2025-02-01';
const FEB1_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 555, closeMinuteIst: 930 }];
const OCT21_DATE = '2025-10-21';
const OCT21_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 825, closeMinuteIst: 885 }];

interface LockedSpecialSession {
  readonly date: string;
  readonly windows: readonly { readonly openMinuteIst: number; readonly closeMinuteIst: number }[];
  readonly missingCode: string;
  readonly windowMismatchCode: string;
}

/** Both certified 2025 special sessions -- every one must be present in the assembly AND independently resolve to exactly these certified calendar windows. */
const LOCKED_SPECIAL_SESSIONS: readonly LockedSpecialSession[] = [
  { date: FEB1_DATE, windows: FEB1_WINDOWS, missingCode: 'MISSING_FEB1_SPECIAL_SESSION', windowMismatchCode: 'FEB1_WINDOW_MISMATCH' },
  { date: OCT21_DATE, windows: OCT21_WINDOWS, missingCode: 'MISSING_OCT21_MUHURAT_SESSION', windowMismatchCode: 'OCT21_WINDOW_MISMATCH' },
];

/** The exact service surface this CLI needs -- `assembleYear` (never persists on its own here) plus the separate `persistAssembly` step, mirroring the 2022/2023/2024 runners. */
export type AssembleAndPersistNiftyUnderlyingResearchAssembly = Pick<NiftyUnderlyingResearchAssemblyService, 'assembleYear' | 'persistAssembly'>;

export interface RunNifty2025ResearchAssemblyOptions {
  readonly buildService: () => AssembleAndPersistNiftyUnderlyingResearchAssembly;
  /** Builds the independent certified-calendar dependency used ONLY for the exact-date-set postcondition below -- never for building the assembly itself. */
  readonly buildCalendarSessionResolverService: () => RequestedSessionsResolver;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function windowsMatchExpected(actual: readonly SessionWindow[], expected: readonly { openMinuteIst: number; closeMinuteIst: number }[]): boolean {
  if (actual.length !== expected.length) return false;
  const sorted = [...actual].sort((left, right) => left.windowIndex - right.windowIndex);
  return sorted.every((window, index) => window.openMinuteIst === expected[index].openMinuteIst && window.closeMinuteIst === expected[index].closeMinuteIst);
}

/**
 * The ONE locked production postcondition gate for the 2025 NIFTY/1minute
 * research assembly. Deliberately hardcodes 249/246/3/0/0 -- acceptable and
 * REQUIRED at this operator postcondition boundary (never inside
 * `NiftyUnderlyingResearchAssemblyService`, which never hardcodes a session
 * count or tier distribution). Unlike 2023's clean-year gate, this does NOT
 * require zero composite-repaired sessions -- it requires EXACTLY the three
 * controlled, reviewed 2025 repairs, and fails closed if any OTHER date
 * unexpectedly appears as composite-repaired/authorized-derived/unavailable,
 * or if the count is off in either direction.
 */
function validateLockedProductionPostconditions(assembly: ResearchUnderlyingDatasetAssemblyV1): PostconditionFailure | null {
  const { identity, sessionCounts, sessions } = assembly;

  if (identity.instrumentKey !== NIFTY_INDEX_INSTRUMENT_KEY) {
    return { code: 'WRONG_INSTRUMENT', message: `expected instrument '${NIFTY_INDEX_INSTRUMENT_KEY}', got '${identity.instrumentKey}'` };
  }
  if (identity.timeframe !== NIFTY_UNDERLYING_TIMEFRAME) {
    return { code: 'WRONG_TIMEFRAME', message: `expected timeframe '${NIFTY_UNDERLYING_TIMEFRAME}', got '${identity.timeframe}'` };
  }
  if (identity.year !== LOCKED_YEAR) {
    return { code: 'WRONG_YEAR', message: `expected year ${LOCKED_YEAR}, got ${identity.year}` };
  }
  if (sessionCounts.expectedSessions !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_EXPECTED_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} certified ${LOCKED_YEAR} sessions, got ${sessionCounts.expectedSessions}` };
  }
  if (sessionCounts.researchReadySessions !== EXPECTED_SESSIONS) {
    return { code: 'INCOMPLETE_RESEARCH_READY_SESSIONS', message: `expected all ${EXPECTED_SESSIONS} sessions research-ready, got ${sessionCounts.researchReadySessions}` };
  }
  // Most-specific-tier-first ordering (matches the 2023/2024 CLI's convention): given a fixed
  // EXPECTED_SESSIONS total, any single unexpected tier deviation necessarily also depresses
  // realCanonicalSessions, so reporting the specific tier first is more actionable.
  if (sessionCounts.unavailableSessions !== EXPECTED_UNAVAILABLE_SESSIONS) {
    return { code: 'UNAVAILABLE_SESSIONS_PRESENT', message: `expected 0 unavailable sessions, got ${sessionCounts.unavailableSessions}` };
  }
  if (sessionCounts.authorizedDerivedSessions !== EXPECTED_AUTHORIZED_DERIVED_SESSIONS) {
    return { code: 'UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS', message: `expected 0 authorized-derived sessions for 2025, got ${sessionCounts.authorizedDerivedSessions}` };
  }
  if (sessionCounts.compositeRepairedSessions !== EXPECTED_COMPOSITE_REPAIRED_SESSIONS) {
    return { code: 'WRONG_COMPOSITE_REPAIRED_SESSION_COUNT', message: `expected exactly ${EXPECTED_COMPOSITE_REPAIRED_SESSIONS} composite-repaired sessions for 2025 (the reviewed 2025-03-25/2025-04-04/2025-04-23 repairs), got ${sessionCounts.compositeRepairedSessions}` };
  }
  if (sessionCounts.realCanonicalSessions !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_SESSION_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} real-canonical sessions, got ${sessionCounts.realCanonicalSessions}` };
  }

  const tierSum = sessionCounts.realCanonicalSessions + sessionCounts.compositeRepairedSessions + sessionCounts.authorizedDerivedSessions + sessionCounts.unavailableSessions;
  if (tierSum !== sessionCounts.expectedSessions) {
    return { code: 'SESSION_COUNT_TIER_SUM_MISMATCH', message: `per-tier counts sum to ${tierSum}, expected ${sessionCounts.expectedSessions}` };
  }

  const derivedTradingDates = sortedCopy(sessions.filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION).map((session) => session.tradingDate));
  if (!arraysEqual(derivedTradingDates, EXPECTED_DERIVED_TRADING_DATES)) {
    return { code: 'WRONG_DERIVED_TRADING_DATES', message: `expected zero authorized-derived trading dates, got [${derivedTradingDates.join(',')}]` };
  }

  // Never assumes the three composite-repaired dates without checking -- derives them from the
  // assembly's OWN tier classification and requires exact equality against the reviewed date set.
  const compositeRepairedTradingDates = sortedCopy(sessions.filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION).map((session) => session.tradingDate));
  if (!arraysEqual(compositeRepairedTradingDates, sortedCopy(EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES))) {
    return {
      code: 'WRONG_COMPOSITE_REPAIRED_TRADING_DATES',
      message: `expected the composite-repaired trading date set to be exactly [${sortedCopy(EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES).join(',')}], got [${compositeRepairedTradingDates.join(',')}]`,
    };
  }

  const nonQualifyingDates = sessions
    .filter((session) => session.precedenceTier !== ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION && session.precedenceTier !== ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate);
  if (nonQualifyingDates.length > 0) {
    return { code: 'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SESSION_PRESENT', message: `expected every selected 2025 date to be real-canonical or one of the three reviewed composite-repaired dates, found unexpected-tier date(s): [${nonQualifyingDates.join(',')}]` };
  }

  return null;
}

/**
 * TERRA BLOCKER CORRECTION (carried forward from 2023/2024): requires EXACT
 * set equality between the assembly's own trading dates and the certified
 * 2025 trading-date set independently resolved from `certified`, plus exact
 * window validation for both certified 2025 special sessions.
 */
function validateCertifiedDateSetPostcondition(assembly: ResearchUnderlyingDatasetAssemblyV1, certified: ManifestRequestedSessions): PostconditionFailure | null {
  const certifiedDates = certified.tradingDates;
  if (certifiedDates.length !== EXPECTED_SESSIONS) {
    return {
      code: 'CERTIFIED_CALENDAR_SESSION_COUNT_MISMATCH',
      message: `the certified ${LOCKED_YEAR} calendar itself resolved ${certifiedDates.length} trading date(s), expected exactly ${EXPECTED_SESSIONS} -- refusing to validate the assembly against a calendar source that disagrees with the locked 2025 topology`,
    };
  }

  const assemblyDates = assembly.sessions.map((session) => session.tradingDate);
  if (assemblyDates.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_ASSEMBLY_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} assembly session(s), got ${assemblyDates.length}` };
  }

  const seenDates = new Set<string>();
  const duplicateDates = new Set<string>();
  for (const date of assemblyDates) {
    if (seenDates.has(date)) duplicateDates.add(date);
    seenDates.add(date);
  }
  if (duplicateDates.size > 0) {
    return { code: 'DUPLICATE_TRADING_DATE', message: `assembly contains duplicate trading date(s): [${[...duplicateDates].sort().join(',')}]` };
  }

  const certifiedDateSet = new Set(certifiedDates);

  const missingCertifiedDates = certifiedDates.filter((date) => !seenDates.has(date)).sort();
  if (missingCertifiedDates.length > 0) {
    return {
      code: 'MISSING_CERTIFIED_TRADING_DATE',
      message: `assembly is missing ${missingCertifiedDates.length} certified ${LOCKED_YEAR} trading date(s): [${missingCertifiedDates.slice(0, 10).join(',')}${missingCertifiedDates.length > 10 ? ',...' : ''}]`,
    };
  }

  const unexpectedDates = assemblyDates.filter((date) => !certifiedDateSet.has(date)).sort();
  if (unexpectedDates.length > 0) {
    return {
      code: 'UNEXPECTED_TRADING_DATE',
      message: `assembly contains ${unexpectedDates.length} trading date(s) absent from the certified ${LOCKED_YEAR} calendar: [${unexpectedDates.slice(0, 10).join(',')}${unexpectedDates.length > 10 ? ',...' : ''}]`,
    };
  }

  // At this point the assembly has exactly EXPECTED_SESSIONS unique trading dates, in true set
  // equality with the EXPECTED_SESSIONS-sized certified set.

  for (const special of LOCKED_SPECIAL_SESSIONS) {
    const hasSession = assembly.sessions.some((session) => session.tradingDate === special.date);
    if (!hasSession) {
      return { code: special.missingCode, message: `certified special session '${special.date}' is absent from the assembly` };
    }
    const windows = certified.calendarSessionWindows[special.date] ?? [];
    if (!windowsMatchExpected(windows, special.windows)) {
      return {
        code: special.windowMismatchCode,
        message: `certified session window(s) for '${special.date}' do not match the locked window(s) ${JSON.stringify(special.windows)}; got ${JSON.stringify(windows)}`,
      };
    }
  }

  return null;
}

/**
 * Returns `true` only on a fully-completed, postcondition-validated, and
 * persisted assembly; `false` on any failure. Never throws -- every failure
 * is caught and reported through `errorOutput`. The trusted B-M7.2-shaped
 * artifact is written ONLY after every postcondition below passes.
 */
export async function runNifty2025ResearchAssembly(options: RunNifty2025ResearchAssemblyOptions): Promise<boolean> {
  const { buildService, buildCalendarSessionResolverService, output, errorOutput } = options;
  const service = buildService();

  let result: NiftyUnderlyingResearchAssemblyResult;
  try {
    result = await service.assembleYear({ year: LOCKED_YEAR });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=ASSEMBLY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.assembly);
  if (postconditionFailure) {
    errorOutput(['[B_M11_2025_RESEARCH_ASSEMBLY]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  const calendarSessionResolverService = buildCalendarSessionResolverService();
  let certified: ManifestRequestedSessions;
  try {
    certified = await calendarSessionResolverService.resolveRequestedSessions({ fromDate: `${LOCKED_YEAR}-01-01`, toDate: `${LOCKED_YEAR}-12-31` });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=CERTIFIED_CALENDAR_RESOLUTION_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const dateSetFailure = validateCertifiedDateSetPostcondition(result.assembly, certified);
  if (dateSetFailure) {
    errorOutput(['[B_M11_2025_RESEARCH_ASSEMBLY]', 'status=FAILED', `code=${dateSetFailure.code}`, `message=${dateSetFailure.message}`].join('\n'));
    return false;
  }

  let assemblyStorage: ContentAddressedJsonStoreResult;
  try {
    assemblyStorage = service.persistAssembly(result.assembly);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result, assemblyStorage));
  return true;
}

function describeStorage(storage: ContentAddressedJsonStoreResult): string {
  return `${storage.relativePath} (wasNewlyWritten=${storage.wasNewlyWritten})`;
}

function formatSuccessOutput(result: NiftyUnderlyingResearchAssemblyResult, assemblyStorage: ContentAddressedJsonStoreResult): string {
  const { assembly } = result;
  const derivedTradingDates = assembly.sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION)
    .map((session) => session.tradingDate)
    .join(',');
  const compositeRepairedTradingDates = assembly.sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .sort()
    .join(',');
  return [
    '[B_M11_2025_RESEARCH_ASSEMBLY]',
    'status=SUCCESS',
    `instrument=${assembly.identity.instrumentKey}`,
    `timeframe=${assembly.identity.timeframe}`,
    `year=${assembly.identity.year}`,
    `expectedSessions=${assembly.sessionCounts.expectedSessions}`,
    `researchReadySessions=${assembly.sessionCounts.researchReadySessions}`,
    `realCanonicalSessions=${assembly.sessionCounts.realCanonicalSessions}`,
    `compositeRepairedSessions=${assembly.sessionCounts.compositeRepairedSessions}`,
    `compositeRepairedTradingDates=${compositeRepairedTradingDates || 'NONE'}`,
    `authorizedDerivedSessions=${assembly.sessionCounts.authorizedDerivedSessions}`,
    `unavailableSessions=${assembly.sessionCounts.unavailableSessions}`,
    `derivedTradingDates=${derivedTradingDates || 'NONE'}`,
    `canonicalManifestChecksum=${assembly.canonicalManifest.datasetChecksum}`,
    `researchAssemblyChecksum=${assembly.assemblyContentChecksum}`,
    `researchAssemblyArtifact=${describeStorage(assemblyStorage)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2025ResearchAssembly({
    // `persistArtifactsToDisk: false` -- `assembleYear` builds the assembly in-memory only; this runner
    // persists it itself, ONLY after both postcondition validations pass.
    buildService: () => new NiftyUnderlyingResearchAssemblyService({ persistArtifactsToDisk: false }),
    // The SAME production calendar resolver `NiftyUnderlyingResearchAssemblyService` itself uses internally --
    // an independent second call for the date-set postcondition, never a different/parallel calendar source.
    buildCalendarSessionResolverService: () => new ManifestCalendarSessionResolverService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M11_2025_RESEARCH_ASSEMBLY] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
