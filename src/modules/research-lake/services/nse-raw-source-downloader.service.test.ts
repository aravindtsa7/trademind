import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import NseRawSourceHttpDownloaderService, { RawSourceDownloadError, RawSourceHttpRequestConfig, RawSourceHttpResponse, RawSourceHttpTransport } from './nse-raw-source-downloader.service';
import { RawSourceContentValidationError } from '../domain/raw-source-content-validator';
import { RawSourceUrlPolicyError } from '../domain/raw-source-url-policy';

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

test('(8) successfully archives a valid PDF response', async () => {
  const transport = new FakeTransport([await pdfResponse()]);
  const downloader = new NseRawSourceHttpDownloaderService(transport);
  const result = await downloader.download(APPROVED_URL);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.resolvedFinalUrl, APPROVED_URL);
  assert.equal(result.contentType, 'application/pdf');
  assert.ok(result.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
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
  assert.ok(result.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
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
