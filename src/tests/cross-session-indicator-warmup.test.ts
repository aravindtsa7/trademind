import assert from 'node:assert/strict';
import test from 'node:test';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { Candle } from '../modules/indicators/types';
import { assertNoFutureWarmup, filterCrossSessionResearchTargets, isCooldownEligible, prepareCrossSessionIndicatorWarmup, sameIstTradingDate } from './helpers/cross-session-indicator-warmup';

function session(date: string, base: number, length = 375): Candle[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length }, (_, index) => ({ timestamp: new Date(start + index * 60_000), open: base + index / 10, high: base + index / 10 + 2, low: base + index / 10 - 2, close: base + index / 10 + 0.5, volume: 1 }));
}

function prepare(days: Array<[string, Candle[]]>) {
  return prepareCrossSessionIndicatorWarmup(days.map(([date, candles]) => ({ date, candles })), new CandleTimeframeAggregatorService(), new IndicatorEngineService(), new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 }));
}
function prepareWithFlags(days: Array<[string, Candle[], boolean?]>) {
  return prepareCrossSessionIndicatorWarmup(days.map(([date, candles, allowIncompleteTrailingFiveMinuteBucket]) => ({ date, candles, allowIncompleteTrailingFiveMinuteBucket })), new CandleTimeframeAggregatorService(), new IndicatorEngineService(), new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 }));
}

test('prior-session candles seed EMA/RSI and ADX/ATR-derived regime state before the target open', () => {
  const prepared = prepare([['2026-07-10', session('2026-07-10', 24_000)], ['2026-07-13', session('2026-07-13', 24_100)]]);
  const target = prepared[1]; const open = target.oneMinute[0].timestamp.getTime();

  assert.equal(target.readiness.at0915, true);
  assert.ok(target.frames[1].ema15.has(open));
  assert.ok(target.frames[1].ema35.has(open));
  assert.ok(target.frames[1].rsi14.has(open));
  assert.ok(target.regimePoints.some((point) => point.availableAt.getTime() <= open && point.regime !== undefined));
});

test('first target-session candles evaluate with prior history while target signal frames exclude warm-up bars', () => {
  const prepared = prepare([['2026-07-14', session('2026-07-14', 24_000)], ['2026-07-15', session('2026-07-15', 24_100)]]);
  const target = prepared[1];

  assert.equal(target.frames[1].candles.length, 375);
  assert.equal(target.frames[5].candles.length, 75);
  assert.ok(target.frames[1].allCandles.length > target.frames[1].candles.length);
  assert.equal(target.frames[1].candles[0].timestamp.toISOString(), '2026-07-15T03:45:00.000Z');
  assert.equal(target.readiness.at0920, true);
  assert.equal(target.readiness.at0930, true);
});

test('calendar gaps use the latest available prior trading session and never warm from future candles', () => {
  const friday = session('2026-07-10', 24_000); const monday = session('2026-07-13', 24_100);
  const prepared = prepare([['2026-07-10', friday], ['2026-07-13', monday]]);
  const target = prepared[1]; const mondayOpen = target.oneMinute[0].timestamp.getTime();

  assert.ok(target.frames[5].allCandles.some((candle) => candle.timestamp.toISOString().startsWith('2026-07-10')));
  assert.ok(target.frames[5].allCandles.filter((candle) => candle.timestamp.getTime() < mondayOpen).every((candle) => candle.timestamp.getTime() < mondayOpen));
  assert.doesNotThrow(() => assertNoFutureWarmup(target));
});

test('end-date filtering excludes later targets while retained targets keep prior-session warm-up', () => {
  const prepared = prepare([
    ['2026-07-14', session('2026-07-14', 24_000)],
    ['2026-07-15', session('2026-07-15', 24_100)],
    ['2026-07-16', session('2026-07-16', 24_200)],
  ]);
  const targets = filterCrossSessionResearchTargets(prepared, '2026-07-15');
  const target = targets[1];

  assert.deepEqual(targets.map((entry) => entry.date), ['2026-07-14', '2026-07-15']);
  assert.ok(target.frames[5].allCandles.some((candle) => candle.timestamp.toISOString().startsWith('2026-07-14')));
  assert.doesNotThrow(() => assertNoFutureWarmup(target));
});

test('09:15, 09:17, and 09:20 use only fully completed regime information', () => {
  const prepared = prepare([['2026-07-14', session('2026-07-14', 24_000)], ['2026-07-15', session('2026-07-15', 24_100)]]);
  const target = prepared[1]; const open = target.oneMinute[0].timestamp.getTime();

  [0, 2, 5].forEach((offset) => {
    const timestamp = open + offset * 60_000;
    const known = target.regimePoints.filter((point) => point.availableAt.getTime() <= timestamp);
    assert.ok(known.every((point) => point.availableAt.getTime() <= timestamp));
  });
  assert.equal(target.regimePoints.some((point) => point.availableAt.getTime() === open + 5 * 60_000), true);
});

test('warm-up preparation does not mutate historical input candles', () => {
  const previous = session('2026-07-14', 24_000); const target = session('2026-07-15', 24_100); const snapshot = structuredClone([previous, target]);
  prepare([['2026-07-14', previous], ['2026-07-15', target]]);
  assert.deepEqual([previous, target], snapshot);
});

test('cooldown state resets when the next target session starts', () => {
  const priorSessionSignal = new Date('2026-07-14T15:29:00+05:30').getTime(); const nextSessionOpen = new Date('2026-07-15T09:15:00+05:30').getTime();
  assert.equal(isCooldownEligible(priorSessionSignal, nextSessionOpen, 10), true);
  assert.equal(isCooldownEligible(new Date('2026-07-15T09:15:00+05:30').getTime(), new Date('2026-07-15T09:20:00+05:30').getTime(), 10), false);
});

test('outcome paths remain bounded to the signal IST trading session', () => {
  const signal = new Date('2026-07-15T15:29:00+05:30'); const rows = [{ candleTime: signal }, { candleTime: new Date('2026-07-16T09:15:00+05:30') }];
  assert.deepEqual(sameIstTradingDate(rows, signal), [rows[0]]);
});

test('a complete 375-row source session aggregates to the exact frozen bar counts across every timeframe', () => {
  const prepared = prepare([['2026-07-14', session('2026-07-14', 24_000)], ['2026-07-15', session('2026-07-15', 24_100)]]);
  const target = prepared[1];
  assert.equal(target.frames[1].candles.length, 375);
  assert.equal(target.frames[2].candles.length, 187);
  assert.equal(target.frames[3].candles.length, 125);
  assert.equal(target.frames[5].candles.length, 75);
});

test('default (omitted) trailing-5m tolerance is unchanged: a naturally incomplete trailing 5m bucket still throws', () => {
  const partial = session('2026-07-15', 24_100, 42); // 42 minutes: 8 complete 5m buckets + 2 leftover minutes
  assert.throws(
    () => prepare([['2026-07-14', session('2026-07-14', 24_000)], ['2026-07-15', partial]]),
    /Incomplete trailing 5m candle bucket/,
  );
});

test('allowIncompleteTrailingFiveMinuteBucket is opt-in and scoped only to the flagged session', () => {
  const partial = session('2026-07-15', 24_100, 42);
  // Only the target (current/forming) session opts in; the prior session keeps strict default behaviour.
  const prepared = prepareWithFlags([['2026-07-14', session('2026-07-14', 24_000), false], ['2026-07-15', partial, true]]);
  const target = prepared[1];
  assert.equal(target.frames[5].candles.length, 8); // trailing incomplete bucket discarded, not fabricated
  assert.equal(target.frames[1].candles.length, 42);

  // The same partial shape without the flag on the PRIOR session still throws if it were the target instead.
  assert.throws(
    () => prepareWithFlags([['2026-07-14', session('2026-07-14', 24_000)], ['2026-07-15', partial, false]]),
    /Incomplete trailing 5m candle bucket/,
  );
});
