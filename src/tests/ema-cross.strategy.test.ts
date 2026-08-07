import assert from 'node:assert/strict';
import test from 'node:test';
import { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy, {
  EmaCrossStrategyInput,
} from '../modules/strategies/strategies/ema-cross.strategy';
import { IndicatorType } from '../modules/indicators/types';

const fastPeriod = 20;
const slowPeriod = 50;
const strategy = new EmaCrossStrategy({ fastPeriod, slowPeriod });
const startTime = new Date('2026-08-03T09:15:00+05:30').getTime();

function createEmaResult(period: number, values: number[], timestampOffset = 0): EmaResult {
  return {
    type: IndicatorType.EMA,
    period,
    values: values.map((value, index) => ({
      timestamp: new Date(startTime + (index + timestampOffset) * 60_000),
      value,
    })),
  };
}

function createInput(fastValues: number[], slowValues: number[]): EmaCrossStrategyInput {
  return {
    fastEma: createEmaResult(fastPeriod, fastValues),
    slowEma: createEmaResult(slowPeriod, slowValues),
  };
}

test('returns BUY_CE for a bullish crossover', () => {
  const result = strategy.evaluate(createInput([10, 12], [11, 11]));

  assert.equal(result.signal, StrategySignal.BUY_CE);
  assert.equal(result.confidence, 60);
  assert.match(result.reasons[0], /crossed above/);
  assert.equal('entryPrice' in result, false);
});

test('returns BUY_PE for a bearish crossover', () => {
  const result = strategy.evaluate(createInput([12, 10], [11, 11]));

  assert.equal(result.signal, StrategySignal.BUY_PE);
  assert.equal(result.confidence, 60);
  assert.match(result.reasons[0], /crossed below/);
});

test('returns NO_TRADE when fast EMA is already above slow EMA', () => {
  const result = strategy.evaluate(createInput([12, 13], [11, 12]));

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.match(result.reasons[0], /remains above/);
});

test('returns NO_TRADE when fast EMA is already below slow EMA', () => {
  const result = strategy.evaluate(createInput([10, 9], [11, 10]));

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.match(result.reasons[0], /remains below/);
});

test('returns BUY_CE when equal EMAs cross bullishly', () => {
  const result = strategy.evaluate(createInput([10, 11], [10, 10]));

  assert.equal(result.signal, StrategySignal.BUY_CE);
});

test('returns BUY_PE when equal EMAs cross bearishly', () => {
  const result = strategy.evaluate(createInput([10, 9], [10, 10]));

  assert.equal(result.signal, StrategySignal.BUY_PE);
});

test('rejects invalid EMA cross periods', () => {
  assert.throws(
    () => new EmaCrossStrategy({ fastPeriod: 0, slowPeriod }),
    /fastPeriod must be a positive integer/
  );
  assert.throws(
    () => new EmaCrossStrategy({ fastPeriod: 20, slowPeriod: 20 }),
    /fastPeriod must be less than slowPeriod/
  );
});

test('rejects insufficient EMA data', () => {
  assert.throws(
    () => strategy.evaluate(createInput([10], [11])),
    /at least two fast and slow EMA results/
  );
});

test('rejects fast and slow EMA timestamp mismatches', () => {
  assert.throws(
    () =>
      strategy.evaluate({
        fastEma: createEmaResult(fastPeriod, [10, 12]),
        slowEma: createEmaResult(slowPeriod, [11, 11], 1),
      }),
    /matching fast and slow EMA timestamps/
  );
});

test('does not mutate EMA input results', () => {
  const input = createInput([10, 12], [11, 11]);
  const originalInput = {
    fastEma: {
      ...input.fastEma,
      values: input.fastEma.values.map((entry) => ({ ...entry })),
    },
    slowEma: {
      ...input.slowEma,
      values: input.slowEma.values.map((entry) => ({ ...entry })),
    },
  };

  strategy.evaluate(input);

  assert.deepEqual(input, originalInput);
});
