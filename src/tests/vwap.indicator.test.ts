import assert from 'node:assert/strict';
import test from 'node:test';
import VwapIndicator from '../modules/indicators/indicators/vwap.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new VwapIndicator();

function createCandle(
  timestamp: string,
  high: number,
  low: number,
  close: number,
  volume: number
): Candle {
  return {
    timestamp: new Date(timestamp),
    open: close,
    high,
    low,
    close,
    volume,
  };
}

test('calculates VWAP for a known intraday series', () => {
  const candles = [
    createCandle('2026-08-03T09:15:00+05:30', 12, 9, 12, 2),
    createCandle('2026-08-03T09:16:00+05:30', 18, 12, 15, 1),
  ];
  const result = indicator.calculate(candles, { type: IndicatorType.VWAP });

  assert.deepEqual(result.values.map((entry) => entry.value), [11, 37 / 3]);
});

test('calculates VWAP for a single candle', () => {
  const result = indicator.calculate(
    [createCandle('2026-08-03T09:15:00+05:30', 15, 9, 12, 4)],
    { type: IndicatorType.VWAP }
  );

  assert.deepEqual(result.values.map((entry) => entry.value), [12]);
});

test('uses volume weighting across candles', () => {
  const result = indicator.calculate(
    [
      createCandle('2026-08-03T09:15:00+05:30', 10, 10, 10, 1),
      createCandle('2026-08-03T09:16:00+05:30', 20, 20, 20, 3),
    ],
    { type: IndicatorType.VWAP }
  );

  assert.deepEqual(result.values.map((entry) => entry.value), [10, 17.5]);
});

test('resets cumulative VWAP at the IST trading-date boundary', () => {
  const result = indicator.calculate(
    [
      createCandle('2026-08-03T15:29:00+05:30', 10, 10, 10, 1),
      createCandle('2026-08-04T09:15:00+05:30', 20, 20, 20, 1),
    ],
    { type: IndicatorType.VWAP }
  );

  assert.deepEqual(result.values.map((entry) => entry.value), [10, 20]);
});

test('returns null while cumulative volume is zero', () => {
  const result = indicator.calculate(
    [
      createCandle('2026-08-03T09:15:00+05:30', 10, 10, 10, 0),
      createCandle('2026-08-03T09:16:00+05:30', 20, 20, 20, 2),
    ],
    { type: IndicatorType.VWAP }
  );

  assert.deepEqual(result.values.map((entry) => entry.value), [null, 20]);
});

test('rejects invalid candle values', () => {
  assert.throws(
    () =>
      indicator.calculate(
        [createCandle('2026-08-03T09:15:00+05:30', 10, 12, 11, 1)],
        { type: IndicatorType.VWAP }
      ),
    /invalid candle/
  );
  assert.throws(
    () =>
      indicator.calculate(
        [createCandle('2026-08-03T09:15:00+05:30', 10, 10, 10, -1)],
        { type: IndicatorType.VWAP }
      ),
    /invalid candle/
  );
});

test('does not mutate input candles', () => {
  const candles = [
    createCandle('2026-08-03T09:15:00+05:30', 10, 9, 9.5, 1),
    createCandle('2026-08-03T09:16:00+05:30', 11, 10, 10.5, 2),
  ];
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, { type: IndicatorType.VWAP });

  assert.deepEqual(candles, originalCandles);
});
