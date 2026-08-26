import axios from 'axios';

/**
 * A historical provider request failed with a permanent error (401/403, or
 * any other 4xx that is not the rate-limit 429): retrying blindly cannot
 * fix an authorization or malformed-request failure, and a malformed
 * response the client itself rejected (a non-axios validation `Error`, e.g.
 * from `UpstoxHistoricalClient.validateResponse`) is treated the same way.
 * Fails closed after exactly one attempt.
 */
export class HistoricalProviderPermanentError extends Error {
  constructor(message: string, public readonly httpStatus: number | undefined, public readonly cause: unknown) {
    super(message);
    this.name = 'HistoricalProviderPermanentError';
  }
}

/** All retry attempts were exhausted on a transient/rate-limited error without ever succeeding. */
export class HistoricalProviderRetryExhaustedError extends Error {
  constructor(message: string, public readonly attempts: number, public readonly cause: unknown) {
    super(message);
    this.name = 'HistoricalProviderRetryExhaustedError';
  }
}

/** Counters the caller supplies and this helper increments in place, so an orchestrator can fold them into its own run summary without parsing thrown errors. */
export interface HistoricalProviderRetryStats {
  retryCount: number;
  rateLimitBackoffCount: number;
}

export interface HistoricalProviderRetryOptions {
  /** Total attempts including the first, before giving up. Default 5. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Returns a value in [0, 1). Injectable so backoff delay is deterministic in tests. Default `Math.random`. */
  readonly randomJitter?: () => number;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type ErrorClassification =
  | { readonly kind: 'PERMANENT'; readonly httpStatus?: number }
  | { readonly kind: 'RATE_LIMITED'; readonly httpStatus: number; readonly retryAfterMs: number | null }
  | { readonly kind: 'TRANSIENT'; readonly httpStatus?: number };

function parseRetryAfterHeader(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/**
 * Classifies a thrown error into permanent/rate-limited/transient, per the
 * B-F2 retry contract: 429 obeys `Retry-After` when present; 5xx and
 * network-level failures (no response at all, e.g. timeout/connection
 * reset) are bounded-retry transient; 401/403 and any other 4xx are
 * permanent; a non-axios error (a validation error the client itself
 * raised on a malformed response body) is also treated as permanent --
 * blindly retrying cannot repair a response the client already determined
 * was malformed.
 */
function classify(error: unknown): ErrorClassification {
  if (!axios.isAxiosError(error)) {
    return { kind: 'PERMANENT' };
  }
  const status = error.response?.status;
  if (status === 429) {
    return { kind: 'RATE_LIMITED', httpStatus: status, retryAfterMs: parseRetryAfterHeader(error.response?.headers?.['retry-after']) };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'TRANSIENT', httpStatus: status };
  }
  if (status !== undefined && status >= 400) {
    return { kind: 'PERMANENT', httpStatus: status };
  }
  // No `status` at all means no response was ever received (timeout, DNS,
  // connection reset, ...) -- a transient network-level failure.
  return { kind: 'TRANSIENT' };
}

function boundedBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: () => number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + jitter() * 0.5)); // 50%-100% of the exponential ceiling
}

/**
 * Retries `task` under the B-F2 historical-provider retry contract. Never
 * bound to one specific HTTP call -- any provider fetch can be wrapped in
 * this -- but deliberately scoped to this one contract (429/Retry-After,
 * bounded 5xx/network retry, fail-closed permanent 4xx) rather than a
 * general-purpose retry framework, since no reusable generic retry
 * primitive exists elsewhere in this repository to reuse instead (every
 * other retry loop in the codebase is a fixed 3-attempt inline loop private
 * to its own HTTP client).
 *
 * Never exposes request headers/tokens: only `error.message` and
 * `error.response.status` are ever read from the underlying error, never
 * `error.config` (which is where an Authorization header would live on an
 * axios error).
 */
export async function withHistoricalProviderRetry<T>(
  task: () => Promise<T>,
  stats: HistoricalProviderRetryStats,
  options: HistoricalProviderRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.randomJitter ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const classification = classify(error);

      if (classification.kind === 'PERMANENT') {
        throw new HistoricalProviderPermanentError(
          `Historical provider request failed with a permanent error${classification.httpStatus ? ` (HTTP ${classification.httpStatus})` : ''}; not retrying.`,
          classification.httpStatus,
          error
        );
      }

      if (attempt >= maxAttempts) break;

      const delayMs =
        classification.kind === 'RATE_LIMITED'
          ? classification.retryAfterMs ?? boundedBackoffMs(attempt, baseDelayMs, maxDelayMs, jitter)
          : boundedBackoffMs(attempt, baseDelayMs, maxDelayMs, jitter);

      if (classification.kind === 'RATE_LIMITED') stats.rateLimitBackoffCount += 1;
      stats.retryCount += 1;
      await sleep(delayMs);
    }
  }

  throw new HistoricalProviderRetryExhaustedError(
    `Historical provider request failed after ${maxAttempts} attempts.`,
    maxAttempts,
    lastError
  );
}
