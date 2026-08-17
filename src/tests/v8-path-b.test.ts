import assert from 'node:assert/strict'; import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import test from 'node:test';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import { assertV8TrainOnlyDates, selectV8TrainOnlyWinner, v8FrozenStrategyFingerprint, v8FrozenStrategyInputs } from '../modules/research/v8-nifty-bullish-reclaim';
import V8ShadowObservationTracker from '../modules/adaptive-intraday/services/v8-shadow-observation-tracker.service';
import { ForwardValidationJournal, normalizeQuote } from '../modules/research-validation';

const trainConfig = { timeframe: 2 as const, levelFamily: 'PDH' as const, reclaimBufferAtr: .1 as const, bullishBodyAtr: .25 as const, rsiMinimum: 50 as const, regimeMode: 'NO_REGIME_FILTER' as const, cooldownMinutes: 5 as const };
const base = { id: 'z', config: trainConfig, policy: { target: 6, stop: 5, hold: 15 }, settledTrades: 32, netAt040: 1, grossMedian: 2, targetRate: 60, stopRate: 30, maxDrawdown: 10, maxLosingStreak: 2 };
test('V8 PATH B restricts requested dates and deterministic selection never reads validation rank data', () => {
  const splits = new Map([['2026-03-02', 'TRAIN'], ['2026-06-08', 'VALIDATION'], ['2026-07-10', 'FINAL_HOLDOUT']]);
  assert.doesNotThrow(() => assertV8TrainOnlyDates(['2026-03-02'], splits));
  assert.throws(() => assertV8TrainOnlyDates(['2026-03-02', '2026-06-08'], splits), /non-TRAIN/);
  assert.throws(() => assertV8TrainOnlyDates(['2026-07-10'], splits), /non-TRAIN/);
  const winner = selectV8TrainOnlyWinner([{ ...base, id: 'b', netAt040: 1.1 }, { ...base, id: 'a', netAt040: 1.1 }, { ...base, id: 'validation-only-looking', netAt040: .5 }]);
  assert.equal(winner.id, 'a');
  assert.equal(v8FrozenStrategyFingerprint(winner), v8FrozenStrategyFingerprint(winner));
  assert.equal(v8FrozenStrategyFingerprint(base), 'c815f819acd71e98');
  assert.equal(v8FrozenStrategyInputs(winner).strategyId, 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW');
});
test('bounded underlying preload calls only inclusive requested range and cannot load a final-holdout row', async () => {
  const calls: unknown[] = []; const row = (time: string) => ({ candleTime: new Date(time), open: 1, high: 1, low: 1, close: 1, volume: 0n, openInterest: null });
  const repository = { findRange: async (_instrument: string, _tf: string, start: Date, end: Date) => { calls.push([start, end]); return [row('2026-03-02T09:15:00+05:30')]; }, findByInstrumentAndTimeframe: async () => { throw new Error('unbounded preload must not run'); } };
  const preloader = new HistoricalOptionResearchPreloaderService(repository as never, {} as never, {} as never, true);
  const result = await preloader.preloadUnderlyingRange('NSE_INDEX|Nifty 50', '1minute', new Date('2026-03-02T00:00:00+05:30'), new Date('2026-06-02T23:59:59+05:30'));
  assert.equal(calls.length, 1); assert.equal(result.underlyingByDate.has('2026-07-10'), false); assert.equal(result.underlyingByDate.size, 1);
});
test('V8 shadow tracker is bid/ask aware, orderless, and resolves EOD deterministically', () => {
  const tracker = new V8ShadowObservationTracker({ target: 6, stop: 5, hold: 15 }); const signalAt = new Date('2026-08-17T04:30:00.000Z'); const contract = { instrumentKey: 'NSE_FO|1', tradingSymbol: 'NIFTY CE', underlying: 'NIFTY 50', strikePrice: 25000, expiry: new Date('2026-08-18T10:00:00Z'), optionType: 'CE' as const, exchange: 'NSE', segment: 'FO' };
  tracker.register('one', signalAt, contract); const at = new Date(signalAt.getTime() + 1_000); const quote = normalizeQuote({ ltp: 100, bid: 99, ask: 101, timestamp: at }, at);
  assert.equal(tracker.observe('one', contract.instrumentKey, 100, 100, quote, at).length, 0);
  const [eod] = tracker.closeAtEod(new Date(at.getTime() + 60_000), quote); assert.equal(eod.reason, 'EOD'); assert.equal(eod.observation.executableEntry, 101); assert.equal(eod.executableExit, 99); assert.equal(tracker.getOpenCount(), 0);
  assert.equal(normalizeQuote({ ltp: 100, bid: 99, ask: 101, timestamp: new Date(at.getTime() - 2_001) }, at).quality, 'STALE_QUOTE');
});
test('V8 forward journal is restart-safe and rejects fingerprint changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-v8-journal-'));
  try { const journal = new ForwardValidationJournal('V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW', 'fingerprint-one', directory); const record = { recordType: 'SIGNAL' as const, tradingDate: '2026-08-17', strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW', fingerprint: 'fingerprint-one', signalId: 'same-signal' }; journal.append(record); journal.append(record); assert.equal(journal.read('2026-08-17').length, 1); assert.throws(() => new ForwardValidationJournal('V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW', 'changed-fingerprint', directory), /fingerprint mismatch/); } finally { rmSync(directory, { recursive: true, force: true }); }
});
