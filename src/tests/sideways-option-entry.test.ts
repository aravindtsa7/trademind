import assert from 'node:assert/strict';
import test from 'node:test';
import { Candle } from '../modules/indicators/types';
import { matchesSidewaysOptionEntry } from './helpers/sideways-option-entry';

const timestamp = new Date('2026-08-03T09:15:00+05:30');
const candle = (open: number, high: number, low: number, close: number): Candle => ({ timestamp, open, high, low, close, volume: 1 });

test('false-breakout signals use only the current completed candle and prior range', () => {
  const prior = [candle(100, 101, 99, 100), candle(100, 102, 98, 101)];
  assert.equal(matchesSidewaysOptionEntry({ family: 'FALSE_BREAKOUT_DOWN_CE', candle: candle(99, 100, 97.8, 99), priorCandles: prior, breakThresholdPercent: 0.1, reclaimPercent: 0 }), true);
  assert.equal(matchesSidewaysOptionEntry({ family: 'FALSE_BREAKOUT_UP_PE', candle: candle(101, 102.3, 100, 102), priorCandles: prior, breakThresholdPercent: 0.1, reclaimPercent: 0 }), true);
});

test('support and resistance controls retain the prior six-bar proximity semantics', () => {
  const prior = [candle(100, 101, 99, 100), candle(100, 102, 98, 101)];
  assert.equal(matchesSidewaysOptionEntry({ family: 'SUPPORT_BOUNCE_CE', candle: candle(98.1, 99, 98, 98.08), priorCandles: prior, proximityPercent: 0.1 }), true);
  assert.equal(matchesSidewaysOptionEntry({ family: 'RESISTANCE_REJECTION_PE', candle: candle(101.9, 102, 101, 101.95), priorCandles: prior, proximityPercent: 0.1 }), true);
});
