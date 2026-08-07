import assert from 'node:assert/strict';
import test from 'node:test';
import AdxIndicator from '../modules/indicators/indicators/adx.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new AdxIndicator();
const config = { type: IndicatorType.ADX, period: 2 } as const;

function createCandles(
  values: Array<{ high: number; low: number; close: number; open?: number }>
): Candle[] {
  const startTime = new Date('2026-08-03T09:15:00+05:30').getTime();

  return values.map((value, index) => ({
    timestamp: new Date(startTime + index * 60_000),
    open: value.open ?? value.close,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: 1,
  }));
}

const mixedTrendCandles = createCandles([
  { high: 10, low: 8, close: 9 },
  { high: 12, low: 9, close: 11 },
  { high: 11, low: 7, close: 8 },
  { high: 13, low: 8, close: 12 },
  { high: 12, low: 6, close: 7 },
  { high: 14, low: 7, close: 13 },
]);

test('calculates positive and negative directional movement through directional indicators', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 },
      { high: 11, low: 6, close: 7 },
    ]),
    { type: IndicatorType.ADX, period: 1 }
  );

  assert.ok(result.values[1].plusDI > 0);
  assert.equal(result.values[1].minusDI, 0);
  assert.equal(result.values[2].plusDI, 0);
  assert.ok(result.values[2].minusDI > 0);
});

test('calculates the expected plusDI and minusDI', () => {
  const result = indicator.calculate(mixedTrendCandles, config);

  assert.equal(Number(result.values[0].plusDI.toFixed(8)), 22.22222222);
  assert.equal(Number(result.values[0].minusDI.toFixed(8)), 22.22222222);
});

test('calculates the initial ADX from the first period DX values', () => {
  const result = indicator.calculate(mixedTrendCandles, config);

  assert.equal(Number(result.values[0].adx.toFixed(8)), 50);
  assert.equal(result.values[0].timestamp, mixedTrendCandles[2].timestamp);
});

test('calculates Wilder-smoothed ADX values after the initial ADX', () => {
  const result = indicator.calculate(mixedTrendCandles, config);

  assert.equal(Number(result.values[2].adx.toFixed(8)), 37.5);
});

test('reports strong positive directional movement for a trending-up series', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 10, close: 11 },
      { high: 14, low: 12, close: 13 },
    ]),
    config
  );

  assert.equal(result.values[0].adx, 100);
  assert.ok(result.values[0].plusDI > result.values[0].minusDI);
});

test('reports strong negative directional movement for a trending-down series', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 14, low: 12, close: 13 },
      { high: 12, low: 10, close: 11 },
      { high: 10, low: 8, close: 9 },
    ]),
    config
  );

  assert.equal(result.values[0].adx, 100);
  assert.ok(result.values[0].minusDI > result.values[0].plusDI);
});

test('returns zero directional indicators and ADX for a flat series', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 10, close: 10 },
      { high: 10, low: 10, close: 10 },
      { high: 10, low: 10, close: 10 },
    ]),
    config
  );

  assert.deepEqual(result.values[0], {
    timestamp: new Date('2026-08-03T03:47:00.000Z'),
    adx: 0,
    plusDI: 0,
    minusDI: 0,
  });
});

test('rejects invalid periods', () => {
  assert.throws(() => indicator.calculate(mixedTrendCandles, { ...config, period: 0 }), /positive integer/);
  assert.throws(() => indicator.calculate(mixedTrendCandles, { ...config, period: 1.5 }), /positive integer/);
});

test('rejects insufficient candles for an initial ADX', () => {
  assert.throws(
    () => indicator.calculate(mixedTrendCandles.slice(0, 2), config),
    /requires at least 3 candles/
  );
});

test('rejects invalid OHLC input', () => {
  const candles = createCandles([
    { high: 10, low: 8, close: 9 },
    { high: 7, low: 8, close: 8 },
    { high: 11, low: 9, close: 10 },
  ]);

  assert.throws(() => indicator.calculate(candles, config), /invalid candle/);
});

test('does not mutate input candles', () => {
  const candles = mixedTrendCandles.map((candle) => ({ ...candle }));
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, config);

  assert.deepEqual(candles, originalCandles);
});
