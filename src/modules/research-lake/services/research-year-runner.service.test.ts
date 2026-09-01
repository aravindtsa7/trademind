import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { CalendarSessionWindowsByDate, SessionWindow } from '../domain/exchange-calendar.types';
import { RequiredOptionSession, RequiredOptionSessionSource, ResearchYearRunOutcome, ResearchYearRunScope, ResearchYearRunStageKind, ResearchYearRunStageStatus, ResolvedResearchYearRunRange } from '../domain/research-year-run.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import DatasetManifestService from './dataset-manifest.service';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';
import ManifestCalendarSessionResolverService, { ManifestCalendarSessionWindowLookupError } from './manifest-calendar-session-resolver.service';

const CLOCK = () => new Date('2026-08-28T10:00:00+05:30');

// ---- shared fakes (matches the FakeHistoricalCandleRepository convention already established in research-lake-parquet-export.service.test.ts) ----

function makeRow(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return { candleTime, open: new Prisma.Decimal(100), high: new Prisma.Decimal(101), low: new Prisma.Decimal(99), close: new Prisma.Decimal(100.5), volume: 1_000n, openInterest: null, ...overrides };
}

function normalSessionRows(tradingDate: string, rowOverrides: (index: number) => Partial<PersistedManifestCandleRow> = () => ({})): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000), rowOverrides(index)));
}

/** Rows for an arbitrary set of calendar-declared session windows (GAP 1 special-session tests) -- reuses `makeRow`, never the fixed 09:15-15:29 375-row shape. */
function sessionRowsForWindows(tradingDate: string, windows: readonly SessionWindow[]): PersistedManifestCandleRow[] {
  const dayStartMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const rows: PersistedManifestCandleRow[] = [];
  for (const window of windows) {
    for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) rows.push(makeRow(new Date(dayStartMs + minute * 60_000)));
  }
  return rows;
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
  sourceConflict?: string[];
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
      sourceConflict: overrides.sourceConflict ?? [],
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

/** The calendar-derived regular session window (09:15-15:29 IST, 375 minutes) -- matches `regularSessionWindow()`. */
const REGULAR_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };

/**
 * B-F5 CALENDAR FIX (GAP 1): duck-typed fake for `ManifestCalendarSessionResolverService`
 * -- MUST be injected into every harness so `ResearchYearRunnerService`
 * never falls back to its real, Prisma-backed default (which would touch
 * the live shared database during a unit test). Defaults every requested
 * date to the ordinary REGULAR_WINDOW, matching this test file's existing
 * `normalSessionRows` (375-row) fixture convention exactly, so injecting
 * this fake changes no pre-existing test's observable behavior.
 */
class FakeCalendarSessionResolver {
  calls: string[][] = [];
  constructor(private readonly windowsFor: (date: string) => readonly SessionWindow[] = () => [REGULAR_WINDOW]) {}
  async resolveSessionWindowsForDates(dates: readonly string[]): Promise<CalendarSessionWindowsByDate> {
    this.calls.push([...dates]);
    if (dates.length === 0) return {};
    const result: Record<string, readonly SessionWindow[]> = {};
    for (const date of dates) result[date] = this.windowsFor(date);
    return result;
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
  fakeCalendarSessionResolver: FakeCalendarSessionResolver;
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
  calendarWindowsFor?: (date: string) => readonly SessionWindow[];
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
  // B-F5 CALENDAR FIX (GAP 1): MUST be injected -- without it, `ResearchYearRunnerService`
  // defaults to a real, Prisma-backed `ManifestCalendarSessionResolverService`
  // that would touch the live shared database during this unit test.
  const fakeCalendarSessionResolver = new FakeCalendarSessionResolver(options.calendarWindowsFor);

  // B-F2C: this harness's `fakeUnderlying` never writes real durable retrieval
  // evidence (it is a duck-typed result stub, not the real acquisition
  // service), so `DatasetManifestService`'s default (real, Prisma-backed)
  // `HistoricalDataRetrievalEvidenceService` must be overridden here -- every
  // manifest generated by these tests genuinely has no B-F2C evidence to find,
  // which this fake truthfully reports as `null` without touching a database.
  const manifestService = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    retrievalEvidenceService: { findLatestAvailableSessionEvidence: async () => null } as unknown as HistoricalDataRetrievalEvidenceService,
  });

  const runner = new ResearchYearRunnerService({
    now: CLOCK,
    requiredOptionSessionSource: options.requiredOptionSessionSource,
    underlyingAcquisitionService: fakeUnderlying as unknown as NiftyUnderlyingAcquisitionService,
    catalogAcquisitionService: fakeCatalog as unknown as NiftyHistoricalContractCatalogAcquisitionService,
    optionCandleAcquisitionService: fakeOptionCandle as unknown as GrowwOptionCandleAcquisitionService | null,
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    manifestService,
    calendarSessionResolverService: fakeCalendarSessionResolver as unknown as ManifestCalendarSessionResolverService,
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
    fakeCalendarSessionResolver,
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
    for (const timeframe of ['2m', '3m', '5m']) assert.equal(byTimeframe[timeframe]?.status, ResampleSessionStatus.COMPLETE_SESSION);
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

// ============================================================================
// B-F2D CORRECTION: manifest wire-contract versioning -- checkpoint/resume
// must accept a backward-compatible v4 artifact but never trust a future
// (unrecognized) schema version enough to skip re-acquisition.
// ============================================================================

test('(B-F2D 10) year-runner resume with a supported v4 manifest artifact still works -- backward compatibility is real, not just accepted in isolation', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };

    const first = await harness.runner.run(request);
    assert.equal(first.outcome, ResearchYearRunOutcome.COMPLETE);
    assert.equal(harness.fakeUnderlying.calls.length, 1);

    const datasetId = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.datasetId as string;
    const manifestPath = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M, `${datasetId}.json`);
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as DatasetManifest;
    assert.equal(onDisk.manifestSchemaVersion, 5, 'sanity check: freshly generated manifests are stamped with the current schema version');
    // Downgrade the stored artifact's own declared version to the oldest
    // backward-compatible one (v4) -- every session here already reports
    // PRIMARY_ONLY (no B-F2C durable evidence in this harness), which is a
    // v4-legal value, so this is a genuinely valid v4 artifact, not merely a
    // relabeled v5 one.
    writeFileSync(manifestPath, `${JSON.stringify({ ...onDisk, manifestSchemaVersion: 4 }, null, 2)}\n`);

    const second = await harness.runner.run(request);
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE);
    assert.equal(harness.fakeUnderlying.calls.length, 1, 'a genuinely valid v4 manifest artifact must still be trusted enough to skip re-acquisition -- v4 backward compatibility must be real, not merely accepted by the guard in isolation');
  } finally {
    harness.cleanup();
  }
});

/**
 * B-F2D CORRECTION (Terra re-review HIGH-2): strips a real, freshly-generated
 * (and therefore correctly checksummed) on-disk manifest down to the EXACT
 * historical shape for `version` -- see `manifest-schema-compatibility.util
 * .ts`'s own compatibility-matrix doc. Never fabricates a checksum: identity/
 * contentChecksum/canonicalRowCount/persistedCanonicalHealthStatus are
 * version-invariant (unchanged since v1), so this is a truthful historical
 * artifact for the SAME underlying persisted content, not a relabeled v5 one.
 */
function stripStoredManifestToVersion(onDisk: DatasetManifest, version: 1 | 2 | 3): DatasetManifest {
  return {
    ...onDisk,
    manifestSchemaVersion: version,
    sessions: onDisk.sessions.map((session) => {
      const { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus, provider, evidenceSemanticChecksum } = session.sourceAcquisitionEvidence;
      const evidence = version === 1 ? { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus } : { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus, provider, evidenceSemanticChecksum };
      const withEvidence = { ...session, sourceAcquisitionEvidence: evidence };
      if (version === 3) return withEvidence; // v3 keeps calendarSessionWindows
      const withoutWindows = { ...withEvidence } as Record<string, unknown>;
      delete withoutWindows.calendarSessionWindows;
      return withoutWindows;
    }),
  } as unknown as DatasetManifest;
}

for (const version of [1, 2, 3] as const) {
  test(`(B-F2D year-runner v${version}) resume with a genuine v${version}-shaped stored manifest artifact still works end to end -- backward compatibility is real, not just accepted by the guard in isolation`, async () => {
    const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
    try {
      harness.candleRepo.rows = normalSessionRows('2022-01-03');
      const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };

      const first = await harness.runner.run(request);
      assert.equal(first.outcome, ResearchYearRunOutcome.COMPLETE);
      assert.equal(harness.fakeUnderlying.calls.length, 1);

      const datasetId = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.datasetId as string;
      const manifestPath = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M, `${datasetId}.json`);
      const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as DatasetManifest;
      const historical = stripStoredManifestToVersion(onDisk, version);
      const calendarSessionWindowsPresent = 'calendarSessionWindows' in (historical.sessions[0] as unknown as Record<string, unknown>);
      assert.equal(calendarSessionWindowsPresent, version === 3, `sanity check: calendarSessionWindows must be present only at v3+ (got present=${calendarSessionWindowsPresent} for v${version})`);
      writeFileSync(manifestPath, `${JSON.stringify(historical, null, 2)}\n`);

      const second = await harness.runner.run(request);
      assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE);
      assert.equal(harness.fakeUnderlying.calls.length, 1, `a genuine v${version} manifest artifact must still be trusted enough to skip re-acquisition -- documented backward compatibility must be real, not merely accepted by the guard in isolation`);
    } finally {
      harness.cleanup();
    }
  });
}

test('(B-F2D 11) year-runner resume with a future (unrecognized) manifest schema version stops before using the artifact -- forces real re-acquisition rather than a false skip', async () => {
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }) });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const request = { ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-03', toDate: '2022-01-03' };

    const first = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 1);

    const datasetId = first.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION)?.materialization?.[0]?.datasetId as string;
    const manifestPath = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M, `${datasetId}.json`);
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as DatasetManifest;
    // Simulate a manifest written by some future version of this codebase --
    // a schema version this reader has never heard of.
    writeFileSync(manifestPath, `${JSON.stringify({ ...onDisk, manifestSchemaVersion: 6 }, null, 2)}\n`);

    const second = await harness.runner.run(request);
    assert.equal(harness.fakeUnderlying.calls.length, 2, 'an unrecognized future manifest schema version must never be trusted enough to skip re-acquisition -- the stale artifact is never interpreted, real work happens instead');
    assert.equal(second.outcome, ResearchYearRunOutcome.COMPLETE, 'the run must still safely re-acquire/rematerialize and succeed rather than crashing on the unreadable prior artifact');
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
    manifestService: new DatasetManifestService({
      historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
      historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
      retrievalEvidenceService: { findLatestAvailableSessionEvidence: async () => null } as unknown as HistoricalDataRetrievalEvidenceService,
    }),
    // B-F5 CALENDAR FIX (GAP 1): MUST be injected -- see `newHarness`'s identical comment.
    calendarSessionResolverService: new FakeCalendarSessionResolver() as unknown as ManifestCalendarSessionResolverService,
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

// ============================================================================
// B-F5/B-F7 CALENDAR FIX (GAP 1): year-runner manifest generation propagates
// authoritative calendar session windows for healthyTradingDates, so a
// SPECIAL_SESSION date's MANIFEST health (persistedCanonicalHealthStatus) is
// never scored against the fixed 375-row regular contract. These assertions
// read back the persisted B-F5 manifest artifact -- the exact layer GAP 1
// describes ("reach manifest health validation without sessionWindows").
//
// B-F7 CALENDAR FIX (task invariant G): `HistoricalCandleResamplerService`
// now also consumes `session.calendarSessionWindows` (wired in
// `resampleExportedSessions`), so a SPECIAL_SESSION date the manifest
// certifies HEALTHY is no longer re-evaluated by the resampler against the
// fixed 09:15-15:29 regular contract. The tests below therefore assert the
// FULL end-to-end outcome -- manifest health AND overall MATERIALIZATION
// stage status AND B-F7 resample bucket counts -- for regular, single-window
// special, multi-window special, and weekend special sessions alike (task
// coverage items 16/17/18).
// ============================================================================

const MUHURAT_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 }; // 60-minute Muhurat-style special session
const MULTI_WINDOWS: readonly SessionWindow[] = [
  { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }, // 09:15-10:00
  { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 }, // 11:30-12:30
];
const REGULAR_SESSION_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };

function readPersistedUnderlyingManifest(harness: Harness, datasetId: string): DatasetManifest {
  return JSON.parse(readFileSync(join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M, `${datasetId}.json`), 'utf8')) as DatasetManifest;
}

test('(GAP1-1) year runner REGULAR_SESSION manifest generation still validates against exactly the calendar-derived 375-minute regular window', async () => {
  const date = '2022-01-03';
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: [date] }) });
  try {
    harness.candleRepo.rows = normalSessionRows(date);
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: date, toDate: date });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);

    assert.deepEqual(harness.fakeCalendarSessionResolver.calls, [[date]]);
    const datasetId = materialization!.materialization![0].datasetId!;
    const manifest = readPersistedUnderlyingManifest(harness, datasetId);
    assert.equal(manifest.sessions[0].canonicalRowCount, 375);
    assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, 'HEALTHY');
    assert.deepEqual(manifest.sessions[0].calendarSessionWindows, [REGULAR_SESSION_WINDOW]);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-2/3/16) a SPECIAL_SESSION date carries its exact 60-minute calendar windows into manifest generation AND B-F7 materialization -- HEALTHY at 60 rows, never scored against the fixed 375-row default, and the resampler never rejects the Muhurat-style window as pre/post-market', async () => {
  const date = '2022-11-04';
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: [date] }),
    calendarWindowsFor: () => [MUHURAT_WINDOW],
  });
  try {
    harness.candleRepo.rows = sessionRowsForWindows(date, [MUHURAT_WINDOW]);
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: date, toDate: date });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);

    // B-F7 CALENDAR FIX (task invariant G, coverage item 16): a certified
    // Muhurat-style special session (16:45-17:45 IST -- entirely outside the
    // fixed 09:15-15:29 regular window) now materializes cleanly end-to-end:
    // `HistoricalCandleResamplerService` consumes the SAME `calendarSessionWindows`
    // the manifest already certified HEALTHY, so it is never re-rejected as a
    // "pre-market"/"post-market row" downstream of an otherwise-correct manifest.
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);
    const outcome = materialization?.materialization?.[0];
    const byTimeframe = Object.fromEntries((outcome?.sessions[0]?.resamples ?? []).map((r) => [r.targetTimeframe, r]));
    // 60 minutes / {2m,3m,5m} divides evenly -- no partial/excluded trailing bucket.
    assert.equal(byTimeframe['2m']?.derivedBucketCount, 30);
    assert.equal(byTimeframe['3m']?.derivedBucketCount, 20);
    assert.equal(byTimeframe['5m']?.derivedBucketCount, 12);
    for (const timeframe of ['2m', '3m', '5m']) assert.equal(byTimeframe[timeframe]?.status, ResampleSessionStatus.COMPLETE_SESSION);

    const manifestDir = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M);
    const [manifestFile] = readdirSync(manifestDir);
    const manifest = JSON.parse(readFileSync(join(manifestDir, manifestFile), 'utf8')) as DatasetManifest;
    assert.equal(manifest.sessions[0].canonicalRowCount, 60);
    assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, 'HEALTHY');
    assert.deepEqual(manifest.sessions[0].calendarSessionWindows, [MUHURAT_WINDOW]);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-4/17) a multi-window SPECIAL_SESSION (105 = 45+60 minutes) carries the exact disjoint windows into manifest generation AND materializes through B-F7 without ever bridging the closed [600,690) gap', async () => {
  const date = '2022-06-01';
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: [date] }),
    calendarWindowsFor: () => MULTI_WINDOWS,
  });
  try {
    harness.candleRepo.rows = sessionRowsForWindows(date, MULTI_WINDOWS);
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: date, toDate: date });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    const outcome = materialization?.materialization?.[0];
    assert.equal(outcome?.sessions[0]?.persistedCanonicalHealthStatus, 'HEALTHY');

    // B-F7 CALENDAR FIX (task invariant B/G, coverage item 17): the resampler
    // buckets each window independently -- window 0 (45 min, 09:15-10:00)
    // and window 1 (60 min, 11:30-12:30) never merge into one contiguous
    // 105-minute run. 5m/3m divide both window lengths evenly (9+12=21,
    // 15+20=35 buckets, zero excluded); 2m does NOT evenly divide window 0's
    // 45 minutes, so window 0 alone contributes exactly one excluded
    // trailing minute (22 complete 2m buckets) while window 1's 60 minutes
    // remain evenly divisible (30 complete) -- 52 total, never 52.5 rounded
    // or a single spurious boundary bucket straddling the gap.
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);
    const byTimeframe = Object.fromEntries((outcome?.sessions[0]?.resamples ?? []).map((r) => [r.targetTimeframe, r]));
    assert.equal(byTimeframe['5m']?.derivedBucketCount, 21);
    assert.equal(byTimeframe['3m']?.derivedBucketCount, 35);
    assert.equal(byTimeframe['2m']?.derivedBucketCount, 52);
    for (const timeframe of ['2m', '3m', '5m']) assert.equal(byTimeframe[timeframe]?.status, ResampleSessionStatus.COMPLETE_SESSION);

    const manifest = readPersistedUnderlyingManifest(harness, outcome!.datasetId!);
    assert.equal(manifest.sessions[0].canonicalRowCount, 45 + 60);
    assert.deepEqual(manifest.sessions[0].calendarSessionWindows, MULTI_WINDOWS);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-5) a certified weekend SPECIAL_SESSION date is handled identically to any other calendar-declared session -- weekday-ness is irrelevant once the calendar has certified it', async () => {
  const saturdayDate = '2022-01-08'; // certified Saturday special session
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: [saturdayDate] }),
    calendarWindowsFor: () => [MUHURAT_WINDOW],
  });
  try {
    harness.candleRepo.rows = sessionRowsForWindows(saturdayDate, [MUHURAT_WINDOW]);
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: saturdayDate, toDate: saturdayDate });

    // This test proves the calendar-authoritative MANIFEST *and* B-F7
    // RESAMPLING layers both treat a certified Saturday special session
    // identically to any other calendar-declared session -- weekday-ness
    // never matters once certified (task invariant G).
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.COMPLETED);

    const manifestDir = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M);
    const [manifestFile] = readdirSync(manifestDir);
    const manifest = JSON.parse(readFileSync(join(manifestDir, manifestFile), 'utf8')) as DatasetManifest;
    assert.equal(manifest.sessions[0].identity.tradingDate, saturdayDate);
    assert.equal(manifest.sessions[0].canonicalRowCount, 60);
    assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, 'HEALTHY');
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-6/7) EXCHANGE_HOLIDAY/EXCEPTIONAL_CLOSURE dates are never candidates the year runner materializes -- they are excluded upstream by calendar-aware acquisition, never reaching manifest generation at all', async () => {
  // GAP 1's own description: "ordinary exchange holidays such as 2022-01-26
  // are not the same problem [for the year runner]" -- `healthyTradingDates`
  // comes exclusively from `NiftyUnderlyingAcquisitionService`'s own
  // calendar-aware planner (untouched by this correction), which only ever
  // buckets REGULAR_TRADING_DAY/SPECIAL_SESSION_DAY dispositions as
  // fetch-eligible/healthy -- CLOSED_HOLIDAY/CLOSED_EXCEPTIONAL dates are
  // bucketed `closedNoDataExpected`, never `newlyCompleted`/`alreadyComplete`/
  // `normalizedWithExclusions`, so they structurally never reach this
  // method's `healthyTradingDates` in the first place (see
  // `executeUnderlyingAcquisition`). This is proven directly by exclusion:
  // an acquisition result reporting a holiday only in `closedNoDataExpected`
  // (never in any healthy bucket) produces zero materialized sessions for it.
  const holidayDate = '2022-01-26';
  const result = underlyingResult({ newlyCompleted: ['2022-01-25'] });
  const withClosedDate: NiftyUnderlyingAcquisitionResult = { ...result, sessions: { ...result.sessions, closedNoDataExpected: [holidayDate] } };
  const harness = newHarness({ underlyingResult: withClosedDate });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-25');
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: '2022-01-24', toDate: '2022-01-26' });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    const outcome = materialization?.materialization?.[0];
    assert.deepEqual(outcome?.sessions.map((s) => s.tradingDate), ['2022-01-25']);
    assert.equal(harness.fakeCalendarSessionResolver.calls[0]?.includes(holidayDate), false);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-8) UNCERTIFIED/inconsistent calendar scope at materialization time fails the stage closed -- no manifest artifact is written, no checkpoint certifies a clean run', async () => {
  const date = '2022-01-03';
  const harness = newHarness({ underlyingResult: underlyingResult({ newlyCompleted: [date] }) });
  try {
    harness.candleRepo.rows = normalSessionRows(date);
    // Force the calendar lookup itself to fail closed, exactly as
    // `ManifestCalendarSessionWindowLookupError` would for a date that no
    // longer certifies as a real trading session between acquisition and
    // materialization (task invariant A: "do not produce a clean year
    // checkpoint/manifest from uncertified scope").
    harness.fakeCalendarSessionResolver.resolveSessionWindowsForDates = async () => {
      throw new ManifestCalendarSessionWindowLookupError([date], []);
    };

    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, fromDate: date, toDate: date });
    const materialization = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION);
    assert.equal(materialization?.status, ResearchYearRunStageStatus.FAILED);
    assert.match(materialization?.detail ?? '', /ManifestCalendarSessionWindowLookupError|UNCERTIFIED/);
    assert.equal(record.outcome, ResearchYearRunOutcome.FAILED);

    // No manifest artifact was ever written for this run -- generation was
    // never reached (the calendar lookup happens before `generateManifest`'s
    // own service call).
    const manifestDir = join(harness.manifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M);
    assert.equal(existsSync(manifestDir), false);
    // No checkpoint ever certifies this run as cleanly resumable past the failure.
    assert.equal(harness.checkpointService.load(record.plan)?.outcome, ResearchYearRunOutcome.FAILED);
  } finally {
    harness.cleanup();
  }
});

// ============================================================================
// TERRA HIGH DEFECT CORRECTION: `executeOptionCandleAcquisition` previously
// called `optionCandleAcquisitionService.acquire({ providerContractId,
// tradingDates, dryRun: false })` WITHOUT `calendarSessionWindows`. Since
// `GrowwOptionCandleAcquisitionService.acquire` intentionally falls back to
// the fixed 09:15-15:29/375-row regular contract whenever `calendarSessionWindows`
// is omitted, a certified SPECIAL_SESSION option date reaching year-runner
// OPTION_CANDLE_ACQUISITION was silently evaluated against the WRONG
// contract -- even though the exact same authoritative windows were already
// being resolved (and correctly propagated) for option MANIFEST generation
// a few lines later in `materializeOptionContract`. The fix resolves
// `calendarSessionWindows` via the SAME injected `calendarSessionResolverService`
// immediately before the `acquire()` call and passes it through unchanged.
//
// These tests assert the ACTUAL `GrowwOptionCandleAcquisitionRequest` object
// `FakeOptionCandleAcquisitionService.calls` captured -- the real object that
// crosses the year-runner -> Groww acquisition boundary -- never a canned
// mock answer.
// ============================================================================

const OPTION_CONTRACT_ID = 'NSE-NIFTY-06Jan22-17200-PE';

test('(GAP1-OPT-1) CRITICAL: a certified 60-minute SPECIAL_SESSION option date propagates its EXACT calendarSessionWindows to GrowwOptionCandleAcquisitionService.acquire -- the precise HIGH defect Terra found', async () => {
  const specialDate = '2022-11-04';
  const muhuratWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 };
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [specialDate] }]);
  const harness = newHarness({
    requiredOptionSessionSource: requiredSource,
    calendarWindowsFor: (date) => (date === specialDate ? [muhuratWindow] : [REGULAR_WINDOW]),
  });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });

    const call = harness.fakeOptionCandle?.calls[0];
    assert.ok(call, 'GrowwOptionCandleAcquisitionService.acquire must have been called');
    assert.ok(call!.tradingDates.includes(specialDate));
    // The exact request object must NOT have calendarSessionWindows undefined -- that is precisely
    // the defect: an undefined map silently triggers the service's own fixed-375-row fallback.
    assert.notEqual(call!.calendarSessionWindows, undefined);
    const windowsForDate = call!.calendarSessionWindows?.[specialDate];
    assert.ok(windowsForDate, `calendarSessionWindows must contain an entry for ${specialDate}`);
    assert.equal(windowsForDate!.length, 1);
    assert.equal(windowsForDate![0].openMinuteIst, 1005);
    assert.equal(windowsForDate![0].closeMinuteIst, 1065);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-OPT-2) an ordinary REGULAR_SESSION option date propagates exactly [regularSessionWindow()] = {openMinuteIst:555, closeMinuteIst:930}', async () => {
  const date = '2022-01-03';
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [date] }]);
  const harness = newHarness({ requiredOptionSessionSource: requiredSource });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const call = harness.fakeOptionCandle?.calls[0];
    assert.notEqual(call?.calendarSessionWindows, undefined);
    assert.deepEqual(call?.calendarSessionWindows?.[date], [REGULAR_WINDOW]);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-OPT-3) a multi-window SPECIAL_SESSION option date propagates BOTH declared windows unchanged: [555,600) + [690,750)', async () => {
  const date = '2022-06-01';
  const multiWindows: readonly SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [date] }]);
  const harness = newHarness({
    requiredOptionSessionSource: requiredSource,
    calendarWindowsFor: (d) => (d === date ? multiWindows : [REGULAR_WINDOW]),
  });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const call = harness.fakeOptionCandle?.calls[0];
    assert.deepEqual(call?.calendarSessionWindows?.[date], multiWindows);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-OPT-4) a certified Saturday SPECIAL_SESSION option date is included in tradingDates and its windows are propagated -- weekday-ness is irrelevant once certified', async () => {
  const saturdayDate = '2022-01-08';
  const muhuratWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 };
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [saturdayDate] }]);
  const harness = newHarness({
    requiredOptionSessionSource: requiredSource,
    calendarWindowsFor: () => [muhuratWindow],
  });
  try {
    await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const call = harness.fakeOptionCandle?.calls[0];
    assert.ok(call?.tradingDates.includes(saturdayDate));
    assert.deepEqual(call?.calendarSessionWindows?.[saturdayDate], [muhuratWindow]);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-OPT-5) an UNCERTIFIED option trading date fails OPTION_CANDLE_ACQUISITION closed BEFORE acquire() is ever called -- no partial/invalid request reaches Groww', async () => {
  const date = '2022-01-03';
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [date] }]);
  const harness = newHarness({ requiredOptionSessionSource: requiredSource });
  try {
    // Force the calendar lookup itself to fail closed, exactly as
    // `ManifestCalendarSessionWindowLookupError` would for a date that no
    // longer certifies as a real trading session (task invariant 9).
    harness.fakeCalendarSessionResolver.resolveSessionWindowsForDates = async () => {
      throw new ManifestCalendarSessionWindowLookupError([date], []);
    };

    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.OPTIONS });
    const acquisition = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
    assert.equal(acquisition?.status, ResearchYearRunStageStatus.FAILED);
    assert.match(acquisition?.detail ?? '', /ManifestCalendarSessionWindowLookupError|UNCERTIFIED/);
    assert.equal(harness.fakeOptionCandle?.calls.length ?? 0, 0);
    assert.equal(record.outcome, ResearchYearRunOutcome.FAILED);
  } finally {
    harness.cleanup();
  }
});

test('(GAP1-OPT-6) scope=ALL: OPTION_CANDLE_ACQUISITION still propagates calendarSessionWindows exactly as under scope=OPTIONS', async () => {
  const specialDate = '2022-11-04';
  const muhuratWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 };
  const requiredSource = new FakeRequiredOptionSessionSource([{ providerContractId: OPTION_CONTRACT_ID, tradingDates: [specialDate] }]);
  const harness = newHarness({
    underlyingResult: underlyingResult({ newlyCompleted: ['2022-01-03'] }),
    requiredOptionSessionSource: requiredSource,
    calendarWindowsFor: (date) => (date === specialDate ? [muhuratWindow] : [REGULAR_WINDOW]),
  });
  try {
    harness.candleRepo.rows = normalSessionRows('2022-01-03');
    const record = await harness.runner.run({ ...REQUEST_UNDERLYING_ONLY, scope: ResearchYearRunScope.ALL });

    const acquisition = record.stages.find((s) => s.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
    assert.equal(acquisition?.status, ResearchYearRunStageStatus.COMPLETED);
    const call = harness.fakeOptionCandle?.calls[0];
    assert.notEqual(call?.calendarSessionWindows, undefined);
    assert.deepEqual(call?.calendarSessionWindows?.[specialDate], [muhuratWindow]);
  } finally {
    harness.cleanup();
  }
});
