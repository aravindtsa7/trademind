import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import ResearchYearRunnerService from './research-year-runner.service';
import ResearchYearRunCheckpointService from './research-year-run-checkpoint.service';
import HistoricalCandleResamplerService from './historical-candle-resampler.service';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import NiftyUnderlyingAcquisitionService, { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME, NiftyUnderlyingAcquisitionRequest, NiftyUnderlyingAcquisitionResult } from './nifty-underlying-acquisition.service';
import NiftyHistoricalContractCatalogAcquisitionService, { NiftyContractCatalogAcquisitionRequest, NiftyContractCatalogAcquisitionResult } from './nifty-historical-contract-catalog.service';
import GrowwOptionCandleAcquisitionService, { GrowwOptionCandleAcquisitionRequest, GrowwOptionCandleAcquisitionResult, GrowwOptionAcquisitionFailureReason } from './groww-option-candle-acquisition.service';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ResampleSessionStatus } from '../domain/resampled-candle.types';
import { DatasetManifest, ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { RequiredOptionSession, RequiredOptionSessionSource, ResearchYearRunOutcome, ResearchYearRunScope, ResearchYearRunStageKind, ResearchYearRunStageStatus, ResolvedResearchYearRunRange } from '../domain/research-year-run.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';

const CLOCK = () => new Date('2026-08-28T10:00:00+05:30');

// ---- shared fakes (matches the FakeHistoricalCandleRepository convention already established in research-lake-parquet-export.service.test.ts) ----

function makeRow(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return { candleTime, open: new Prisma.Decimal(100), high: new Prisma.Decimal(101), low: new Prisma.Decimal(99), close: new Prisma.Decimal(100.5), volume: 1_000n, openInterest: null, ...overrides };
}

function normalSessionRows(tradingDate: string, rowOverrides: (index: number) => Partial<PersistedManifestCandleRow> = () => ({})): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000), rowOverrides(index)));
}

class FakeHistoricalCandleRepository {
  rows: PersistedManifestCandleRow[] = [];
  findRangeCallCount = 0;
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

class FakeHistoricalOptionCandleLakeRepository {
  rows: PersistedManifestCandleRow[] = [];
  findRangeCallCount = 0;
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

function underlyingResult(overrides: {
  newlyCompleted?: string[];
  alreadyComplete?: string[];
  normalizedWithExclusions?: string[];
  incomplete?: string[];
  invalid?: string[];
  unresolvedNoData?: string[];
  failedChunks?: { fromDate: string; toDate: string; error: string }[];
} = {}): NiftyUnderlyingAcquisitionResult {
  return {
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    timeframe: NIFTY_UNDERLYING_TIMEFRAME,
    requestedStartDate: '2022-01-01',
    requestedEndDate: '2022-01-10',
    monthlyChunksAttempted: 1,
    monthlyChunksSucceeded: 1,
    monthlyChunksFailed: 0,
    providerRowsReceived: 0,
    canonicalRowsAccepted: 0,
    excludedRows: 0,
    sessions: {
      alreadyComplete: overrides.alreadyComplete ?? [],
      newlyCompleted: overrides.newlyCompleted ?? [],
      normalizedWithExclusions: overrides.normalizedWithExclusions ?? [],
      incomplete: overrides.incomplete ?? [],
      invalid: overrides.invalid ?? [],
      specialSessionExcluded: [],
      unresolvedNoData: overrides.unresolvedNoData ?? [],
      closedNoDataExpected: [],
      dryRunAcquisitionPlanned: [],
    },
    sessionDetails: [],
    retryCount: 0,
    rateLimitBackoffCount: 0,
    failedChunks: overrides.failedChunks ?? [],
    dryRun: false,
  };
}

/** `results` may be a single static result (every call returns the same thing) or a per-call factory, to simulate a fake provider whose answer changes between successive runs (e.g. an unresolved date later resolving). */
class FakeUnderlyingAcquisitionService {
  calls: NiftyUnderlyingAcquisitionRequest[] = [];
  constructor(private results: NiftyUnderlyingAcquisitionResult | ((callIndex: number) => NiftyUnderlyingAcquisitionResult)) {}
  async acquire(request: NiftyUnderlyingAcquisitionRequest): Promise<NiftyUnderlyingAcquisitionResult> {
    const callIndex = this.calls.length;
    this.calls.push(request);
    return typeof this.results === 'function' ? this.results(callIndex) : this.results;
  }
}

function catalogResult(overrides: { failedExpiryYears?: { year: number; reason: string }[] } = {}): NiftyContractCatalogAcquisitionResult {
  return {
    provider: HistoricalProviderId.GROWW,
    underlyingSymbol: 'NIFTY',
    exchange: 'NSE',
    requestedStartDate: '2022-01-01',
    requestedEndDate: '2022-01-10',
    dryRun: false,
    expiryRequests: 1,
    expiriesReceived: 1,
    expiriesAccepted: 1,
    contractRequests: 1,
    contractSymbolsReceived: 2,
    parsedOptionContracts: 2,
    ignoredFutures: 0,
    malformedContracts: 0,
    duplicateContracts: 0,
    metadataComplete: 0,
    metadataIncomplete: 2,
    alreadyKnown: 0,
    newlyDiscovered: 2,
    enriched: 0,
    retryCount: 0,
    rateLimitBackoffCount: 0,
    failedExpiryYears: overrides.failedExpiryYears ?? [],
    failedExpiries: [],
    malformedSymbolSamples: [],
    expiryDetails: [],
  };
}

class FakeCatalogAcquisitionService {
  calls: NiftyContractCatalogAcquisitionRequest[] = [];
  constructor(private result: NiftyContractCatalogAcquisitionResult, private onCall?: () => void) {}
  async acquire(request: NiftyContractCatalogAcquisitionRequest): Promise<NiftyContractCatalogAcquisitionResult> {
    this.calls.push(request);
    this.onCall?.();
    return this.result;
  }
}

function optionCandleResult(overrides: { alreadyComplete?: string[]; newlyComplete?: string[]; invalid?: string[]; providerUnavailable?: string[]; authenticationFailed?: boolean } = {}): GrowwOptionCandleAcquisitionResult {
  return {
    provider: HistoricalProviderId.GROWW,
    providerContractId: 'NSE-NIFTY-06Jan22-17200-PE',
    requestedSessions: [],
    dryRun: false,
    requests: 1,
    providerRows: 375,
    canonicalRows: 375,
    excludedRows: 0,
    sessions: {
      alreadyComplete: overrides.alreadyComplete ?? [],
      newlyComplete: overrides.newlyComplete ?? [],
      observedPartial: [],
      noObservedTrading: [],
      invalid: overrides.invalid ?? [],
      providerUnavailable: overrides.providerUnavailable ?? [],
    },
    oi: { rowsWithOi: 0, rowsWithNullOi: 0 },
    retries: 0,
    rateLimitBackoffs: 0,
    failedSessions: overrides.invalid?.map((tradingDate) => ({ tradingDate, reason: GrowwOptionAcquisitionFailureReason.FETCH_PERMANENT, detail: 'forced test failure' })) ?? [],
    authenticationFailed: overrides.authenticationFailed ?? false,
    sessionDetails: [],
  };
}

class FakeOptionCandleAcquisitionService {
  calls: GrowwOptionCandleAcquisitionRequest[] = [];
  constructor(private resultFor: (providerContractId: string) => GrowwOptionCandleAcquisitionResult, private onCall?: (providerContractId: string) => void) {}
  async acquire(request: GrowwOptionCandleAcquisitionRequest): Promise<GrowwOptionCandleAcquisitionResult> {
    this.calls.push(request);
    this.onCall?.(request.providerContractId);
    return this.resultFor(request.providerContractId);
  }
}

class FakeRequiredOptionSessionSource implements RequiredOptionSessionSource {
  calls: ResolvedResearchYearRunRange[] = [];
  constructor(private sessions: readonly RequiredOptionSession[]) {}
  async resolve(range: ResolvedResearchYearRunRange): Promise<readonly RequiredOptionSession[]> {
    this.calls.push(range);
    return this.sessions;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf8-runner-'));
}

interface Harness {
  runner: ResearchYearRunnerService;
  checkpointService: ResearchYearRunCheckpointService;
  candleRepo: FakeHistoricalCandleRepository;
  optionRepo: FakeHistoricalOptionCandleLakeRepository;
  fakeUnderlying: FakeUnderlyingAcquisitionService;
  fakeCatalog: FakeCatalogAcquisitionService;
  fakeOptionCandle: FakeOptionCandleAcquisitionService | null;
  requiredOptionSessionSource?: FakeRequiredOptionSessionSource;
  outputRoot: string;
  manifestArtifactRoot: string;
  checkpointRoot: string;
  cleanup: () => void;
}

function newHarness(options: {
  underlyingResult?: NiftyUnderlyingAcquisitionResult | ((callIndex: number) => NiftyUnderlyingAcquisitionResult);
  catalogResult?: NiftyContractCatalogAcquisitionResult;
  optionCandleResultFor?: (providerContractId: string) => GrowwOptionCandleAcquisitionResult;
  requiredOptionSessionSource?: FakeRequiredOptionSessionSource;
  includeOptionCandleService?: boolean;
  onUnderlyingCall?: () => void;
  onCatalogCall?: () => void;
  onOptionCandleCall?: (providerContractId: string) => void;
} = {}): Harness {
  const candleRepo = new FakeHistoricalCandleRepository();
  const optionRepo = new FakeHistoricalOptionCandleLakeRepository();
  const outputRoot = tempDir();
  const manifestArtifactRoot = tempDir();
  const checkpointRoot = tempDir();
  const checkpointService = new ResearchYearRunCheckpointService(checkpointRoot);

  const fakeUnderlying = new FakeUnderlyingAcquisitionService(options.underlyingResult ?? underlyingResult());
  const originalUnderlyingAcquire = fakeUnderlying.acquire.bind(fakeUnderlying);
  fakeUnderlying.acquire = async (request) => {
    options.onUnderlyingCall?.();
    return originalUnderlyingAcquire(request);
  };

  const fakeCatalog = new FakeCatalogAcquisitionService(options.catalogResult ?? catalogResult(), options.onCatalogCall);
  const fakeOptionCandle = options.includeOptionCandleService === false ? null : new FakeOptionCandleAcquisitionService(options.optionCandleResultFor ?? (() => optionCandleResult()), options.onOptionCandleCall);

  const runner = new ResearchYearRunnerService({
    now: CLOCK,
    requiredOptionSessionSource: options.requiredOptionSessionSource,
    underlyingAcquisitionService: fakeUnderlying as unknown as NiftyUnderlyingAcquisitionService,
    catalogAcquisitionService: fakeCatalog as unknown as NiftyHistoricalContractCatalogAcquisitionService,
    optionCandleAcquisitionService: fakeOptionCandle as unknown as GrowwOptionCandleAcquisitionService | null,
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    checkpointService,
    outputRoot,
    manifestArtifactRoot,
  });

  return {
    runner,
    checkpointService,
    candleRepo,
    optionRepo,
    fakeUnderlying,
    fakeCatalog,
    fakeOptionCandle,
    requiredOptionSessionSource: options.requiredOptionSessionSource,
    outputRoot,
    manifestArtifactRoot,
    checkpointRoot,
    cleanup: () => {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(manifestArtifactRoot, { recursive: true, force: true });
      rmSync(checkpointRoot, { recursive: true, force: true });
    },
  };
}

const REQUEST_UNDERLYING_ONLY = { year: 2022, fromDate: '2022-01-01', toDate: '2022-01-10', scope: ResearchYearRunScope.UNDERLYING };

// ---- K/L: dry-run zero side effects ----------------------------------------

test('(K/L) dry-run makes zero provider calls and zero repository/storage/checkpoint writes', async () => {
  const harness = newHarness();
  try {
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.ALL, dryRun: true });
    assert.equal(harness.fakeUnderlying.calls.length, 0);
    assert.equal(harness.fakeCatalog.calls.length, 0);
    assert.equal(harness.fakeOptionCandle?.calls.length, 0);
    assert.equal(harness.candleRepo.findRangeCallCount, 0);
    assert.equal(harness.optionRepo.findRangeCallCount, 0);
    assert.deepEqual(readdirSync(harness.outputRoot), [], 'dry-run must never write into the Parquet output root');
    assert.deepEqual(readdirSync(harness.manifestArtifactRoot), [], 'dry-run must never write into the manifest artifact root');
    assert.equal(harness.checkpointService.load(record.plan), null, 'dry-run must never write a checkpoint');
    // Every in-scope stage is reported PLANNED (or BLOCKED, for the strategy-universe gap) -- never executed.
    for (const stage of record.stages) {
      if (stage.status !== ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE) {
        assert.ok([ResearchYearRunStageStatus.PLANNED, ResearchYearRunStageStatus.BLOCKED].includes(stage.status), `unexpected dry-run stage status ${stage.status}`);
      }
    }
  } finally {
    harness.cleanup();
  }
});

// ---- M/N: underlying delegation --------------------------------------------

test('(M/N) UNDERLYING_ACQUISITION delegates to NiftyUnderlyingAcquisitionService exactly once with the resolved range, never re-chunking itself', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    await harness.runner.run(REQUEST_UNDERLYING_ONLY);
    assert.equal(harness.fakeUnderlying.calls.length, 1);
    assert.deepEqual(harness.fakeUnderlying.calls[0], { fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: false });
  } finally {
    harness.cleanup();
  }
});

// ---- O/P: catalog before candles, no look-ahead ----------------------------

test('(O) OPTIONS scope executes OPTION_CATALOG_ACQUISITION before OPTION_CANDLE_ACQUISITION', async () => {
  const order: string[] = [];
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03'] }]);
  const harness = newHarness({
    requiredOptionSessionSource: requiredSource,
    onCatalogCall: () => order.push('CATALOG'),
    onOptionCandleCall: () => order.push('CANDLE'),
  });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    assert.deepEqual(order, ['CATALOG', 'CANDLE']);
  } finally {
    harness.cleanup();
  }
});

test('(P) the resolved range handed to catalog discovery and the strategy-universe source is never extended beyond the plan\'s own [fromDate, toDate] (no look-ahead)', async () => {
  const requiredSource = new FakeRequiredOptionSessionSource([]);
  const harness = newHarness({ requiredOptionSessionSource: requiredSource });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    assert.deepEqual(harness.fakeCatalog.calls[0], { fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: false });
    assert.deepEqual(requiredSource.calls[0], { year: 2022, fromDate: '2022-01-01', toDate: '2022-01-10' });
  } finally {
    harness.cleanup();
  }
});

// ---- Q: deterministic option acquisition requests --------------------------

test('(Q) option candle acquisition requests are issued in deterministic contract order with exact, sorted trading dates', async () => {
  const requiredSource = new FakeRequiredOptionSessionSource([
    { providerContractId: 'NSE-NIFTY-13Feb22-17500-CE', tradingDates: ['2022-02-01'] },
    { providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-04', '2022-01-03'] },
  ]);
  const harness = newHarness({ requiredOptionSessionSource: requiredSource });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    assert.deepEqual(
      harness.fakeOptionCandle?.calls.map((call) => call.providerContractId),
      ['NSE-NIFTY-06Jan22-17200-PE', 'NSE-NIFTY-13Feb22-17500-CE']
    );
    assert.deepEqual(harness.fakeOptionCandle?.calls[0]?.tradingDates, ['2022-01-03', '2022-01-04']);
  } finally {
    harness.cleanup();
  }
});

// ---- AE/AF: full-session resampling counts ---------------------------------

test('(AE/AF) a full 375-row underlying source produces 2m=187 (never a fabricated 15:29 tail), 3m=125, 5m=75, and materialization COMPLETES', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' });

    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);
    const session = materialization?.materialization?.[0]?.sessions[0];
    assert.equal(session?.parquetStatus, 'WRITTEN');
    const byTimeframe = Object.fromEntries((session?.resamples ?? []).map((r) => [r.targetTimeframe, r]));
    assert.equal(byTimeframe['2m']?.derivedBucketCount, 187);
    assert.equal(byTimeframe['3m']?.derivedBucketCount, 125);
    assert.equal(byTimeframe['5m']?.derivedBucketCount, 75);
    for (const timeframe of ['2m', '3m', '5m']) assert.equal(byTimeframe[timeframe]?.status, ResampleSessionStatus.COMPLETE_REGULAR_SESSION);
  } finally {
    harness.cleanup();
  }
});

// ---- AG/AH/AI: OI preserved end-to-end (checksum-parity proof) ------------

test('(AG/AH/AI) option OI (positive, zero, and null) survives the full B-F8 pipeline unmodified -- proven by matching the independently-recomputed B-F7 checksum', async () => {
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03'] }]);
  const harness = newHarness({
    requiredOptionSessionSource: requiredSource,
    optionCandleResultFor: () => optionCandleResult({ newlyComplete: ['2022-01-03'] }),
  });
  try {
    const oiRows = normalSessionRows('2022-01-03', (index) => ({ openInterest: index === 0 ? 500n : index === 1 ? 0n : index === 2 ? null : 500n }));
    harness.optionRepo.rows = oiRows;

    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.OPTION_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);
    const outcome = materialization?.materialization?.find((m) => m.instrumentDescriptor === 'NSE-NIFTY-06Jan22-17200-PE');
    const session = outcome?.sessions[0];
    assert.equal(session?.parquetStatus, 'WRITTEN');

    // Load back the ACTUAL persisted B-F5 manifest artifact this run wrote, rather than
    // hand-constructing a session identity (which would risk silently testing against the wrong
    // identity, e.g. a mis-guessed expiry UTC anchor, instead of proving anything about the pipeline).
    const persistedManifest = JSON.parse(readFileSync(join(harness.manifestArtifactRoot, ManifestDatasetKind.EXPIRED_OPTION_1M, `${outcome!.datasetId}.json`), 'utf8')) as DatasetManifest;
    const persistedIdentity = persistedManifest.sessions[0].identity;

    const independentResampler = new HistoricalCandleResamplerService();
    for (const resample of session?.resamples ?? []) {
      const recomputed = independentResampler.resampleSession({
        targetTimeframe: resample.targetTimeframe as never,
        tradingDate: '2022-01-03',
        sourceDatasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
        sourceSessionIdentity: persistedIdentity,
        sourceSessionContentChecksum: session!.sessionContentChecksum,
        sourceRows: oiRows,
      });
      assert.equal(recomputed.descriptor.derivedContentChecksum, resample.derivedContentChecksum, `OI/derived content diverged for ${resample.targetTimeframe}`);
    }
  } finally {
    harness.cleanup();
  }
});

// ---- S/T/U/V/W/X: resume, revalidation, fail-closed ------------------------

test('(S/T) a second identical run does not re-acquire underlying data once the first run\'s output is durably complete and revalidates successfully', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };

    const first = await harness.runner.run(request);
    assert.equal(first.outcome, ResearchYearRunOutcome.COMPLETE);
    assert.equal(harness.fakeUnderlying.calls.length, 1);

    const second = await harness.runner.run(request);
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE);
    assert.equal(harness.fakeUnderlying.calls.length, 1, 'the second run must not re-invoke the (provider-calling) acquisition service once prior output is verified');
    const acquisitionStage = second.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
    assert.equal(acquisitionStage?.acquisitionSummary?.skippedReacquisition, true);
  } finally {
    harness.cleanup();
  }
});

test('(T/W) a COMPLETED checkpoint is revalidated before skip -- DB drift after the first run forces real re-acquisition rather than silently trusting the stale checkpoint', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };
    const first = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 1);
    assert.equal(first.outcome, ResearchYearRunOutcome.COMPLETE);

    // Simulate DB drift after the manifest/Parquet were generated: mutate one row's close price
    // (kept within the existing high/low bounds so the session's persisted-canonical health status
    // stays HEALTHY -- this test isolates the CONTENT-CHECKSUM-drift revalidation path from the
    // separate REJECTED_HEALTH_POLICY path an invalid OHLC row would take instead).
    harness.candleRepo.rows[0] = { ...harness.candleRepo.rows[0], close: new Prisma.Decimal(100.6) };

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'drifted content must never be trusted enough to skip re-acquisition -- the stale COMPLETED checkpoint marker alone is never sufficient (task section 13)');
    // B-F6 storage is content-addressed at the whole-dataset level (task section 6): the drifted
    // content correctly re-derives a DIFFERENT datasetChecksum and is safely (re)materialized fresh
    // under it -- proving the run never silently certified the OLD, now-stale dataset identity as
    // still describing the CURRENT persisted truth.
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE);
    const firstDatasetChecksum = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.datasetChecksum;
    const secondDatasetChecksum = second.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.datasetChecksum;
    assert.notEqual(secondDatasetChecksum, firstDatasetChecksum);
  } finally {
    harness.cleanup();
  }
});

test('(U) a missing Parquet storage descriptor is never false-skipped', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };
    await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 1);

    rmSync(join(harness.outputRoot, ManifestDatasetKind.UNDERLYING_1M), { recursive: true, force: true });

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'a missing Parquet descriptor must never be treated as durable prior evidence');
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE, 'the second run must safely rematerialize and still succeed');
  } finally {
    harness.cleanup();
  }
});

test('(V/X) corrupted Parquet bytes are never false-skipped and fail closed rather than being silently overwritten', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };
    const first = await harness.runner.run(request);
    const parquetPath = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.sessions[0];
    assert.ok(parquetPath);

    // Corrupt the actual Parquet session file's bytes directly (physical corruption, not DB drift).
    const sessionFilePath = join(harness.outputRoot, ManifestDatasetKind.UNDERLYING_1M, first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)!.materialization![0].datasetChecksum!, 'sessions', '2022-01-03.parquet');
    const original = readFileSync(sessionFilePath);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] ^= 0xff;
    writeFileSync(sessionFilePath, corrupted);

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'physically corrupted Parquet content must never be trusted enough to skip re-acquisition');
    assert.notEqual(second.outcome, ResearchYearRunOutcome.COMPLETE);
    const materialization = second.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.materialization?.[0]?.sessions[0]?.parquetStatus, 'FAILED_EXISTING_FILE_UNTRUSTED');
    // The corrupted bytes must never have been silently overwritten/repaired.
    assert.deepEqual(readFileSync(sessionFilePath), corrupted);
  } finally {
    harness.cleanup();
  }
});

// ---- AB/AC: recoverable failure vs invariant failure -----------------------

test('(AB/AC) a recoverable underlying session failure is recorded, other in-scope stages still run, and the overall outcome is INCOMPLETE (never COMPLETE)', async () => {
  const requiredSource = new FakeRequiredOptionSessionSource([]);
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'], incomplete: ['2022-01-04'] }),
    requiredOptionSessionSource: requiredSource,
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.ALL });
    assert.equal(record.outcome, ResearchYearRunOutcome.INCOMPLETE);
    const catalogStage = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION);
    assert.equal(catalogStage?.status, ResearchYearRunStageStatus.COMPLETED, 'an independent, unrelated stage must still be allowed to complete despite the underlying session failure');
  } finally {
    harness.cleanup();
  }
});

// ---- HOLIDAY / NO-DATA / RESUME SEMANTICS (task correction section 3) -----
//
// NiftyUnderlyingAcquisitionService.acquire() (B-F2) has NO authoritative
// non-trading-day/holiday classification. `unresolvedNoData` means "a
// candidate weekday had no provider data and no existing DB coverage" --
// it is NEVER proof of a genuine exchange holiday, and it is never proof of
// a safe, certified exclusion either. `SPECIAL_SESSION_EXCLUDED` is the only
// bucket that WOULD represent an authoritative exclusion, but B-F2's own
// doc confirms it is unreachable in this milestone ("Always empty in B-F2").
// B-F8 therefore does not fabricate a holiday calendar; these tests prove
// the corrected, truthful behavior instead.

test('(3-i) an unresolvedNoData date is never labeled a holiday, never materialized, and keeps the run out of COMPLETE -- resume must still retry it', async () => {
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'], unresolvedNoData: ['2022-01-04'] }),
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-04' };

    const first = await harness.runner.run(request);
    const acquisitionStage = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
    assert.equal(acquisitionStage?.status, ResearchYearRunStageStatus.INCOMPLETE, 'a genuinely unresolved candidate date must never let the stage report COMPLETED');
    assert.equal(first.outcome, ResearchYearRunOutcome.INCOMPLETE);
    // Only the certified-healthy date was materialized -- the unresolved date has no Parquet/manifest session at all.
    const materialization = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    const sessions = materialization?.materialization?.[0]?.sessions ?? [];
    assert.deepEqual(sessions.map((s) => s.tradingDate), ['2022-01-03']);

    // Resume must retry: a prior run with a concealed unresolvedNoData date must never be trusted enough to skip re-acquisition.
    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'an unresolved required date must be retried through B-F2 on the next run, never silently dropped');
    assert.equal(second.outcome, ResearchYearRunOutcome.INCOMPLETE);
  } finally {
    harness.cleanup();
  }
});

test('(3-ii) an INCOMPLETE date keeps the run INCOMPLETE and is retried on the next run', async () => {
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'], incomplete: ['2022-01-04'] }),
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-04' };
    const first = await harness.runner.run(request);
    assert.equal(first.outcome, ResearchYearRunOutcome.INCOMPLETE);
    await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'an INCOMPLETE required date must be retried, never treated as a safe/certified exclusion');
  } finally {
    harness.cleanup();
  }
});

test('(3-iii) an INVALID date keeps the run INCOMPLETE and is retried on the next run', async () => {
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'], invalid: ['2022-01-04'] }),
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-04' };
    const first = await harness.runner.run(request);
    assert.equal(first.outcome, ResearchYearRunOutcome.INCOMPLETE);
    await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'an INVALID required date must be retried, never treated as a safe/certified exclusion');
  } finally {
    harness.cleanup();
  }
});

test('(3-iv) a provider/chunk failure is never converted into a holiday/no-data success', async () => {
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'], failedChunks: [{ fromDate: '2022-01-03', toDate: '2022-01-04', error: 'simulated transient provider failure' }] }),
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-04' });
    const acquisitionStage = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
    assert.equal(acquisitionStage?.status, ResearchYearRunStageStatus.INCOMPLETE);
    assert.equal(record.outcome, ResearchYearRunOutcome.INCOMPLETE);
  } finally {
    harness.cleanup();
  }
});

test('(3-v/vi) a genuinely unresolved date that resolves healthy on a LATER run is picked up, and the run only reaches COMPLETE once every required date is certified', async () => {
  const harness = newHarness({
    underlyingResult: (callIndex) =>
      callIndex === 0
        ? underlyingResult({ newlyCompleted: ['2022-01-03'], unresolvedNoData: ['2022-01-04'] })
        : underlyingResult({ alreadyComplete: ['2022-01-03'], newlyCompleted: ['2022-01-04'] }),
  });
  try {
    harness.candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-04' };

    const first = await harness.runner.run(request);
    assert.equal(first.outcome, ResearchYearRunOutcome.INCOMPLETE);

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'the unresolved date from the first run must be retried, not skipped');
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE, 'once every required date is certified healthy and materialized, the run may reach COMPLETE');
    const materialization = second.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.deepEqual(
      (materialization?.materialization?.[0]?.sessions ?? []).map((s) => s.tradingDate).sort(),
      ['2022-01-03', '2022-01-04']
    );
  } finally {
    harness.cleanup();
  }
});

test('(3-vii) FULL MULTI-MONTH resume: only a handful of certified-healthy dates out of many weekday CANDIDATES still allows a clean second-run skip (the candidate-list-based defect this correction fixes)', async () => {
  // A real two-month span has ~40 Mon-Fri candidate dates. A real NSE calendar would exclude several
  // as holidays; B-F2 has no such calendar, so most of these candidates are never expected to resolve
  // healthy in this test -- only three are configured to. Before this correction, the resume/skip check
  // compared coverage against ALL ~40 candidate dates (`stagePlan.underlyingCandidateDates`), which could
  // never be satisfied by 3 materialized sessions -- resume would NEVER skip for any realistic multi-month
  // range. The fix checks coverage against the previously CERTIFIED healthy dates instead.
  const healthyDates = ['2022-01-03', '2022-01-18', '2022-02-15'];
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: healthyDates }) });
  try {
    harness.candleRepo.rows = healthyDates.flatMap((date) => normalSessionRows(date));
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-01', toDate: '2022-02-28' };

    const plan = await harness.runner.buildPlan(request);
    const candidateCount = plan.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION)?.underlyingCandidateDates?.length ?? 0;
    assert.ok(candidateCount > healthyDates.length * 2, `expected many more weekday candidates (${candidateCount}) than certified-healthy dates (${healthyDates.length}) for this to be a meaningful test`);

    const first = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 1);
    // This fake never resolves the remaining candidates at all (they stay simply absent, not unresolvedNoData,
    // for this harness) -- the acquisition stage is COMPLETED because the fake reports zero failure buckets;
    // the point under test is exclusively the RESUME/SKIP mechanism against the certified-healthy subset.
    assert.equal(first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION)?.status, ResearchYearRunStageStatus.COMPLETED);

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 1, 'resume must skip re-acquisition once every PREVIOUSLY CERTIFIED healthy date (not every weekday candidate) is durably verified');
    const secondAcquisition = second.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
    assert.equal(secondAcquisition?.acquisitionSummary?.skippedReacquisition, true);
    assert.deepEqual((secondAcquisition?.acquisitionSummary?.healthyTradingDates as string[]).sort(), [...healthyDates].sort());
  } finally {
    harness.cleanup();
  }
});

test('(AD) an invariant failure (e.g. a resampler checksum violation) fails the stage AND halts remaining stages immediately, rather than certifying the run', async () => {
  const throwingResampler = { resampleSession: () => { throw new Error('INVARIANT_TEST: forced checksum violation'); } };
  const candleRepo = new FakeHistoricalCandleRepository();
  const optionRepo = new FakeHistoricalOptionCandleLakeRepository();
  const outputRoot = tempDir();
  const manifestArtifactRoot = tempDir();
  const checkpointRoot = tempDir();
  const fakeUnderlying = new FakeUnderlyingAcquisitionService(underlyingResult({ newlyCompleted: ['2022-01-03'] }));
  const fakeCatalog = new FakeCatalogAcquisitionService(catalogResult());
  candleRepo.rows = normalSessionRows('2022-01-03');

  const runner = new ResearchYearRunnerService({
    now: CLOCK,
    underlyingAcquisitionService: fakeUnderlying as unknown as NiftyUnderlyingAcquisitionService,
    catalogAcquisitionService: fakeCatalog as unknown as NiftyHistoricalContractCatalogAcquisitionService,
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    resamplerService: throwingResampler as unknown as HistoricalCandleResamplerService,
    checkpointService: new ResearchYearRunCheckpointService(checkpointRoot),
    outputRoot,
    manifestArtifactRoot,
  });

  try {
    const record = await runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.ALL, fromDate: '2022-01-03', toDate: '2022-01-03' });
    assert.equal(record.outcome, ResearchYearRunOutcome.FAILED);
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.FAILED);
    assert.match(materialization?.detail ?? '', /INVARIANT_TEST/);
    // Every stage after the failure must never have been attempted this run.
    const laterStages = record.stages.slice(record.stages.findIndex((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION) + 1);
    assert.ok(laterStages.length > 0);
    for (const stage of laterStages) assert.equal(stage.status, ResearchYearRunStageStatus.PLANNED);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(manifestArtifactRoot, { recursive: true, force: true });
    rmSync(checkpointRoot, { recursive: true, force: true });
  }
});

// ---- AK: rerunning a fully valid year does not change semantic identity ---

test('(AK) rerunning the same fully valid request twice never changes the plan\'s semantic identity or the checkpoint path', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };
    const first = await harness.runner.run(request);
    const second = await harness.runner.run(request);
    assert.equal(first.plan.planSemanticIdentity, second.plan.planSemanticIdentity);
    assert.equal(harness.checkpointService.checkpointPath(first.plan), harness.checkpointService.checkpointPath(second.plan));
  } finally {
    harness.cleanup();
  }
});

// ---- OPTIONS blocked end-to-end (no GrowwOptionCandleAcquisitionService configured) ----

test('OPTIONS scope with a resolvable strategy universe but no configured GrowwOptionCandleAcquisitionService reports BLOCKED rather than guessing/constructing a default provider', async () => {
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03'] }]);
  const harness = newHarness({ requiredOptionSessionSource: requiredSource, includeOptionCandleService: false });
  try {
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const candleStage = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
    assert.equal(candleStage?.status, ResearchYearRunStageStatus.BLOCKED);
    assert.equal(record.outcome, ResearchYearRunOutcome.INCOMPLETE);
  } finally {
    harness.cleanup();
  }
});
