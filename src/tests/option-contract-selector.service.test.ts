import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionRequest } from '../modules/options/types';

const selector = new OptionContractSelectorService();
const signalTimestamp = new Date('2026-08-10T09:15:00+05:30');
const currentExpiry = new Date('2026-08-10T00:00:00+05:30');
const nextExpiry = new Date('2026-08-13T00:00:00+05:30');
const laterExpiry = new Date('2026-08-20T00:00:00+05:30');
const expiredExpiry = new Date('2026-08-09T00:00:00+05:30');

function createContract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    instrumentKey: 'NSE_FO|NIFTY26AUG24600CE',
    tradingSymbol: 'NIFTY26AUG24600CE',
    underlying: 'NIFTY',
    strikePrice: 24600,
    expiry: nextExpiry,
    optionType: 'CE',
    exchange: 'NSE',
    segment: 'FO',
    ...overrides,
  };
}

function createRequest(overrides: Partial<OptionContractSelectionRequest> = {}): OptionContractSelectionRequest {
  return {
    underlying: 'NIFTY',
    spotPrice: 24624,
    signal: StrategySignal.BUY_CE,
    timestamp: signalTimestamp,
    contracts: [createContract()],
    ...overrides,
  };
}

test('BUY_CE selects a CE contract', () => {
  const result = selector.select(
    createRequest({ contracts: [createContract({ optionType: 'PE' }), createContract({ optionType: 'CE' })] })
  );

  assert.equal(result.optionType, 'CE');
});

test('BUY_PE selects a PE contract', () => {
  const result = selector.select(
    createRequest({
      signal: StrategySignal.BUY_PE,
      contracts: [createContract({ optionType: 'CE' }), createContract({ optionType: 'PE' })],
    })
  );

  assert.equal(result.optionType, 'PE');
});

test('selects the nearest available expiry', () => {
  const result = selector.select(
    createRequest({
      contracts: [
        createContract({ expiry: laterExpiry, strikePrice: 24600 }),
        createContract({ expiry: nextExpiry, strikePrice: 24700 }),
      ],
    })
  );

  assert.equal(result.expiry, nextExpiry);
});

test('ignores expired contracts', () => {
  const result = selector.select(
    createRequest({
      contracts: [
        createContract({ expiry: expiredExpiry, strikePrice: 24600 }),
        createContract({ expiry: currentExpiry, strikePrice: 24700 }),
      ],
    })
  );

  assert.equal(result.expiry, currentExpiry);
});

test('selects the ATM strike at the nearest expiry', () => {
  const result = selector.select(
    createRequest({
      contracts: [
        createContract({ strikePrice: 24550 }),
        createContract({ strikePrice: 24600 }),
        createContract({ strikePrice: 24650 }),
        createContract({ strikePrice: 24700 }),
      ],
    })
  );

  assert.equal(result.strikePrice, 24600);
  assert.equal(result.strikeDistance, 24);
});

test('selects an exact ATM strike when available', () => {
  const result = selector.select(
    createRequest({ spotPrice: 24600, contracts: [createContract({ strikePrice: 24600 })] })
  );

  assert.equal(result.strikePrice, 24600);
  assert.equal(result.strikeDistance, 0);
});

test('chooses the lower strike when equally distant strikes tie', () => {
  const result = selector.select(
    createRequest({
      spotPrice: 24625,
      contracts: [createContract({ strikePrice: 24650 }), createContract({ strikePrice: 24600 })],
    })
  );

  assert.equal(result.strikePrice, 24600);
});

test('does not let lot size affect contract selection', () => {
  const result = selector.select(
    createRequest({
      contracts: [
        createContract({ instrumentKey: 'higher-strike', strikePrice: 24650, lotSize: 65 }),
        createContract({ instrumentKey: 'lower-strike', strikePrice: 24600, lotSize: 1 }),
      ],
    })
  );

  assert.equal(result.instrumentKey, 'lower-strike');
  assert.equal(result.strikePrice, 24600);
});

test('ignores contracts for different underlyings', () => {
  const result = selector.select(
    createRequest({
      contracts: [
        createContract({ underlying: 'BANKNIFTY', strikePrice: 24600 }),
        createContract({ underlying: 'NIFTY', strikePrice: 24700 }),
      ],
    })
  );

  assert.equal(result.underlying, 'NIFTY');
  assert.equal(result.strikePrice, 24700);
});

test('fails for an invalid spot price', () => {
  assert.throws(() => selector.select(createRequest({ spotPrice: 0 })), /positive finite spot price/);
});

test('fails for an invalid timestamp', () => {
  assert.throws(
    () => selector.select(createRequest({ timestamp: new Date('invalid') })),
    /valid timestamp/
  );
});

test('fails when contracts are empty', () => {
  assert.throws(() => selector.select(createRequest({ contracts: [] })), /at least one contract/);
});

test('fails when no contracts match the requested option type', () => {
  assert.throws(
    () => selector.select(createRequest({ contracts: [createContract({ optionType: 'PE' })] })),
    /No CE option contracts/
  );
});

test('fails when no non-expired expiry exists', () => {
  assert.throws(
    () => selector.select(createRequest({ contracts: [createContract({ expiry: expiredExpiry })] })),
    /No non-expired option expiry/
  );
});

test('does not mutate supplied contracts', () => {
  const contracts = [
    createContract({ instrumentKey: 'second', strikePrice: 24650 }),
    createContract({ instrumentKey: 'first', strikePrice: 24600 }),
  ];
  const before = contracts.map((contract) => ({ ...contract, expiry: contract.expiry.getTime() }));

  selector.select(createRequest({ contracts }));

  assert.deepEqual(
    contracts.map((contract) => ({ ...contract, expiry: contract.expiry.getTime() })),
    before
  );
});
