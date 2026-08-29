import { join } from 'path';
import { cleanupTempFile, fileExists, publishVerifiedTempFile, readFileBuffer, writeBufferToTempFile } from './atomic-file-writer';
import { sha256HexOfBuffer } from './file-checksum';
import { RawSourceRetrievalReceipt } from './raw-source-retrieval-receipt.types';

/**
 * B-F7A-ARCHIVE-1 content-addressed raw-document storage (task section 9/12).
 * Reuses the EXISTING B-F6 atomic-write trio (`writeBufferToTempFile` /
 * `publishVerifiedTempFile` / `cleanupTempFile`) and the existing raw-byte
 * hasher (`sha256HexOfBuffer`) rather than reimplementing either -- this
 * module only adds the raw-archive-specific content-addressed path
 * convention and the same-hash-path corruption check.
 */

export const DEFAULT_RAW_SOURCE_ARCHIVE_ROOT = 'artifacts/nse-raw-source-archive';

const HEX64_PATTERN = /^[a-f0-9]{64}$/;

export type RawSourceStorageErrorCode = 'INVALID_SHA256' | 'EXISTING_BLOB_CORRUPTED' | 'ARCHIVE_RECEIPT_BLOB_MISSING' | 'ARCHIVE_RECEIPT_BLOB_CORRUPTED';

export class RawSourceStorageError extends Error {
  constructor(public readonly code: RawSourceStorageErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceStorageError';
  }
}

/**
 * Content-addressed, archive-root-relative locator for one raw document
 * (task section 9: "<sha256>.pdf or similarly deterministic structure").
 * Never derived from `reference` (task section 20: "Never construct
 * filesystem paths directly from unsanitized reference strings") -- the
 * only input is the document's own proven byte hash.
 */
export function rawSourceBlobRelativePath(sha256Hex: string): string {
  if (!HEX64_PATTERN.test(sha256Hex)) {
    throw new RawSourceStorageError('INVALID_SHA256', `'${sha256Hex}' is not a lowercase 64-character hex SHA-256 digest.`);
  }
  // Always forward-slash, regardless of host OS (matches `parquetSessionRelativePath`'s convention) -- this path is persisted verbatim into JSON receipts that must be host-independent.
  return `blobs/${sha256Hex}.pdf`;
}

export interface RawSourceBlobStoreResult {
  readonly relativePath: string;
  readonly absolutePath: string;
  /** `false` when a blob already existed at this content-addressed path and its bytes were verified to match (idempotent skip, task section 12/17). */
  readonly wasNewlyWritten: boolean;
}

/**
 * Atomically stores `bytes` at the content-addressed path for `sha256Hex`
 * (task section 12: temp-write, then atomic rename onto the final path).
 * `sha256Hex` MUST already equal `sha256HexOfBuffer(bytes)` -- callers
 * compute it once and pass it in rather than this function re-deriving it,
 * so a caller's own conflict-detection step (see
 * `raw-source-retrieval-receipt.types.ts`) and the stored path always agree
 * on the exact same digest.
 *
 * If a blob already exists at the target path, its bytes are re-hashed and
 * compared against `sha256Hex` -- a mismatch means the on-disk file no
 * longer matches its own content-addressed name (corruption, a prior
 * incomplete/partial write that somehow reached the final path, or manual
 * tampering) and is a hard failure, NEVER silently overwritten (task section
 * 12: "If final hash path already exists: verify its bytes/hash. Do not
 * blindly overwrite.").
 */
export function storeRawSourceBlob(archiveRoot: string, bytes: Buffer, sha256Hex: string): RawSourceBlobStoreResult {
  const relativePath = rawSourceBlobRelativePath(sha256Hex);
  const absolutePath = join(archiveRoot, relativePath);

  if (fileExists(absolutePath)) {
    const existingBytes = readFileBuffer(absolutePath);
    const existingHash = sha256HexOfBuffer(existingBytes);
    if (existingHash !== sha256Hex) {
      throw new RawSourceStorageError(
        'EXISTING_BLOB_CORRUPTED',
        `Existing blob at '${absolutePath}' hashes to '${existingHash}', not its own content-addressed name '${sha256Hex}'. Refusing to overwrite.`
      );
    }
    return { relativePath, absolutePath, wasNewlyWritten: false };
  }

  const temporaryPath = writeBufferToTempFile(absolutePath, bytes);
  try {
    publishVerifiedTempFile(temporaryPath, absolutePath);
  } catch (error) {
    cleanupTempFile(temporaryPath);
    throw error;
  }
  return { relativePath, absolutePath, wasNewlyWritten: true };
}

/**
 * Receipt-to-blob integrity check (task section 12/15, FIX-1 Defect C):
 * before a caller treats an existing receipt as trustworthy (an
 * `IDEMPOTENT_MATCH`, or a crash-recovery read), this proves the receipt's
 * own `archiveRelativePath` is exactly the locator its `rawSha256` derives
 * (never just trusted as persisted), that a blob actually exists there,
 * that its size matches `receipt.byteLength`, and that its bytes actually
 * rehash to `receipt.rawSha256`. ANY failure is a hard, fail-closed
 * `ARCHIVE_RECEIPT_BLOB_MISSING`/`ARCHIVE_RECEIPT_BLOB_CORRUPTED` error --
 * this function never redownloads, repairs, or silently re-derives a
 * receipt; it only proves or disproves trust in evidence that already
 * claims to exist.
 */
export function verifyBlobMatchesReceipt(archiveRoot: string, receipt: RawSourceRetrievalReceipt): void {
  const expectedRelativePath = rawSourceBlobRelativePath(receipt.rawSha256);
  if (receipt.archiveRelativePath !== expectedRelativePath) {
    throw new RawSourceStorageError(
      'ARCHIVE_RECEIPT_BLOB_CORRUPTED',
      `Receipt for '${receipt.reference}' has archiveRelativePath '${receipt.archiveRelativePath}', inconsistent with the locator '${expectedRelativePath}' derived from its own rawSha256.`
    );
  }

  const absolutePath = join(archiveRoot, receipt.archiveRelativePath);
  if (!fileExists(absolutePath)) {
    throw new RawSourceStorageError('ARCHIVE_RECEIPT_BLOB_MISSING', `Receipt for '${receipt.reference}' references blob '${absolutePath}', which does not exist on disk.`);
  }

  const bytes = readFileBuffer(absolutePath);
  if (bytes.length !== receipt.byteLength) {
    throw new RawSourceStorageError(
      'ARCHIVE_RECEIPT_BLOB_CORRUPTED',
      `Receipt for '${receipt.reference}' recorded byteLength ${receipt.byteLength}, but the blob on disk at '${absolutePath}' is ${bytes.length} bytes.`
    );
  }

  const actualHash = sha256HexOfBuffer(bytes);
  if (actualHash !== receipt.rawSha256) {
    throw new RawSourceStorageError(
      'ARCHIVE_RECEIPT_BLOB_CORRUPTED',
      `Receipt for '${receipt.reference}' recorded rawSha256 '${receipt.rawSha256}', but the blob on disk at '${absolutePath}' hashes to '${actualHash}'.`
    );
  }
}
