import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionOutcomeEvaluationRequest } from '../modules/options/dto/option-outcome.dto';
import OptionOutcomeEvaluatorService from '../modules/options/services/option-outcome-evaluator.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

const evaluator = new OptionOutcomeEvaluatorService();
const signalTimestamp = new Date('2026-07-15T09:15:00+05:30');

function createContract(): OptionContract {
  return {
    instrumentKey: 'NSE_FO|57344|21-07-2026',
    tradingSymbol: 'NIFTY 24100 CE 21 JUL 26',
    underlying: 'NIFTY',
    strikePrice: 24100,
    expiry: new Date('2026-07-21T00:00:00+05:30'),
    optionType: 'CE',
    exchange: 'NSE',
    segment: 'NSE_FO',
  };
}

function createCandles(
  count = 61,
  valueAtMinute: (minute: number) => number = (minute) => 100 + minute
): ExpiredOptionCandleDto[] {
  return Array.from({ length: count }, (_, minute) => {
    const close = valueAtMinute(minute);

    return {
      instrumentKey: createContract().instrumentKey,
      candleTime: new Date(signalTimestamp.getTime() + minute * 60_000),
      open: close,
      high: close + 2,
      low: close - 1,
      close,
      volume: 100n,
    };
  });
}

function createRequest(overrides: Partial<OptionOutcomeEvaluationRequest> = {}): OptionOutcomeEvaluationRequest {
  return {
    signalTimestamp,
    signalType: StrategySignal.BUY_CE,
    selectedContract: createContract(),
    candles: createCandles(),
    ...overrides,
  };
}

test('evaluates a rising option premium', () => {
  const outcome = evaluator.evaluate(createRequest());

  assert.equal(outcome.entryPremium, 100);
  assert.equal(outcome.at5m?.change, 5);
  assert.equal(outcome.at60m?.change, 60);
});

test('evaluates a falling option premium for a bought option', () => {
  const outcome = evaluator.evaluate(createRequest({ candles: createCandles(61, (minute) => 100 - minute) }));

  assert.equal(outcome.at5m?.change, -5);
  assert.equal(outcome.at60m?.change, -60);
});

test('aligns each requested 5, 15, 30, and 60-minute horizon exactly', () => {
  const outcome = evaluator.evaluate(createRequest());

  assert.deepEqual(
    [outcome.at5m?.premium, outcome.at15m?.premium, outcome.at30m?.premium, outcome.at60m?.premium],
    [105, 115, 130, 160]
  );
});

test('calculates maximum favorable excursion from post-signal option highs', () => {
  const candles = createCandles();
  candles[30] = { ...candles[30], high: 180 };

  const outcome = evaluator.evaluate(createRequest({ candles }));

  assert.equal(outcome.mfe, 80);
});

test('calculates maximum adverse excursion from post-signal option lows', () => {
  const candles = createCandles();
  candles[15] = { ...candles[15], low: 70 };

  const outcome = evaluator.evaluate(createRequest({ candles }));

  assert.equal(outcome.mae, 30);
});

test('calculates premium and excursion percentages', () => {
  const candles = createCandles(61, () => 100);
  candles[5] = { ...candles[5], close: 110, high: 112, low: 109 };
  candles[60] = { ...candles[60], high: 150, low: 80 };

  const outcome = evaluator.evaluate(createRequest({ candles }));

  assert.equal(outcome.at5m?.changePercent, 10);
  assert.equal(outcome.mfePercent, 50);
  assert.equal(outcome.maePercent, 20);
});

test('returns null horizons near the end of a trading session', () => {
  const nearCloseSignal = new Date('2026-07-15T15:25:00+05:30');
  const candles = Array.from({ length: 5 }, (_, minute) => ({
    instrumentKey: createContract().instrumentKey,
    candleTime: new Date(nearCloseSignal.getTime() + minute * 60_000),
    open: 100,
    high: 102,
    low: 99,
    close: 100 + minute,
    volume: 100n,
  }));

  const outcome = evaluator.evaluate(createRequest({ signalTimestamp: nearCloseSignal, candles }));

  assert.equal(outcome.at5m, null);
  assert.equal(outcome.at15m, null);
  assert.equal(outcome.at30m, null);
  assert.equal(outcome.at60m, null);
});

test('fails clearly when the exact signal candle is missing', () => {
  const candles = createCandles().slice(1);

  assert.throws(
    () => evaluator.evaluate(createRequest({ candles })),
    /cannot find a candle/
  );
});

test('fails for an invalid zero entry premium', () => {
  const candles = createCandles();
  candles[0] = { ...candles[0], open: 0, high: 1, low: 0, close: 0 };

  assert.throws(
    () => evaluator.evaluate(createRequest({ candles })),
    /positive finite entry premium/
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
