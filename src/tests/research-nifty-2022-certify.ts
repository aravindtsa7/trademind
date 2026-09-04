import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';
import NiftyUnderlyingResearchCertificationService from '../modules/research-lake/services/nifty-underlying-research-certification.service';

dotenv.config();
logger.silent = true;

/**
 * B-M8B operator runner: certifies the fully end-to-end 2022 NIFTY Historical
 * Research Lake dataset -- canonical manifest, VERIFIED canonical Parquet
 * physical storage, the trusted B-M7.1/B-M7.2/B-M7.3 artifacts, every one of
 * the 248 certified 1-minute research sessions, and all 744 (date, target)
 * resampled reads -- and, ONLY if every locked postcondition passes,
 * persists ONE compact content-addressed certification artifact.
 *
 * DELIBERATELY narrow -- no env override for year/instrument/timeframe/any
 * trusted checksum exists. Never calls `ResearchYearRunnerService` (out of
 * scope -- that service is acquisition/materialization-capable, this is a
 * read-only certification boundary). Zero provider calls, zero canonical DB
 * writes -- every read is either a certified-calendar lookup, an
 * already-established read-only `HistoricalCandle`/Parquet reconstruction
 * path, or a read of an already-trusted content-addressed artifact.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation AND
 * `npm run research:nifty-2022:materialize-storage` has been run for real:
 *   npm run research:nifty-2022:certify
 */

const LOCKED_YEAR = 2022;
const LOCKED_CANONICAL_DATASET_CHECKSUM = '1a7cf5e2f88a0f6bee8b687f92c80c291a8a7bcb15184b986639f431a76e5870';
const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const LOCKED_RESAMPLING_MANIFEST_CHECKSUM = '3881dc81c685ae16f60869f6faed2f9d9ebbf7a4ac5cafe89af7a9a33be3dd3b';
const EXPECTED_SESSIONS = 248;
const MARCH_7_DATE = '2022-03-07';

const LOCKED_MARCH7_NO_LOOKAHEAD_PROOFS: readonly { target: ResampleTargetTimeframe; bucketStartIst: string; expectedAvailableAtIst: string }[] = [
  { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26' },
  { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:23', expectedAvailableAtIst: '10:26' },
  { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26' },
  { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:24', expectedAvailableAtIst: '10:27' },
  { target: ResampleTargetTimeframe.FIVE_MINUTE, bucketStartIst: '10:20', expectedAvailableAtIst: '10:26' },
];

const LOCKED_TARGET_TOTALS: Readonly<Record<ResampleTargetTimeframe, { totalOutputCandles: number; totalStructuralTrailingRows: number; totalCandlesContainingImputation: number }>> = {
  [ResampleTargetTimeframe.TWO_MINUTE]: { totalOutputCandles: 46219, totalStructuralTrailingRows: 247, totalCandlesContainingImputation: 2 },
  [ResampleTargetTimeframe.THREE_MINUTE]: { totalOutputCandles: 30895, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 2 },
  [ResampleTargetTimeframe.FIVE_MINUTE]: { totalOutputCandles: 18537, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 1 },
};

export type CertifyYear = Pick<NiftyUnderlyingResearchCertificationService, 'certifyYear' | 'persistCertification'>;

export interface RunCertifyOptions {
  readonly buildService: () => CertifyYear;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The ONE locked production postcondition gate for the 2022 end-to-end
 * certification. Deliberately hardcodes 248/March-7/the 5 exact no-lookahead
 * proofs/the exact 2m-3m-5m aggregate totals -- acceptable and REQUIRED at
 * this operator postcondition boundary (never inside the generic
 * `NiftyUnderlyingResearchCertificationService`, which never hardcodes a
 * session count, a specific date, or an aggregate total).
 */
function validateLockedPostconditions(result: CertifyYearResult): PostconditionFailure | null {
  const { certification } = result;

  if (certification.canonicalManifest.datasetChecksum !== LOCKED_CANONICAL_DATASET_CHECKSUM) {
    return { code: 'WRONG_CANONICAL_CHECKSUM', message: `expected canonical datasetChecksum '${LOCKED_CANONICAL_DATASET_CHECKSUM}', got '${certification.canonicalManifest.datasetChecksum}'` };
  }
  if (certification.sourceAssemblyChecksum !== LOCKED_SOURCE_ASSEMBLY_CHECKSUM) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected B-M7.2 checksum '${LOCKED_SOURCE_ASSEMBLY_CHECKSUM}', got '${certification.sourceAssemblyChecksum}'` };
  }
  if (certification.resamplingManifestChecksum !== LOCKED_RESAMPLING_MANIFEST_CHECKSUM) {
    return { code: 'WRONG_RESAMPLING_MANIFEST_CHECKSUM', message: `expected B-M7.3 checksum '${LOCKED_RESAMPLING_MANIFEST_CHECKSUM}', got '${certification.resamplingManifestChecksum}'` };
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
  if (certification.sessions.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_MANIFEST_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} certified session records, got ${certification.sessions.length}` };
  }
  for (const session of certification.sessions) {
    if (session.targets.length !== 3 || session.targets.some((target) => !target.noLookaheadVerified)) {
      return { code: 'NO_LOOKAHEAD_NOT_VERIFIED', message: `tradingDate '${session.tradingDate}' has an unverified no-lookahead target record` };
    }
  }

  for (const target of [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE] as const) {
    const actual = certification.summary.byTarget[target];
    const expected = LOCKED_TARGET_TOTALS[target];
    if (actual.sessionCount !== EXPECTED_SESSIONS || actual.completeSessionCount !== EXPECTED_SESSIONS) {
      return { code: 'WRONG_TARGET_SESSION_COUNT', message: `target '${target}': expected sessionCount=completeSessionCount=${EXPECTED_SESSIONS}, got sessionCount=${actual.sessionCount} completeSessionCount=${actual.completeSessionCount}` };
    }
    if (actual.totalOutputCandles !== expected.totalOutputCandles || actual.totalStructuralTrailingRows !== expected.totalStructuralTrailingRows || actual.totalCandlesContainingImputation !== expected.totalCandlesContainingImputation) {
      return {
        code: 'WRONG_TARGET_AGGREGATE_TOTALS',
        message: `target '${target}': expected totalOutputCandles=${expected.totalOutputCandles}/totalStructuralTrailingRows=${expected.totalStructuralTrailingRows}/totalCandlesContainingImputation=${expected.totalCandlesContainingImputation}, got ${actual.totalOutputCandles}/${actual.totalStructuralTrailingRows}/${actual.totalCandlesContainingImputation}`,
      };
    }
  }

  // The locked 2022 topology always has exactly one authorized-derived (March-7) session -- march7Proof must
  // never be null here (B-M9 clean-year support only applies to a 0-derived year like 2023).
  const march7Proof = certification.march7Proof;
  if (march7Proof === null) {
    return { code: 'MISSING_MARCH7_PROOF', message: 'expected a non-null march7Proof for the locked 2022 (1 authorized-derived session) topology, got null' };
  }
  if (march7Proof.tradingDate !== MARCH_7_DATE) {
    return { code: 'WRONG_MARCH7_DATE', message: `expected march7Proof.tradingDate '${MARCH_7_DATE}', got '${march7Proof.tradingDate}'` };
  }
  if (JSON.stringify(march7Proof.imputedMinutesIst) !== JSON.stringify(['10:22', '10:23', '10:24'])) {
    return { code: 'WRONG_MARCH7_IMPUTED_MINUTES', message: `expected imputedMinutesIst=[10:22,10:23,10:24], got ${JSON.stringify(march7Proof.imputedMinutesIst)}` };
  }
  if (march7Proof.leftRealAnchorIst !== '10:21' || march7Proof.rightRealAnchorIst !== '10:25') {
    return { code: 'WRONG_MARCH7_ANCHORS', message: `expected leftRealAnchorIst=10:21/rightRealAnchorIst=10:25, got ${march7Proof.leftRealAnchorIst}/${march7Proof.rightRealAnchorIst}` };
  }
  if (march7Proof.entries.length !== 5) {
    return { code: 'WRONG_MARCH7_PROOF_ENTRY_COUNT', message: `expected exactly 5 march7Proof entries, got ${march7Proof.entries.length}` };
  }
  for (const expectedEntry of LOCKED_MARCH7_NO_LOOKAHEAD_PROOFS) {
    const actualEntry = march7Proof.entries.find((entry) => entry.target === expectedEntry.target && entry.bucketStartIst === expectedEntry.bucketStartIst);
    if (!actualEntry || actualEntry.expectedAvailableAtIst !== expectedEntry.expectedAvailableAtIst || !actualEntry.verified) {
      return {
        code: 'MARCH7_NO_LOOKAHEAD_PROOF_FAILED',
        message: `${expectedEntry.target} ${expectedEntry.bucketStartIst} must have availableAt=${expectedEntry.expectedAvailableAtIst} IST and verified=true, got ${actualEntry ? `${actualEntry.expectedAvailableAtIst}/verified=${actualEntry.verified}` : 'MISSING'}`,
      };
    }
  }

  return null;
}

/**
 * Returns `true` only on a fully-certified, postcondition-validated, and
 * persisted 2022 end-to-end certification; `false` on any failure. Never
 * throws -- every failure is caught and reported through `errorOutput`. The
 * trusted certification artifact is written ONLY after every check passes.
 */
export async function runNifty2022Certify(options: RunCertifyOptions): Promise<boolean> {
  const { buildService, output, errorOutput } = options;
  const service = buildService();

  let result: CertifyYearResult;
  try {
    result = await service.certifyYear({ year: LOCKED_YEAR, expectedCanonicalDatasetChecksum: LOCKED_CANONICAL_DATASET_CHECKSUM, sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM, resamplingManifestChecksum: LOCKED_RESAMPLING_MANIFEST_CHECKSUM });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M8B_2022_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=CERTIFY_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result);
  if (postconditionFailure) {
    errorOutput(['[B_M8B_2022_RESEARCH_CERTIFICATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  let stored;
  try {
    stored = service.persistCertification(result.certification);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M8B_2022_RESEARCH_CERTIFICATION]', 'status=FAILED', 'code=PERSISTENCE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  output(
    [
      '[B_M8B_2022_RESEARCH_CERTIFICATION]',
      'status=SUCCESS',
      `year=${LOCKED_YEAR}`,
      `expectedSessions=${result.certification.summary.expectedSessions}`,
      `verifiedSessions=${result.certification.summary.verifiedSessions}`,
      `realCanonicalSessions=${result.certification.summary.realCanonicalSessions}`,
      `authorizedDerivedSessions=${result.certification.summary.authorizedDerivedSessions}`,
      `march7NoLookaheadProofsVerified=${result.certification.march7Proof !== null && result.certification.march7Proof.entries.every((e) => e.verified)}`,
      `certificationContentChecksum=${result.certification.certificationContentChecksum}`,
      `certificationArtifact=${stored.relativePath} (wasNewlyWritten=${stored.wasNewlyWritten})`,
    ].join('\n')
  );
  return true;
}

async function main(): Promise<void> {
  const success = await runNifty2022Certify({
    buildService: () => new NiftyUnderlyingResearchCertificationService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M8B_2022_RESEARCH_CERTIFICATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
