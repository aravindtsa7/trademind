import assert from 'node:assert/strict';
import test from 'node:test';
import EmaIndicator from '../modules/indicators/indicators/ema.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new EmaIndicator();

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

test('calculates EMA for a known close-price series', () => {
  const candles = createCandles([2, 4, 6, 8, 10]);
  const result = indicator.calculate(candles, { type: IndicatorType.EMA, period: 3 });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [4, 6, 8]
  );
  assert.equal(result.values[1].timestamp, candles[3].timestamp);
});

test('uses the SMA of the first period closes as the EMA seed', () => {
  const candles = createCandles([3, 6, 9, 12]);
  const result = indicator.calculate(candles, { type: IndicatorType.EMA, period: 3 });

  assert.equal(result.values[0].value, 6);
  assert.equal(result.values[0].timestamp, candles[2].timestamp);
});

test('calculates EMA with period 1', () => {
  const candles = createCandles([10, 20, 30]);
  const result = indicator.calculate(candles, { type: IndicatorType.EMA, period: 1 });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [10, 20, 30]
  );
});

test('rejects insufficient candles', () => {
  assert.throws(
    () => indicator.calculate(createCandles([1, 2]), { type: IndicatorType.EMA, period: 3 }),
    /requires at least 3 candles/
  );
});

test('rejects invalid periods', () => {
  const candles = createCandles([1, 2, 3]);

  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.EMA, period: 0 }),
    /positive integer/
  );
  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.EMA, period: 1.5 }),
    /positive integer/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles([1, 2, 3, 4]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, { type: IndicatorType.EMA, period: 2 });

  assert.deepEqual(candles, originalCandles);
});
