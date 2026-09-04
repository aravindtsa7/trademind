import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { ResearchCandleQuality, ResearchResampleSessionStatus } from '../modules/research-lake/domain/research-underlying-resampled-candle.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES, ResearchUnderlyingResamplingManifestV1 } from '../modules/research-lake/domain/research-underlying-resampling-manifest.types';
import { istMinuteOfDay } from '../modules/research-lake/domain/ist-session-clock';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import ResearchUnderlyingResamplingManifestBuilderService, { BuildYearResamplingManifestResult } from '../modules/research-lake/services/research-underlying-resampling-manifest-builder.service';
import ResearchUnderlyingResampledSessionReaderService from '../modules/research-lake/services/research-underlying-resampled-session-reader.service';

dotenv.config();
logger.silent = true;

/**
 * B-M9 operator runner: resamples the trusted, committed 2023 NIFTY research
 * assembly (B-M7.2-shaped, from `research:nifty-2023:assemble`) into a
 * content-addressed 2m/3m/5m research resampling manifest. Reuses the
 * existing generic `ResearchUnderlyingResamplingManifestBuilderService`/
 * `ResearchUnderlyingResamplerService`/verified resampled reader unmodified
 * -- no second resampling implementation.
 *
 * CHECKSUM HANDOFF (task: "Do NOT invent placeholder checksum constants"):
 * the 2023 research assembly checksum is NOT known until
 * `research:nifty-2023:assemble` has actually been run for real, so -- unlike
 * the 2022 CLI, which hardcodes its already-known, already-committed
 * checksum -- this CLI requires it as an explicit operator input via the
 * narrow, year-specific `RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM`
 * environment variable. The value is format-validated (exactly 64 lowercase
 * hex characters) BEFORE use; the underlying
 * `ResearchUnderlyingResamplingManifestBuilderService`/
 * `readResearchUnderlyingDatasetAssembly` read boundary then independently
 * verifies the referenced assembly artifact exists and is content-addressed-
 * checksum-correct. A missing or malformed value fails closed before any
 * work begins; a well-formed but wrong checksum fails closed via the
 * existing content-addressed read boundary before any write.
 *
 * Zero provider calls, zero canonical DB writes. Builds the manifest WITHOUT
 * persisting it, independently validates a fixed set of locked production
 * postconditions (exact year aggregate totals, the 2023-11-12 Muhurat
 * session's exact 60/30/20/12 shape), independently re-verifies no-lookahead
 * across EVERY (date, target) pair -- 246 x 3 = 738 -- through the SAME
 * verified read boundary a future consumer would use, and ONLY THEN persists
 * the trusted content-addressed artifact.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation AND
 * `research:nifty-2023:assemble` has produced a real researchAssemblyChecksum:
 *   $env:RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2023:resample
 */

const LOCKED_YEAR = 2023;
const EXPECTED_SESSIONS = 246;
const MUHURAT_DATE = '2023-11-12';
const MUHURAT_OPEN_MINUTE_IST = 1095; // 18:15 IST, inclusive
const MUHURAT_CLOSE_MINUTE_IST = 1155; // 19:15 IST, exclusive

const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

const LOCKED_TARGET_TOTALS: Readonly<Record<ResampleTargetTimeframe, { totalOutputCandles: number; totalStructuralTrailingRows: number; totalCandlesContainingImputation: number }>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { totalOutputCandles: 45845, totalStructuralTrailingRows: 245, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { totalOutputCandles: 30645, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { totalOutputCandles: 18387, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
};

const LOCKED_MUHURAT_COUNTS: Readonly<Record<ResampleTargetTimeframe, number>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: 30,
  [ResampleTargetTimeframe.THREE_MINUTE]: 20,
  [ResampleTargetTimeframe.FIVE_MINUTE]: 12,
};

/** The exact service surface this CLI needs -- `buildYearManifest` (never persists on its own) plus the separate `persistManifest` step. */
export type BuildAndPersistResamplingManifest = Pick<ResearchUnderlyingResamplingManifestBuilderService, 'buildYearManifest' | 'persistManifest'>;
/** The exact verified read-boundary surface this CLI needs to re-verify no-lookahead across every (date, target) pair through the SAME path a future consumer would use. */
export type VerifyResampledSession = Pick<ResearchUnderlyingResampledSessionReaderService, 'readResampledSession'>;

export interface RunNifty2023ResampleOptions {
  /** The operator-supplied upstream checksum (normally read from the RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM environment variable) -- injected explicitly here so tests never read real environment variables. */
  readonly sourceAssemblyChecksum: string | undefined;
  readonly buildService: () => BuildAndPersistResamplingManifest;
  readonly buildVerifier: () => VerifyResampledSession;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

function validateSourceAssemblyChecksumInput(value: string | undefined): { checksum: string } | PostconditionFailure {
  if (!value) {
    return {
      code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM',
      message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2023 research assembly checksum produced by 'npm run research:nifty-2023:assemble' (its SUCCESS output line 'researchAssemblyChecksum=...')`,
    };
  }
  if (!CHECKSUM_PATTERN.test(value)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${value}'` };
  }
  return { checksum: value };
}

/**
 * The ONE locked production postcondition gate for the 2023 NIFTY/1minute
 * resampling manifest. Deliberately hardcodes 246/45845/30645/18387/
 * 2023-11-12/30-20-12 -- acceptable and REQUIRED at this operator
 * postcondition boundary (never inside the core resampler/manifest-builder
 * algorithms, which never hardcode a session count or aggregate total).
 */
function validateLockedProductionPostconditions(manifest: ResearchUnderlyingResamplingManifestV1, expectedSourceAssemblyChecksum: string): PostconditionFailure | null {
  if (manifest.sourceAssemblyChecksum !== expectedSourceAssemblyChecksum) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected source assembly checksum '${expectedSourceAssemblyChecksum}', got '${manifest.sourceAssemblyChecksum}'` };
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

  const totals: Record<ResampleTargetTimeframe, { outputCandleCount: number; structuralTrailingRowCount: number; candlesContainingImputation: number }> = {
    [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
    [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
    [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
  };

  for (const session of manifest.sessions) {
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      const descriptor = session.targets[target];
      if (!descriptor || descriptor.status !== ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION) {
        return { code: 'INCOMPLETE_SESSION_DESCRIPTOR', message: `tradingDate '${session.tradingDate}' is missing a COMPLETE descriptor for target '${target}'` };
      }
      if (descriptor.sourcePrecedenceTier !== ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION) {
        return {
          code: 'NON_REAL_CANONICAL_SOURCE',
          message: `tradingDate '${session.tradingDate}' target '${target}' sourcePrecedenceTier is '${String(descriptor.sourcePrecedenceTier)}', expected HEALTHY_REAL_CANONICAL_SESSION for every 2023 session -- 2023 must be 100% REAL_CANONICAL_ONLY`,
        };
      }
      if (descriptor.derivedImputedConstituentRowCount !== 0) {
        return { code: 'UNEXPECTED_IMPUTATION', message: `tradingDate '${session.tradingDate}' target '${target}' has ${descriptor.derivedImputedConstituentRowCount} imputed constituent row(s) -- 2023 must have zero imputation` };
      }
      totals[target].outputCandleCount += descriptor.outputCandleCount;
      totals[target].structuralTrailingRowCount += descriptor.structuralTrailingRowCount;
      totals[target].candlesContainingImputation += descriptor.candlesContainingImputation;
    }
  }

  for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
    const expected = LOCKED_TARGET_TOTALS[target];
    const actual = totals[target];
    if (actual.outputCandleCount !== expected.totalOutputCandles || actual.structuralTrailingRowCount !== expected.totalStructuralTrailingRows || actual.candlesContainingImputation !== expected.totalCandlesContainingImputation) {
      return {
        code: 'WRONG_TARGET_AGGREGATE_TOTALS',
        message: `target '${target}': expected outputCandleCount=${expected.totalOutputCandles}/structuralTrailingRowCount=${expected.totalStructuralTrailingRows}/candlesContainingImputation=${expected.totalCandlesContainingImputation}, got ${actual.outputCandleCount}/${actual.structuralTrailingRowCount}/${actual.candlesContainingImputation}`,
      };
    }
  }

  const muhurat = manifest.sessions.find((session) => session.tradingDate === MUHURAT_DATE);
  if (!muhurat) {
    return { code: 'MUHURAT_SESSION_MISSING', message: `no manifest session entry for '${MUHURAT_DATE}'` };
  }
  const m2 = muhurat.targets[ResampleTargetTimeframe.TWO_MINUTE];
  if (m2.sourceRowCount !== 60) {
    return { code: 'MUHURAT_WRONG_SOURCE_ROW_COUNT', message: `expected Muhurat sourceRowCount 60, got ${m2.sourceRowCount}` };
  }
  for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
    const descriptor = muhurat.targets[target];
    const expectedCount = LOCKED_MUHURAT_COUNTS[target];
    if (descriptor.outputCandleCount !== expectedCount || descriptor.structuralTrailingRowCount !== 0) {
      return {
        code: 'MUHURAT_WRONG_TARGET_COUNTS',
        message: `Muhurat target '${target}': expected outputCandleCount=${expectedCount}/structuralTrailingRowCount=0, got ${descriptor.outputCandleCount}/${descriptor.structuralTrailingRowCount}`,
      };
    }
  }

  return null;
}

/**
 * Re-derives every (date, target) pair's actual candles through the SAME
 * verified read boundary (`ResearchUnderlyingResampledSessionReaderService`)
 * a future consumer would use, and independently proves, for EVERY candle in
 * all 246 x 3 = 738 pairs: `availableAt === MAX(constituent availableAt)`
 * (never a synthetic/forward-filled value), `quality === REAL_CANONICAL_ONLY`
 * (2023 has zero derived/imputed content), and -- for the 2023-11-12 Muhurat
 * session specifically -- that no bucket bridges outside the certified
 * 18:15-19:15 IST special-session window.
 */
async function validateNoLookaheadAcrossAllSessions(
  verifier: VerifyResampledSession,
  manifest: ResearchUnderlyingResamplingManifestV1,
  sourceAssembly: BuildYearResamplingManifestResult['sourceAssembly']
): Promise<{ failure: PostconditionFailure | null; verifiedSessionTargetPairs: number }> {
  let verifiedSessionTargetPairs = 0;
  for (const session of manifest.sessions) {
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      let readResult;
      try {
        // eslint-disable-next-line no-await-in-loop -- deterministic per-(date,target) ordering matters for reproducible failure attribution
        readResult = await verifier.readResampledSession({ manifest, sourceAssembly, tradingDate: session.tradingDate, targetTimeframe: target });
      } catch (error) {
        return { failure: { code: 'NO_LOOKAHEAD_VERIFICATION_FAILED', message: `${session.tradingDate}/${target}: ${error instanceof Error ? error.message : String(error)}` }, verifiedSessionTargetPairs };
      }

      const descriptor = session.targets[target];
      if (readResult.candles.length !== descriptor.outputCandleCount) {
        return {
          failure: { code: 'CANDLE_COUNT_MISMATCH', message: `${session.tradingDate}/${target}: manifest descriptor says ${descriptor.outputCandleCount} output candles, verified reader returned ${readResult.candles.length}` },
          verifiedSessionTargetPairs,
        };
      }

      for (const candle of readResult.candles) {
        const constituentAvailableAtMs = candle.constituents.map((constituent) => new Date(constituent.availableAt).getTime());
        const maxAvailableAtMs = Math.max(...constituentAvailableAtMs);
        if (candle.availableAt.getTime() !== maxAvailableAtMs) {
          return { failure: { code: 'NO_LOOKAHEAD_VIOLATION', message: `${session.tradingDate}/${target} bucket ${candle.bucketStart.toISOString()}: availableAt does not equal MAX(constituent availableAt)` }, verifiedSessionTargetPairs };
        }
        if (candle.quality !== ResearchCandleQuality.REAL_CANONICAL_ONLY) {
          return {
            failure: { code: 'NON_REAL_CANONICAL_QUALITY', message: `${session.tradingDate}/${target} bucket ${candle.bucketStart.toISOString()}: quality is '${candle.quality}', expected REAL_CANONICAL_ONLY for a clean 2023 session` },
            verifiedSessionTargetPairs,
          };
        }
        if (session.tradingDate === MUHURAT_DATE) {
          const bucketStartMinute = istMinuteOfDay(candle.bucketStart);
          const bucketLastMinute = istMinuteOfDay(new Date(candle.bucketEnd.getTime() - 60_000));
          if (bucketStartMinute < MUHURAT_OPEN_MINUTE_IST || bucketLastMinute >= MUHURAT_CLOSE_MINUTE_IST) {
            return {
              failure: { code: 'MUHURAT_BUCKET_BRIDGES_WINDOW', message: `Muhurat bucket ${candle.bucketStart.toISOString()}-${candle.bucketEnd.toISOString()} is not fully contained within 18:15-19:15 IST` },
              verifiedSessionTargetPairs,
            };
          }
        }
      }
      verifiedSessionTargetPairs += 1;
    }
  }
  return { failure: null, verifiedSessionTargetPairs };
}

/**
 * Returns `true` only on a fully-completed, postcondition-validated,
 * no-lookahead-proof-verified, and persisted manifest; `false` on any
 * failure. Never throws. The trusted B-M7.3-shaped manifest is written ONLY
 * after every check below passes.
 */
export async function runNifty2023Resample(options: RunNifty2023ResampleOptions): Promise<boolean> {
  const { sourceAssemblyChecksum: rawChecksum, buildService, buildVerifier, output, errorOutput } = options;

  const checksumInput = validateSourceAssemblyChecksumInput(rawChecksum);
  if ('code' in checksumInput) {
    errorOutput(['[B_M9_2023_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${checksumInput.code}`, `message=${checksumInput.message}`].join('\n'));
    return false;
  }
  const sourceAssemblyChecksum = checksumInput.checksum;

  const service = buildService();
  let result: BuildYearResamplingManifestResult;
  try {
    result = await service.buildYearManifest({ sourceAssemblyChecksum });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=BUILD_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.manifest, sourceAssemblyChecksum);
  if (postconditionFailure) {
    errorOutput(['[B_M9_2023_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  const verifier = buildVerifier();
  const { failure: noLookaheadFailure, verifiedSessionTargetPairs } = await validateNoLookaheadAcrossAllSessions(verifier, result.manifest, result.sourceAssembly);
  if (noLookaheadFailure) {
    errorOutput(['[B_M9_2023_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${noLookaheadFailure.code}`, `message=${noLookaheadFailure.message}`].join('\n'));
    return false;
  }

  let manifestStorage: ContentAddressedJsonStoreResult;
  try {
    manifestStorage = service.persistManifest(result.manifest);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result, manifestStorage, verifiedSessionTargetPairs));
  return true;
}

function describeStorage(storage: ContentAddressedJsonStoreResult): string {
  return `${storage.relativePath} (wasNewlyWritten=${storage.wasNewlyWritten})`;
}

function formatSuccessOutput(result: BuildYearResamplingManifestResult, manifestStorage: ContentAddressedJsonStoreResult, verifiedSessionTargetPairs: number): string {
  const { manifest } = result;
  return [
    '[B_M9_2023_RESEARCH_RESAMPLING]',
    'status=SUCCESS',
    `instrument=${manifest.identity.instrumentKey}`,
    `sourceTimeframe=${manifest.identity.sourceTimeframe}`,
    `year=${manifest.identity.year}`,
    `sourceAssemblyChecksum=${manifest.sourceAssemblyChecksum}`,
    `sourceSessions=${manifest.sourceSessionCounts.expectedSessions}`,
    `resolvedSessions=${manifest.summary.resolvedSessions}`,
    `unavailableSessions=${manifest.sourceSessionCounts.unavailableSessions}`,
    `targets=${manifest.targetTimeframes.join(',')}`,
    `verifiedSessionTargetPairs=${verifiedSessionTargetPairs}`,
    `manifestContentChecksum=${manifest.manifestContentChecksum}`,
    `manifestArtifact=${describeStorage(manifestStorage)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2023Resample({
    sourceAssemblyChecksum: process.env[SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR],
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
    console.error('[B_M9_2023_RESEARCH_RESAMPLING] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
