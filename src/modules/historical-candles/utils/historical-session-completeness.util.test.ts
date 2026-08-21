import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompleteHistoricalSession } from './historical-session-completeness.util';

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
