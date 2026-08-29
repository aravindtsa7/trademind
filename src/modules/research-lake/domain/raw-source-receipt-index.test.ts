import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiptIndexValidationError, emptyReceiptIndexEnvelope, validateReceiptIndexEnvelope } from './raw-source-receipt-index';
import { rawSourceBlobRelativePath } from './raw-source-archive-storage';

const HASH = 'a'.repeat(64);

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    reference: 'NSE/MSD/60340',
    requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
    resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
    httpStatus: 200,
    contentType: 'application/pdf',
    etag: null,
    lastModified: null,
    rawSha256: HASH,
    byteLength: 1234,
    retrievedAt: '2026-01-01T00:00:00.000Z',
    archiveRelativePath: rawSourceBlobRelativePath(HASH),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected ReceiptIndexValidationError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof ReceiptIndexValidationError, `Expected ReceiptIndexValidationError, got ${error}`);
    assert.equal((error as ReceiptIndexValidationError).code, code);
  }
}

test('the empty envelope validates', () => {
  const result = validateReceiptIndexEnvelope(emptyReceiptIndexEnvelope());
  assert.deepEqual(result.receipts, {});
});

test('(14) a well-formed envelope with one valid receipt validates', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt() } };
  const result = validateReceiptIndexEnvelope(raw);
  assert.equal(result.receipts['NSE/MSD/60340'].rawSha256, HASH);
});

test('(15) an unsupported schema version is rejected', () => {
  expectCode(() => validateReceiptIndexEnvelope({ schemaVersion: 99, receipts: {} }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('(15) a non-object top-level value is rejected', () => {
  expectCode(() => validateReceiptIndexEnvelope('not an object'), 'INVALID_ENVELOPE_SHAPE');
  expectCode(() => validateReceiptIndexEnvelope(null), 'INVALID_ENVELOPE_SHAPE');
  expectCode(() => validateReceiptIndexEnvelope([]), 'INVALID_ENVELOPE_SHAPE');
});

test('(15) a malformed receipts container is rejected', () => {
  expectCode(() => validateReceiptIndexEnvelope({ schemaVersion: 1, receipts: 'not-an-object' }), 'INVALID_ENVELOPE_SHAPE');
  expectCode(() => validateReceiptIndexEnvelope({ schemaVersion: 1, receipts: [] }), 'INVALID_ENVELOPE_SHAPE');
});

test('an index key that is not a valid reference is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'not-a-reference': validReceipt({ reference: 'not-a-reference' }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_REFERENCE_KEY');
});

test('a receipt whose own reference field disagrees with its index key is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ reference: 'NSE/MSD/99999' }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'REFERENCE_KEY_MISMATCH');
});

test('a malformed SHA-256 is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ rawSha256: 'not-a-hash' }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_SHA256');
});

test('a blob locator inconsistent with its own rawSha256 is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ archiveRelativePath: `blobs/${'f'.repeat(64)}.pdf` }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_BLOB_LOCATOR');
});

test('a malformed URL field is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ requestedUrl: 'not a url' }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_URL');
});

test('a non-2xx httpStatus is rejected (only successful terminal responses are ever persisted)', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ httpStatus: 404 }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_HTTP_STATUS');
});

test('a negative/non-integer byteLength is rejected', () => {
  expectCode(() => validateReceiptIndexEnvelope({ schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ byteLength: -1 }) } }), 'INVALID_BYTE_LENGTH');
  expectCode(() => validateReceiptIndexEnvelope({ schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ byteLength: 1.5 }) } }), 'INVALID_BYTE_LENGTH');
});

test('an unparseable retrievedAt is rejected', () => {
  const raw = { schemaVersion: 1, receipts: { 'NSE/MSD/60340': validReceipt({ retrievedAt: 'not-a-date' }) } };
  expectCode(() => validateReceiptIndexEnvelope(raw), 'INVALID_RETRIEVED_AT');
});

test('one malformed receipt fails the WHOLE index closed -- valid sibling entries are never partially accepted', () => {
  const raw = {
    schemaVersion: 1,
    receipts: {
      'NSE/MSD/60340': validReceipt(),
      'NSE/CMTR/59722': validReceipt({ reference: 'NSE/CMTR/59722', rawSha256: 'bad-hash', archiveRelativePath: rawSourceBlobRelativePath(HASH) }),
    },
  };
  assert.throws(() => validateReceiptIndexEnvelope(raw), ReceiptIndexValidationError);
});
