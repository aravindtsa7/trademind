import axios, { AxiosInstance } from 'axios';
import logger from '../../../../core/logger/logger';
import { GrowwApiEnvelope } from './groww-historical-api.dto';
import { GrowwCandlePayload, GrowwCandleRow, GrowwValidatedCandleRow, parseGrowwCandleTimestamp } from './groww-historical-candle.dto';

const growwApiBaseUrl = 'https://api.groww.in';
const growwApiVersion = '1.0';

/**
 * Groww's `GROWW_ACCESS_TOKEN` expires daily. A 401/403 must never be
 * retried into a long, silent hang -- it is a signal the token/account
 * needs human attention, not a transient condition. Thrown by this client
 * BEFORE the shared B-F2 retry wrapper ever sees the error, so
 * `withHistoricalProviderRetry`'s classifier (which treats any non-axios
 * error as permanent) fails closed after exactly one attempt. `httpStatus`
 * distinguishes two genuinely different causes, described only in truthful
 * generic terms (never a specific claimed cause this client cannot actually
 * verify from the HTTP response alone):
 *
 *   401 -- the token/credentials themselves are invalid or expired.
 *   403 -- the identity authenticated, but the current account/token is
 *          not authorized for the requested endpoint (e.g. the active
 *          Groww plan/API entitlement does not include it).
 *
 * Both are permanent for retry purposes.
 */
export class GrowwAuthenticationError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly cause: unknown) {
    super(message);
    this.name = 'GrowwAuthenticationError';
  }
}

/** Groww responded with a well-formed `{status:'FAILURE', error:{...}}` envelope for a non-auth reason (validated request, real business-level failure). */
export class GrowwApiFailureError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'GrowwApiFailureError';
  }
}

/** Groww responded 200 but the payload did not match this client's documented/assumed schema (see groww-historical-api.dto.ts). Never silently coerced. */
export class GrowwSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowwSchemaValidationError';
  }
}

/**
 * Narrowly-scoped HTTP client for Groww's CURRENT Backtesting historical
 * APIs (`/v1/historical/expiries`, `/v1/historical/contracts`,
 * `/v1/historical/candles` -- task B-F4, extended by B-M10 to also cover
 * CASH/underlying-index candles on the SAME `/v1/historical/candles`
 * endpoint via `fetchUnderlyingCandles`) -- never the deprecated
 * `/v1/historical/candle/range`. Does not use the Groww SDK: a
 * small typed axios client is sufficient for these two read-only GET
 * endpoints and avoids an unnecessary dependency, matching the existing
 * repo convention (UpstoxHistoricalClient / UpstoxExpiredOptionClient are
 * both plain axios wrappers, not SDK-based).
 *
 * Never logs, serializes, or otherwise exposes the access token: only
 * `error.message` / `error.response.status` / `error.response.data` are
 * ever read from a caught error (never `error.config`, where the
 * Authorization header lives), mirroring the established pattern from
 * UpstoxHistoricalClient and the B-F2 retry utility.
 */
export default class GrowwHistoricalClient {
  private readonly axios: AxiosInstance;
  private readonly accessToken: string;

  constructor(accessToken: string = process.env.GROWW_ACCESS_TOKEN?.trim() ?? '') {
    this.accessToken = accessToken.trim();
    if (!this.accessToken) {
      throw new Error('A Groww access token (GROWW_ACCESS_TOKEN) is required for historical contract discovery.');
    }
    this.axios = axios.create({ baseURL: growwApiBaseUrl, timeout: 15_000 });
  }

  /**
   * Raw expiry-date strings exactly as Groww returned them, in whatever
   * order the API delivered -- NOT deduplicated, NOT format-validated,
   * NOT range-filtered. Those are deliberately orchestrator-level steps
   * (task section 9), so this client stays a thin, honest transport layer.
   */
  async fetchExpiries(params: { exchange: string; underlyingSymbol: string; year: number; month?: number }): Promise<readonly string[]> {
    const query: Record<string, string | number> = {
      exchange: params.exchange,
      underlying_symbol: params.underlyingSymbol,
      year: params.year,
    };
    if (params.month !== undefined) query.month = params.month;

    const startedAt = Date.now();
    try {
      logger.info('Requesting Groww historical expiries', { exchange: params.exchange, underlyingSymbol: params.underlyingSymbol, year: params.year, month: params.month });
      const response = await this.axios.get<GrowwApiEnvelope>('/v1/historical/expiries', {
        params: query,
        headers: this.headers(),
      });
      const payload = this.validateSuccessEnvelope(response.data, 'historical expiries');
      const expiries = this.extractExpiryStrings(payload);
      logger.info('Groww historical expiries received', { year: params.year, month: params.month, count: expiries.length, durationMs: Date.now() - startedAt });
      return expiries;
    } catch (error) {
      throw this.classifyAndRethrow(error, 'Groww historical expiries', { year: params.year, month: params.month, durationMs: Date.now() - startedAt });
    }
  }

  /** Raw discovered contract symbol strings exactly as Groww returned them -- NOT strictly symbol-parsed (see groww-contract-symbol-parser.ts). */
  async fetchContracts(params: { exchange: string; underlyingSymbol: string; expiryDate: string }): Promise<readonly string[]> {
    const startedAt = Date.now();
    try {
      logger.info('Requesting Groww historical contracts', { exchange: params.exchange, underlyingSymbol: params.underlyingSymbol, expiryDate: params.expiryDate });
      const response = await this.axios.get<GrowwApiEnvelope>('/v1/historical/contracts', {
        params: { exchange: params.exchange, underlying_symbol: params.underlyingSymbol, expiry_date: params.expiryDate },
        headers: this.headers(),
      });
      const payload = this.validateSuccessEnvelope(response.data, 'historical contracts');
      const contracts = this.extractContractSymbols(payload);
      logger.info('Groww historical contracts received', { expiryDate: params.expiryDate, count: contracts.length, durationMs: Date.now() - startedAt });
      return contracts;
    } catch (error) {
      throw this.classifyAndRethrow(error, 'Groww historical contracts', { expiryDate: params.expiryDate, durationMs: Date.now() - startedAt });
    }
  }

  /**
   * Fetches and strictly validates one page of 1-minute FNO candles for a
   * single Groww-native option/future symbol (task B-F4, section 1-2).
   * `startTime`/`endTime` must already be `YYYY-MM-DD HH:mm:ss` wall-clock
   * strings (never a `Date` -- callers own IST-vs-host-local formatting
   * before calling this method, matching every other plain-string
   * date/time convention already used in this module). Never chunks or
   * re-requests on the caller's behalf: a single call is a single HTTP
   * request, exactly like `fetchExpiries`/`fetchContracts`. Rows are
   * returned in EXACTLY the order Groww delivered them -- never sorted or
   * reversed here -- so `sourceIndex`/`CanonicalSourceOrderAnomaly`
   * evidence at the caller boundary can still detect a genuine
   * out-of-order delivery (task section 7).
   */
  async fetchOptionCandles(params: {
    exchange: string;
    segment: string;
    growwSymbol: string;
    startTime: string;
    endTime: string;
    candleInterval: string;
  }): Promise<readonly GrowwValidatedCandleRow[]> {
    return this.requestCandles(params, 'historical candles');
  }

  /**
   * B-M10: fetches and strictly validates one page of 1-minute CASH
   * (underlying/index) candles for a single Groww-native underlying symbol
   * (e.g. `NSE-NIFTY`) -- the same documented/live-verified
   * `/v1/historical/candles` endpoint `fetchOptionCandles` already uses,
   * distinguished only by `segment`/`groww_symbol`, never a different
   * endpoint. Shares this client's existing request/validation/error
   * pipeline via `requestCandles` rather than duplicating it (task section
   * "do not duplicate transport infrastructure unnecessarily"). Same
   * single-request-per-call, never-reordered contract as
   * `fetchOptionCandles` -- see that method's own doc for both.
   */
  async fetchUnderlyingCandles(params: {
    exchange: string;
    segment: string;
    growwSymbol: string;
    startTime: string;
    endTime: string;
    candleInterval: string;
  }): Promise<readonly GrowwValidatedCandleRow[]> {
    return this.requestCandles(params, 'historical underlying candles');
  }

  /**
   * Shared request/validate/error-classify pipeline for `/v1/historical/candles`,
   * used by both `fetchOptionCandles` and `fetchUnderlyingCandles`. `operation`
   * (e.g. `'historical candles'` / `'historical underlying candles'`) feeds the
   * SAME log/error-message conventions `fetchExpiries`/`fetchContracts` already
   * establish elsewhere in this file (`validateSuccessEnvelope`/`classifyAndRethrow`
   * both prepend their own `'Groww '` prefix) -- extracting this common body
   * changes no observable string `fetchOptionCandles` already produced.
   */
  private async requestCandles(
    params: { exchange: string; segment: string; growwSymbol: string; startTime: string; endTime: string; candleInterval: string },
    operation: string
  ): Promise<readonly GrowwValidatedCandleRow[]> {
    const startedAt = Date.now();
    const context = { exchange: params.exchange, segment: params.segment, growwSymbol: params.growwSymbol, startTime: params.startTime, endTime: params.endTime, candleInterval: params.candleInterval };
    try {
      logger.info(`Requesting Groww ${operation}`, context);
      const response = await this.axios.get<GrowwApiEnvelope>('/v1/historical/candles', {
        params: {
          exchange: params.exchange,
          segment: params.segment,
          groww_symbol: params.growwSymbol,
          start_time: params.startTime,
          end_time: params.endTime,
          candle_interval: params.candleInterval,
        },
        headers: this.headers(),
      });
      const payload = this.validateSuccessEnvelope(response.data, operation);
      const candles = this.extractCandleRows(payload, params.growwSymbol);
      logger.info(`Groww ${operation} received`, { ...context, count: candles.length, durationMs: Date.now() - startedAt });
      return candles;
    } catch (error) {
      throw this.classifyAndRethrow(error, `Groww ${operation}`, { ...context, durationMs: Date.now() - startedAt });
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'X-API-VERSION': growwApiVersion,
      Accept: 'application/json',
    };
  }

  /**
   * Classifies a caught error and rethrows either a typed
   * `GrowwAuthenticationError` (401/403 -- fails closed, never retried
   * blindly) or the ORIGINAL axios/other error unchanged, so the shared
   * B-F2 retry wrapper's own classifier still governs 429/5xx/network
   * behavior. Logs only status/response-body/duration -- never
   * `error.config` (headers/token).
   */
  private classifyAndRethrow(error: unknown, operation: string, context: Record<string, unknown>): unknown {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      logger.error(`Failed to fetch ${operation}`, { ...context, httpStatus: status, responseData: error.response?.data });
      if (status === 401) {
        return new GrowwAuthenticationError(
          `Groww authentication failed (HTTP 401) for ${operation} -- GROWW_ACCESS_TOKEN is likely invalid or expired (it expires daily); refresh it and retry.`,
          401,
          error
        );
      }
      if (status === 403) {
        return new GrowwAuthenticationError(
          `Groww authorization failed (HTTP 403) for ${operation} -- the current account/token is not authorized for this endpoint; verify the active Groww Trading API plan/API entitlement. This is not a transient failure and will not be resolved by retrying.`,
          403,
          error
        );
      }
      return error;
    }
    logger.error(`Failed to fetch ${operation}`, { ...context, error });
    return error;
  }

  /**
   * Validates only the outer envelope (`status`/`payload` presence and
   * FAILURE handling) and returns the raw `payload` value unexamined --
   * callers validate their own live-proven nested shape
   * (`payload.expiries` / `payload.contracts`) themselves, since the two
   * endpoints' payload shapes differ.
   */
  private validateSuccessEnvelope(data: unknown, operation: string): unknown {
    if (!data || typeof data !== 'object') {
      throw new GrowwSchemaValidationError(`Groww ${operation} response was not a JSON object.`);
    }
    const envelope = data as Partial<GrowwApiEnvelope>;
    if (envelope.status === 'FAILURE') {
      const failure = data as { error?: { code?: string; message?: string } };
      throw new GrowwApiFailureError(
        `Groww ${operation} request failed: ${failure.error?.message ?? 'unknown error'}`,
        failure.error?.code ?? 'UNKNOWN'
      );
    }
    if (envelope.status !== 'SUCCESS') {
      throw new GrowwSchemaValidationError(`Groww ${operation} response had unexpected status '${String(envelope.status)}' (expected 'SUCCESS').`);
    }
    if (!('payload' in envelope) || envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
      throw new GrowwSchemaValidationError(`Groww ${operation} response 'payload' must be a nested object, not an array or a missing/non-object value.`);
    }
    return (envelope as GrowwApiEnvelope & { payload: unknown }).payload;
  }

  /** Live-proven shape: `payload.expiries` is a string array -- `payload` itself is never the array. */
  private extractExpiryStrings(payload: unknown): string[] {
    const expiries = (payload as Record<string, unknown>).expiries;
    if (!Array.isArray(expiries)) {
      throw new GrowwSchemaValidationError("Groww historical expiries 'payload.expiries' was not an array.");
    }
    return expiries.map((entry, index) => {
      if (typeof entry === 'string') return entry;
      throw new GrowwSchemaValidationError(`Groww historical expiries payload.expiries[${index}] was not a string.`);
    });
  }

  /** Live-proven shape: `payload.contracts` is a bare-string array -- `payload` itself is never the array, and no object-shaped entry/metadata hint is modeled. */
  private extractContractSymbols(payload: unknown): string[] {
    const contracts = (payload as Record<string, unknown>).contracts;
    if (!Array.isArray(contracts)) {
      throw new GrowwSchemaValidationError("Groww historical contracts 'payload.contracts' was not an array.");
    }
    return contracts.map((entry, index) => {
      if (typeof entry === 'string' && entry.length > 0) return entry;
      throw new GrowwSchemaValidationError(`Groww historical contracts payload.contracts[${index}] was not a non-empty string.`);
    });
  }

  /**
   * Documented shape: `payload.candles` is an array of exactly-7-element
   * arrays (FNO always reports openInterest in the 7th position, explicit
   * `null` included) -- `payload` itself is never the array. Every row is
   * validated strictly and independently (task section 2); a single
   * malformed row fails the WHOLE response closed rather than silently
   * dropping or coercing just that row, since a provider that got one row
   * wrong cannot be trusted to have gotten the others right either.
   */
  private extractCandleRows(payload: unknown, growwSymbol: string): GrowwValidatedCandleRow[] {
    const candles = (payload as Partial<GrowwCandlePayload>).candles;
    if (!Array.isArray(candles)) {
      throw new GrowwSchemaValidationError("Groww historical candles 'payload.candles' was not an array.");
    }
    return candles.map((row, index) => this.parseCandleRow(row, index, growwSymbol));
  }

  private parseCandleRow(row: GrowwCandleRow, index: number, growwSymbol: string): GrowwValidatedCandleRow {
    const fail = (detail: string): never => {
      throw new GrowwSchemaValidationError(`Groww historical candles for '${growwSymbol}': payload.candles[${index}] ${detail}`);
    };
    if (!Array.isArray(row) || row.length !== 7) {
      return fail(`must be a 7-element array; received ${Array.isArray(row) ? `${row.length}-element array` : typeof row}.`);
    }

    const candleTime = parseGrowwCandleTimestamp(row[0]);
    if (!candleTime) return fail(`has an invalid/malformed timestamp (received ${JSON.stringify(row[0])}).`);

    const open = this.parseFiniteNumber(row[1], fail, 'open');
    const high = this.parseFiniteNumber(row[2], fail, 'high');
    const low = this.parseFiniteNumber(row[3], fail, 'low');
    const close = this.parseFiniteNumber(row[4], fail, 'close');
    const volume = this.parseNonNegativeIntegerBigInt(row[5], fail, 'volume', false);
    const openInterest = this.parseNonNegativeIntegerBigInt(row[6], fail, 'openInterest', true);

    return { candleTime, open, high, low, close, volume: volume as bigint, openInterest };
  }

  private parseFiniteNumber(raw: unknown, fail: (detail: string) => never, field: string): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return fail(`has a non-finite/non-numeric '${field}' value (received ${JSON.stringify(raw)}).`);
    }
    return raw;
  }

  /**
   * `volume` is never nullable (`allowNull=false`); `openInterest` may
   * legitimately be `null` or entirely absent -- both mean "provider did
   * not supply OI", collapsed to `null` (task section 9: never fabricated,
   * never treated as zero). `0` is always a valid, distinct value from
   * `null` for both fields. Rejects `NaN`/`Infinity`, negative values, and
   * non-integers (a fractional lot count/OI is malformed provider data,
   * never silently rounded/truncated).
   */
  private parseNonNegativeIntegerBigInt(raw: unknown, fail: (detail: string) => never, field: string, allowNull: boolean): bigint | null {
    if (raw === null || raw === undefined) {
      if (allowNull) return null;
      return fail(`has a missing/null '${field}' value, which is not permitted for '${field}'.`);
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      return fail(`has a non-finite/non-integer '${field}' value (received ${JSON.stringify(raw)}).`);
    }
    if (raw < 0) {
      return fail(`has a negative '${field}' value (${raw}), which is invalid.`);
    }
    return BigInt(raw);
  }
}
