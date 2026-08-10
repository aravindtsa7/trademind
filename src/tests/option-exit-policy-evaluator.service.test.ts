import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationRequest } from '../modules/options/dto/option-exit-policy.dto';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';

const evaluator = new OptionExitPolicyEvaluatorService();
const signalTimestamp = new Date('2026-07-15T09:15:00+05:30');

function createCandles(count = 61): ExpiredOptionCandleDto[] {
  return Array.from({ length: count }, (_, minute) => ({
    instrumentKey: 'NSE_FO|57344|21-07-2026',
    candleTime: new Date(signalTimestamp.getTime() + minute * 60_000),
    open: 100,
    high: 101,
    low: 99,
    close: 100 + minute,
    volume: 100n,
  }));
}

function createRequest(overrides: Partial<OptionExitPolicyEvaluationRequest> = {}): OptionExitPolicyEvaluationRequest {
  return {
    signalTimestamp,
    entryPremium: 100,
    candles: createCandles(),
    exitPolicy: { type: 'FIXED_TIME', holdingMinutes: 5 },
    ...overrides,
  };
}

test('exits a fixed 5-minute policy at the exact horizon close', () => {
  const result = evaluator.evaluate(createRequest());

  assert.equal(result.exitReason, 'TIME_EXIT');
  assert.equal(result.exitPremium, 105);
  assert.equal(result.holdingMinutes, 5);
});

test('exits a fixed 15-minute policy at the exact horizon close', () => {
  const result = evaluator.evaluate(createRequest({ exitPolicy: { type: 'FIXED_TIME', holdingMinutes: 15 } }));

  assert.equal(result.exitPremium, 115);
  assert.equal(result.holdingMinutes, 15);
});

test('exits when the target is hit', () => {
  const candles = createCandles();
  candles[3] = { ...candles[3], high: 111, low: 102 };

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 60 },
  }));

  assert.equal(result.exitReason, 'TARGET');
  assert.ok(Math.abs((result.exitPremium ?? 0) - 110) < 1e-10);
  assert.equal(result.holdingMinutes, 3);
});

test('exits when the stop loss is hit', () => {
  const candles = createCandles();
  candles[2] = { ...candles[2], high: 101, low: 94 };

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 60 },
  }));

  assert.equal(result.exitReason, 'STOP_LOSS');
  assert.equal(result.exitPremium, 95);
  assert.equal(result.holdingMinutes, 2);
});

test('uses the maximum-holding close for a time exit', () => {
  const candles = createCandles(16).map((candle) => ({ ...candle, high: 105, low: 96, close: 103 }));

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 15 },
  }));

  assert.equal(result.exitReason, 'TIME_EXIT');
  assert.equal(result.exitPremium, 103);
  assert.equal(result.holdingMinutes, 15);
});

test('keeps a target exit when a later candle touches the stop', () => {
  const candles = createCandles();
  candles[2] = { ...candles[2], high: 111, low: 102 };
  candles[3] = { ...candles[3], high: 101, low: 94 };

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 60 },
  }));

  assert.equal(result.exitReason, 'TARGET');
});

test('keeps a stop exit when a later candle touches the target', () => {
  const candles = createCandles();
  candles[2] = { ...candles[2], high: 101, low: 94 };
  candles[3] = { ...candles[3], high: 111, low: 102 };

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 60 },
  }));

  assert.equal(result.exitReason, 'STOP_LOSS');
});

test('returns AMBIGUOUS when one candle touches both target and stop', () => {
  const candles = createCandles();
  candles[4] = { ...candles[4], high: 111, low: 94 };

  const result = evaluator.evaluate(createRequest({
    candles,
    exitPolicy: { type: 'TARGET_STOP', targetPercent: 10, stopLossPercent: 5, maximumHoldingMinutes: 60 },
  }));

  assert.equal(result.exitReason, 'AMBIGUOUS');
  assert.equal(result.exitTimestamp?.getTime(), candles[4].candleTime.getTime());
  assert.equal(result.ambiguous, true);
  assert.equal(result.exitPremium, null);
});

test('does not cross into the next trading session', () => {
  const nearClose = new Date('2026-07-15T15:25:00+05:30');
  const candles = [
    {
      instrumentKey: 'key', candleTime: nearClose, open: 100, high: 101, low: 99, close: 100, volume: 1n,
    },
    {
      instrumentKey: 'key', candleTime: new Date('2026-07-16T09:15:00+05:30'), open: 100, high: 120, low: 90, close: 110, volume: 1n,
    },
  ];

  const result = evaluator.evaluate(createRequest({
    signalTimestamp: nearClose,
    candles,
    exitPolicy: { type: 'FIXED_TIME', holdingMinutes: 5 },
  }));

  assert.equal(result.exitReason, 'UNAVAILABLE');
  assert.equal(result.unavailable, true);
});

test('returns UNAVAILABLE when the fixed horizon candle is missing', () => {
  const result = evaluator.evaluate(createRequest({ candles: createCandles(5) }));

  assert.equal(result.exitReason, 'UNAVAILABLE');
  assert.equal(result.exitTimestamp, null);
});

test('rejects invalid target-stop configuration', () => {
  assert.throws(
    () => evaluator.evaluate(createRequest({
      exitPolicy: { type: 'TARGET_STOP', targetPercent: 0, stopLossPercent: 5, maximumHoldingMinutes: 15 },
    })),
    /configuration is invalid/
  );
});

test('does not mutate supplied candles', () => {
  const candles = createCandles();
  const before = candles.map((candle) => ({ ...candle, candleTime: candle.candleTime.getTime() }));

  evaluator.evaluate(createRequest({ candles }));

  assert.deepEqual(
    candles.map((candle) => ({ ...candle, candleTime: candle.candleTime.getTime() })),
    before
  );
});
