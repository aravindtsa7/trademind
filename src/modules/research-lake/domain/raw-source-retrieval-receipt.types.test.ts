import assert from 'node:assert/strict';
import test from 'node:test';
import { RawSourceContentChangedError, RawSourceReceiptIndex, RawSourceRetrievalReceipt, reconcileReceiptForArchive } from './raw-source-retrieval-receipt.types';

function receipt(overrides: Partial<RawSourceRetrievalReceipt> = {}): RawSourceRetrievalReceipt {
  return {
    reference: 'NSE/MSD/60340',
    requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf',
    resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf',
    httpStatus: 200,
    contentType: 'application/pdf',
    etag: null,
    lastModified: null,
    rawSha256: 'a'.repeat(64),
    byteLength: 1234,
    retrievedAt: '2026-01-01T00:00:00.000Z',
    archiveRelativePath: `blobs/${'a'.repeat(64)}.pdf`,
    ...overrides,
  };
}

const RETRIEVAL_METADATA = {
  requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf',
  resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/x.pdf',
  httpStatus: 200,
  byteLength: 1234,
  retrievedAt: '2026-02-01T00:00:00.000Z',
};

test('a brand-new reference reconciles as NEW', () => {
  const index: RawSourceReceiptIndex = {};
  const outcome = reconcileReceiptForArchive('NSE/MSD/60340', 'b'.repeat(64), index, RETRIEVAL_METADATA);
  assert.equal(outcome.outcome, 'NEW');
});

test('(17) same reference + same bytes is idempotent', () => {
  const existing = receipt();
  const index: RawSourceReceiptIndex = { 'NSE/MSD/60340': existing };
  const outcome = reconcileReceiptForArchive('NSE/MSD/60340', existing.rawSha256, index, RETRIEVAL_METADATA);
  assert.equal(outcome.outcome, 'IDEMPOTENT_MATCH');
  if (outcome.outcome === 'IDEMPOTENT_MATCH') {
    assert.equal(outcome.existingReceipt, existing);
  }
});

test('(18) same reference + different bytes produces a hard SOURCE_CONTENT_CHANGED conflict, never a silent overwrite', () => {
  const existing = receipt({ rawSha256: 'a'.repeat(64) });
  const index: RawSourceReceiptIndex = { 'NSE/MSD/60340': existing };

  assert.throws(
    () => reconcileReceiptForArchive('NSE/MSD/60340', 'c'.repeat(64), index, RETRIEVAL_METADATA),
    (error: unknown) => {
      assert.ok(error instanceof RawSourceContentChangedError);
      assert.equal(error.reference, 'NSE/MSD/60340');
      assert.equal(error.existingReceipt.rawSha256, 'a'.repeat(64));
      assert.equal(error.newSha256, 'c'.repeat(64));
      assert.equal(error.newRetrievalMetadata.retrievedAt, RETRIEVAL_METADATA.retrievedAt);
      return true;
    }
  );
});

test('conflict error message names both the existing and new hash for human review', () => {
  const existing = receipt({ rawSha256: 'a'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z' });
  const index: RawSourceReceiptIndex = { 'NSE/MSD/60340': existing };
  try {
    reconcileReceiptForArchive('NSE/MSD/60340', 'c'.repeat(64), index, RETRIEVAL_METADATA);
    assert.fail('expected RawSourceContentChangedError');
  } catch (error) {
    assert.ok(error instanceof RawSourceContentChangedError);
    assert.match(error.message, /SOURCE_CONTENT_CHANGED/);
    assert.match(error.message, new RegExp('a'.repeat(64)));
    assert.match(error.message, new RegExp('c'.repeat(64)));
  }
});

test('a different reference in the same index is unaffected (NEW), never confused with an unrelated conflict', () => {
  const existing = receipt({ reference: 'NSE/MSD/60340', rawSha256: 'a'.repeat(64) });
  const index: RawSourceReceiptIndex = { 'NSE/MSD/60340': existing };
  const outcome = reconcileReceiptForArchive('NSE/MSD/61893', 'd'.repeat(64), index, RETRIEVAL_METADATA);
  assert.equal(outcome.outcome, 'NEW');
});
