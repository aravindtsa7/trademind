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
