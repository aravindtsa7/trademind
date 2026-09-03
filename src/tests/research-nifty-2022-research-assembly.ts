import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import NiftyUnderlyingResearchAssemblyService, { NiftyUnderlyingResearchAssemblyResult } from '../modules/research-lake/services/nifty-underlying-research-assembly.service';

dotenv.config();
logger.silent = true;

/**
 * B-M7.2 operator runner: assembles the deterministic NIFTY underlying
 * research-layer overlay for one locked year (2022). This script is
 * DELIBERATELY narrow -- no argv/env flag exists to change instrument,
 * timeframe, or year (`LOCKED_YEAR` below is the only value ever passed).
 *
 * Unlike the B-M7.1 March-7 capture runner, this script needs NO operator
 * confirmation interlock: it makes ZERO provider calls and ZERO database
 * writes. Every operation is either a read-only reconstruction from the
 * already-persisted canonical store (the SAME thing `research:manifest:generate`
 * already does) or an idempotent, content-addressed write of this
 * milestone's own new research-assembly artifact -- never a canonical
 * mutation, never a repeat of the B-M7.1 capture.
 *
 * BLOCKER-04 CORRECTION: this runner now builds the assembly WITHOUT
 * persisting it, independently validates a fixed set of locked production
 * postconditions against the in-memory result, and ONLY THEN persists the
 * trusted content-addressed artifact. An incomplete/incorrect 2022 assembly
 * (wrong session count, any unavailable session, a missing/extra/wrong
 * authorized-derived date, wrong instrument/timeframe/year) is therefore
 * NEVER written into the trusted B-M7.2 artifact directory, and the CLI
 * never prints SUCCESS for it.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation:
 *   npm run research:nifty-2022:assemble
 */

const LOCKED_YEAR = 2022;
const EXPECTED_SESSIONS = 248;
const EXPECTED_AUTHORIZED_DERIVED_SESSIONS = 1;
const EXPECTED_DERIVED_TRADING_DATES: readonly string[] = ['2022-03-07'];

/** The exact service surface this CLI needs -- `assembleYear` (never persists on its own here) plus the separate `persistAssembly` step BLOCKER-04 introduced. */
export type AssembleAndPersistNiftyUnderlyingResearchAssembly = Pick<NiftyUnderlyingResearchAssemblyService, 'assembleYear' | 'persistAssembly'>;

export interface RunNifty2022ResearchAssemblyOptions {
  readonly buildService: () => AssembleAndPersistNiftyUnderlyingResearchAssembly;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * BLOCKER-04: the ONE locked production postcondition gate for the 2022
 * NIFTY/1minute assembly -- every field checked here is exactly what the
 * task's locked production conditions require. Deliberately hardcodes
 * 248/1/'2022-03-07' -- acceptable and REQUIRED at this operator
 * postcondition boundary (never inside the core `selectResearchSessionSource`/
 * `NiftyUnderlyingResearchAssemblyService` algorithm, which never hardcodes a
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
  if (sessionCounts.unavailableSessions !== 0) {
    return { code: 'UNAVAILABLE_SESSIONS_PRESENT', message: `expected 0 unavailable sessions, got ${sessionCounts.unavailableSessions}` };
  }
  if (sessionCounts.researchReadySessions !== EXPECTED_SESSIONS) {
    return { code: 'INCOMPLETE_RESEARCH_READY_SESSIONS', message: `expected all ${EXPECTED_SESSIONS} sessions research-ready, got ${sessionCounts.researchReadySessions}` };
  }
  if (sessionCounts.authorizedDerivedSessions !== EXPECTED_AUTHORIZED_DERIVED_SESSIONS) {
    return { code: 'WRONG_AUTHORIZED_DERIVED_SESSION_COUNT', message: `expected exactly ${EXPECTED_AUTHORIZED_DERIVED_SESSIONS} authorized derived session(s), got ${sessionCounts.authorizedDerivedSessions}` };
  }

  const tierSum = sessionCounts.realCanonicalSessions + sessionCounts.compositeRepairedSessions + sessionCounts.authorizedDerivedSessions + sessionCounts.unavailableSessions;
  if (tierSum !== sessionCounts.expectedSessions) {
    return { code: 'SESSION_COUNT_TIER_SUM_MISMATCH', message: `per-tier counts sum to ${tierSum}, expected ${sessionCounts.expectedSessions}` };
  }

  const derivedTradingDates = sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION)
    .map((session) => session.tradingDate)
    .sort();
  const expectedSorted = [...EXPECTED_DERIVED_TRADING_DATES].sort();
  const derivedTradingDatesMatch = derivedTradingDates.length === expectedSorted.length && derivedTradingDates.every((date, index) => date === expectedSorted[index]);
  if (!derivedTradingDatesMatch) {
    return { code: 'WRONG_DERIVED_TRADING_DATES', message: `expected authorized derived trading date(s) [${expectedSorted.join(',')}], got [${derivedTradingDates.join(',')}]` };
  }

  return null;
}

/**
 * Returns `true` only on a fully-completed, postcondition-validated, and
 * persisted assembly; `false` on any failure. Never throws -- every failure
 * (invariant violation, evidence-qualification-shaped error, trusted-derived-
 * artifact integrity failure, a failed locked postcondition, a persistence
 * error, an unexpected error) is caught and reported through `errorOutput`,
 * so a caller sets `process.exitCode` from the boolean alone. The trusted
 * B-M7.2 artifact is written ONLY after every postcondition below passes
 * (BLOCKER-04) -- never before, and never at all on any failure path.
 */
export async function runNifty2022ResearchAssembly(options: RunNifty2022ResearchAssemblyOptions): Promise<boolean> {
  const { buildService, output, errorOutput } = options;
  const service = buildService();

  let result: NiftyUnderlyingResearchAssemblyResult;
  try {
    result = await service.assembleYear({ year: LOCKED_YEAR });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M7_2_2022_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=ASSEMBLY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.assembly);
  if (postconditionFailure) {
    errorOutput(['[B_M7_2_2022_RESEARCH_ASSEMBLY]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  let assemblyStorage: ContentAddressedJsonStoreResult;
  try {
    assemblyStorage = service.persistAssembly(result.assembly);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M7_2_2022_RESEARCH_ASSEMBLY]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
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
    '[B_M7_2_2022_RESEARCH_ASSEMBLY]',
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
  const success = await runNifty2022ResearchAssembly({
    // BLOCKER-04: `persistArtifactsToDisk: false` -- `assembleYear` builds the
    // assembly in-memory only; this runner persists it itself, ONLY after
    // `validateLockedProductionPostconditions` passes.
    buildService: () => new NiftyUnderlyingResearchAssemblyService({ persistArtifactsToDisk: false }),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M7_2_2022_RESEARCH_ASSEMBLY] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
