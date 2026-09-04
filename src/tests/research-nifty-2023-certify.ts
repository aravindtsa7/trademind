import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';
import NiftyUnderlyingResearchCertificationService from '../modules/research-lake/services/nifty-underlying-research-certification.service';

dotenv.config();
logger.silent = true;

/**
 * B-M9 operator runner: certifies the fully end-to-end 2023 NIFTY Historical
 * Research Lake dataset -- canonical manifest, VERIFIED canonical Parquet
 * physical storage for all 246 sessions, the trusted B-M7.2/B-M7.3 artifacts,
 * every one of the 246 certified 1-minute research sessions, and all
 * 246 x 3 = 738 (date, target) resampled reads -- and, ONLY if every locked
 * postcondition passes, persists ONE compact content-addressed certification
 * artifact. Reuses `NiftyUnderlyingResearchCertificationService` unmodified
 * -- the SAME B-M9 clean-year (0 authorized-derived) generalization the 2022
 * certification path already exercises for its 1-derived March-7 topology.
 *
 * CHECKSUM HANDOFF (task: "Do NOT invent placeholder checksum constants"):
 * the 2023 canonical/assembly/resampling-manifest checksums are not known
 * until `research:nifty-2023:assemble` and `research:nifty-2023:resample`
 * have actually been run for real, so this CLI requires all THREE as
 * explicit operator inputs via the narrow, year-specific
 * `RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM`,
 * `RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM`, and
 * `RESEARCH_NIFTY_2023_RESAMPLING_MANIFEST_CHECKSUM` environment variables
 * (the first two are the SAME values already supplied to
 * `research:nifty-2023:materialize-storage`/`research:nifty-2023:resample`).
 * All three are format-validated (exactly 64 lowercase hex characters)
 * BEFORE use; the underlying `NiftyUnderlyingResearchCertificationService`
 * then independently re-verifies every referenced artifact's own
 * content-addressed checksum and cross-binding BEFORE any certification
 * work begins -- missing/malformed operator input fails closed before any
 * work begins; a well-formed but wrong checksum fails closed via the
 * service's own existing safety gates before any write.
 *
 * Unlike 2022, this CLI does NOT print a misleading
 * `march7NoLookaheadProofsVerified=...` line -- 2023 has zero
 * authorized-derived sessions, so no March-7-style proof exists at all. It
 * instead reports `authorizedDerivedSessions=0` and `derivedProofRequired=false`
 * explicitly.
 *
 * Never calls `ResearchYearRunnerService`. Zero provider calls, zero
 * canonical DB writes.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation AND
 * `npm run research:nifty-2023:materialize-storage` has been run for real:
 *   $env:RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM = "<checksum>"
 *   $env:RESEARCH_NIFTY_2023_RESAMPLING_MANIFEST_CHECKSUM = "<checksum>"
 *   npm run research:nifty-2023:certify
 */

const LOCKED_YEAR = 2023;
const EXPECTED_SESSIONS = 246;
const EXPECTED_VERIFIED_TARGET_PAIRS = EXPECTED_SESSIONS * 3;

const CANONICAL_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM';
const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM';
const RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_RESAMPLING_MANIFEST_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

const LOCKED_TARGET_TOTALS: Readonly<Record<ResampleTargetTimeframe, { totalOutputCandles: number; totalStructuralTrailingRows: number; totalCandlesContainingImputation: number }>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { totalOutputCandles: 45845, totalStructuralTrailingRows: 245, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { totalOutputCandles: 30645, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { totalOutputCandles: 18387, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
};

export type CertifyYear = Pick<NiftyUnderlyingResearchCertificationService, 'certifyYear' | 'persistCertification'>;

export interface RunNifty2023CertifyOptions {
  /** Operator-supplied upstream checksums (normally read from the three RESEARCH_NIFTY_2023_* environment variables) -- injected explicitly here so tests never read real environment variables. */
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
    return { code: 'MISSING_CANONICAL_MANIFEST_CHECKSUM', message: `environment variable ${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2023 canonicalManifestChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(canonical)) {
    return { code: 'MALFORMED_CANONICAL_MANIFEST_CHECKSUM', message: `${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${canonical}'` };
  }
  if (!assembly) {
    return { code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM', message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2023 researchAssemblyChecksum` };
  }
  if (!CHECKSUM_PATTERN.test(assembly)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${assembly}'` };
  }
  if (!resampling) {
    return { code: 'MISSING_RESAMPLING_MANIFEST_CHECKSUM', message: `environment variable ${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2023 manifestContentChecksum produced by 'npm run research:nifty-2023:resample'` };
  }
  if (!CHECKSUM_PATTERN.test(resampling)) {
    return { code: 'MALFORMED_RESAMPLING_MANIFEST_CHECKSUM', message: `${RESAMPLING_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${resampling}'` };
  }
  return { canonicalManifestChecksum: canonical, sourceAssemblyChecksum: assembly, resamplingManifestChecksum: resampling };
}

/**
 * The ONE locked production postcondition gate for the 2023 end-to-end
 * certification. Deliberately hardcodes 246/0-derived/the exact 2m-3m-5m
 * aggregate totals -- acceptable and REQUIRED at this operator postcondition
 * boundary (never inside the generic `NiftyUnderlyingResearchCertificationService`).
 * Explicitly REQUIRES the clean-year (0 authorized-derived) shape -- if the
 * certification unexpectedly reports any authorized-derived session or a
 * non-null derived proof/checksum field, this fails closed rather than
 * silently accepting it.
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
  // The most SPECIFIC/actionable diagnostic (which tier unexpectedly gained a session) is checked
  // BEFORE the aggregate realCanonicalSessions count, mirroring the 2023 assembly CLI's convention --
  // given a fixed EXPECTED_SESSIONS total, any unexpected tier2/tier3 session necessarily also
  // depresses realCanonicalSessions, so reporting the specific tier first is more actionable.
  if (certification.summary.authorizedDerivedSessions !== 0) {
    return { code: 'UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS', message: `expected 0 authorized-derived sessions for the clean 2023 canonical year, got ${certification.summary.authorizedDerivedSessions}` };
  }
  if (certification.summary.compositeRepairedSessions !== 0) {
    return { code: 'UNEXPECTED_COMPOSITE_REPAIRED_SESSIONS', message: `expected 0 composite-repaired sessions for the clean 2023 canonical year, got ${certification.summary.compositeRepairedSessions}` };
  }
  if (certification.summary.realCanonicalSessions !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} real-canonical sessions, got ${certification.summary.realCanonicalSessions}` };
  }
  if (certification.derivedSnapshotChecksum !== null || certification.derivedSessionChecksum !== null || certification.march7Proof !== null) {
    return {
      code: 'UNEXPECTED_DERIVED_PROOF_FIELDS',
      message: `expected derivedSnapshotChecksum/derivedSessionChecksum/march7Proof all null for the clean 2023 canonical year, got derivedSnapshotChecksum=${JSON.stringify(certification.derivedSnapshotChecksum)} derivedSessionChecksum=${JSON.stringify(certification.derivedSessionChecksum)} march7Proof=${certification.march7Proof === null ? 'null' : 'non-null'}`,
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

  return null;
}

/**
 * Returns `true` only on a fully-certified, postcondition-validated, and
 * persisted 2023 end-to-end certification; `false` on any failure. Never
 * throws. The trusted certification artifact is written ONLY after every
 * check passes.
 */
export async function runNifty2023Certify(options: RunNifty2023CertifyOptions): Promise<boolean> {
  const { canonicalManifestChecksum: rawCanonical, sourceAssemblyChecksum: rawAssembly, resamplingManifestChecksum: rawResampling, buildService, output, errorOutput } = options;

  const checksumInputs = validateChecksumInputs(rawCanonical, rawAssembly, rawResampling);
  if ('code' in checksumInputs) {
    errorOutput(['[B_M9_2023_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${checksumInputs.code}`, `message=${checksumInputs.message}`].join('\n'));
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
    errorOutput(['[B_M9_2023_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=CERTIFY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result, checksumInputs);
  if (postconditionFailure) {
    errorOutput(['[B_M9_2023_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  let stored;
  try {
    stored = service.persistCertification(result.certification);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const verifiedTargetPairs = result.certification.sessions.reduce((total, session) => total + session.targets.length, 0);
  output(
    [
      '[B_M9_2023_RESEARCH_CERTIFICATION]',
      'status=SUCCESS',
      `year=${LOCKED_YEAR}`,
      `expectedSessions=${result.certification.summary.expectedSessions}`,
      `verifiedSessions=${result.certification.summary.verifiedSessions}`,
      `realCanonicalSessions=${result.certification.summary.realCanonicalSessions}`,
      `authorizedDerivedSessions=${result.certification.summary.authorizedDerivedSessions}`,
      // Never a misleading march7NoLookaheadProofsVerified=true for a clean year -- 2023 has zero authorized-derived
      // sessions, so no March-7-style proof exists to verify. Report the clean-year facts explicitly instead.
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
  const success = await runNifty2023Certify({
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
    console.error('[B_M9_2023_RESEARCH_CERTIFICATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
