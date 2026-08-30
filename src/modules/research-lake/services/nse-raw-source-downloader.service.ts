import axios from 'axios';
import logger from '../../../core/logger/logger';
import { assertApprovedRawSourceUrl } from '../domain/raw-source-url-policy';
import { assertValidRawPdfBytes, MAX_RAW_SOURCE_BYTES } from '../domain/raw-source-content-validator';
import { deriveExpectedZipMemberBasename, extractZipMember, looksLikeZipEnvelope } from '../domain/raw-source-zip-envelope.util';

/**
 * B-F7A-ARCHIVE-1 official-source downloader (task section 6/11/20). A small
 * injectable transport interface (matching the existing repo convention of a
 * hand-rolled test double for `axios.get`, e.g.
 * `groww-historical-client.test.ts`) rather than a mocking library, so tests
 * never touch the real network.
 */
export interface RawSourceHttpResponse {
  readonly status: number;
  readonly data: ArrayBuffer | Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface RawSourceHttpRequestConfig {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface RawSourceHttpTransport {
  get(url: string, config: RawSourceHttpRequestConfig): Promise<RawSourceHttpResponse>;
}

/**
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect A): the reference-bound PDF
 * unwrapped from a ZIP transport envelope, kept as its OWN distinct object
 * -- never merged back into a single ambiguous `bytes` field. `mediaType`
 * is always `'application/pdf'` today (the only thing this extractor ever
 * produces), carried explicitly rather than assumed at every call site.
 */
export interface RawSourceExtractedDocument {
  readonly bytes: Buffer;
  readonly memberName: string;
  readonly mediaType: string;
}

export interface RawSourceDownloadResult {
  readonly requestedUrl: string;
  readonly resolvedFinalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** LAYER A / TRANSPORT: the EXACT terminal HTTP response bytes, always -- never extracted/unwrapped (Terra Defect A). For a ZIP-wrapped source this is the ZIP itself. */
  readonly rawBytes: Buffer;
  /** LAYER B / DOCUMENT: non-null ONLY when `rawBytes` was a ZIP envelope that had to be unwrapped. `null` means the document IS `rawBytes` (the common direct-PDF case). */
  readonly document: RawSourceExtractedDocument | null;
}

export type RawSourceDownloadErrorCode =
  | 'HTTP_STATUS_REJECTED'
  | 'MISSING_REDIRECT_LOCATION'
  | 'TOO_MANY_REDIRECTS'
  | 'TRANSPORT_ERROR';

export class RawSourceDownloadError extends Error {
  constructor(public readonly code: RawSourceDownloadErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RawSourceDownloadError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECT_HOPS = 5;
const EXTRACTED_DOCUMENT_MEDIA_TYPE = 'application/pdf';

/**
 * B-F7A-SOURCE-EVIDENCE-1: live retrieval against the real
 * `nsearchives.nseindia.com` host proved that axios's bare default request
 * (no `User-Agent`/`Accept` headers at all) is rejected by NSE's Akamai edge
 * with a bare `503` before ever reaching the actual file -- verified
 * directly with the production transport during this task, not assumed. A
 * standard browser-shaped request (the same header set a real browser
 * sends) succeeds. These are STATIC headers only -- no cookies, no
 * authentication/session state, no credential scraping -- and do not change
 * WHAT is requested or WHICH host/path policy applies, only whether NSE's
 * edge accepts the connection at all. Terra explicitly accepted this
 * correction; kept as a named constant (task section 22) purely for
 * reviewability, not behavior change.
 */
const NSE_BROWSER_SHAPED_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/pdf,application/zip,application/octet-stream,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/',
};

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Real network transport backed by `axios`. `maxRedirects: 0` disables
 * axios's own automatic redirect following entirely -- the caller
 * (`NseRawSourceHttpDownloaderService`) follows redirects itself, one hop at
 * a time, so it can revalidate each target URL against the approved-host
 * policy BEFORE the next request is ever made (task section 6: "Redirects,
 * if allowed, must be revalidated at every hop").
 */
class AxiosRawSourceHttpTransport implements RawSourceHttpTransport {
  async get(url: string, config: RawSourceHttpRequestConfig): Promise<RawSourceHttpResponse> {
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: config.timeoutMs,
        maxRedirects: 0,
        maxContentLength: config.maxBytes,
        maxBodyLength: config.maxBytes,
        validateStatus: () => true,
        headers: NSE_BROWSER_SHAPED_REQUEST_HEADERS,
      });
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers[key.toLowerCase()] = typeof value === 'string' ? value : undefined;
      }
      return { status: response.status, data: response.data, headers };
    } catch (error) {
      throw new RawSourceDownloadError('TRANSPORT_ERROR', `Network/transport error fetching '${url}': ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }
}

/**
 * Fetches and fully validates one official NSE source document (task section
 * 6/11/20). Every response byte is bounds-checked (`config.maxBytes`) and
 * every URL -- the initial one AND every redirect hop -- is revalidated
 * against `assertApprovedRawSourceUrl` before it is ever requested, so a
 * redirect can never silently escape the approved host/path allowlist.
 *
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect A): the returned `rawBytes` are
 * ALWAYS the exact terminal HTTP response body, untouched -- if that body is
 * itself a ZIP envelope (task section 4/37), the reference-bound PDF member
 * inside it is unwrapped into a SEPARATE `document` field rather than
 * silently replacing `rawBytes`. `assertValidRawPdfBytes` always runs on the
 * DOCUMENT bytes (whichever they are -- `document.bytes` when present,
 * `rawBytes` otherwise) before this method returns -- callers never receive
 * an unvalidated document, and never lose the raw transport evidence.
 */
export default class NseRawSourceHttpDownloaderService {
  constructor(
    private readonly transport: RawSourceHttpTransport = new AxiosRawSourceHttpTransport(),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly maxBytes: number = MAX_RAW_SOURCE_BYTES
  ) {}

  async download(url: string): Promise<RawSourceDownloadResult> {
    assertApprovedRawSourceUrl(url);

    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      logger.info('Requesting NSE raw source document', { url: currentUrl, hop });
      const response = await this.transport.get(currentUrl, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });

      if (isRedirectStatus(response.status)) {
        const location = response.headers['location'];
        if (!location) {
          throw new RawSourceDownloadError('MISSING_REDIRECT_LOCATION', `'${currentUrl}' responded ${response.status} with no Location header.`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        assertApprovedRawSourceUrl(nextUrl); // revalidate at every hop
        currentUrl = nextUrl;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new RawSourceDownloadError('HTTP_STATUS_REJECTED', `'${currentUrl}' responded with non-success HTTP status ${response.status}.`);
      }

      const rawBytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

      // B-F7A-SOURCE-EVIDENCE-FIX-1 (task section 4/37): a small number of
      // real NSE circulars are published at their approved path as a `.zip`
      // bundle rather than a bare PDF. Detected by the response body's own
      // magic bytes (never inferred from the request URL alone), and only
      // the single member whose name is PROVEN to match this reference's
      // expected `<DEPT><NUMBER>.pdf` basename is ever extracted -- see
      // `raw-source-zip-envelope.util.ts`. `rawBytes` itself is NEVER
      // replaced by the extraction -- it stays the exact transport bytes.
      let document: RawSourceExtractedDocument | null = null;
      if (looksLikeZipEnvelope(rawBytes)) {
        const memberName = deriveExpectedZipMemberBasename(currentUrl);
        document = { bytes: extractZipMember(rawBytes, memberName), memberName, mediaType: EXTRACTED_DOCUMENT_MEDIA_TYPE };
      }

      await assertValidRawPdfBytes(document?.bytes ?? rawBytes);

      return {
        requestedUrl: url,
        resolvedFinalUrl: currentUrl,
        httpStatus: response.status,
        contentType: response.headers['content-type'] ?? null,
        etag: response.headers['etag'] ?? null,
        lastModified: response.headers['last-modified'] ?? null,
        rawBytes,
        document,
      };
    }

    throw new RawSourceDownloadError('TOO_MANY_REDIRECTS', `'${url}' exceeded the maximum of ${MAX_REDIRECT_HOPS} redirect hops.`);
  }
}
