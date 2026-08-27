import { join } from 'path';
import { fileExists, readFileBuffer } from '../domain/atomic-file-writer';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { decodeParquetBufferToManifestCandles } from '../domain/canonical-candle-parquet-codec';
import { DatasetManifest, computeSessionContentChecksum } from '../domain/dataset-manifest.types';
import { PARQUET_STORAGE_SCHEMA_VERSION, ParquetDatasetStorageDescriptor, ParquetSessionVerificationResult, ParquetVerificationRunResult, assertNoDuplicateStorageSessionEntries } from '../domain/parquet-storage.types';

export interface VerifyStorageDescriptorRequest {
  readonly descriptor: ParquetDatasetStorageDescriptor;
  readonly manifest: DatasetManifest;
  /** Filesystem root `descriptor.sessions[].relativePath` is resolved against -- MUST be the same `outputRoot` the export run used. Defaults to `DEFAULT_PARQUET_OUTPUT_ROOT`. */
  readonly storageRoot?: string;
}

export const DEFAULT_PARQUET_OUTPUT_ROOT = 'artifacts/research-lake/parquet';

/**
 * B-F6 VERIFY orchestrator. Never calls a provider, never rewrites/repairs
 * anything (task section 20: "no automatic rewrite during VERIFY"). Performs
 * BOTH the physical validation (file exists, byte checksum, Parquet
 * parse/schema) and the logical validation (reconstructed rows reproduce the
 * B-F5 `SessionManifest.contentChecksum`, dataset/session identity linkage
 * matches) required by task section 20, and can distinguish all three
 * corruption/mutation categories from task section 8:
 *   A. Parquet file byte corruption            -> `physicalChecksumMatches: false`
 *   B. valid bytes, semantically wrong rows     -> parses, but `logicalContentChecksumMatches: false`
 *   C. valid bytes, correct logical session     -> `verified: true`
 */
export default class ResearchLakeParquetVerifyService {
  async verifyStorageDescriptor(request: VerifyStorageDescriptorRequest): Promise<ParquetVerificationRunResult> {
    const { descriptor, manifest } = request;
    const storageRoot = request.storageRoot ?? DEFAULT_PARQUET_OUTPUT_ROOT;

    if (descriptor.storageSchemaVersion !== PARQUET_STORAGE_SCHEMA_VERSION) {
      throw new Error(`Unsupported B-F6 storage schema version ${descriptor.storageSchemaVersion}: this reader only supports version ${PARQUET_STORAGE_SCHEMA_VERSION}. Rejecting fail-closed rather than guessing at an incompatible physical layout.`);
    }
    assertNoDuplicateStorageSessionEntries(descriptor.sessions);

    const datasetLinkageMatches = descriptor.datasetId === manifest.datasetId && descriptor.datasetChecksum === manifest.datasetChecksum && descriptor.datasetKind === manifest.datasetKind;

    const manifestSessionsByDate = new Map(manifest.sessions.map((session) => [session.identity.tradingDate, session]));

    const sessionResults: ParquetSessionVerificationResult[] = [];
    for (const entry of descriptor.sessions) {
      const manifestSession = manifestSessionsByDate.get(entry.tradingDate);
      if (!manifestSession) {
        sessionResults.push({
          tradingDate: entry.tradingDate,
          verified: false,
          physicalFileExists: false,
          physicalChecksumMatches: null,
          parquetParsed: null,
          rowCountMatches: null,
          logicalContentChecksumMatches: null,
          detail: `No session for tradingDate ${entry.tradingDate} exists in the linked B-F5 manifest -- orphaned storage descriptor entry.`,
        });
        continue;
      }

      if (entry.sessionContentChecksum !== manifestSession.contentChecksum) {
        sessionResults.push({
          tradingDate: entry.tradingDate,
          verified: false,
          physicalFileExists: fileExists(join(storageRoot, entry.relativePath)),
          physicalChecksumMatches: null,
          parquetParsed: null,
          rowCountMatches: null,
          logicalContentChecksumMatches: false,
          detail: `Storage descriptor's recorded sessionContentChecksum (${entry.sessionContentChecksum}) does not match the linked manifest session's contentChecksum (${manifestSession.contentChecksum}) -- wrong session linkage.`,
        });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- verification must attribute failures to a specific trading date, one date at a time (matches DatasetManifestService.verifyManifest convention)
      sessionResults.push(await this.verifySession(storageRoot, entry, manifest, manifestSession.contentChecksum, manifestSession.identity, manifestSession.canonicalRowCount));
    }

    const mismatchedTradingDates = sessionResults.filter((result) => !result.verified).map((result) => result.tradingDate);

    return {
      verified: datasetLinkageMatches && mismatchedTradingDates.length === 0,
      datasetId: manifest.datasetId,
      datasetKind: manifest.datasetKind,
      datasetLinkageMatches,
      sessionResults,
      mismatchedTradingDates,
    };
  }

  private async verifySession(
    storageRoot: string,
    entry: ParquetDatasetStorageDescriptor['sessions'][number],
    manifest: DatasetManifest,
    expectedContentChecksum: string,
    identity: DatasetManifest['sessions'][number]['identity'],
    expectedRowCount: number
  ): Promise<ParquetSessionVerificationResult> {
    const path = join(storageRoot, entry.relativePath);
    if (!fileExists(path)) {
      return {
        tradingDate: entry.tradingDate,
        verified: false,
        physicalFileExists: false,
        physicalChecksumMatches: null,
        parquetParsed: null,
        rowCountMatches: null,
        logicalContentChecksumMatches: null,
        detail: `Expected Parquet file not found at ${entry.relativePath}.`,
      };
    }

    const buffer = readFileBuffer(path);
    const physicalChecksumMatches = sha256HexOfBuffer(buffer) === entry.physicalFileChecksum;
    if (!physicalChecksumMatches) {
      return {
        tradingDate: entry.tradingDate,
        verified: false,
        physicalFileExists: true,
        physicalChecksumMatches: false,
        parquetParsed: null,
        rowCountMatches: null,
        logicalContentChecksumMatches: null,
        detail: `Physical SHA-256 of ${entry.relativePath} does not match the storage descriptor's recorded checksum -- file bytes were altered/corrupted.`,
      };
    }

    let candles;
    try {
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      candles = await decodeParquetBufferToManifestCandles(arrayBuffer);
    } catch (error) {
      return {
        tradingDate: entry.tradingDate,
        verified: false,
        physicalFileExists: true,
        physicalChecksumMatches: true,
        parquetParsed: false,
        rowCountMatches: null,
        logicalContentChecksumMatches: null,
        detail: `Parquet parse/schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const rowCountMatches = candles.length === expectedRowCount && candles.length === entry.canonicalRowCount;
    const recomputedContentChecksum = computeSessionContentChecksum({
      identity,
      canonicalizationVersion: manifest.canonicalizationVersion,
      healthSemanticsVersion: manifest.healthSemanticsVersion,
      candles,
    });
    const logicalContentChecksumMatches = recomputedContentChecksum === expectedContentChecksum;

    return {
      tradingDate: entry.tradingDate,
      verified: rowCountMatches && logicalContentChecksumMatches,
      physicalFileExists: true,
      physicalChecksumMatches: true,
      parquetParsed: true,
      rowCountMatches,
      logicalContentChecksumMatches,
      detail: rowCountMatches && logicalContentChecksumMatches ? null : `rowCountMatches=${rowCountMatches} logicalContentChecksumMatches=${logicalContentChecksumMatches} (recomputed=${recomputedContentChecksum}, expected=${expectedContentChecksum}).`,
    };
  }
}
