import assert from 'node:assert/strict';
import test from 'node:test';
import RsiIndicator from '../modules/indicators/indicators/rsi.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new RsiIndicator();

function createCandles(closes: number[]): Candle[] {
  const startTime = new Date('2026-08-03T09:15:00+05:30').getTime();

  return closes.map((close, index) => ({
    timestamp: new Date(startTime + index * 60_000),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

test('calculates Wilder RSI for a known close-price series', () => {
  const candles = createCandles([1, 2, 1, 2]);
  const result = indicator.calculate(candles, { type: IndicatorType.RSI, period: 2 });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [50, 75]
  );
  assert.equal(result.values[1].timestamp, candles[3].timestamp);
});

test('returns 100 for a sequence of gains', () => {
  const result = indicator.calculate(createCandles([1, 2, 3, 4]), {
    type: IndicatorType.RSI,
    period: 2,
  });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [100, 100]
  );
});

test('returns 0 for a sequence of losses', () => {
  const result = indicator.calculate(createCandles([4, 3, 2, 1]), {
    type: IndicatorType.RSI,
    period: 2,
  });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [0, 0]
  );
});

test('returns 50 for flat close prices', () => {
  const result = indicator.calculate(createCandles([5, 5, 5, 5]), {
    type: IndicatorType.RSI,
    period: 2,
  });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [50, 50]
  );
});

test('calculates RSI with period 1', () => {
  const result = indicator.calculate(createCandles([1, 2, 1, 3]), {
    type: IndicatorType.RSI,
    period: 1,
  });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [100, 0, 100]
  );
});

test('rejects insufficient candles', () => {
  assert.throws(
    () => indicator.calculate(createCandles([1, 2]), { type: IndicatorType.RSI, period: 2 }),
    /requires at least 3 candles/
  );
});

test('rejects invalid periods', () => {
  const candles = createCandles([1, 2, 3]);

  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.RSI, period: 0 }),
    /positive integer/
  );
  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.RSI, period: 1.5 }),
    /positive integer/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles([1, 2, 3, 2]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, { type: IndicatorType.RSI, period: 2 });

  assert.deepEqual(candles, originalCandles);
});
