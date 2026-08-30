import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompleteCalendarSession } from './calendar-session-completeness.util';

const TRADING_DATE = '2024-03-02';

function minuteRow(minuteOfDay: number): { candleTime: Date } {
  const dayStart = new Date(`${TRADING_DATE}T00:00:00+05:30`).getTime();
  return { candleTime: new Date(dayStart + minuteOfDay * 60_000) };
}

const MULTI_WINDOW_EXPECTED = [
  ...Array.from({ length: 45 }, (_, i) => 555 + i),
  ...Array.from({ length: 60 }, (_, i) => 690 + i),
];

test('exactly the expected minute set, no more, no less, is complete', () => {
  const rows = MULTI_WINDOW_EXPECTED.map((minute) => minuteRow(minute));
  assert.equal(isCompleteCalendarSession(rows, TRADING_DATE, MULTI_WINDOW_EXPECTED), true);
});

test('one missing minute is incomplete', () => {
  const rows = MULTI_WINDOW_EXPECTED.filter((minute) => minute !== 700).map((minute) => minuteRow(minute));
  assert.equal(isCompleteCalendarSession(rows, TRADING_DATE, MULTI_WINDOW_EXPECTED), false);
});

test('a surplus row outside the expected set is incomplete, never silently accepted as a superset match', () => {
  const rows = [...MULTI_WINDOW_EXPECTED.map((minute) => minuteRow(minute)), minuteRow(645)]; // 645 is in the gap, not expected
  assert.equal(isCompleteCalendarSession(rows, TRADING_DATE, MULTI_WINDOW_EXPECTED), false);
});

test('a duplicate row for an already-present expected minute is incomplete', () => {
  const rows = [...MULTI_WINDOW_EXPECTED.map((minute) => minuteRow(minute)), minuteRow(MULTI_WINDOW_EXPECTED[0])];
  assert.equal(isCompleteCalendarSession(rows, TRADING_DATE, MULTI_WINDOW_EXPECTED), false);
});

test('a row on a different IST calendar date is incomplete, regardless of minute-of-day match', () => {
  const rows = MULTI_WINDOW_EXPECTED.slice(1).map((minute) => minuteRow(minute));
  const wrongDateRow = { candleTime: new Date(`2024-03-03T${String(Math.floor(555 / 60)).padStart(2, '0')}:15:00+05:30`) };
  assert.equal(isCompleteCalendarSession([...rows, wrongDateRow], TRADING_DATE, MULTI_WINDOW_EXPECTED), false);
});

test('an empty expected-minutes set is never "complete" (a closed/blocked date has no session to be complete)', () => {
  assert.equal(isCompleteCalendarSession([], TRADING_DATE, []), false);
});

test('a single-window regular-shaped set behaves consistently: exact match completes, off-by-one does not', () => {
  const expected = Array.from({ length: 375 }, (_, i) => 555 + i);
  const complete = expected.map((minute) => minuteRow(minute));
  assert.equal(isCompleteCalendarSession(complete, TRADING_DATE, expected), true);
  assert.equal(isCompleteCalendarSession(complete.slice(0, 374), TRADING_DATE, expected), false);
});
