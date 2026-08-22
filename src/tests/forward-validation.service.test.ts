import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ForwardJournalRecord,
  ForwardValidationJournal,
  costStressExpectancy,
  estimateEntry,
  estimateExit,
  executionComparison,
  normalizeQuote,
  resolveSessionOutcome,
  strategyFingerprint,
  summarizeForwardValidation,
  uniqueForwardTradingDates,
} from '../modules/research-validation';

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
    journal.append({ recordType: 'SUMMARY', tradingDate: '2026-08-12', strategyId: 'V4', fingerprint: 'fp', eodReason: 'VALID_COMPLETED', sessionCompleted: true, status: 'VALID_COMPLETED' });
    const records = journal.read('2026-08-12');
    assert.equal(new Set(records.filter((record) => record.signalId).map((record) => record.signalId)).size, 1);
    assert.equal(records.at(-1)?.status, 'VALID_COMPLETED');
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

test('A9 outcome resolver maps genuine EOD reasons to VALID_COMPLETED with sessionCompleted true', () => {
  const eodReasons = ['VALID_COMPLETED', 'EOD', 'WALL_CLOCK_EOD', 'MARKET_EOD', 'EOD_NSE_SESSION_CLOSE', 'SESSION_END'];
  for (const reason of eodReasons) {
    const outcome = resolveSessionOutcome({ reason });
    assert.equal(outcome.status, 'VALID_COMPLETED');
    assert.equal(outcome.sessionCompleted, true);
  }
});

test('A9 outcome resolver maps manual stop reasons to MANUAL_STOP with sessionCompleted false', () => {
  const manualReasons = ['SIGINT', 'SIGTERM', 'MANUAL_STOP', 'MANUAL_SHUTDOWN'];
  for (const reason of manualReasons) {
    const outcome = resolveSessionOutcome({ reason });
    assert.equal(outcome.status, 'MANUAL_STOP');
    assert.equal(outcome.sessionCompleted, false);
  }
});

test('A9 outcome resolver maps fault reason to FAULTED with sessionCompleted false', () => {
  const outcome = resolveSessionOutcome({ reason: 'FAULTED' });
  assert.equal(outcome.status, 'FAULTED');
  assert.equal(outcome.sessionCompleted, false);
});

test('A9 outcome resolver maps unknown or anomalous shutdown reasons fail-closed to FAULTED with sessionCompleted false', () => {
  const unknown = resolveSessionOutcome({ reason: 'SOMETHING_NEW', reconciliationRequired: false, durableExitDrained: true });
  assert.equal(unknown.status, 'FAULTED');
  assert.equal(unknown.sessionCompleted, false);

  // Typos can NEVER fall through to VALID_COMPLETED or MANUAL_STOP
  const typos = ['VALID_COMPLETE', 'EODD', 'SIGINT_TYPO', 'SESSION_ENDED', 'UNKNOWN_STOP'];
  for (const typo of typos) {
    const outcome = resolveSessionOutcome({ reason: typo });
    assert.equal(outcome.status, 'FAULTED');
    assert.equal(outcome.sessionCompleted, false);
  }
});

test('A9 outcome resolver maps startup/warmup blockers to INVALID_DATA via explicit invalidData signal', () => {
  const realProductionBlockerReasons = [
    'WAITING_FOR_FIRST_COMPLETED_CURRENT_DAY_MINUTE',
    'CURRENT_DAY_BACKFILL_FAILED:historical_candle_fetch_timeout',
    'STALE_CURRENT_DAY_HISTORY:lag_exceeded',
    'STALE_CURRENT_DAY_5M_HISTORY:missing_five_minute_bar',
    'V8_NO_PRIOR_HISTORICAL_SESSION_AVAILABLE',
    'V8_TARGET_SESSION_SOURCE_DISCONTINUOUS:gap_minute_count_nonzero',
  ];

  for (const reason of realProductionBlockerReasons) {
    // With explicit invalidData or startupDataBlocked signal -> INVALID_DATA
    const outcomeWithInvalidData = resolveSessionOutcome({ reason, invalidData: true });
    assert.equal(outcomeWithInvalidData.status, 'INVALID_DATA');
    assert.equal(outcomeWithInvalidData.sessionCompleted, false);

    const outcomeWithStartupBlocked = resolveSessionOutcome({ reason, startupDataBlocked: true });
    assert.equal(outcomeWithStartupBlocked.status, 'INVALID_DATA');
    assert.equal(outcomeWithStartupBlocked.sessionCompleted, false);

    // WITHOUT explicit invalidData signal, unknown free-form strings do not become INVALID_DATA (fail-closed to FAULTED)
    const outcomeWithoutSignal = resolveSessionOutcome({ reason });
    assert.equal(outcomeWithoutSignal.status, 'FAULTED');
    assert.equal(outcomeWithoutSignal.sessionCompleted, false);
  }

  // Explicit reason 'INVALID_DATA' is always accepted
  const explicitInvalid = resolveSessionOutcome({ reason: 'INVALID_DATA' });
  assert.equal(explicitInvalid.status, 'INVALID_DATA');
  assert.equal(explicitInvalid.sessionCompleted, false);
});

test('A9 outcome resolver enforces V2 precedence: RECONCILIATION_REQUIRED over FAULTED and MANUAL_STOP', () => {
  // Faulted + reconciliation required
  const faultedReconcile = resolveSessionOutcome({ reason: 'FAULTED', reconciliationRequired: true });
  assert.equal(faultedReconcile.status, 'RECONCILIATION_REQUIRED');
  assert.equal(faultedReconcile.sessionCompleted, false);

  // SIGINT + reconciliation required
  const sigintReconcile = resolveSessionOutcome({ reason: 'SIGINT', reconciliationRequired: true });
  assert.equal(sigintReconcile.status, 'RECONCILIATION_REQUIRED');
  assert.equal(sigintReconcile.sessionCompleted, false);

  // Normal EOD + undrained durable exit
  const undrainedEod = resolveSessionOutcome({ reason: 'EOD_NSE_SESSION_CLOSE', durableExitDrained: false });
  assert.equal(undrainedEod.status, 'RECONCILIATION_REQUIRED');
  assert.equal(undrainedEod.sessionCompleted, false);
});

test('A9 forward-validation reporting gating: Date A through Date I fail-closed verification', () => {
  const fp = 'abc1234567890def';
  const strategyId = 'V4_NIFTY_MOMENTUM_PE_SHADOW';
  const mockRecords: ForwardJournalRecord[] = [
    // Date A: VALID_COMPLETED + 2 exits -> INCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-01', strategyId, fingerprint: fp, status: 'VALID_COMPLETED', sessionCompleted: true, eodReason: 'WALL_CLOCK_EOD' },
    { recordType: 'SIGNAL', tradingDate: '2026-08-01', strategyId, fingerprint: fp, signalId: 's-A1' },
    { recordType: 'EXIT', tradingDate: '2026-08-01', strategyId, fingerprint: fp, signalId: 's-A1', theoreticalReturn: 5, executableEstimatedReturn: 4.8, exitReason: 'TARGET' },
    { recordType: 'EXIT', tradingDate: '2026-08-01', strategyId, fingerprint: fp, signalId: 's-A2', theoreticalReturn: -2, executableEstimatedReturn: -2.2, exitReason: 'STOP' },

    // Date B: Legacy COMPLETED -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-02', strategyId, fingerprint: fp, status: 'COMPLETED', sessionCompleted: true, eodReason: 'SESSION_END' },
    { recordType: 'EXIT', tradingDate: '2026-08-02', strategyId, fingerprint: fp, signalId: 's-B1', theoreticalReturn: 10, executableEstimatedReturn: 10, exitReason: 'TARGET' },

    // Date C: MANUAL_STOP -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-03', strategyId, fingerprint: fp, status: 'MANUAL_STOP', sessionCompleted: false, eodReason: 'SIGINT' },
    { recordType: 'EXIT', tradingDate: '2026-08-03', strategyId, fingerprint: fp, signalId: 's-C1', theoreticalReturn: 8, executableEstimatedReturn: 8, exitReason: 'TARGET' },

    // Date D: FAULTED -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-04', strategyId, fingerprint: fp, status: 'FAULTED', sessionCompleted: false, eodReason: 'FAULTED' },
    { recordType: 'EXIT', tradingDate: '2026-08-04', strategyId, fingerprint: fp, signalId: 's-D1', theoreticalReturn: -5, executableEstimatedReturn: -5, exitReason: 'STOP' },

    // Date E: INVALID_DATA -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-05', strategyId, fingerprint: fp, status: 'INVALID_DATA', sessionCompleted: false, eodReason: 'WARMUP_NOT_READY' },
    { recordType: 'EXIT', tradingDate: '2026-08-05', strategyId, fingerprint: fp, signalId: 's-E1', theoreticalReturn: 2, executableEstimatedReturn: 2, exitReason: 'TARGET' },

    // Date F: RECONCILIATION_REQUIRED -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-06', strategyId, fingerprint: fp, status: 'RECONCILIATION_REQUIRED', sessionCompleted: false, eodReason: 'LOCAL_DURABLE_EXIT_UNCERTAIN' },
    { recordType: 'EXIT', tradingDate: '2026-08-06', strategyId, fingerprint: fp, signalId: 's-F1', theoreticalReturn: 3, executableEstimatedReturn: 3, exitReason: 'TARGET' },

    // Date G: No SUMMARY -> EXCLUDED
    { recordType: 'SIGNAL', tradingDate: '2026-08-07', strategyId, fingerprint: fp, signalId: 's-G1' },
    { recordType: 'EXIT', tradingDate: '2026-08-07', strategyId, fingerprint: fp, signalId: 's-G1', theoreticalReturn: 6, executableEstimatedReturn: 6, exitReason: 'TARGET' },

    // Date H: Two conflicting SUMMARY records -> EXCLUDED
    { recordType: 'SUMMARY', tradingDate: '2026-08-08', strategyId, fingerprint: fp, status: 'VALID_COMPLETED', sessionCompleted: true, eodReason: 'WALL_CLOCK_EOD' },
    { recordType: 'SUMMARY', tradingDate: '2026-08-08', strategyId, fingerprint: fp, status: 'MANUAL_STOP', sessionCompleted: false, eodReason: 'SIGINT' },
    { recordType: 'EXIT', tradingDate: '2026-08-08', strategyId, fingerprint: fp, signalId: 's-H1', theoreticalReturn: 7, executableEstimatedReturn: 7, exitReason: 'TARGET' },

    // Date I: VALID_COMPLETED with zero exits -> INCLUDED as valid session with 0 trades
    { recordType: 'SUMMARY', tradingDate: '2026-08-09', strategyId, fingerprint: fp, status: 'VALID_COMPLETED', sessionCompleted: true, eodReason: 'WALL_CLOCK_EOD' },
  ];

  const summary = summarizeForwardValidation(strategyId, mockRecords);

  // Exactly Date A and Date I are eligible (2 sessions)
  assert.equal(summary.sessionsObserved, 2);
  // Signals from Date A only (Date G excluded)
  assert.equal(summary.signals, 1);
  // Exits from Date A only (2 resolved trades)
  assert.equal(summary.resolvedTrades, 2);
  assert.equal(summary.unresolvedTrades, 0);

  // Theoretical expectancy = (5 + -2) / 2 = 1.5
  assert.equal(summary.theoreticalExpectancy, 1.5);
  // Executable expectancy = (4.8 + -2.2) / 2 = 1.3
  assert.equal(Math.round(summary.executableEstimatedExpectancy * 10) / 10, 1.3);

  // Daily PnL semantics: Date A has +2.6% net, Date I has 0 exits (no synthetic 0% diluting denominator).
  // Exactly 1 out of 1 PnL-bearing eligible days is profitable = 100%
  assert.equal(summary.profitableDayPct, 100);
  assert.equal(summary.maxDrawdown, 0);
  assert.equal(summary.maxLossStreak, 0);

  // Excluded date diagnostics
  assert.equal(summary.excludedDateDiagnostics.legacyCompletedCount, 1); // Date B
  assert.equal(summary.excludedDateDiagnostics.manualStopCount, 1); // Date C
  assert.equal(summary.excludedDateDiagnostics.faultedCount, 1); // Date D
  assert.equal(summary.excludedDateDiagnostics.invalidDataCount, 1); // Date E
  assert.equal(summary.excludedDateDiagnostics.reconciliationRequiredCount, 1); // Date F
  assert.equal(summary.excludedDateDiagnostics.missingSummaryCount, 1); // Date G
  assert.equal(summary.excludedDateDiagnostics.duplicateSummaryCount, 1); // Date H
});
