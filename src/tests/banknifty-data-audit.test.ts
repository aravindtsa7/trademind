import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBankNiftyUnderlying, proposedSplit, reconstructDerivedBarCounts } from '../modules/research/banknifty-data-audit';

const key = 'NSE_INDEX|Nifty Bank';
function rows(date: string, count = 375) { return Array.from({ length: count }, (_, index) => { const candleTime = new Date(`${date}T09:15:00+05:30`); candleTime.setTime(candleTime.getTime() + index * 60_000); return { instrumentKey: key, timeframe: '1minute', candleTime, open: 100, high: 102, low: 99, close: 101 }; }); }

test('BANK NIFTY audit is instrument/timeframe isolated and detects clean sessions', () => {
  const result = auditBankNiftyUnderlying([...rows('2026-03-02'), { ...rows('2026-03-03')[0], instrumentKey: 'NSE_INDEX|Nifty 50' }], key, '1minute', '2026-03-02', '2026-03-03');
  assert.equal(result.rowsInScope, 375);
  assert.equal(result.cleanSessionCount, 1);
  assert.equal(result.sessions[0].complete, true);
});

test('BANK NIFTY audit detects gaps, duplicates and out-of-session rows', () => {
  const duplicate = rows('2026-03-03'); duplicate.push({ ...duplicate[20] });
  const gapped = rows('2026-03-04').filter((_, index) => index !== 20);
  const extra = { ...rows('2026-03-05')[0], candleTime: new Date('2026-03-05T15:30:00+05:30') };
  const result = auditBankNiftyUnderlying([...duplicate, ...gapped, ...rows('2026-03-05'), extra], key, '1minute', '2026-03-03', '2026-03-05');
  assert.equal(result.sessions.find((session) => session.tradingDate === '2026-03-03')?.duplicateTimestamps.length, 1);
  assert.equal(result.sessions.find((session) => session.tradingDate === '2026-03-04')?.missingMinutes, 1);
  assert.equal(result.sessions.find((session) => session.tradingDate === '2026-03-05')?.outOfSessionTimestamps.length, 1);
});

test('protected split is only proposed for exactly 104 usable sessions', () => {
  const dates = Array.from({ length: 104 }, (_, index) => { const date = new Date('2026-01-01T00:00:00Z'); date.setUTCDate(date.getUTCDate() + index); return date.toISOString().slice(0, 10); });
  const proposal = proposedSplit(dates);
  assert.equal(proposal.status, 'PROPOSED');
  assert.equal(proposal.assignments?.filter((entry) => entry.split === 'TRAIN').length, 60);
  assert.equal(proposal.assignments?.filter((entry) => entry.split === 'VALIDATION').length, 20);
  assert.equal(proposedSplit(dates.slice(0, 103)).status, 'NOT_PROPOSED_SESSION_COUNT_IS_NOT_104');
});

test('clean continuous 1m sessions rebuild deterministic 2m, 3m and 5m bars', () => {
  const result = reconstructDerivedBarCounts(rows('2026-03-02'));
  assert.equal(result.continuous, true);
  assert.equal(result.valid, true);
  assert.equal(result['2m'], 187);
  assert.equal(result['3m'], 125);
  assert.equal(result['5m'], 75);
});
