import assert from 'node:assert/strict';
import test from 'node:test';
import SmaIndicator from '../modules/indicators/indicators/sma.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new SmaIndicator();

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

test('calculates SMA for a known close-price series', () => {
  const candles = createCandles([1, 2, 3, 4, 5]);
  const result = indicator.calculate(candles, { type: IndicatorType.SMA, period: 3 });

  assert.equal(result.type, IndicatorType.SMA);
  assert.equal(result.period, 3);
  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [2, 3, 4]
  );
  assert.equal(result.values[0].timestamp, candles[2].timestamp);
});

test('calculates SMA with period 1', () => {
  const candles = createCandles([10, 20, 30]);
  const result = indicator.calculate(candles, { type: IndicatorType.SMA, period: 1 });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [10, 20, 30]
  );
});

test('rejects insufficient candles', () => {
  assert.throws(
    () => indicator.calculate(createCandles([1, 2]), { type: IndicatorType.SMA, period: 3 }),
    /requires at least 3 candles/
  );
});

test('rejects invalid periods', () => {
  const candles = createCandles([1, 2, 3]);

  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.SMA, period: 0 }),
    /positive integer/
  );
  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.SMA, period: -1 }),
    /positive integer/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles([1, 2, 3]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, { type: IndicatorType.SMA, period: 2 });

  assert.deepEqual(candles, originalCandles);
});
