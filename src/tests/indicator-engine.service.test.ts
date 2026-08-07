import assert from 'node:assert/strict';
import test from 'node:test';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';

const engine = new IndicatorEngineService();

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

test('calculates an SMA-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.SMA, period: 2 }],
  });

  assert.equal(result.indicators.length, 1);
  assert.equal(result.indicators[0].result.type, IndicatorType.SMA);
  assert.deepEqual(
    (result.indicators[0].result.values as Array<{ value: number }>).map((entry) => entry.value),
    [1.5, 2.5]
  );
});

test('calculates an EMA-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.EMA, period: 2 }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.EMA);
  assert.deepEqual(
    (result.indicators[0].result.values as Array<{ value: number }>).map((entry) => entry.value),
    [1.5, 2.5]
  );
});

test('calculates an RSI-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 1]), {
    indicators: [{ type: IndicatorType.RSI, period: 2 }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.RSI);
  assert.deepEqual(
    (result.indicators[0].result.values as Array<{ value: number }>).map((entry) => entry.value),
    [50]
  );
});

test('calculates a VWAP-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.VWAP }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.VWAP);
  assert.deepEqual(
    (result.indicators[0].result.values as Array<{ value: number | null }>).map(
      (entry) => entry.value
    ),
    [1, 1.5, 2]
  );
});

test('calculates an ATR-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.ATR, period: 2 }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.ATR);
  assert.equal(result.indicators[0].result.values.length, 2);
});

test('calculates a MACD-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 1, 3, 2, 4, 3]), {
    indicators: [
      {
        type: IndicatorType.MACD,
        fastPeriod: 3,
        slowPeriod: 5,
        signalPeriod: 3,
      },
    ],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.MACD);
  assert.equal(result.indicators[0].result.values.length, 1);
});

test('calculates a Bollinger Bands-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [
      {
        type: IndicatorType.BOLLINGER_BANDS,
        period: 2,
        standardDeviationMultiplier: 2,
      },
    ],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.BOLLINGER_BANDS);
  assert.equal(result.indicators[0].result.values.length, 2);
});

test('calculates an ADX-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.ADX, period: 2 }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.ADX);
  assert.equal(result.indicators[0].result.values.length, 1);
});

test('calculates a SuperTrend-only request', () => {
  const result = engine.calculate(createCandles([1, 2, 3]), {
    indicators: [{ type: IndicatorType.SUPER_TREND, period: 2, multiplier: 3 }],
  });

  assert.equal(result.indicators[0].result.type, IndicatorType.SUPER_TREND);
  assert.equal(result.indicators[0].result.values.length, 2);
});

test('calculates multiple indicators in one request', () => {
  const result = engine.calculate(createCandles([1, 2, 3, 4]), {
    indicators: [
      { type: IndicatorType.SMA, period: 2 },
      { type: IndicatorType.EMA, period: 2 },
      { type: IndicatorType.RSI, period: 2 },
      { type: IndicatorType.VWAP },
      { type: IndicatorType.ATR, period: 2 },
    ],
  });

  assert.deepEqual(
    result.indicators.map((entry) => entry.result.type),
    [
      IndicatorType.SMA,
      IndicatorType.EMA,
      IndicatorType.RSI,
      IndicatorType.VWAP,
      IndicatorType.ATR,
    ]
  );
});

test('calculates all nine supported indicators in one request', () => {
  const result = engine.calculate(
    createCandles(Array.from({ length: 60 }, (_, index) => index + 1)),
    {
      indicators: [
        { type: IndicatorType.SMA, period: 20 },
        { type: IndicatorType.EMA, period: 20 },
        { type: IndicatorType.RSI, period: 14 },
        { type: IndicatorType.VWAP },
        { type: IndicatorType.ATR, period: 14 },
        {
          type: IndicatorType.MACD,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
        },
        {
          type: IndicatorType.BOLLINGER_BANDS,
          period: 20,
          standardDeviationMultiplier: 2,
        },
        { type: IndicatorType.ADX, period: 14 },
        { type: IndicatorType.SUPER_TREND, period: 14, multiplier: 3 },
      ],
    }
  );

  assert.deepEqual(
    result.indicators.map((entry) => entry.result.type),
    [
      IndicatorType.SMA,
      IndicatorType.EMA,
      IndicatorType.RSI,
      IndicatorType.VWAP,
      IndicatorType.ATR,
      IndicatorType.MACD,
      IndicatorType.BOLLINGER_BANDS,
      IndicatorType.ADX,
      IndicatorType.SUPER_TREND,
    ]
  );
});

test('supports two EMA requests with different periods', () => {
  const result = engine.calculate(createCandles([1, 2, 3, 4, 5]), {
    indicators: [
      { type: IndicatorType.EMA, period: 2 },
      { type: IndicatorType.EMA, period: 3 },
    ],
  });

  assert.equal(result.indicators.length, 2);
  assert.equal((result.indicators[0].config as { period: number }).period, 2);
  assert.equal((result.indicators[1].config as { period: number }).period, 3);
});

test('supports two ATR requests with different periods', () => {
  const result = engine.calculate(createCandles([1, 2, 3, 4, 5]), {
    indicators: [
      { type: IndicatorType.ATR, period: 2 },
      { type: IndicatorType.ATR, period: 3 },
    ],
  });

  assert.equal(result.indicators.length, 2);
  assert.equal((result.indicators[0].config as { period: number }).period, 2);
  assert.equal((result.indicators[1].config as { period: number }).period, 3);
});

test('supports multiple MACD configurations', () => {
  const result = engine.calculate(createCandles([1, 2, 1, 3, 2, 4, 3, 5]), {
    indicators: [
      { type: IndicatorType.MACD, fastPeriod: 2, slowPeriod: 4, signalPeriod: 2 },
      { type: IndicatorType.MACD, fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 },
    ],
  });

  assert.equal(result.indicators.length, 2);
  assert.notDeepEqual(result.indicators[0].config, result.indicators[1].config);
});

test('supports multiple SuperTrend configurations', () => {
  const result = engine.calculate(createCandles([1, 2, 3, 4]), {
    indicators: [
      { type: IndicatorType.SUPER_TREND, period: 2, multiplier: 2 },
      { type: IndicatorType.SUPER_TREND, period: 2, multiplier: 3 },
    ],
  });

  assert.equal(result.indicators.length, 2);
  assert.notDeepEqual(result.indicators[0].config, result.indicators[1].config);
});

test('rejects unsupported indicator types', () => {
  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [{ type: 'UNKNOWN' }] as never,
      }),
    /Unsupported indicator type: UNKNOWN/
  );
});

test('propagates invalid indicator configurations', () => {
  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [{ type: IndicatorType.SMA, period: 0 }],
      }),
    /SMA period must be a positive integer/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles([1, 2, 3, 4]);
  const originalCandles = candles.map((candle) => ({ ...candle }));

  engine.calculate(candles, {
    indicators: [
      { type: IndicatorType.SMA, period: 2 },
      { type: IndicatorType.EMA, period: 2 },
      { type: IndicatorType.RSI, period: 2 },
    ],
  });

  assert.deepEqual(candles, originalCandles);
});

test('rejects duplicate indicator requests', () => {
  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [
          { type: IndicatorType.EMA, period: 2 },
          { type: IndicatorType.EMA, period: 2 },
        ],
      }),
    /Duplicate indicator request/
  );
});

test('rejects duplicate VWAP requests', () => {
  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [{ type: IndicatorType.VWAP }, { type: IndicatorType.VWAP }],
      }),
    /Duplicate indicator request: VWAP/
  );
});

test('rejects exact duplicate MACD requests', () => {
  const macdRequest = {
    type: IndicatorType.MACD,
    fastPeriod: 3,
    slowPeriod: 5,
    signalPeriod: 3,
  } as const;

  assert.throws(
    () => engine.calculate(createCandles([1, 2, 3]), { indicators: [macdRequest, macdRequest] }),
    /Duplicate indicator request: MACD/
  );
});

test('rejects exact duplicate Bollinger Bands requests', () => {
  const bollingerBandsRequest = {
    type: IndicatorType.BOLLINGER_BANDS,
    period: 2,
    standardDeviationMultiplier: 2,
  } as const;

  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [bollingerBandsRequest, bollingerBandsRequest],
      }),
    /Duplicate indicator request: BOLLINGER_BANDS/
  );
});

test('rejects exact duplicate ADX requests', () => {
  const adxRequest = { type: IndicatorType.ADX, period: 2 } as const;

  assert.throws(
    () => engine.calculate(createCandles([1, 2, 3]), { indicators: [adxRequest, adxRequest] }),
    /Duplicate indicator request: ADX/
  );
});

test('rejects exact duplicate SuperTrend requests', () => {
  const superTrendRequest = {
    type: IndicatorType.SUPER_TREND,
    period: 2,
    multiplier: 3,
  } as const;

  assert.throws(
    () =>
      engine.calculate(createCandles([1, 2, 3]), {
        indicators: [superTrendRequest, superTrendRequest],
      }),
    /Duplicate indicator request: SUPER_TREND/
  );
});
