import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OptionTradeCharges,
  OptionTradePnlCalculationRequest,
} from '../modules/options/dto/option-trade-pnl.dto';
import OptionTradePnlCalculatorService from '../modules/options/services/option-trade-pnl-calculator.service';

const calculator = new OptionTradePnlCalculatorService();

function zeroCharges(): OptionTradeCharges {
  return {
    brokerage: 0,
    stt: 0,
    exchangeTransactionCharges: 0,
    sebiCharges: 0,
    gst: 0,
    stampDuty: 0,
    otherCharges: 0,
  };
}

function createRequest(overrides: Partial<OptionTradePnlCalculationRequest> = {}): OptionTradePnlCalculationRequest {
  return {
    entryPremium: 100,
    exitPremium: 120,
    quantity: 50,
    charges: zeroCharges(),
    ...overrides,
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${actual} to equal ${expected}`);
}

test('calculates a profitable trade without charges', () => {
  const result = calculator.calculate(createRequest());

  assert.equal(result.grossPnl, 1000);
  assert.equal(result.totalCharges, 0);
  assert.equal(result.netPnl, 1000);
});

test('calculates a losing trade without charges', () => {
  const result = calculator.calculate(createRequest({ exitPremium: 80 }));

  assert.equal(result.grossPnl, -1000);
  assert.equal(result.netPnl, -1000);
});

test('deducts supplied charges from a profitable trade', () => {
  const charges = {
    brokerage: 20,
    stt: 10,
    exchangeTransactionCharges: 5,
    sebiCharges: 1,
    gst: 3,
    stampDuty: 2,
    otherCharges: 4,
  };
  const result = calculator.calculate(createRequest({ charges }));

  assert.equal(result.totalCharges, 45);
  assert.equal(result.netPnl, 955);
  assert.deepEqual(result.charges, charges);
});

test('allows charges to turn a small gross profit into a net loss', () => {
  const result = calculator.calculate(createRequest({
    exitPremium: 100.1,
    charges: { ...zeroCharges(), brokerage: 10 },
  }));

  assertClose(result.grossPnl, 5);
  assertClose(result.netPnl, -5);
});

test('calculates entry and exit values from premiums and quantity', () => {
  const result = calculator.calculate(createRequest({ entryPremium: 125, exitPremium: 140, quantity: 40 }));

  assert.equal(result.entryValue, 5000);
  assert.equal(result.exitValue, 5600);
});

test('calculates gross return percentage from entry value', () => {
  const result = calculator.calculate(createRequest());

  assertClose(result.grossReturnPercent, 20);
});

test('calculates net return percentage after charges', () => {
  const result = calculator.calculate(createRequest({ charges: { ...zeroCharges(), brokerage: 100 } }));

  assertClose(result.netReturnPercent, 18);
});

test('accepts an explicit all-zero charge breakdown', () => {
  const result = calculator.calculate(createRequest({ charges: zeroCharges() }));

  assert.equal(result.totalCharges, 0);
});

test('rejects an invalid entry premium', () => {
  assert.throws(() => calculator.calculate(createRequest({ entryPremium: 0 })), /positive finite entry premium/);
});

test('rejects an invalid exit premium', () => {
  assert.throws(() => calculator.calculate(createRequest({ exitPremium: -1 })), /non-negative finite exit premium/);
});

test('rejects an invalid quantity', () => {
  assert.throws(() => calculator.calculate(createRequest({ quantity: 1.5 })), /positive integer quantity/);
});

test('rejects a negative charge', () => {
  assert.throws(
    () => calculator.calculate(createRequest({ charges: { ...zeroCharges(), stt: -0.01 } })),
    /non-negative finite stt charge/
  );
});

test('does not mutate the input request or charges', () => {
  const request = createRequest({ charges: { ...zeroCharges(), brokerage: 12 } });
  const original = structuredClone(request);

  calculator.calculate(request);

  assert.deepEqual(request, original);
});
