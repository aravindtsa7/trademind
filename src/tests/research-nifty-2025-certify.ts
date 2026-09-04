import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { CertifiedSessionRecord } from '../modules/research-lake/domain/research-underlying-year-certification.types';
import { CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';
import NiftyUnderlyingResearchCertificationService from '../modules/research-lake/services/nifty-underlying-research-certification.service';

dotenv.config();
logger.silent = true;

/**
 * B-M11 operator runner: certifies the fully end-to-end 2025 NIFTY Historical
 * Research Lake dataset -- canonical manifest, VERIFIED canonical Parquet
 * physical storage for all 249 sessions, the trusted B-M7.2/B-M7.3 artifacts,
 * every one of the 249 certified 1-minute research sessions, and all
 * 249 x 3 = 747 (date, target) resampled reads -- and, ONLY if every locked
 * postcondition passes, persists ONE compact content-addressed certification
 * artifact. Reuses `NiftyUnderlyingResearchCertificationService` unmodified.
 *
 * UNLIKE 2024 (exactly ONE composite-repaired session), 2025 carries THREE
 * -- 2025-03-25, 2025-04-04, 2025-04-23. This is a DIFFERENT axis from the
 * March-7-style derived-topology coherence rule: `authorizedDerivedSessions`
 * (tier 3) drives whether `derivedSnapshotChecksum`/`derivedSessionChecksum`/
 * `march7Proof` must be null (see `assertCoherentDerivedTopology` in
 * `research-underlying-year-certification.types.ts`) -- 2025 has ZERO
 * authorized-derived sessions, so it is still a "clean" derived topology and
 * those three fields remain null, exactly like 2023/2024.
 * `compositeRepairedSessions` (tier 2) is an entirely separate count this
 * CLI asserts is exactly 3, at exactly the three reviewed dates -- never
 * conflated with the derived-proof coherence rule above.
 *
 * UNLIKE 2024, this CLI does NOT hardcode a year-level aggregate 2m/3m/5m
 * candle total (task instruction: "do not hardcode resample output totals
 * unless derived from the existing deterministic service -- let the real
 * run produce authoritative counts"). Instead it validates EVERY certified
 * session record individually against one of exactly two DETERMINISTIC
 * per-session shapes derived from certified window length alone (the SAME
 * floor-division rule the reviewed, unmodified resampler already applied
 * upstream, never re-implemented here): a certified single 375-minute
 * session (every ordinary trading day, 2025-02-01, and all three
 * composite-repaired dates) always produces 187/125/75 (2m/3m/5m) output
 * candles with 1/0/0 structural trailing rows; the certified single
 * 60-minute 2025-10-21 Muhurat session always produces 30/20/12 with 0/0/0
 * trailing. `certification.summary.byTarget[*].sessionCount/completeSessionCount`
 * (a pure session-count fact, not a candle total) is still asserted exactly.
 *
 * CHECKSUM HANDOFF: the 2025 canonical/assembly/resampling-manifest
 * checksums are not known until `research:nifty-2025:assemble` and
 * `research:nifty-2025:resample` have actually been run for real, so this
 * CLI requires all THREE as explicit operator inputs via the narrow,
 * year-specific `RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM`,
 * `RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM`, and
 * `RESEARCH_NIFTY_2025_RESAMPLING_MANIFEST_CHECKSUM` environment variables.
 * All three are format-validated (exactly 64 lowercase hex characters)
 * BEFORE use.
 *
 * Never calls `ResearchYearRunnerService`. Zero provider calls, zero
 * canonical DB writes.
 *
 * Usage (PowerShell), once reviewed AND `npm run research:nifty-2025:materialize-storage`
 * has been run for real:
 *   $env:RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2025_RESAMPLING_MANIFEST_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2025:certify
 */

const LOCKED_YEAR = 2025;
const EXPECTED_SESSIONS = 249;
const EXPECTED_REAL_CANONICAL_SESSIONS = 246;
const EXPECTED_COMPOSITE_REPAIRED_SESSIONS = 3;
const EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];
const EXPECTED_VERIFIED_TARGET_PAIRS = EXPECTED_SESSIONS * 3;

const OCT21_DATE = '2025-10-21';

interface TargetShape {
  readonly outputCandleCount: number;
  readonly structuralTrailingRowCount: number;
}

/** Deterministic floor-division shape for ANY certified single 375-minute window session -- see this file's own module doc. Never a hardcoded year-total. */
const REGULAR_375_SHAPE: Readonly<Record<ResampleTargetTimeframe, TargetShape>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 187, structuralTrailingRowCount: 1 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 125, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 75, structuralTrailingRowCount: 0 },
};

/** Deterministic floor-division shape for the certified single 60-minute 2025-10-21 Muhurat window. */
const MUHURAT_60_SHAPE: Readonly<Record<ResampleTargetTimeframe, TargetShape>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 30, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 20, structuralTrailingRowCount: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 12, structuralTrailingRowCount: 0 },
};

function expectedRowCountFor(tradingDate: string): number {
  return tradingDate === OCT21_DATE ? 60 : 375;
}

function expectedShapeFor(tradingDate: string): Readonly<Record<ResampleTargetTimeframe, TargetShape>> {
  return tradingDate === OCT21_DATE ? MUHURAT_60_SHAPE : REGULAR_375_SHAPE;
}

const CANONICAL_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM';
const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM';
const RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_RESAMPLING_MANIFEST_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export type CertifyYear = Pick<NiftyUnderlyingResearchCertificationService, 'certifyYear' | 'persistCertification'>;

export interface RunNifty2025CertifyOptions {
  /** Operator-supplied upstream checksums (normally read from the three RESEARCH_NIFTY_2025_* environment variables) -- injected explicitly here so tests never read real environment variables. */
  readonly canonicalManifestChecksum: string | undefined;
  readonly sourceAssemblyChecksum: string | undefined;
  readonly resamplingManifestChecksum: string | undefined;
  readonly buildService: () => CertifyYear;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

interface ValidatedChecksumInputs {
  readonly canonicalManifestChecksum: string;
  readonly sourceAssemblyChecksum: string;
  readonly resamplingManifestChecksum: string;
}

function validateChecksumInputs(canonical: string | undefined, assembly: string | undefined, resampling: string | undefined): ValidatedChecksumInputs | PostconditionFailure {
  if (!canonical) {
    return { code: 'MISSING_CANONICAL_MANIFEST_CHECKSUM', message: `environment variable ${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2025 canonicalManifestChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(canonical)) {
    return { code: 'MALFORMED_CANONICAL_MANIFEST_CHECKSUM', message: `${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${canonical}'` };
  }
  if (!assembly) {
    return { code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM', message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2025 researchAssemblyChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(assembly)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${assembly}'` };
  }
  if (!resampling) {
    return { code: 'MISSING_RESAMPLING_MANIFEST_CHECKSUM', message: `environment variable ${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2025 manifestContentChecksum produced by 'npm run research:nifty-2025:resample'` };
  }
  if (!CHECKSUM_PATTERN.test(resampling)) {
    return { code: 'MALFORMED_RESAMPLING_MANIFEST_CHECKSUM', message: `${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${resampling}'` };
  }
  return { canonicalManifestChecksum: canonical, sourceAssemblyChecksum: assembly, resamplingManifestChecksum: resampling };
}

/**
 * The ONE locked production postcondition gate for the 2025 end-to-end
 * certification. Deliberately hardcodes 249/246-real/3-composite-repaired-at-
 * the-three-reviewed-dates/0-derived -- acceptable and REQUIRED at this
 * operator postcondition boundary (never inside the generic
 * `NiftyUnderlyingResearchCertificationService`). UNLIKE 2024, does NOT
 * assert a year-level aggregate candle total (see this file's own module
 * doc) -- it validates each certified session record's own target shape
 * instead.
 */
function validateLockedPostconditions(result: CertifyYearResult, expected: ValidatedChecksumInputs): PostconditionFailure | null {
  const { certification } = result;

  if (certification.canonicalManifest.datasetChecksum !== expected.canonicalManifestChecksum) {
    return { code: 'WRONG_CANONICAL_CHECKSUM', message: `expected canonical datasetChecksum '${expected.canonicalManifestChecksum}', got '${certification.canonicalManifest.datasetChecksum}'` };
  }
  if (certification.sourceAssemblyChecksum !== expected.sourceAssemblyChecksum) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected B-M7.2 checksum '${expected.sourceAssemblyChecksum}', got '${certification.sourceAssemblyChecksum}'` };
  }
  if (certification.resamplingManifestChecksum !== expected.resamplingManifestChecksum) {
    return { code: 'WRONG_RESAMPLING_MANIFEST_CHECKSUM', message: `expected B-M7.3 checksum '${expected.resamplingManifestChecksum}', got '${certification.resamplingManifestChecksum}'` };
  }
  if (certification.identity.year !== LOCKED_YEAR) {
    return { code: 'WRONG_YEAR', message: `expected year ${LOCKED_YEAR}, got ${certification.identity.year}` };
  }
  if (certification.summary.expectedSessions !== EXPECTED_SESSIONS || certification.summary.verifiedSessions !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_SESSION_COUNT', message: `expected expectedSessions=verifiedSessions=${EXPECTED_SESSIONS}, got expected=${certification.summary.expectedSessions} verified=${certification.summary.verifiedSessions}` };
  }
  if (certification.summary.unavailableSessions !== 0) {
    return { code: 'UNAVAILABLE_SESSIONS_PRESENT', message: `expected 0 unavailable sessions, got ${certification.summary.unavailableSessions}` };
  }
  // Most-specific-tier-first ordering (matches the 2023/2024 CLI's convention): given a fixed
  // EXPECTED_SESSIONS total, any unexpected tier deviation necessarily also depresses
  // realCanonicalSessions, so reporting the specific tier first is more actionable.
  if (certification.summary.authorizedDerivedSessions !== 0) {
    return { code: 'UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS', message: `expected 0 authorized-derived sessions for 2025, got ${certification.summary.authorizedDerivedSessions}` };
  }
  if (certification.summary.compositeRepairedSessions !== EXPECTED_COMPOSITE_REPAIRED_SESSIONS) {
    return { code: 'WRONG_COMPOSITE_REPAIRED_SESSION_COUNT', message: `expected exactly ${EXPECTED_COMPOSITE_REPAIRED_SESSIONS} composite-repaired sessions for 2025 (the three reviewed repairs), got ${certification.summary.compositeRepairedSessions}` };
  }
  if (certification.summary.realCanonicalSessions !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_SESSION_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} real-canonical sessions, got ${certification.summary.realCanonicalSessions}` };
  }
  // authorizedDerivedSessions === 0 drives the CLEAN derived-topology branch of
  // `assertCoherentDerivedTopology` -- these three fields must remain null for 2025, exactly like
  // 2023/2024, REGARDLESS of 2025's non-zero compositeRepairedSessions count (a separate axis).
  if (certification.derivedSnapshotChecksum !== null || certification.derivedSessionChecksum !== null || certification.march7Proof !== null) {
    return {
      code: 'UNEXPECTED_DERIVED_PROOF_FIELDS',
      message: `expected derivedSnapshotChecksum/derivedSessionChecksum/march7Proof all null for 2025 (zero authorized-derived sessions), got derivedSnapshotChecksum=${JSON.stringify(certification.derivedSnapshotChecksum)} derivedSessionChecksum=${JSON.stringify(certification.derivedSessionChecksum)} march7Proof=${certification.march7Proof === null ? 'null' : 'non-null'}`,
    };
  }
  if (certification.sessions.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_MANIFEST_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} certified session records, got ${certification.sessions.length}` };
  }

  for (const session of certification.sessions) {
    if (session.targets.length !== 3 || session.targets.some((target) => !target.noLookaheadVerified)) {
      return { code: 'NO_LOOKAHEAD_NOT_VERIFIED', message: `tradingDate '${session.tradingDate}' has an unverified no-lookahead target record` };
    }
    const expectedRowCount = expectedRowCountFor(session.tradingDate);
    if (session.sourceRowCount !== expectedRowCount) {
      return { code: 'WRONG_SESSION_SOURCE_ROW_COUNT', message: `tradingDate '${session.tradingDate}': expected sourceRowCount ${expectedRowCount} (certified window length), got ${session.sourceRowCount}` };
    }
    const expectedShape = expectedShapeFor(session.tradingDate);
    for (const targetRecord of session.targets) {
      const shape = expectedShape[targetRecord.target];
      if (targetRecord.outputCandleCount !== shape.outputCandleCount || targetRecord.structuralTrailingRowCount !== shape.structuralTrailingRowCount) {
        return {
          code: 'WRONG_SESSION_TARGET_SHAPE',
          message: `tradingDate '${session.tradingDate}' target '${targetRecord.target}': expected outputCandleCount=${shape.outputCandleCount}/structuralTrailingRowCount=${shape.structuralTrailingRowCount} (deterministic floor-division shape for a ${expectedRowCount}-minute window), got ${targetRecord.outputCandleCount}/${targetRecord.structuralTrailingRowCount}`,
        };
      }
      if (targetRecord.candlesContainingImputation !== 0) {
        return { code: 'UNEXPECTED_IMPUTATION', message: `tradingDate '${session.tradingDate}' target '${targetRecord.target}' has ${targetRecord.candlesContainingImputation} imputation-containing candle(s) -- 2025 must have zero imputation` };
      }
    }
  }

  const verifiedTargetPairs = certification.sessions.reduce((total, session) => total + session.targets.length, 0);
  if (verifiedTargetPairs !== EXPECTED_VERIFIED_TARGET_PAIRS) {
    return { code: 'WRONG_VERIFIED_TARGET_PAIR_COUNT', message: `expected exactly ${EXPECTED_VERIFIED_TARGET_PAIRS} verified (date, target) pairs, got ${verifiedTargetPairs}` };
  }

  if (certification.physicalStorage.sessions.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_PHYSICAL_STORAGE_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} verified physical canonical storage sessions, got ${certification.physicalStorage.sessions.length}` };
  }

  for (const target of [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE] as const) {
    const actual = certification.summary.byTarget[target];
    if (actual.sessionCount !== EXPECTED_SESSIONS || actual.completeSessionCount !== EXPECTED_SESSIONS) {
      return { code: 'WRONG_TARGET_SESSION_COUNT', message: `target '${target}': expected sessionCount=completeSessionCount=${EXPECTED_SESSIONS}, got sessionCount=${actual.sessionCount} completeSessionCount=${actual.completeSessionCount}` };
    }
  }

  // Never assumes the three composite-repaired dates without checking -- derives them from the
  // certification's OWN per-session tier records and requires exact equality against the reviewed date set.
  const compositeRepairedTradingDates = certification.sessions
    .filter((session) => session.sourcePrecedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .sort();
  const expectedCompositeRepairedTradingDates = [...EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES].sort();
  if (compositeRepairedTradingDates.length !== expectedCompositeRepairedTradingDates.length || !compositeRepairedTradingDates.every((date, index) => date === expectedCompositeRepairedTradingDates[index])) {
    return {
      code: 'WRONG_COMPOSITE_REPAIRED_TRADING_DATES',
      message: `expected the composite-repaired trading date set to be exactly [${expectedCompositeRepairedTradingDates.join(',')}], got [${compositeRepairedTradingDates.join(',')}]`,
    };
  }
  const nonQualifyingDates = certification.sessions
    .filter((session) => session.sourcePrecedenceTier !== ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION && session.sourcePrecedenceTier !== ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate);
  if (nonQualifyingDates.length > 0) {
    return { code: 'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SESSION_PRESENT', message: `expected every certified 2025 session to be real-canonical or one of the three reviewed composite-repaired dates, found unexpected-tier date(s): [${nonQualifyingDates.join(',')}]` };
  }

  return null;
}

/**
 * Returns `true` only on a fully-certified, postcondition-validated, and
 * persisted 2025 end-to-end certification; `false` on any failure. Never
 * throws. The trusted certification artifact is written ONLY after every
 * check passes.
 */
export async function runNifty2025Certify(options: RunNifty2025CertifyOptions): Promise<boolean> {
  const { canonicalManifestChecksum: rawCanonical, sourceAssemblyChecksum: rawAssembly, resamplingManifestChecksum: rawResampling, buildService, output, errorOutput } = options;

  const checksumInputs = validateChecksumInputs(rawCanonical, rawAssembly, rawResampling);
  if ('code' in checksumInputs) {
    errorOutput(['[B_M11_2025_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${checksumInputs.code}`, `message=${checksumInputs.message}`].join('\n'));
    return false;
  }

  const service = buildService();
  let result: CertifyYearResult;
  try {
    result = await service.certifyYear({
      year: LOCKED_YEAR,
      expectedCanonicalDatasetChecksum: checksumInputs.canonicalManifestChecksum,
      sourceAssemblyChecksum: checksumInputs.sourceAssemblyChecksum,
      resamplingManifestChecksum: checksumInputs.resamplingManifestChecksum,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=CERTIFY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result, checksumInputs);
  if (postconditionFailure) {
    errorOutput(['[B_M11_2025_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  let stored;
  try {
    stored = service.persistCertification(result.certification);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const verifiedTargetPairs = result.certification.sessions.reduce((total, session) => total + session.targets.length, 0);
  const compositeRepairedTradingDates = result.certification.sessions
    .filter((session: CertifiedSessionRecord) => session.sourcePrecedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .sort()
    .join(',');
  output(
    [
      '[B_M11_2025_RESEARCH_CERTIFICATION]',
      'status=SUCCESS',
      `year=${LOCKED_YEAR}`,
      `expectedSessions=${result.certification.summary.expectedSessions}`,
      `verifiedSessions=${result.certification.summary.verifiedSessions}`,
      `realCanonicalSessions=${result.certification.summary.realCanonicalSessions}`,
      `compositeRepairedSessions=${result.certification.summary.compositeRepairedSessions}`,
      `compositeRepairedTradingDates=${compositeRepairedTradingDates || 'NONE'}`,
      `authorizedDerivedSessions=${result.certification.summary.authorizedDerivedSessions}`,
      // Never a misleading march7NoLookaheadProofsVerified=true for 2025 -- zero authorized-derived
      // sessions, so no March-7-style proof exists to verify. Report the clean-derived-topology facts explicitly.
      `derivedProofRequired=false`,
      `physicalStorageVerifiedSessionCount=${result.certification.physicalStorage.sessions.length}`,
      `verifiedTargetPairs=${verifiedTargetPairs}`,
      `certificationContentChecksum=${result.certification.certificationContentChecksum}`,
      `certificationArtifact=${stored.relativePath} (wasNewlyWritten=${stored.wasNewlyWritten})`,
    ].join('\n')
  );
  return true;
}

async function main(): Promise<void> {
  const success = await runNifty2025Certify({
    canonicalManifestChecksum: process.env[CANONICAL_MANIFEST_CHECKSUM_ENV_VAR],
    sourceAssemblyChecksum: process.env[SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR],
    resamplingManifestChecksum: process.env[RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR],
    buildService: () => new NiftyUnderlyingResearchCertificationService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M11_2025_RESEARCH_CERTIFICATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
