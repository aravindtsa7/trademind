import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileExists, readFileBuffer, writeBufferAtomic } from '../domain/atomic-file-writer';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { acquireRawSourceArchiveLock } from '../domain/raw-source-archive-lock';
import { DEFAULT_RAW_SOURCE_ARCHIVE_ROOT, RawSourceBlobExtension, storeRawSourceBlob, verifyBlobIntegrity } from '../domain/raw-source-archive-storage';
import { RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION, ReceiptIndexValidationError, validateReceiptIndexEnvelope } from '../domain/raw-source-receipt-index';
import {
  RawSourceContentChangedError,
  RawSourceDocumentContentChangedError,
  RawSourceDocumentEvidence,
  RawSourceLegacyReceiptRepairMismatchError,
  RawSourceReceiptIndex,
  RawSourceRetrievalReceipt,
  authoritativeDocumentIdentity,
  isLegacyZipDerivedReceipt,
  reconcileReceiptForArchive,
} from '../domain/raw-source-retrieval-receipt.types';
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
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect A): reconciliation and storage
 * now operate on TWO independently auditable layers per entry -- TRANSPORT
 * (`rawSha256`/`byteLength`/`archiveRelativePath`, always the exact HTTP
 * response bytes) and, only when the response was a ZIP envelope, DOCUMENT
 * (`documentEvidence`, the extracted reference-bound PDF's own identity).
 * `archiveEntry` additionally recognizes and safely upgrades a narrow class
 * of pre-fix "legacy" receipts (task section 6-9) that recorded the
 * extracted PDF bytes as if they were the raw transport identity, WITHOUT
 * ever destroying either the legacy evidence or newly reacquired evidence
 * on a mismatch.
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

export type RawSourceArchiveEntryStatus =
  | 'ARCHIVED_NEW'
  | 'VERIFIED_IDEMPOTENT_EXISTING'
  | 'REPAIRED_LEGACY_ZIP_RECEIPT'
  | 'SKIPPED_URL_NOT_REVIEWED'
  | 'FAILED_CONTENT_CHANGED'
  | 'FAILED_DOCUMENT_CONTENT_CHANGED'
  | 'FAILED_LEGACY_DOCUMENT_MISMATCH'
  | 'FAILED_ERROR';

export interface RawSourceArchiveEntryResult {
  readonly reference: string;
  readonly status: RawSourceArchiveEntryStatus;
  readonly receipt: RawSourceRetrievalReceipt | null;
  /** Present only for `FAILED_CONTENT_CHANGED` / `FAILED_DOCUMENT_CONTENT_CHANGED` / `FAILED_LEGACY_DOCUMENT_MISMATCH`. */
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

const COMPLETE_STATUSES: ReadonlySet<RawSourceArchiveEntryStatus> = new Set(['ARCHIVED_NEW', 'VERIFIED_IDEMPOTENT_EXISTING', 'REPAIRED_LEGACY_ZIP_RECEIPT']);
const FAILED_STATUSES: ReadonlySet<RawSourceArchiveEntryStatus> = new Set(['FAILED_CONTENT_CHANGED', 'FAILED_DOCUMENT_CONTENT_CHANGED', 'FAILED_LEGACY_DOCUMENT_MISMATCH', 'FAILED_ERROR']);

/** Every reference in `runResult` ended in a COMPLETE status (`ARCHIVED_NEW`, `VERIFIED_IDEMPOTENT_EXISTING`, or `REPAIRED_LEGACY_ZIP_RECEIPT`), and at least one entry was processed. A caller (the pilot CLI) uses this to fail closed on ANY partial/zero success -- it never infers success merely from a zero exit-worthy error count. */
export interface RawSourceArchiveOutcome {
  readonly success: boolean;
  readonly incompleteReferences: readonly string[];
}

export function evaluatePilotArchiveOutcome(runResult: RawSourceArchiveRunResult): RawSourceArchiveOutcome {
  const incompleteReferences = runResult.entries.filter((entry) => !COMPLETE_STATUSES.has(entry.status)).map((entry) => entry.reference);
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

/** The RAW/TRANSPORT blob's extension follows deterministically from whether this download produced a document layer: a document layer exists ONLY when the transport response was a ZIP envelope. */
function rawExtensionFor(download: RawSourceDownloadResult): RawSourceBlobExtension {
  return download.document !== null ? 'zip' : 'pdf';
}

export default class RawSourceArchiverService {
  constructor(private readonly downloader: RawSourceDownloader, private readonly archiveRoot: string = DEFAULT_RAW_SOURCE_ARCHIVE_ROOT) {}

  /** Reads the current on-disk receipt index (validated). Exposed for diagnostics/tests; `archiveManifest` always re-reads its own fresh copy under the interprocess lock rather than trusting a caller-supplied snapshot. */
  loadReceiptIndex(): RawSourceReceiptIndex {
    return loadReceiptIndex(this.archiveRoot);
  }

  /**
   * Task section 6-9: `existingReceipt` was recognized (by INVARIANT, see
   * `isLegacyZipDerivedReceipt`) as a pre-fix receipt that recorded the
   * extracted PDF's own bytes as if they were the raw transport identity.
   * `download` is a FRESH live reacquisition of the same official URL
   * (already performed by the caller). Upgrades the receipt to the
   * two-layer shape ONLY when the freshly re-derived document hash equals
   * the legacy receipt's (mislabeled) hash -- i.e. the authoritative
   * document identity is proven unchanged. On any mismatch, throws
   * `RawSourceLegacyReceiptRepairMismatchError` and touches NEITHER the
   * legacy evidence nor writes any new blob (task section 7: "Do NOT
   * destroy either evidence stream.").
   */
  private repairLegacyZipReceipt(
    entry: ReviewedRawSourceManifestEntry,
    existingReceipt: RawSourceRetrievalReceipt,
    download: RawSourceDownloadResult,
    rawSha256: string,
    documentSha256: string,
    documentBytes: Buffer,
    retrievedAt: string
  ): RawSourceArchiveEntryResult {
    if (existingReceipt.rawSha256 !== documentSha256) {
      throw new RawSourceLegacyReceiptRepairMismatchError(entry.reference, existingReceipt.rawSha256, documentSha256);
    }

    // Document identity is proven unchanged -- the legacy blob is still trustworthy evidence for the document layer. Re-verify it (never trust blindly) and REUSE it rather than rewriting (task section 4: no unnecessary duplicate storage).
    verifyBlobIntegrity(this.archiveRoot, `Legacy receipt for '${entry.reference}'`, { sha256: existingReceipt.rawSha256, byteLength: existingReceipt.byteLength, archiveRelativePath: existingReceipt.archiveRelativePath, extension: 'pdf' });

    const rawStoreResult = storeRawSourceBlob(this.archiveRoot, download.rawBytes, rawSha256, rawExtensionFor(download));

    const documentEvidence: RawSourceDocumentEvidence = {
      documentSha256,
      documentByteLength: documentBytes.length,
      documentArchiveRelativePath: existingReceipt.archiveRelativePath,
      documentMemberName: download.document?.memberName ?? existingReceipt.archiveRelativePath,
      documentMediaType: download.document?.mediaType ?? 'application/pdf',
    };

    const repairedReceipt: RawSourceRetrievalReceipt = {
      reference: entry.reference,
      requestedUrl: download.requestedUrl,
      resolvedFinalUrl: download.resolvedFinalUrl,
      httpStatus: download.httpStatus,
      contentType: download.contentType,
      etag: download.etag,
      lastModified: download.lastModified,
      rawSha256,
      byteLength: download.rawBytes.length,
      retrievedAt,
      archiveRelativePath: rawStoreResult.relativePath,
      documentEvidence,
      repairedFrom: {
        repairedFromLegacyRawSha256: existingReceipt.rawSha256,
        repairedFromArchiveRelativePath: existingReceipt.archiveRelativePath,
        repairedAt: retrievedAt,
        reason:
          'Legacy pre-fix receipt recorded the extracted PDF bytes as if they were the raw transport identity (no separate document-layer evidence existed yet). Upgraded to the two-layer evidence model after a live reacquisition of the same official URL confirmed the authoritative document hash is unchanged.',
      },
    };

    return { reference: entry.reference, status: 'REPAIRED_LEGACY_ZIP_RECEIPT', receipt: repairedReceipt, conflict: null, detail: null };
  }

  /**
   * Transport matched an existing receipt (task section 9 Case A/B already
   * resolved by `reconcileReceiptForArchive` before this is called -- Case B
   * throws before we ever get here). Re-verifies BOTH evidence layers
   * on-disk (FIX-1 Defect C: never trust an in-memory hash match alone) and
   * additionally proves the document layer independently agrees (task
   * section 9 Case C / section 29), throwing `RawSourceDocumentContentChangedError`
   * rather than ever silently replacing document evidence.
   */
  private verifyIdempotentMatch(entry: ReviewedRawSourceManifestEntry, existing: RawSourceRetrievalReceipt, freshDocumentSha256: string): RawSourceArchiveEntryResult {
    verifyBlobIntegrity(this.archiveRoot, `Receipt for '${entry.reference}' (transport)`, {
      sha256: existing.rawSha256,
      byteLength: existing.byteLength,
      archiveRelativePath: existing.archiveRelativePath,
      extension: existing.documentEvidence !== null ? 'zip' : 'pdf',
    });

    const existingDocumentIdentity = authoritativeDocumentIdentity(existing);
    if (existingDocumentIdentity.sha256 !== freshDocumentSha256) {
      throw new RawSourceDocumentContentChangedError(entry.reference, existingDocumentIdentity.sha256, freshDocumentSha256);
    }
    if (existing.documentEvidence !== null) {
      verifyBlobIntegrity(this.archiveRoot, `Receipt for '${entry.reference}' (document)`, {
        sha256: existing.documentEvidence.documentSha256,
        byteLength: existing.documentEvidence.documentByteLength,
        archiveRelativePath: existing.documentEvidence.documentArchiveRelativePath,
        extension: 'pdf',
      });
    }

    return { reference: entry.reference, status: 'VERIFIED_IDEMPOTENT_EXISTING', receipt: existing, conflict: null, detail: null };
  }

  /**
   * Stores a brand-new reference's evidence. `storeRawSourceBlob`'s own
   * content-addressed idempotency handles crash-recovery Case 1 (task
   * section 15) correctly on its own -- if a blob already exists at this
   * exact hash's path (e.g. from a prior run that crashed between
   * blob-publish and receipt-publish), it is verified to match and reused;
   * otherwise it is written fresh. This is genuine content reconciliation
   * (the hash came from a real, just-completed download), never an
   * arbitrary assignment of an unrelated blob.
   */
  private storeNewEvidence(
    download: RawSourceDownloadResult,
    rawSha256: string,
    documentSha256: string
  ): { readonly rawStoreResult: ReturnType<typeof storeRawSourceBlob>; readonly documentEvidence: RawSourceDocumentEvidence | null } {
    const rawStoreResult = storeRawSourceBlob(this.archiveRoot, download.rawBytes, rawSha256, rawExtensionFor(download));

    let documentEvidence: RawSourceDocumentEvidence | null = null;
    if (download.document !== null) {
      const documentStoreResult = storeRawSourceBlob(this.archiveRoot, download.document.bytes, documentSha256, 'pdf');
      documentEvidence = {
        documentSha256,
        documentByteLength: download.document.bytes.length,
        documentArchiveRelativePath: documentStoreResult.relativePath,
        documentMemberName: download.document.memberName,
        documentMediaType: download.document.mediaType,
      };
    }
    return { rawStoreResult, documentEvidence };
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
      // `assertExecutableManifestComplete` before ever calling this
      // service, a direct caller of `RawSourceArchiverService` must still
      // never be able to archive bytes under a mismatched reference.
      assertUrlBindsToReference(entry.reference, entry.sourceUrl);

      const download = await this.downloader.download(entry.sourceUrl);
      const rawSha256 = sha256HexOfBuffer(download.rawBytes);
      const retrievedAt = new Date().toISOString();
      const documentBytes = download.document?.bytes ?? download.rawBytes;
      const documentSha256 = download.document !== null ? sha256HexOfBuffer(documentBytes) : rawSha256;

      const existingReceipt = existingIndex[entry.reference];
      if (existingReceipt !== undefined && isLegacyZipDerivedReceipt(existingReceipt)) {
        return this.repairLegacyZipReceipt(entry, existingReceipt, download, rawSha256, documentSha256, documentBytes, retrievedAt);
      }

      const reconciliation = reconcileReceiptForArchive(entry.reference, rawSha256, existingIndex, {
        requestedUrl: download.requestedUrl,
        resolvedFinalUrl: download.resolvedFinalUrl,
        httpStatus: download.httpStatus,
        byteLength: download.rawBytes.length,
        retrievedAt,
      });

      if (reconciliation.outcome === 'IDEMPOTENT_MATCH') {
        return this.verifyIdempotentMatch(entry, reconciliation.existingReceipt, documentSha256);
      }

      // reconciliation.outcome === 'NEW'
      const { rawStoreResult, documentEvidence } = this.storeNewEvidence(download, rawSha256, documentSha256);

      const receipt: RawSourceRetrievalReceipt = {
        reference: entry.reference,
        requestedUrl: download.requestedUrl,
        resolvedFinalUrl: download.resolvedFinalUrl,
        httpStatus: download.httpStatus,
        contentType: download.contentType,
        etag: download.etag,
        lastModified: download.lastModified,
        rawSha256,
        byteLength: download.rawBytes.length,
        retrievedAt,
        archiveRelativePath: rawStoreResult.relativePath,
        documentEvidence,
        repairedFrom: null,
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
      if (error instanceof RawSourceDocumentContentChangedError) {
        return {
          reference: entry.reference,
          status: 'FAILED_DOCUMENT_CONTENT_CHANGED',
          receipt: null,
          conflict: { existingSha256: error.existingDocumentSha256, newSha256: error.newDocumentSha256 },
          detail: error.message,
        };
      }
      if (error instanceof RawSourceLegacyReceiptRepairMismatchError) {
        return {
          reference: entry.reference,
          status: 'FAILED_LEGACY_DOCUMENT_MISMATCH',
          receipt: null,
          conflict: { existingSha256: error.legacyDocumentSha256, newSha256: error.reacquiredDocumentSha256 },
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
        if ((result.status === 'ARCHIVED_NEW' || result.status === 'REPAIRED_LEGACY_ZIP_RECEIPT') && result.receipt !== null) {
          index = { ...index, [entry.reference]: result.receipt };
          saveReceiptIndex(this.archiveRoot, index);
        }
      }

      return {
        archiveRoot: this.archiveRoot,
        entries: results,
        archivedCount: results.filter((r) => COMPLETE_STATUSES.has(r.status)).length,
        skippedCount: results.filter((r) => r.status === 'SKIPPED_URL_NOT_REVIEWED').length,
        failedCount: results.filter((r) => FAILED_STATUSES.has(r.status)).length,
      };
    } finally {
      await lock.release();
    }
  }
}
