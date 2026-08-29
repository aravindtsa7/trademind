import { isValidRawSourceReference } from './raw-source-archive.types';
import { RawSourceReceiptIndex, RawSourceRetrievalReceipt } from './raw-source-retrieval-receipt.types';
import { rawSourceBlobRelativePath } from './raw-source-archive-storage';

/**
 * B-F7A-ARCHIVE-1-FIX-1 Defect C correction (task section 11). The receipt
 * index persisted at `receipts/receipt-index.json` used to be read with a
 * bare `JSON.parse(...) as RawSourceReceiptIndex` type assertion -- a
 * malformed or hand-edited file would silently be trusted as if every field
 * had already been proven correct. This module replaces that with full
 * runtime structural validation; the loader (`nse-raw-source-archiver.service.ts`)
 * now fails closed on anything this does not accept, and NEVER falls back to
 * treating malformed content as an empty index (task section 11: "Malformed
 * receipt index: FAIL CLOSED. Do not treat malformed JSON as empty state.").
 */

export const RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION = 1;

export interface RawSourceReceiptIndexEnvelope {
  readonly schemaVersion: number;
  readonly receipts: RawSourceReceiptIndex;
}

export type ReceiptIndexErrorCode =
  | 'INVALID_ENVELOPE_SHAPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_REFERENCE_KEY'
  | 'REFERENCE_KEY_MISMATCH'
  | 'INVALID_RECEIPT_SHAPE'
  | 'INVALID_SHA256'
  | 'INVALID_BLOB_LOCATOR'
  | 'INVALID_URL'
  | 'INVALID_HTTP_STATUS'
  | 'INVALID_BYTE_LENGTH'
  | 'INVALID_RETRIEVED_AT';

export class ReceiptIndexValidationError extends Error {
  constructor(public readonly code: ReceiptIndexErrorCode, message: string) {
    super(message);
    this.name = 'ReceiptIndexValidationError';
  }
}

const HEX64_PATTERN = /^[a-f0-9]{64}$/;

function fail(code: ReceiptIndexErrorCode, message: string): never {
  throw new ReceiptIndexValidationError(code, message);
}

function isWellFormedUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateReceipt(key: string, raw: unknown): RawSourceRetrievalReceipt {
  if (typeof raw !== 'object' || raw === null) fail('INVALID_RECEIPT_SHAPE', `Receipt for key '${key}' must be an object.`);
  const receipt = raw as Record<string, unknown>;

  if (!isValidRawSourceReference(receipt.reference)) {
    fail('INVALID_REFERENCE_KEY', `Receipt for key '${key}' has an invalid or missing 'reference' field.`);
  }
  if (receipt.reference !== key) {
    fail('REFERENCE_KEY_MISMATCH', `Receipt index key '${key}' does not match its own receipt.reference '${String(receipt.reference)}'.`);
  }
  if (!isWellFormedUrl(receipt.requestedUrl)) fail('INVALID_URL', `Receipt for '${key}': requestedUrl must be a well-formed URL string.`);
  if (!isWellFormedUrl(receipt.resolvedFinalUrl)) fail('INVALID_URL', `Receipt for '${key}': resolvedFinalUrl must be a well-formed URL string.`);
  if (!Number.isInteger(receipt.httpStatus) || (receipt.httpStatus as number) < 200 || (receipt.httpStatus as number) > 299) {
    fail('INVALID_HTTP_STATUS', `Receipt for '${key}': httpStatus must be an integer in [200, 299] -- only successful terminal responses are ever persisted as receipts.`);
  }
  if (receipt.contentType !== null && typeof receipt.contentType !== 'string') fail('INVALID_RECEIPT_SHAPE', `Receipt for '${key}': contentType must be a string or null.`);
  if (receipt.etag !== null && typeof receipt.etag !== 'string') fail('INVALID_RECEIPT_SHAPE', `Receipt for '${key}': etag must be a string or null.`);
  if (receipt.lastModified !== null && typeof receipt.lastModified !== 'string') fail('INVALID_RECEIPT_SHAPE', `Receipt for '${key}': lastModified must be a string or null.`);
  if (typeof receipt.rawSha256 !== 'string' || !HEX64_PATTERN.test(receipt.rawSha256)) {
    fail('INVALID_SHA256', `Receipt for '${key}': rawSha256 must be a lowercase 64-character hex digest.`);
  }
  if (!Number.isInteger(receipt.byteLength) || (receipt.byteLength as number) < 0) {
    fail('INVALID_BYTE_LENGTH', `Receipt for '${key}': byteLength must be a non-negative integer.`);
  }
  if (typeof receipt.retrievedAt !== 'string' || Number.isNaN(Date.parse(receipt.retrievedAt))) {
    fail('INVALID_RETRIEVED_AT', `Receipt for '${key}': retrievedAt must be a parseable ISO timestamp string.`);
  }

  const expectedLocator = rawSourceBlobRelativePath(receipt.rawSha256 as string);
  if (receipt.archiveRelativePath !== expectedLocator) {
    fail('INVALID_BLOB_LOCATOR', `Receipt for '${key}': archiveRelativePath '${String(receipt.archiveRelativePath)}' does not match the locator '${expectedLocator}' derived from its own rawSha256.`);
  }

  return {
    reference: receipt.reference as string,
    requestedUrl: receipt.requestedUrl as string,
    resolvedFinalUrl: receipt.resolvedFinalUrl as string,
    httpStatus: receipt.httpStatus as number,
    contentType: (receipt.contentType as string | null) ?? null,
    etag: (receipt.etag as string | null) ?? null,
    lastModified: (receipt.lastModified as string | null) ?? null,
    rawSha256: receipt.rawSha256 as string,
    byteLength: receipt.byteLength as number,
    retrievedAt: receipt.retrievedAt as string,
    archiveRelativePath: receipt.archiveRelativePath as string,
  };
}

/**
 * Fails closed on ANY structural problem: wrong envelope shape, unsupported
 * schema version, a reference-index key that doesn't look like a reference
 * or disagrees with its own receipt's `reference` field, or any individual
 * receipt field that fails validation (task section 11's full checklist).
 * Never repairs, drops, or silently reinterprets a malformed entry -- one
 * bad receipt fails the WHOLE index closed, exactly like the calendar
 * fixture importer's "reject before mutation" convention.
 */
export function validateReceiptIndexEnvelope(raw: unknown): RawSourceReceiptIndexEnvelope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('INVALID_ENVELOPE_SHAPE', 'Receipt index must be a plain object.');
  const envelope = raw as Record<string, unknown>;

  if (envelope.schemaVersion !== RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `Unsupported receipt index schemaVersion '${String(envelope.schemaVersion)}'; expected ${RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION}.`);
  }
  if (typeof envelope.receipts !== 'object' || envelope.receipts === null || Array.isArray(envelope.receipts)) {
    fail('INVALID_ENVELOPE_SHAPE', 'Receipt index receipts must be a plain object keyed by reference.');
  }

  const receipts: Record<string, RawSourceRetrievalReceipt> = {};
  for (const [key, value] of Object.entries(envelope.receipts as Record<string, unknown>)) {
    receipts[key] = validateReceipt(key, value);
  }

  return { schemaVersion: RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION, receipts };
}

/** The empty, valid envelope a fresh archive root starts from. */
export function emptyReceiptIndexEnvelope(): RawSourceReceiptIndexEnvelope {
  return { schemaVersion: RAW_SOURCE_RECEIPT_INDEX_SCHEMA_VERSION, receipts: {} };
}
