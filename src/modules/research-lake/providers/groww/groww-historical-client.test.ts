import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import GrowwHistoricalClient, { GrowwAuthenticationError, GrowwApiFailureError, GrowwSchemaValidationError } from './groww-historical-client';

const SECRET_TOKEN = 'super-secret-groww-bearer-token-value';

interface MockResponse {
  data: unknown;
}

class AxiosMock {
  readonly calls: Array<{ url: string; config: { params?: Record<string, unknown>; headers?: Record<string, string> } }> = [];
  constructor(private readonly responder: (url: string, config: { params?: Record<string, unknown> }) => Promise<MockResponse>) {}

  async get(url: string, config: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<MockResponse> {
    this.calls.push({ url, config });
    return this.responder(url, config);
  }
}

function createClient(
  responder: (url: string, config: { params?: Record<string, unknown> }) => Promise<MockResponse>,
  token = SECRET_TOKEN
): { client: GrowwHistoricalClient; axios: AxiosMock } {
  const client = new GrowwHistoricalClient(token);
  const axios = new AxiosMock(responder);
  (client as unknown as { axios: AxiosInstance }).axios = axios as unknown as AxiosInstance;
  return { client, axios };
}

function success(payload: unknown): Promise<MockResponse> {
  return Promise.resolve({ data: { status: 'SUCCESS', payload } });
}

/** Live-proven envelope: `GET /v1/historical/expiries` -> `{ status: "SUCCESS", payload: { expiries: string[] } }`. */
function successExpiries(expiries: unknown): Promise<MockResponse> {
  return success({ expiries });
}

/** Live-proven envelope: `GET /v1/historical/contracts` -> `{ status: "SUCCESS", payload: { contracts: string[] } }`. */
function successContracts(contracts: unknown): Promise<MockResponse> {
  return success({ contracts });
}

function axiosFailure(status: number, data: unknown): Promise<never> {
  const error = Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data, headers: {} },
    config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
  });
  return Promise.reject(error);
}

test('fetchExpiries calls the correct endpoint/query and sends the Bearer token from config plus X-API-VERSION 1.0', async () => {
  const { client, axios } = createClient(() => successExpiries(['2022-01-06', '2022-01-13']));

  const expiries = await client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 });

  assert.deepEqual(expiries, ['2022-01-06', '2022-01-13']);
  assert.equal(axios.calls.length, 1);
  assert.equal(axios.calls[0].url, '/v1/historical/expiries');
  assert.deepEqual(axios.calls[0].config.params, { exchange: 'NSE', underlying_symbol: 'NIFTY', year: 2022 });
  assert.equal(axios.calls[0].config.headers?.Authorization, `Bearer ${SECRET_TOKEN}`);
  assert.equal(axios.calls[0].config.headers?.['X-API-VERSION'], '1.0');
});

test('fetchExpiries includes month only when supplied', async () => {
  const { client, axios } = createClient(() => successExpiries([]));
  await client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022, month: 1 });
  assert.deepEqual(axios.calls[0].config.params, { exchange: 'NSE', underlying_symbol: 'NIFTY', year: 2022, month: 1 });
});

test('LIVE-PROVEN: matches the real Jan-2022 NIFTY expiries envelope (count=4, includes 2022-01-06)', async () => {
  const { client } = createClient(() =>
    successExpiries(['2022-01-06', '2022-01-13', '2022-01-20', '2022-01-27'])
  );
  const expiries = await client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022, month: 1 });
  assert.equal(expiries.length, 4);
  assert.ok(expiries.includes('2022-01-06'));
});

test('a payload that is itself the expiries array (old speculative shape) is rejected, not silently accepted', async () => {
  const { client } = createClient(() => success(['2022-01-06', '2022-01-13']));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
});

test('an object-shaped expiries entry (old speculative shape) is rejected, not silently accepted', async () => {
  const { client } = createClient(() => successExpiries([{ expiry_date: '2022-01-06' }]));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
});

test('fetchContracts calls the correct endpoint/query with expiry_date', async () => {
  const { client, axios } = createClient(() => successContracts(['NSE-NIFTY-06Jan22-17500-CE']));
  const contracts = await client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' });

  assert.deepEqual(contracts, ['NSE-NIFTY-06Jan22-17500-CE']);
  assert.deepEqual(axios.calls[0].config.params, { exchange: 'NSE', underlying_symbol: 'NIFTY', expiry_date: '2022-01-06' });
});

test('LIVE-PROVEN: matches the real 2022-01-06 NIFTY contracts envelope (bare string[], includes documented samples)', async () => {
  const liveSamples = ['NSE-NIFTY-06Jan22-17200-PE', 'NSE-NIFTY-06Jan22-17700-CE', 'NSE-NIFTY-06Jan22-18250-CE'];
  const { client } = createClient(() => successContracts(liveSamples));
  const contracts = await client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' });
  assert.deepEqual(contracts, liveSamples);
});

test('an object-shaped contract entry with speculative metadata hints is rejected, not silently accepted or partially extracted', async () => {
  const { client } = createClient(() =>
    successContracts([{ symbol: 'NSE-NIFTY-06Jan22-17500-CE', trading_symbol: 'NIFTY22J0617500CE', lot_size: 50, tick_size: 0.05 }])
  );
  await assert.rejects(client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' }), GrowwSchemaValidationError);
});

test('a payload that is itself the contracts array (old speculative shape) is rejected, not silently accepted', async () => {
  const { client } = createClient(() => success(['NSE-NIFTY-06Jan22-17500-CE']));
  await assert.rejects(client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' }), GrowwSchemaValidationError);
});

test('an empty-array payload ([]) at the outer payload position is rejected (payload must be a nested object, never an array)', async () => {
  const { client } = createClient(() => success([]));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
  const { client: contractsClient } = createClient(() => success([]));
  await assert.rejects(contractsClient.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' }), GrowwSchemaValidationError);
});

test('a non-string element in payload.expiries is rejected', async () => {
  const { client } = createClient(() => successExpiries(['2022-01-06', 42]));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
});

test('an object element in payload.contracts is rejected', async () => {
  const { client } = createClient(() => successContracts(['NSE-NIFTY-06Jan22-17500-CE', { symbol: 'NSE-NIFTY-06Jan22-17600-CE' }]));
  await assert.rejects(client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' }), GrowwSchemaValidationError);
});

test('a wrong/missing nested key is rejected: payload.expiry_dates instead of payload.expiries', async () => {
  const { client } = createClient(() => success({ expiry_dates: ['2022-01-06'] }));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
});

test('a wrong/missing nested key is rejected: payload.contract_symbols instead of payload.contracts', async () => {
  const { client } = createClient(() => success({ contract_symbols: ['NSE-NIFTY-06Jan22-17500-CE'] }));
  await assert.rejects(client.fetchContracts({ exchange: 'NSE', underlyingSymbol: 'NIFTY', expiryDate: '2022-01-06' }), GrowwSchemaValidationError);
});

test('a 401 response is converted to a typed GrowwAuthenticationError, permanent for retry purposes', async () => {
  const { client } = createClient(() => axiosFailure(401, { status: 'FAILURE', error: { code: '401', message: 'unauthorized' } }));
  await assert.rejects(
    client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }),
    (error: unknown) => {
      assert.ok(error instanceof GrowwAuthenticationError);
      assert.equal(error.httpStatus, 401);
      assert.match(error.message, /invalid|expired/i);
      return true;
    }
  );
});

test('a 403 response is converted to a typed GrowwAuthenticationError describing an authorization/entitlement problem, distinct from 401', async () => {
  const { client } = createClient(() => axiosFailure(403, { status: 'FAILURE', error: { code: '403', message: 'Access forbidden for this request.' } }));
  await assert.rejects(
    client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }),
    (error: unknown) => {
      assert.ok(error instanceof GrowwAuthenticationError);
      assert.equal(error.httpStatus, 403);
      assert.match(error.message, /not authorized|entitlement|plan/i);
      assert.doesNotMatch(error.message, /scope/i);
      return true;
    }
  );
});

test('a 503 response is rethrown as the raw axios error (unmodified), so the shared retry classifier still governs it', async () => {
  const { client } = createClient(() => axiosFailure(503, { status: 'FAILURE', error: { code: '503', message: 'unavailable' } }));
  await assert.rejects(
    client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }),
    (error: unknown) => {
      assert.equal((error as { isAxiosError?: boolean }).isAxiosError, true);
      assert.equal((error as { response?: { status?: number } }).response?.status, 503);
      return true;
    }
  );
});

test('a well-formed FAILURE envelope on an HTTP 200 raises a typed GrowwApiFailureError', async () => {
  const { client } = createClient(() => Promise.resolve({ data: { status: 'FAILURE', error: { code: 'BAD_REQUEST', message: 'invalid year' } } }));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwApiFailureError);
});

test('a status other than SUCCESS/FAILURE raises a typed GrowwSchemaValidationError', async () => {
  const { client } = createClient(() => Promise.resolve({ data: { status: 'PENDING', payload: { expiries: [] } } }));
  await assert.rejects(client.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 }), GrowwSchemaValidationError);
});

test('constructing the client without a token throws immediately', () => {
  assert.throws(() => new GrowwHistoricalClient(''));
  assert.throws(() => new GrowwHistoricalClient('   '));
});

// ---- B-F4: fetchOptionCandles ---------------------------------------------

/** Official documented envelope (task B-F4 section 1): `payload.candles` is a 7-element-array array. */
function successCandles(candles: unknown): Promise<MockResponse> {
  return success({ candles, closing_price: 0, start_time: '2022-01-03 09:15:00', end_time: '2022-01-03 15:30:00', interval_in_minutes: 1 });
}

test('fetchOptionCandles calls the correct endpoint/query with groww_symbol/start_time/end_time/candle_interval', async () => {
  const { client, axios } = createClient(() => successCandles([]));
  await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'NSE-NIFTY-06Jan22-17200-PE', startTime: '2022-01-03 09:15:00', endTime: '2022-01-03 15:30:00', candleInterval: '1minute' });
  assert.equal(axios.calls[0].url, '/v1/historical/candles');
  assert.deepEqual(axios.calls[0].config.params, {
    exchange: 'NSE',
    segment: 'FNO',
    groww_symbol: 'NSE-NIFTY-06Jan22-17200-PE',
    start_time: '2022-01-03 09:15:00',
    end_time: '2022-01-03 15:30:00',
    candle_interval: '1minute',
  });
});

test('(A) exact Groww candle SUCCESS envelope: 7-element row maps OHLCV/OI/timestamp exactly', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100.5, 101, 100, 100.75, 1200, 5000]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'NSE-NIFTY-06Jan22-17200-PE', startTime: '2022-01-03 09:15:00', endTime: '2022-01-03 15:30:00', candleInterval: '1minute' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open, 100.5);
  assert.equal(rows[0].high, 101);
  assert.equal(rows[0].low, 100);
  assert.equal(rows[0].close, 100.75);
  assert.equal(rows[0].volume, 1200n);
  assert.equal(rows[0].openInterest, 5000n);
});

test('(B) malformed envelope (payload.candles missing) is rejected', async () => {
  const { client } = createClient(() => success({ closing_price: 0 }));
  await assert.rejects(
    client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }),
    GrowwSchemaValidationError
  );
});

test('(C) malformed candle row (wrong element count) is rejected', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5]]));
  await assert.rejects(
    client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }),
    GrowwSchemaValidationError
  );
});

test('(D) timestamp is parsed explicitly as Asia/Kolkata, never host-local', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, null]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].candleTime.toISOString(), '2022-01-03T03:45:00.000Z'); // 09:15 IST == 03:45 UTC
});

test('(D) LIVE-CONFIRMED shape: a T-separated timestamp with no offset ("2022-01-03T09:15:00", the real response format) is also parsed explicitly as Asia/Kolkata', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03T09:15:00', 59.9, 62.95, 43.75, 46.4, 428903, 3640950]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'NSE-NIFTY-06Jan22-17200-PE', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].candleTime.toISOString(), '2022-01-03T03:45:00.000Z');
  assert.equal(rows[0].openInterest, 3640950n);
});

test('a syntactically-shaped but calendar-invalid timestamp is rejected, never silently rolled over', async () => {
  const { client } = createClient(() => successCandles([['2022-13-40 25:70:00', 100, 101, 100, 100.5, 10, null]]));
  await assert.rejects(
    client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }),
    GrowwSchemaValidationError
  );
});

test('(E)/(F) OHLC and volume are mapped exactly, with no unit/precision coercion', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:16:00', 12.34, 12.99, 12.01, 12.5, 987654, null]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].open, 12.34);
  assert.equal(rows[0].high, 12.99);
  assert.equal(rows[0].low, 12.01);
  assert.equal(rows[0].close, 12.5);
  assert.equal(rows[0].volume, 987654n);
});

test('a non-finite OHLC value (NaN/Infinity) is rejected, never coerced', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', Number.NaN, 101, 100, 100.5, 10, null]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);

  const { client: infClient } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, Number.POSITIVE_INFINITY, 100, 100.5, 10, null]]));
  await assert.rejects(infClient.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('negative volume is rejected, never coerced', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, -1, null]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('(G) numeric OI is preserved exactly as a bigint', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, 123456]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].openInterest, 123456n);
});

test('(H) OI of zero is valid and distinct from null', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, 0]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].openInterest, 0n);
  assert.notEqual(rows[0].openInterest, null);
});

test('(I) OI null on an exact 7-element row is accepted and preserved as null, never fabricated', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, null]]));
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].openInterest, null);
});

test('a 6-element row (7th/openInterest element entirely missing) is rejected, never coerced to null OI', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('an 8-element row (extra trailing element) is rejected', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, 5000, 'unexpected']]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('(J) negative OI is rejected, never coerced', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, -5]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('non-integer (fractional) OI is rejected, never truncated', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, 5.5]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('malformed/non-finite OI (NaN/Infinity) is rejected, never coerced', async () => {
  const { client } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, Number.NaN]]));
  await assert.rejects(client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);

  const { client: infClient } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, Number.POSITIVE_INFINITY]]));
  await assert.rejects(infClient.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }), GrowwSchemaValidationError);
});

test('candle rows are returned in exactly the order the provider sent them -- never sorted or reversed by the client', async () => {
  const { client } = createClient(() =>
    successCandles([
      ['2022-01-03 09:16:00', 100, 101, 100, 100.5, 10, null],
      ['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, null], // out of order on purpose
    ])
  );
  const rows = await client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.equal(rows[0].candleTime.toISOString() < rows[1].candleTime.toISOString(), false); // first row is still the later timestamp -- proves no reordering happened
});

test('(T) a 401 on the candle endpoint is a typed GrowwAuthenticationError with no token leakage', async () => {
  const { client } = createClient(() => axiosFailure(401, { status: 'FAILURE', error: { code: '401', message: 'unauthorized' } }));
  let message = '';
  await assert.rejects(
    client.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' }),
    (error: unknown) => {
      assert.ok(error instanceof GrowwAuthenticationError);
      assert.equal(error.httpStatus, 401);
      message = error.message;
      return true;
    }
  );
  assert.ok(!message.includes(SECRET_TOKEN));
});

test('SECURITY: the token never appears in a successful result or in any thrown error message/serialization', async () => {
  const { client: okClient } = createClient(() => successExpiries(['2022-01-06']));
  const expiries = await okClient.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 });
  assert.ok(!JSON.stringify(expiries).includes(SECRET_TOKEN));

  const { client: failClient } = createClient(() => axiosFailure(401, {}));
  let message = '';
  try {
    await failClient.fetchExpiries({ exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!message.includes(SECRET_TOKEN));
});

test('SECURITY: the token never appears in a successful candle result or in any thrown error message/serialization', async () => {
  const { client: okClient } = createClient(() => successCandles([['2022-01-03 09:15:00', 100, 101, 100, 100.5, 10, null]]));
  const rows = await okClient.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'NSE-NIFTY-06Jan22-17200-PE', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  assert.ok(!JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)).includes(SECRET_TOKEN));

  const { client: failClient } = createClient(() => axiosFailure(401, {}));
  let message = '';
  try {
    await failClient.fetchOptionCandles({ exchange: 'NSE', segment: 'FNO', growwSymbol: 'X', startTime: 'a', endTime: 'b', candleInterval: '1minute' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!message.includes(SECRET_TOKEN));
});
