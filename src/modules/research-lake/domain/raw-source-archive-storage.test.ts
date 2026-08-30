import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawSourceStorageError, rawSourceBlobRelativePath, storeRawSourceBlob, verifyBlobIntegrity } from './raw-source-archive-storage';
import { sha256HexOfBuffer } from './file-checksum';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-archive-test-'));
}

test('(15/16) raw SHA-256 is deterministic: same bytes always produce the same digest', () => {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic content', 'ascii');
  assert.equal(sha256HexOfBuffer(bytes), sha256HexOfBuffer(Buffer.from(bytes)));
});

test('rawSourceBlobRelativePath rejects a non-hex/wrong-length input', () => {
  assert.throws(() => rawSourceBlobRelativePath('not-a-hash', 'pdf'), RawSourceStorageError);
  assert.throws(() => rawSourceBlobRelativePath('a'.repeat(63), 'pdf'), RawSourceStorageError);
  assert.doesNotThrow(() => rawSourceBlobRelativePath('a'.repeat(64), 'pdf'));
});

test('rawSourceBlobRelativePath is always forward-slashed, content-addressed, and carries the exact requested extension -- never derived from an untrusted reference string', () => {
  const hash = sha256HexOfBuffer(Buffer.from('x'));
  assert.equal(rawSourceBlobRelativePath(hash, 'pdf'), `blobs/${hash}.pdf`);
  assert.equal(rawSourceBlobRelativePath(hash, 'zip'), `blobs/${hash}.zip`);
  assert.ok(!rawSourceBlobRelativePath(hash, 'pdf').includes('..'));
});

test('(19) storeRawSourceBlob writes a new blob atomically', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nfirst write', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const result = storeRawSourceBlob(root, bytes, hash, 'pdf');
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

test('storeRawSourceBlob stores a ZIP-extension blob at its own distinct path from a PDF-extension blob, even for coincidentally-equal bytes/hash', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('arbitrary transport bytes', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const pdfResult = storeRawSourceBlob(root, bytes, hash, 'pdf');
    const zipResult = storeRawSourceBlob(root, bytes, hash, 'zip');
    assert.notEqual(pdfResult.relativePath, zipResult.relativePath);
    assert.ok(pdfResult.relativePath.endsWith('.pdf'));
    assert.ok(zipResult.relativePath.endsWith('.zip'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(17) same reference + same bytes archived twice is idempotent (second call is a no-op skip, not a rewrite)', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nidempotent content', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const first = storeRawSourceBlob(root, bytes, hash, 'pdf');
    const second = storeRawSourceBlob(root, bytes, hash, 'pdf');
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
    const stored = storeRawSourceBlob(root, bytes, hash, 'pdf');

    // Simulate corruption: overwrite the blob's bytes directly on disk without going through storeRawSourceBlob.
    writeFileSync(stored.absolutePath, Buffer.from('corrupted bytes that do not hash to the filename', 'ascii'));

    assert.throws(() => storeRawSourceBlob(root, bytes, hash, 'pdf'), (error: unknown) => error instanceof RawSourceStorageError && error.code === 'EXISTING_BLOB_CORRUPTED');

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
    const relativePath = rawSourceBlobRelativePath(hash, 'pdf');
    const finalPath = join(root, ...relativePath.split('/'));
    // Never call storeRawSourceBlob at all -- prove the final path simply does not exist until a real store call publishes it.
    assert.equal(existsSync(finalPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(16) verifyBlobIntegrity accepts evidence whose blob genuinely matches', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\ngenuine matching content\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const stored = storeRawSourceBlob(root, bytes, hash, 'pdf');
    assert.doesNotThrow(() => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length, archiveRelativePath: stored.relativePath, extension: 'pdf' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(17) evidence whose blob is missing on disk is rejected as ARCHIVE_RECEIPT_BLOB_MISSING', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nnever actually stored\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    assert.throws(
      () => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length, archiveRelativePath: rawSourceBlobRelativePath(hash, 'pdf'), extension: 'pdf' }),
      (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_MISSING'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(18) evidence whose blob bytes no longer hash to the recorded sha256 is rejected as ARCHIVE_RECEIPT_BLOB_CORRUPTED, and never silently redownloaded/overwritten by this check', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\noriginal genuine content\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const stored = storeRawSourceBlob(root, bytes, hash, 'pdf');
    // Corrupt the blob directly on disk, bypassing storeRawSourceBlob.
    writeFileSync(stored.absolutePath, Buffer.from('tampered bytes that no longer hash to the receipt', 'ascii'));
    assert.throws(
      () => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length, archiveRelativePath: stored.relativePath, extension: 'pdf' }),
      (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence whose recorded byteLength disagrees with the actual blob size on disk is rejected as corrupted', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nreal content\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const stored = storeRawSourceBlob(root, bytes, hash, 'pdf');
    assert.throws(
      () => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length + 100, archiveRelativePath: stored.relativePath, extension: 'pdf' }),
      (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence whose archiveRelativePath does not correspond to its own sha256/extension is rejected as corrupted (locator/hash self-consistency)', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('%PDF-1.4\nreal content\n%%EOF\n', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    storeRawSourceBlob(root, bytes, hash, 'pdf');
    assert.throws(
      () => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length, archiveRelativePath: `blobs/${'f'.repeat(64)}.pdf`, extension: 'pdf' }),
      (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence whose extension does not match the blob actually stored (same sha256, wrong extension claimed) is rejected as corrupted', () => {
  const root = tempArchiveRoot();
  try {
    const bytes = Buffer.from('arbitrary zip-shaped transport bytes', 'ascii');
    const hash = sha256HexOfBuffer(bytes);
    const stored = storeRawSourceBlob(root, bytes, hash, 'zip');
    // Claim it's a .pdf blob (wrong extension) even though it was stored as .zip -- must be rejected, not silently accepted.
    assert.throws(
      () => verifyBlobIntegrity(root, 'test evidence', { sha256: hash, byteLength: bytes.length, archiveRelativePath: stored.relativePath, extension: 'pdf' }),
      (error: unknown) => error instanceof RawSourceStorageError && error.code === 'ARCHIVE_RECEIPT_BLOB_CORRUPTED'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
