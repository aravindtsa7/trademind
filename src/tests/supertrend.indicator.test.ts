import assert from 'node:assert/strict';
import test from 'node:test';
import SuperTrendIndicator, {
  SuperTrendDirection,
} from '../modules/indicators/indicators/supertrend.indicator';
import { Candle, IndicatorType } from '../modules/indicators/types';

const indicator = new SuperTrendIndicator();
const config = {
  type: IndicatorType.SUPER_TREND,
  period: 1,
  multiplier: 2,
} as const;

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

test('calculates correct basic upper and lower bands', () => {
  const result = indicator.calculate(createCandles([{ high: 10, low: 8, close: 9 }]), config);

  assert.equal(result.values[0].upperBand, 13);
  assert.equal(result.values[0].lowerBand, 5);
});

test('carries final bands forward when the update rules are not met', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
    ]),
    config
  );

  assert.equal(result.values[1].upperBand, 13);
  assert.equal(result.values[1].lowerBand, 6);
});

test('reports an UP trend when price rises above the active upper band', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 15, low: 13, close: 14 },
    ]),
    config
  );

  assert.equal(result.values[1].trend, SuperTrendDirection.UP);
  assert.equal(result.values[1].supertrend, result.values[1].lowerBand);
});

test('reports a DOWN trend while price remains below the active upper band', () => {
  const result = indicator.calculate(createCandles([{ high: 10, low: 8, close: 9 }]), config);

  assert.equal(result.values[0].trend, SuperTrendDirection.DOWN);
  assert.equal(result.values[0].supertrend, result.values[0].upperBand);
});

test('reverses from DOWN to UP when price closes above the upper band', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 15, low: 13, close: 14 },
    ]),
    config
  );

  assert.equal(result.values[0].trend, SuperTrendDirection.DOWN);
  assert.equal(result.values[1].trend, SuperTrendDirection.UP);
});

test('reverses from UP to DOWN when price closes below the lower band', () => {
  const result = indicator.calculate(
    createCandles([
      { high: 10, low: 8, close: 9 },
      { high: 15, low: 13, close: 14 },
      { high: 6, low: 3, close: 4 },
    ]),
    config
  );

  assert.equal(result.values[1].trend, SuperTrendDirection.UP);
  assert.equal(result.values[2].trend, SuperTrendDirection.DOWN);
  assert.equal(result.values[2].supertrend, result.values[2].upperBand);
});

test('supports period 1', () => {
  const result = indicator.calculate(createCandles([{ high: 10, low: 8, close: 9 }]), config);

  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].timestamp.getTime(), new Date('2026-08-03T03:45:00.000Z').getTime());
});

test('rejects invalid periods', () => {
  const candles = createCandles([{ high: 10, low: 8, close: 9 }]);

  assert.throws(() => indicator.calculate(candles, { ...config, period: 0 }), /positive integer/);
  assert.throws(() => indicator.calculate(candles, { ...config, period: 1.5 }), /positive integer/);
});

test('rejects invalid multipliers', () => {
  const candles = createCandles([{ high: 10, low: 8, close: 9 }]);

  assert.throws(() => indicator.calculate(candles, { ...config, multiplier: 0 }), /positive finite number/);
  assert.throws(
    () => indicator.calculate(candles, { ...config, multiplier: Number.NaN }),
    /positive finite number/
  );
});

test('rejects insufficient candles for ATR', () => {
  assert.throws(
    () =>
      indicator.calculate(createCandles([{ high: 10, low: 8, close: 9 }]), {
        ...config,
        period: 2,
      }),
    /requires at least 2 candles/
  );
});

test('rejects invalid OHLC input', () => {
  const candles = createCandles([{ high: 8, low: 10, close: 9 }]);

  assert.throws(() => indicator.calculate(candles, config), /invalid candle/);
});

test('does not mutate input candles', () => {
  const candles = createCandles([
    { high: 10, low: 8, close: 9 },
    { high: 15, low: 13, close: 14 },
    { high: 6, low: 3, close: 4 },
  ]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  indicator.calculate(candles, config);

  assert.deepEqual(candles, originalCandles);
});
