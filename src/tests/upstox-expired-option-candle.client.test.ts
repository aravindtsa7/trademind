import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosInstance } from 'axios';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';

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
  client: UpstoxExpiredOptionCandleClient;
  axios: AxiosMock;
} {
  const client = new UpstoxExpiredOptionCandleClient('test-access-token');
  const axios = new AxiosMock(responder);
  (client as unknown as { axios: AxiosInstance }).axios = axios as unknown as AxiosInstance;

  return { client, axios };
}

function success(candles: unknown): Promise<MockResponse> {
  return Promise.resolve({ data: { status: 'success', data: { candles } } });
}

const instrumentKey = 'NSE_FO|57344|21-07-2026';
const candle = ['2026-07-15T09:15:00+05:30', 120.5, 125.25, 118.75, 123.4, 1500, 2400];

test('retrieves expired option candles successfully', async () => {
  const { client, axios } = createClient(() => success([candle]));

  const candles = await client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15', '1minute');

  assert.equal(candles.length, 1);
  assert.match(axios.calls[0].url, /NSE_FO%7C57344%7C21-07-2026\/1minute\/2026-07-15\/2026-07-15/);
});

test('maps OHLC fields correctly', async () => {
  const { client } = createClient(() => success([candle]));

  const [result] = await client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15');

  assert.deepEqual(
    { open: result.open, high: result.high, low: result.low, close: result.close },
    { open: 120.5, high: 125.25, low: 118.75, close: 123.4 }
  );
});

test('maps volume and open interest as bigint values', async () => {
  const { client } = createClient(() => success([candle]));

  const [result] = await client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15');

  assert.equal(result.volume, 1500n);
  assert.equal(result.openInterest, 2400n);
});

test('maps candle timestamp and instrument key', async () => {
  const { client } = createClient(() => success([candle]));

  const [result] = await client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15');

  assert.equal(result.instrumentKey, instrumentKey);
  assert.equal(result.candleTime.toISOString(), '2026-07-15T03:45:00.000Z');
});

test('rejects empty candle responses', async () => {
  const { client } = createClient(() => success([]));

  await assert.rejects(
    () => client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15'),
    /did not contain candles/
  );
});

test('rejects malformed candle responses', async () => {
  const { client } = createClient(() => success([['not-a-date', 1, 2]]));

  await assert.rejects(
    () => client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15'),
    /candle row is invalid/
  );
});

test('propagates Upstox request failures', async () => {
  const upstreamError = new Error('Upstox request failed');
  const { client } = createClient(() => Promise.reject(upstreamError));

  await assert.rejects(
    () => client.fetchCandles(instrumentKey, '2026-07-15', '2026-07-15'),
    (error: unknown) => error === upstreamError
  );
});
