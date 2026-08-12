import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { Candle } from '../modules/indicators/types';
import { CrossSessionPreparedSession } from './helpers/cross-session-indicator-warmup';
import {
  assertV5NoLookAhead,
  createV5ScalpingConfigs,
  generateV5Signals,
  prepareV5IndicatorContext,
  V5Indicators,
} from './helpers/v5-nifty-scalping-signal-generation';

const start = new Date('2026-03-02T09:15:00+05:30').getTime();

function bar(index: number, open: number, high: number, low: number, close: number): Candle {
  return { timestamp: new Date(start + index * 2 * 60_000), open, high, low, close, volume: 100 };
}

function prepared(candles: Candle[], regime: AdaptivePrimaryMarketRegime): CrossSessionPreparedSession {
  const frame = { minutes: 2 as const, candles, allCandles: candles, ema15: new Map<number, number>(), ema35: new Map<number, number>(), rsi14: new Map<number, number>() };
  return {
    date: '2026-03-02', oneMinute: candles,
    frames: { 1: { ...frame, minutes: 1 }, 2: frame, 3: { ...frame, minutes: 3 }, 5: { ...frame, minutes: 5 } },
    regimePoints: [{ availableAt: new Date(start), regime }],
    readiness: { at0915: true, at0920: true, at0930: true },
  };
}

function indicatorContext(candles: Candle[], rsi: number): ReadonlyMap<string, V5Indicators> {
  return new Map([['2026-03-02', {
    ema20: new Map(candles.map((value) => [value.timestamp.getTime(), 100])),
    rsi14: new Map(candles.map((value) => [value.timestamp.getTime(), rsi])),
    atr14: new Map(candles.map((value) => [value.timestamp.getTime(), 1])),
  }]]);
}

test('V5 grid remains bounded and symmetrical between CE and PE', () => {
  const configs = createV5ScalpingConfigs();
  assert.equal(configs.length, 2_592);
  assert.equal(configs.filter((config) => config.direction === 'CE').length, 1_296);
  assert.equal(configs.filter((config) => config.direction === 'PE').length, 1_296);
});

test('V5 CE uses a completed 2m candle and an already-available TREND_UP regime', () => {
  const candles = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 101.4, 100, 101.2)];
  const config = createV5ScalpingConfigs().find((value) => value.direction === 'CE' && value.ema20ProximityPercent === 0.1 && value.rsiThreshold === 50 && value.bodyAtrMinimum === 0.5 && value.pullbackLookbackBars === 1 && value.confirmation === 'TREND_CLOSE' && value.cooldownMinutes === 0);
  assert.ok(config);
  const signals = generateV5Signals([prepared(candles, AdaptivePrimaryMarketRegime.TREND_UP)], config, indicatorContext(candles, 61));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'CE');
  assert.equal(signals[0].timestamp.getTime(), candles[1].timestamp.getTime() + 2 * 60_000);
  assertV5NoLookAhead(signals);
});

test('V5 PE is regime and RSI directional, and its cooldown prevents duplicate 2m entries', () => {
  const candles = [
    bar(0, 100, 100.1, 99.9, 100),
    bar(1, 100, 100, 98.8, 99),
    bar(2, 100, 100.1, 99.9, 100),
    bar(3, 100, 100, 98.7, 99),
  ];
  const config = createV5ScalpingConfigs().find((value) => value.direction === 'PE' && value.ema20ProximityPercent === 0.1 && value.rsiThreshold === 50 && value.bodyAtrMinimum === 0.5 && value.pullbackLookbackBars === 1 && value.confirmation === 'TREND_CLOSE' && value.cooldownMinutes === 5);
  assert.ok(config);
  const trendDown = generateV5Signals([prepared(candles, AdaptivePrimaryMarketRegime.TREND_DOWN)], config, indicatorContext(candles, 39));
  assert.equal(trendDown.length, 1);
  assert.equal(trendDown[0].timestamp.getTime(), candles[1].timestamp.getTime() + 2 * 60_000);
  const trendUp = generateV5Signals([prepared(candles, AdaptivePrimaryMarketRegime.TREND_UP)], config, indicatorContext(candles, 39));
  assert.equal(trendUp.length, 0);
});

test('V5 no-look-ahead rejects a regime not available at the completed entry timestamp', () => {
  assert.throws(() => assertV5NoLookAhead([{
    configKey: 'test', date: '2026-03-02', direction: 'CE', spotPrice: 100,
    entryCandleStartedAt: new Date(start), timestamp: new Date(start + 2 * 60_000),
    regimeAvailableAt: new Date(start + 2 * 60_000 + 1),
  }]), /look-ahead/);
});

test('V5 indicator context is prepared once per target session', () => {
  const candles = Array.from({ length: 30 }, (_, index) => bar(index, 100 + index, 101 + index, 99 + index, 100.5 + index));
  const session = prepared(candles, AdaptivePrimaryMarketRegime.TREND_UP);
  const context = prepareV5IndicatorContext([session], new IndicatorEngineService());
  assert.equal(context.size, 1);
  assert.ok(context.get(session.date)?.ema20.has(candles.at(-1)!.timestamp.getTime()));
});
