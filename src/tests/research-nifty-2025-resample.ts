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
 * B-M11 operator runner: resamples the trusted, committed 2025 NIFTY
 * research assembly (B-M7.2-shaped, from `research:nifty-2025:assemble`)
 * into a content-addressed 2m/3m/5m research resampling manifest. Reuses the
 * existing generic `ResearchUnderlyingResamplingManifestBuilderService`/
 * `ResearchUnderlyingResamplerService`/verified resampled reader unmodified
 * -- no second resampling implementation.
 *
 * UNLIKE 2024 (exactly ONE composite-repaired session), 2025 carries THREE
 * -- 2025-03-25, 2025-04-04, 2025-04-23 -- so every per-session-per-target
 * descriptor check below accepts `ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION`
 * for exactly those three dates and `HEALTHY_REAL_CANONICAL_SESSION` for
 * every other date. A composite-repaired session's resampled candles still
 * carry `ResearchCandleQuality.REAL_CANONICAL_ONLY` (every constituent row
 * maps to `ResolvedResearchRowSourceKind.REAL_CANONICAL` for both tier 1 and
 * tier 2 -- see `research-underlying-1m-session-reader.service.ts`), so the
 * no-lookahead re-verification's REAL_CANONICAL_ONLY-quality requirement is
 * unchanged and applies uniformly across all 249 sessions.
 *
 * UNLIKE 2024, this CLI does NOT hardcode a year-level aggregate 2m/3m/5m
 * candle total: no such number was independently proven ahead of a real run
 * (task instruction: "do not hardcode resample output totals unless derived
 * from the existing deterministic service -- let the real run produce
 * authoritative counts"). Instead it validates EVERY session individually
 * against one of exactly two DETERMINISTIC per-session shapes derived from
 * certified window length alone (the SAME floor-division rule the reviewed,
 * unmodified resampler already applies, never re-implemented here): a
 * certified single 375-minute session (every ordinary trading day plus the
 * 2025-02-01 special session plus all three composite-repaired dates) always
 * produces 187/125/75 (2m/3m/5m) output candles with 1/0/0 structural
 * trailing rows; the certified single 60-minute 2025-10-21 Muhurat session
 * always produces 30/20/12 with 0/0/0 trailing. This is per-session
 * structural validation, not a hardcoded year-total -- the actual year-level
 * sums are computed fresh from the validated manifest and only ever REPORTED
 * (informational SUCCESS output), never gated on a pre-guessed number.
 *
 * CHECKSUM HANDOFF: the 2025 research assembly checksum is NOT known until
 * `research:nifty-2025:assemble` has actually been run for real, so this CLI
 * requires it as an explicit operator input via the narrow, year-specific
 * `RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM` environment variable. The
 * value is format-validated (exactly 64 lowercase hex characters) BEFORE
 * use; the underlying `ResearchUnderlyingResamplingManifestBuilderService`/
 * `readResearchUnderlyingDatasetAssembly` read boundary then independently
 * verifies the referenced assembly artifact exists and is content-addressed-
 * checksum-correct.
 *
 * Zero provider calls, zero canonical DB writes. Builds the manifest WITHOUT
 * persisting it, independently validates a fixed set of locked production
 * postconditions, independently re-verifies no-lookahead across EVERY
 * (date, target) pair -- 249 x 3 = 747 -- through the SAME verified read
 * boundary a future consumer would use, and ONLY THEN persists the trusted
 * content-addressed artifact.
 *
 * Usage (PowerShell), once reviewed AND `research:nifty-2025:assemble` has
 * produced a real researchAssemblyChecksum:
 *   $env:RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2025:resample
 */

const LOCKED_YEAR = 2025;
const EXPECTED_SESSIONS = 249;

const FEB1_DATE = '2025-02-01';
const FEB1_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 555, closeMinuteIst: 930 }];
const OCT21_DATE = '2025-10-21';
const OCT21_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 825, closeMinuteIst: 885 }];
const COMPOSITE_REPAIRED_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];

const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

interface TargetShape {
  readonly outputCandleCount: number;
  readonly structuralTrailingRowCount: number;
}

/** Deterministic floor-division shape for ANY certified single 375-minute window session (every ordinary day, 2025-02-01, and all three composite-repaired dates) -- the SAME arithmetic the reviewed, unmodified resampler already applies (floor(375/2)=187 remainder 1, floor(375/3)=125 exact, floor(375/5)=75 exact). Never a hardcoded year-total; this is a per-session fact derived purely from the certified window length. */
const REGULAR_375_SHAPE: Readonly<Record<ResampleTargetTimeframe, TargetShape>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 187, structuralTrailingRowCount: 1 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 125, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 75, structuralTrailingRowCount: 0 },
};

/** Deterministic floor-division shape for the certified single 60-minute 2025-10-21 Muhurat window (floor(60/2)=30, floor(60/3)=20, floor(60/5)=12, all exact -- zero trailing). */
const MUHURAT_60_SHAPE: Readonly<Record<ResampleTargetTimeframe, TargetShape>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 30, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 20, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 12, structuralTrailingRowCount: 0 },
};

/** Bucket-containment windows for both certified 2025 special sessions -- used ONLY by the no-lookahead re-verification loop to prove no resampled bucket ever bridges outside its certified window. Neither 2025 special session is multi-window, so no gap-bridging is even possible this year; kept for the same defense-in-depth reason 2024 checked its single-window specials too. */
const SPECIAL_SESSION_BUCKET_WINDOWS: Readonly<Record<string, readonly { openMinuteIst: number; closeMinuteIst: number }[]>> = {
  [FEB1_DATE]: FEB1_WINDOWS,
  [OCT21_DATE]: OCT21_WINDOWS,
};

function expectedRowCountFor(tradingDate: string): number {
  return tradingDate === OCT21_DATE ? 60 : 375;
}

function expectedShapeFor(tradingDate: string): Readonly<Record<ResampleTargetTimeframe, TargetShape>> {
  return tradingDate === OCT21_DATE ? MUHURAT_60_SHAPE : REGULAR_375_SHAPE;
}

function expectedTierFor(tradingDate: string): ResearchSessionSourcePrecedenceTier {
  return COMPOSITE_REPAIRED_DATES.includes(tradingDate) ? ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION : ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION;
}

/** The exact service surface this CLI needs -- `buildYearManifest` (never persists on its own) plus the separate `persistManifest` step. */
export type BuildAndPersistResamplingManifest = Pick<ResearchUnderlyingResamplingManifestBuilderService, 'buildYearManifest' | 'persistManifest'>;
/** The exact verified read-boundary surface this CLI needs to re-verify no-lookahead across every (date, target) pair through the SAME path a future consumer would use. */
export type VerifyResampledSession = Pick<ResearchUnderlyingResampledSessionReaderService, 'readResampledSession'>;

export interface RunNifty2025ResampleOptions {
  /** The operator-supplied upstream checksum (normally read from the RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM environment variable) -- injected explicitly here so tests never read real environment variables. */
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
      message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2025 research assembly checksum produced by 'npm run research:nifty-2025:assemble' (its SUCCESS output line 'researchAssemblyChecksum=...')`,
    };
  }
  if (!CHECKSUM_PATTERN.test(value)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${value}'` };
  }
  return { checksum: value };
}

interface YearTotals {
  outputCandleCount: number;
  structuralTrailingRowCount: number;
  candlesContainingImputation: number;
}

/**
 * The ONE locked production postcondition gate for the 2025 NIFTY/1minute
 * resampling manifest. Validates every session individually against a
 * DETERMINISTIC per-window-length shape (never a hardcoded year-aggregate
 * total -- see this file's own module doc) and the exact tier expected for
 * that date (real-canonical everywhere except the three reviewed 2025
 * composite repairs). Also accumulates the actual year-level totals purely
 * for informational SUCCESS reporting -- `formatSuccessOutput` prints them,
 * but nothing here gates on a pre-guessed sum.
 */
function validateLockedProductionPostconditions(manifest: ResearchUnderlyingResamplingManifestV1, expectedSourceAssemblyChecksum: string): { failure: PostconditionFailure | null; totals: Readonly<Record<ResampleTargetTimeframe, YearTotals>> } {
  const totals: Record<ResampleTargetTimeframe, YearTotals> = {
    [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
    [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
    [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 0, structuralTrailingRowCount: 0, candlesContainingImputation: 0 },
  };
  const fail = (code: string, message: string): { failure: PostconditionFailure; totals: Readonly<Record<ResampleTargetTimeframe, YearTotals>> } => ({ failure: { code, message }, totals });

  if (manifest.sourceAssemblyChecksum !== expectedSourceAssemblyChecksum) {
    return fail('WRONG_SOURCE_ASSEMBLY_CHECKSUM', `expected source assembly checksum '${expectedSourceAssemblyChecksum}', got '${manifest.sourceAssemblyChecksum}'`);
  }
  if (manifest.identity.instrumentKey !== NIFTY_INDEX_INSTRUMENT_KEY) {
    return fail('WRONG_INSTRUMENT', `expected instrument '${NIFTY_INDEX_INSTRUMENT_KEY}', got '${manifest.identity.instrumentKey}'`);
  }
  if (manifest.identity.sourceTimeframe !== NIFTY_UNDERLYING_TIMEFRAME) {
    return fail('WRONG_TIMEFRAME', `expected source timeframe '${NIFTY_UNDERLYING_TIMEFRAME}', got '${manifest.identity.sourceTimeframe}'`);
  }
  if (manifest.identity.year !== LOCKED_YEAR) {
    return fail('WRONG_YEAR', `expected year ${LOCKED_YEAR}, got ${manifest.identity.year}`);
  }
  if (manifest.sourceSessionCounts.expectedSessions !== EXPECTED_SESSIONS) {
    return fail('WRONG_SOURCE_SESSION_COUNT', `expected exactly ${EXPECTED_SESSIONS} certified ${LOCKED_YEAR} source sessions, got ${manifest.sourceSessionCounts.expectedSessions}`);
  }
  if (manifest.sourceSessionCounts.unavailableSessions !== 0) {
    return fail('UNAVAILABLE_SESSIONS_PRESENT', `expected 0 unavailable source sessions, got ${manifest.sourceSessionCounts.unavailableSessions}`);
  }
  if (manifest.summary.resolvedSessions !== EXPECTED_SESSIONS) {
    return fail('INCOMPLETE_RESOLVED_SESSIONS', `expected all ${EXPECTED_SESSIONS} sessions resolved, got ${manifest.summary.resolvedSessions}`);
  }

  const targetSet = new Set(manifest.targetTimeframes);
  const targetsMatch = manifest.targetTimeframes.length === RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length && RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.every((target) => targetSet.has(target));
  if (!targetsMatch) {
    return fail('WRONG_TARGET_TIMEFRAME_SET', `expected targets exactly [${RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.join(',')}], got [${manifest.targetTimeframes.join(',')}]`);
  }
  if (manifest.sessions.length !== EXPECTED_SESSIONS) {
    return fail('WRONG_MANIFEST_SESSION_COUNT', `expected exactly ${EXPECTED_SESSIONS} manifest session entries, got ${manifest.sessions.length}`);
  }

  for (const special of [FEB1_DATE, OCT21_DATE]) {
    if (!manifest.sessions.some((session) => session.tradingDate === special)) {
      return fail('SPECIAL_SESSION_MISSING', `no manifest session entry for certified special session '${special}'`);
    }
  }
  for (const repaired of COMPOSITE_REPAIRED_DATES) {
    if (!manifest.sessions.some((session) => session.tradingDate === repaired)) {
      return fail('COMPOSITE_REPAIRED_SESSION_MISSING', `no manifest session entry for reviewed composite-repaired date '${repaired}'`);
    }
  }

  for (const session of manifest.sessions) {
    const expectedTier = expectedTierFor(session.tradingDate);
    const expectedRowCount = expectedRowCountFor(session.tradingDate);
    const expectedShape = expectedShapeFor(session.tradingDate);
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      const descriptor = session.targets[target];
      if (!descriptor || descriptor.status !== ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION) {
        return fail('INCOMPLETE_SESSION_DESCRIPTOR', `tradingDate '${session.tradingDate}' is missing a COMPLETE descriptor for target '${target}'`);
      }
      if (descriptor.sourcePrecedenceTier !== expectedTier) {
        return fail(
          'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SOURCE',
          `tradingDate '${session.tradingDate}' target '${target}' sourcePrecedenceTier is '${String(descriptor.sourcePrecedenceTier)}', expected '${expectedTier}' for 2025 -- every 2025 session must be real-canonical except the three reviewed composite repairs`
        );
      }
      if (descriptor.derivedImputedConstituentRowCount !== 0) {
        return fail('UNEXPECTED_IMPUTATION', `tradingDate '${session.tradingDate}' target '${target}' has ${descriptor.derivedImputedConstituentRowCount} imputed constituent row(s) -- 2025 must have zero imputation`);
      }
      if (descriptor.sourceRowCount !== expectedRowCount) {
        return fail('WRONG_SESSION_SOURCE_ROW_COUNT', `tradingDate '${session.tradingDate}': expected sourceRowCount ${expectedRowCount} (certified window length), got ${descriptor.sourceRowCount}`);
      }
      const shape = expectedShape[target];
      if (descriptor.outputCandleCount !== shape.outputCandleCount || descriptor.structuralTrailingRowCount !== shape.structuralTrailingRowCount) {
        return fail(
          'WRONG_SESSION_TARGET_SHAPE',
          `tradingDate '${session.tradingDate}' target '${target}': expected outputCandleCount=${shape.outputCandleCount}/structuralTrailingRowCount=${shape.structuralTrailingRowCount} (deterministic floor-division shape for a ${expectedRowCount}-minute window), got ${descriptor.outputCandleCount}/${descriptor.structuralTrailingRowCount}`
        );
      }
      totals[target].outputCandleCount += descriptor.outputCandleCount;
      totals[target].structuralTrailingRowCount += descriptor.structuralTrailingRowCount;
      totals[target].candlesContainingImputation += descriptor.candlesContainingImputation;
    }
  }

  return { failure: null, totals };
}

/**
 * Re-derives every (date, target) pair's actual candles through the SAME
 * verified read boundary (`ResearchUnderlyingResampledSessionReaderService`)
 * a future consumer would use, and independently proves, for EVERY candle in
 * all 249 x 3 = 747 pairs: `availableAt === MAX(constituent availableAt)`
 * (never a synthetic/forward-filled value) and `quality === REAL_CANONICAL_ONLY`
 * (2025 has zero derived/imputed content -- true for the three
 * composite-repaired dates too, since their constituents are still real
 * canonical rows). For both certified 2025 special sessions, ALSO proves no
 * bucket bridges outside its certified window.
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
            failure: { code: 'NON_REAL_CANONICAL_QUALITY', message: `${session.tradingDate}/${target} bucket ${candle.bucketStart.toISOString()}: quality is '${candle.quality}', expected REAL_CANONICAL_ONLY for 2025 (real-canonical and composite-repaired constituents are both REAL_CANONICAL)` },
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
export async function runNifty2025Resample(options: RunNifty2025ResampleOptions): Promise<boolean> {
  const { sourceAssemblyChecksum: rawChecksum, buildService, buildVerifier, output, errorOutput } = options;

  const checksumInput = validateSourceAssemblyChecksumInput(rawChecksum);
  if ('code' in checksumInput) {
    errorOutput(['[B_M11_2025_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${checksumInput.code}`, `message=${checksumInput.message}`].join('\n'));
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
    errorOutput(['[B_M11_2025_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=BUILD_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const { failure: postconditionFailure, totals } = validateLockedProductionPostconditions(result.manifest, sourceAssemblyChecksum);
  if (postconditionFailure) {
    errorOutput(['[B_M11_2025_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  const verifier = buildVerifier();
  const { failure: noLookaheadFailure, verifiedSessionTargetPairs } = await validateNoLookaheadAcrossAllSessions(verifier, result.manifest, result.sourceAssembly);
  if (noLookaheadFailure) {
    errorOutput(['[B_M11_2025_RESEARCH_RESAMPLING]', 'status=FAILED', `code=${noLookaheadFailure.code}`, `message=${noLookaheadFailure.message}`].join('\n'));
    return false;
  }

  let manifestStorage: ContentAddressedJsonStoreResult;
  try {
    manifestStorage = service.persistManifest(result.manifest);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_RESAMPLING]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result, manifestStorage, verifiedSessionTargetPairs, totals));
  return true;
}

function describeStorage(storage: ContentAddressedJsonStoreResult): string {
  return `${storage.relativePath} (wasNewlyWritten=${storage.wasNewlyWritten})`;
}

function formatSuccessOutput(
  result: BuildYearResamplingManifestResult,
  manifestStorage: ContentAddressedJsonStoreResult,
  verifiedSessionTargetPairs: number,
  totals: Readonly<Record<ResampleTargetTimeframe, YearTotals>>
): string {
  const { manifest } = result;
  // Informational only -- the ACTUAL totals this real run produced, never gated against a pre-guessed
  // number (task instruction: "let the real run produce authoritative 2m/3m/5m counts").
  const totalsLines = RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.map(
    (target) => `total${target}=outputCandles:${totals[target].outputCandleCount}/trailing:${totals[target].structuralTrailingRowCount}/imputation:${totals[target].candlesContainingImputation}`
  );
  return [
    '[B_M11_2025_RESEARCH_RESAMPLING]',
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
    ...totalsLines,
    `manifestContentChecksum=${manifest.manifestContentChecksum}`,
    `manifestArtifact=${describeStorage(manifestStorage)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2025Resample({
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
    console.error('[B_M11_2025_RESEARCH_RESAMPLING] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
