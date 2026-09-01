import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import ResearchLakeParquetExportService, { DEFAULT_PARQUET_OUTPUT_ROOT } from '../modules/research-lake/services/research-lake-parquet-export.service';
import { DatasetManifest } from '../modules/research-lake/domain/dataset-manifest.types';
import { assertManifestSchemaCompatible } from '../modules/research-lake/domain/manifest-schema-compatibility.util';

dotenv.config();
logger.silent = true;

/**
 * Research-only B-F6 EXPORT entrypoint. Never wired into `server.ts` or any
 * live startup path. Never calls a provider live -- driven entirely by an
 * already-generated B-F5 `DatasetManifest` artifact plus a fresh read of the
 * currently persisted rows for each of that manifest's sessions (task
 * section 10/19: "Prefer export driven by a B-F5 manifest path"). No
 * default/implicit dataset kind, instrument, or date range -- this script
 * only ever exports the exact sessions already listed in the given
 * manifest, which was itself generated under B-F5's own bounded-scope
 * safety cap.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_PARQUET_MANIFEST_PATH = 'artifacts/research-lake/manifests/UNDERLYING_1M/UNDERLYING_1M_abcd1234.json'
 *   npm run research:parquet:export
 *
 * Optional:
 *   $env:RESEARCH_PARQUET_OUTPUT_ROOT = 'artifacts/research-lake/parquet'   (default)
 *   $env:RESEARCH_PARQUET_ALLOW_INCOMPLETE = 'true'                        (default false -- task section 11)
 */
async function run(): Promise<void> {
  const manifestPath = process.env.RESEARCH_PARQUET_MANIFEST_PATH?.trim();
  if (!manifestPath) {
    throw new Error('RESEARCH_PARQUET_MANIFEST_PATH is required (path to a previously generated B-F5 dataset manifest JSON artifact). This script never guesses/discovers a manifest or a bulk date range on its own.');
  }
  const outputRoot = process.env.RESEARCH_PARQUET_OUTPUT_ROOT?.trim() || DEFAULT_PARQUET_OUTPUT_ROOT;
  const allowIncompleteSessions = process.env.RESEARCH_PARQUET_ALLOW_INCOMPLETE?.trim().toLowerCase() === 'true';

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
  // B-F2D CORRECTION (manifest wire-contract versioning): reject an
  // incompatible/malformed manifestSchemaVersion or unknown provenance enum
  // fail-closed, before this CLI-supplied manifest is exported from.
  assertManifestSchemaCompatible(manifest);

  console.log(JSON.stringify({ event: 'research:parquet:export starting', manifestPath, datasetId: manifest.datasetId, datasetKind: manifest.datasetKind, sessionCount: manifest.sessions.length, outputRoot, allowIncompleteSessions }));

  const service = new ResearchLakeParquetExportService();
  const result = await service.exportDataset({ manifest, outputRoot, allowIncompleteSessions });

  console.log(
    JSON.stringify(
      {
        datasetId: result.datasetId,
        datasetChecksum: result.datasetChecksum,
        storageSchemaVersion: result.storageSchemaVersion,
        compressionCodec: result.compressionCodec,
        sessionsRequested: result.sessionsRequested,
        sessionsWritten: result.sessionsWritten,
        sessionsSkippedVerified: result.sessionsSkippedVerified,
        sessionsFailed: result.sessionsFailed,
        sessions: result.sessions.map((session) => ({
          tradingDate: session.tradingDate,
          status: session.status,
          rowCount: session.rowCount,
          logicalContentChecksum: session.logicalContentChecksum,
          physicalFileChecksum: session.physicalFileChecksum,
          fileSizeBytes: session.fileSizeBytes,
          relativePath: session.relativePath,
          detail: session.detail,
        })),
        descriptorPath: result.descriptorPath,
      },
      null,
      2
    )
  );

  if (result.sessionsFailed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('B-F6 Parquet export failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
