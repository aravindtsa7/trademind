import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';

interface MockResponse {
  data: unknown;
}

class AxiosMock {
  readonly calls: Array<{ url: string; config: unknown }> = [];

  constructor(private readonly responder: (url: string) => Promise<MockResponse>) {}

  async get(url: string, config: unknown): Promise<MockResponse> {
    this.calls.push({ url, config });

    return this.responder(url);
  }
}

function createClient(responder: (url: string) => Promise<MockResponse>): {
  client: UpstoxExpiredOptionClient;
  axios: AxiosMock;
} {
  const client = new UpstoxExpiredOptionClient('test-access-token');
  const axios = new AxiosMock(responder);
  (client as unknown as { axios: AxiosInstance }).axios = axios as unknown as AxiosInstance;

  return { client, axios };
}

function success(data: unknown): Promise<MockResponse> {
  return Promise.resolve({ data: { status: 'success', data } });
}

function createApiContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument_key: 'NSE_FO|47983|17-04-2025',
    trading_symbol: 'NIFTY 20400 PE 17 APR 25',
    underlying_symbol: 'NIFTY',
    strike_price: 20400,
    expiry: '2025-04-17',
    instrument_type: 'PE',
    exchange: 'NSE',
    segment: 'NSE_FO',
    ...overrides,
  };
}

test('retrieves available expired expiries', async () => {
  const { client, axios } = createClient(() => success(['2025-04-10', '2025-04-17']));

  const expiries = await client.fetchAvailableExpiries('NSE_INDEX|Nifty 50');

  assert.deepEqual(expiries, ['2025-04-10', '2025-04-17']);
  assert.match(axios.calls[0].url, /instrument_key=NSE_INDEX%7CNifty\+50/);
  assert.deepEqual(axios.calls[0].config, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-access-token',
    },
  });
});

test('retrieves and maps expired option contracts', async () => {
  const { client, axios } = createClient(() => success([createApiContract({ lot_size: 65 })]));

  const contracts = await client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17');

  assert.equal(contracts.length, 1);
  assert.match(axios.calls[0].url, /expiry_date=2025-04-17/);
  assert.deepEqual(contracts[0], {
    instrumentKey: 'NSE_FO|47983|17-04-2025',
    tradingSymbol: 'NIFTY 20400 PE 17 APR 25',
    underlying: 'NIFTY',
    strikePrice: 20400,
    expiry: new Date('2025-04-17T00:00:00+05:30'),
    optionType: 'PE',
    exchange: 'NSE',
    segment: 'NSE_FO',
    lotSize: 65,
  });
});

test('does not map zero or negative lot sizes', async () => {
  const { client } = createClient(() =>
    success([createApiContract({ lot_size: 0 }), createApiContract({ lot_size: -1 })])
  );

  const contracts = await client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17');

  assert.equal(contracts[0].lotSize, undefined);
  assert.equal(contracts[1].lotSize, undefined);
});

test('does not map malformed or non-numeric lot sizes', async () => {
  const { client } = createClient(() =>
    success([createApiContract({ lot_size: '65' }), createApiContract({ lot_size: Number.NaN })])
  );

  const contracts = await client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17');

  assert.equal(contracts[0].lotSize, undefined);
  assert.equal(contracts[1].lotSize, undefined);
});

test('maps CE and PE option types', async () => {
  const { client } = createClient(() =>
    success([createApiContract({ instrument_type: 'CE' }), createApiContract({ instrument_type: 'PE' })])
  );

  const contracts = await client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17');

  assert.deepEqual(
    contracts.map((contract) => contract.optionType),
    ['CE', 'PE']
  );
});

test('maps strike price and expiry date', async () => {
  const { client } = createClient(() =>
    success([createApiContract({ strike_price: 20550, expiry: '2025-04-24' })])
  );

  const [contract] = await client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-24');

  assert.equal(contract.strikePrice, 20550);
  assert.equal(contract.expiry.toISOString(), '2025-04-23T18:30:00.000Z');
});

test('rejects malformed Upstox responses', async () => {
  const { client } = createClient(() => Promise.resolve({ data: { status: 'success', data: [{}] } }));

  await assert.rejects(
    () => client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17'),
    /did not contain valid option contracts/
  );
});

test('rejects empty Upstox responses', async () => {
  const { client } = createClient(() => success([]));

  await assert.rejects(
    () => client.fetchAvailableExpiries('NSE_INDEX|Nifty 50'),
    /did not contain valid expiry dates/
  );
});

test('propagates Upstox request failures', async () => {
  const upstreamError = new Error('Upstox request failed');
  const { client } = createClient(() => Promise.reject(upstreamError));

  await assert.rejects(
    () => client.fetchExpiredOptionContracts('NSE_INDEX|Nifty 50', '2025-04-17'),
    (error: unknown) => error === upstreamError
  );
});
