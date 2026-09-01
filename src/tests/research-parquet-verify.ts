import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import ResearchLakeParquetVerifyService, { DEFAULT_PARQUET_OUTPUT_ROOT } from '../modules/research-lake/services/research-lake-parquet-verify.service';
import { DatasetManifest } from '../modules/research-lake/domain/dataset-manifest.types';
import { assertManifestSchemaCompatible } from '../modules/research-lake/domain/manifest-schema-compatibility.util';
import { ParquetDatasetStorageDescriptor } from '../modules/research-lake/domain/parquet-storage.types';

dotenv.config();
logger.silent = true;

/**
 * Research-only B-F6 VERIFY entrypoint. Never wired into `server.ts` or any
 * live startup path. Never calls a provider live. Requires BOTH an explicit
 * B-F6 storage descriptor path AND the explicit B-F5 manifest path it was
 * exported from -- this script never auto-discovers either (task section
 * 20: "Require explicit B-F6 storage descriptor or explicit bounded storage
 * dataset"). Performs physical (file/byte/schema) AND logical (B-F5
 * contentChecksum + dataset/session identity linkage) validation; never
 * rewrites/repairs anything on mismatch.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_PARQUET_DESCRIPTOR_PATH = 'artifacts/research-lake/parquet/UNDERLYING_1M/<datasetChecksum>/storage-manifest.json'
 *   $env:RESEARCH_PARQUET_MANIFEST_PATH = 'artifacts/research-lake/manifests/UNDERLYING_1M/UNDERLYING_1M_abcd1234.json'
 *   npm run research:parquet:verify
 *
 * Optional:
 *   $env:RESEARCH_PARQUET_OUTPUT_ROOT = 'artifacts/research-lake/parquet'   (default; must match the export run's outputRoot)
 */
async function run(): Promise<void> {
  const descriptorPath = process.env.RESEARCH_PARQUET_DESCRIPTOR_PATH?.trim();
  const manifestPath = process.env.RESEARCH_PARQUET_MANIFEST_PATH?.trim();
  if (!descriptorPath) {
    throw new Error('RESEARCH_PARQUET_DESCRIPTOR_PATH is required (path to a B-F6 storage-manifest.json descriptor). This script never guesses/discovers a descriptor on its own.');
  }
  if (!manifestPath) {
    throw new Error('RESEARCH_PARQUET_MANIFEST_PATH is required (path to the B-F5 dataset manifest the descriptor was exported from) -- logical verification needs the manifest\'s own session identities/checksums.');
  }
  const storageRoot = process.env.RESEARCH_PARQUET_OUTPUT_ROOT?.trim() || DEFAULT_PARQUET_OUTPUT_ROOT;

  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as ParquetDatasetStorageDescriptor;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
  // B-F2D CORRECTION (manifest wire-contract versioning): reject an
  // incompatible/malformed manifestSchemaVersion or unknown provenance enum
  // fail-closed, before this CLI-supplied manifest is used for anything.
  assertManifestSchemaCompatible(manifest);

  console.log(JSON.stringify({ event: 'research:parquet:verify starting', descriptorPath, manifestPath, datasetId: descriptor.datasetId, datasetKind: descriptor.datasetKind, sessionCount: descriptor.sessions.length, storageRoot }));

  const service = new ResearchLakeParquetVerifyService();
  const result = await service.verifyStorageDescriptor({ descriptor, manifest, storageRoot });

  console.log(
    JSON.stringify(
      {
        verified: result.verified,
        datasetId: result.datasetId,
        datasetKind: result.datasetKind,
        datasetLinkageMatches: result.datasetLinkageMatches,
        mismatchedTradingDates: result.mismatchedTradingDates,
        sessionResults: result.sessionResults.map((session) => ({
          tradingDate: session.tradingDate,
          verified: session.verified,
          physicalFileExists: session.physicalFileExists,
          physicalChecksumMatches: session.physicalChecksumMatches,
          parquetParsed: session.parquetParsed,
          rowCountMatches: session.rowCountMatches,
          logicalContentChecksumMatches: session.logicalContentChecksumMatches,
          detail: session.detail,
        })),
      },
      null,
      2
    )
  );

  if (!result.verified) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('B-F6 Parquet verification failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
