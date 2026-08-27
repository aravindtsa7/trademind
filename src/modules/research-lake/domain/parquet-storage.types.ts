import { ManifestDatasetKind } from './dataset-manifest.types';

/**
 * Physical storage format/schema version for B-F6 Parquet artifacts.
 * Deliberately DISTINCT from `MANIFEST_SCHEMA_VERSION` (B-F5 manifest JSON
 * envelope shape), `CANONICALIZATION_SEMANTICS_VERSION`, and
 * `HEALTH_SEMANTICS_VERSION` (both B-F5 logical-content semantics) --
 * `dataset-manifest.types.ts` already documents why those three are each
 * separate; this is a fourth, orthogonal axis: how the CONTENT those
 * versions describe happens to be laid out as Parquet bytes on disk.
 *
 * A future writer/column-layout change (different column set, different
 * logical type mapping, different partitioning) MUST bump this constant so
 * `ResearchLakeParquetReaderService` can reject an unsupported physical
 * layout fail-closed, even when the underlying B-F5 logical dataset
 * checksum would still be identical (task section 17/18: physical bytes may
 * legitimately change across a writer upgrade while logical identity does
 * not -- the two must never be conflated).
 */
export const PARQUET_STORAGE_SCHEMA_VERSION = 1;

/** Compression codec actually applied when writing session Parquet files. SNAPPY is the only codec both `hyparquet` (read) and `hyparquet-writer` (write) support without the optional `hyparquet-compressors` add-on package (task section 9/2: smallest dependency footprint that can reliably read AND write a real compressed codec). */
export enum ParquetCompressionCodec {
  SNAPPY = 'SNAPPY',
}

/** Physical container format for a B-F6 storage artifact. Only one value exists today; kept as an enum (not a literal) so a future physical format (e.g. a different columnar container) is an additive value, not a breaking type change. */
export enum ParquetWriterFormat {
  PARQUET = 'PARQUET',
}

/**
 * Why a requested session did or did not end up with a written/verified
 * Parquet file during export. Every value is distinguishable in CLI output
 * (task section 19: per-session `status`) and every non-`WRITTEN`/
 * `SKIPPED_VERIFIED` value means "no session file was written or trusted",
 * never a partial/best-effort state.
 */
export enum ParquetSessionExportStatus {
  /** Freshly encoded, written atomically, and read back to prove logical checksum preservation. */
  WRITTEN = 'WRITTEN',
  /** A final file already existed, its physical + logical checksums matched, so it was left untouched (task section 12: idempotent skip). */
  SKIPPED_VERIFIED = 'SKIPPED_VERIFIED',
  /** `SessionManifest.persistedCanonicalHealthStatus` is not export-ready under the fail-closed policy (task section 11) -- no file was written. */
  REJECTED_HEALTH_POLICY = 'REJECTED_HEALTH_POLICY',
  /** The rows currently persisted no longer reproduce the manifest's own `contentChecksum` (the DB drifted since the manifest was generated) -- exporting them would silently certify stale/wrong content as the manifest's logical session, so this fails closed instead (task section 10: "do not let Parquet generation repair malformed data"). */
  REJECTED_CONTENT_CHECKSUM_DRIFT = 'REJECTED_CONTENT_CHECKSUM_DRIFT',
  /** A final file already existed but failed physical or logical verification (corrupt bytes, or bytes that parse but no longer reproduce the expected logical checksum) -- left untouched, never silently overwritten (task section 12: "fail closed... never destroy suspicious prior evidence"). */
  FAILED_EXISTING_FILE_UNTRUSTED = 'FAILED_EXISTING_FILE_UNTRUSTED',
  /** Encoding, atomic write, or post-write self-verification raised an error. */
  FAILED_WRITE_ERROR = 'FAILED_WRITE_ERROR',
}

/** One session's outcome from a single export run. Never carries candle payloads (task section 19: "do not print raw candles"). */
export interface ParquetSessionExportResult {
  readonly tradingDate: string;
  readonly status: ParquetSessionExportStatus;
  /** Present only when `status` is `WRITTEN` or `SKIPPED_VERIFIED`. */
  readonly rowCount: number | null;
  readonly logicalContentChecksum: string | null;
  readonly physicalFileChecksum: string | null;
  readonly fileSizeBytes: number | null;
  readonly relativePath: string | null;
  /** Human-readable detail for a non-success status (e.g. which check failed). Never included for `WRITTEN`/`SKIPPED_VERIFIED`. */
  readonly detail: string | null;
}

export interface ParquetExportRunResult {
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly datasetKind: ManifestDatasetKind;
  readonly storageSchemaVersion: number;
  readonly compressionCodec: ParquetCompressionCodec;
  readonly sessionsRequested: number;
  readonly sessionsWritten: number;
  readonly sessionsSkippedVerified: number;
  readonly sessionsFailed: number;
  readonly sessions: readonly ParquetSessionExportResult[];
  /** `null` when every requested session failed/was rejected (no descriptor is written in that case -- task section 11: storage success must never be asserted for a run that produced nothing trustworthy). */
  readonly descriptor: ParquetDatasetStorageDescriptor | null;
  readonly descriptorPath: string | null;
}

/**
 * One session's PHYSICAL storage record. Deliberately narrow: identity
 * material beyond `tradingDate` (instrument/contract, strike, expiry,
 * provider, timeframe) is NOT duplicated here -- that already lives in the
 * linked B-F5 `DatasetManifest` (`sessionContentChecksum` + the descriptor's
 * own `datasetId`/`datasetChecksum` are sufficient to look up the
 * authoritative identity there). Never contains candle payloads (task
 * section 7: "do NOT copy candle payloads into the storage descriptor").
 */
export interface ParquetSessionStorageEntry {
  readonly tradingDate: string;
  /** The exact `SessionManifest.contentChecksum` this physical file was produced from -- proves LOGICAL content identity, kept structurally separate from `physicalFileChecksum` (task section 1/8). */
  readonly sessionContentChecksum: string;
  /** Forward-slash, dataset-root-relative path (never absolute, never containing `..`) -- see `parquetSessionRelativePath`. */
  readonly relativePath: string;
  readonly canonicalRowCount: number;
  readonly fileSizeBytes: number;
  /** SHA-256 of the exact final Parquet file bytes -- proves PHYSICAL byte identity, distinct from `sessionContentChecksum` (task section 8). */
  readonly physicalFileChecksum: string;
}

/**
 * B-F6 storage metadata model: describes WHERE and HOW one B-F5 logical
 * dataset was physically materialized as compressed Parquet files. Kept
 * entirely separate from `DatasetManifest` (task section 7: "separate from
 * B-F5 DatasetManifest... do NOT alter the B-F5 manifest to stuff
 * physical-storage details into its logical identity model").
 */
export interface ParquetDatasetStorageDescriptor {
  readonly storageSchemaVersion: number;
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly datasetKind: ManifestDatasetKind;
  readonly writerFormat: ParquetWriterFormat;
  readonly writerLibrary: string;
  readonly writerLibraryVersion: string;
  readonly compressionCodec: ParquetCompressionCodec;
  /** Observability only -- never part of any identity/checksum comparison (same convention as `DatasetManifest.generatedAt`; task section 18/AC). */
  readonly generatedAt: string;
  readonly sessions: readonly ParquetSessionStorageEntry[];
}

const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEX_CHECKSUM_PATTERN = /^[0-9a-f]{16,64}$/;

/** Fails closed on any value that could plausibly enable path traversal or an unsafe filesystem segment (task section 6: "no path traversal"). Every path-building helper below calls this before touching the filesystem, even though today's callers only ever pass already-validated B-F5 identity values. */
function assertSafePathSegment(value: string, label: string): void {
  if (value.length === 0 || value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Unsafe ${label} '${value}': must not be empty, contain path separators, '..', or a null byte.`);
  }
}

/** Dataset-root-relative directory for one B-F5 logical dataset's Parquet artifacts, keyed by the FULL `datasetChecksum` (task section 6: "Prefer FULL B-F5 datasetChecksum somewhere in physical storage identity/path, even if the shorter B-F5 datasetId is also displayed"). */
export function parquetDatasetDirectory(datasetKind: ManifestDatasetKind, datasetChecksum: string): string {
  assertSafePathSegment(datasetKind, 'datasetKind');
  if (!HEX_CHECKSUM_PATTERN.test(datasetChecksum)) {
    throw new Error(`Unsafe datasetChecksum '${datasetChecksum}': expected a lowercase hex string.`);
  }
  return `${datasetKind}/${datasetChecksum}`;
}

/** Dataset-root-relative path to one session's Parquet file -- one canonical trading session = one Parquet file (task section 6). */
export function parquetSessionRelativePath(datasetKind: ManifestDatasetKind, datasetChecksum: string, tradingDate: string): string {
  if (!TRADING_DATE_PATTERN.test(tradingDate)) {
    throw new Error(`Unsafe tradingDate '${tradingDate}': expected YYYY-MM-DD.`);
  }
  return `${parquetDatasetDirectory(datasetKind, datasetChecksum)}/sessions/${tradingDate}.parquet`;
}

/** Dataset-root-relative path to the B-F6 storage descriptor for one logical dataset. */
export function parquetStorageManifestRelativePath(datasetKind: ManifestDatasetKind, datasetChecksum: string): string {
  return `${parquetDatasetDirectory(datasetKind, datasetChecksum)}/storage-manifest.json`;
}

/** Fails closed if two or more entries in `entries` describe the same `tradingDate` (task section 22.V: "duplicate session descriptor rejected"). Mirrors `assertNoDuplicateSessionIdentities` in `dataset-manifest.types.ts`. */
export function assertNoDuplicateStorageSessionEntries(entries: readonly Pick<ParquetSessionStorageEntry, 'tradingDate'>[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.tradingDate)) {
      throw new Error(`Duplicate Parquet storage descriptor entry for tradingDate ${entry.tradingDate}: a storage descriptor must contain at most one physical record per trading date.`);
    }
    seen.add(entry.tradingDate);
  }
}

export interface ParquetSessionVerificationResult {
  readonly tradingDate: string;
  readonly verified: boolean;
  /** `null` only when the session could not be located in the descriptor/manifest at all (orphan/missing linkage). */
  readonly physicalFileExists: boolean;
  readonly physicalChecksumMatches: boolean | null;
  readonly parquetParsed: boolean | null;
  readonly rowCountMatches: boolean | null;
  readonly logicalContentChecksumMatches: boolean | null;
  readonly detail: string | null;
}

export interface ParquetVerificationRunResult {
  readonly verified: boolean;
  readonly datasetId: string;
  readonly datasetKind: ManifestDatasetKind;
  readonly datasetLinkageMatches: boolean;
  readonly sessionResults: readonly ParquetSessionVerificationResult[];
  readonly mismatchedTradingDates: readonly string[];
}
