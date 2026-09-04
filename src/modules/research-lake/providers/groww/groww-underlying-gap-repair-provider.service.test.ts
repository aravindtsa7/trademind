import assert from 'node:assert/strict';
import test from 'node:test';
import GrowwUnderlyingGapRepairProviderService, {
  assertExpectedMissingMinuteWithinRegularSession,
  GrowwGapRepairExpectedMissingMinuteError,
  parseExpectedMissingMinuteUtc,
} from './groww-underlying-gap-repair-provider.service';
import GrowwUnderlyingHistoricalDataProviderService from './groww-underlying-historical-data-provider.service';
import GrowwHistoricalClient from './groww-historical-client';
import { GrowwValidatedCandleRow } from './groww-historical-candle.dto';
import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import { HistoricalUnderlyingCandleRangeRequest } from '../../interfaces/historical-data-provider.interface';
import { NIFTY_INDEX_INSTRUMENT_KEY } from '../../services/nifty-underlying-identity';

const TRADING_DATE = '2024-12-12';
const EXPECTED_MISSING_MINUTE_UTC_STRING = '2024-12-12T04:12:00.000Z'; // 09:42 IST -- the exact B-M10 locked authorized timestamp
const EXPECTED_MISSING_MINUTE_UTC = new Date(EXPECTED_MISSING_MINUTE_UTC_STRING);

const BASE_REQUEST: HistoricalUnderlyingCandleRangeRequest = {
  assetType: HistoricalAssetType.NIFTY_INDEX,
  instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
  interval: '1minute',
  fromTradingDate: TRADING_DATE,
  toTradingDate: TRADING_DATE,
};

function fakeGrowwClient(rows: readonly GrowwValidatedCandleRow[]): GrowwHistoricalClient {
  return { fetchUnderlyingCandles: async () => rows } as unknown as GrowwHistoricalClient;
}

function contentFor(index: number): { open: number; high: number; low: number; close: number; volume: bigint; openInterest: null } {
  return { open: 24600 + index, high: 24601 + index, low: 24599 + index, close: 24600.5 + index, volume: 0n, openInterest: null };
}

/** A live-shaped Groww CASH response: minute-of-day 555 (09:15) through 930 (15:30) inclusive -- 376 rows, matching the B-M10 live-verified boundary behavior. */
function fullDayRows(tradingDate: string): GrowwValidatedCandleRow[] {
  const dayStartUtcMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const rows: GrowwValidatedCandleRow[] = [];
  for (let minuteOfDay = 555; minuteOfDay <= 930; minuteOfDay += 1) {
    const dayIndex = minuteOfDay - 555; // 0..374 real session minutes, 375 == the 15:30 boundary row
    const candleTime = new Date(dayStartUtcMs + minuteOfDay * 60_000);
    rows.push({ candleTime, ...contentFor(dayIndex) });
  }
  return rows;
}

function newWrapper(rows: readonly GrowwValidatedCandleRow[], expectedMissingMinuteUtc: Date = EXPECTED_MISSING_MINUTE_UTC): GrowwUnderlyingGapRepairProviderService {
  const delegate = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient(rows));
  return new GrowwUnderlyingGapRepairProviderService(delegate, expectedMissingMinuteUtc);
}

// ---- Test 1: full 376-row Groww fixture -> exactly 1 candidate ------------

test('1: a full 376-row Groww session narrows to exactly the one authorized candidate; 15:30 and every other in-session row never escape', async () => {
  const wrapper = newWrapper(fullDayRows(TRADING_DATE));
  const result = await wrapper.fetchCompletedUnderlyingRange(BASE_REQUEST);

  assert.equal(result.length, 1, 'exactly one candidate, never the full 376/375-row session');
  assert.equal(result[0].candleTime.toISOString(), EXPECTED_MISSING_MINUTE_UTC_STRING);
  assert.equal(result[0].sourceIndex, 0);

  // Content is the untouched original Groww candle -- never modified.
  const expectedDayIndex = 27; // 09:42 IST == 09:15 + 27 minutes
  const expectedContent = contentFor(expectedDayIndex);
  assert.equal(result[0].open, expectedContent.open);
  assert.equal(result[0].high, expectedContent.high);
  assert.equal(result[0].low, expectedContent.low);
  assert.equal(result[0].close, expectedContent.close);
  assert.equal(result[0].volume, expectedContent.volume);
  assert.equal(result[0].openInterest, null);
});

// ---- B-M11 (D): a null-volume target candidate normalizes cleanly through the real underlying adapter ----

test('B-M11 (D): a null-volume target candidate (2025-03-25T05:12:00.000Z, 10:42 IST) normalizes to volume=0n/OI=null with OHLC preserved exactly; wrapper still exposes exactly one candidate', async () => {
  const TRADING_DATE_2025 = '2025-03-25';
  const TARGET_UTC_STRING = '2025-03-25T05:12:00.000Z'; // 10:42 IST -- the live-confirmed B-M11 null-volume timestamp
  const TARGET_UTC = new Date(TARGET_UTC_STRING);

  const baseRows = fullDayRows(TRADING_DATE_2025);
  const targetIndex = baseRows.findIndex((row) => row.candleTime.getTime() === TARGET_UTC.getTime());
  assert.ok(targetIndex >= 0, 'fixture must include the target minute');
  const expectedContent = contentFor(targetIndex); // the ORIGINAL OHLC before the volume field is nulled out below

  // Only the target row's volume is set to `null` (the live-confirmed Groww shape) -- every other
  // row, including the 15:30 boundary row, keeps its ordinary numeric-zero volume unchanged.
  const rowsWithNullVolumeAtTarget: GrowwValidatedCandleRow[] = baseRows.map((row, index) => (index === targetIndex ? { ...row, volume: null } : row));

  const wrapper = newWrapper(rowsWithNullVolumeAtTarget, TARGET_UTC);
  const result = await wrapper.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, fromTradingDate: TRADING_DATE_2025, toTradingDate: TRADING_DATE_2025 });

  assert.equal(result.length, 1, 'exactly one target candidate exposed, never the full session');
  assert.equal(result[0].candleTime.toISOString(), TARGET_UTC_STRING);
  assert.equal(result[0].sourceIndex, 0);
  assert.equal(result[0].open, expectedContent.open);
  assert.equal(result[0].high, expectedContent.high);
  assert.equal(result[0].low, expectedContent.low);
  assert.equal(result[0].close, expectedContent.close);
  assert.equal(result[0].volume, 0n, 'the real GrowwUnderlyingHistoricalDataProviderService normalized the null Groww volume to canonical 0n');
  assert.equal(result[0].openInterest, null);

  // The 15:30 IST boundary row (10:00 UTC) is present in the underlying fixture but was never the
  // authorized target -- it must never be the exposed candidate.
  assert.notEqual(result[0].candleTime.toISOString(), '2025-03-25T10:00:00.000Z');

  // The 15:30 boundary itself still cannot be authorized as a repair target at all -- the wrapper's
  // own pre-check rejects it before any provider call, exactly as it does for the 2024-12-12 topology
  // (see test 7 below), regardless of this session also containing a null-volume row elsewhere.
  const boundaryWrapper = newWrapper(rowsWithNullVolumeAtTarget, new Date('2025-03-25T10:00:00.000Z'));
  await assert.rejects(
    boundaryWrapper.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, fromTradingDate: TRADING_DATE_2025, toTradingDate: TRADING_DATE_2025 }),
    GrowwGapRepairExpectedMissingMinuteError
  );
});

test('providerId remains GROWW and getCapability delegates verbatim to the wrapped adapter', () => {
  const delegate = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient([]));
  const wrapper = new GrowwUnderlyingGapRepairProviderService(delegate, EXPECTED_MISSING_MINUTE_UTC);
  assert.equal(wrapper.providerId, HistoricalProviderId.GROWW);
  assert.deepEqual(wrapper.getCapability(), delegate.getCapability());
});

// ---- Test 2: candidate absent -> fail closed -------------------------------

test('2: zero matching candles at the authorized timestamp -> fail closed', async () => {
  const rowsWithoutTarget = fullDayRows(TRADING_DATE).filter((row) => row.candleTime.getTime() !== EXPECTED_MISSING_MINUTE_UTC.getTime());
  const wrapper = newWrapper(rowsWithoutTarget);
  await assert.rejects(wrapper.fetchCompletedUnderlyingRange(BASE_REQUEST), GrowwGapRepairExpectedMissingMinuteError);
});

// ---- Test 3: duplicate candidate -> fail closed ----------------------------

test('3: two candles at the exact authorized timestamp -> fail closed (duplicate)', async () => {
  const rows = [...fullDayRows(TRADING_DATE)];
  rows.push({ candleTime: new Date(EXPECTED_MISSING_MINUTE_UTC.getTime()), ...contentFor(27), open: 99999 });
  const wrapper = newWrapper(rows);
  await assert.rejects(wrapper.fetchCompletedUnderlyingRange(BASE_REQUEST), GrowwGapRepairExpectedMissingMinuteError);
});

// ---- Tests 5/6/7: validation rejects before any provider call -------------

test('5: parseExpectedMissingMinuteUtc rejects a non-minute-aligned timestamp before any provider/client construction', () => {
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12T04:12:30.000Z'), GrowwGapRepairExpectedMissingMinuteError);
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12T04:12:00.500Z'), GrowwGapRepairExpectedMissingMinuteError);
});

test('5: parseExpectedMissingMinuteUtc rejects a non-canonical/malformed string', () => {
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12 04:12:00'), GrowwGapRepairExpectedMissingMinuteError); // space separator, not the canonical T/Z form
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12T04:12:00+00:00'), GrowwGapRepairExpectedMissingMinuteError); // offset form, not canonical Z
  assert.throws(() => parseExpectedMissingMinuteUtc('not-a-timestamp'), GrowwGapRepairExpectedMissingMinuteError);
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-13-40T25:70:00.000Z'), GrowwGapRepairExpectedMissingMinuteError); // calendar-invalid, round-trip check catches it
});

test('5: parseExpectedMissingMinuteUtc accepts the exact live-verified B-M10 timestamp', () => {
  const parsed = parseExpectedMissingMinuteUtc(EXPECTED_MISSING_MINUTE_UTC_STRING);
  assert.equal(parsed.toISOString(), EXPECTED_MISSING_MINUTE_UTC_STRING);
});

test('6: assertExpectedMissingMinuteWithinRegularSession rejects a timestamp on the wrong trading date, before any provider call', () => {
  assert.throws(() => assertExpectedMissingMinuteWithinRegularSession(EXPECTED_MISSING_MINUTE_UTC, '2024-12-13'), GrowwGapRepairExpectedMissingMinuteError);
});

test('7: assertExpectedMissingMinuteWithinRegularSession rejects the 15:30 boundary timestamp itself -- it is outside the certified [09:15,15:30) window', () => {
  const boundaryTimestamp = new Date(`${TRADING_DATE}T00:00:00+05:30`.replace('T00:00:00', 'T15:30:00'));
  assert.throws(() => assertExpectedMissingMinuteWithinRegularSession(boundaryTimestamp, TRADING_DATE), GrowwGapRepairExpectedMissingMinuteError);
});

test('7: assertExpectedMissingMinuteWithinRegularSession rejects a pre-market timestamp (e.g. 09:00 IST)', () => {
  const preMarket = new Date(`${TRADING_DATE}T09:00:00+05:30`);
  assert.throws(() => assertExpectedMissingMinuteWithinRegularSession(preMarket, TRADING_DATE), GrowwGapRepairExpectedMissingMinuteError);
});

test('assertExpectedMissingMinuteWithinRegularSession accepts the exact live-verified 09:42 IST candidate for 2024-12-12', () => {
  assert.doesNotThrow(() => assertExpectedMissingMinuteWithinRegularSession(EXPECTED_MISSING_MINUTE_UTC, TRADING_DATE));
});

test('the wrapper independently re-validates trading-date match BEFORE delegating -- even if constructed with a mismatched date, the delegate is never called', async () => {
  const rows = fullDayRows(TRADING_DATE);
  const delegate = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient(rows));
  let delegateCalled = false;
  const spiedDelegate = {
    fetchCompletedUnderlyingRange: async (request: HistoricalUnderlyingCandleRangeRequest) => {
      delegateCalled = true;
      return delegate.fetchCompletedUnderlyingRange(request);
    },
    getCapability: () => delegate.getCapability(),
  } as unknown as GrowwUnderlyingHistoricalDataProviderService;
  const wrapper = new GrowwUnderlyingGapRepairProviderService(spiedDelegate, EXPECTED_MISSING_MINUTE_UTC);

  await assert.rejects(wrapper.fetchCompletedUnderlyingRange({ ...BASE_REQUEST, fromTradingDate: '2024-12-13', toTradingDate: '2024-12-13' }), GrowwGapRepairExpectedMissingMinuteError);
  assert.equal(delegateCalled, false, 'the underlying provider/client must never be called when the pre-check already fails closed');
});

test('fetchExpiredOptionRange is intentionally unimplemented and fails loudly', async () => {
  const wrapper = newWrapper([]);
  await assert.rejects(
    wrapper.fetchExpiredOptionRange({ assetType: HistoricalAssetType.NIFTY_OPTION, instrumentKey: 'NSE-NIFTY-06Jan22-17200-PE', interval: '1minute', fromTradingDate: TRADING_DATE, toTradingDate: TRADING_DATE })
  );
});
