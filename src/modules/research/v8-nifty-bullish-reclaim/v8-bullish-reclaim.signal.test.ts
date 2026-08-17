import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
import { Candle } from '../../indicators/types';
import {
  V8_STRATEGY_ID,
  assertV8NoLookAhead,
  buildV8StructuralLevels,
  createV8BullishReclaimConfigs,
  evaluateV8BullishReclaimFrames,
  generateV8BullishReclaimSignals,
  V8PreparedSession,
} from './v8-bullish-reclaim.signal';
import { isV8CompletedUnderlyingCandleEvent, V8ShadowRuntimeCounters } from '../../adaptive-intraday/services/v8-bullish-reclaim-shadow.service';

const ist = (date: string, minute: number): Date => new Date(`${date}T09:${String(15 + minute).padStart(2, '0')}:00+05:30`);
function candle(timestamp: Date, open: number, high: number, low: number, close: number): Candle { return { timestamp, open, high, low, close, volume: 0 }; }
function session(date: string, candles2: Candle[], regime = AdaptivePrimaryMarketRegime.TREND_UP, regimeAvailableAt = candles2[0].timestamp): V8PreparedSession {
  const rsi = new Map(candles2.map((value) => [value.timestamp.getTime(), 55]));
  const frame = { candles: candles2, rsi14: rsi };
  return { date, oneMinute: candles2, frames: { 2: frame, 3: frame }, regimePoints: [{ availableAt: new Date(regimeAvailableAt.getTime()), regime }] };
}
function atr(candles: Candle[]): ReadonlyMap<number, number> { return new Map(candles.map((value) => [value.timestamp.getTime(), 1])); }

test('grid size is explicit and bounded', () => {
  assert.equal(createV8BullishReclaimConfigs().length, 4608);
  assert.equal(new Set(createV8BullishReclaimConfigs().map((config) => config.timeframe)).size, 2);
});

test('PDH reclaim requires a prior interaction and emits CE at completed candle time', () => {
  const prior = session('2026-03-01', [candle(ist('2026-03-01', 0), 99, 101, 99, 100)]);
  const currentCandles = [
    candle(ist('2026-03-02', 0), 99.8, 100, 99, 99.5),
    candle(ist('2026-03-02', 2), 99.5, 101.5, 99.5, 101.2),
  ];
  const current = session('2026-03-02', currentCandles);
  const config = createV8BullishReclaimConfigs().find((value) => value.timeframe === 2 && value.levelFamily === 'PDH' && value.reclaimBufferAtr === 0 && value.bullishBodyAtr === 0.25 && value.rsiMinimum === 'NONE' && value.regimeMode === 'NO_REGIME_FILTER' && value.cooldownMinutes === 5);
  assert.ok(config);
  const signals = generateV8BullishReclaimSignals([prior, current], config, { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(currentCandles)], [3, atr(currentCandles)]]) });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].strategyId, V8_STRATEGY_ID);
  assert.equal(signals[0].direction, 'CE');
  assert.equal(signals[0].timestamp.getTime(), currentCandles[1].timestamp.getTime() + 2 * 60_000);
});

test('same candle interaction and reclaim cannot self-confirm', () => {
  const prior = session('2026-03-01', [candle(ist('2026-03-01', 0), 99, 101, 99, 100)]);
  const currentCandles = [candle(ist('2026-03-02', 0), 99, 101.5, 99, 101.2)];
  const current = session('2026-03-02', currentCandles);
  const config = createV8BullishReclaimConfigs().find((value) => value.timeframe === 2 && value.levelFamily === 'PDH' && value.rsiMinimum === 'NONE' && value.regimeMode === 'NO_REGIME_FILTER');
  assert.ok(config);
  assert.equal(generateV8BullishReclaimSignals([prior, current], config, { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(currentCandles)], [3, atr(currentCandles)]]) }).length, 0);
});

test('TREND_UP_ONLY blocks non-up regimes and any-except mode allows SIDEWAYS', () => {
  const prior = session('2026-03-01', [candle(ist('2026-03-01', 0), 99, 101, 99, 100)]);
  const candles = [candle(ist('2026-03-02', 0), 99.8, 100, 99, 99.5), candle(ist('2026-03-02', 2), 99.5, 101.5, 99.5, 101.2)];
  const sideways = session('2026-03-02', candles, AdaptivePrimaryMarketRegime.SIDEWAYS);
  const configs = createV8BullishReclaimConfigs().filter((value) => value.timeframe === 2 && value.levelFamily === 'PDH' && value.rsiMinimum === 'NONE' && value.cooldownMinutes === 5);
  const context = { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(candles)], [3, atr(candles)]]) };
  assert.equal(generateV8BullishReclaimSignals([prior, sideways], configs.find((value) => value.regimeMode === 'TREND_UP_ONLY')!, context).length, 0);
  assert.equal(generateV8BullishReclaimSignals([prior, sideways], configs.find((value) => value.regimeMode === 'ANY_EXCEPT_TREND_DOWN')!, context).length, 1);
});

test('late regime availability is rejected as lookahead', () => {
  assert.throws(() => assertV8NoLookAhead([{ strategyId: V8_STRATEGY_ID, configKey: 'x', date: '2026-03-02', timestamp: new Date('2026-03-02T09:20:00+05:30'), direction: 'CE', levelFamily: 'PDH', structuralLevel: 100, spotPrice: 101, atr14: 1, body: 1, bodyAtr: 1, reclaimBufferAtr: 0, rsi14: 55, regime: AdaptivePrimaryMarketRegime.TREND_UP, regimeAvailableAt: new Date('2026-03-02T09:21:00+05:30') }]), /look-ahead/);
});

test('opening-range high is fixed from the first completed 15 minutes', () => {
  const opening = Array.from({ length: 15 }, (_, index) => candle(ist('2026-03-02', index), 99, index === 14 ? 105 : 100 + index / 100, 98, 99));
  const after = candle(ist('2026-03-02', 15), 99, 102, 98, 100);
  const current = session('2026-03-02', [after]);
  current.oneMinute = opening;
  const levels = buildV8StructuralLevels(current, 2, 'OR15_HIGH');
  assert.equal(levels.get(after.timestamp.getTime()), 105);
});

test('recent swing resistance uses only prior completed candles', () => {
  const candles = Array.from({ length: 11 }, (_, index) => candle(ist('2026-03-02', index * 2), 99, 100 + index, 98, 99));
  const current = session('2026-03-02', candles);
  const levels = buildV8StructuralLevels(current, 2, 'RECENT_SWING_HIGH');
  assert.equal(levels.get(candles[10].timestamp.getTime()), 109);
});

test('cooldown suppresses a second reclaim while allowing a re-armed episode later', () => {
  const prior = session('2026-03-01', [candle(ist('2026-03-01', 0), 99, 101, 99, 100)]);
  const candles = [
    candle(ist('2026-03-02', 0), 99.8, 100, 99, 99.5),
    candle(ist('2026-03-02', 2), 99.5, 101.5, 99.5, 101.2),
    candle(ist('2026-03-02', 4), 99.8, 100, 99, 99.5),
    candle(ist('2026-03-02', 6), 99.5, 101.5, 99.5, 101.2),
    candle(ist('2026-03-02', 12), 99.8, 100, 99, 99.5),
    candle(ist('2026-03-02', 14), 99.5, 101.5, 99.5, 101.2),
  ];
  const current = session('2026-03-02', candles);
  const config = createV8BullishReclaimConfigs().find((value) => value.timeframe === 2 && value.levelFamily === 'PDH' && value.rsiMinimum === 'NONE' && value.regimeMode === 'NO_REGIME_FILTER' && value.cooldownMinutes === 5);
  assert.ok(config);
  const signals = generateV8BullishReclaimSignals([prior, current], config, { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(candles)], [3, atr(candles)]]) });
  assert.deepEqual(signals.map((signal) => signal.timestamp.getTime()), [candles[1], candles[5]].map((value) => value.timestamp.getTime() + 2 * 60_000));
});

function frozenDiagnosticConfig() {
  const config = createV8BullishReclaimConfigs().find((value) => value.timeframe === 2 && value.levelFamily === 'PDH' && value.reclaimBufferAtr === .1 && value.bullishBodyAtr === .25 && value.rsiMinimum === 50 && value.regimeMode === 'NO_REGIME_FILTER' && value.cooldownMinutes === 5);
  assert.ok(config); return config;
}
function diagnosticSession(candles: Candle[], rsi: readonly number[]): V8PreparedSession {
  const frame = { candles, rsi14: new Map(candles.map((value, index) => [value.timestamp.getTime(), rsi[index] ?? 55])) };
  return { date: '2026-03-02', oneMinute: candles, frames: { 2: frame, 3: frame }, regimePoints: [] };
}
function diagnosticPrior(): V8PreparedSession { return session('2026-03-01', [candle(ist('2026-03-01', 0), 99, 100, 98, 99)]); }
function diagnosticEvaluations(candles: Candle[], rsi = candles.map(() => 55)) {
  return evaluateV8BullishReclaimFrames([diagnosticPrior(), diagnosticSession(candles, rsi)], frozenDiagnosticConfig(), { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(candles)], [3, atr(candles)]]) })
    .filter((value) => value.date === '2026-03-02');
}
function diagnosticSignals(candles: Candle[], rsi = candles.map(() => 55)) {
  return generateV8BullishReclaimSignals([diagnosticPrior(), diagnosticSession(candles, rsi)], frozenDiagnosticConfig(), { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(candles)], [3, atr(candles)]]) });
}

test('completed V8 2m frames expose frozen primary blocking reasons without changing signal output', () => {
  const interaction = candle(ist('2026-03-02', 0), 100, 100, 99, 99.8);
  const reclaimBlocked = candle(ist('2026-03-02', 2), 99.5, 100.05, 99.5, 100.05);
  const reclaim = diagnosticEvaluations([interaction, reclaimBlocked]);
  assert.equal(reclaim[0].reason, 'INTERACTION_ARMED_WAITING_FOR_RECLAIM');
  assert.equal(reclaim[1].reason, 'RECLAIM_THRESHOLD_NOT_MET');
  assert.equal(reclaim[1].timestamp.getTime(), reclaimBlocked.timestamp.getTime() + 2 * 60_000);

  const bodyBlocked = candle(ist('2026-03-02', 2), 100.1, 100.2, 100.0, 100.2);
  assert.equal(diagnosticEvaluations([interaction, bodyBlocked]).at(-1)?.reason, 'BULLISH_BODY_BELOW_THRESHOLD');

  const valid = candle(ist('2026-03-02', 2), 99.8, 100.6, 99.8, 100.4);
  assert.equal(diagnosticEvaluations([interaction, valid], [55, 50]).at(-1)?.reason, 'RSI_NOT_ABOVE_THRESHOLD');
  assert.equal(diagnosticEvaluations([interaction, valid]).at(-1)?.reason, 'SIGNAL');
});

test('V8 frozen gate boundaries retain the intended strict and inclusive signal semantics', () => {
  const interaction = candle(ist('2026-03-02', 0), 100, 100, 99, 99.8);
  const belowReclaim = candle(ist('2026-03-02', 2), 99.5, 100.099, 99.5, 100.099);
  const exactReclaim = candle(ist('2026-03-02', 2), 99.8, 100.1, 99.8, 100.1);
  const belowBody = candle(ist('2026-03-02', 2), 99.851, 100.1, 99.8, 100.1);
  const exactBody = candle(ist('2026-03-02', 2), 99.85, 100.1, 99.8, 100.1);

  // Frozen PDH is 100, ATR is 1: the reclaim level is exactly 100.10.
  assert.deepEqual(
    diagnosticEvaluations([interaction, belowReclaim]).map((value) => [value.signal, value.reason]),
    [[false, 'INTERACTION_ARMED_WAITING_FOR_RECLAIM'], [false, 'RECLAIM_THRESHOLD_NOT_MET']],
  );
  assert.equal(diagnosticSignals([interaction, belowReclaim]).length, 0);

  assert.equal(diagnosticEvaluations([interaction, exactReclaim]).at(-1)?.reason, 'SIGNAL');
  assert.equal(diagnosticSignals([interaction, exactReclaim]).length, 1);

  assert.equal(diagnosticEvaluations([interaction, belowBody]).at(-1)?.reason, 'BULLISH_BODY_BELOW_THRESHOLD');
  assert.equal(diagnosticSignals([interaction, belowBody]).length, 0);
  assert.equal(diagnosticEvaluations([interaction, exactBody]).at(-1)?.reason, 'SIGNAL');
  assert.equal(diagnosticSignals([interaction, exactBody]).length, 1);

  assert.equal(diagnosticEvaluations([interaction, exactReclaim], [55, 50]).at(-1)?.reason, 'RSI_NOT_ABOVE_THRESHOLD');
  assert.equal(diagnosticSignals([interaction, exactReclaim], [55, 50]).length, 0);
  assert.equal(diagnosticEvaluations([interaction, exactReclaim], [55, 50.0001]).at(-1)?.reason, 'SIGNAL');
  assert.equal(diagnosticSignals([interaction, exactReclaim], [55, 50.0001]).length, 1);
});

test('V8 diagnostics expose every completed frame, including unavailable PDH and unarmed frames', () => {
  const currentOnly = diagnosticSession([candle(ist('2026-03-02', 0), 99.8, 100.2, 99.5, 100.1)], [55]);
  const noPdh = evaluateV8BullishReclaimFrames([currentOnly], frozenDiagnosticConfig(), { atr14ByFrame: new Map<2 | 3, ReadonlyMap<number, number>>([[2, atr(currentOnly.frames[2].candles)], [3, atr(currentOnly.frames[3].candles)]]) });
  assert.deepEqual(noPdh.map((value) => [value.signal, value.reason]), [[false, 'PDH_UNAVAILABLE']]);

  const noInteraction = candle(ist('2026-03-02', 0), 100.2, 100.6, 100.2, 100.5);
  const evaluations = diagnosticEvaluations([noInteraction]);
  assert.equal(evaluations.length, 1);
  assert.deepEqual(evaluations.map((value) => [value.signal, value.reason]), [[false, 'AWAITING_PDH_INTERACTION']]);
  assert.equal(diagnosticSignals([noInteraction]).length, 0);
});

test('V8 diagnostic cooldown and runtime counters are deterministic and orderless', () => {
  const candles = [
    candle(ist('2026-03-02', 0), 100, 100, 99, 99.8),
    candle(ist('2026-03-02', 2), 99.8, 100.6, 99.8, 100.4),
    candle(ist('2026-03-02', 4), 100, 100, 99, 99.8),
    candle(ist('2026-03-02', 6), 99.8, 100.6, 99.8, 100.4),
  ];
  assert.equal(diagnosticEvaluations(candles).at(-1)?.reason, 'COOLDOWN');
  const counters = new V8ShadowRuntimeCounters(); counters.markCompleted2m(); counters.markCompleted2m(); counters.markSignal(); counters.markClosed();
  assert.deepEqual(counters.snapshot(), { completed2m: 2, signals: 1, closed: 1 });
  assert.equal(Object.isFrozen(counters.snapshot()), true);
  const completed = { instrumentKey: 'NSE_INDEX|Nifty 50', completed: true, candleTime: new Date('2026-08-17T04:00:00Z'), open: 100, high: 101, low: 99, close: 100 };
  assert.equal(isV8CompletedUnderlyingCandleEvent(completed, 'NSE_INDEX|Nifty 50'), true);
  assert.equal(isV8CompletedUnderlyingCandleEvent({ ...completed, completed: false }, 'NSE_INDEX|Nifty 50'), false);
});
