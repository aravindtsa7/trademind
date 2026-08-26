import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalOptionType } from './historical-asset.types';
import { HistoricalContractState } from './historical-option-identity.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  DiscoveredOptionContractCandidate,
  resolveCatalogMetadataState,
  toCatalogRecord,
} from './historical-option-contract-catalog.types';

function symbolOnlyCandidate(overrides: Partial<DiscoveredOptionContractCandidate> = {}): DiscoveredOptionContractCandidate {
  return {
    provider: HistoricalProviderId.GROWW,
    providerContractId: 'NSE-NIFTY-02Jan25-28500-CE',
    exchange: 'NSE',
    underlyingSymbol: 'NIFTY',
    expiry: new Date('2025-01-02T00:00:00+05:30'),
    strikePrice: 28500,
    optionType: HistoricalOptionType.CE,
    exchangeTradingSymbol: null,
    lotSize: null,
    tickSize: null,
    discoveredAt: new Date('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

test('a symbol-only discovery (no exact historical lot/tick/tradingSymbol) resolves to METADATA_INCOMPLETE, never guessed', () => {
  const state = resolveCatalogMetadataState(symbolOnlyCandidate());
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('a discovery with a full, provider-proven identity resolves to CATALOG_KNOWN', () => {
  const state = resolveCatalogMetadataState(
    symbolOnlyCandidate({ exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: 75, tickSize: 0.05 })
  );
  assert.equal(state, HistoricalContractState.CATALOG_KNOWN);
});

test('missing only lotSize is enough to keep the record METADATA_INCOMPLETE', () => {
  const state = resolveCatalogMetadataState(
    symbolOnlyCandidate({ exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: null, tickSize: 0.05 })
  );
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('missing only tickSize is enough to keep the record METADATA_INCOMPLETE', () => {
  const state = resolveCatalogMetadataState(
    symbolOnlyCandidate({ exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: 75, tickSize: null })
  );
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('missing only exchangeTradingSymbol is enough to keep the record METADATA_INCOMPLETE, even with lot/tick present', () => {
  const state = resolveCatalogMetadataState(symbolOnlyCandidate({ exchangeTradingSymbol: null, lotSize: 75, tickSize: 0.05 }));
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('strong discovery evidence alone can never become OBSERVED_TRADING or SESSION_COVERED -- discovery proves catalog existence only', () => {
  // Even a "complete" discovery (all fields proven) resolves only as far as CATALOG_KNOWN;
  // resolveCatalogMetadataState's return type itself cannot express OBSERVED_TRADING/SESSION_COVERED.
  const state = resolveCatalogMetadataState(
    symbolOnlyCandidate({ exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: 75, tickSize: 0.05 })
  );
  assert.notEqual(state, HistoricalContractState.OBSERVED_TRADING);
  assert.notEqual(state, HistoricalContractState.SESSION_COVERED);
  assert.equal(state, HistoricalContractState.CATALOG_KNOWN);
});

test('toCatalogRecord retains the truthful partial discovery rather than discarding it for incomplete metadata', () => {
  const record = toCatalogRecord(symbolOnlyCandidate());
  assert.equal(record.metadataState, HistoricalContractState.METADATA_INCOMPLETE);
  assert.equal(record.providerContractId, 'NSE-NIFTY-02Jan25-28500-CE');
  assert.equal(record.strikePrice, 28500);
  assert.equal(record.optionType, HistoricalOptionType.CE);
  assert.equal(record.exchangeTradingSymbol, null);
});

test('the providerContractId is never mistaken for a proven exchangeTradingSymbol', () => {
  const record = toCatalogRecord(symbolOnlyCandidate());
  assert.notEqual(record.providerContractId, record.exchangeTradingSymbol);
  assert.equal(record.exchangeTradingSymbol, null);
});
