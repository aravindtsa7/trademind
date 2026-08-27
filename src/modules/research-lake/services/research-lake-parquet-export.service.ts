import { join } from 'path';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { istTradingDayUtcBounds } from '../domain/ist-session-clock';
import { DatasetManifest, ManifestDatasetKind, OptionSessionIdentity, SessionContentIdentity, SessionManifest, UnderlyingSessionIdentity, computeSessionContentChecksum } from '../domain/dataset-manifest.types';
import { encodeManifestCandlesToParquetBuffer, toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import { cleanupTempFile, fileExists, publishVerifiedTempFile, writeBufferAtomic, writeBufferToTempFile } from '../domain/atomic-file-writer';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import {
  ParquetCompressionCodec,
  ParquetDatasetStorageDescriptor,
  ParquetExportRunResult,
  ParquetSessionExportResult,
  ParquetSessionExportStatus,
  ParquetSessionStorageEntry,
  ParquetWriterFormat,
  PARQUET_STORAGE_SCHEMA_VERSION,
  assertNoDuplicateStorageSessionEntries,
  parquetSessionRelativePath,
  parquetStorageManifestRelativePath,
} from '../domain/parquet-storage.types';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import ResearchLakeParquetReaderService from './research-lake-parquet-reader.service';

/** Pinned exact in `package.json` (`hyparquet-writer`) -- bump this constant together with that dependency version so `ParquetDatasetStorageDescriptor.writerLibraryVersion` never drifts from what actually wrote the file (task section 2/18). */
const WRITER_LIBRARY = 'hyparquet-writer';
const WRITER_LIBRARY_VERSION = '0.16.6';

export const DEFAULT_PARQUET_OUTPUT_ROOT = 'artifacts/research-lake/parquet';

/** Sessions whose `persistedCanonicalHealthStatus` is never export-ready, regardless of caller options (task section 11: "INVALID -> do not certify as export-ready research session", "PROVIDER_UNAVAILABLE -> no data file"). `METADATA_INCOMPLETE`/`SPECIAL_SESSION_EXCLUDED` are structurally invalid session content for the same reason `INVALID` is. */
const ALWAYS_INELIGIBLE_HEALTH_STATUSES: ReadonlySet<DatasetHealthStatus> = new Set([
  DatasetHealthStatus.INVALID,
  DatasetHealthStatus.PROVIDER_UNAVAILABLE,
  DatasetHealthStatus.METADATA_INCOMPLETE,
  DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED,
]);

export interface ResearchLakeParquetExportServiceDependencies {
  readonly historicalCandleRepository?: HistoricalCandleRepository;
  readonly historicalOptionCandleLakeRepository?: HistoricalOptionCandleLakeRepository;
  readonly reader?: ResearchLakeParquetReaderService;
}

export interface ExportDatasetRequest {
  readonly manifest: DatasetManifest;
  /** Filesystem root the dataset's Parquet directory/descriptor are created under. Defaults to `DEFAULT_PARQUET_OUTPUT_ROOT`; tests MUST override with an OS temp directory (task section 21/23: never write real Parquet artifacts as a side effect of a test run). */
  readonly outputRoot?: string;
  /** Opt-in per task section 11: "incomplete/partial may be exportable ONLY if... caller explicitly permits it". Default `false`. Never affects the always-ineligible statuses above. */
  readonly allowIncompleteSessions?: boolean;
}

/**
 * B-F6 EXPORT orchestrator. Mirrors `DatasetManifestService`'s shape (one
 * instance handles both dataset kinds via the session identity's own
 * `datasetKind` discriminant) but never re-derives B-F5 logical identity --
 * it only ever compares CURRENT persisted rows against the `contentChecksum`
 * a caller-supplied `DatasetManifest` already recorded (task section 1/10:
 * "B-F5 logical identity remains authoritative"; "do not let Parquet
 * generation repair malformed data").
 */
export default class ResearchLakeParquetExportService {
  private readonly historicalCandleRepository: HistoricalCandleRepository;
  private readonly historicalOptionCandleLakeRepository: HistoricalOptionCandleLakeRepository;
  private readonly reader: ResearchLakeParquetReaderService;

  constructor(dependencies: ResearchLakeParquetExportServiceDependencies = {}) {
    this.historicalCandleRepository = dependencies.historicalCandleRepository ?? new HistoricalCandleRepository();
    this.historicalOptionCandleLakeRepository = dependencies.historicalOptionCandleLakeRepository ?? new HistoricalOptionCandleLakeRepository();
    this.reader = dependencies.reader ?? new ResearchLakeParquetReaderService();
  }

  async exportDataset(request: ExportDatasetRequest): Promise<ParquetExportRunResult> {
    const { manifest } = request;
    const outputRoot = request.outputRoot ?? DEFAULT_PARQUET_OUTPUT_ROOT;
    const allowIncompleteSessions = request.allowIncompleteSessions ?? false;

    const sessionResults: ParquetSessionExportResult[] = [];
    for (const session of manifest.sessions) {
      // eslint-disable-next-line no-await-in-loop -- deterministic per-session ordering matters for reproducible logging/failure attribution (matches DatasetManifestService's own convention)
      const result = await this.exportSession(manifest, session, outputRoot, allowIncompleteSessions);
      sessionResults.push(result);
    }

    const storageEntries: ParquetSessionStorageEntry[] = sessionResults
      .filter((result) => result.status === ParquetSessionExportStatus.WRITTEN || result.status === ParquetSessionExportStatus.SKIPPED_VERIFIED)
      .map((result) => ({
        tradingDate: result.tradingDate,
        sessionContentChecksum: result.logicalContentChecksum as string,
        relativePath: result.relativePath as string,
        canonicalRowCount: result.rowCount as number,
        fileSizeBytes: result.fileSizeBytes as number,
        physicalFileChecksum: result.physicalFileChecksum as string,
      }));
    assertNoDuplicateStorageSessionEntries(storageEntries);

    const sessionsWritten = sessionResults.filter((result) => result.status === ParquetSessionExportStatus.WRITTEN).length;
    const sessionsSkippedVerified = sessionResults.filter((result) => result.status === ParquetSessionExportStatus.SKIPPED_VERIFIED).length;
    const sessionsFailed = sessionResults.length - sessionsWritten - sessionsSkippedVerified;

    let descriptor: ParquetDatasetStorageDescriptor | null = null;
    let descriptorPath: string | null = null;
    if (storageEntries.length > 0) {
      descriptor = {
        storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
        datasetId: manifest.datasetId,
        datasetChecksum: manifest.datasetChecksum,
        datasetKind: manifest.datasetKind,
        writerFormat: ParquetWriterFormat.PARQUET,
        writerLibrary: WRITER_LIBRARY,
        writerLibraryVersion: WRITER_LIBRARY_VERSION,
        compressionCodec: ParquetCompressionCodec.SNAPPY,
        generatedAt: new Date().toISOString(),
        sessions: [...storageEntries].sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : 0)),
      };
      descriptorPath = join(outputRoot, parquetStorageManifestRelativePath(manifest.datasetKind, manifest.datasetChecksum));
      writeBufferAtomic(descriptorPath, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8'));
    }

    return {
      datasetId: manifest.datasetId,
      datasetChecksum: manifest.datasetChecksum,
      datasetKind: manifest.datasetKind,
      storageSchemaVersion: PARQUET_STORAGE_SCHEMA_VERSION,
      compressionCodec: ParquetCompressionCodec.SNAPPY,
      sessionsRequested: manifest.sessions.length,
      sessionsWritten,
      sessionsSkippedVerified,
      sessionsFailed,
      sessions: sessionResults,
      descriptor,
      descriptorPath,
    };
  }

  private async exportSession(manifest: DatasetManifest, session: SessionManifest, outputRoot: string, allowIncompleteSessions: boolean): Promise<ParquetSessionExportResult> {
    const tradingDate = session.identity.tradingDate;
    const relativePath = parquetSessionRelativePath(manifest.datasetKind, manifest.datasetChecksum, tradingDate);
    const finalPath = join(outputRoot, relativePath);
    const rejected = (status: ParquetSessionExportStatus, detail: string): ParquetSessionExportResult => ({
      tradingDate,
      status,
      rowCount: null,
      logicalContentChecksum: null,
      physicalFileChecksum: null,
      fileSizeBytes: null,
      relativePath: null,
      detail,
    });

    const status = session.persistedCanonicalHealthStatus;
    const incompleteButNotAllowed = status === DatasetHealthStatus.INCOMPLETE && !allowIncompleteSessions;
    if (ALWAYS_INELIGIBLE_HEALTH_STATUSES.has(status) || incompleteButNotAllowed) {
      return rejected(ParquetSessionExportStatus.REJECTED_HEALTH_POLICY, `Session health status ${status} is not export-ready under the B-F6 fail-closed policy${incompleteButNotAllowed ? ' (allowIncompleteSessions was not set)' : ''}. Storage success must never certify data quality (task section 11).`);
    }

    if (fileExists(finalPath)) {
      return this.reconcileExistingFile(manifest, session, finalPath, relativePath);
    }

    return this.writeNewSession(manifest, session, finalPath, relativePath);
  }

  /** Idempotent-skip check (task section 12): an existing final file is verified, never blindly trusted OR blindly overwritten. */
  private async reconcileExistingFile(manifest: DatasetManifest, session: SessionManifest, finalPath: string, relativePath: string): Promise<ParquetSessionExportResult> {
    const tradingDate = session.identity.tradingDate;
    try {
      const read = await this.reader.readSession(finalPath);
      const recomputedContentChecksum = computeSessionContentChecksum({
        identity: session.identity,
        canonicalizationVersion: manifest.canonicalizationVersion,
        healthSemanticsVersion: manifest.healthSemanticsVersion,
        candles: read.candles,
      });
      const rowCountMatches = read.candles.length === session.canonicalRowCount;
      const checksumMatches = recomputedContentChecksum === session.contentChecksum;
      if (rowCountMatches && checksumMatches) {
        return {
          tradingDate,
          status: ParquetSessionExportStatus.SKIPPED_VERIFIED,
          rowCount: read.candles.length,
          logicalContentChecksum: recomputedContentChecksum,
          physicalFileChecksum: read.physicalFileChecksum,
          fileSizeBytes: read.fileSizeBytes,
          relativePath,
          detail: null,
        };
      }
      return {
        tradingDate,
        status: ParquetSessionExportStatus.FAILED_EXISTING_FILE_UNTRUSTED,
        rowCount: null,
        logicalContentChecksum: null,
        physicalFileChecksum: null,
        fileSizeBytes: null,
        relativePath: null,
        detail: `Existing file at ${relativePath} parsed, but rowCountMatches=${rowCountMatches} checksumMatches=${checksumMatches} -- left untouched (fail-closed, never overwritten automatically).`,
      };
    } catch (error) {
      return {
        tradingDate,
        status: ParquetSessionExportStatus.FAILED_EXISTING_FILE_UNTRUSTED,
        rowCount: null,
        logicalContentChecksum: null,
        physicalFileChecksum: null,
        fileSizeBytes: null,
        relativePath: null,
        detail: `Existing file at ${relativePath} could not be read/parsed (${error instanceof Error ? error.message : String(error)}) -- left untouched (fail-closed, never overwritten automatically).`,
      };
    }
  }

  private async writeNewSession(manifest: DatasetManifest, session: SessionManifest, finalPath: string, relativePath: string): Promise<ParquetSessionExportResult> {
    const tradingDate = session.identity.tradingDate;
    try {
      const rows = await this.fetchCurrentRows(manifest.datasetKind, session.identity, tradingDate);
      const candles = rows.map(toManifestCandleContent);
      if (candles.length === 0) {
        return {
          tradingDate,
          status: ParquetSessionExportStatus.FAILED_WRITE_ERROR,
          rowCount: null,
          logicalContentChecksum: null,
          physicalFileChecksum: null,
          fileSizeBytes: null,
          relativePath: null,
          detail: `No persisted rows found for ${tradingDate} at export time (0 rows) -- refusing to write an empty session file.`,
        };
      }

      const recomputedContentChecksum = computeSessionContentChecksum({
        identity: session.identity,
        canonicalizationVersion: manifest.canonicalizationVersion,
        healthSemanticsVersion: manifest.healthSemanticsVersion,
        candles,
      });
      if (recomputedContentChecksum !== session.contentChecksum) {
        return {
          tradingDate,
          status: ParquetSessionExportStatus.REJECTED_CONTENT_CHECKSUM_DRIFT,
          rowCount: null,
          logicalContentChecksum: null,
          physicalFileChecksum: null,
          fileSizeBytes: null,
          relativePath: null,
          detail: `Currently persisted rows for ${tradingDate} no longer reproduce the manifest's recorded contentChecksum (manifest=${session.contentChecksum}, current=${recomputedContentChecksum}). Refusing to export -- Parquet generation never repairs/re-certifies drifted content (task section 10).`,
        };
      }

      const arrayBuffer = encodeManifestCandlesToParquetBuffer(candles);
      const buffer = Buffer.from(arrayBuffer);
      const physicalFileChecksum = sha256HexOfBuffer(buffer);

      // B-F6 CORRECTION (independent review): write to a TEMP file first -- `finalPath`
      // must not exist until verification of the temp file has already succeeded. Encode
      // exactly once; `physicalFileChecksum` is derived from the SAME `buffer` that is
      // written to the temp file and later renamed byte-for-byte onto `finalPath` (never a
      // second encode/write).
      const temporaryPath = writeBufferToTempFile(finalPath, buffer);
      try {
        const readBack = await this.reader.readAndVerifySession({
          parquetFilePath: temporaryPath,
          identity: session.identity,
          canonicalizationVersion: manifest.canonicalizationVersion,
          healthSemanticsVersion: manifest.healthSemanticsVersion,
          expectedContentChecksum: session.contentChecksum,
          expectedRowCount: candles.length,
          expectedPhysicalFileChecksum: physicalFileChecksum,
        });
        if (!readBack.contentChecksumMatches || !readBack.rowCountMatches || !readBack.physicalChecksumMatches) {
          throw new Error(`Pre-publish self-verification failed for ${tradingDate} (contentChecksumMatches=${readBack.contentChecksumMatches}, rowCountMatches=${readBack.rowCountMatches}, physicalChecksumMatches=${readBack.physicalChecksumMatches}).`);
        }
        publishVerifiedTempFile(temporaryPath, finalPath); // only now does finalPath come into existence
      } catch (error) {
        cleanupTempFile(temporaryPath); // finalPath was never touched -- nothing to undo there
        throw error;
      }

      return {
        tradingDate,
        status: ParquetSessionExportStatus.WRITTEN,
        rowCount: candles.length,
        logicalContentChecksum: recomputedContentChecksum,
        physicalFileChecksum,
        fileSizeBytes: buffer.byteLength,
        relativePath,
        detail: null,
      };
    } catch (error) {
      return {
        tradingDate,
        status: ParquetSessionExportStatus.FAILED_WRITE_ERROR,
        rowCount: null,
        logicalContentChecksum: null,
        physicalFileChecksum: null,
        fileSizeBytes: null,
        relativePath: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Re-fetches rows for exactly one session from the SAME persisted store B-F5 reads (never a provider API -- task section 10/24). */
  private async fetchCurrentRows(datasetKind: ManifestDatasetKind, identity: SessionContentIdentity, tradingDate: string): Promise<PersistedManifestCandleRow[]> {
    const { start, end } = istTradingDayUtcBounds(tradingDate);
    if (datasetKind === ManifestDatasetKind.UNDERLYING_1M) {
      const underlying = identity as UnderlyingSessionIdentity;
      return this.historicalCandleRepository.findRange(underlying.instrumentKey, underlying.timeframe, start, end);
    }
    const option = identity as OptionSessionIdentity;
    return this.historicalOptionCandleLakeRepository.findRange(option.providerContractId, option.timeframe, start, end);
  }
}
