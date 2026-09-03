import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ParquetSessionExportStatus } from '../modules/research-lake/domain/parquet-storage.types';
import NiftyUnderlyingCanonicalStorageMaterializerService, { MaterializeCanonicalStorageResult } from '../modules/research-lake/services/nifty-underlying-canonical-storage-materializer.service';

dotenv.config();
logger.silent = true;

/**
 * B-M8A operator runner: reconstructs the exact certified 2022 NIFTY
 * canonical `DatasetManifest` from certified calendar truth + currently
 * persisted `HistoricalCandle` rows, validates it against the LOCKED
 * canonical dataset checksum, preflights every B-M7.2-selected date's
 * current canonical state, persists the canonical manifest artifact, and
 * exports + verifies canonical Parquet for the 247 real-canonical sessions
 * only (March-7's currently-PERSISTED canonical content is zero rows /
 * PROVIDER_UNAVAILABLE under the existing B-F5 DatasetHealthValidatorService
 * zero-row rule -- this describes PERSISTED canonical content, never the
 * original Upstox acquisition, which the trusted B-M7.2 authorized-derived
 * selection separately tracks; March-7 is excluded from Parquet by B-F6's
 * own default health policy -- never special-cased here).
 *
 * DELIBERATELY narrow -- no env override for year/instrument/timeframe/
 * canonical checksum/B-M7.2 checksum exists (task: "No env override for
 * year, instrument, timeframe, canonical manifest checksum, B-M7.2 assembly
 * checksum"). Zero provider calls, zero canonical DB writes -- every
 * read is either a certified-calendar lookup or an already-established
 * read-only `HistoricalCandle` reconstruction path.
 *
 * Usage (PowerShell), once Terra has reviewed this implementation:
 *   npm run research:nifty-2022:materialize-storage
 */

const LOCKED_YEAR = 2022;
const LOCKED_CANONICAL_DATASET_CHECKSUM = '1a7cf5e2f88a0f6bee8b687f92c80c291a8a7bcb15184b986639f431a76e5870';
const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const EXPECTED_REAL_CANONICAL_SESSIONS = 247;
const MARCH_7_DATE = '2022-03-07';

export type MaterializeCanonicalStorage = Pick<NiftyUnderlyingCanonicalStorageMaterializerService, 'materialize'>;

export interface RunMaterializeStorageOptions {
  readonly buildService: () => MaterializeCanonicalStorage;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

interface PostconditionFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The ONE locked production postcondition gate for the 2022 canonical
 * storage materialization. Deliberately hardcodes 247/March-7 -- acceptable
 * and REQUIRED at this operator postcondition boundary (never inside the
 * generic `NiftyUnderlyingCanonicalStorageMaterializerService`, which never
 * hardcodes a session count or a specific trading date). Most of these
 * facts are already guaranteed by the service's own internal fail-closed
 * checks; re-asserting them here is deliberate defense-in-depth AND is what
 * makes this CLI's own gating logic independently testable via a fake
 * service.
 */
function validateLockedPostconditions(result: MaterializeCanonicalStorageResult): PostconditionFailure | null {
  if (result.canonicalManifest.datasetChecksum !== LOCKED_CANONICAL_DATASET_CHECKSUM) {
    return { code: 'WRONG_CANONICAL_CHECKSUM', message: `expected canonical datasetChecksum '${LOCKED_CANONICAL_DATASET_CHECKSUM}', got '${result.canonicalManifest.datasetChecksum}'` };
  }
  if (result.sourceAssembly.assemblyContentChecksum !== LOCKED_SOURCE_ASSEMBLY_CHECKSUM) {
    return { code: 'WRONG_SOURCE_ASSEMBLY_CHECKSUM', message: `expected B-M7.2 assembly checksum '${LOCKED_SOURCE_ASSEMBLY_CHECKSUM}', got '${result.sourceAssembly.assemblyContentChecksum}'` };
  }

  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  if (writtenOrSkipped.length !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_REAL_CANONICAL_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} real-canonical exported sessions, got ${writtenOrSkipped.length}` };
  }
  if (writtenOrSkipped.some((session) => session.tradingDate === MARCH_7_DATE)) {
    return { code: 'MARCH7_IN_EXPORT', message: `March-7 (${MARCH_7_DATE}) must never appear as a WRITTEN/SKIPPED_VERIFIED canonical Parquet session` };
  }
  const march7ExportResult = result.exportResult.sessions.find((session) => session.tradingDate === MARCH_7_DATE);
  if (!march7ExportResult || march7ExportResult.status !== ParquetSessionExportStatus.REJECTED_HEALTH_POLICY) {
    return { code: 'MARCH7_NOT_EXCLUDED', message: `expected March-7 export status REJECTED_HEALTH_POLICY, got '${String(march7ExportResult?.status)}'` };
  }

  if (!result.verifyResult.verified) {
    return { code: 'VERIFY_NOT_VERIFIED', message: 'ResearchLakeParquetVerifyService did not report verified=true' };
  }
  if (result.verifyResult.sessionResults.length !== EXPECTED_REAL_CANONICAL_SESSIONS) {
    return { code: 'WRONG_VERIFY_COUNT', message: `expected exactly ${EXPECTED_REAL_CANONICAL_SESSIONS} verified storage sessions, got ${result.verifyResult.sessionResults.length}` };
  }
  if (result.verifyResult.mismatchedTradingDates.length !== 0) {
    return { code: 'MISMATCHED_DATES', message: `expected zero mismatchedTradingDates, got [${result.verifyResult.mismatchedTradingDates.join(',')}]` };
  }
  if (result.verifyResult.sessionResults.some((session) => session.tradingDate === MARCH_7_DATE)) {
    return { code: 'MARCH7_IN_VERIFY', message: 'March-7 must never appear in the verified Parquet storage descriptor' };
  }
  if (!result.verifyResult.datasetLinkageMatches) {
    return { code: 'DATASET_LINKAGE_MISMATCH', message: 'Parquet storage descriptor does not link to the exact canonical manifest' };
  }

  return null;
}

/**
 * Returns `true` only on a fully-reconstructed, checksum-validated,
 * preflighted, persisted, exported, and verified 2022 canonical storage
 * state; `false` on any failure. Never throws -- every failure is caught
 * and reported through `errorOutput`.
 */
export async function runNifty2022MaterializeStorage(options: RunMaterializeStorageOptions): Promise<boolean> {
  const { buildService, output, errorOutput } = options;
  const service = buildService();

  let result: MaterializeCanonicalStorageResult;
  try {
    result = await service.materialize({ year: LOCKED_YEAR, expectedCanonicalDatasetChecksum: LOCKED_CANONICAL_DATASET_CHECKSUM, sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', 'code=MATERIALIZE_FAILED', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const postconditionFailure = validateLockedPostconditions(result);
  if (postconditionFailure) {
    errorOutput(['[B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION]', 'status=FAILED', `code=${postconditionFailure.code}`, `message=${postconditionFailure.message}`].join('\n'));
    return false;
  }

  output(formatSuccessOutput(result));
  return true;
}

function formatSuccessOutput(result: MaterializeCanonicalStorageResult): string {
  const writtenOrSkipped = result.exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED);
  return [
    '[B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION]',
    'status=SUCCESS',
    `year=${LOCKED_YEAR}`,
    `canonicalDatasetChecksum=${result.canonicalManifest.datasetChecksum}`,
    `canonicalManifestArtifact=${result.manifestArtifact.relativePath} (wasNewlyWritten=${result.manifestArtifact.wasNewlyWritten})`,
    `sourceAssemblyChecksum=${result.sourceAssembly.assemblyContentChecksum}`,
    `realCanonicalSessionsExported=${writtenOrSkipped.length}`,
    `march7Excluded=true`,
    `parquetVerified=${result.verifyResult.verified}`,
    `parquetVerifiedSessionCount=${result.verifyResult.sessionResults.length}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runNifty2022MaterializeStorage({
    buildService: () => new NiftyUnderlyingCanonicalStorageMaterializerService(),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly -- never when imported, e.g. by this script's own unit tests.
if (require.main === module) {
  main().catch((error) => {
    console.error('[B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
