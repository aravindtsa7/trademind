import assert from 'node:assert/strict';
import test from 'node:test';
import GrowwUnderlyingHistoricalDataProviderService from './groww-underlying-historical-data-provider.service';
import GrowwHistoricalClient from './groww-historical-client';
import { GrowwValidatedCandleRow } from './groww-historical-candle.dto';
import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalUnderlyingCandleRangeRequest } from '../../interfaces/historical-data-provider.interface';
import { HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import CanonicalSessionProjectorService from '../../services/canonical-session-projector.service';
import { CanonicalExclusionReason, CanonicalSessionDeclaration } from '../../domain/canonical-session.types';
import { regularSessionWindow } from '../../domain/session-window-expected-minutes.util';
import { NIFTY_INDEX_INSTRUMENT_KEY } from '../../services/nifty-underlying-identity';

interface FakeClientCall { exchange: string; segment: string; growwSymbol: string; startTime: string; endTime: string; candleInterval: string; }

function fakeClient(rows: readonly GrowwValidatedCandleRow[]): { client: GrowwHistoricalClient; calls: FakeClientCall[] } {
  const calls: FakeClientCall[] = [];
  const client = {
    fetchUnderlyingCandles: async (params: FakeClientCall) => {
      calls.push(params);
      return rows;
    },
  } as unknown as GrowwHistoricalClient;
  return { client, calls };
}

const BASE_REQUEST: HistoricalUnderlyingCandleRangeRequest = { assetType: HistoricalAssetType.NIFTY_INDEX, instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, interval: '1minute', fromTradingDate: '2024-12-12', toTradingDate: '2024-12-12' };

test('providerId is GROWW', () => {
  const provider = new GrowwUnderlyingHistoricalDataProviderService(fakeClient([]).client);
  assert.equal(provider.providerId, HistoricalProviderId.GROWW);
});

test('forwards exchange=NSE, segment=CASH, groww_symbol=NSE-NIFTY, candleInterval=1minute, and the documented 09:15:00/15:30:00 session boundary strings', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exchange, 'NSE');
  assert.equal(calls[0].segment, 'CASH');
  assert.equal(calls[0].growwSymbol, 'NSE-NIFTY');
  assert.equal(calls[0].startTime, '2024-12-12 09:15:00');
  assert.equal(calls[0].endTime, '2024-12-12 15:30:00');
  assert.equal(calls[0].candleInterval, '1minute');
});

test('maps validated candle rows into HistoricalSourceCandleRow exactly, assigning sourceIndex by position, with no synthetic/inferred rows', async () => {
  const rows: GrowwValidatedCandleRow[] = [
    { candleTime: new Date('2024-12-12T03:45:00.000Z'), open: 24600, high: 24610, low: 24590, close: 24605, volume: 0n, openInterest: null },
    { candleTime: new Date('2024-12-12T04:12:00.000Z'), open: 24657.4, high: 24659.6, low: 24651.4, close: 24651.4, volume: 0n, openInterest: null },
  ];
  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  const result = await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(result.length, rows.length); // never adds or drops rows -- exactly what the client returned
  assert.equal(result[0].sourceIndex, 0);
  assert.equal(result[1].sourceIndex, 1);
  assert.equal(result[1].candleTime.toISOString(), '2024-12-12T04:12:00.000Z');
  assert.equal(result[1].open, 24657.4);
  assert.equal(result[1].high, 24659.6);
  assert.equal(result[1].low, 24651.4);
  assert.equal(result[1].close, 24651.4);
  assert.equal(result[1].volume, 0n);
  assert.equal(result[1].openInterest, null);
});

// ---- B-M11: NIFTY_INDEX null-volume normalization (this adapter is the ONE place this happens) ----

test('B-M11 (C): a null Groww volume is normalized to canonical 0n', async () => {
  const rows: GrowwValidatedCandleRow[] = [{ candleTime: new Date('2025-03-25T05:12:00.000Z'), open: 23715.15, high: 23737.75, low: 23712.45, close: 23736.3, volume: null, openInterest: null }];
  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  const result = await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(result.length, 1);
  assert.equal(result[0].volume, 0n);
  assert.equal(result[0].open, 23715.15);
  assert.equal(result[0].high, 23737.75);
  assert.equal(result[0].low, 23712.45);
  assert.equal(result[0].close, 23736.3);
  assert.equal(result[0].openInterest, null);
});

test('B-M11 (C): a numeric Groww volume is preserved exactly, never touched by the null-volume normalization', async () => {
  const rows: GrowwValidatedCandleRow[] = [{ candleTime: new Date('2024-12-12T04:12:00.000Z'), open: 24657.4, high: 24659.6, low: 24651.4, close: 24651.4, volume: 4321n, openInterest: null }];
  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  const result = await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(result[0].volume, 4321n);
});

test('B-M11 (C): a mixed session (some rows null volume, some numeric) normalizes only the null ones, in place, preserving order', async () => {
  const rows: GrowwValidatedCandleRow[] = [
    { candleTime: new Date('2025-03-25T04:00:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10n, openInterest: null },
    { candleTime: new Date('2025-03-25T05:12:00.000Z'), open: 2, high: 3, low: 1.5, close: 2.5, volume: null, openInterest: null },
    { candleTime: new Date('2025-03-25T06:00:00.000Z'), open: 3, high: 4, low: 2.5, close: 3.5, volume: 0n, openInterest: null },
  ];
  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  const result = await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(result.length, 3);
  assert.equal(result[0].volume, 10n);
  assert.equal(result[1].volume, 0n); // normalized from null
  assert.equal(result[2].volume, 0n); // was already numeric 0
});

test('rejects a NIFTY_OPTION request -- this adapter is underlying-index-only', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(
    provider.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, assetType: HistoricalAssetType.NIFTY_OPTION as unknown as HistoricalAssetType.NIFTY_INDEX })
  );
  assert.equal(calls.length, 0, 'must fail before any provider call');
});

test('rejects any instrumentKey other than the fixed canonical NSE_INDEX|Nifty 50', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(provider.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, instrumentKey: 'NSE-NIFTY' }));
  assert.equal(calls.length, 0);
});

test('rejects any interval other than 1minute', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(provider.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, interval: '5minute' }));
  assert.equal(calls.length, 0);
});

test('rejects a multi-date range request -- only a single trading date is a verified/supported contract', async () => {
  const { client, calls } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(provider.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, fromTradingDate: '2024-12-01', toTradingDate: '2024-12-12' }));
  assert.equal(calls.length, 0);
});

test('fails closed on a non-null openInterest for a NIFTY_INDEX candle -- outside the verified contract, never silently accepted', async () => {
  const rows: GrowwValidatedCandleRow[] = [{ candleTime: new Date('2024-12-12T03:45:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 0n, openInterest: 5n }];
  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(provider.fetchCompletedUnderlyingRange(BASE_REQUEST), /openInterest to be null/);
});

test('fetchExpiredOptionRange is intentionally unimplemented and fails loudly', async () => {
  const { client } = fakeClient([]);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  await assert.rejects(
    provider.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'NSE-NIFTY-06Jan22-17200-PE', interval: '1minute', fromTradingDate: '2024-12-12', toTradingDate: '2024-12-12' })
  );
});

test('getCapability reports underlying-only support, 1minute, and a single-day maximum span', () => {
  const provider = new GrowwUnderlyingHistoricalDataProviderService(fakeClient([]).client);
  const capability = provider.getCapability();
  assert.equal(capability.providerId, HistoricalProviderId.GROWW);
  assert.equal(capability.supportsOptionCandleAcquisition, false);
  assert.equal(capability.supportsOptionContractDiscovery, false);
  assert.deepEqual(capability.supportedIntervals, ['1minute']);
  assert.equal(capability.maximumRequestDateSpanDays, 1);
});

// ============================================================================
// B-M10 Part 3/7.C: 15:30 IST boundary handling. Groww's live-verified
// response for a certified [09:15,15:30) session includes an EXTRA row AT
// 15:30 (376 rows total, not 375) -- this adapter passes it through
// unfiltered (see its own doc), and the UNMODIFIED CanonicalSessionProjectorService
// is what excludes it. Proven here end-to-end: real projector, real adapter,
// only the HTTP transport (GrowwHistoricalClient) is faked.
// ============================================================================

function growwShapedRow(minuteOfDayIst: number): GrowwValidatedCandleRow {
  const dayStartUtcMs = new Date('2024-12-12T00:00:00+05:30').getTime();
  const candleTime = new Date(dayStartUtcMs + minuteOfDayIst * 60_000);
  return { candleTime, open: 100, high: 101, low: 99, close: 100.5, volume: 0n, openInterest: null };
}

test('B-M10 Part 3: a 376-row Groww response (09:15..15:30 inclusive boundary) projects to exactly 375 certified canonical minutes, excluding 15:30 and retaining 09:42', async () => {
  // 09:15 IST == minute 555; 15:30 IST == minute 930 -- 555..930 inclusive is 376 rows.
  const rows: GrowwValidatedCandleRow[] = [];
  for (let minute = 555; minute <= 930; minute += 1) rows.push(growwShapedRow(minute));
  assert.equal(rows.length, 376);

  const { client } = fakeClient(rows);
  const provider = new GrowwUnderlyingHistoricalDataProviderService(client);
  const sourceRows = await provider.fetchCompletedUnderlyingRange(BASE_REQUEST);
  assert.equal(sourceRows.length, 376, 'the adapter itself must NOT drop the boundary row -- that is the projector\'s job');

  const projector = new CanonicalSessionProjectorService();
  const projection = projector.project({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    tradingDate: '2024-12-12',
    sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
    sessionWindows: [regularSessionWindow()],
    sourceRows,
  });

  assert.equal(projection.acceptedRows.length, 375, 'certified session [09:15,15:30) must yield exactly 375 canonical minutes');
  assert.equal(projection.excludedRows.length, 1);
  assert.equal(projection.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW);
  assert.equal(projection.excludedRows[0].candleTime.toISOString(), '2024-12-12T10:00:00.000Z'); // 15:30 IST == 10:00 UTC

  const acceptedTimestamps = new Set(projection.acceptedRows.map((row) => row.candleTime.toISOString()));
  assert.ok(!acceptedTimestamps.has('2024-12-12T10:00:00.000Z'), '15:30 IST boundary row must never become canonical');
  assert.ok(acceptedTimestamps.has('2024-12-12T04:12:00.000Z'), '09:42 IST must be retained (04:12 UTC)');
});
