import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import NiftyUnderlyingResearchAssemblyService, { NiftyUnderlyingResearchAssemblyResult, RequestedSessionsResolver } from '../modules/research-lake/services/nifty-underlying-research-assembly.service';
import ManifestCalendarSessionResolverService, { ManifestRequestedSessions } from '../modules/research-lake/services/manifest-calendar-session-resolver.service';

dotenv.config();
logger.silent = true;

/**
 * B-M9 operator runner: assembles the deterministic NIFTY underlying
 * research-layer overlay for locked year 2023 -- a CLEAN canonical year
 * (the real controlled 2023 acquisition already completed with 100%
 * real-canonical, complete sessions; zero composite-repaired, zero
 * authorized-derived, zero unavailable). DELIBERATELY narrow, mirroring the
 * 2022 assembly runner exactly -- no argv/env flag exists to change
 * instrument, timeframe, or year. Reuses `NiftyUnderlyingResearchAssemblyService`
 * unmodified -- no second source-selection algorithm.
 *
 * Zero provider calls, zero database writes. Every operation is either a
 * read-only reconstruction from the already-persisted canonical store or an
 * idempotent, content-addressed write of this milestone's own research-
 * assembly artifact.
 *
 * Builds the assembly WITHOUT persisting it, independently validates a fixed
 * set of locked production postconditions against the in-memory result, and
 * ONLY THEN persists the trusted content-addressed artifact -- mirroring the
 * 2022 BLOCKER-04 discipline. Unlike 2022, 2023's postconditions assert ALL
 * FOUR per-tier counts explicitly (realCanonicalSessions/compositeRepaired/
 * authorizedDerived/unavailable) so the wrapper fails closed if ANY source
 * unexpectedly becomes tier2/tier3/unavailable, not merely if the tier sum
 * happens to still add up.
 *
 * TERRA BLOCKER CORRECTION: the per-tier COUNT postconditions above are
 * necessary but not sufficient -- a forged/incorrect assembly can contain
 * entirely wrong trading dates (e.g. dates from an unrelated year) while
 * still summing to the right per-tier counts. This runner therefore ALSO
 * independently re-derives the exact certified 2023 trading-date set from
 * `ManifestCalendarSessionResolverService` (the SAME authoritative
 * calendar/session source `NiftyUnderlyingResearchAssemblyService` itself
 * consults internally -- never a second parallel calendar model) and
 * requires exact set equality against the assembly's own session dates
 * BEFORE persistence. This is a defense-in-depth check: it holds even if the
 * injected `buildService` result did not, for whatever reason, actually come
 * from a calendar-correct `assembleYear` call.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation:
 *   npm run research:nifty-2023:assemble
 */

const LOCKED_YEAR = 2023;
const EXPECTED_SESSIONS = 246;
const EXPECTED_REAL_CANONICAL_SESSIONS = 246;
const EXPECTED_COMPOSITE_REPAIRED_SESSIONS = 0;
const EXPECTED_AUTHORIZED_DERIVED_SESSIONS = 0;
const EXPECTED_UNAVAILABLE_SESSIONS = 0;
const EXPECTED_DERIVED_TRADING_DATES: readonly string[] = [];

/** Certified 2023 special session (task-locked fact, cross-checked against the authoritative NSE/EQUITY fixture): Diwali Muhurat trading, 18:15-19:15 IST. */
const MUHURAT_DATE = '2023-11-12';
const MUHURAT_OPEN_MINUTE_IST = 1095; // 18:15 IST, inclusive
const MUHURAT_CLOSE_MINUTE_IST = 1155; // 19:15 IST, exclusive

/** The exact service surface this CLI needs -- `assembleYear` (never persists on its own here) plus the separate `persistAssembly` step, mirroring the 2022 runner. */
export type AssembleAndPersistNiftyUnderlyingResearchAssembly = Pick<NiftyUnderlyingResearchAssemblyService, 'assembleYear' | 'persistAssembly'>;

export interface RunNifty2023ResearchAssemblyOptions {
  readonly buildService: () => AssembleAndPersistNiftyUnderlyingResearchAssembly;
  /** TERRA BLOCKER CORRECTION: builds the independent certified-calendar dependency used ONLY for the exact-date-set postcondition below -- never for building the assembly itself. */
  readonly buildCalendarSessionResolverService: () => RequestedSessionsResolver;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The ONE locked production postcondition gate for the 2023 NIFTY/1minute
 * clean-canonical-year assembly. Deliberately hardcodes 246/0/0/0/[] --
 * acceptable and REQUIRED at this operator postcondition boundary (never
 * inside `NiftyUnderlyingResearchAssemblyService`, which never hardcodes a
 * session count).
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
  // Unlike the 2022 CLI (which only asserts unavailable=0/derived=1/tierSum), 2023 asserts ALL FOUR
  // per-tier counts explicitly -- this MUST fail closed if any source unexpectedly becomes
  // tier2 (composite-repaired) or tier3 (authorized-derived), not merely if the sum still adds up.
  // The most SPECIFIC/actionable diagnostic (which tier unexpectedly gained a session) is checked
  // BEFORE the aggregate realCanonicalSessions count, since -- given a fixed EXPECTED_SESSIONS total --
  // any single unexpected tier2/tier3/unavailable session necessarily also depresses
  // realCanonicalSessions below 246; reporting the specific tier first is far more actionable for an
  // operator than a generic "wrong real-canonical count".
  if (sessionCounts.unavailableSessions !== EXPECTED_UNAVAILABLE_SESSIONS) {
    return { code: 'UNAVAILABLE_SESSIONS_PRESENT', message: `expected 0 unavailable sessions, got ${sessionCounts.unavailableSessions}` };
  }
  if (sessionCounts.compositeRepairedSessions !== EXPECTED_COMPOSITE_REPAIRED_SESSIONS) {
    return { code: 'UNEXPECTED_COMPOSITE_REPAIRED_SESSIONS', message: `expected 0 composite-repaired sessions for a clean canonical year, got ${sessionCounts.compositeRepairedSessions}` };
  }
  if (sessionCounts.authorizedDerivedSessions !== EXPECTED_AUTHORIZED_DERIVED_SESSIONS) {
    return { code: 'UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS', message: `expected 0 authorized-derived sessions for a clean canonical year, got ${sessionCounts.authorizedDerivedSessions}` };
  }
  if (sessionCounts.realCanonicalSessions !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_SESSION_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} real-canonical sessions, got ${sessionCounts.realCanonicalSessions}` };
  }

  const tierSum = sessionCounts.realCanonicalSessions + sessionCounts.compositeRepairedSessions + sessionCounts.authorizedDerivedSessions + sessionCounts.unavailableSessions;
  if (tierSum !== sessionCounts.expectedSessions) {
    return { code: 'SESSION_COUNT_TIER_SUM_MISMATCH', message: `per-tier counts sum to ${tierSum}, expected ${sessionCounts.expectedSessions}` };
  }

  const derivedTradingDates = sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION)
    .map((session) => session.tradingDate)
    .sort();
  if (derivedTradingDates.length !== EXPECTED_DERIVED_TRADING_DATES.length) {
    return { code: 'WRONG_DERIVED_TRADING_DATES', message: `expected zero authorized-derived trading dates, got [${derivedTradingDates.join(',')}]` };
  }

  const nonRealCanonicalDates = sessions.filter((session) => session.precedenceTier !== ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION).map((session) => session.tradingDate);
  if (nonRealCanonicalDates.length > 0) {
    return { code: 'NON_REAL_CANONICAL_SESSION_PRESENT', message: `expected every selected 2023 date to be real canonical, found non-real-canonical date(s): [${nonRealCanonicalDates.join(',')}]` };
  }

  return null;
}

/**
 * TERRA BLOCKER CORRECTION: `validateLockedProductionPostconditions` above
 * only checks aggregate per-tier COUNTS, which a wrong-but-count-matching
 * date set can still satisfy (the exact bypass Terra reproduced: 245
 * unrelated dates + the Muhurat date, all real-canonical). This function
 * closes that gap by requiring EXACT set equality between the assembly's own
 * trading dates and the certified 2023 trading-date set independently
 * resolved from `certified` (built from `ManifestCalendarSessionResolverService`,
 * the same authoritative calendar source `NiftyUnderlyingResearchAssemblyService`
 * itself already consults -- never a second, parallel calendar model).
 *
 * Also enforces the certified 2023 Muhurat special session specifically
 * (task-locked facts): it must be present, and the INDEPENDENTLY-resolved
 * certified session window for it must be exactly the 18:15-19:15 IST
 * Muhurat window (a sanity check on the calendar source itself, not merely
 * the assembly). A separate "Muhurat session must be real-canonical" check
 * is deliberately NOT duplicated here: `validateLockedProductionPostconditions`
 * already ran first and requires realCanonicalSessions === EXPECTED_SESSIONS
 * === total session count, so by the time this function runs every session
 * -- Muhurat included -- is already guaranteed real-canonical; re-asserting
 * that here would be dead code.
 */
function validateCertifiedDateSetPostcondition(assembly: ResearchUnderlyingDatasetAssemblyV1, certified: ManifestRequestedSessions): PostconditionFailure | null {
  const certifiedDates = certified.tradingDates;
  if (certifiedDates.length !== EXPECTED_SESSIONS) {
    return {
      code: 'CERTIFIED_CALENDAR_SESSION_COUNT_MISMATCH',
      message: `the certified ${LOCKED_YEAR} calendar itself resolved ${certifiedDates.length} trading date(s), expected exactly ${EXPECTED_SESSIONS} -- refusing to validate the assembly against a calendar source that disagrees with the locked 2023 topology`,
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

  // At this point the assembly has exactly EXPECTED_SESSIONS unique trading dates, none
  // missing from and none extraneous to the EXPECTED_SESSIONS-sized certified set -- true
  // set equality (assemblyDates.length === certifiedDates.length === |certifiedDateSet|,
  // no duplicates, assemblyDates subset-of certifiedDateSet, certifiedDateSet subset-of assemblyDates).

  const hasMuhuratSession = assembly.sessions.some((session) => session.tradingDate === MUHURAT_DATE);
  if (!hasMuhuratSession) {
    return { code: 'MISSING_MUHURAT_SESSION', message: `certified special session '${MUHURAT_DATE}' is absent from the assembly` };
  }

  const muhuratWindows = certified.calendarSessionWindows[MUHURAT_DATE] ?? [];
  const isLockedMuhuratWindow = muhuratWindows.length === 1 && muhuratWindows[0].openMinuteIst === MUHURAT_OPEN_MINUTE_IST && muhuratWindows[0].closeMinuteIst === MUHURAT_CLOSE_MINUTE_IST;
  if (!isLockedMuhuratWindow) {
    return {
      code: 'MUHURAT_WINDOW_MISMATCH',
      message: `certified session window(s) for '${MUHURAT_DATE}' do not match the locked Muhurat window [${MUHURAT_OPEN_MINUTE_IST},${MUHURAT_CLOSE_MINUTE_IST}); got ${JSON.stringify(muhuratWindows)}`,
    };
  }

  return null;
}

/**
 * Returns `true` only on a fully-completed, postcondition-validated, and
 * persisted assembly; `false` on any failure. Never throws -- every failure
 * is caught and reported through `errorOutput`. The trusted B-M7.2-shaped
 * artifact is written ONLY after every postcondition below passes.
 */
export async function runNifty2023ResearchAssembly(options: RunNifty2023ResearchAssemblyOptions): Promise<boolean> {
  const { buildService, buildCalendarSessionResolverService, output, errorOutput } = options;
  const service = buildService();

  let result: NiftyUnderlyingResearchAssemblyResult;
  try {
    result = await service.assembleYear({ year: LOCKED_YEAR });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=ASSEMBLY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.assembly);
  if (postconditionFailure) {
    errorOutput(['[B_M9_2023_RESEARCH_ASSEMBLY]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  // TERRA BLOCKER CORRECTION: independently re-derive the certified 2023 trading-date
  // set and require exact set equality BEFORE persistence -- see
  // `validateCertifiedDateSetPostcondition`'s doc for why the count-only checks above
  // are not sufficient on their own.
  const calendarSessionResolverService = buildCalendarSessionResolverService();
  let certified: ManifestRequestedSessions;
  try {
    certified = await calendarSessionResolverService.resolveRequestedSessions({ fromDate: `${LOCKED_YEAR}-01-01`, toDate: `${LOCKED_YEAR}-12-31` });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=CERTIFIED_CALENDAR_RESOLUTION_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const dateSetFailure = validateCertifiedDateSetPostcondition(result.assembly, certified);
  if (dateSetFailure) {
    errorOutput(['[B_M9_2023_RESEARCH_ASSEMBLY]', 'status=FAILED', `code=${dateSetFailure.code}`, `message=${dateSetFailure.message}`].join('\n'));
    return false;
  }

  let assemblyStorage: ContentAddressedJsonStoreResult;
  try {
    assemblyStorage = service.persistAssembly(result.assembly);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
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
  return [
    '[B_M9_2023_RESEARCH_ASSEMBLY]',
    'status=SUCCESS',
    `instrument=${assembly.identity.instrumentKey}`,
    `timeframe=${assembly.identity.timeframe}`,
    `year=${assembly.identity.year}`,
    `expectedSessions=${assembly.sessionCounts.expectedSessions}`,
    `researchReadySessions=${assembly.sessionCounts.researchReadySessions}`,
    `realCanonicalSessions=${assembly.sessionCounts.realCanonicalSessions}`,
    `compositeRepairedSessions=${assembly.sessionCounts.compositeRepairedSessions}`,
    `authorizedDerivedSessions=${assembly.sessionCounts.authorizedDerivedSessions}`,
    `unavailableSessions=${assembly.sessionCounts.unavailableSessions}`,
    `derivedTradingDates=${derivedTradingDates || 'NONE'}`,
    `canonicalManifestChecksum=${assembly.canonicalManifest.datasetChecksum}`,
    `researchAssemblyChecksum=${assembly.assemblyContentChecksum}`,
    `researchAssemblyArtifact=${describeStorage(assemblyStorage)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2023ResearchAssembly({
    // `persistArtifactsToDisk: false` -- `assembleYear` builds the assembly in-memory only; this runner
    // persists it itself, ONLY after both `validateLockedProductionPostconditions` and
    // `validateCertifiedDateSetPostcondition` pass.
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
    console.error('[B_M9_2023_RESEARCH_ASSEMBLY] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
