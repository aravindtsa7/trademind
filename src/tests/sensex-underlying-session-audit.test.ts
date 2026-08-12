import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSensexUnderlyingSessions, SensexUnderlyingRow } from './helpers/sensex-underlying-session-audit';

const instrumentKey = 'BSE_INDEX|SENSEX';

function rows(date: string): SensexUnderlyingRow[] {
  return Array.from({ length: 375 }, (_, index) => {
    const candleTime = new Date(`${date}T09:15:00+05:30`);
    candleTime.setTime(candleTime.getTime() + index * 60_000);
    return { instrumentKey, timeframe: '1minute', candleTime, open: 100, high: 102, low: 99, close: 101 };
  });
}

test('keeps BSE SENSEX audit strictly isolated to its instrument and timeframe', () => {
  const source = [
    ...rows('2026-03-02'),
    { ...rows('2026-03-03')[0], instrumentKey: 'NSE_INDEX|Nifty 50' },
    { ...rows('2026-03-03')[0], timeframe: '5minute' },
  ];
  const audit = auditSensexUnderlyingSessions(source, instrumentKey, '1minute');
  assert.equal(audit.ignoredRows, 2);
  assert.equal(audit.sessions.length, 1);
  assert.equal(audit.sessions[0].complete, true);
});

test('detects duplicate timestamps and missing-minute gaps without changing candle values', () => {
  const duplicate = rows('2026-03-03');
  duplicate.push({ ...duplicate[120] });
  const gapped = rows('2026-03-04').filter((_, index) => index !== 120);
  const audit = auditSensexUnderlyingSessions([...rows('2026-03-02'), ...duplicate, ...gapped], instrumentKey, '1minute');
  const duplicatedSession = audit.sessions.find((session) => session.tradingDate === '2026-03-03');
  const gappedSession = audit.sessions.find((session) => session.tradingDate === '2026-03-04');
  assert.equal(duplicatedSession?.duplicateTimestamps.length, 1);
  assert.equal(duplicatedSession?.complete, false);
  assert.equal(gappedSession?.missingMinuteCount, 1);
  assert.equal(gappedSession?.complete, false);
});

test('derives the normal session from actual continuous rows', () => {
  const audit = auditSensexUnderlyingSessions([...rows('2026-03-02'), ...rows('2026-03-03')], instrumentKey, '1minute');
  assert.deepEqual(audit.normalSession, { rowCount: 375, firstMinute: 555, lastMinute: 929 });
  assert.equal(audit.sessions.every((session) => session.complete), true);
});
