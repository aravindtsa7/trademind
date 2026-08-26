import assert from 'node:assert/strict';
import test from 'node:test';
import { splitIntoCalendarMonthChunks } from './calendar-month-chunking.util';

test('a range fully inside one month produces a single chunk', () => {
  assert.deepEqual(splitIntoCalendarMonthChunks('2022-01-10', '2022-01-20'), [{ fromDate: '2022-01-10', toDate: '2022-01-20' }]);
});

test('Jan 1 2022 through Mar 15 2022 splits into three chunks with no overlap or gap', () => {
  assert.deepEqual(splitIntoCalendarMonthChunks('2022-01-01', '2022-03-15'), [
    { fromDate: '2022-01-01', toDate: '2022-01-31' },
    { fromDate: '2022-02-01', toDate: '2022-02-28' },
    { fromDate: '2022-03-01', toDate: '2022-03-15' },
  ]);
});

test('leap February (2024) ends on the 29th when the chunk covers the full month', () => {
  assert.deepEqual(splitIntoCalendarMonthChunks('2024-01-15', '2024-03-05'), [
    { fromDate: '2024-01-15', toDate: '2024-01-31' },
    { fromDate: '2024-02-01', toDate: '2024-02-29' },
    { fromDate: '2024-03-01', toDate: '2024-03-05' },
  ]);
});

test('non-leap February (2022) ends on the 28th', () => {
  assert.deepEqual(splitIntoCalendarMonthChunks('2022-02-01', '2022-02-28'), [{ fromDate: '2022-02-01', toDate: '2022-02-28' }]);
});

test('a partial first month and partial last month never overlap at the boundary', () => {
  const chunks = splitIntoCalendarMonthChunks('2022-03-15', '2022-04-10');
  assert.deepEqual(chunks, [
    { fromDate: '2022-03-15', toDate: '2022-03-31' },
    { fromDate: '2022-04-01', toDate: '2022-04-10' },
  ]);
  assert.equal(chunks[0].toDate < chunks[1].fromDate, true);
});

test('adjacent chunks are exactly contiguous with no missing calendar date between them', () => {
  const chunks = splitIntoCalendarMonthChunks('2022-01-20', '2022-04-05');
  for (let index = 1; index < chunks.length; index += 1) {
    const previousEnd = new Date(`${chunks[index - 1].toDate}T00:00:00Z`);
    const currentStart = new Date(`${chunks[index].fromDate}T00:00:00Z`);
    assert.equal(currentStart.getTime() - previousEnd.getTime(), 24 * 60 * 60 * 1000);
  }
});

test('a single-day range produces one single-day chunk', () => {
  assert.deepEqual(splitIntoCalendarMonthChunks('2022-06-15', '2022-06-15'), [{ fromDate: '2022-06-15', toDate: '2022-06-15' }]);
});

test('a multi-year range produces one chunk per calendar month, in order, with no duplicated dates', () => {
  const chunks = splitIntoCalendarMonthChunks('2022-11-01', '2023-02-28');
  assert.deepEqual(chunks.map((chunk) => chunk.fromDate), ['2022-11-01', '2022-12-01', '2023-01-01', '2023-02-01']);
  assert.deepEqual(chunks.map((chunk) => chunk.toDate), ['2022-11-30', '2022-12-31', '2023-01-31', '2023-02-28']);
  const allDatesSeen = new Set<string>();
  for (const chunk of chunks) {
    assert.equal(allDatesSeen.has(chunk.fromDate), false);
    allDatesSeen.add(chunk.fromDate);
  }
});

test('fromDate after toDate throws rather than silently producing an empty/reversed result', () => {
  assert.throws(() => splitIntoCalendarMonthChunks('2022-05-01', '2022-04-01'));
});

test('a malformed date string throws', () => {
  assert.throws(() => splitIntoCalendarMonthChunks('2022-13-01', '2022-13-31'));
  assert.throws(() => splitIntoCalendarMonthChunks('not-a-date', '2022-01-31'));
});
