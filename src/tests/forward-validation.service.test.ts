import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ForwardValidationJournal, costStressExpectancy, estimateEntry, estimateExit, executionComparison, normalizeQuote, strategyFingerprint, uniqueForwardTradingDates } from '../modules/research-validation';

test('strategy fingerprints are deterministic and change with frozen rules', () => {
  const base = { strategyId: 'V2_TREND_DOWN_PE', timeframe: '5m', cooldown: 10, target: 5 };
  assert.equal(strategyFingerprint(base), strategyFingerprint({ target: 5, cooldown: 10, timeframe: '5m', strategyId: 'V2_TREND_DOWN_PE' }));
  assert.notEqual(strategyFingerprint(base), strategyFingerprint({ ...base, cooldown: 5 }));
});

test('fresh bid/ask uses ask for entry and bid for exit', () => {
  const quote = normalizeQuote({ ltp: 105, bid: 100, ask: 110, timestamp: new Date('2026-08-12T09:15:00Z') }, new Date('2026-08-12T09:15:01Z'));
  assert.equal(quote.quality, 'BID_ASK');
  assert.deepEqual(estimateEntry(quote), { price: 110, source: 'ASK' });
  assert.deepEqual(estimateExit(quote), { price: 100, source: 'BID' });
  const comparison = executionComparison(100, 105, 110, 100);
  assert.equal(comparison.theoreticalReturn, 5);
  assert.ok((comparison.totalExecutionFrictionPercent ?? 0) > 0);
});

test('LTP-only fallback is explicit and stale quote is unavailable', () => {
  const ltp = normalizeQuote({ ltp: 100, timestamp: new Date('2026-08-12T09:15:00Z') }, new Date('2026-08-12T09:15:01Z'));
  assert.equal(ltp.quality, 'LTP_ONLY');
  assert.deepEqual(estimateEntry(ltp), { price: 100, source: 'ESTIMATED_LTP' });
  const stale = normalizeQuote({ ltp: 100, bid: 99, ask: 101, timestamp: new Date('2026-08-12T09:14:00Z') }, new Date('2026-08-12T09:15:01Z'));
  assert.equal(stale.quality, 'STALE_QUOTE');
  assert.deepEqual(estimateExit(stale), { price: null, source: 'UNAVAILABLE' });
});

test('journal is append-only and refuses fingerprint mismatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-forward-'));
  try {
    const journal = new ForwardValidationJournal('V2', 'abc', directory);
    journal.append({ recordType: 'SIGNAL', tradingDate: '2026-08-12', strategyId: 'V2', fingerprint: 'abc', signalId: 's1' });
    journal.append({ recordType: 'SIGNAL', tradingDate: '2026-08-12', strategyId: 'V2', fingerprint: 'abc', signalId: 's1' });
    journal.append({ recordType: 'EXIT', tradingDate: '2026-08-12', strategyId: 'V2', fingerprint: 'abc', signalId: 's1', executableEstimatedReturn: 1 });
    assert.equal(journal.read('2026-08-12').length, 2);
    assert.throws(() => journal.append({ recordType: 'SIGNAL', tradingDate: '2026-08-12', strategyId: 'V2', fingerprint: 'different' }));
    assert.equal(readFileSync(join(directory, 'V2', '2026-08-12.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('signal IDs and EOD records can be represented without orders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-forward-eod-'));
  try {
    const journal = new ForwardValidationJournal('V4', 'fp', directory);
    journal.append({ recordType: 'SIGNAL', tradingDate: '2026-08-12', strategyId: 'V4', fingerprint: 'fp', signalId: 'V4-1', flags: ['SHADOW_ONLY'] });
    journal.append({ recordType: 'SUMMARY', tradingDate: '2026-08-12', strategyId: 'V4', fingerprint: 'fp', eodReason: 'SESSION_END', sessionCompleted: true, status: 'COMPLETED' });
    const records = journal.read('2026-08-12');
    assert.equal(new Set(records.filter((record) => record.signalId).map((record) => record.signalId)).size, 1);
    assert.equal(records.at(-1)?.status, 'COMPLETED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('forward sessions count unique IST dates across restarts and preserve distinct dates', () => {
  assert.deepEqual(uniqueForwardTradingDates([
    { tradingDate: '2026-08-13' },
    { tradingDate: '2026-08-13' },
    { tradingDate: '2026-08-14' },
  ]), ['2026-08-13', '2026-08-14']);
});

test('cost stress does not charge a flat cost when there are no resolved trades', () => {
  assert.deepEqual(costStressExpectancy([]), { netAt02: 0, netAt04: 0, netAt06: 0, netAt08: 0, netAt1: 0 });
  assert.equal(costStressExpectancy([1, -1], [.4]).netAt04, -.4);
});
