import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
import { Candle } from '../../indicators/types';
import {
  V8_STRATEGY_ID,
  assertV8NoLookAhead,
  buildV8StructuralLevels,
  createV8BullishReclaimConfigs,
  generateV8BullishReclaimSignals,
  V8PreparedSession,
} from './v8-bullish-reclaim.signal';

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
