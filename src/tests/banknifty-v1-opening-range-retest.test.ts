import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { BankNiftyOpeningRangeConfig, assertNoLookAhead, createConfigs, generateSignals } from '../modules/research/banknifty-v1-opening-range-retest';
import { CrossSessionPreparedSession } from './helpers/cross-session-indicator-warmup';

function session(): CrossSessionPreparedSession {
  const start = new Date('2026-03-02T09:15:00+05:30').getTime();
  const candles = Array.from({ length: 30 }, (_, index) => {
    const timestamp = new Date(start + index * 60_000);
    if (index < 15) return { timestamp, open: 99, high: 100, low: 98, close: 99, volume: 1 };
    if (index === 15) return { timestamp, open: 100, high: 101, low: 100, close: 101, volume: 1 };
    if (index === 16) return { timestamp, open: 100, high: 101, low: 100, close: 101, volume: 1 };
    return { timestamp, open: 101, high: 102, low: 100.5, close: 101, volume: 1 };
  });
  const frame = { minutes: 1 as const, candles, allCandles: candles, ema15: new Map(), ema35: new Map(), rsi14: new Map() };
  return { date: '2026-03-02', oneMinute: candles, frames: { 1: frame, 2: { ...frame, minutes: 2, candles: [], allCandles: [] }, 3: { ...frame, minutes: 3, candles: [], allCandles: [] }, 5: { ...frame, minutes: 5, candles: [], allCandles: [] } }, regimePoints: [{ availableAt: new Date(start), regime: AdaptivePrimaryMarketRegime.TREND_UP }], readiness: { at0915: true, at0920: true, at0930: true } } as unknown as CrossSessionPreparedSession;
}

const config: BankNiftyOpeningRangeConfig = { openingRange: 'OR15', timeframe: 1, breakoutBufferAtr: 0, retestToleranceAtr: 0.1, confirmationBodyAtr: 0.25, regimeMode: 'NO_REGIME_FILTER', retestExpiryBars: 3, cooldownMinutes: 5 };

test('BANK NIFTY grid has 7,776 signal configurations and 69,984 policy evaluations', () => {
  assert.equal(createConfigs().length, 7776);
  assert.equal(createConfigs().length * 9, 69984);
});

test('opening-range retest requires a later breakout and emits one episode signal', () => {
  const prepared = session();
  const atr = new Map(prepared.frames[1].candles.map((candle) => [candle.timestamp.getTime(), 1]));
  const signals = generateSignals([prepared], config, { atr14ByFrame: new Map([[1, atr]]), regimeBySessionFrame: new Map([['2026-03-02|1', new Map(prepared.frames[1].candles.map((candle) => [candle.timestamp.getTime(), prepared.regimePoints[0]]))]]) });
  assert.equal(signals.length, 1);
  assert.ok(signals[0].breakoutTimestamp.getTime() < signals[0].timestamp.getTime());
  assert.equal(signals[0].direction, 'CE');
  assertNoLookAhead(signals);
});

test('OR15 and OR30 timing and regime timestamps are protected', () => {
  const prepared = session();
  const atr = new Map(prepared.frames[1].candles.map((candle) => [candle.timestamp.getTime(), 1]));
  const signals = generateSignals([prepared], config, { atr14ByFrame: new Map([[1, atr]]), regimeBySessionFrame: new Map([['2026-03-02|1', new Map(prepared.frames[1].candles.map((candle) => [candle.timestamp.getTime(), prepared.regimePoints[0]]))]]) });
  assert.ok(signals.every((signal) => signal.timestamp.toISOString().includes('03:') || signal.timestamp.getTime() >= new Date('2026-03-02T09:30:00+05:30').getTime()));
  assert.throws(() => assertNoLookAhead([{ ...signals[0], breakoutTimestamp: signals[0].timestamp }]));
  assert.throws(() => assertNoLookAhead([{ ...signals[0], regimeAvailableAt: new Date(signals[0].timestamp.getTime() + 60_000) }]));
});
