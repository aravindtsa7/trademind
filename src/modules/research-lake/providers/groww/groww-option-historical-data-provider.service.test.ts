import assert from 'node:assert/strict';
import test from 'node:test';
import GrowwOptionHistoricalDataProviderService from './groww-option-historical-data-provider.service';
import GrowwHistoricalClient from './groww-historical-client';
import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { GrowwValidatedCandleRow } from './groww-historical-candle.dto';

interface FakeClientCall { exchange: string; segment: string; growwSymbol: string; startTime: string; endTime: string; candleInterval: string; }

function fakeClient(rows: readonly GrowwValidatedCandleRow[]): { client: GrowwHistoricalClient; calls: FakeClientCall[] } {
  const calls: FakeClientCall[] = [];
  const client = {
    fetchOptionCandles: async (params: FakeClientCall) => {
      calls.push(params);
      return rows;
    },
  } as unknown as GrowwHistoricalClient;
  return { client, calls };
}

test('fetchExpiredOptionRange forwards a session-scoped request using the documented 09:15:00/15:30:00 boundary strings', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  await provider.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'NSE-NIFTY-06Jan22-17200-PE', interval: '1minute', fromTradingDate: '2022-01-03', toTradingDate: '2022-01-03' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exchange, 'NSE');
  assert.equal(calls[0].segment, 'FNO');
  assert.equal(calls[0].growwSymbol, 'NSE-NIFTY-06Jan22-17200-PE');
  assert.equal(calls[0].startTime, '2022-01-03 09:15:00');
  assert.equal(calls[0].endTime, '2022-01-03 15:30:00');
  assert.equal(calls[0].candleInterval, '1minute');
});

test('maps validated candle rows into HistoricalSourceCandleRow, preserving order and OI exactly, assigning sourceIndex by position', async () => {
  const rows: GrowwValidatedCandleRow[] = [
    { candleTime: new Date('2022-01-03T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10n, openInterest: null },
    { candleTime: new Date('2022-01-03T03:46:00.000Z'), open: 1.5, high: 2, low: 1, close: 1.8, volume: 20n, openInterest: 500n },
  ];
  const { client } = fakeClient(rows);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  const result = await provider.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'X', interval: '1minute', fromTradingDate: '2022-01-03', toTradingDate: '2022-01-03' });
  assert.equal(result.length, 2);
  assert.equal(result[0].sourceIndex, 0);
  assert.equal(result[1].sourceIndex, 1);
  assert.equal(result[0].openInterest, null);
  assert.equal(result[1].openInterest, 500n);
  assert.equal(result[0].candleTime.getTime(), rows[0].candleTime.getTime());
});

test('rejects a NIFTY_INDEX request -- this adapter is option-candle-only', async () => {
  const { client } = fakeClient([]);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  await assert.rejects(
    provider.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_INDEX as unknown as HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'X', interval: '1minute', fromTradingDate: '2022-01-03', toTradingDate: '2022-01-03' })
  );
});

test('fetchCompletedUnderlyingRange is intentionally unimplemented and fails loudly', async () => {
  const { client } = fakeClient([]);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  await assert.rejects(
    provider.fetchCompletedUnderlyingRange({ assetType: HistoricalAssetType.NIFTY_INDEX, instrumentKey: 'NSE_INDEX|Nifty 50', interval: '1minute', fromTradingDate: '2022-01-03', toTradingDate: '2022-01-03' })
  );
});

test('a request spanning more than the documented 30-day maximum is rejected before ever calling the client', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  await assert.rejects(
    provider.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'X', interval: '1minute', fromTradingDate: '2022-01-01', toTradingDate: '2022-02-15' })
  );
  assert.equal(calls.length, 0);
});

test('getCapability reports option-candle-acquisition support and the documented 30-day max span', () => {
  const provider = new GrowwOptionHistoricalDataProviderService(fakeClient([]).client);
  const capability = provider.getCapability();
  assert.equal(capability.supportsOptionCandleAcquisition, true);
  assert.equal(capability.supportsOptionContractDiscovery, false);
  assert.equal(capability.maximumRequestDateSpanDays, 30);
  assert.deepEqual(capability.supportedIntervals, ['1minute']);
});
