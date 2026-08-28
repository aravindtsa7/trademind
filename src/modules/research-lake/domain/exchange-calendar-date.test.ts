import assert from 'node:assert/strict';
import test from 'node:test';
import { addExchangeCalendarDays, exchangeCalendarDateToUtc, exchangeCalendarYear, parseExchangeCalendarDate } from './exchange-calendar-date';

test('strict calendar-date validator accepts real leap/month-end dates', () => {
  assert.deepEqual(parseExchangeCalendarDate('2032-02-29'), { year: 2032, month: 2, day: 29 });
  assert.deepEqual(parseExchangeCalendarDate('2031-04-30'), { year: 2031, month: 4, day: 30 });
  assert.equal(exchangeCalendarYear('2032-02-29'), 2032);
});

test('strict calendar-date validator rejects rollover and invalid month dates', () => {
  for (const value of ['2031-02-29', '2031-04-31', '2031-13-01', '2031-00-10']) {
    assert.throws(() => parseExchangeCalendarDate(value));
  }
});

test('UTC conversion and date enumeration helpers round-trip independently of host timezone', () => {
  assert.equal(exchangeCalendarDateToUtc('2032-02-29').toISOString(), '2032-02-29T00:00:00.000Z');
  assert.equal(addExchangeCalendarDays('2032-02-28', 1), '2032-02-29');
  assert.equal(addExchangeCalendarDays('2032-02-29', 1), '2032-03-01');
});
