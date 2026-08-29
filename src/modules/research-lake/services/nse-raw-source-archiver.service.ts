import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileExists, readFileBuffer, writeBufferAtomic } from '../domain/atomic-file-writer';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { acquireRawSourceArchiveLock } from '../domain/raw-source-archive-lock';
import { DEFAULT_RAW_SOURCE_ARCHIVE_ROOT, storeRawSourceBlob, verifyBlobMatchesReceipt } from '../domain/raw-source-archive-storage';
import { RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION, ReceiptIndexValidationError, validateReceiptIndexEnvelope } from '../domain/raw-source-receipt-index';
import { RawSourceContentChangedError, RawSourceReceiptIndex, RawSourceRetrievalReceipt, reconcileReceiptForArchive } from '../domain/raw-source-retrieval-receipt.types';
import { ReviewedRawSourceManifest, ReviewedRawSourceManifestEntry, RawSourceUrlReviewStatus } from '../domain/raw-source-archive.types';
import { assertUrlBindsToReference } from '../domain/raw-source-manifest-url-binding';
import { RawSourceDownloadResult } from './nse-raw-source-downloader.service';

/**
 * B-F7A-ARCHIVE-1 archiving orchestration (task section 3/16/23; interprocess
 * safety and receipt integrity corrected under FIX-1 Defect C, task sections
 * 9-16). Ties together: interprocess lock -> receipt-index runtime
 * validation -> downloader -> hashing -> same-reference/different-bytes
 * conflict check -> receipt-to-blob integrity verification ->
 * content-addressed atomic storage -> retrieval receipt -> atomic index
 * publication.
 *
 * DELIBERATELY DOES NOT: call Prisma, call `ExchangeCalendarRepository`,
 * call `ExchangeCalendarImporterService`/`ExchangeCalendarCertificationService`,
 * or write to the real TradeMind MySQL database in any way. Its only I/O is:
 * HTTP GET (via the injected downloader) and local filesystem writes under
 * `archiveRoot`.
 */

export interface RawSourceDownloader {
  download(url: string): Promise<RawSourceDownloadResult>;
}

const RECEIPT_INDEX_RELATIVE_PATH = 'receipts/receipt-index.json';

export type RawSourceArchiveEntryStatus = 'ARCHIVED_NEW' | 'VERIFIED_IDEMPOTENT_EXISTING' | 'SKIPPED_URL_NOT_REVIEWED' | 'FAILED_CONTENT_CHANGED' | 'FAILED_ERROR';

export interface RawSourceArchiveEntryResult {
  readonly reference: string;
  readonly status: RawSourceArchiveEntryStatus;
  readonly receipt: RawSourceRetrievalReceipt | null;
  /** Present only for `FAILED_CONTENT_CHANGED`. */
  readonly conflict: { readonly existingSha256: string; readonly newSha256: string } | null;
  /** Present only for `FAILED_ERROR`/`SKIPPED_URL_NOT_REVIEWED`. */
  readonly detail: string | null;
}

export interface RawSourceArchiveRunResult {
  readonly archiveRoot: string;
  readonly entries: readonly RawSourceArchiveEntryResult[];
  readonly archivedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
}

/** Every reference in `runResult` ended `ARCHIVED_NEW` or `VERIFIED_IDEMPOTENT_EXISTING`, and at least one entry was processed (task section 8: "SUCCESS means every one of the 16 entries is either ARCHIVED_NEW or VERIFIED_IDEMPOTENT_EXISTING. No required source may remain SKIPPED/FAILED/UNREVIEWED/UNVERIFIED."). A caller (the pilot CLI) uses this to fail closed on ANY partial/zero success -- it never infers success merely from a zero exit-worthy error count. */
export interface RawSourceArchiveOutcome {
  readonly success: boolean;
  readonly incompleteReferences: readonly string[];
}

export function evaluatePilotArchiveOutcome(runResult: RawSourceArchiveRunResult): RawSourceArchiveOutcome {
  const incompleteReferences = runResult.entries.filter((entry) => entry.status !== 'ARCHIVED_NEW' && entry.status !== 'VERIFIED_IDEMPOTENT_EXISTING').map((entry) => entry.reference);
  return { success: runResult.entries.length > 0 && incompleteReferences.length === 0, incompleteReferences };
}

function receiptIndexPath(archiveRoot: string): string {
  return join(archiveRoot, RECEIPT_INDEX_RELATIVE_PATH);
}

/**
 * Loads and STRUCTURALLY VALIDATES the persisted receipt index (task
 * section 11, FIX-1 Defect C). A missing file is a fresh/empty index; ANY
 * OTHER problem -- unparseable JSON, wrong schema version, a malformed
 * receipt -- fails closed by throwing `ReceiptIndexValidationError`. Never
 * treats malformed content as empty state.
 */
function loadReceiptIndex(archiveRoot: string): RawSourceReceiptIndex {
  const path = receiptIndexPath(archiveRoot);
  if (!fileExists(path)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileBuffer(path).toString('utf8'));
  } catch (error) {
    throw new ReceiptIndexValidationError('INVALID_ENVELOPE_SHAPE', `Receipt index at '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReceiptIndexEnvelope(raw).receipts;
}

/** Atomic publication (task section 16): temp-write then rename, never an in-place edit. */
function saveReceiptIndex(archiveRoot: string, index: RawSourceReceiptIndex): void {
  const path = receiptIndexPath(archiveRoot);
  mkdirSync(dirname(path), { recursive: true });
  const envelope = { schemaVersion: RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION, receipts: index };
  writeBufferAtomic(path, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8'));
}

export default class RawSourceArchiverService {
  constructor(private readonly downloader: RawSourceDownloader, private readonly archiveRoot: string = DEFAULT_RAW_SOURCE_ARCHIVE_ROOT) {}

  /** Reads the current on-disk receipt index (validated). Exposed for diagnostics/tests; `archiveManifest` always re-reads its own fresh copy under the interprocess lock rather than trusting a caller-supplied snapshot. */
  loadReceiptIndex(): RawSourceReceiptIndex {
    return loadReceiptIndex(this.archiveRoot);
  }

  /**
   * Archives one manifest entry against `existingIndex`. Callers that need
   * interprocess safety MUST go through `archiveManifest` instead, which
   * holds the exclusive archive lock for the entire read-reconcile-publish
   * transition -- this method alone does not acquire any lock and is safe
   * to call directly only for isolated single-entry testing.
   */
  async archiveEntry(entry: ReviewedRawSourceManifestEntry, existingIndex: RawSourceReceiptIndex): Promise<RawSourceArchiveEntryResult> {
    if (entry.urlReviewStatus !== RawSourceUrlReviewStatus.REVIEWED || entry.sourceUrl === null) {
      return {
        reference: entry.reference,
        status: 'SKIPPED_URL_NOT_REVIEWED',
        receipt: null,
        conflict: null,
        detail: `'${entry.reference}' has urlReviewStatus '${entry.urlReviewStatus}' -- refusing to guess/construct a source URL (task rule: never invent URLs).`,
      };
    }

    try {
      // Defect E defense-in-depth: even though the CLI gates on
      // `assertExecutable2024PilotManifestComplete` before ever calling
      // this service, a direct caller of `RawSourceArchiverService` must
      // still never be able to archive bytes under a mismatched reference.
      assertUrlBindsToReference(entry.reference, entry.sourceUrl);

      const download = await this.downloader.download(entry.sourceUrl);
      const sha256 = sha256HexOfBuffer(download.bytes);
      const retrievedAt = new Date().toISOString();

      const reconciliation = reconcileReceiptForArchive(entry.reference, sha256, existingIndex, {
        requestedUrl: download.requestedUrl,
        resolvedFinalUrl: download.resolvedFinalUrl,
        httpStatus: download.httpStatus,
        byteLength: download.bytes.length,
        retrievedAt,
      });

      if (reconciliation.outcome === 'IDEMPOTENT_MATCH') {
        // FIX-1 Defect C (task section 12/15 Case 2/3): an existing receipt
        // is NEVER trusted merely because its hash matched in memory -- the
        // blob it claims to reference must actually exist and rehash
        // correctly. A missing/corrupted blob here is a hard failure, NEVER
        // silently repaired by redownloading/overwriting.
        verifyBlobMatchesReceipt(this.archiveRoot, reconciliation.existingReceipt);
        return { reference: entry.reference, status: 'VERIFIED_IDEMPOTENT_EXISTING', receipt: reconciliation.existingReceipt, conflict: null, detail: null };
      }

      // reconciliation.outcome === 'NEW': storeRawSourceBlob's own
      // content-addressed idempotency handles crash-recovery Case 1 (task
      // section 15) correctly on its own -- if a blob already exists at
      // this exact hash's path (e.g. from a prior run that crashed between
      // blob-publish and receipt-publish), it is verified to match and
      // reused; otherwise it is written fresh. This is genuine content
      // reconciliation (the hash came from a real, just-completed
      // download), never an arbitrary assignment of an unrelated blob.
      const storeResult = storeRawSourceBlob(this.archiveRoot, download.bytes, sha256);
      const receipt: RawSourceRetrievalReceipt = {
        reference: entry.reference,
        requestedUrl: download.requestedUrl,
        resolvedFinalUrl: download.resolvedFinalUrl,
        httpStatus: download.httpStatus,
        contentType: download.contentType,
        etag: download.etag,
        lastModified: download.lastModified,
        rawSha256: sha256,
        byteLength: download.bytes.length,
        retrievedAt,
        archiveRelativePath: storeResult.relativePath,
      };
      return { reference: entry.reference, status: 'ARCHIVED_NEW', receipt, conflict: null, detail: null };
    } catch (error) {
      if (error instanceof RawSourceContentChangedError) {
        return {
          reference: entry.reference,
          status: 'FAILED_CONTENT_CHANGED',
          receipt: null,
          conflict: { existingSha256: error.existingReceipt.rawSha256, newSha256: error.newSha256 },
          detail: error.message,
        };
      }
      return { reference: entry.reference, status: 'FAILED_ERROR', receipt: null, conflict: null, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Archives every entry in `manifest.entries` sequentially, under a SINGLE
   * exclusive interprocess archive lock held for the complete
   * read-index -> reconcile -> publish transition (task section 9/10, FIX-1
   * Defect C). This is what makes the invariants in sections 13/14 hold even
   * across two independent process invocations targeting the same
   * `archiveRoot`: the receipt index is read fresh only after the lock is
   * held, every entry's reconciliation/storage/receipt-append happens while
   * still holding it, and the lock is released (in `finally`) only once the
   * whole run's index state is durably published.
   */
  async archiveManifest(manifest: ReviewedRawSourceManifest): Promise<RawSourceArchiveRunResult> {
    const lock = await acquireRawSourceArchiveLock(this.archiveRoot);
    try {
      let index = loadReceiptIndex(this.archiveRoot);
      const results: RawSourceArchiveEntryResult[] = [];

      for (const entry of manifest.entries) {
        const result = await this.archiveEntry(entry, index);
        results.push(result);
        if (result.status === 'ARCHIVED_NEW' && result.receipt !== null) {
          index = { ...index, [entry.reference]: result.receipt };
          saveReceiptIndex(this.archiveRoot, index);
        }
      }

      return {
        archiveRoot: this.archiveRoot,
        entries: results,
        archivedCount: results.filter((r) => r.status === 'ARCHIVED_NEW' || r.status === 'VERIFIED_IDEMPOTENT_EXISTING').length,
        skippedCount: results.filter((r) => r.status === 'SKIPPED_URL_NOT_REVIEWED').length,
        failedCount: results.filter((r) => r.status === 'FAILED_CONTENT_CHANGED' || r.status === 'FAILED_ERROR').length,
      };
    } finally {
      await lock.release();
    }
  }
}
