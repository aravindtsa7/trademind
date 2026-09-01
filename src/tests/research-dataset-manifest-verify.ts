import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import DatasetManifestService from '../modules/research-lake/services/dataset-manifest.service';
import { DatasetManifest } from '../modules/research-lake/domain/dataset-manifest.types';
import { assertManifestSchemaCompatible } from '../modules/research-lake/domain/manifest-schema-compatibility.util';

dotenv.config();
logger.silent = true;

/**
 * Research-only B-F5 VERIFY entrypoint. Never wired into `server.ts` or any
 * live startup path. Never calls a provider live -- recomputes every
 * session in the given manifest fresh from the CURRENTLY persisted store
 * and compares against the stored checksums (task section 10). Fails
 * closed: any mismatch (mutated/missing/extra row) sets a non-zero exit
 * code (task section 16.Y). Never dumps full candle payloads (task section
 * 10: "without dumping huge candle datasets").
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_MANIFEST_VERIFY_PATH = 'artifacts/research-lake/manifests/UNDERLYING_1M/UNDERLYING_1M_abcd1234.json'
 *   npm run research:manifest:verify
 */
async function run(): Promise<void> {
  const manifestPath = process.env.RESEARCH_MANIFEST_VERIFY_PATH?.trim();
  if (!manifestPath) {
    throw new Error('RESEARCH_MANIFEST_VERIFY_PATH is required (path to a previously generated dataset manifest JSON artifact). This script never guesses/discovers a manifest on its own.');
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
  // B-F2D CORRECTION (manifest wire-contract versioning): reject an
  // incompatible/malformed manifestSchemaVersion or unknown provenance enum
  // fail-closed, BEFORE even logging session fields below.
  assertManifestSchemaCompatible(manifest);

  console.log(JSON.stringify({ event: 'research:manifest:verify starting', manifestPath, datasetId: manifest.datasetId, datasetKind: manifest.datasetKind, sessionCount: manifest.sessions.length }));

  const service = new DatasetManifestService();
  const result = await service.verifyManifest(manifest);

  console.log(
    JSON.stringify(
      {
        verified: result.verified,
        datasetId: result.datasetId,
        datasetKind: result.datasetKind,
        datasetChecksumMatches: result.datasetChecksumMatches,
        originalDatasetChecksum: result.originalDatasetChecksum,
        recomputedDatasetChecksum: result.recomputedDatasetChecksum,
        mismatchedTradingDates: result.mismatchedTradingDates,
        sessionResults: result.sessionResults.map((session) => ({
          tradingDate: session.tradingDate,
          matches: session.matches,
          originalCanonicalRowCount: session.originalCanonicalRowCount,
          recomputedCanonicalRowCount: session.recomputedCanonicalRowCount,
          // Persisted canonical content health only -- never source acquisition health.
          originalPersistedCanonicalHealthStatus: session.originalPersistedCanonicalHealthStatus,
          recomputedPersistedCanonicalHealthStatus: session.recomputedPersistedCanonicalHealthStatus,
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
  console.error('B-F5 dataset manifest verification failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
