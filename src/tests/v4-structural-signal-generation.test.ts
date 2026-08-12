import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { Candle } from '../modules/indicators/types';
import { CrossSessionPreparedSession } from './helpers/cross-session-indicator-warmup';
import {
  assertV4NoLookAhead,
  createV4Configs,
  generateV4Signals,
  V4IndicatorContext,
} from './helpers/v4-structural-signal-generation';

const start = new Date('2026-03-02T09:15:00+05:30').getTime();

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { timestamp: new Date(start + index * 60_000), open, high, low, close, volume: 100 };
}

function session(candles: Candle[], regime = AdaptivePrimaryMarketRegime.TREND_UP): CrossSessionPreparedSession {
  const values = new Map(candles.map((value) => [value.timestamp.getTime(), 55]));
  const frame = { minutes: 1 as const, candles, allCandles: candles, ema15: new Map(candles.map((value) => [value.timestamp.getTime(), 101])), ema35: new Map(candles.map((value) => [value.timestamp.getTime(), 100])), rsi14: values };
  return {
    date: '2026-03-02',
    oneMinute: candles,
    frames: { 1: frame, 2: { ...frame, minutes: 2 }, 3: { ...frame, minutes: 3 }, 5: { ...frame, minutes: 5 } },
    regimePoints: [{ availableAt: new Date(start), regime }],
    readiness: { at0915: true, at0920: true, at0930: true },
  };
}

function indicators(candles: Candle[]): V4IndicatorContext {
  const vwap = new Map(candles.map((value) => [value.timestamp.getTime(), 100]));
  const atr = new Map(candles.map((value) => [value.timestamp.getTime(), 1]));
  return { vwapByFrame: new Map([[1, vwap], [2, vwap], [3, vwap], [5, vwap]]), atr14ByFrame: new Map([[1, atr], [2, atr], [3, atr], [5, atr]]) };
}

test('opening-range breakout/retest signals only after a completed breakout and a later completed retest', () => {
  const candles = Array.from({ length: 10 }, (_, index) => candle(index, 99.5, 100, 99, 99.8));
  candles.push(candle(10, 100, 101, 100.5, 100.5));
  candles.push(candle(11, 100.3, 100.7, 100.05, 100.4));
  const config = createV4Configs().OPENING_RANGE.find((value) => value.timeframe === 1 && value.rangeMinutes === 10 && value.setup === 'BREAKOUT_RETEST_UP_CE' && value.breakoutBufferPercent === 0.05 && value.retestBufferPercent === 0.05 && value.cooldownMinutes === 0);
  assert.ok(config);
  const signals = generateV4Signals([session(candles)], config, indicators(candles));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'CE');
  assert.equal(signals[0].timestamp.getTime(), candles[11].timestamp.getTime() + 60_000);
});

test('VWAP first-pullback mode retains the first completed reclaim and suppresses repeated pullbacks', () => {
  const candles = [
    candle(0, 100.8, 101.2, 100.7, 101),
    candle(1, 100.8, 101, 100.02, 100.4),
    candle(2, 100.8, 101.2, 100.7, 101),
    candle(3, 100.8, 101, 100.02, 100.4),
  ];
  const config = createV4Configs().VWAP.find((value) => value.timeframe === 1 && value.direction === 'CE' && value.proximityPercent === 0.05 && value.confirmation === 'NONE' && value.pullbackMode === 'FIRST_PULLBACK' && value.cooldownMinutes === 0);
  assert.ok(config);
  const signals = generateV4Signals([session(candles)], config, indicators(candles));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].timestamp.getTime(), candles[1].timestamp.getTime() + 60_000);
});

test('compression-to-expansion requires only completed prior bars and can apply regime alignment', () => {
  const candles = [
    candle(0, 99.5, 100, 99, 99.8),
    candle(1, 99.7, 100, 99.1, 99.8),
    candle(2, 99.6, 100, 99.2, 99.9),
    candle(3, 99.8, 101.5, 99.8, 101.3),
  ];
  const config = createV4Configs().MOMENTUM_EXPANSION.find((value) => value.timeframe === 1 && value.direction === 'CE' && value.compressionBars === 3 && value.bodyAtr === 0.75 && value.breakoutAtr === 0.1 && value.requireVwapAlignment && value.requirePrimaryRegimeAlignment && value.cooldownMinutes === 0);
  assert.ok(config);
  const signals = generateV4Signals([session(candles)], config, indicators(candles));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].timestamp.getTime(), candles[3].timestamp.getTime() + 60_000);
});

test('V4 grids remain bounded and no-look-ahead rejects a late regime value', () => {
  const configs = createV4Configs();
  assert.equal(configs.OPENING_RANGE.length, 864);
  assert.equal(configs.VWAP.length, 576);
  assert.equal(configs.MOMENTUM_EXPANSION.length, 1024);
  assert.throws(
    () => assertV4NoLookAhead([{ family: 'VWAP', configKey: 'test', date: '2026-03-02', timestamp: new Date(start), spotPrice: 100, direction: 'CE', regimeAvailableAt: new Date(start + 60_000) }]),
    /look-ahead/,
  );
});
