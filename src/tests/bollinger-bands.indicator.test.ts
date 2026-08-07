import assert from 'node:assert/strict';
import test from 'node:test';
import BollingerBandsIndicator from '../modules/indicators/indicators/bollinger-bands.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new BollingerBandsIndicator();
const config = {
  type: IndicatorType.BOLLINGER_BANDS,
  period: 8,
  standardDeviationMultiplier: 2,
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

test('calculates the correct middle band for a known series', () => {
  const result = indicator.calculate(createCandles([2, 4, 4, 4, 5, 5, 7, 9]), config);

  assert.equal(result.values[0].middle, 5);
});

test('calculates population standard deviation for a known series', () => {
  const result = indicator.calculate(createCandles([2, 4, 4, 4, 5, 5, 7, 9]), config);

  assert.equal(result.values[0].standardDeviation, 2);
});

test('calculates the correct upper band', () => {
  const result = indicator.calculate(createCandles([2, 4, 4, 4, 5, 5, 7, 9]), config);

  assert.equal(result.values[0].upper, 9);
});

test('calculates the correct lower band', () => {
  const result = indicator.calculate(createCandles([2, 4, 4, 4, 5, 5, 7, 9]), config);

  assert.equal(result.values[0].lower, 1);
});

test('calculates zero-width bands for period 1', () => {
  const result = indicator.calculate(createCandles([10, 20]), {
    type: IndicatorType.BOLLINGER_BANDS,
    period: 1,
    standardDeviationMultiplier: 2,
  });

  assert.deepEqual(
    result.values.map(({ middle, upper, lower, standardDeviation }) => ({
      middle,
      upper,
      lower,
      standardDeviation,
    })),
    [
      { middle: 10, upper: 10, lower: 10, standardDeviation: 0 },
      { middle: 20, upper: 20, lower: 20, standardDeviation: 0 },
    ]
  );
});

test('rejects invalid periods', () => {
  const candles = createCandles([1, 2, 3]);

  assert.throws(() => indicator.calculate(candles, { ...config, period: 0 }), /positive integer/);
  assert.throws(() => indicator.calculate(candles, { ...config, period: 1.5 }), /positive integer/);
});

test('rejects invalid standard deviation multipliers', () => {
  const candles = createCandles([1, 2, 3, 4, 5, 6, 7, 8]);

  assert.throws(
    () => indicator.calculate(candles, { ...config, standardDeviationMultiplier: 0 }),
    /positive finite number/
  );
  assert.throws(
    () => indicator.calculate(candles, { ...config, standardDeviationMultiplier: Number.NaN }),
    /positive finite number/
  );
});

test('rejects insufficient candles', () => {
  assert.throws(
    () => indicator.calculate(createCandles([1, 2, 3]), config),
    /requires at least 8 candles/
  );
});

test('handles a flat-price series', () => {
  const result = indicator.calculate(createCandles([5, 5, 5, 5, 5, 5, 5, 5]), config);

  assert.deepEqual(result.values[0], {
    timestamp: new Date('2026-08-03T03:52:00.000Z'),
    middle: 5,
    upper: 5,
    lower: 5,
    standardDeviation: 0,
  });
});

test('does not mutate input candles', () => {
  const candles = createCandles([2, 4, 4, 4, 5, 5, 7, 9]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, config);

  assert.deepEqual(candles, originalCandles);
});
