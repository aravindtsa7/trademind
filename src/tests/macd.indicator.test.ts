import assert from 'node:assert/strict';
import test from 'node:test';
import MacdIndicator from '../modules/indicators/indicators/macd.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new MacdIndicator();
const config = {
  type: IndicatorType.MACD,
  fastPeriod: 3,
  slowPeriod: 5,
  signalPeriod: 3,
} as const;

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

test('calculates MACD for a known close-price series', () => {
  const candles = createCandles([1, 2, 1, 3, 2, 4, 3, 5, 4, 6]);
  const result = indicator.calculate(candles, config);

  assert.equal(result.values.length, 4);
  assert.equal(result.values[0].timestamp, candles[6].timestamp);
  assert.deepEqual(
    result.values.map((entry) => Number(entry.macd.toFixed(8))),
    [0.33194444, 0.55115741, 0.36570216, 0.57626672]
  );
});

test('calculates the expected MACD line', () => {
  const result = indicator.calculate(createCandles([1, 2, 1, 3, 2, 4, 3, 5, 4, 6]), config);

  assert.equal(Number(result.values[0].macd.toFixed(8)), 0.33194444);
});

test('calculates the expected signal line', () => {
  const result = indicator.calculate(createCandles([1, 2, 1, 3, 2, 4, 3, 5, 4, 6]), config);

  assert.equal(Number(result.values[0].signal.toFixed(8)), 0.37453704);
});

test('calculates the expected histogram', () => {
  const result = indicator.calculate(createCandles([1, 2, 1, 3, 2, 4, 3, 5, 4, 6]), config);

  assert.equal(Number(result.values[0].histogram.toFixed(8)), -0.04259259);
});

test('rejects an invalid fast and slow period relationship', () => {
  const candles = createCandles([1, 2, 3, 4, 5, 6, 7]);

  assert.throws(
    () => indicator.calculate(candles, { ...config, fastPeriod: 5, slowPeriod: 5 }),
    /fastPeriod must be less than slowPeriod/
  );
});

test('rejects invalid periods', () => {
  const candles = createCandles([1, 2, 3, 4, 5, 6, 7]);

  assert.throws(() => indicator.calculate(candles, { ...config, fastPeriod: 0 }), /positive integer/);
  assert.throws(() => indicator.calculate(candles, { ...config, slowPeriod: 1.5 }), /positive integer/);
  assert.throws(() => indicator.calculate(candles, { ...config, signalPeriod: -1 }), /positive integer/);
});

test('rejects insufficient candles to produce a signal value', () => {
  assert.throws(
    () => indicator.calculate(createCandles([1, 2, 3, 4, 5, 6]), config),
    /requires at least 7 candles/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles([1, 2, 1, 3, 2, 4, 3]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, config);

  assert.deepEqual(candles, originalCandles);
});
