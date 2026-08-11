import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveMarketRegimeInputDto } from '../dto/adaptive-market-regime.dto';
import AdaptiveMarketRegimeService from './adaptive-market-regime.service';
import {
  AdaptiveBreakoutDirection,
  AdaptivePrimaryMarketRegime,
  AdaptiveVolatilityRegime,
} from '../types/adaptive-market-regime.types';

const service = new AdaptiveMarketRegimeService({
  trendStrengthThreshold: 20,
  emaProximityPercent: 0.1,
  highVolatilityThreshold: 2,
  lowVolatilityThreshold: 0.5,
});

function input(overrides: Partial<AdaptiveMarketRegimeInputDto> = {}): AdaptiveMarketRegimeInputDto {
  return {
    timestamp: new Date('2026-08-10T04:45:00.000Z'),
    close: 100,
    ema15: 102,
    ema35: 98,
    rsi14: 60,
    adx14: 25,
    atr14: 1,
    ...overrides,
  };
}

test('classifies a confirmed upward trend', () => {
  assert.equal(service.classify(input()).primaryRegime, AdaptivePrimaryMarketRegime.TREND_UP);
});

test('classifies a confirmed downward trend', () => {
  const result = service.classify(input({ ema15: 98, ema35: 102, rsi14: 40 }));
  assert.equal(result.primaryRegime, AdaptivePrimaryMarketRegime.TREND_DOWN);
});

test('classifies SIDEWAYS from weak ADX', () => {
  assert.equal(service.classify(input({ adx14: 19.99 })).primaryRegime, AdaptivePrimaryMarketRegime.SIDEWAYS);
});

test('classifies SIDEWAYS when EMAs are within proximity', () => {
  assert.equal(service.classify(input({ ema15: 100.05, ema35: 100, adx14: 25 })).primaryRegime, AdaptivePrimaryMarketRegime.SIDEWAYS);
});

test('classifies high, low, and normal volatility independently', () => {
  assert.equal(service.classify(input({ atr14: 2 })).volatilityRegime, AdaptiveVolatilityRegime.HIGH_VOLATILITY);
  assert.equal(service.classify(input({ atr14: 0.5 })).volatilityRegime, AdaptiveVolatilityRegime.LOW_VOLATILITY);
  assert.equal(service.classify(input({ atr14: 1 })).volatilityRegime, AdaptiveVolatilityRegime.NORMAL_VOLATILITY);
});

test('identifies upward and downward breakouts without replacing the primary regime', () => {
  const up = service.classify(input({ recentHigh: 99 }));
  const down = service.classify(input({ ema15: 98, ema35: 102, rsi14: 40, recentLow: 101 }));
  assert.equal(up.breakoutDirection, AdaptiveBreakoutDirection.BREAKOUT_UP);
  assert.equal(up.primaryRegime, AdaptivePrimaryMarketRegime.TREND_UP);
  assert.equal(down.breakoutDirection, AdaptiveBreakoutDirection.BREAKOUT_DOWN);
  assert.equal(down.primaryRegime, AdaptivePrimaryMarketRegime.TREND_DOWN);
});

test('applies exact configured threshold boundaries deterministically', () => {
  const result = service.classify(input({ adx14: 20, atr14: 2, ema15: 101, ema35: 99, rsi14: 51 }));
  assert.equal(result.primaryRegime, AdaptivePrimaryMarketRegime.TREND_UP);
  assert.equal(result.volatilityRegime, AdaptiveVolatilityRegime.HIGH_VOLATILITY);
  assert.equal(service.classify(input({ ema15: 100.1, ema35: 100, adx14: 20 })).primaryRegime, AdaptivePrimaryMarketRegime.SIDEWAYS);
});

test('rejects invalid configuration and input values', () => {
  assert.throws(() => new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.1, highVolatilityThreshold: 0.5, lowVolatilityThreshold: 0.5 }), /configuration/);
  assert.throws(() => service.classify(input({ close: 0 })), /invalid market or indicator values/);
});

test('does not mutate caller input and returns independent result values', () => {
  const value = input({ recentHigh: 99 });
  const original = structuredClone(value);
  const result = service.classify(value);
  result.timestamp.setTime(0);
  result.reasons.push('changed');
  assert.deepEqual(value, original);
});
