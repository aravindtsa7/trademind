import assert from 'node:assert/strict';
import test from 'node:test';
import { v7AuthorizedOptionSessions, validateV7AuthorizedResponse } from './helpers/v7-authorized-option-cache-fill';

test('V7 authorization is exactly the 46 unique requested instrument/date sessions', () => {
  assert.equal(v7AuthorizedOptionSessions.length, 46);
  assert.equal(new Set(v7AuthorizedOptionSessions.map((item) => `${item.instrumentKey}\u0000${item.tradingDate}`)).size, 46);
});

test('V7 accepts only an exact 375-minute IST session and rejects extra, duplicate, gap, date, and OHLC anomalies', () => {
  const request = v7AuthorizedOptionSessions[0]; const start = new Date(`${request.tradingDate}T09:15:00+05:30`).getTime();
  const valid = Array.from({ length: 375 }, (_, index) => ({ candleTime: new Date(start + index * 60_000), open: 100, high: 101, low: 99, close: 100.5, volume: 1n, instrumentKey: request.instrumentKey }));
  assert.deepEqual(validateV7AuthorizedResponse(request, valid).valid, true);
  assert.equal(validateV7AuthorizedResponse(request, [...valid, { ...valid[374], candleTime: new Date(start + 375 * 60_000) }]).valid, false);
  assert.equal(validateV7AuthorizedResponse(request, valid.filter((_, index) => index !== 20)).valid, false);
  assert.equal(validateV7AuthorizedResponse(request, [...valid.slice(0, 10), valid[9], ...valid.slice(10)]).valid, false);
  assert.equal(validateV7AuthorizedResponse(request, valid.map((row, index) => index === 0 ? { ...row, low: 102 } : row)).valid, false);
});
