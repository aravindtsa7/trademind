import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RawSourceContentChangedError,
  RawSourceReceiptIndex,
  RawSourceRetrievalReceipt,
  authoritativeDocumentIdentity,
  isLegacyZipDerivedReceipt,
  reconcileReceiptForArchive,
} from './raw-source-retrieval-receipt.types';

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
    documentEvidence: null,
    repairedFrom: null,
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

// ============================================================
// B-F7A-SOURCE-EVIDENCE-FIX-1: two-layer identity helpers
// ============================================================

test('authoritativeDocumentIdentity returns the RAW fields when documentEvidence is null (direct-PDF case)', () => {
  const r = receipt({ documentEvidence: null });
  const identity = authoritativeDocumentIdentity(r);
  assert.equal(identity.sha256, r.rawSha256);
  assert.equal(identity.byteLength, r.byteLength);
  assert.equal(identity.archiveRelativePath, r.archiveRelativePath);
});

test('authoritativeDocumentIdentity returns the DOCUMENT fields (never the raw/transport ones) when documentEvidence is present', () => {
  const documentSha = 'd'.repeat(64);
  const r = receipt({
    rawSha256: 'c'.repeat(64),
    archiveRelativePath: `blobs/${'c'.repeat(64)}.zip`,
    documentEvidence: { documentSha256: documentSha, documentByteLength: 999, documentArchiveRelativePath: `blobs/${documentSha}.pdf`, documentMemberName: 'CMTR60338.pdf', documentMediaType: 'application/pdf' },
  });
  const identity = authoritativeDocumentIdentity(r);
  assert.equal(identity.sha256, documentSha);
  assert.notEqual(identity.sha256, r.rawSha256);
  assert.equal(identity.byteLength, 999);
  assert.equal(identity.archiveRelativePath, `blobs/${documentSha}.pdf`);
});

test('isLegacyZipDerivedReceipt recognizes ONLY the exact pre-fix shape: no documentEvidence AND a .zip requested/resolved URL', () => {
  const legacy = receipt({ requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip', resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip', documentEvidence: null });
  assert.equal(isLegacyZipDerivedReceipt(legacy), true);
});

test('isLegacyZipDerivedReceipt never matches a normal direct-PDF receipt', () => {
  const direct = receipt({ documentEvidence: null }); // requestedUrl already ends in .pdf from the default fixture
  assert.equal(isLegacyZipDerivedReceipt(direct), false);
});

test('isLegacyZipDerivedReceipt never matches a receipt that already carries real document evidence, even if its URL ends in .zip', () => {
  const corrected = receipt({
    requestedUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip',
    resolvedFinalUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip',
    documentEvidence: { documentSha256: 'd'.repeat(64), documentByteLength: 1, documentArchiveRelativePath: `blobs/${'d'.repeat(64)}.pdf`, documentMemberName: 'CMTR60338.pdf', documentMediaType: 'application/pdf' },
  });
  assert.equal(isLegacyZipDerivedReceipt(corrected), false);
});
