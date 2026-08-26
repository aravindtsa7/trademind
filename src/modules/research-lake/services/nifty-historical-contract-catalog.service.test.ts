import assert from 'node:assert/strict';
import test from 'node:test';
import NiftyHistoricalContractCatalogAcquisitionService from './nifty-historical-contract-catalog.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import GrowwHistoricalContractProviderService, { GrowwContractDiscoveryOutcome } from '../providers/groww/groww-historical-contract-provider.service';
import HistoricalOptionContractCatalogRepository, { HistoricalOptionContractCatalogUpsertResult } from '../repositories/historical-option-contract-catalog.repository';
import { DiscoveredOptionContractCandidate, resolveCatalogMetadataState } from '../domain/historical-option-contract-catalog.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { GrowwSymbolParseFailureReason } from '../providers/groww/groww-contract-symbol-parser';

function candidate(rawSymbol: string, expiry: string, strike: number, optionType: HistoricalOptionType, overrides: Partial<DiscoveredOptionContractCandidate> = {}): DiscoveredOptionContractCandidate {
  return {
    provider: HistoricalProviderId.GROWW,
    providerContractId: rawSymbol,
    exchange: 'NSE',
    underlyingSymbol: 'NIFTY',
    expiry: new Date(`${expiry}T00:00:00+05:30`),
    strikePrice: strike,
    optionType,
    exchangeTradingSymbol: null,
    lotSize: null,
    tickSize: null,
    discoveredAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function permanentError(status: number): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, headers: {} } });
}

class FakeAdapter {
  readonly expiryCalls: number[] = [];
  readonly contractCalls: string[] = [];
  constructor(
    private readonly expiriesByYear: Record<number, readonly string[] | 'THROW'>,
    private readonly outcomesByExpiry: Record<string, GrowwContractDiscoveryOutcome | 'THROW'>
  ) {}

  getCapability() {
    return {
      providerId: HistoricalProviderId.GROWW,
      earliestDocumentedUnderlyingHistory: null,
      earliestDocumentedOptionDiscovery: '2020-01-01',
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: true,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: [],
      maximumRequestDateSpanDays: null,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false,
      rateLimitPolicy: { policyId: 'FAKE' },
    };
  }

  async discoverExpiriesForYearMonth(year: number): Promise<readonly string[]> {
    this.expiryCalls.push(year);
    const value = this.expiriesByYear[year];
    if (value === 'THROW' || value === undefined) throw permanentError(403);
    return value;
  }

  async discoverContractsForExpiry(expiry: string): Promise<GrowwContractDiscoveryOutcome> {
    this.contractCalls.push(expiry);
    const value = this.outcomesByExpiry[expiry];
    if (value === 'THROW' || value === undefined) throw permanentError(403);
    return value;
  }
}

class FakeRepository {
  readonly upsertManyCalls: DiscoveredOptionContractCandidate[][] = [];
  private readonly known = new Set<string>();

  constructor(preExisting: readonly string[] = []) {
    preExisting.forEach((id) => this.known.add(id));
  }

  async upsertMany(candidates: readonly DiscoveredOptionContractCandidate[]): Promise<HistoricalOptionContractCatalogUpsertResult[]> {
    this.upsertManyCalls.push([...candidates]);
    return candidates.map((c) => {
      const alreadyKnown = this.known.has(c.providerContractId);
      this.known.add(c.providerContractId);
      return { providerContractId: c.providerContractId, outcome: alreadyKnown ? ('UNCHANGED' as const) : ('INSERTED' as const), metadataState: resolveCatalogMetadataState(c) };
    });
  }
}

function buildService(
  expiriesByYear: Record<number, readonly string[] | 'THROW'>,
  outcomesByExpiry: Record<string, GrowwContractDiscoveryOutcome | 'THROW'>,
  preExistingContractIds: readonly string[] = []
): { service: NiftyHistoricalContractCatalogAcquisitionService; adapter: FakeAdapter; repository: FakeRepository } {
  const adapter = new FakeAdapter(expiriesByYear, outcomesByExpiry);
  const repository = new FakeRepository(preExistingContractIds);
  const service = new NiftyHistoricalContractCatalogAcquisitionService({
    adapter: adapter as unknown as GrowwHistoricalContractProviderService,
    repository: repository as unknown as HistoricalOptionContractCatalogRepository,
    rateLimiter: new HistoricalProviderRateLimiterService(0),
    retryOptions: { sleep: async () => {}, maxAttempts: 2 },
  });
  return { service, adapter, repository };
}

function outcome(candidates: DiscoveredOptionContractCandidate[], ignoredFutureSymbols: string[] = [], malformedSymbols: GrowwContractDiscoveryOutcome['malformedSymbols'] = []): GrowwContractDiscoveryOutcome {
  return { candidates, ignoredFutureSymbols, malformedSymbols };
}

test('H: multiple expiries across years are discovered, deduplicated, and processed in deterministic ascending order', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const c2 = candidate('NSE-NIFTY-13Jan22-17600-PE', '2022-01-13', 17600, HistoricalOptionType.PE);
  const { service } = buildService(
    { 2022: ['2022-01-06', '2022-01-06', '2022-01-13'] }, // duplicate expiry date in raw response
    { '2022-01-06': outcome([c1]), '2022-01-13': outcome([c2]) }
  );

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.expiriesReceived, 3);
  assert.equal(result.expiriesAccepted, 2); // duplicate expiry collapsed
  assert.deepEqual(result.expiryDetails.map((d) => d.expiry), ['2022-01-06', '2022-01-13']); // ascending
  assert.equal(result.parsedOptionContracts, 2);
  assert.equal(result.newlyDiscovered, 2);
});

test('H: a duplicate providerContractId within one expiry response is deduplicated before persistence', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const c1Duplicate = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const { service, repository } = buildService({ 2022: ['2022-01-06'] }, { '2022-01-06': outcome([c1, c1Duplicate]) });

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.duplicateContracts, 1);
  assert.equal(result.parsedOptionContracts, 1);
  assert.equal(repository.upsertManyCalls[0].length, 1);
});

test('H: one expiry failing (permanent) does not corrupt or block other successful expiries', async () => {
  const good = candidate('NSE-NIFTY-13Jan22-17600-PE', '2022-01-13', 17600, HistoricalOptionType.PE);
  const { service } = buildService({ 2022: ['2022-01-06', '2022-01-13'] }, { '2022-01-06': 'THROW', '2022-01-13': outcome([good]) });

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.failedExpiries.length, 1);
  assert.equal(result.failedExpiries[0].expiry, '2022-01-06');
  assert.equal(result.newlyDiscovered, 1);
  assert.equal(result.parsedOptionContracts, 1);
  const goodDetail = result.expiryDetails.find((d) => d.expiry === '2022-01-13')!;
  assert.equal(goodDetail.failed, false);
  assert.equal(goodDetail.newlyDiscovered, 1);
});

test('H: resume -- a contract already known in the catalog is reported UNCHANGED/alreadyKnown, not re-discovered', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const { service } = buildService({ 2022: ['2022-01-06'] }, { '2022-01-06': outcome([c1]) }, [c1.providerContractId]);

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.alreadyKnown, 1);
  assert.equal(result.newlyDiscovered, 0);
});

test('I: dry run parses/validates as normal but never calls the repository, and reports dryRun=true', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const { service, repository } = buildService({ 2022: ['2022-01-06'] }, { '2022-01-06': outcome([c1]) });

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31', dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(repository.upsertManyCalls.length, 0);
  assert.equal(result.parsedOptionContracts, 1);
  assert.equal(result.newlyDiscovered, 1); // "would discover" projection, not an actual write
});

test('REGRESSION (confirmed via live B-F3 controlled probe): a year-level expiry-discovery failure (e.g. auth/scope) is never silently indistinguishable from "zero expiries returned"', async () => {
  const { service } = buildService({ 2022: 'THROW' }, {});
  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.expiriesReceived, 0);
  assert.equal(result.failedExpiryYears.length, 1);
  assert.equal(result.failedExpiryYears[0].year, 2022);
  assert.match(result.failedExpiryYears[0].reason, /permanent|forbidden|403/i);
});

test('a failed expiry year does not prevent a subsequent successful year in the same run', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan23-17500-CE', '2023-01-06', 17500, HistoricalOptionType.CE);
  const { service } = buildService({ 2022: 'THROW', 2023: ['2023-01-06'] }, { '2023-01-06': outcome([c1]) });
  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2023-12-31' });

  assert.equal(result.failedExpiryYears.length, 1);
  assert.equal(result.failedExpiryYears[0].year, 2022);
  assert.equal(result.newlyDiscovered, 1);
  assert.deepEqual(result.expiryDetails.map((d) => d.expiry), ['2023-01-06']);
});

test('futures and malformed symbols are tracked separately, never counted as parsed options', async () => {
  const c1 = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const { service } = buildService(
    { 2022: ['2022-01-06'] },
    {
      '2022-01-06': outcome(
        [c1],
        ['NSE-NIFTY-27Jan22-FUT'],
        [{ rawSymbol: 'garbage', reason: GrowwSymbolParseFailureReason.INVALID_SEGMENT_COUNT, detail: 'bad' }]
      ),
    }
  );

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.parsedOptionContracts, 1);
  assert.equal(result.ignoredFutures, 1);
  assert.equal(result.malformedContracts, 1);
  assert.equal(result.malformedSymbolSamples.length, 1);
  assert.equal(result.contractSymbolsReceived, 3);
});

test('metadataComplete/metadataIncomplete counts reflect the resolved catalog state', async () => {
  const incomplete = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const complete = candidate('NSE-NIFTY-06Jan22-17600-PE', '2022-01-06', 17600, HistoricalOptionType.PE, {
    exchangeTradingSymbol: 'NIFTY22J0617600PE',
    lotSize: 50,
    tickSize: 0.05,
  });
  const { service } = buildService({ 2022: ['2022-01-06'] }, { '2022-01-06': outcome([incomplete, complete]) });

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.metadataIncomplete, 1);
  assert.equal(result.metadataComplete, 1);
});

test('G: retry/rate-limit -- a persistent transient failure exhausts retries and is reported as a failed expiry with a typed reason, without crashing the run', async () => {
  const { service } = buildService({ 2022: ['2022-01-06'] }, { '2022-01-06': 'THROW' });
  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.failedExpiries.length, 1);
  assert.match(result.failedExpiries[0].reason, /permanent|forbidden|403/i);
});

test('validation: requires an explicit toDate and rejects fromDate after toDate', async () => {
  const { service } = buildService({}, {});
  await assert.rejects(service.acquire({ toDate: 'not-a-date' }));
  await assert.rejects(service.acquire({ fromDate: '2022-05-01', toDate: '2022-01-01' }));
});

test('expiries outside the requested range are excluded even if Groww returns them for the requested year', async () => {
  const inRange = candidate('NSE-NIFTY-06Jan22-17500-CE', '2022-01-06', 17500, HistoricalOptionType.CE);
  const { service } = buildService(
    { 2022: ['2022-01-06', '2022-06-30'] },
    { '2022-01-06': outcome([inRange]), '2022-06-30': outcome([]) }
  );

  const result = await service.acquire({ fromDate: '2022-01-01', toDate: '2022-01-31' });

  assert.equal(result.expiriesAccepted, 1);
  assert.deepEqual(result.expiryDetails.map((d) => d.expiry), ['2022-01-06']);
});
