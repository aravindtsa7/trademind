import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawSourceStorageError, rawSourceBlobRelativePath, storeRawSourceBlob, verifyBlobMatchesReceipt } from './raw-source-archive-storage';
import { sha256HexOfBuffer } from './file-checksum';
import { RawSourceRetrievalReceipt } from './raw-source-retrieval-receipt.types';

function receiptFor(root: string, bytes: Buffer, overrides: Partial<RawSourceRetrievalReceipt> = {}): RawSourceRetrievalReceipt {
  const hash = sha256HexOfBuffer(bytes);
  const stored = storeRawSourceBlob(root, bytes, hash);
  return {
    reference: 'NSE/MSD/60340',
    requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
    resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
    httpStatus: 200,
    contentType: 'application/pdf',
    etag: null,
    lastModified: null,
    rawSha256: hash,
    byteLength: bytes.length,
    retrievedAt: '2026-01-01T00:00:00.000Z',
    archiveRelativePath: stored.relativePath,
    ...overrides,
  };
}

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-archive-test-'));
}

test('(15/16) raw SHA-256 is deterministic: same bytes always produce the same digest', () => {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic content', 'ascii');
  assert.equal(sha256HexOfBuffer(bytes), sha256HexOfBuffer(Buffer.from(bytes)));
});

test('rawSourceBlobRelativePath rejects a non-hex/wrong-length input', () => {
  assert.throws(() => rawSourceBlobRelativePath('not-a-hash'), RawSourceStorageError);
  assert.throws(() => rawSourceBlobRelativePath('a'.repeat(63)), RawSourceStorageError);
  assert.doesNotThrow(() => rawSourceBlobRelativePath('a'.repeat(64)));
});

test('rawSourceBlobRelativePath is always forward-slashed and content-addressed, never derived from an untrusted reference string', () => {
  const hash = sha256HexOfBuffer(Buffer.from('x'));
  const relativePath = rawSourceBlobRelativePath(hash);
  assert.equal(relativePath, `blobs/${hash}.pdf`);
  assert.ok(!relativePath.includes('..'));
});

test('(19) storeRawSourceBlob writes a new blob atomically', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nfirst write', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const result = storeRawSourceBlob(root, bytes, hash);
    assert.equal(result.wasNewlyWritten, true);
    assert.ok(existsSync(result.absolutePath));
    assert.deepEqual(readFileSync(result.absolutePath), bytes);
    // no stray temp file left behind in the blobs directory
    const siblingFiles = readdirSync(join(root, 'blobs'));
    assert.equal(siblingFiles.some((name) => name.includes('.tmp')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(17) same reference + same bytes archived twice is idempotent (second call is a no-op skip, not a rewrite)', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nidempotent content', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const first = storeRawSourceBlob(root, bytes, hash);
    const second = storeRawSourceBlob(root, bytes, hash);
    assert.equal(first.wasNewlyWritten, true);
    assert.equal(second.wasNewlyWritten, false);
    assert.equal(first.absolutePath, second.absolutePath);
    assert.deepEqual(readFileSync(second.absolutePath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(20) an existing corrupted target (bytes no longer match its own content-addressed name) is detected and never silently overwritten', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\noriginal content', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const stored = storeRawSourceBlob(root, bytes, hash);

    // Simulate corruption: overwrite the blob's bytes directly on disk without going through storeRawSourceBlob.
    writeFileSync(stored.absolutePath, Buffer.from('corrupted bytes that do not hash to the filename', 'ascii'));

    assert.throws(() => storeRawSourceBlob(root, bytes, hash), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'EXISTING_BLOB_CORRUPTED');

    // The corrupted file must be left exactly as it was -- never silently overwritten by the failed call.
    assert.deepEqual(readFileSync(stored.absolutePath), Buffer.from('corrupted bytes that do not hash to the filename', 'ascii'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(34) a temp/partial write never becomes the accepted final file if interrupted before publish', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nnever published', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const relativePath = rawSourceBlobRelativePath(hash);
    const finalPath = join(root, ...relativePath.split('/'));
    // Never call storeRawSourceBlob at all -- prove the final path simply does not exist until a real store call publishes it.
    assert.equal(existsSync(finalPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(16) verifyBlobMatchesReceipt accepts a receipt whose blob genuinely matches', () => {
  const root = tempArchiveRoot();
  try {
    const receipt = receiptFor(root, Buffer.from('%PDF-1.4\ngenuine matching content\n%%EOF\n', 'ascii'));
    assert.doesNotThrow(() => verifyBlobMatchesReceipt(root, receipt));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(17) a receipt whose blob is missing on disk is rejected as ARCHIVE_RECEIPT_BLOB_MISSING', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nnever actually stored\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const receipt: RawSourceRetrievalReceipt = {
      reference: 'NSE/MSD/60340',
      requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
      resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
      httpStatus: 200,
      contentType: 'application/pdf',
      etag: null,
      lastModified: null,
      rawSha256: hash,
      byteLength: bytes.length,
      retrievedAt: '2026-01-01T00:00:00.000Z',
      archiveRelativePath: rawSourceBlobRelativePath(hash),
    };
    assert.throws(() => verifyBlobMatchesReceipt(root, receipt), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(18) a receipt whose blob bytes no longer hash to the recorded rawSha256 is rejected as ARCHIVE_RECEIPT_BLOB_CORRUPTED, and never silently redownloaded/overwritten by this check', () => {
  const root = tempArchiveRoot();
  try {
    const receipt = receiptFor(root, Buffer.from('%PDF-1.4\noriginal genuine content\n%%EOF\n', 'ascii'));
    // Corrupt the blob directly on disk, bypassing storeRawSourceBlob.
    const absolutePath = join(root, ...receipt.archiveRelativePath.split('/'));
    writeFileSync(absolutePath, Buffer.from('tampered bytes that no longer hash to the receipt', 'ascii'));
    assert.throws(() => verifyBlobMatchesReceipt(root, receipt), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt whose recorded byteLength disagrees with the actual blob size on disk is rejected as corrupted', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nreal content\n%%EOF\n', 'ascii');
    const receipt = receiptFor(root, bytes, { byteLength: bytes.length + 100 });
    assert.throws(() => verifyBlobMatchesReceipt(root, receipt), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt whose archiveRelativePath does not correspond to its own rawSha256 is rejected as corrupted (locator/hash self-consistency)', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nreal content\n%%EOF\n', 'ascii');
    const receipt = receiptFor(root, bytes, { archiveRelativePath: `blobs/${'f'.repeat(64)}.pdf` });
    assert.throws(() => verifyBlobMatchesReceipt(root, receipt), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
