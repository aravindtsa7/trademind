import { createHash } from 'node:crypto';
import axios, { AxiosInstance } from 'axios';

const growwApiBaseUrl = 'https://api.groww.in';

/**
 * A Groww API-key/secret credential is invalid, or the approval endpoint
 * itself rejected the request (401/403). Permanent -- never retried
 * blindly. `httpStatus` is `undefined` for a non-HTTP failure (e.g. this
 * client's own strict response-shape validation).
 */
export class GrowwAccessTokenProviderError extends Error {
  constructor(message: string, public readonly httpStatus: number | undefined, public readonly cause: unknown) {
    super(message);
    this.name = 'GrowwAccessTokenProviderError';
  }
}

/**
 * Narrowly-scoped, in-memory-only Groww access-token generator (task B-F4,
 * section 10). Uses the documented "approval" flow:
 *
 *   POST /v1/token/api/access
 *   Authorization: Bearer <GROWW_API_KEY>
 *   body: { key_type: "approval", checksum: SHA256(GROWW_API_SECRET + timestamp), timestamp }
 *
 * NEVER persists `GROWW_API_KEY`, `GROWW_API_SECRET`, or the generated
 * access token to disk/DB/artifacts -- the token is cached only in this
 * instance's memory for the lifetime of the process (`getAccessToken()` is
 * idempotent once a token is cached; call `invalidate()` after a 401/403 to
 * force regeneration on the next call). Never logs the key/secret/token or
 * any request/response header -- only a caught error's HTTP status is ever
 * read, matching the established pattern in `GrowwHistoricalClient`.
 *
 * LIVE-CONFIRMED (task B-F4 section 0 controlled proof, against a real
 * `GROWW_API_KEY`/`GROWW_API_SECRET`): `timestamp` MUST be epoch SECONDS,
 * not milliseconds -- a millisecond value returns a real
 * `{"error":{"errorCode":"400","errorMessage":"timestamp must be in epoch
 * seconds format"}}`. The real success response is `{ token, tokenRefId,
 * sessionName, expiry, active }`; only `token` is read, matching the
 * strict-fail-closed handling below. Fails closed
 * (`GrowwAccessTokenProviderError`) on anything else rather than guessing
 * an alternative field name.
 */
export default class GrowwAccessTokenProviderService {
  private cachedToken: string | null = null;
  private readonly axios: AxiosInstance;

  constructor(
    private readonly apiKey: string = process.env.GROWW_API_KEY?.trim() ?? '',
    private readonly apiSecret: string = process.env.GROWW_API_SECRET?.trim() ?? '',
    axiosInstance?: AxiosInstance
  ) {
    this.axios = axiosInstance ?? axios.create({ baseURL: growwApiBaseUrl, timeout: 15_000 });
  }

  /** Returns the cached token if one is already held; otherwise generates and caches a new one. */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    if (!this.apiKey || !this.apiSecret) {
      throw new GrowwAccessTokenProviderError(
        'GROWW_API_KEY and GROWW_API_SECRET are both required to generate a Groww access token via the approval flow; at least one is missing.',
        undefined,
        undefined
      );
    }

    // Groww's approval endpoint requires epoch SECONDS, not milliseconds
    // (confirmed live -- HTTP 400 "timestamp must be in epoch seconds
    // format" was returned with a millisecond value during this task's
    // controlled live proof; see the B-F4 final report).
    const timestamp = String(Math.floor(Date.now() / 1000));
    const checksum = createHash('sha256').update(`${this.apiSecret}${timestamp}`).digest('hex');

    try {
      const response = await this.axios.post(
        '/v1/token/api/access',
        { key_type: 'approval', checksum, timestamp },
        { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' } }
      );
      const token = this.extractToken(response.data);
      this.cachedToken = token;
      return token;
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** Forces the next `getAccessToken()` call to regenerate a token -- call after a downstream 401/403 that indicates this token has expired/been revoked. Never auto-invoked internally (task section 10: "do not silently generate unlimited new sessions"). */
  invalidate(): void {
    this.cachedToken = null;
  }

  private extractToken(data: unknown): string {
    if (data && typeof data === 'object') {
      const token = (data as Record<string, unknown>).token;
      if (typeof token === 'string' && token.trim().length > 0) return token.trim();
    }
    throw new GrowwAccessTokenProviderError(
      "Groww access-token approval response did not contain a non-empty string 'token' field -- refusing to guess an alternative shape.",
      undefined,
      undefined
    );
  }

  /** Only ever reads `error.message`/`error.response.status` -- never `error.config` (where the Authorization header/API key lives), matching `GrowwHistoricalClient.classifyAndRethrow`. */
  private classify(error: unknown): GrowwAccessTokenProviderError {
    if (error instanceof GrowwAccessTokenProviderError) return error;
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      return new GrowwAccessTokenProviderError(
        `Groww access-token approval request failed${status ? ` (HTTP ${status})` : ''}: ${status === 401 || status === 403 ? 'the API key/secret is invalid, expired, or not approved.' : 'a transport-level error occurred.'}`,
        status,
        error
      );
    }
    return new GrowwAccessTokenProviderError(
      `Groww access-token approval request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      error
    );
  }
}
