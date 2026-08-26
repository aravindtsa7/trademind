import assert from 'node:assert/strict';
import test from 'node:test';
import UpstoxHistoricalDataProviderService, {
  UPSTOX_ONE_MINUTE_MAX_REQUEST_DATE_SPAN_DAYS,
  UPSTOX_UNDERLYING_HISTORY_START_DATE,
} from './upstox-historical-data-provider.service';
import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const SECRET_TOKEN = 'super-secret-upstox-bearer-token-value';

class UpstoxHistoricalClientMock {
  calls: Array<{ instrumentKey: string; toDate: string; fromDate: string }> = [];
  constructor(private readonly accessToken: string, private readonly candles: unknown[] = []) {}

  async fetchOneMinuteCandles(instrumentKey: string, toDate: string, fromDate: string) {
    this.calls.push({ instrumentKey, toDate, fromDate });
    return this.candles;
  }
}

function buildProvider(candles: unknown[]): { provider: UpstoxHistoricalDataProviderService; client: UpstoxHistoricalClientMock } {
  const client = new UpstoxHistoricalClientMock(SECRET_TOKEN, candles);
  const provider = new UpstoxHistoricalDataProviderService(client as never);
  return { provider, client };
}

test('capability reports UPSTOX, the documented underlying start date, and underlying-only support', () => {
  const { provider } = buildProvider([]);
  const capability = provider.getCapability();

  assert.equal(capability.providerId, HistoricalProviderId.UPSTOX);
  assert.equal(capability.earliestDocumentedUnderlyingHistory, UPSTOX_UNDERLYING_HISTORY_START_DATE);
  assert.equal(capability.earliestDocumentedUnderlyingHistory, '2022-01-01');
  assert.equal(capability.earliestDocumentedOptionDiscovery, null);
  assert.equal(capability.earliestDocumentedOptionCandleHistory, null);
  assert.equal(capability.supportsOptionContractDiscovery, false);
  assert.equal(capability.supportsOptionCandleAcquisition, false);
  assert.deepEqual(capability.supportedIntervals, ['1minute']);
  assert.equal(capability.maximumRequestDateSpanDays, UPSTOX_ONE_MINUTE_MAX_REQUEST_DATE_SPAN_DAYS);
});

test('fetchCompletedUnderlyingRange maps existing Upstox DTOs into provider-neutral HistoricalSourceCandleRow, preserving values', async () => {
  // Upstox's real v3 endpoint delivers newest-first (confirmed live -- see
  // the reversal regression test below), so the fixture matches that.
  const candleA = { candleTime: new Date('2022-01-03T09:16:00+05:30'), open: 100.5, high: 102, low: 100, close: 101, volume: 2_000n, openInterest: 50n };
  const candleB = { candleTime: new Date('2022-01-03T09:15:00+05:30'), open: 100, high: 101, low: 99, close: 100.5, volume: 1_000n, openInterest: undefined };
  const { provider } = buildProvider([candleA, candleB]);

  const rows = await provider.fetchCompletedUnderlyingRange({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    interval: '1minute',
    fromTradingDate: '2022-01-03',
    toTradingDate: '2022-01-03',
  });

  assert.equal(rows.length, 2);
  // rows[0] is now the EARLIEST minute (candleB, 09:15) -- ascending, normalized order -- see the dedicated ordering test.
  assert.equal(rows[0].candleTime.getTime(), candleB.candleTime.getTime());
  assert.equal(rows[0].open, 100);
  assert.equal(rows[0].volume, 1_000n);
  assert.equal(rows[0].openInterest, null); // undefined DTO field maps to explicit null, never left ambiguous
  assert.equal(rows[1].candleTime.getTime(), candleA.candleTime.getTime());
  assert.equal(rows[1].openInterest, 50n);
});

test('REGRESSION (confirmed via live B-F2 controlled probe): Upstox delivers rows newest-first, and this adapter normalizes them to ascending chronological order with sourceIndex 0 = earliest', async () => {
  const earliest = { candleTime: new Date('2022-01-03T09:15:00+05:30'), open: 100, high: 101, low: 99, close: 100.5, volume: 1_000n, openInterest: undefined };
  const middle = { candleTime: new Date('2022-01-03T09:16:00+05:30'), open: 100.5, high: 102, low: 100, close: 101, volume: 2_000n, openInterest: undefined };
  const latest = { candleTime: new Date('2022-01-03T09:17:00+05:30'), open: 101, high: 103, low: 100.5, close: 102, volume: 3_000n, openInterest: undefined };
  // Raw Upstox order: latest, middle, earliest (strictly descending).
  const { provider } = buildProvider([latest, middle, earliest]);

  const rows = await provider.fetchCompletedUnderlyingRange({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    interval: '1minute',
    fromTradingDate: '2022-01-03',
    toTradingDate: '2022-01-03',
  });

  assert.deepEqual(
    rows.map((row) => row.candleTime.toISOString()),
    [earliest.candleTime.toISOString(), middle.candleTime.toISOString(), latest.candleTime.toISOString()]
  );
  assert.deepEqual(rows.map((row) => row.sourceIndex), [0, 1, 2]);
  // A strictly-monotonic-in-one-direction raw response (Upstox's normal
  // behavior) must normalize to zero source-order anomalies once reversed;
  // this is what unblocked the earlier false-positive INVALID/NON_MONOTONIC_ORDER
  // result the live probe first surfaced.
});

test('fetchCompletedUnderlyingRange calls the underlying client with (instrumentKey, toDate, fromDate) in the existing established order', async () => {
  const { provider, client } = buildProvider([]);

  await provider.fetchCompletedUnderlyingRange({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    interval: '1minute',
    fromTradingDate: '2022-01-01',
    toTradingDate: '2022-01-31',
  });

  assert.deepEqual(client.calls, [{ instrumentKey: INSTRUMENT_KEY, toDate: '2022-01-31', fromDate: '2022-01-01' }]);
});

test('fetchExpiredOptionRange is intentionally unsupported and fails loudly rather than returning data', async () => {
  const { provider } = buildProvider([]);
  await assert.rejects(
    provider.fetchExpiredOptionRange({
      assetType: HistoricalAssetType.NIFTY_OPTION,
      instrumentKey: 'NSE_FO|12345',
      interval: '1minute',
      fromTradingDate: '2022-01-01',
      toTradingDate: '2022-01-01',
    }),
    /does not support option candle acquisition/
  );
});

test('SECURITY: the mock access token never appears in any capability or mapped-row output', async () => {
  const { provider } = buildProvider([]);
  const capability = provider.getCapability();
  const rows = await provider.fetchCompletedUnderlyingRange({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    interval: '1minute',
    fromTradingDate: '2022-01-01',
    toTradingDate: '2022-01-01',
  });

  const serialized = JSON.stringify({ capability, rows }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  assert.ok(!serialized.includes(SECRET_TOKEN));
});
