import assert from 'node:assert/strict';
import test from 'node:test';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { OptionContract } from '../modules/options/types';
import {
  chooseHistoricalOptionExpiry,
  deduplicateDirectionalOptionSessions,
  optionDirectionForResearch,
} from './helpers/v3-option-cache-diagnostics';

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    instrumentKey: 'BSE_FO|SENSEX|75000|CE',
    tradingSymbol: 'SENSEX26AUG75000CE',
    underlying: 'SENSEX',
    strikePrice: 75000,
    expiry: new Date('2026-08-06T00:00:00+05:30'),
    optionType: 'CE',
    exchange: 'BSE',
    segment: 'FO',
    ...overrides,
  };
}

test('maps SENSEX V3 directions to their historical option sides', () => {
  assert.equal(optionDirectionForResearch('DOWN'), 'PE');
  assert.equal(optionDirectionForResearch('UP'), 'CE');
});

test('uses the first authoritative historical expiry on or after the SENSEX signal date', () => {
  assert.equal(chooseHistoricalOptionExpiry(['2026-08-06', '2026-07-30', '2026-08-13'], '2026-08-04'), '2026-08-06');
  assert.throws(() => chooseHistoricalOptionExpiry(['2026-08-03'], '2026-08-04'), /on or after/);
});

test('selects exact historical SENSEX ATM contracts without crossing CE and PE directions', () => {
  const selector = new OptionContractSelectorService();
  const contracts = [
    contract({ instrumentKey: 'ce-74900', strikePrice: 74900 }),
    contract({ instrumentKey: 'ce-75000', strikePrice: 75000 }),
    contract({ instrumentKey: 'pe-75000', tradingSymbol: 'SENSEX26AUG75000PE', strikePrice: 75000, optionType: 'PE' }),
  ];
  const ce = selector.select({ underlying: 'SENSEX', spotPrice: 75020, signal: StrategySignal.BUY_CE, timestamp: new Date('2026-08-04T10:00:00+05:30'), contracts });
  const pe = selector.select({ underlying: 'SENSEX', spotPrice: 75020, signal: StrategySignal.BUY_PE, timestamp: new Date('2026-08-04T10:00:00+05:30'), contracts });
  assert.deepEqual([ce.instrumentKey, ce.optionType], ['ce-75000', 'CE']);
  assert.deepEqual([pe.instrumentKey, pe.optionType], ['pe-75000', 'PE']);
});

test('deduplicates exact SENSEX contract/date requirements while preserving direction isolation', () => {
  const sessions = deduplicateDirectionalOptionSessions([
    { instrumentKey: 'BSE_FO|PE', tradingDate: '2026-08-04', direction: 'PE', locallyAvailableCandleCount: 0, completenessState: 'MISSING' },
    { instrumentKey: 'BSE_FO|PE', tradingDate: '2026-08-04', direction: 'PE', locallyAvailableCandleCount: 0, completenessState: 'MISSING' },
    { instrumentKey: 'BSE_FO|CE', tradingDate: '2026-08-04', direction: 'CE', locallyAvailableCandleCount: 0, completenessState: 'MISSING' },
    { instrumentKey: 'BSE_FO|PE', tradingDate: '2026-08-04', direction: 'CE', locallyAvailableCandleCount: 0, completenessState: 'MISSING' },
  ]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.find((session) => session.instrumentKey === 'BSE_FO|PE')?.directions, ['PE', 'CE']);
  assert.deepEqual(sessions.find((session) => session.instrumentKey === 'BSE_FO|CE')?.directions, ['CE']);
});
