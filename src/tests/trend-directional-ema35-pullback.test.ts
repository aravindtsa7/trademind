import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesTrendDirectionalEma35Pullback } from './helpers/trend-directional-ema35-pullback';

test('TREND_UP CE pullback preserves the existing EMA35 low-proximity and RSI_GT semantics', () => {
  const base = { direction: 'UP' as const, close: 100.2, high: 100.5, low: 99.9, ema35: 100, rsi: 56, proximity: 0.10, rsiFilter: 'RSI_GT_55' as const };
  assert.equal(matchesTrendDirectionalEma35Pullback(base), true);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, rsi: 55 }), false);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, low: 99.8 }), false);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, close: 100 }), false);
});

test('TREND_DOWN PE pullback preserves the existing EMA35 high-proximity and RSI_LT semantics', () => {
  const base = { direction: 'DOWN' as const, close: 99.8, high: 100.1, low: 99.5, ema35: 100, rsi: 34, proximity: 0.10, rsiFilter: 'RSI_LT_35' as const };
  assert.equal(matchesTrendDirectionalEma35Pullback(base), true);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, rsi: 35 }), false);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, high: 100.2 }), false);
  assert.equal(matchesTrendDirectionalEma35Pullback({ ...base, close: 100 }), false);
});
