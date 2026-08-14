import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { assertV10NoLookAhead, createV10Configs, generateV10Signals, v10TheoreticalConfigurationCount, V10Config, V10Indicators, V10PreparedSession } from '../modules/research/v10-nifty-banknifty-lead-lag';
import ResearchSplitService from '../modules/research-validation/services/research-split.service';

const start = new Date('2026-03-02T03:45:00.000Z').getTime();
const candle = (index: number, open: number, high: number, low: number, close: number) => ({ timestamp: new Date(start + index * 60_000), open, high, low, close, volume: 1 });
function config(overrides: Partial<V10Config> = {}): V10Config { return { timeframe: 1, bankImpulseLookbackBars: 1, bankImpulseThresholdAtr: .75, niftyLagRatioMaximum: .75, confirmationDelayBars: 1, confirmation: 'DIRECTIONAL_CLOSE', regimeMode: 'NO_REGIME_FILTER', timeFilter: 'FULL_SESSION', cooldownMinutes: 5, ...overrides }; }
function session(removeBankIndex?: number): V10PreparedSession {
  const nifty = Array.from({ length: 25 }, (_, index) => candle(index, 100, 101, 99, 100));
  const bank = Array.from({ length: 25 }, (_, index) => candle(index, 200, 201, 199, 200));
  bank[10] = candle(10, 200, 202, 199, 202); nifty[10] = candle(10, 100, 101, 99.8, 100.1); nifty[11] = candle(11, 100, 101.5, 99.9, 101.2);
  if (removeBankIndex !== undefined) bank.splice(removeBankIndex, 1);
  return { date: '2026-03-02', niftyFrames: { 1: nifty, 2: nifty, 3: nifty }, bankFrames: { 1: bank, 2: bank, 3: bank }, niftyRegimePoints: [{ availableAt: new Date(start), regime: AdaptivePrimaryMarketRegime.TREND_UP }] };
}
function indicators(sessionValue: V10PreparedSession): V10Indicators { const map = new Map(sessionValue.niftyFrames[1].map((value) => [value.timestamp.getTime(), 1])); const bank = new Map(sessionValue.bankFrames[1].map((value) => [value.timestamp.getTime(), 1])); return { niftyAtrByFrame: new Map([[1 as const, map], [2 as const, map], [3 as const, map]]), bankAtrByFrame: new Map([[1 as const, bank], [2 as const, bank], [3 as const, bank]]) }; }

test('V10 documented structural reduction preserves all requested levels under 500 configs', () => { assert.equal(v10TheoreticalConfigurationCount(), 1728); const configs = createV10Configs(); assert.equal(configs.length, 432); assert.ok(configs.every((value) => ['NO_REGIME_FILTER', 'ANY_EXCEPT_OPPOSITE'].includes(value.regimeMode))); });
test('BANK NIFTY impulse is completed no later than delayed NIFTY confirmation', () => { const value = session(); const signals = generateV10Signals([value], config(), indicators(value)); assert.ok(signals.length > 0); signals.forEach((signal) => { assert.ok(signal.bankImpulseCompletedAt <= signal.timestamp); assert.equal(signal.direction, 'CE'); assert.equal(signal.leadTimeMinutes, 1); }); assertV10NoLookAhead(signals); });
test('same-bar uses only synchronized completed inputs and a future regime is rejected', () => { const value = session(); const signals = generateV10Signals([value], config({ confirmationDelayBars: 0 }), indicators(value)); assert.ok(signals.every((signal) => signal.leadTimeMinutes === 0)); assert.throws(() => assertV10NoLookAhead([{ ...signals[0], regimeAvailableAt: new Date(signals[0].timestamp.getTime() + 1) }])); });
test('missing BANK NIFTY alignment fails safely without an invented signal', () => { const value = session(9); const signals = generateV10Signals([value], config(), indicators(value)); assert.equal(signals.length, 0); });
test('micro-break excludes the current candle and cooldown plus episode suppression prevent repeats', () => { const value = session(); const signals = generateV10Signals([value], config({ confirmation: 'MICRO_BREAK_2', confirmationDelayBars: 1 }), indicators(value)); assert.ok(signals.every((signal, index) => index === 0 || signal.timestamp.getTime() - signals[index - 1].timestamp.getTime() >= signal.cooldownMinutes * 60_000)); assert.ok(signals.length <= 1); });
test('sessions reset lead-lag state and CE/PE state remains directionally isolated', () => { const first = session(); const second = session(); second.date = '2026-03-03'; const signals = generateV10Signals([first, second], config(), indicators(first)); assert.ok(signals.every((signal) => signal.direction === 'CE')); assert.equal(new Set(signals.map((signal) => signal.date)).size, 2); });
test('TRAIN_VALIDATION_ONLY rejects FINAL_HOLDOUT dates', () => { const dates = Array.from({ length: 104 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`); const manifest = new ResearchSplitService().createManifest(dates, { instrumentKey: 'NSE_INDEX|Nifty 50' }); const final = manifest.sessions.find((row) => row.split === 'FINAL_HOLDOUT')!; assert.throws(() => new ResearchSplitService().assertOutcomeAccess(manifest, [final.tradingDate], 'TRAIN_VALIDATION_ONLY')); });
