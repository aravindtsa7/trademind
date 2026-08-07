import assert from 'node:assert/strict';
import test from 'node:test';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import { Candle } from '../modules/indicators/types';

const aggregator = new CandleTimeframeAggregatorService();

function createCandles(start: string, count: number): Candle[] {
  const startTime = new Date(start).getTime();

  return Array.from({ length: count }, (_, index) => {
    const price = 100 + index;

    return {
      timestamp: new Date(startTime + index * 60_000),
      open: price,
      high: price + 2,
      low: price - 1,
      close: price + 1,
      volume: 10,
    };
  });
}

test('aggregates 5m candles from the 09:15 IST session start', () => {
  const result = aggregator.aggregate(createCandles('2026-08-03T09:15:00+05:30', 10), '5m');

  assert.equal(result.length, 2);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:45:00.000Z');
  assert.equal(result[1].timestamp.toISOString(), '2026-08-03T03:50:00.000Z');
  assert.equal(result[0].open, 100);
  assert.equal(result[0].high, 106);
  assert.equal(result[0].low, 99);
  assert.equal(result[0].close, 105);
  assert.equal(result[0].volume, 50);
});

test('aggregates 15m candles from the 09:15 IST session start', () => {
  const result = aggregator.aggregate(createCandles('2026-08-03T09:15:00+05:30', 30), '15m');

  assert.equal(result.length, 2);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:45:00.000Z');
  assert.equal(result[1].timestamp.toISOString(), '2026-08-03T04:00:00.000Z');
});

test('aggregates 60m candles from the 09:15 IST session start', () => {
  const result = aggregator.aggregate(createCandles('2026-08-03T09:15:00+05:30', 120), '60m');

  assert.equal(result.length, 2);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:45:00.000Z');
  assert.equal(result[1].timestamp.toISOString(), '2026-08-03T04:45:00.000Z');
});

test('does not create a 09:16-09:20 bucket when input begins at 09:16', () => {
  const result = aggregator.aggregate(createCandles('2026-08-03T09:16:00+05:30', 9), '5m', {
    incompleteLeadingBucket: 'discard',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:50:00.000Z');
});

test('treats a missing 09:15 candle as an incomplete initial bucket', () => {
  assert.throws(
    () => aggregator.aggregate(createCandles('2026-08-03T09:16:00+05:30', 4), '5m'),
    /Incomplete leading 5m candle bucket/
  );
});

test('explicitly discards partial leading and trailing buckets', () => {
  const result = aggregator.aggregate(createCandles('2026-08-03T09:16:00+05:30', 12), '5m', {
    incompleteLeadingBucket: 'discard',
    incompleteTrailingBucket: 'discard',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:50:00.000Z');
});

test('does not create aggregation buckets across trading-day boundaries', () => {
  const candles = [
    ...createCandles('2026-08-03T09:15:00+05:30', 5),
    ...createCandles('2026-08-04T09:15:00+05:30', 5),
  ];
  const result = aggregator.aggregate(candles, '5m');

  assert.equal(result.length, 2);
  assert.equal(result[0].timestamp.toISOString(), '2026-08-03T03:45:00.000Z');
  assert.equal(result[1].timestamp.toISOString(), '2026-08-04T03:45:00.000Z');
});
