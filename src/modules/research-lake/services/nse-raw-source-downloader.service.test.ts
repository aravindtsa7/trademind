import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import NseRawSourceHttpDownloaderService, { RawSourceDownloadError, RawSourceHttpRequestConfig, RawSourceHttpResponse, RawSourceHttpTransport } from './nse-raw-source-downloader.service';
import { RawSourceContentValidationError } from '../domain/raw-source-content-validator';
import { RawSourceUrlPolicyError } from '../domain/raw-source-url-policy';
import { RawSourceZipEnvelopeError } from '../domain/raw-source-zip-envelope.util';

const APPROVED_URL = 'https://nsearchives.nseindia.com/content/circulars/CMPT60340.pdf';

class FakeTransport implements RawSourceHttpTransport {
  readonly calls: string[] = [];
  constructor(private readonly responses: readonly (RawSourceHttpResponse | Error)[]) {}

  async get(url: string, _config: RawSourceHttpRequestConfig): Promise<RawSourceHttpResponse> {
    this.calls.push(url);
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) throw new Error(`FakeTransport: no response configured for call #${this.calls.length} (url=${url}).`);
    if (response instanceof Error) throw response;
    return response;
  }
}

/**
 * FIX-2: the content validator now requires actual PDF parseability, so
 * this must be a genuinely loadable PDF, not just header/trailer-shaped
 * text. Built once and cached -- every test that needs "a valid PDF
 * response" shares the same bytes.
 */
let cachedValidPdfBytes: Buffer | null = null;
async function validSyntheticPdfBytes(): Promise<Buffer> {
  if (cachedValidPdfBytes === null) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]);
    cachedValidPdfBytes = Buffer.from(await doc.save());
  }
  return cachedValidPdfBytes;
}

async function pdfResponse(status = 200, extraHeaders: Record<string, string> = {}): Promise<RawSourceHttpResponse> {
  return {
    status,
    data: await validSyntheticPdfBytes(),
    headers: { 'content-type': 'application/pdf', ...extraHeaders },
  };
}

/**
 * A minimal single-entry ZIP wrapping `members`' bytes, hand-assembled the
 * same way `raw-source-zip-envelope.util.test.ts` does (independent of
 * `extractZipMember` itself). Used here only to prove `download()` actually
 * wires the zip-envelope unwrap into the live HTTP path end to end -- the
 * extractor's own edge cases (encryption, CRC mismatch, ZIP64, ...) are
 * covered exhaustively in that other suite, not repeated here.
 */
function buildSingleEntryZip(memberName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(memberName, 'utf8');
  const data = deflateRawSync(content);
  const entryCrc32 = crc32(content) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // DEFLATE
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(entryCrc32, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const localSection = Buffer.concat([localHeader, nameBytes, data]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(entryCrc32, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // local header offset
  const centralSection = Buffer.concat([centralHeader, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

/** STORE-method (uncompressed) sibling of `buildSingleEntryZip` -- same content, deliberately different transport bytes, used to prove transport drift is observable even when the wrapped document is identical. */
function buildSingleEntryZipStored(memberName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(memberName, 'utf8');
  const entryCrc32 = crc32(content) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8); // STORE
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(entryCrc32, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const localSection = Buffer.concat([localHeader, nameBytes, content]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10); // STORE
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(entryCrc32, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralSection = Buffer.concat([centralHeader, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

test('(8) successfully archives a valid PDF response', async () => {
  const transport = new FakeTransport([await pdfResponse()]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  const result = await downloader.download(APPROVED_URL);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.resolvedFinalUrl, APPROVED_URL);
  assert.equal(result.contentType, 'application/pdf');
  assert.ok(result.rawBytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(result.document, null, 'a direct-PDF response carries no separate document layer -- rawBytes IS the document');
});

test('the initial URL is validated against the approved-host policy before any request is made', async () => {
  const transport = new FakeTransport([await pdfResponse()]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download('https://evil.example.com/content/circulars/x.pdf'), RawSourceUrlPolicyError);
  assert.equal(transport.calls.length, 0, 'must not have made any HTTP call for a policy-rejected URL');
});

test('(9) an empty response body is rejected', async () => {
  const transport = new FakeTransport([{ status: 200, data: Buffer.alloc(0), headers: {} }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceContentValidationError);
});

test('(10) a non-PDF body is rejected', async () => {
  const transport = new FakeTransport([{ status: 200, data: Buffer.from('not a pdf'), headers: {} }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceContentValidationError);
});

test('(11) an HTML/challenge page returned with HTTP 200 is rejected', async () => {
  const transport = new FakeTransport([{ status: 200, data: Buffer.from('<html><body>Access Denied</body></html>'), headers: { 'content-type': 'text/html' } }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceContentValidationError);
});

test('(12) a bad HTTP status is rejected', async () => {
  const transport = new FakeTransport([{ status: 404, data: Buffer.from('not found'), headers: {} }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceDownloadError);
});

test('(13) a transport-level error (e.g. timeout) propagates rather than being swallowed', async () => {
  const transport = new FakeTransport([new Error('ETIMEDOUT')]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), /ETIMEDOUT/);
});

test('redirects are followed only up to an approved host, and revalidated at every hop', async () => {
  const secondUrl = 'https://archives.nseindia.com/content/circulars/CMPT60340.pdf';
  const transport = new FakeTransport([{ status: 302, data: Buffer.alloc(0), headers: { location: secondUrl } }, await pdfResponse()]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  const result = await downloader.download(APPROVED_URL);
  assert.equal(result.resolvedFinalUrl, secondUrl);
  assert.deepEqual(transport.calls, [APPROVED_URL, secondUrl]);
});

test('a redirect to an unapproved host is rejected before the second request is made', async () => {
  const badTarget = 'https://attacker.example.com/content/circulars/x.pdf';
  const transport = new FakeTransport([{ status: 302, data: Buffer.alloc(0), headers: { location: badTarget } }, await pdfResponse()]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceUrlPolicyError);
  assert.equal(transport.calls.length, 1, 'must not have followed the redirect to an unapproved host');
});

test('a redirect with no Location header is rejected', async () => {
  const transport = new FakeTransport([{ status: 302, data: Buffer.alloc(0), headers: {} }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceDownloadError);
});

test('(I) a fake Content-Type paired with non-PDF bytes is still REJECTED -- Content-Type is never trusted to justify accepting bad bytes', async () => {
  const transport = new FakeTransport([{ status: 200, data: Buffer.from('not a pdf at all'), headers: { 'content-type': 'application/pdf' } }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), RawSourceContentValidationError);
});

test('(J) valid PDF bytes with a misleading/non-ideal Content-Type are still ACCEPTED -- Content-Type is never used to reject genuinely good bytes either', async () => {
  const transport = new FakeTransport([await pdfResponse(200, { 'content-type': 'application/octet-stream' })]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  const result = await downloader.download(APPROVED_URL);
  assert.equal(result.contentType, 'application/octet-stream');
  assert.ok(result.rawBytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
});

test('a response body that is a ZIP envelope is unwrapped to its reference-bound PDF member in a SEPARATE `document` field -- rawBytes stays the exact ZIP transport bytes, never replaced (Terra Defect A)', async () => {
  const pdfBytes = await validSyntheticPdfBytes();
  const zipUrl = 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip';
  const zip = buildSingleEntryZip('CMTR60338.pdf', pdfBytes);
  const transport = new FakeTransport([{ status: 200, data: zip, headers: { 'content-type': 'application/zip' } }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  const result = await downloader.download(zipUrl);
  assert.deepEqual(result.rawBytes, zip, 'rawBytes must be the exact ZIP transport bytes, not the extracted PDF');
  assert.ok(result.document !== null);
  assert.deepEqual(result.document!.bytes, pdfBytes);
  assert.ok(result.document!.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(result.document!.memberName, 'CMTR60338.pdf');
  assert.equal(result.document!.mediaType, 'application/pdf');
});

test('a ZIP envelope whose only entry does NOT match the reference-derived basename is rejected, never extracted positionally', async () => {
  const pdfBytes = await validSyntheticPdfBytes();
  const zipUrl = 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip';
  const zip = buildSingleEntryZip('SomeOtherFile.pdf', pdfBytes);
  const transport = new FakeTransport([{ status: 200, data: zip, headers: { 'content-type': 'application/zip' } }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(zipUrl), (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_NOT_FOUND');
});

test('a ZIP-extracted member that is not actually a valid PDF is still rejected by the same content validator', async () => {
  const zipUrl = 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip';
  const zip = buildSingleEntryZip('CMTR60338.pdf', Buffer.from('not a pdf'));
  const transport = new FakeTransport([{ status: 200, data: zip, headers: { 'content-type': 'application/zip' } }]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(zipUrl), RawSourceContentValidationError);
});

test('two ZIP envelopes with different transport bytes (different DEFLATE encoding) but the SAME extracted PDF still report DIFFERENT rawBytes -- the transport drift is never hidden by the downloader layer', async () => {
  const pdfBytes = await validSyntheticPdfBytes();
  const zipUrl = 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip';
  // Two independently-built ZIP byte streams (different local/central header padding via STORE vs DEFLATE) wrapping the identical PDF payload.
  const zipViaDeflate = buildSingleEntryZip('CMTR60338.pdf', pdfBytes);
  const zipViaStore = buildSingleEntryZipStored('CMTR60338.pdf', pdfBytes);
  assert.notDeepEqual(zipViaDeflate, zipViaStore, 'test setup sanity: the two ZIP encodings must actually differ in bytes');

  const downloader1 = new NseRawSourceHttpDownloaderService(new FakeTransport([{ status: 200, data: zipViaDeflate, headers: { 'content-type': 'application/zip' } }]));
  const downloader2 = new NseRawSourceHttpDownloaderService(new FakeTransport([{ status: 200, data: zipViaStore, headers: { 'content-type': 'application/zip' } }]));
  const result1 = await downloader1.download(zipUrl);
  const result2 = await downloader2.download(zipUrl);

  assert.notDeepEqual(result1.rawBytes, result2.rawBytes, 'transport bytes must differ -- this is the observable transport drift');
  assert.deepEqual(result1.document!.bytes, result2.document!.bytes, 'the authoritative document bytes are identical either way');
  assert.deepEqual(result1.document!.bytes, pdfBytes);
});

test('too many redirect hops is rejected rather than looping forever', async () => {
  const responses: RawSourceHttpResponse[] = [];
  for (let i = 0; i < 10; i += 1) {
    responses.push({ status: 302, data: Buffer.alloc(0), headers: { location: APPROVED_URL } });
  }
  const transport = new FakeTransport(responses);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  await assert.rejects(() => downloader.download(APPROVED_URL), (error: unknown) => error instanceof RawSourceDownloadError && error.code === 'TOO_MANY_REDIRECTS');
});
