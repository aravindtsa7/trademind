import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ParquetSessionExportStatus } from '../modules/research-lake/domain/parquet-storage.types';
import NiftyUnderlyingCanonicalStorageMaterializerService, { MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

dotenv.config();
logger.silent = true;

/**
 * B-M11 operator runner: reconstructs the exact certified 2025 NIFTY
 * canonical `DatasetManifest` from certified calendar truth + currently
 * persisted `HistoricalCandle` rows, validates it against an operator-supplied
 * EXACT canonical checksum, preflights every B-M7.2-selected date's current
 * canonical state, persists the canonical manifest artifact, and exports +
 * verifies canonical Parquet for all 249 sessions -- there is NO
 * authorized-derived canonical-empty date in 2025, so no session is ever
 * excluded by B-F6's health policy. All THREE composite-repaired sessions
 * (2025-03-25, 2025-04-04, 2025-04-23) are preflighted/exported/verified
 * through the EXACT SAME tier 1/2 path as every real-canonical session --
 * the identical `NiftyUnderlyingCanonicalStorageMaterializerService.preflight`
 * `HEALTHY_REAL_CANONICAL_SESSION`/`ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION`
 * case 2024 already exercised for its one repair -- no special Parquet
 * format, no separate export path. Reuses
 * `NiftyUnderlyingCanonicalStorageMaterializerService` unmodified -- no new
 * Parquet exporter, no new verifier.
 *
 * CHECKSUM HANDOFF: the 2025 canonical dataset checksum and research assembly
 * checksum are not known until `research:nifty-2025:assemble` has actually
 * been run for real, so this CLI requires BOTH as explicit operator inputs
 * via the narrow, year-specific `RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM`
 * and `RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM` environment variables
 * (the latter is the SAME value the operator supplied to
 * `research:nifty-2025:resample`). Both values are format-validated (exactly
 * 64 lowercase hex characters) BEFORE use; the underlying
 * `NiftyUnderlyingCanonicalStorageMaterializerService.materialize` then
 * independently re-verifies the reconstructed manifest's OWN checksum
 * against the supplied `expectedCanonicalDatasetChecksum`, reads the
 * referenced B-M7.2 assembly artifact by its content-addressed checksum, and
 * cross-checks the canonical-manifest-checksum binding between them -- all
 * BEFORE any write.
 *
 * Zero provider calls, zero canonical DB writes.
 *
 * Usage (PowerShell), once reviewed AND `research:nifty-2025:assemble` has
 * produced real checksums:
 *   $env:RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM = "<canonicalManifestChecksum>"
 *   $env:RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM = "<researchAssemblyChecksum>"
 *   npm run research:nifty-2025:materialize-storage
 */

const LOCKED_YEAR = 2025;
const EXPECTED_SESSIONS = 249;
const REGULAR_ROW_COUNT = 375;
/** The one certified 2025 session whose exported rowCount differs from the ordinary 375-row day -- every other exported session (including 2025-02-01 and all three composite-repaired dates, all ordinary 375-row full days) defaults to `REGULAR_ROW_COUNT`. */
const SPECIAL_SESSION_ROW_COUNTS: Readonly<Record<string, number>> = {
  '2025-10-21': 60,
};
const COMPOSITE_REPAIRED_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];

const CANONICAL_MANIFEST_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_CANONICAL_MANIFEST_CHECKSUM';
const SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR = 'RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM';
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export type MaterializeCanonicalStorage = Pick<NiftyUnderlyingCanonicalStorageMaterializerService, 'materialize'>;

export interface RunNifty2025MaterializeStorageOptions {
  /** Operator-supplied upstream checksums (normally read from the two RESEARCH_NIFTY_2025_* environment variables) -- injected explicitly here so tests never read real environment variables. */
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
    return { code: 'MISSING_CANONICAL_MANIFEST_CHECKSUM', message: `environment variable ${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be set to the exact 2025 canonicalManifestChecksum produced by 'npm run research:nifty-2025:assemble'` };
  }
  if (!CHECKSUM_PATTERN.test(canonicalManifestChecksum)) {
    return { code: 'MALFORMED_CANONICAL_MANIFEST_CHECKSUM', message: `${CANONICAL_MANIFEST_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${canonicalManifestChecksum}'` };
  }
  if (!sourceAssemblyChecksum) {
    return { code: 'MISSING_SOURCE_ASSEMBLY_CHECKSUM', message: `environment variable ${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be set to the exact 2025 researchAssemblyChecksum produced by 'npm run research:nifty-2025:assemble'` };
  }
  if (!CHECKSUM_PATTERN.test(sourceAssemblyChecksum)) {
    return { code: 'MALFORMED_SOURCE_ASSEMBLY_CHECKSUM', message: `${SOURCE_ASSEMBLY_CHECKSUM_ENV_VAR} must be exactly 64 lowercase hex characters, got '${sourceAssemblyChecksum}'` };
  }
  return { canonicalManifestChecksum, sourceAssemblyChecksum };
}

/**
 * The ONE locked production postcondition gate for the 2025 canonical
 * storage materialization. Deliberately hardcodes 249/60/375 -- acceptable
 * and REQUIRED at this operator postcondition boundary (never inside the
 * generic `NiftyUnderlyingCanonicalStorageMaterializerService`). Asserts
 * ZERO rejected-health-policy sessions (2025 has no authorized-derived
 * canonical-empty date to exclude). Does NOT independently re-derive the
 * composite-repaired tier from the exported Parquet sessions (row-count/
 * status alone cannot distinguish tier 1 from tier 2) -- it instead
 * cross-checks the tier classification directly from
 * `result.sourceAssembly.sessions`, the SAME trusted B-M7.2 selections the
 * materializer itself preflighted against.
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
    return { code: 'UNEXPECTED_REJECTED_HEALTH_POLICY_SESSION', message: `expected zero REJECTED_HEALTH_POLICY sessions for 2025, got [${rejectedHealthPolicy.map((s) => s.tradingDate).join(',')}]` };
  }

  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  if (writtenOrSkipped.length !== EXPECTED_SESSIONS) {
    return { code: 'WRONG_EXPORTED_SESSION_COUNT', message: `expected exactly ${EXPECTED_SESSIONS} exported/verified canonical sessions, got ${writtenOrSkipped.length}` };
  }

  for (const session of writtenOrSkipped) {
    const expectedRowCount = SPECIAL_SESSION_ROW_COUNTS[session.tradingDate] ?? REGULAR_ROW_COUNT;
    if (session.rowCount !== expectedRowCount) {
      return { code: 'SESSION_WRONG_ROW_COUNT', message: `tradingDate '${session.tradingDate}': expected exported rowCount ${expectedRowCount}, got ${session.rowCount}` };
    }
  }

  // Cross-checks the three reviewed composite-repaired dates directly against the trusted B-M7.2
  // selections the materializer itself preflighted -- row count/export status alone cannot
  // distinguish a composite-repaired session from an ordinary real-canonical one.
  const compositeRepairedDates = result.sourceAssembly.sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .sort();
  const expectedCompositeRepairedDates = [...COMPOSITE_REPAIRED_DATES].sort();
  if (compositeRepairedDates.length !== expectedCompositeRepairedDates.length || !compositeRepairedDates.every((date, index) => date === expectedCompositeRepairedDates[index])) {
    return { code: 'WRONG_COMPOSITE_REPAIRED_TRADING_DATES', message: `expected the composite-repaired trading date set to be exactly [${expectedCompositeRepairedDates.join(',')}], got [${compositeRepairedDates.join(',')}]` };
  }
  const nonQualifyingDates = result.sourceAssembly.sessions
    .filter((session) => session.precedenceTier !== ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION && session.precedenceTier !== ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate);
  if (nonQualifyingDates.length > 0) {
    return { code: 'NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SESSION_PRESENT', message: `expected every 2025 B-M7.2 selection to be real-canonical or one of the three reviewed composite-repaired dates, found unexpected-tier date(s): [${nonQualifyingDates.join(',')}]` };
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
 * preflighted, persisted, exported, and verified 2025 canonical storage
 * state; `false` on any failure. Never throws.
 */
export async function runNifty2025MaterializeStorage(options: RunNifty2025MaterializeStorageOptions): Promise<boolean> {
  const { canonicalManifestChecksum: rawCanonicalChecksum, sourceAssemblyChecksum: rawAssemblyChecksum, buildService, output, errorOutput } = options;

  const checksumInputs = validateChecksumInputs(rawCanonicalChecksum, rawAssemblyChecksum);
  if ('code' in checksumInputs) {
    errorOutput(['[B_M11_2025_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', `code=${checksumInputs.code}`, `message=${checksumInputs.message}`].join('\n'));
    return false;
  }

  const service = buildService();
  let result: MaterializeCanonicalStorageResult;
  try {
    result = await service.materialize({ year: LOCKED_YEAR, expectedCanonicalDatasetChecksum: checksumInputs.canonicalManifestChecksum, sourceAssemblyChecksum: checksumInputs.sourceAssemblyChecksum });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M11_2025_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', 'code=MATERIALIZE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result, checksumInputs);
  if (postconditionFailure) {
    errorOutput(['[B_M11_2025_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result));
  return true;
}

function formatSuccessOutput(result: MaterializeCanonicalStorageResult): string {
  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  const compositeRepairedTradingDates = result.sourceAssembly.sessions
    .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
    .map((session) => session.tradingDate)
    .sort()
    .join(',');
  return [
    '[B_M11_2025_CANONICAL_STORAGE_MATERIALIZATION]',
    'status=SUCCESS',
    `year=${LOCKED_YEAR}`,
    `canonicalDatasetChecksum=${result.canonicalManifest.datasetChecksum}`,
    `canonicalManifestArtifact=${result.manifestArtifact.relativePath} (wasNewlyWritten=${result.manifestArtifact.wasNewlyWritten})`,
    `sourceAssemblyChecksum=${result.sourceAssembly.assemblyContentChecksum}`,
    `realCanonicalOrCompositeRepairedSessionsExported=${writtenOrSkipped.length}`,
    `compositeRepairedTradingDates=${compositeRepairedTradingDates || 'NONE'}`,
    `parquetVerified=${result.verifyResult.verified}`,
    `parquetVerifiedSessionCount=${result.verifyResult.sessionResults.length}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2025MaterializeStorage({
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
    console.error('[B_M11_2025_CANONICAL_STORAGE_MATERIALIZATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
