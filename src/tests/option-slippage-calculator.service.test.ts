import assert from 'node:assert/strict';
import test from 'node:test';
import { OptionSlippageCalculationRequest } from '../modules/options/dto/option-slippage.dto';
import OptionSlippageCalculatorService from '../modules/options/services/option-slippage-calculator.service';

const calculator = new OptionSlippageCalculatorService();

function request(overrides: Partial<OptionSlippageCalculationRequest> = {}): OptionSlippageCalculationRequest {
  return {
    entryPremium: 100,
    exitPremium: 120,
    slippage: { entrySlippagePercent: 0, exitSlippagePercent: 0 },
    ...overrides,
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${actual} to equal ${expected}`);
}

test('applies zero slippage without changing premiums', () => {
  const result = calculator.calculate(request());

  assert.equal(result.adjustedEntryPremium, 100);
  assert.equal(result.adjustedExitPremium, 120);
  assert.equal(result.entrySlippageAmount, 0);
  assert.equal(result.exitSlippageAmount, 0);
});

test('applies entry slippage only', () => {
  const result = calculator.calculate(request({ slippage: { entrySlippagePercent: 2, exitSlippagePercent: 0 } }));

  assert.equal(result.adjustedEntryPremium, 102);
  assert.equal(result.adjustedExitPremium, 120);
  assert.equal(result.entrySlippageAmount, 2);
});

test('applies exit slippage only', () => {
  const result = calculator.calculate(request({ slippage: { entrySlippagePercent: 0, exitSlippagePercent: 2 } }));

  assert.equal(result.adjustedEntryPremium, 100);
  assert.equal(result.adjustedExitPremium, 117.6);
  assertClose(result.exitSlippageAmount, 2.4);
});

test('applies entry and exit slippage together', () => {
  const result = calculator.calculate(request({ slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } }));

  assert.equal(result.adjustedEntryPremium, 101);
  assertClose(result.adjustedExitPremium, 118.8);
  assert.equal(result.entrySlippagePercent, 1);
  assert.equal(result.exitSlippagePercent, 1);
});

test('applies deterministic slippage to a profitable option trade', () => {
  const result = calculator.calculate(request({ entryPremium: 100, exitPremium: 130, slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } }));

  assert.equal(result.adjustedEntryPremium, 101);
  assertClose(result.adjustedExitPremium, 128.7);
});

test('applies deterministic slippage to a losing option trade', () => {
  const result = calculator.calculate(request({ entryPremium: 100, exitPremium: 80, slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } }));

  assert.equal(result.adjustedEntryPremium, 101);
  assert.equal(result.adjustedExitPremium, 79.2);
});

test('calculates one percent slippage amounts', () => {
  const result = calculator.calculate(request({ entryPremium: 250, exitPremium: 150, slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } }));

  assert.equal(result.entrySlippageAmount, 2.5);
  assert.equal(result.exitSlippageAmount, 1.5);
});

test('rejects negative slippage percentages and negative adjusted exits', () => {
  assert.throws(
    () => calculator.calculate(request({ slippage: { entrySlippagePercent: -1, exitSlippagePercent: 0 } })),
    /non-negative and finite/
  );
  assert.throws(
    () => calculator.calculate(request({ slippage: { entrySlippagePercent: 0, exitSlippagePercent: 101 } })),
    /negative adjusted exit premium/
  );
});

test('rejects invalid premiums', () => {
  assert.throws(() => calculator.calculate(request({ entryPremium: 0 })), /positive finite entry premium/);
  assert.throws(() => calculator.calculate(request({ exitPremium: -1 })), /non-negative finite exit premium/);
});

test('does not mutate the input request', () => {
  const input = request({ slippage: { entrySlippagePercent: 1, exitSlippagePercent: 2 } });
  const before = structuredClone(input);

  calculator.calculate(input);

  assert.deepEqual(input, before);
});
