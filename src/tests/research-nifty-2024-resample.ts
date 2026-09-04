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
 * B-M10 operator runner: resamples the trusted, committed 2024 NIFTY
 * research assembly (B-M7.2-shaped, from `research:nifty-2024:assemble`)
 * into a content-addressed 2m/3m/5m research resampling manifest. Reuses the
 * existing generic `ResearchUnderlyingResamplingManifestBuilderService`/
 * `ResearchUnderlyingResamplerService`/verified resampled reader unmodified
 * -- no second resampling implementation.
 *
 * UNLIKE 2023 (100% real-canonical), 2024 carries exactly ONE
 * composite-repaired session -- 2024-12-12 -- so every per-session-per-target
 * descriptor check below accepts `ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION`
 * for that ONE date specifically and `HEALTHY_REAL_CANONICAL_SESSION` for
 * every other date, rather than requiring 100% real-canonical-only like the
 * 2023 CLI. A composite-repaired session's resampled candles still carry
 * `ResearchCandleQuality.REAL_CANONICAL_ONLY` (every constituent row maps to
 * `ResolvedResearchRowSourceKind.REAL_CANONICAL` for both tier 1 and tier 2
 * -- see `research-underlying-1m-session-reader.service.ts`), so the
 * no-lookahead re-verification's REAL_CANONICAL_ONLY-quality requirement is
 * unchanged and applies uniformly across all 249 sessions.
 *
 * CHECKSUM HANDOFF: the 2024 research assembly checksum is NOT known until
 * `research:nifty-2024:assemble` has actually been run for real, so this CLI
 * requires it as an explicit operator input via the narrow, year-specific
 * `RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM` environment variable. The
 * value is format-validated (exactly 64 lowercase hex characters) BEFORE
 * use; the underlying `ResearchUnderlyingResamplingManifestBuilderService`/
 * `readResearchUnderlyingDatasetAssembly` read boundary then independently
 * verifies the referenced assembly artifact exists and is content-addressed-
 * checksum-correct.
 *
 * Zero provider calls, zero canonical DB writes. Builds the manifest WITHOUT
 * persisting it, independently validates a fixed set of locked production
 * postconditions (exact year aggregate totals, every special session's exact
 * shape), independently re-verifies no-lookahead across EVERY (date, target)
 * pair -- 249 x 3 = 747 -- through the SAME verified read boundary a future
 * consumer would use (plus a bucket-containment check proving the two
 * DR-switchover special sessions never bridge the 10:00-11:30 gap), and ONLY
 * THEN persists the trusted content-addressed artifact.
 *
 * Usage (PowerShell), once reviewed AND `research:nifty-2024:assemble` has
 * produced a real researchAssemblyChecksum:
 *   $env:RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2024:resample
 */

const LOCKED_YEAR = 2024;
const EXPECTED_SESSIONS = 249;

const JAN20_DATE = '2024-01-20';
const JAN20_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 555, closeMinuteIst: 930 }];
const MAR2_DATE = '2024-03-02';
const MAY18_DATE = '2024-05-18';
const DR_SWITCHOVER_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [
  { openMinuteIst: 555, closeMinuteIst: 600 },
  { openMinuteIst: 690, closeMinuteIst: 750 },
];
const MUHURAT_DATE = '2024-11-01';
const MUHURAT_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 1080, closeMinuteIst: 1140 }];
const COMPOSITE_REPAIRED_DATE = '2024-12-12';

const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

const LOCKED_TARGET_TOTALS: Readonly<Record<ResampleTargetTimeframe, { totalOutputCandles: number; totalStructuralTrailingRows: number; totalCandlesContainingImputation: number }>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { totalOutputCandles: 46136, totalStructuralTrailingRows: 248, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { totalOutputCandles: 30840, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { totalOutputCandles: 18504, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
};

interface TargetShape {
  readonly outputCandleCount: number;
  readonly structuralTrailingRowCount: number;
}

interface LockedSpecialSessionShape {
  readonly date: string;
  readonly sourceRowCount: number;
  readonly perTarget: Readonly<Record<ResampleTargetTimeframe, TargetShape>>;
  readonly missingCode: string;
  readonly rowCountCode: string;
  readonly targetCountsCode: string;
}

/**
 * Every non-uniform-shaped 2024 session (the four certified special sessions
 * plus the one composite-repaired session -- included here purely as an
 * explicit row-count lock, its shape is otherwise identical to a regular
 * day). Every other 2024 session is an ordinary single-window 375-row day
 * (187/125/75 per 2m/3m/5m, 1/0/0 trailing) and is covered only by the
 * aggregate totals check below.
 */
const LOCKED_SPECIAL_SESSIONS: readonly LockedSpecialSessionShape[] = [
  {
    date: JAN20_DATE,
    sourceRowCount: 375,
    perTarget: {
      [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 187, structuralTrailingRowCount: 1 },
      [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 125, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 75, structuralTrailingRowCount: 0 },
    },
    missingCode: 'JAN20_SESSION_MISSING',
    rowCountCode: 'JAN20_WRONG_SOURCE_ROW_COUNT',
    targetCountsCode: 'JAN20_WRONG_TARGET_COUNTS',
  },
  {
    date: MAR2_DATE,
    sourceRowCount: 105,
    perTarget: {
      [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 52, structuralTrailingRowCount: 1 },
      [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 35, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 21, structuralTrailingRowCount: 0 },
    },
    missingCode: 'MAR2_SESSION_MISSING',
    rowCountCode: 'MAR2_WRONG_SOURCE_ROW_COUNT',
    targetCountsCode: 'MAR2_WRONG_TARGET_COUNTS',
  },
  {
    date: MAY18_DATE,
    sourceRowCount: 105,
    perTarget: {
      [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 52, structuralTrailingRowCount: 1 },
      [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 35, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 21, structuralTrailingRowCount: 0 },
    },
    missingCode: 'MAY18_SESSION_MISSING',
    rowCountCode: 'MAY18_WRONG_SOURCE_ROW_COUNT',
    targetCountsCode: 'MAY18_WRONG_TARGET_COUNTS',
  },
  {
    date: MUHURAT_DATE,
    sourceRowCount: 60,
    perTarget: {
      [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 30, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 20, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 12, structuralTrailingRowCount: 0 },
    },
    missingCode: 'MUHURAT_SESSION_MISSING',
    rowCountCode: 'MUHURAT_WRONG_SOURCE_ROW_COUNT',
    targetCountsCode: 'MUHURAT_WRONG_TARGET_COUNTS',
  },
  {
    date: COMPOSITE_REPAIRED_DATE,
    sourceRowCount: 375,
    perTarget: {
      [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 187, structuralTrailingRowCount: 1 },
      [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 125, structuralTrailingRowCount: 0 },
      [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 75, structuralTrailingRowCount: 0 },
    },
    missingCode: 'COMPOSITE_REPAIRED_SESSION_MISSING',
    rowCountCode: 'COMPOSITE_REPAIRED_WRONG_SOURCE_ROW_COUNT',
    targetCountsCode: 'COMPOSITE_REPAIRED_WRONG_TARGET_COUNTS',
  },
];

/** Bucket-containment windows for every certified 2024 special session -- used ONLY by the no-lookahead re-verification loop to prove no resampled bucket ever bridges outside its certified window(s) (critically: never across the 10:00-11:30 gap for 2024-03-02/2024-05-18). The composite-repaired date is deliberately absent -- it is an ordinary single full-day window, like every regular 2024 session. */
const SPECIAL_SESSION_BUCKET_WINDOWS: Readonly<Record<string, readonly { openMinuteIst: number; closeMinuteIst: number }[]>> = {
  [JAN20_DATE]: JAN20_WINDOWS,
  [MAR2_DATE]: DR_SWITCHOVER_WINDOWS,
  [MAY18_DATE]: DR_SWITCHOVER_WINDOWS,
  [MUHURAT_DATE]: MUHURAT_WINDOWS,
};

/** The exact service surface this CLI needs -- `buildYearManifest` (never persists on its own) plus the separate `persistManifest` step. */
export type BuildAndPersistResamplingManifest = Pick<ResearchUnderlyingResamplingManifestBuilderService, 'buildYearManifest' | 'persistManifest'>;
/** The exact verified read-boundary surface this CLI needs to re-verify no-lookahead across every (date, target) pair through the SAME path a future consumer would use. */
export type VerifyResampledSession = Pick<ResearchUnderlyingResampledSessionReaderService, 'readResampledSession'>;

export interface RunNifty2024ResampleOptions {
  /** The operator-supplied upstream checksum (normally read from the RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM environment variable) -- injected explicitly here so tests never read real environment variables. */
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
      message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2024 research assembly checksum produced by 'npm run research:nifty-2024:assemble' (its SUCCESS output line 'researchAssemblyChecksum=...')`,
    };
  }
  if (!CHECKSUM_PATTERN.test(value)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${value}'` };
  }
  return { checksum: value };
}

function expectedTierFor(tradingDate: string): ResearchSessionSourcePrecedenceTier {
  return tradingDate === COMPOSITE_REPAIRED_DATE ? ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION : ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION;
}

/**
 * The ONE locked production postcondition gate for the 2024 NIFTY/1minute
 * resampling manifest. Deliberately hardcodes the exact 2m/3m/5m aggregate
 * totals and every special session's exact shape -- acceptable and REQUIRED
 * at this operator postcondition boundary (never inside the core
 * resampler/manifest-builder algorithms, which never hardcode a session
 * count or aggregate total). Unlike 2023, does NOT require 100%
 * real-canonical-only -- it requires exactly the one reviewed 2024-12-12
 * composite-repaired date and real-canonical everywhere else.
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
    const expectedTier = expectedTierFor(session.tradingDate);
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      const descriptor = session.targets[target];
      if (!descriptor || descriptor.status !== ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION) {
        return { code: 'INCOMPLETE_SESSION_DESCRIPTOR', message: `tradingDate '${session.tradingDate}' is missing a COMPLETE descriptor for target '${target}'` };
      }
      if (descriptor.sourcePrecedenceTier !== expectedTier) {
        return {
          code: 'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SOURCE',
          message: `tradingDate '${session.tradingDate}' target '${target}' sourcePrecedenceTier is '${String(descriptor.sourcePrecedenceTier)}', expected '${expectedTier}' for 2024 -- every 2024 session must be real-canonical except the one reviewed 2024-12-12 composite repair`,
        };
      }
      if (descriptor.derivedImputedConstituentRowCount !== 0) {
        return { code: 'UNEXPECTED_IMPUTATION', message: `tradingDate '${session.tradingDate}' target '${target}' has ${descriptor.derivedImputedConstituentRowCount} imputed constituent row(s) -- 2024 must have zero imputation` };
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

  for (const special of LOCKED_SPECIAL_SESSIONS) {
    const session = manifest.sessions.find((entry) => entry.tradingDate === special.date);
    if (!session) {
      return { code: special.missingCode, message: `no manifest session entry for '${special.date}'` };
    }
    const anyTarget = session.targets[ResampleTargetTimeframe.TWO_MINUTE];
    if (anyTarget.sourceRowCount !== special.sourceRowCount) {
      return { code: special.rowCountCode, message: `expected '${special.date}' sourceRowCount ${special.sourceRowCount}, got ${anyTarget.sourceRowCount}` };
    }
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      const descriptor = session.targets[target];
      const expectedShape = special.perTarget[target];
      if (descriptor.outputCandleCount !== expectedShape.outputCandleCount || descriptor.structuralTrailingRowCount !== expectedShape.structuralTrailingRowCount) {
        return {
          code: special.targetCountsCode,
          message: `'${special.date}' target '${target}': expected outputCandleCount=${expectedShape.outputCandleCount}/structuralTrailingRowCount=${expectedShape.structuralTrailingRowCount}, got ${descriptor.outputCandleCount}/${descriptor.structuralTrailingRowCount}`,
        };
      }
    }
  }

  return null;
}

/**
 * Re-derives every (date, target) pair's actual candles through the SAME
 * verified read boundary (`ResearchUnderlyingResampledSessionReaderService`)
 * a future consumer would use, and independently proves, for EVERY candle in
 * all 249 x 3 = 747 pairs: `availableAt === MAX(constituent availableAt)`
 * (never a synthetic/forward-filled value) and `quality === REAL_CANONICAL_ONLY`
 * (2024 has zero derived/imputed content -- true for the composite-repaired
 * date too, since its constituents are still real canonical rows). For every
 * certified 2024 special session, ALSO proves no bucket bridges outside its
 * certified window(s) -- critically, that the two DR-switchover sessions
 * (2024-03-02/2024-05-18) never bridge the 10:00-11:30 gap between windows.
 */
async function validateNoLookaheadAcrossAllSessions(
  verifier: VerifyResampledSession,
  manifest: ResearchUnderlyingResamplingManifestV1,
  sourceAssembly: BuildYearResamplingManifestResult['sourceAssembly']
): Promise<{ failure: PostconditionFailure | null; verifiedSessionTargetPairs: number }> {
  let verifiedSessionTargetPairs = 0;
  for (const session of manifest.sessions) {
    const specialWindows = SPECIAL_SESSION_BUCKET_WINDOWS[session.tradingDate];
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
            failure: { code: 'NON_REAL_CANONICAL_QUALITY', message: `${session.tradingDate}/${target} bucket ${candle.bucketStart.toISOString()}: quality is '${candle.quality}', expected REAL_CANONICAL_ONLY for 2024 (real-canonical and composite-repaired constituents are both REAL_CANONICAL)` },
            verifiedSessionTargetPairs,
          };
        }
        if (specialWindows) {
          const bucketStartMinute = istMinuteOfDay(candle.bucketStart);
          const bucketLastMinute = istMinuteOfDay(new Date(candle.bucketEnd.getTime() - 60_000));
          const withinAnyWindow = specialWindows.some((window) => bucketStartMinute >= window.openMinuteIst && bucketLastMinute < window.closeMinuteIst);
          if (!withinAnyWindow) {
            return {
              failure: { code: 'SPECIAL_SESSION_BUCKET_BRIDGES_WINDOW', message: `${session.tradingDate} bucket ${candle.bucketStart.toISOString()}-${candle.bucketEnd.toISOString()} is not fully contained within any certified window for this special session` },
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
export async function runNifty2024Resample(options: RunNifty2024ResampleOptions): Promise<boolean> {
  const { sourceAssemblyChecksum: rawChecksum, buildService, buildVerifier, output, errorOutput } = options;

  const checksumInput = validateSourceAssemblyChecksumInput(rawChecksum);
  if ('code' in checksumInput) {
    errorOutput(['[B_M10_2024_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${checksumInput.code}`, `message=${checksumInput.message}`].join('\n'));
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
    errorOutput(['[B_M10_2024_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=BUILD_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedProductionPostconditions(result.manifest, sourceAssemblyChecksum);
  if (postconditionFailure) {
    errorOutput(['[B_M10_2024_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  const verifier = buildVerifier();
  const { failure: noLookaheadFailure, verifiedSessionTargetPairs } = await validateNoLookaheadAcrossAllSessions(verifier, result.manifest, result.sourceAssembly);
  if (noLookaheadFailure) {
    errorOutput(['[B_M10_2024_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${noLookaheadFailure.code}`, `message=${noLookaheadFailure.message}`].join('\n'));
    return false;
  }

  let manifestStorage: ContentAddressedJsonStoreResult;
  try {
    manifestStorage = service.persistManifest(result.manifest);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M10_2024_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
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
    '[B_M10_2024_RESEARCH_RESAMPLING]',
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
  const success = await runNifty2024Resample({
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
    console.error('[B_M10_2024_RESEARCH_RESAMPLING] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
