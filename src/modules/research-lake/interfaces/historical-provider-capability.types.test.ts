import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalProviderCapability, HistoricalProviderId } from './historical-provider-capability.types';

test('a provider capability can express three distinct historical horizons without ambiguity', () => {
  const capability: HistoricalProviderCapability = {
    providerId: HistoricalProviderId.UPSTOX,
    earliestDocumentedUnderlyingHistory: '2022-01-01',
    earliestDocumentedOptionDiscovery: '2024-10-03',
    earliestDocumentedOptionCandleHistory: '2025-06-05',
    supportsOptionContractDiscovery: true,
    supportsOptionCandleAcquisition: true,
    supportedIntervals: ['1minute'],
    maximumRequestDateSpanDays: 30,
    contractMetadataIncludesLotSize: true,
    historicalListingStartDateKnown: false,
    rateLimitPolicy: { policyId: 'UPSTOX_DEFAULT' },
  };

  assert.equal(capability.earliestDocumentedUnderlyingHistory, '2022-01-01');
  assert.equal(capability.earliestDocumentedOptionDiscovery, '2024-10-03');
  assert.equal(capability.earliestDocumentedOptionCandleHistory, '2025-06-05');
  assert.notEqual(capability.earliestDocumentedUnderlyingHistory, capability.earliestDocumentedOptionDiscovery);
  assert.notEqual(capability.earliestDocumentedOptionDiscovery, capability.earliestDocumentedOptionCandleHistory);
});

test('each horizon is independently representable as null (undocumented) regardless of the others', () => {
  const capability: HistoricalProviderCapability = {
    providerId: HistoricalProviderId.GROWW,
    earliestDocumentedUnderlyingHistory: '2021-01-01',
    earliestDocumentedOptionDiscovery: null,
    earliestDocumentedOptionCandleHistory: null,
    supportsOptionContractDiscovery: false,
    supportsOptionCandleAcquisition: false,
    supportedIntervals: ['1day'],
    maximumRequestDateSpanDays: null,
    contractMetadataIncludesLotSize: false,
    historicalListingStartDateKnown: false,
    rateLimitPolicy: { policyId: 'GROWW_DEFAULT' },
  };

  assert.equal(capability.earliestDocumentedUnderlyingHistory, '2021-01-01');
  assert.equal(capability.earliestDocumentedOptionDiscovery, null);
  assert.equal(capability.earliestDocumentedOptionCandleHistory, null);
});

test('support booleans are independent of the documented horizon: a provider can support an operation without documenting how far back it goes', () => {
  const capability: HistoricalProviderCapability = {
    providerId: HistoricalProviderId.DHAN,
    earliestDocumentedUnderlyingHistory: null,
    earliestDocumentedOptionDiscovery: null,
    earliestDocumentedOptionCandleHistory: null,
    supportsOptionContractDiscovery: true,
    supportsOptionCandleAcquisition: true,
    supportedIntervals: ['1minute', '1day'],
    maximumRequestDateSpanDays: null,
    contractMetadataIncludesLotSize: true,
    historicalListingStartDateKnown: false,
    rateLimitPolicy: { policyId: 'DHAN_DEFAULT' },
  };

  assert.equal(capability.supportsOptionContractDiscovery, true);
  assert.equal(capability.supportsOptionCandleAcquisition, true);
  assert.equal(capability.earliestDocumentedOptionDiscovery, null);
  assert.equal(capability.earliestDocumentedOptionCandleHistory, null);
});
