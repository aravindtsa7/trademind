import assert from 'node:assert/strict';
import test from 'node:test';
import AtrIndicator from '../modules/indicators/indicators/atr.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new AtrIndicator();

function createCandle(
  index: number,
  high: number,
  low: number,
  close: number,
  open = close
): Candle {
  return {
    timestamp: new Date(new Date('2026-08-03T09:15:00+05:30').getTime() + index * 60_000),
    open,
    high,
    low,
    close,
    volume: 1,
  };
}

function createKnownCandles(): Candle[] {
  return [
    createCandle(0, 10, 8, 9),
    createCandle(1, 12, 9, 11),
    createCandle(2, 13, 10, 12),
    createCandle(3, 16, 11, 15),
  ];
}

test('calculates True Range values for a known series', () => {
  const result = indicator.calculate(createKnownCandles(), { type: IndicatorType.ATR, period: 1 });

  assert.deepEqual(
    result.values.map((entry) => entry.value),
    [2, 3, 3, 5]
  );
});

test('calculates the initial ATR from the first period of True Ranges', () => {
  const candles = createKnownCandles();
  const result = indicator.calculate(candles, { type: IndicatorType.ATR, period: 3 });

  assert.equal(result.values[0].value, 8 / 3);
  assert.equal(result.values[0].timestamp, candles[2].timestamp);
});

test('calculates Wilder-smoothed ATR values', () => {
  const result = indicator.calculate(createKnownCandles(), { type: IndicatorType.ATR, period: 3 });

  assert.ok(Math.abs(result.values[1].value - 31 / 9) < 1e-12);
});

test('calculates ATR with period 1', () => {
  const result = indicator.calculate(createKnownCandles(), { type: IndicatorType.ATR, period: 1 });

  assert.equal(result.values.length, 4);
  assert.equal(result.values[3].value, 5);
});

test('rejects insufficient candles', () => {
  assert.throws(
    () => indicator.calculate(createKnownCandles().slice(0, 2), { type: IndicatorType.ATR, period: 3 }),
    /requires at least 3 candles/
  );
});

test('rejects invalid periods', () => {
  const candles = createKnownCandles();

  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.ATR, period: 0 }),
    /positive integer/
  );
  assert.throws(
    () => indicator.calculate(candles, { type: IndicatorType.ATR, period: 1.5 }),
    /positive integer/
  );
});

test('rejects invalid candle OHLC data', () => {
  assert.throws(
    () =>
      indicator.calculate([createCandle(0, 8, 10, 9)], { type: IndicatorType.ATR, period: 1 }),
    /invalid candle/
  );
});

test('does not mutate input candles', () => {
  const candles = createKnownCandles();
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, { type: IndicatorType.ATR, period: 2 });

  assert.deepEqual(candles, originalCandles);
});
