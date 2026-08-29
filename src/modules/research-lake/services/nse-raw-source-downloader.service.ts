import axios from 'axios';
import logger from '../../../core/logger/logger';
import { assertApprovedRawSourceUrl } from '../domain/raw-source-url-policy';
import { assertValidRawPdfBytes, MAX_RAW_SOURCE_BYTES } from '../domain/raw-source-content-validator';

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

export interface RawSourceDownloadResult {
  readonly requestedUrl: string;
  readonly resolvedFinalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly bytes: Buffer;
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
 * `assertValidRawPdfBytes` runs on the terminal response body before this
 * method returns -- callers never receive unvalidated bytes.
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

      const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
      await assertValidRawPdfBytes(bytes);

      return {
        requestedUrl: url,
        resolvedFinalUrl: currentUrl,
        httpStatus: response.status,
        contentType: response.headers['content-type'] ?? null,
        etag: response.headers['etag'] ?? null,
        lastModified: response.headers['last-modified'] ?? null,
        bytes,
      };
    }

    throw new RawSourceDownloadError('TOO_MANY_REDIRECTS', `'${url}' exceeded the maximum of ${MAX_REDIRECT_HOPS} redirect hops.`);
  }
}
