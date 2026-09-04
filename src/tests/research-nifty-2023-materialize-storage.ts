import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ParquetSessionExportStatus } from '../modules/research-lake/domain/parquet-storage.types';
import NiftyUnderlyingCanonicalStorageMaterializerService, { MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

dotenv.config();
logger.silent = true;

/**
 * B-M9 operator runner: reconstructs the exact certified 2023 NIFTY canonical
 * `DatasetManifest` from certified calendar truth + currently persisted
 * `HistoricalCandle` rows, validates it against an operator-supplied EXACT
 * canonical checksum, preflights every B-M7.2-selected date's current
 * canonical state, persists the canonical manifest artifact, and exports +
 * verifies canonical Parquet for all 246 sessions -- unlike 2022, there is NO
 * authorized-derived canonical-empty date in 2023, so no session is ever
 * excluded by B-F6's health policy. Reuses
 * `NiftyUnderlyingCanonicalStorageMaterializerService` unmodified -- no new
 * Parquet exporter, no new verifier.
 *
 * CHECKSUM HANDOFF (task: "Do NOT invent placeholder checksum constants. Do
 * NOT remove the materializer's expected-checksum safety gate. Do NOT make
 * the materializer compare a freshly-built checksum to itself"): the 2023
 * canonical dataset checksum and research assembly checksum are not known
 * until `research:nifty-2023:assemble` has actually been run for real, so --
 * unlike the 2022 CLI, which hardcodes its already-known, already-committed
 * checksums -- this CLI requires BOTH as explicit operator inputs via the
 * narrow, year-specific `RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM`
 * and `RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM` environment variables
 * (the latter is the SAME value the operator supplied to
 * `research:nifty-2023:resample`). Both values are format-validated (exactly
 * 64 lowercase hex characters) BEFORE use; the underlying
 * `NiftyUnderlyingCanonicalStorageMaterializerService.materialize` then
 * independently re-verifies the reconstructed manifest's OWN checksum
 * against the supplied `expectedCanonicalDatasetChecksum` (never comparing a
 * freshly-built checksum to itself), reads the referenced B-M7.2 assembly
 * artifact by its content-addressed checksum, and cross-checks the
 * canonical-manifest-checksum binding between them -- all BEFORE any write.
 * Missing/malformed operator input fails closed before any work begins; a
 * well-formed but wrong checksum fails closed via the materializer's own
 * existing safety gate before any write.
 *
 * Zero provider calls, zero canonical DB writes.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation AND
 * `research:nifty-2023:assemble` has produced real checksums:
 *   $env:RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM = "<canonicalManifestChecksum>"
 *   $env:RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM = "<researchAssemblyChecksum>"
 *   npm run research:nifty-2023:materialize-storage
 */

const LOCKED_YEAR = 2023;
const EXPECTED_SESSIONS = 246;
const MUHURAT_DATE = '2023-11-12';
const MUHURAT_ROW_COUNT = 60;
const REGULAR_ROW_COUNT = 375;

const CANONICAL_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM';
const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export type MaterializeCanonicalStorage = Pick<NiftyUnderlyingCanonicalStorageMaterializerService, 'materialize'>;

export interface RunNifty2023MaterializeStorageOptions {
  /** Operator-supplied upstream checksums (normally read from the two RESEARCH_NIFTY_2023_* environment variables) -- injected explicitly here so tests never read real environment variables. */
  readonly canonicalManifestChecksum: string | undefined;
  readonly sourceAssemblyChecksum: string | undefined;
  readonly buildService: () => MaterializeCanonicalStorage;
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
}

function validateChecksumInputs(canonicalManifestChecksum: string | undefined, sourceAssemblyChecksum: string | undefined): ValidatedChecksumInputs | PostconditionFailure {
  if (!canonicalManifestChecksum) {
    return { code: 'MISSING_CANONICAL_MANIFEST_CHECKSUM', message: `environment variable ${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2023 canonicalManifestChecksum produced by 'npm run research:nifty-2023:assemble'` };
  }
  if (!CHECKSUM_PATTERN.test(canonicalManifestChecksum)) {
    return { code: 'MALFORMED_CANONICAL_MANIFEST_CHECKSUM', message: `${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${canonicalManifestChecksum}'` };
  }
  if (!sourceAssemblyChecksum) {
    return { code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM', message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2023 researchAssemblyChecksum produced by 'npm run research:nifty-2023:assemble'` };
  }
  if (!CHECKSUM_PATTERN.test(sourceAssemblyChecksum)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${sourceAssemblyChecksum}'` };
  }
  return { canonicalManifestChecksum, sourceAssemblyChecksum };
}

/**
 * The ONE locked production postcondition gate for the 2023 canonical
 * storage materialization. Deliberately hardcodes 246/2023-11-12/60/375 --
 * acceptable and REQUIRED at this operator postcondition boundary (never
 * inside the generic `NiftyUnderlyingCanonicalStorageMaterializerService`).
 * Unlike 2022, asserts ZERO rejected-health-policy sessions (2023 has no
 * authorized-derived canonical-empty date to exclude).
 */
function validateLockedPostconditions(result: MaterializeCanonicalStorageResult, expectedChecksums: ValidatedChecksumInputs): PostconditionFailure | null {
  if (result.canonicalManifest.datasetChecksum !== expectedChecksums.canonicalManifestChecksum) {
    return { code: 'WRONG_CANONICAL_CHECKSUM', message: `expected canonical datasetChecksum '${expectedChecksums.canonicalManifestChecksum}', got '${result.canonicalManifest.datasetChecksum}'` };
  }
  if (result.sourceAssembly.assemblyContentChecksum !== expectedChecksums.sourceAssemblyChecksum) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected B-M7.2 assembly checksum '${expectedChecksums.sourceAssemblyChecksum}', got '${result.sourceAssembly.assemblyContentChecksum}'` };
  }

  const rejectedHealthPolicy = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.REJECTED_HEALTH_POLICY);
  if (rejectedHealthPolicy.length !== 0) {
    return { code: 'UNEXPECTED_REJECTED_HEALTH_POLICY_SESSION', message: `expected zero REJECTED_HEALTH_POLICY sessions for a clean canonical year, got [${rejectedHealthPolicy.map((s) => s.tradingDate).join(',')}]` };
  }

  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  if (writtenOrSkipped.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_EXPORTED_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} exported/verified canonical sessions, got ${writtenOrSkipped.length}` };
  }

  const muhurat = writtenOrSkipped.find((session) => session.tradingDate === MUHURAT_DATE);
  if (!muhurat || muhurat.rowCount !== MUHURAT_ROW_COUNT) {
    return { code: 'MUHURAT_WRONG_ROW_COUNT', message: `expected Muhurat (${MUHURAT_DATE}) exported rowCount ${MUHURAT_ROW_COUNT}, got ${muhurat?.rowCount ?? 'MISSING'}` };
  }
  const wrongRegularRowCount = writtenOrSkipped.find((session) => session.tradingDate !== MUHURAT_DATE && session.rowCount !== REGULAR_ROW_COUNT);
  if (wrongRegularRowCount) {
    return { code: 'REGULAR_SESSION_WRONG_ROW_COUNT', message: `tradingDate '${wrongRegularRowCount.tradingDate}': expected regular exported rowCount ${REGULAR_ROW_COUNT}, got ${wrongRegularRowCount.rowCount}` };
  }

  if (!result.verifyResult.verified) {
    return { code: 'VERIFY_NOT_VERIFIED', message: 'ResearchLakeParquetVerifyService did not report verified=true' };
  }
  if (result.verifyResult.sessionResults.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_VERIFY_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} verified storage sessions, got ${result.verifyResult.sessionResults.length}` };
  }
  if (result.verifyResult.mismatchedTradingDates.length !== 0) {
    return { code: 'MISMATCHED_DATES', message: `expected zero mismatchedTradingDates, got [${result.verifyResult.mismatchedTradingDates.join(',')}]` };
  }
  if (!result.verifyResult.datasetLinkageMatches) {
    return { code: 'DATASET_LINKAGE_MISMATCH', message: 'Parquet storage descriptor does not link to the exact canonical manifest' };
  }

  return null;
}

/**
 * Returns `true` only on a fully-reconstructed, checksum-validated,
 * preflighted, persisted, exported, and verified 2023 canonical storage
 * state; `false` on any failure. Never throws.
 */
export async function runNifty2023MaterializeStorage(options: RunNifty2023MaterializeStorageOptions): Promise<boolean> {
  const { canonicalManifestChecksum: rawCanonicalChecksum, sourceAssemblyChecksum: rawAssemblyChecksum, buildService, output, errorOutput } = options;

  const checksumInputs = validateChecksumInputs(rawCanonicalChecksum, rawAssemblyChecksum);
  if ('code' in checksumInputs) {
    errorOutput(['[B_M9_2023_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', `code=${checksumInputs.code}`, `message=${checksumInputs.message}`].join('\n'));
    return false;
  }

  const service = buildService();
  let result: MaterializeCanonicalStorageResult;
  try {
    result = await service.materialize({ year: LOCKED_YEAR, expectedCanonicalDatasetChecksum: checksumInputs.canonicalManifestChecksum, sourceAssemblyChecksum: checksumInputs.sourceAssemblyChecksum });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M9_2023_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', 'code=MATERIALIZE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result, checksumInputs);
  if (postconditionFailure) {
    errorOutput(['[B_M9_2023_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result));
  return true;
}

function formatSuccessOutput(result: MaterializeCanonicalStorageResult): string {
  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  return [
    '[B_M9_2023_CANONICAL_STORAGE_MATERIALIZATION]',
    'status=SUCCESS',
    `year=${LOCKED_YEAR}`,
    `canonicalDatasetChecksum=${result.canonicalManifest.datasetChecksum}`,
    `canonicalManifestArtifact=${result.manifestArtifact.relativePath} (wasNewlyWritten=${result.manifestArtifact.wasNewlyWritten})`,
    `sourceAssemblyChecksum=${result.sourceAssembly.assemblyContentChecksum}`,
    `realCanonicalSessionsExported=${writtenOrSkipped.length}`,
    `muhuratExcluded=false`,
    `parquetVerified=${result.verifyResult.verified}`,
    `parquetVerifiedSessionCount=${result.verifyResult.sessionResults.length}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2023MaterializeStorage({
    canonicalManifestChecksum: process.env[CANONICAL_MANIFEST_CHECKSUM_ENV_VAR],
    sourceAssemblyChecksum: process.env[SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR],
    buildService: () => new NiftyUnderlyingCanonicalStorageMaterializerService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M9_2023_CANONICAL_STORAGE_MATERIALIZATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
