import assert from 'node:assert/strict';
import test from 'node:test';
import GrowwHistoricalContractProviderService, { GROWW_OPTION_DISCOVERY_START_DATE } from './groww-historical-contract-provider.service';
import { GrowwSymbolParseFailureReason } from './groww-contract-symbol-parser';
import { HistoricalOptionType } from '../../domain/historical-asset.types';
import { HistoricalContractState } from '../../domain/historical-option-identity.types';
import { toCatalogRecord } from '../../domain/historical-option-contract-catalog.types';
import { HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import GrowwHistoricalClient from './groww-historical-client';

class FakeGrowwClient {
  expiriesCalls: Array<{ exchange: string; underlyingSymbol: string; year: number; month?: number }> = [];
  contractsCalls: Array<{ exchange: string; underlyingSymbol: string; expiryDate: string }> = [];

  constructor(
    private readonly expiries: string[],
    private readonly contractSymbols: string[]
  ) {}

  async fetchExpiries(params: { exchange: string; underlyingSymbol: string; year: number; month?: number }) {
    this.expiriesCalls.push(params);
    return this.expiries;
  }

  async fetchContracts(params: { exchange: string; underlyingSymbol: string; expiryDate: string }) {
    this.contractsCalls.push(params);
    return this.contractSymbols;
  }
}

function buildAdapter(expiries: string[], contractSymbols: string[]): { adapter: GrowwHistoricalContractProviderService; client: FakeGrowwClient } {
  const client = new FakeGrowwClient(expiries, contractSymbols);
  const adapter = new GrowwHistoricalContractProviderService(client as unknown as GrowwHistoricalClient);
  return { adapter, client };
}

test('capability reports GROWW, option-discovery support, and the documented 2020-01-01 discovery start date only as capability metadata', () => {
  const { adapter } = buildAdapter([], []);
  const capability = adapter.getCapability();

  assert.equal(capability.providerId, HistoricalProviderId.GROWW);
  assert.equal(capability.supportsOptionContractDiscovery, true);
  assert.equal(capability.earliestDocumentedOptionDiscovery, GROWW_OPTION_DISCOVERY_START_DATE);
  assert.equal(capability.earliestDocumentedOptionDiscovery, '2020-01-01');
  assert.equal(capability.supportsOptionCandleAcquisition, false);
  assert.equal(capability.historicalListingStartDateKnown, false);
});

test('discoverContractsForExpiry strictly parses options, separates futures, and retains malformed symbols as typed evidence', async () => {
  const { adapter, client } = buildAdapter(
    [],
    [
      'NSE-NIFTY-06Jan22-17500-CE',
      'NSE-NIFTY-06Jan22-17500-PE',
      'NSE-NIFTY-27Jan22-FUT',
      'NSE-NIFTY-not-a-real-symbol',
    ]
  );

  const outcome = await adapter.discoverContractsForExpiry('2022-01-06');

  assert.equal(client.contractsCalls[0].expiryDate, '2022-01-06');
  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.candidates[0].optionType, HistoricalOptionType.CE);
  assert.equal(outcome.candidates[0].exchangeTradingSymbol, null);
  assert.equal(outcome.candidates[1].optionType, HistoricalOptionType.PE);
  assert.equal(outcome.candidates[1].exchangeTradingSymbol, null);
  assert.equal(outcome.candidates[1].lotSize, null);
  assert.deepEqual(outcome.ignoredFutureSymbols, ['NSE-NIFTY-27Jan22-FUT']);
  assert.equal(outcome.malformedSymbols.length, 1);
  assert.equal(outcome.malformedSymbols[0].rawSymbol, 'NSE-NIFTY-not-a-real-symbol');
  assert.equal(outcome.malformedSymbols[0].reason, GrowwSymbolParseFailureReason.INVALID_SEGMENT_COUNT);
});

test('LIVE-PROVEN: string-only Groww discovery always resolves lotSize/tickSize/exchangeTradingSymbol to null and metadataState to METADATA_INCOMPLETE, never OBSERVED_TRADING/SESSION_COVERED', async () => {
  const { adapter } = buildAdapter([], ['NSE-NIFTY-06Jan22-17200-PE', 'NSE-NIFTY-06Jan22-17700-CE', 'NSE-NIFTY-06Jan22-18250-CE']);
  const outcome = await adapter.discoverContractsForExpiry('2022-01-06');

  assert.equal(outcome.candidates.length, 3);
  for (const candidate of outcome.candidates) {
    assert.equal(candidate.exchangeTradingSymbol, null);
    assert.equal(candidate.lotSize, null);
    assert.equal(candidate.tickSize, null);
    const record = toCatalogRecord(candidate);
    assert.equal(record.metadataState, HistoricalContractState.METADATA_INCOMPLETE);
    assert.notEqual(record.metadataState, HistoricalContractState.OBSERVED_TRADING);
    assert.notEqual(record.metadataState, HistoricalContractState.SESSION_COVERED);
  }
});

test('discoverExpiriesForYearMonth passes exchange/underlying/year/month through to the client unchanged', async () => {
  const { adapter, client } = buildAdapter(['2022-01-06', '2022-01-13'], []);
  const expiries = await adapter.discoverExpiriesForYearMonth(2022, 1);

  assert.deepEqual(expiries, ['2022-01-06', '2022-01-13']);
  assert.deepEqual(client.expiriesCalls[0], { exchange: 'NSE', underlyingSymbol: 'NIFTY', year: 2022, month: 1 });
});

test('B-F1 interface: discoverExpiries(asOfTradingDate) resolves the year from the date and returns valid Dates', async () => {
  const { adapter } = buildAdapter(['2022-01-06', 'not-a-date', '2022-12-30'], []);
  const dates = await adapter.discoverExpiries({ underlyingKey: 'NIFTY', asOfTradingDate: '2022-06-15' });

  assert.equal(dates.length, 2);
  assert.equal(dates[0].getTime(), new Date('2022-01-06T00:00:00+05:30').getTime());
});

test('B-F1 interface: discoverContracts maps down to HistoricalOptionContractIdentity with an empty tradingSymbol when unproven', async () => {
  const { adapter } = buildAdapter([], ['NSE-NIFTY-06Jan22-17500-CE']);
  const identities = await adapter.discoverContracts({ underlyingKey: 'NIFTY', expiry: new Date('2022-01-06T00:00:00+05:30') });

  assert.equal(identities.length, 1);
  assert.equal(identities[0].tradingSymbol, '');
  assert.equal(identities[0].instrumentKey, 'NSE-NIFTY-06Jan22-17500-CE');
});

test('rejects a wrong underlyingKey for both interface methods', async () => {
  const { adapter } = buildAdapter([], []);
  await assert.rejects(adapter.discoverExpiries({ underlyingKey: 'BANKNIFTY', asOfTradingDate: '2022-01-01' }));
  await assert.rejects(adapter.discoverContracts({ underlyingKey: 'BANKNIFTY', expiry: new Date() }));
});
