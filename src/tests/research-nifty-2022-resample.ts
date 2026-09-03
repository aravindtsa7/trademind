import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { ResearchResampleSessionStatus } from '../modules/research-lake/domain/research-underlying-resampled-candle.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES, ResearchUnderlyingResamplingManifestV1 } from '../modules/research-lake/domain/research-underlying-resampling-manifest.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import ResearchUnderlyingResamplingManifestBuilderService, { BuildYearResamplingManifestResult } from '../modules/research-lake/services/research-underlying-resampling-manifest-builder.service';
import ResearchUnderlyingResampledSessionReaderService from '../modules/research-lake/services/research-underlying-resampled-session-reader.service';

dotenv.config();
logger.silent = true;

/**
 * B-M7.3 operator runner: resamples the trusted, committed 2022 NIFTY
 * research assembly (B-M7.2) into a provenance-aware, content-addressed
 * 2m/3m/5m research resampling manifest. DELIBERATELY narrow -- no argv/env
 * flag exists to change the source assembly checksum, instrument, timeframe,
 * year, or target set (every locked constant below is the only value ever
 * used).
 *
 * Makes ZERO provider calls and ZERO canonical DB writes. Every operation is
 * either a read-only reconstruction from already-persisted/already-committed
 * content (the trusted B-M7.2 assembly, persisted canonical candles for
 * tier 1/2 dates, the trusted B-M7.1 derived artifact for March-7) or an
 * idempotent, content-addressed write of this milestone's own new
 * resampling-manifest artifact -- never a canonical mutation, never a repeat
 * of the B-M7.1/B-M7.2 capture/assembly work.
 *
 * Builds the manifest WITHOUT persisting it, independently validates a fixed
 * set of locked production postconditions (including the exact March-7
 * no-lookahead availableAt proofs, verified through the SAME verified
 * read boundary a future replay consumer would use), and ONLY THEN persists
 * the trusted content-addressed artifact -- mirroring B-M7.2's BLOCKER-04
 * validate-before-persist discipline exactly.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation:
 *   npm run research:nifty-2022:resample
 */

const LOCKED_YEAR = 2022;
const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const EXPECTED_SESSIONS = 248;
const MARCH_7_DATE = '2022-03-07';
const MARCH_7_DAY_START_MS = new Date(`${MARCH_7_DATE}T00:00:00+05:30`).getTime();

function march7Minute(minuteOfDay: number): Date {
  return new Date(MARCH_7_DAY_START_MS + minuteOfDay * 60_000);
}

/** The exact service surface this CLI needs -- `buildYearManifest` (never persists on its own) plus the separate `persistManifest` step. */
export type BuildAndPersistResamplingManifest = Pick<ResearchUnderlyingResamplingManifestBuilderService, 'buildYearManifest' | 'persistManifest'>;
/** The exact verified read-boundary surface this CLI needs to prove the March-7 no-lookahead postconditions against the SAME path a future replay consumer would use. */
export type VerifyResampledSession = Pick<ResearchUnderlyingResampledSessionReaderService, 'readResampledSession'>;

export interface RunNifty2022ResampleOptions {
  readonly buildService: () => BuildAndPersistResamplingManifest;
  readonly buildVerifier: () => VerifyResampledSession;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The ONE locked production postcondition gate for the 2022 NIFTY/1minute
 * resampling manifest. Deliberately hardcodes 248/2022-03-07/187-125-75 --
 * acceptable and REQUIRED at this operator postcondition boundary (never
 * inside the core `ResearchUnderlyingResamplerService`/
 * `ResearchUnderlyingResamplingManifestBuilderService` algorithms, which
 * never hardcode a session count).
 */
function validateLockedProductionPostconditions(manifest: ResearchUnderlyingResamplingManifestV1): PostconditionFailure | null {
  if (manifest.sourceAssemblyChecksum !== LOCKED_SOURCE_ASSEMBLY_CHECKSUM) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected source assembly checksum '${LOCKED_SOURCE_ASSEMBLY_CHECKSUM}', got '${manifest.sourceAssemblyChecksum}'` };
  }
  if (manifest.identity.instrumentKey !== NIFTY_INDEX_INSTRUMENT_KEY) {
    return { code: 'WRONG_INSTRUMENT', message: `expected instrument '${NIFTY_INDEX_INSTRUMENT_KEY}', got '${manifest.identity.instrumentKey}'` };
  }
  if (manifest.identity.sourceTimeframe !== NIFTY_UNDERLYING_TIMEFRAME) {
    return { code: 'WRONG_TIMEFRAME', message: `expected source timeframe '${NIFTY_UNDERLYING_TIMEFRAME}', got '${manifest.identity.sourceTimeframe}'` };
  }
  if (manifest.identity.year !== LOCKED_YEAR) {
    return { code: 'WRONG_YEAR', message: `expected year ${LOCKED_YEAR}, got ${manifest.identity.year}` };
  }
  if (manifest.sourceSessionCounts.expectedSessions !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_SOURCE_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} certified ${LOCKED_YEAR} source sessions, got ${manifest.sourceSessionCounts.expectedSessions}` };
  }
  if (manifest.sourceSessionCounts.unavailableSessions !== 0) {
    return { code: 'UNAVAILABLE_SESSIONS_PRESENT', message: `expected 0 unavailable source sessions, got ${manifest.sourceSessionCounts.unavailableSessions}` };
  }
  if (manifest.summary.resolvedSessions !== EXPECTED_SESSIONS) {
    return { code: 'INCOMPLETE_RESOLVED_SESSIONS', message: `expected all ${EXPECTED_SESSIONS} sessions resolved, got ${manifest.summary.resolvedSessions}` };
  }

  const targetSet = new Set(manifest.targetTimeframes);
  const targetsMatch = manifest.targetTimeframes.length === RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length && RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.every((target) => targetSet.has(target));
  if (!targetsMatch) {
    return { code: 'WRONG_TARGET_TIMEFRAME_SET', message: `expected targets exactly [${RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.join(',')}], got [${manifest.targetTimeframes.join(',')}]` };
  }

  if (manifest.sessions.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_MANIFEST_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} manifest session entries, got ${manifest.sessions.length}` };
  }
  for (const session of manifest.sessions) {
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      const descriptor = session.targets[target];
      if (!descriptor || descriptor.status !== ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION) {
        return { code: 'INCOMPLETE_SESSION_DESCRIPTOR', message: `tradingDate '${session.tradingDate}' is missing a COMPLETE descriptor for target '${target}'` };
      }
    }
  }

  const march7 = manifest.sessions.find((session) => session.tradingDate === MARCH_7_DATE);
  if (!march7) {
    return { code: 'MARCH7_MISSING', message: `no manifest session entry for '${MARCH_7_DATE}'` };
  }
  const d2 = march7.targets[ResampleTargetTimeframe.TWO_MINUTE];
  const d3 = march7.targets[ResampleTargetTimeframe.THREE_MINUTE];
  const d5 = march7.targets[ResampleTargetTimeframe.FIVE_MINUTE];

  if (d2.sourcePrecedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
    return { code: 'MARCH7_NOT_TIER3', message: `expected March-7 sourcePrecedenceTier AUTHORIZED_DERIVED_IMPUTED_SESSION, got '${String(d2.sourcePrecedenceTier)}'` };
  }
  if (d2.sourceRowCount !== 375) {
    return { code: 'MARCH7_WRONG_SOURCE_ROW_COUNT', message: `expected March-7 sourceRowCount 375, got ${d2.sourceRowCount}` };
  }
  if (d2.derivedImputedConstituentRowCount !== 3) {
    return { code: 'MARCH7_WRONG_IMPUTED_COUNT', message: `expected March-7 derivedImputedConstituentRowCount 3, got ${d2.derivedImputedConstituentRowCount}` };
  }
  if (d2.outputCandleCount !== 187 || d2.structuralTrailingRowCount !== 1 || d2.candlesContainingImputation !== 2) {
    return {
      code: 'MARCH7_WRONG_2M_COUNTS',
      message: `expected March-7 2m outputCandleCount=187/structuralTrailingRowCount=1/candlesContainingImputation=2, got ${d2.outputCandleCount}/${d2.structuralTrailingRowCount}/${d2.candlesContainingImputation}`,
    };
  }
  if (d3.outputCandleCount !== 125 || d3.structuralTrailingRowCount !== 0 || d3.candlesContainingImputation !== 2) {
    return {
      code: 'MARCH7_WRONG_3M_COUNTS',
      message: `expected March-7 3m outputCandleCount=125/structuralTrailingRowCount=0/candlesContainingImputation=2, got ${d3.outputCandleCount}/${d3.structuralTrailingRowCount}/${d3.candlesContainingImputation}`,
    };
  }
  if (d5.outputCandleCount !== 75 || d5.structuralTrailingRowCount !== 0 || d5.candlesContainingImputation !== 1) {
    return {
      code: 'MARCH7_WRONG_5M_COUNTS',
      message: `expected March-7 5m outputCandleCount=75/structuralTrailingRowCount=0/candlesContainingImputation=1, got ${d5.outputCandleCount}/${d5.structuralTrailingRowCount}/${d5.candlesContainingImputation}`,
    };
  }

  return null;
}

/**
 * Re-derives March-7's actual candles through the SAME verified read
 * boundary (`ResearchUnderlyingResampledSessionReaderService`) a future
 * replay consumer would use, and asserts the exact five no-lookahead
 * `availableAt` proofs the task locks in -- catching, in particular, an
 * implementation that incorrectly used "if bucket contains imputation,
 * availableAt=10:26" instead of the required MAX(constituent availableAt)
 * (the March-7 3m 10:24-10:26 bucket, whose correct availableAt is 10:27).
 */
async function validateMarch7NoLookaheadProofs(
  verifier: VerifyResampledSession,
  manifest: ResearchUnderlyingResamplingManifestV1,
  sourceAssembly: BuildYearResamplingManifestResult['sourceAssembly']
): Promise<PostconditionFailure | null> {
  try {
    const twoMin = await verifier.readResampledSession({ manifest, sourceAssembly, tradingDate: MARCH_7_DATE, targetTimeframe: ResampleTargetTimeframe.TWO_MINUTE });
    const bucket2mA = twoMin.candles.find((candle) => candle.bucketStart.getTime() === march7Minute(621).getTime());
    if (!bucket2mA || bucket2mA.availableAt.getTime() !== march7Minute(626).getTime()) {
      return { code: 'MARCH7_2M_10_21_PROOF_FAILED', message: `2m bucket 10:21-10:22 must have availableAt=10:26 IST` };
    }
    const bucket2mB = twoMin.candles.find((candle) => candle.bucketStart.getTime() === march7Minute(623).getTime());
    if (!bucket2mB || bucket2mB.availableAt.getTime() !== march7Minute(626).getTime()) {
      return { code: 'MARCH7_2M_10_23_PROOF_FAILED', message: `2m bucket 10:23-10:24 must have availableAt=10:26 IST` };
    }

    const threeMin = await verifier.readResampledSession({ manifest, sourceAssembly, tradingDate: MARCH_7_DATE, targetTimeframe: ResampleTargetTimeframe.THREE_MINUTE });
    const bucket3mA = threeMin.candles.find((candle) => candle.bucketStart.getTime() === march7Minute(621).getTime());
    if (!bucket3mA || bucket3mA.availableAt.getTime() !== march7Minute(626).getTime()) {
      return { code: 'MARCH7_3M_10_21_PROOF_FAILED', message: `3m bucket 10:21-10:23 must have availableAt=10:26 IST` };
    }
    const bucket3mB = threeMin.candles.find((candle) => candle.bucketStart.getTime() === march7Minute(624).getTime());
    if (!bucket3mB || bucket3mB.availableAt.getTime() !== march7Minute(627).getTime()) {
      return { code: 'MARCH7_3M_10_24_PROOF_FAILED', message: `3m bucket 10:24-10:26 must have availableAt=10:27 IST (MAX of 10:26 imputation delay and 10:27 normal completion), never 10:26` };
    }

    const fiveMin = await verifier.readResampledSession({ manifest, sourceAssembly, tradingDate: MARCH_7_DATE, targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE });
    const bucket5m = fiveMin.candles.find((candle) => candle.bucketStart.getTime() === march7Minute(620).getTime());
    if (!bucket5m || bucket5m.availableAt.getTime() !== march7Minute(626).getTime()) {
      return { code: 'MARCH7_5M_10_20_PROOF_FAILED', message: `5m bucket 10:20-10:24 must have availableAt=10:26 IST` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 'MARCH7_VERIFICATION_FAILED', message };
  }

  return null;
}

/**
 * Returns `true` only on a fully-completed, postcondition-validated,
 * no-lookahead-proof-verified, and persisted manifest; `false` on any
 * failure. Never throws -- every failure is caught and reported through
 * `errorOutput`, so a caller sets `process.exitCode` from the boolean alone.
 * The trusted B-M7.3 manifest is written ONLY after every check below
 * passes -- never before, and never at all on any failure path.
 */
export async function runNifty2022Resample(options: RunNifty2022ResampleOptions): Promise<boolean> {
  const { buildService, buildVerifier, output, errorOutput } = options;
  const service = buildService();

  let result: BuildYearResamplingManifestResult;
  try {
    result = await service.buildYearManifest({ sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M7_3_2022_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=BUILD_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.manifest);
  if (postconditionFailure) {
    errorOutput(['[B_M7_3_2022_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  const verifier = buildVerifier();
  const noLookaheadFailure = await validateMarch7NoLookaheadProofs(verifier, result.manifest, result.sourceAssembly);
  if (noLookaheadFailure) {
    errorOutput(['[B_M7_3_2022_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${noLookaheadFailure.code}`, `message=${noLookaheadFailure.message}`].join('\n'));
    return false;
  }

  let manifestStorage: ContentAddressedJsonStoreResult;
  try {
    manifestStorage = service.persistManifest(result.manifest);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M7_3_2022_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result, manifestStorage));
  return true;
}

function describeStorage(storage: ContentAddressedJsonStoreResult): string {
  return `${storage.relativePath} (wasNewlyWritten=${storage.wasNewlyWritten})`;
}

function formatSuccessOutput(result: BuildYearResamplingManifestResult, manifestStorage: ContentAddressedJsonStoreResult): string {
  const { manifest } = result;
  return [
    '[B_M7_3_2022_RESEARCH_RESAMPLING]',
    'status=SUCCESS',
    `instrument=${manifest.identity.instrumentKey}`,
    `sourceTimeframe=${manifest.identity.sourceTimeframe}`,
    `year=${manifest.identity.year}`,
    `sourceAssemblyChecksum=${manifest.sourceAssemblyChecksum}`,
    `sourceSessions=${manifest.sourceSessionCounts.expectedSessions}`,
    `resolvedSessions=${manifest.summary.resolvedSessions}`,
    `unavailableSessions=${manifest.sourceSessionCounts.unavailableSessions}`,
    `targets=${manifest.targetTimeframes.join(',')}`,
    `manifestContentChecksum=${manifest.manifestContentChecksum}`,
    `manifestArtifact=${describeStorage(manifestStorage)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2022Resample({
    buildService: () => new ResearchUnderlyingResamplingManifestBuilderService(),
    buildVerifier: () => new ResearchUnderlyingResampledSessionReaderService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M7_3_2022_RESEARCH_RESAMPLING] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
