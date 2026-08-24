import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompleteHistoricalSession, expectedNifty1mCompletedMinute, nifty1mSourceCompletionBoundary, HISTORICAL_SESSION_ROW_COUNT, NIFTY_1M_SOURCE_HORIZON_END_MINUTE } from './historical-session-completeness.util';

function fullDay(date: string): { candleTime: Date }[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000) }));
}

test('375 contiguous minute-aligned rows from 09:15-15:29 IST is complete', () => {
  assert.equal(isCompleteHistoricalSession(fullDay('2026-08-21')), true);
});

test('374 rows (one short) is incomplete', () => {
  assert.equal(isCompleteHistoricalSession(fullDay('2026-08-21').slice(0, 374)), false);
});

test('an interior missing minute (374 rows, gap in the middle) is incomplete', () => {
  const rows = fullDay('2026-08-21');
  rows.splice(200, 1);
  assert.equal(isCompleteHistoricalSession(rows), false);
});

test('a trailing partial session (283 rows, Aug-21 shape) is incomplete', () => {
  assert.equal(isCompleteHistoricalSession(fullDay('2026-08-21').slice(0, 283)), false);
});

test('a duplicate timestamp in place of the last minute is never accepted as complete', () => {
  const rows = fullDay('2026-08-21');
  rows[374] = { candleTime: rows[373].candleTime }; // duplicate of the second-to-last minute instead of the true last minute
  assert.equal(isCompleteHistoricalSession(rows), false);
});

test('a non-minute-aligned timestamp is incomplete', () => {
  const rows = fullDay('2026-08-21');
  rows[10] = { candleTime: new Date(rows[10].candleTime.getTime() + 15_000) };
  assert.equal(isCompleteHistoricalSession(rows), false);
});

test('rows spanning two IST calendar dates are incomplete', () => {
  const rows = fullDay('2026-08-21').slice(0, 374);
  rows.push({ candleTime: new Date(`2026-08-22T09:15:00+05:30`) });
  assert.equal(isCompleteHistoricalSession(rows), false);
});

test('a session not starting at 09:15 IST is incomplete', () => {
  const start = new Date('2026-08-21T09:16:00+05:30').getTime();
  const rows = Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000) }));
  assert.equal(isCompleteHistoricalSession(rows), false);
});

test('empty input is incomplete', () => {
  assert.equal(isCompleteHistoricalSession([]), false);
});

// ---- A7-H4: canonical NIFTY_INDEX 1m source-horizon contract, shared by
// LivePaperFreshWarmupService and MarketDataRecoveryCoordinatorService (getSourceCompletionBoundary) ----

test('the row-count and end-minute constants agree: 375 rows ending at 15:29 IST', () => {
  assert.equal(HISTORICAL_SESSION_ROW_COUNT, 375);
  assert.equal(NIFTY_1M_SOURCE_HORIZON_END_MINUTE, 15 * 60 + 29);
});

test('expectedNifty1mCompletedMinute returns null at/before session open', () => {
  assert.equal(expectedNifty1mCompletedMinute(new Date('2026-08-24T09:15:00+05:30')), null);
  assert.equal(expectedNifty1mCompletedMinute(new Date('2026-08-24T08:00:00+05:30')), null);
});

test('expectedNifty1mCompletedMinute resolves the ordinary minus-one-minute rule during normal intraday hours', () => {
  assert.equal(expectedNifty1mCompletedMinute(new Date('2026-08-24T12:40:12+05:30'))?.toISOString(), new Date('2026-08-24T12:39:00+05:30').toISOString());
});

test('expectedNifty1mCompletedMinute at 15:29:59 still treats 15:29 as forming -- expected is 15:28', () => {
  assert.equal(expectedNifty1mCompletedMinute(new Date('2026-08-24T15:29:59+05:30'))?.toISOString(), new Date('2026-08-24T15:28:00+05:30').toISOString());
});

test('expectedNifty1mCompletedMinute at exactly 15:30:00 (the source horizon) resolves 15:29, the session\'s actual last candle', () => {
  assert.equal(expectedNifty1mCompletedMinute(new Date('2026-08-24T15:30:00+05:30'))?.toISOString(), new Date('2026-08-24T15:29:00+05:30').toISOString());
});

test('expectedNifty1mCompletedMinute never advances past 15:29, at any reference time at or after the source horizon -- including 15:40 and well beyond', () => {
  for (const now of ['15:30:00', '15:40:00', '18:00:00']) {
    assert.equal(expectedNifty1mCompletedMinute(new Date(`2026-08-24T${now}+05:30`))?.toISOString(), new Date('2026-08-24T15:29:00+05:30').toISOString(), now);
  }
});

test('nifty1mSourceCompletionBoundary is 15:30 IST on the reference date, independent of the time of day passed in', () => {
  assert.equal(nifty1mSourceCompletionBoundary(new Date('2026-08-24T09:20:00+05:30')).toISOString(), new Date('2026-08-24T15:30:00+05:30').toISOString());
  assert.equal(nifty1mSourceCompletionBoundary(new Date('2026-08-24T18:00:00+05:30')).toISOString(), new Date('2026-08-24T15:30:00+05:30').toISOString());
});
