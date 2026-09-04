import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';
import NiftyUnderlyingResearchCertificationService from '../modules/research-lake/services/nifty-underlying-research-certification.service';

dotenv.config();
logger.silent = true;

/**
 * B-M10 operator runner: certifies the fully end-to-end 2024 NIFTY Historical
 * Research Lake dataset -- canonical manifest, VERIFIED canonical Parquet
 * physical storage for all 249 sessions, the trusted B-M7.2/B-M7.3 artifacts,
 * every one of the 249 certified 1-minute research sessions, and all
 * 249 x 3 = 747 (date, target) resampled reads -- and, ONLY if every locked
 * postcondition passes, persists ONE compact content-addressed certification
 * artifact. Reuses `NiftyUnderlyingResearchCertificationService` unmodified.
 *
 * UNLIKE 2023 (a CLEAN canonical year, 0 composite-repaired), 2024 carries
 * exactly ONE composite-repaired session (2024-12-12). This is a DIFFERENT
 * axis from the March-7-style derived-topology coherence rule: `authorizedDerivedSessions`
 * (tier 3) drives whether `derivedSnapshotChecksum`/`derivedSessionChecksum`/
 * `march7Proof` must be null (see `assertCoherentDerivedTopology` in
 * `research-underlying-year-certification.types.ts`) -- 2024 has ZERO
 * authorized-derived sessions, so it is still a "clean" derived topology and
 * those three fields remain null, exactly like 2023. `compositeRepairedSessions`
 * (tier 2) is an entirely separate count this CLI asserts is exactly 1, at
 * exactly the reviewed 2024-12-12 date -- never conflated with the
 * derived-proof coherence rule above.
 *
 * CHECKSUM HANDOFF: the 2024 canonical/assembly/resampling-manifest
 * checksums are not known until `research:nifty-2024:assemble` and
 * `research:nifty-2024:resample` have actually been run for real, so this
 * CLI requires all THREE as explicit operator inputs via the narrow,
 * year-specific `RESEARCH_NIFTY_2024_CANONICAL_MANIFEST_CHECKSUM`,
 * `RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM`, and
 * `RESEARCH_NIFTY_2024_RESAMPLING_MANIFEST_CHECKSUM` environment variables.
 * All three are format-validated (exactly 64 lowercase hex characters)
 * BEFORE use.
 *
 * Never calls `ResearchYearRunnerService`. Zero provider calls, zero
 * canonical DB writes.
 *
 * Usage (PowerShell), once reviewed AND `npm run research:nifty-2024:materialize-storage`
 * has been run for real:
 *   $env:RESEARCH_NIFTY_2024_CANONICAL_MANIFEST_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2024_RESAMPLING_MANIFEST_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2024:certify
 */

const LOCKED_YEAR = 2024;
const EXPECTED_SESSIONS = 249;
const EXPECTED_REAL_CANONICAL_SESSIONS = 248;
const EXPECTED_COMPOSITE_REPAIRED_SESSIONS = 1;
const EXPECTED_COMPOSITE_REPAIRED_TRADING_DATES: readonly string[] = ['2024-12-12'];
const EXPECTED_VERIFIED_TARGET_PAIRS = EXPECTED_SESSIONS * 3;

const CANONICAL_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2024_CANONICAL_MANIFEST_CHECKSUM';
const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2024_SOURCE_ASSEMBLY_CHECKSUM';
const RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2024_RESAMPLING_MANIFEST_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

const LOCKED_TARGET_TOTALS: Readonly<Record<ResampleTargetTimeframe, { totalOutputCandles: number; totalStructuralTrailingRows: number; totalCandlesContainingImputation: number }>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { totalOutputCandles: 46136, totalStructuralTrailingRows: 248, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { totalOutputCandles: 30840, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { totalOutputCandles: 18504, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
};

export type CertifyYear = Pick<NiftyUnderlyingResearchCertificationService, 'certifyYear' | 'persistCertification'>;

export interface RunNifty2024CertifyOptions {
  /** Operator-supplied upstream checksums (normally read from the three RESEARCH_NIFTY_2024_* environment variables) -- injected explicitly here so tests never read real environment variables. */
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
    return { code: 'MISSING_CANONICAL_MANIFEST_CHECKSUM', message: `environment variable ${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2024 canonicalManifestChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(canonical)) {
    return { code: 'MALFORMED_CANONICAL_MANIFEST_CHECKSUM', message: `${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${canonical}'` };
  }
  if (!assembly) {
    return { code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM', message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2024 researchAssemblyChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(assembly)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${assembly}'` };
  }
  if (!resampling) {
    return { code: 'MISSING_RESAMPLING_MANIFEST_CHECKSUM', message: `environment variable ${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2024 manifestContentChecksum produced by 'npm run research:nifty-2024:resample'` };
  }
  if (!CHECKSUM_PATTERN.test(resampling)) {
    return { code: 'MALFORMED_RESAMPLING_MANIFEST_CHECKSUM', message: `${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${resampling}'` };
  }
  return { canonicalManifestChecksum: canonical, sourceAssemblyChecksum: assembly, resamplingManifestChecksum: resampling };
}

/**
 * The ONE locked production postcondition gate for the 2024 end-to-end
 * certification. Deliberately hardcodes 249/248-real/1-composite-repaired-at-
 * 2024-12-12/0-derived/the exact 2m-3m-5m aggregate totals -- acceptable and
 * REQUIRED at this operator postcondition boundary (never inside the generic
 * `NiftyUnderlyingResearchCertificationService`). UNLIKE 2023, does NOT
 * require zero composite-repaired sessions.
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
  // Most-specific-tier-first ordering (matches the 2023 CLI's convention): given a fixed
  // EXPECTED_SESSIONS total, any unexpected tier deviation necessarily also depresses
  // realCanonicalSessions, so reporting the specific tier first is more actionable.
  if (certification.summary.authorizedDerivedSessions !== 0) {
    return { code: 'UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS', message: `expected 0 authorized-derived sessions for 2024, got ${certification.summary.authorizedDerivedSessions}` };
  }
  if (certification.summary.compositeRepairedSessions !== EXPECTED_COMPOSITE_REPAIRED_SESSIONS) {
    return { code: 'WRONG_COMPOSITE_REPAIRED_SESSION_COUNT', message: `expected exactly ${EXPECTED_COMPOSITE_REPAIRED_SESSIONS} composite-repaired session for 2024 (the reviewed 2024-12-12 repair), got ${certification.summary.compositeRepairedSessions}` };
  }
  if (certification.summary.realCanonicalSessions !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_SESSION_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} real-canonical sessions, got ${certification.summary.realCanonicalSessions}` };
  }
  // authorizedDerivedSessions === 0 drives the CLEAN derived-topology branch of
  // `assertCoherentDerivedTopology` -- these three fields must remain null for 2024, exactly like the
  // clean 2023 year, REGARDLESS of 2024's non-zero compositeRepairedSessions count (a separate axis).
  if (certification.derivedSnapshotChecksum !== null || certification.derivedSessionChecksum !== null || certification.march7Proof !== null) {
    return {
      code: 'UNEXPECTED_DERIVED_PROOF_FIELDS',
      message: `expected derivedSnapshotChecksum/derivedSessionChecksum/march7Proof all null for 2024 (zero authorized-derived sessions), got derivedSnapshotChecksum=${JSON.stringify(certification.derivedSnapshotChecksum)} derivedSessionChecksum=${JSON.stringify(certification.derivedSessionChecksum)} march7Proof=${certification.march7Proof === null ? 'null' : 'non-null'}`,
    };
  }
  if (certification.sessions.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_MANIFEST_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} certified session records, got ${certification.sessions.length}` };
  }
  for (const session of certification.sessions) {
    if (session.targets.length !== 3 || session.targets.some((target) => !target.noLookaheadVerified)) {
      return { code: 'NO_LOOKAHEAD_NOT_VERIFIED', message: `tradingDate '${session.tradingDate}' has an unverified no-lookahead target record` };
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
    const expectedTotals = LOCKED_TARGET_TOTALS[target];
    if (actual.sessionCount !== EXPECTED_SESSIONS || actual.completeSessionCount !== EXPECTED_SESSIONS) {
      return { code: 'WRONG_TARGET_SESSION_COUNT', message: `target '${target}': expected sessionCount=completeSessionCount=${EXPECTED_SESSIONS}, got sessionCount=${actual.sessionCount} completeSessionCount=${actual.completeSessionCount}` };
    }
    if (actual.totalOutputCandles !== expectedTotals.totalOutputCandles || actual.totalStructuralTrailingRows !== expectedTotals.totalStructuralTrailingRows || actual.totalCandlesContainingImputation !== expectedTotals.totalCandlesContainingImputation) {
      return {
        code: 'WRONG_TARGET_AGGREGATE_TOTALS',
        message: `target '${target}': expected totalOutputCandles=${expectedTotals.totalOutputCandles}/totalStructuralTrailingRows=${expectedTotals.totalStructuralTrailingRows}/totalCandlesContainingImputation=${expectedTotals.totalCandlesContainingImputation}, got ${actual.totalOutputCandles}/${actual.totalStructuralTrailingRows}/${actual.totalCandlesContainingImputation}`,
      };
    }
  }

  // Never assumes 2024-12-12 is the composite-repaired date without checking -- derives it from the
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
    return { code: 'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SESSION_PRESENT', message: `expected every certified 2024 session to be real-canonical or the one reviewed composite-repaired date, found unexpected-tier date(s): [${nonQualifyingDates.join(',')}]` };
  }

  return null;
}

/**
 * Returns `true` only on a fully-certified, postcondition-validated, and
 * persisted 2024 end-to-end certification; `false` on any failure. Never
 * throws. The trusted certification artifact is written ONLY after every
 * check passes.
 */
export async function runNifty2024Certify(options: RunNifty2024CertifyOptions): Promise<boolean> {
  const { canonicalManifestChecksum: rawCanonical, sourceAssemblyChecksum: rawAssembly, resamplingManifestChecksum: rawResampling, buildService, output, errorOutput } = options;

  const checksumInputs = validateChecksumInputs(rawCanonical, rawAssembly, rawResampling);
  if ('code' in checksumInputs) {
    errorOutput(['[B_M10_2024_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${checksumInputs.code}`, `message=${checksumInputs.message}`].join('\n'));
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
    errorOutput(['[B_M10_2024_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=CERTIFY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result, checksumInputs);
  if (postconditionFailure) {
    errorOutput(['[B_M10_2024_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  let stored;
  try {
    stored = service.persistCertification(result.certification);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M10_2024_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const verifiedTargetPairs = result.certification.sessions.reduce((total, session) => total + session.targets.length, 0);
  const compositeRepairedTradingDates = result.certification.sessions
    .filter((session) => session.sourcePrecedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .join(',');
  output(
    [
      '[B_M10_2024_RESEARCH_CERTIFICATION]',
      'status=SUCCESS',
      `year=${LOCKED_YEAR}`,
      `expectedSessions=${result.certification.summary.expectedSessions}`,
      `verifiedSessions=${result.certification.summary.verifiedSessions}`,
      `realCanonicalSessions=${result.certification.summary.realCanonicalSessions}`,
      `compositeRepairedSessions=${result.certification.summary.compositeRepairedSessions}`,
      `compositeRepairedTradingDates=${compositeRepairedTradingDates || 'NONE'}`,
      `authorizedDerivedSessions=${result.certification.summary.authorizedDerivedSessions}`,
      // Never a misleading march7NoLookaheadProofsVerified=true for 2024 -- zero authorized-derived
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
  const success = await runNifty2024Certify({
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
    console.error('[B_M10_2024_RESEARCH_CERTIFICATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
