import { join } from 'path';
import { cleanupTempFile, fileExists, publishVerifiedTempFile, readFileBuffer, writeBufferToTempFile } from './atomic-file-writer';
import { sha256HexOfBuffer } from './file-checksum';

/**
 * B-F7A-ARCHIVE-1 content-addressed raw-document storage (task section 9/12).
 * Reuses the EXISTING B-F6 atomic-write trio (`writeBufferToTempFile` /
 * `publishVerifiedTempFile` / `cleanupTempFile`) and the existing raw-byte
 * hasher (`sha256HexOfBuffer`) rather than reimplementing either -- this
 * module only adds the raw-archive-specific content-addressed path
 * convention and the same-hash-path corruption check.
 *
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect A): a blob's file extension is
 * now an EXPLICIT, REQUIRED parameter rather than a hardcoded `.pdf` --
 * the two-layer evidence model (`raw-source-retrieval-receipt.types.ts`)
 * stores a TRANSPORT blob (exact HTTP response bytes -- `.zip` for a
 * ZIP-wrapped source, `.pdf` for a direct one) and, only for ZIP-wrapped
 * sources, a SEPARATE DOCUMENT blob (the extracted, reference-bound PDF,
 * always `.pdf`) at its own distinct content-addressed path. Making the
 * extension explicit at every call site removes the exact ambiguity Terra
 * found: a `.pdf`-named blob silently holding bytes that were actually the
 * transport layer's real identity (a ZIP).
 */

export const DEFAULT_RAW_SOURCE_ARCHIVE_ROOT = 'artifacts/nse-raw-source-archive';

const HEX64_PATTERN = /^[a-f0-9]{64}$/;

/** The only two byte identities this archive ever stores: a raw/transport response, or an extracted/authoritative document. Both are always either a PDF or (transport-only) a ZIP envelope -- never anything else, by construction of `raw-source-content-validator.ts` / `raw-source-zip-envelope.util.ts`. */
export type RawSourceBlobExtension = 'pdf' | 'zip';

export type RawSourceStorageErrorCode = 'INVALID_SHA256' | 'EXISTING_BLOB_CORRUPTED' | 'ARCHIVE_RECEIPT_BLOB_MISSING' | 'ARCHIVE_RECEIPT_BLOB_CORRUPTED';

export class RawSourceStorageError extends Error {
  constructor(public readonly code: RawSourceStorageErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceStorageError';
  }
}

/**
 * Content-addressed, archive-root-relative locator for one blob (task
 * section 9: "<sha256>.pdf or similarly deterministic structure"). Never
 * derived from `reference` (task section 20: "Never construct filesystem
 * paths directly from unsanitized reference strings") -- the only inputs
 * are the blob's own proven byte hash and its own proven extension
 * (`RawSourceBlobExtension`, never inferred/guessed from context).
 */
export function rawSourceBlobRelativePath(sha256Hex: string, extension: RawSourceBlobExtension): string {
  if (!HEX64_PATTERN.test(sha256Hex)) {
    throw new RawSourceStorageError('INVALID_SHA256', `'${sha256Hex}' is not a lowercase 64-character hex SHA-256 digest.`);
  }
  // Always forward-slash, regardless of host OS (matches `parquetSessionRelativePath`'s convention) -- this path is persisted verbatim into JSON receipts that must be host-independent.
  return `blobs/${sha256Hex}.${extension}`;
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
export function storeRawSourceBlob(archiveRoot: string, bytes: Buffer, sha256Hex: string, extension: RawSourceBlobExtension): RawSourceBlobStoreResult {
  const relativePath = rawSourceBlobRelativePath(sha256Hex, extension);
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
 * Evidence-to-blob integrity check (task section 12/15, FIX-1 Defect C;
 * generalized under B-F7A-SOURCE-EVIDENCE-FIX-1 to work identically for
 * EITHER evidence layer -- transport or document -- since both are now
 * independently re-verifiable content-addressed blobs). Before a caller
 * treats existing evidence as trustworthy (an `IDEMPOTENT_MATCH`, or a
 * crash-recovery read), this proves `archiveRelativePath` is exactly the
 * locator `sha256`+`extension` derive (never just trusted as persisted),
 * that a blob actually exists there, that its size matches `byteLength`,
 * and that its bytes actually rehash to `sha256`. ANY failure is a hard,
 * fail-closed `ARCHIVE_RECEIPT_BLOB_MISSING`/`ARCHIVE_RECEIPT_BLOB_CORRUPTED`
 * error -- this function never redownloads, repairs, or silently re-derives
 * evidence; it only proves or disproves trust in evidence that already
 * claims to exist. `label` is observability-only (identifies WHICH
 * reference/layer failed in the thrown message).
 */
export function verifyBlobIntegrity(
  archiveRoot: string,
  label: string,
  evidence: { readonly sha256: string; readonly byteLength: number; readonly archiveRelativePath: string; readonly extension: RawSourceBlobExtension }
): void {
  const expectedRelativePath = rawSourceBlobRelativePath(evidence.sha256, evidence.extension);
  if (evidence.archiveRelativePath !== expectedRelativePath) {
    throw new RawSourceStorageError(
      'ARCHIVE_RECEIPT_BLOB_CORRUPTED',
      `${label} has archiveRelativePath '${evidence.archiveRelativePath}', inconsistent with the locator '${expectedRelativePath}' derived from its own sha256.`
    );
  }

  const absolutePath = join(archiveRoot, evidence.archiveRelativePath);
  if (!fileExists(absolutePath)) {
    throw new RawSourceStorageError('ARCHIVE_RECEIPT_BLOB_MISSING', `${label} references blob '${absolutePath}', which does not exist on disk.`);
  }

  const bytes = readFileBuffer(absolutePath);
  if (bytes.length !== evidence.byteLength) {
    throw new RawSourceStorageError('ARCHIVE_RECEIPT_BLOB_CORRUPTED', `${label} recorded byteLength ${evidence.byteLength}, but the blob on disk at '${absolutePath}' is ${bytes.length} bytes.`);
  }

  const actualHash = sha256HexOfBuffer(bytes);
  if (actualHash !== evidence.sha256) {
    throw new RawSourceStorageError('ARCHIVE_RECEIPT_BLOB_CORRUPTED', `${label} recorded sha256 '${evidence.sha256}', but the blob on disk at '${absolutePath}' hashes to '${actualHash}'.`);
  }
}
