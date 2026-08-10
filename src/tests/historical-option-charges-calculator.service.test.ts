import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HistoricalOptionBrokerageConfiguration,
  HistoricalOptionChargesCalculationRequest,
  HistoricalOptionStatutoryChargesRateConfiguration,
} from '../modules/options/dto/historical-option-charges.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';

const calculator = new HistoricalOptionChargesCalculatorService();

function zeroStatutoryConfiguration(
  overrides: Partial<HistoricalOptionStatutoryChargesRateConfiguration> = {}
): HistoricalOptionStatutoryChargesRateConfiguration {
  return {
    id: 'test-zero-statutory-rates',
    effectiveFrom: '2026-01-01',
    stt: { side: 'SELL', rate: { value: 0, unit: 'DECIMAL_FRACTION' } },
    exchangeTransactionChargeRate: { value: 0, unit: 'DECIMAL_FRACTION' },
    sebiTurnoverRate: { value: 0, unit: 'DECIMAL_FRACTION' },
    gst: { rate: { value: 0, unit: 'PERCENT' }, taxableComponents: ['BROKERAGE'] },
    stampDuty: { side: 'BUY', rate: { value: 0, unit: 'DECIMAL_FRACTION' } },
    ...overrides,
  };
}

function brokerageConfiguration(
  overrides: Partial<HistoricalOptionBrokerageConfiguration> = {}
): HistoricalOptionBrokerageConfiguration {
  return {
    id: 'test-standard-brokerage',
    effectiveFrom: '2026-01-01',
    brokeragePerExecutedOrder: 0,
    numberOfOrders: 2,
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<HistoricalOptionChargesCalculationRequest> = {}
): HistoricalOptionChargesCalculationRequest {
  return {
    tradeDate: new Date('2026-07-15T09:15:00+05:30'),
    entryPremium: 100,
    exitPremium: 120,
    quantity: 50,
    statutoryRateConfiguration: zeroStatutoryConfiguration(),
    brokerageConfiguration: brokerageConfiguration(),
    ...overrides,
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${actual} to equal ${expected}`);
}

test('calculates zero charges from zero statutory and brokerage configurations', () => {
  const result = calculator.calculate(createRequest());

  assert.equal(result.totalCharges, 0);
  assert.equal(result.entryTurnover, 5000);
  assert.equal(result.exitTurnover, 6000);
  assert.equal(result.totalTurnover, 11000);
});

test('calculates Standard brokerage at 20 rupees per executed order', () => {
  const result = calculator.calculate(createRequest({
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 20 }),
  }));

  assert.equal(result.brokerage, 40);
});

test('calculates Plus brokerage at 30 rupees per executed order', () => {
  const result = calculator.calculate(createRequest({
    brokerageConfiguration: brokerageConfiguration({ id: 'plus', brokeragePerExecutedOrder: 30 }),
  }));

  assert.equal(result.brokerage, 60);
  assert.equal(result.brokerageConfigurationId, 'plus');
});

test('keeps statutory charges unchanged across brokerage plans', () => {
  const statutoryRateConfiguration = zeroStatutoryConfiguration({
    stt: { side: 'SELL', rate: { value: 1, unit: 'PERCENT' } },
    exchangeTransactionChargeRate: { value: 1, unit: 'PERCENT' },
    sebiTurnoverRate: { value: 10, unit: 'PER_CRORE' },
    gst: { rate: { value: 0, unit: 'PERCENT' }, taxableComponents: ['BROKERAGE'] },
    stampDuty: { side: 'BUY', rate: { value: 1, unit: 'PERCENT' } },
  });
  const standard = calculator.calculate(createRequest({
    statutoryRateConfiguration,
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 20 }),
  }));
  const plus = calculator.calculate(createRequest({
    statutoryRateConfiguration,
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 30 }),
  }));

  assert.equal(standard.brokerage, 40);
  assert.equal(plus.brokerage, 60);
  assert.equal(standard.stt, plus.stt);
  assert.equal(standard.exchangeTransactionCharges, plus.exchangeTransactionCharges);
  assert.equal(standard.sebiCharges, plus.sebiCharges);
  assert.equal(standard.stampDuty, plus.stampDuty);
});

test('changes GST when a configured brokerage plan changes', () => {
  const statutoryRateConfiguration = zeroStatutoryConfiguration({
    gst: { rate: { value: 18, unit: 'PERCENT' }, taxableComponents: ['BROKERAGE'] },
  });
  const standard = calculator.calculate(createRequest({
    statutoryRateConfiguration,
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 20 }),
  }));
  const plus = calculator.calculate(createRequest({
    statutoryRateConfiguration,
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 30 }),
  }));

  assertClose(standard.gst, 7.2);
  assertClose(plus.gst, 10.8);
});

test('calculates sell-side STT from exit turnover only', () => {
  const result = calculator.calculate(createRequest({
    statutoryRateConfiguration: zeroStatutoryConfiguration({
      stt: { side: 'SELL', rate: { value: 1, unit: 'PERCENT' } },
    }),
  }));

  assert.equal(result.stt, 60);
});

test('calculates buy-side stamp duty from entry turnover only', () => {
  const result = calculator.calculate(createRequest({
    statutoryRateConfiguration: zeroStatutoryConfiguration({
      stampDuty: { side: 'BUY', rate: { value: 1, unit: 'PERCENT' } },
    }),
  }));

  assert.equal(result.stampDuty, 50);
});

test('calculates exchange and SEBI charges from their configured turnover bases', () => {
  const result = calculator.calculate(createRequest({
    statutoryRateConfiguration: zeroStatutoryConfiguration({
      exchangeTransactionChargeRate: { value: 0.5, unit: 'PERCENT' },
      sebiTurnoverRate: { value: 10, unit: 'PER_CRORE' },
    }),
  }));

  assert.equal(result.exchangeTransactionCharges, 55);
  assertClose(result.sebiCharges, 0.011);
});

test('calculates a complete configured round trip including other charges', () => {
  const result = calculator.calculate(createRequest({
    statutoryRateConfiguration: zeroStatutoryConfiguration({
      id: 'full-statutory-configuration',
      effectiveTo: '2026-12-31',
      stt: { side: 'SELL', rate: { value: 1, unit: 'PERCENT' } },
      exchangeTransactionChargeRate: { value: 1, unit: 'PERCENT' },
      sebiTurnoverRate: { value: 1, unit: 'PER_CRORE' },
      gst: { rate: { value: 10, unit: 'PERCENT' }, taxableComponents: ['BROKERAGE', 'EXCHANGE_TRANSACTION_CHARGES', 'SEBI_CHARGES', 'OTHER_CHARGES'] },
      stampDuty: { side: 'BUY', rate: { value: 1, unit: 'PERCENT' } },
      otherCharges: [
        { id: 'flat', kind: 'FLAT_RUPEE', amount: 5 },
        { id: 'sell-rate', kind: 'TURNOVER_RATE', side: 'SELL', rate: { value: 1, unit: 'PERCENT' } },
      ],
    }),
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 10 }),
  }));

  assert.equal(result.brokerage, 20);
  assert.equal(result.stt, 60);
  assert.equal(result.exchangeTransactionCharges, 110);
  assertClose(result.sebiCharges, 0.0011);
  assert.equal(result.stampDuty, 50);
  assert.equal(result.otherCharges, 65);
  assertClose(result.gst, 19.50011);
  assertClose(result.totalCharges, 324.50121);
  assert.equal(result.statutoryRateConfigurationId, 'full-statutory-configuration');
});

test('rejects a trade date outside the statutory configuration effective range', () => {
  assert.throws(
    () => calculator.calculate(createRequest({
      statutoryRateConfiguration: zeroStatutoryConfiguration({ effectiveTo: '2026-07-14' }),
    })),
    /is not effective/
  );
});

test('rejects brokerage configurations outside their effective date range', () => {
  assert.throws(
    () => calculator.calculate(createRequest({
      brokerageConfiguration: brokerageConfiguration({ effectiveTo: '2026-07-14' }),
    })),
    /brokerage configuration .* is not effective/
  );
});

test('rejects invalid brokerage configurations', () => {
  assert.throws(
    () => calculator.calculate(createRequest({
      brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: -1 }),
    })),
    /brokeragePerExecutedOrder/
  );
  assert.throws(
    () => calculator.calculate(createRequest({
      brokerageConfiguration: brokerageConfiguration({ numberOfOrders: 0 }),
    })),
    /numberOfOrders/
  );
});

test('rejects invalid statutory rate values, premiums, and quantity', () => {
  assert.throws(
    () => calculator.calculate(createRequest({
      statutoryRateConfiguration: zeroStatutoryConfiguration({
        exchangeTransactionChargeRate: { value: -1, unit: 'PERCENT' },
      }),
    })),
    /non-negative finite value/
  );
  assert.throws(() => calculator.calculate(createRequest({ entryPremium: 0 })), /positive finite entry premium/);
  assert.throws(() => calculator.calculate(createRequest({ exitPremium: -1 })), /non-negative finite exit premium/);
  assert.throws(() => calculator.calculate(createRequest({ quantity: 1.5 })), /positive integer quantity/);
});

test('does not mutate the input request or either configuration', () => {
  const request = createRequest({
    statutoryRateConfiguration: zeroStatutoryConfiguration({
      otherCharges: [{ id: 'flat', kind: 'FLAT_RUPEE', amount: 2 }],
    }),
    brokerageConfiguration: brokerageConfiguration({ brokeragePerExecutedOrder: 20 }),
  });
  const original = structuredClone(request);

  calculator.calculate(request);

  assert.deepEqual(request, original);
});
