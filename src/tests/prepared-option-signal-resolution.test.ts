import assert from 'node:assert/strict';
import test from 'node:test';
import { OptionContract } from '../modules/options/types';
import { prepareOptionSignalResolution } from './helpers/prepared-option-signal-resolution';

const contract: OptionContract = { instrumentKey: 'NSE_FO|123', tradingSymbol: 'NIFTY26JUL25000PE', underlying: 'NIFTY', strikePrice: 25_000, expiry: new Date('2026-07-30T00:00:00+05:30'), optionType: 'PE', exchange: 'NSE', segment: 'FO', lotSize: 75 };

test('one selected contract is reused unchanged for preload and signal resolution', () => {
  const signal = { timestamp: new Date('2026-07-15T10:00:00+05:30'), date: '2026-07-15', spotPrice: 25_012.5 }; let selections = 0;
  const selectAtmPe = (): OptionContract => { selections += 1; return contract; };
  const prepared = prepareOptionSignalResolution(signal, selectAtmPe(), signal.date);
  const preloadRequest = { instrumentKey: prepared.instrumentKey, tradingDate: prepared.tradingDate, metadata: prepared.metadata };
  const resolutionResult = { signal: prepared.signal, selectedContract: prepared.selectedContract, instrumentKey: prepared.instrumentKey, tradingDate: prepared.tradingDate };

  assert.equal(selections, 1);
  assert.strictEqual(prepared.selectedContract, contract);
  assert.strictEqual(resolutionResult.selectedContract, contract);
  assert.strictEqual(resolutionResult.signal, signal);
  assert.deepEqual(preloadRequest, { instrumentKey: contract.instrumentKey, tradingDate: signal.date, metadata: { tradingSymbol: contract.tradingSymbol, optionType: contract.optionType, strikePrice: contract.strikePrice, expiry: contract.expiry } });
  assert.deepEqual(resolutionResult, { signal, selectedContract: contract, instrumentKey: contract.instrumentKey, tradingDate: signal.date });
});
