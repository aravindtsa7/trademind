import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarketDataTimestamp } from './market-data-timestamp';

test('normalizes epoch milliseconds and ISO strings to canonical UTC ISO', () => {
  assert.equal(normalizeMarketDataTimestamp('1723618200000'), '2024-08-14T06:50:00.000Z');
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T09:15:00+05:30'), '2026-08-20T03:45:00.000Z');
});

test('rejects invalid, epoch-seconds, and epoch-microseconds without guessing', () => {
  assert.equal(normalizeMarketDataTimestamp('1723618200'), undefined);
  assert.equal(normalizeMarketDataTimestamp('1723618200000000'), undefined);
  assert.equal(normalizeMarketDataTimestamp('not-a-timestamp'), undefined);
  assert.equal(normalizeMarketDataTimestamp('2026-02-30T00:00:00.000Z'), undefined);
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T03:45:00'), undefined);
  assert.equal(normalizeMarketDataTimestamp(undefined), undefined);
});
