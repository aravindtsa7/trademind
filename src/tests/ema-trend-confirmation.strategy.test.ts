import assert from 'node:assert/strict';
import test from 'node:test';
import { SuperTrendDirection } from '../modules/indicators/indicators/supertrend.indicator';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaTrendConfirmationStrategy, {
  EmaTrendConfirmationInput,
} from '../modules/strategies/strategies/ema-trend-confirmation.strategy';

const strategy = new EmaTrendConfirmationStrategy();
const previousTimestamp = new Date('2026-08-03T09:15:00+05:30');
const latestTimestamp = new Date('2026-08-03T09:20:00+05:30');

function createInput(overrides: Partial<EmaTrendConfirmationInput> = {}): EmaTrendConfirmationInput {
  return {
    previousEma20: { timestamp: previousTimestamp, value: 100 },
    latestEma20: { timestamp: latestTimestamp, value: 102 },
    previousEma50: { timestamp: previousTimestamp, value: 101 },
    latestEma50: { timestamp: latestTimestamp, value: 101 },
    latestRsi14: { timestamp: latestTimestamp, value: 55 },
    latestAdx14: { timestamp: latestTimestamp, adx: 25, plusDI: 30, minusDI: 10 },
    latestSuperTrend: {
      timestamp: latestTimestamp,
      supertrend: 99,
      trend: SuperTrendDirection.UP,
      upperBand: 105,
      lowerBand: 99,
    },
    ...overrides,
  };
}

function createBearishInput(overrides: Partial<EmaTrendConfirmationInput> = {}): EmaTrendConfirmationInput {
  return createInput({
    previousEma20: { timestamp: previousTimestamp, value: 102 },
    latestEma20: { timestamp: latestTimestamp, value: 100 },
    previousEma50: { timestamp: previousTimestamp, value: 101 },
    latestEma50: { timestamp: latestTimestamp, value: 101 },
    latestRsi14: { timestamp: latestTimestamp, value: 45 },
    latestAdx14: { timestamp: latestTimestamp, adx: 25, plusDI: 10, minusDI: 30 },
    latestSuperTrend: {
      timestamp: latestTimestamp,
      supertrend: 103,
      trend: SuperTrendDirection.DOWN,
      upperBand: 103,
      lowerBand: 97,
    },
    ...overrides,
  });
}

test('returns BUY_CE for a fully confirmed bullish crossover', () => {
  const result = strategy.evaluate(createInput());

  assert.equal(result.signal, StrategySignal.BUY_CE);
  assert.equal(result.confidence, 100);
  assert.equal(result.reasons.length, 5);
});

test('returns BUY_PE for a fully confirmed bearish crossover', () => {
  const result = strategy.evaluate(createBearishInput());

  assert.equal(result.signal, StrategySignal.BUY_PE);
  assert.equal(result.confidence, 100);
});

test('returns NO_TRADE for a bullish crossover with weak ADX', () => {
  const result = strategy.evaluate(
    createInput({ latestAdx14: { timestamp: latestTimestamp, adx: 19, plusDI: 30, minusDI: 10 } })
  );

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.equal(result.confidence, 80);
  assert.match(result.reasons.join(' '), /ADX 19 is below required 20/);
});

test('returns NO_TRADE for a bullish crossover with the wrong DI direction', () => {
  const result = strategy.evaluate(
    createInput({ latestAdx14: { timestamp: latestTimestamp, adx: 25, plusDI: 10, minusDI: 30 } })
  );

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.equal(result.confidence, 85);
  assert.match(result.reasons.join(' '), /\+DI 10 does not exceed -DI 30/);
});

test('returns NO_TRADE for a bullish crossover with SuperTrend DOWN', () => {
  const result = strategy.evaluate(
    createInput({
      latestSuperTrend: {
        timestamp: latestTimestamp,
        supertrend: 103,
        trend: SuperTrendDirection.DOWN,
        upperBand: 103,
        lowerBand: 99,
      },
    })
  );

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.equal(result.confidence, 80);
  assert.match(result.reasons.join(' '), /expected UP/);
});

test('returns NO_TRADE for a bullish crossover with RSI below 50', () => {
  const result = strategy.evaluate(
    createInput({ latestRsi14: { timestamp: latestTimestamp, value: 49 } })
  );

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.equal(result.confidence, 85);
  assert.match(result.reasons.join(' '), /RSI 49 does not meet the required >= 50 threshold/);
});

test('returns NO_TRADE for bearish crossovers with each failed confirmation', () => {
  const weakAdx = strategy.evaluate(
    createBearishInput({ latestAdx14: { timestamp: latestTimestamp, adx: 19, plusDI: 10, minusDI: 30 } })
  );
  const wrongDi = strategy.evaluate(
    createBearishInput({ latestAdx14: { timestamp: latestTimestamp, adx: 25, plusDI: 30, minusDI: 10 } })
  );
  const wrongTrend = strategy.evaluate(
    createBearishInput({
      latestSuperTrend: {
        timestamp: latestTimestamp,
        supertrend: 99,
        trend: SuperTrendDirection.UP,
        upperBand: 103,
        lowerBand: 99,
      },
    })
  );
  const highRsi = strategy.evaluate(
    createBearishInput({ latestRsi14: { timestamp: latestTimestamp, value: 51 } })
  );

  assert.deepEqual(
    [weakAdx, wrongDi, wrongTrend, highRsi].map((result) => result.signal),
    [
      StrategySignal.NO_TRADE,
      StrategySignal.NO_TRADE,
      StrategySignal.NO_TRADE,
      StrategySignal.NO_TRADE,
    ]
  );
  assert.match(weakAdx.reasons.join(' '), /ADX 19 is below required 20/);
  assert.match(wrongDi.reasons.join(' '), /-DI 10 does not exceed \+DI 30/);
  assert.match(wrongTrend.reasons.join(' '), /expected DOWN/);
  assert.match(highRsi.reasons.join(' '), /RSI 51 does not meet the required <= 50 threshold/);
});

test('returns NO_TRADE when no EMA crossover exists', () => {
  const result = strategy.evaluate(
    createInput({
      previousEma20: { timestamp: previousTimestamp, value: 102 },
      latestEma20: { timestamp: latestTimestamp, value: 103 },
    })
  );

  assert.equal(result.signal, StrategySignal.NO_TRADE);
  assert.equal(result.confidence, 0);
  assert.match(result.reasons[0], /No EMA crossover/);
});

test('accepts ADX exactly at the 20 threshold', () => {
  const result = strategy.evaluate(
    createInput({ latestAdx14: { timestamp: latestTimestamp, adx: 20, plusDI: 30, minusDI: 10 } })
  );

  assert.equal(result.signal, StrategySignal.BUY_CE);
  assert.equal(result.confidence, 100);
});

test('does not mutate pre-calculated indicator input', () => {
  const input = createInput();
  const originalInput = {
    ...input,
    previousEma20: { ...input.previousEma20 },
    latestEma20: { ...input.latestEma20 },
    previousEma50: { ...input.previousEma50 },
    latestEma50: { ...input.latestEma50 },
    latestRsi14: { ...input.latestRsi14 },
    latestAdx14: { ...input.latestAdx14 },
    latestSuperTrend: { ...input.latestSuperTrend },
  };

  strategy.evaluate(input);

  assert.deepEqual(input, originalInput);
});
