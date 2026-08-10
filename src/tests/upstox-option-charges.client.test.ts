import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import UpstoxOptionChargesClient from '../modules/options/client/upstox-option-charges.client';

interface MockResponse {
  data: unknown;
  status?: number;
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
  client: UpstoxOptionChargesClient;
  axios: AxiosMock;
} {
  const client = new UpstoxOptionChargesClient('test-access-token');
  const axios = new AxiosMock(responder);
  (client as unknown as { axios: AxiosInstance }).axios = axios as unknown as AxiosInstance;
  return { client, axios };
}

function success(charges: Record<string, unknown>): Promise<MockResponse> {
  return Promise.resolve({ data: { status: 'success', data: { charges } }, status: 200 });
}

function apiCharges(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 35.5,
    brokerage: 20,
    taxes: { gst: 3.6, stt: 7.5, stamp_duty: 1.2 },
    other_charges: { transaction: 2, clearing: 0.5, ipft: 0.2, sebi_turnover: 0.5 },
    ...overrides,
  };
}

function request(transactionType: 'BUY' | 'SELL' = 'BUY') {
  return {
    instrumentToken: 'NSE_FO|35271',
    quantity: 50,
    product: 'I',
    transactionType,
    price: 120.5,
  } as const;
}

test('retrieves and maps a successful option BUY charge response', async () => {
  const { client, axios } = createClient(() => success(apiCharges()));

  const charges = await client.fetchCharges(request('BUY'));

  assert.equal(charges.brokerage, 20);
  assert.match(axios.calls[0].url, /charges\/brokerage/);
  assert.match(axios.calls[0].url, /instrument_token=NSE_FO%7C35271/);
  assert.match(axios.calls[0].url, /transaction_type=BUY/);
});

test('supports a successful option SELL charge response', async () => {
  const { client, axios } = createClient(() => success(apiCharges()));

  await client.fetchCharges(request('SELL'));

  assert.match(axios.calls[0].url, /transaction_type=SELL/);
});

test('maps brokerage charges', async () => {
  const { client } = createClient(() => success(apiCharges()));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.brokerage, 20);
});

test('maps STT charges', async () => {
  const { client } = createClient(() => success(apiCharges()));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.stt, 7.5);
});

test('maps GST charges', async () => {
  const { client } = createClient(() => success(apiCharges()));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.gst, 3.6);
});

test('maps exchange, SEBI, and stamp-duty charges', async () => {
  const { client } = createClient(() => success(apiCharges()));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.exchangeTransactionCharges, 2);
  assert.equal(charges.sebiCharges, 0.5);
  assert.equal(charges.stampDuty, 1.2);
});

test('rolls additional Upstox other charges into otherCharges', async () => {
  const { client } = createClient(() => success(apiCharges({
    other_charges: { transaction: 2, clearing: 0.5, ipft: 0.2, other_exchange_charge: 0.3, sebi_turnover: 0.5 },
  })));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.otherCharges, 1);
});

test('returns the broker-reported total for reconciliation', async () => {
  const { client } = createClient(() => success(apiCharges({ total: 35.5 })));

  const charges = await client.fetchCharges(request());

  assert.equal(charges.reportedTotalCharges, 35.5);
});

test('rejects malformed Upstox charge responses', async () => {
  const { client } = createClient(() => success({ total: 1, brokerage: 1 }));

  await assert.rejects(() => client.fetchCharges(request()), /did not contain a valid charge breakdown/);
});

test('propagates Upstox API errors', async () => {
  const upstreamError = new Error('Upstox request failed');
  const { client } = createClient(() => Promise.reject(upstreamError));

  await assert.rejects(() => client.fetchCharges(request()), (error: unknown) => error === upstreamError);
});
