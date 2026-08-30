import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RawSourceArchiverService, { RawSourceDownloader } from './nse-raw-source-archiver.service';
import { RawSourceDownloadResult } from './nse-raw-source-downloader.service';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { rawSourceBlobRelativePath, storeRawSourceBlob } from '../domain/raw-source-archive-storage';
import { RawSourceApplicabilityBasis, RawSourceApplicabilityDomain, RawSourceLifecycleStatus, RawSourceRole, RawSourceUrlReviewStatus, ReviewedRawSourceManifestEntry } from '../domain/raw-source-archive.types';
import { RawSourceReceiptIndex, RawSourceRetrievalReceipt } from '../domain/raw-source-retrieval-receipt.types';
import { validateReceiptIndexEnvelope } from '../domain/raw-source-receipt-index';

/**
 * B-F7A-SOURCE-EVIDENCE-FIX-1: dedicated coverage for the two-layer
 * (transport/document) evidence model, its reconciliation cases (task
 * section 9/28/29), and the legacy-receipt repair mechanism (task section
 * 6-9/33-34). Uses a downloader double at the ARCHIVER's own injection seam
 * (`RawSourceDownloader`) with FULLY CONTROLLED raw/document byte pairs --
 * the real ZIP central-directory parsing/CRC/decompression-bound behavior
 * is already exhaustively covered independently in
 * `raw-source-zip-envelope.util.test.ts`, and the real end-to-end
 * downloader+archiver wiring is covered in
 * `nse-2024-pilot-archive-runner.test.ts`'s real-transport integration
 * test; this file is specifically about the ARCHIVER's reconciliation
 * decisions given a genuine two-layer download result.
 */

const ZIP_URL = 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-two-layer-test-'));
}

function zipReviewedEntry(overrides: Partial<ReviewedRawSourceManifestEntry> = {}): ReviewedRawSourceManifestEntry {
  return {
    reference: 'NSE/CMTR/60338',
    urlReviewStatus: RawSourceUrlReviewStatus.REVIEWED,
    sourceUrl: ZIP_URL,
    primaryDepartment: 'Capital Market',
    circularReference: '11/2024',
    publicationDate: '2024-01-19',
    subject: 'Trading Holiday on January 22, 2024 on account of Holiday declared under Negotiable Instrument Act',
    applicableSegments: [{ domain: RawSourceApplicabilityDomain.EQUITY, basis: RawSourceApplicabilityBasis.DIRECT }],
    sourceRole: RawSourceRole.EXCEPTIONAL_CLOSURE_NOTICE,
    lifecycleStatus: RawSourceLifecycleStatus.FINAL,
    withdraws: [],
    withdrawnBy: null,
    supersedes: [],
    supersededBy: null,
    notes: null,
    ...overrides,
  };
}

class TwoLayerDownloader implements RawSourceDownloader {
  callCount = 0;
  constructor(private readonly responses: readonly RawSourceDownloadResult[]) {}
  async download(_url: string): Promise<RawSourceDownloadResult> {
    const response = this.responses[this.callCount];
    this.callCount += 1;
    if (!response) throw new Error('TwoLayerDownloader: no more configured responses.');
    return response;
  }
}

function zipDownload(rawBytes: Buffer, documentBytes: Buffer, memberName = 'CMTR60338.pdf'): RawSourceDownloadResult {
  return {
    requestedUrl: ZIP_URL,
    resolvedFinalUrl: ZIP_URL,
    httpStatus: 200,
    contentType: 'application/zip',
    etag: null,
    lastModified: null,
    rawBytes,
    document: { bytes: documentBytes, memberName, mediaType: 'application/pdf' },
  };
}

// ============================================================
// ARCHIVED_NEW / VERIFIED_IDEMPOTENT_EXISTING for a genuine ZIP source
// ============================================================

test('(A) a brand-new ZIP-wrapped source is archived with TWO distinct blobs (transport .zip + document .pdf), genuinely different hashes', async () => {
  const root = tempArchiveRoot();
  try {
    const rawBytes = Buffer.from('zip transport bytes v1');
    const documentBytes = Buffer.from('%PDF-1.4 extracted document v1');
    const downloader = new TwoLayerDownloader([zipDownload(rawBytes, documentBytes)]);
    const archiver = new RawSourceArchiverService(downloader, root);

    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [zipReviewedEntry()] };
    const run = await archiver.archiveManifest(manifest);
    const entry = run.entries[0];

    assert.equal(entry.status, 'ARCHIVED_NEW');
    assert.equal(entry.receipt!.rawSha256, sha256HexOfBuffer(rawBytes));
    assert.equal(entry.receipt!.archiveRelativePath, rawSourceBlobRelativePath(sha256HexOfBuffer(rawBytes), 'zip'));
    assert.ok(entry.receipt!.documentEvidence !== null);
    assert.equal(entry.receipt!.documentEvidence!.documentSha256, sha256HexOfBuffer(documentBytes));
    assert.equal(entry.receipt!.documentEvidence!.documentArchiveRelativePath, rawSourceBlobRelativePath(sha256HexOfBuffer(documentBytes), 'pdf'));
    assert.notEqual(entry.receipt!.rawSha256, entry.receipt!.documentEvidence!.documentSha256);

    // Persisted receipt index round-trips through the real validator.
    const persisted = JSON.parse(readFileSync(join(root, 'receipts', 'receipt-index.json'), 'utf8'));
    const validated = validateReceiptIndexEnvelope(persisted);
    assert.equal(validated.receipts['NSE/CMTR/60338'].documentEvidence!.documentSha256, sha256HexOfBuffer(documentBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(A) re-archiving the identical ZIP a second time is VERIFIED_IDEMPOTENT_EXISTING -- both layers re-verified on disk', async () => {
  const root = tempArchiveRoot();
  try {
    const rawBytes = Buffer.from('zip transport bytes v1');
    const documentBytes = Buffer.from('%PDF-1.4 extracted document v1');
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [zipReviewedEntry()] };

    const first = await new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(rawBytes, documentBytes)]), root).archiveManifest(manifest);
    assert.equal(first.entries[0].status, 'ARCHIVED_NEW');

    const second = await new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(rawBytes, documentBytes)]), root).archiveManifest(manifest);
    assert.equal(second.entries[0].status, 'VERIFIED_IDEMPOTENT_EXISTING');
    assert.equal(second.entries[0].receipt!.rawSha256, first.entries[0].receipt!.rawSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// Direct-PDF non-regression (task section 32): transport rawSha256 IS the
// document checksum, and a SINGLE stored blob satisfies both identities --
// no duplicate storage merely because the two-layer model now exists.
// ============================================================

test('(32) a direct-PDF source (no ZIP envelope) stores exactly ONE blob, and its rawSha256 equals the authoritative document identity', async () => {
  const root = tempArchiveRoot();
  try {
    const pdfEntry = zipReviewedEntry({ sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR61518.pdf', reference: 'NSE/CMTR/61518' });
    const pdfBytes = Buffer.from('%PDF-1.4 a genuine direct PDF response, never wrapped in a zip');
    const downloader = new TwoLayerDownloader([
      {
        requestedUrl: pdfEntry.sourceUrl!,
        resolvedFinalUrl: pdfEntry.sourceUrl!,
        httpStatus: 200,
        contentType: 'application/pdf',
        etag: null,
        lastModified: null,
        rawBytes: pdfBytes,
        document: null,
      },
    ]);
    const archiver = new RawSourceArchiverService(downloader, root);
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [pdfEntry] };
    const run = await archiver.archiveManifest(manifest);
    const entry = run.entries[0];

    assert.equal(entry.status, 'ARCHIVED_NEW');
    assert.equal(entry.receipt!.documentEvidence, null);
    assert.equal(entry.receipt!.rawSha256, sha256HexOfBuffer(pdfBytes));
    assert.equal(entry.receipt!.archiveRelativePath, rawSourceBlobRelativePath(sha256HexOfBuffer(pdfBytes), 'pdf'));
    assert.deepEqual(readFileSync(join(root, ...entry.receipt!.archiveRelativePath.split('/'))), pdfBytes, 'the single stored blob IS the document bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// Case B (task section 9/28): same document, different ZIP transport bytes
// ============================================================

test('(B) same extracted document but DIFFERENT ZIP transport bytes produces FAILED_CONTENT_CHANGED -- never collapses into idempotency', async () => {
  const root = tempArchiveRoot();
  try {
    const documentBytes = Buffer.from('%PDF-1.4 stable document content, unchanged');
    const rawBytesV1 = Buffer.from('zip transport bytes -- encoding V1');
    const rawBytesV2 = Buffer.from('zip transport bytes -- a completely different encoding V2 (same wrapped document)');
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [zipReviewedEntry()] };

    const first = await new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(rawBytesV1, documentBytes)]), root).archiveManifest(manifest);
    assert.equal(first.entries[0].status, 'ARCHIVED_NEW');

    const second = await new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(rawBytesV2, documentBytes)]), root).archiveManifest(manifest);
    assert.equal(second.entries[0].status, 'FAILED_CONTENT_CHANGED');
    assert.equal(second.entries[0].conflict!.existingSha256, sha256HexOfBuffer(rawBytesV1));
    assert.equal(second.entries[0].conflict!.newSha256, sha256HexOfBuffer(rawBytesV2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// Case C (task section 9/29): transport matches, document evidence disagrees
// ============================================================

test('(C) transport bytes match an existing receipt exactly, but its recorded document evidence disagrees with the freshly re-derived document hash -- hard conflict, no document replacement', async () => {
  const root = tempArchiveRoot();
  try {
    const rawBytes = Buffer.from('zip transport bytes, stable across both runs');
    const rawSha = sha256HexOfBuffer(rawBytes);
    storeRawSourceBlob(root, rawBytes, rawSha, 'zip');

    const wrongDocumentSha = 'f'.repeat(64);
    const craftedExisting: RawSourceRetrievalReceipt = {
      reference: 'NSE/CMTR/60338',
      requestedUrl: ZIP_URL,
      resolvedFinalUrl: ZIP_URL,
      httpStatus: 200,
      contentType: 'application/zip',
      etag: null,
      lastModified: null,
      rawSha256: rawSha,
      byteLength: rawBytes.length,
      retrievedAt: '2026-01-01T00:00:00.000Z',
      archiveRelativePath: rawSourceBlobRelativePath(rawSha, 'zip'),
      documentEvidence: {
        documentSha256: wrongDocumentSha,
        documentByteLength: 1,
        documentArchiveRelativePath: rawSourceBlobRelativePath(wrongDocumentSha, 'pdf'),
        documentMemberName: 'CMTR60338.pdf',
        documentMediaType: 'application/pdf',
      },
      repairedFrom: null,
    };
    const index: RawSourceReceiptIndex = { 'NSE/CMTR/60338': craftedExisting };

    const realDocumentBytes = Buffer.from('%PDF-1.4 the actual real extracted document content');
    const archiver = new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(rawBytes, realDocumentBytes)]), root);
    const result = await archiver.archiveEntry(zipReviewedEntry(), index);

    assert.equal(result.status, 'FAILED_DOCUMENT_CONTENT_CHANGED');
    assert.equal(result.conflict!.existingSha256, wrongDocumentSha);
    assert.equal(result.conflict!.newSha256, sha256HexOfBuffer(realDocumentBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// Legacy receipt repair (task section 6-9/33-34)
// ============================================================

function legacyReceiptFor(legacyPdfBytes: Buffer): RawSourceRetrievalReceipt {
  const legacySha = sha256HexOfBuffer(legacyPdfBytes);
  return {
    reference: 'NSE/CMTR/60338',
    requestedUrl: ZIP_URL,
    resolvedFinalUrl: ZIP_URL,
    httpStatus: 200,
    contentType: 'application/zip',
    etag: null,
    lastModified: null,
    rawSha256: legacySha, // pre-fix bug: this is actually the DOCUMENT hash, mislabeled as raw
    byteLength: legacyPdfBytes.length,
    retrievedAt: '2026-01-01T00:00:00.000Z',
    archiveRelativePath: rawSourceBlobRelativePath(legacySha, 'pdf'),
    documentEvidence: null,
    repairedFrom: null,
  };
}

test('(D) a recognized legacy ZIP-derived receipt is safely upgraded when the reacquired document hash matches the legacy (mislabeled) hash', async () => {
  const root = tempArchiveRoot();
  try {
    const legacyPdfBytes = Buffer.from('%PDF-1.4 legacy extracted content, already on disk');
    storeRawSourceBlob(root, legacyPdfBytes, sha256HexOfBuffer(legacyPdfBytes), 'pdf');
    const legacyReceipt = legacyReceiptFor(legacyPdfBytes);
    const index: RawSourceReceiptIndex = { 'NSE/CMTR/60338': legacyReceipt };

    const freshZipRawBytes = Buffer.from('brand-new zip transport bytes from a live reacquisition');
    const archiver = new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(freshZipRawBytes, legacyPdfBytes)]), root);
    const result = await archiver.archiveEntry(zipReviewedEntry(), index);

    assert.equal(result.status, 'REPAIRED_LEGACY_ZIP_RECEIPT');
    assert.equal(result.receipt!.rawSha256, sha256HexOfBuffer(freshZipRawBytes));
    assert.equal(result.receipt!.archiveRelativePath, rawSourceBlobRelativePath(sha256HexOfBuffer(freshZipRawBytes), 'zip'));
    assert.ok(result.receipt!.documentEvidence !== null);
    assert.equal(result.receipt!.documentEvidence!.documentSha256, sha256HexOfBuffer(legacyPdfBytes));
    assert.equal(result.receipt!.documentEvidence!.documentArchiveRelativePath, legacyReceipt.archiveRelativePath, 'the already-stored legacy PDF blob must be REUSED, never rewritten');
    assert.ok(result.receipt!.repairedFrom !== null);
    assert.equal(result.receipt!.repairedFrom!.repairedFromLegacyRawSha256, legacyReceipt.rawSha256);
    assert.equal(result.receipt!.repairedFrom!.repairedFromArchiveRelativePath, legacyReceipt.archiveRelativePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(D) a legacy repair whose reacquired document hash does NOT match the legacy hash is a hard LEGACY_DOCUMENT_MISMATCH conflict -- neither evidence stream is touched', async () => {
  const root = tempArchiveRoot();
  try {
    const legacyPdfBytes = Buffer.from('%PDF-1.4 legacy extracted content, ORIGINAL');
    const legacyBlobPath = storeRawSourceBlob(root, legacyPdfBytes, sha256HexOfBuffer(legacyPdfBytes), 'pdf').relativePath;
    const legacyReceipt = legacyReceiptFor(legacyPdfBytes);
    const index: RawSourceReceiptIndex = { 'NSE/CMTR/60338': legacyReceipt };

    const freshZipRawBytes = Buffer.from('a different zip transport response');
    const differentDocumentBytes = Buffer.from('%PDF-1.4 a genuinely DIFFERENT document -- NSE changed the historical PDF');
    const archiver = new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(freshZipRawBytes, differentDocumentBytes)]), root);
    const result = await archiver.archiveEntry(zipReviewedEntry(), index);

    assert.equal(result.status, 'FAILED_LEGACY_DOCUMENT_MISMATCH');
    assert.equal(result.conflict!.existingSha256, sha256HexOfBuffer(legacyPdfBytes));
    assert.equal(result.conflict!.newSha256, sha256HexOfBuffer(differentDocumentBytes));

    // Neither evidence stream was touched: the legacy blob is unchanged, and no new .zip blob was ever written.
    assert.deepEqual(readFileSync(join(root, ...legacyBlobPath.split('/'))), legacyPdfBytes);
    const wouldBeNewZipPath = join(root, ...rawSourceBlobRelativePath(sha256HexOfBuffer(freshZipRawBytes), 'zip').split('/'));
    assert.equal(existsSync(wouldBeNewZipPath), false, 'a mismatched repair must never write the new transport blob');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(D) after a successful repair, a subsequent run resolves as ordinary VERIFIED_IDEMPOTENT_EXISTING (no longer recognized as legacy)', async () => {
  const root = tempArchiveRoot();
  try {
    const legacyPdfBytes = Buffer.from('%PDF-1.4 legacy extracted content');
    storeRawSourceBlob(root, legacyPdfBytes, sha256HexOfBuffer(legacyPdfBytes), 'pdf');
    const index: RawSourceReceiptIndex = { 'NSE/CMTR/60338': legacyReceiptFor(legacyPdfBytes) };

    const freshZipRawBytes = Buffer.from('brand-new zip transport bytes');
    const archiver1 = new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(freshZipRawBytes, legacyPdfBytes)]), root);
    const repaired = await archiver1.archiveEntry(zipReviewedEntry(), index);
    assert.equal(repaired.status, 'REPAIRED_LEGACY_ZIP_RECEIPT');

    const updatedIndex: RawSourceReceiptIndex = { 'NSE/CMTR/60338': repaired.receipt! };
    const archiver2 = new RawSourceArchiverService(new TwoLayerDownloader([zipDownload(freshZipRawBytes, legacyPdfBytes)]), root);
    const secondRun = await archiver2.archiveEntry(zipReviewedEntry(), updatedIndex);
    assert.equal(secondRun.status, 'VERIFIED_IDEMPOTENT_EXISTING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
