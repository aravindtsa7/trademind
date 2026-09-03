import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSourceRowsSemanticChecksum,
  DatasetHealthStatus,
  expectedCanonicalTimestamps,
  expectedMinutesForWindow,
  HistoricalCandleSessionPersistenceOutcome,
  HistoricalSourceCandleRow,
  istMinuteOfDay,
  regularSessionWindow,
} from '../domain';
import { ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { HistoricalDataProvider, HistoricalUnderlyingCandleRangeRequest } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalDataRetrievalEvidenceService, { QualifiedIncompleteSessionEvidence } from './historical-data-retrieval-evidence.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import NiftyUnderlyingIngestionPlannerService, { NiftyIngestionPlan, NiftyPlannedDate, NiftyPlannedDateDisposition } from './nifty-underlying-ingestion-planner.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';
import NiftyIndexGapImputationService, { NiftyIndexGapImputationError, NiftyIndexGapImputationServiceDependencies } from './nifty-index-gap-imputation.service';

/**
 * B-M7.1: zero-DB, zero-network orchestrator test suite. Every network/DB
 * boundary (`primaryProvider`, `plannerService`, `retrievalEvidenceService`)
 * is a duck-typed fake, cast `as unknown as <RealClass>` -- the SAME
 * convention already established by `nifty-underlying-acquisition.service.test.ts`
 * (`FakeAllRegularPlanner`) and `historical-data-retrieval-evidence.service.test.ts`
 * (fake Prisma). Critically, the fakes below expose ONLY the read methods
 * this milestone actually needs (`fetchCompletedUnderlyingRange`,
 * `buildPlan`, `findTerminalIncompleteSessionEvidence`) -- none of them
 * implement any write/persist method at all, so an accidental attempt by
 * the orchestrator to call `startRetrieval`/`recordFetched`/`persistSession`/
 * any canonical-write path would throw a hard "not a function" TypeError,
 * not silently succeed. This is itself part of the section-16/H canonical-
 * safety proof, not merely a testing convenience.
 */

const TRADING_DATE = '2022-03-07';
const WINDOW = regularSessionWindow();
const EXPECTED_MINUTES_IST = expectedMinutesForWindow(WINDOW); // 375 ascending minutes, 555..929
const EXPECTED_TIMESTAMPS = expectedCanonicalTimestamps(TRADING_DATE, EXPECTED_MINUTES_IST); // 375 ascending Dates
const MISSING_MINUTES_IST = [622, 623, 624]; // 10:22, 10:23, 10:24 IST

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fullSessionRows(): HistoricalSourceCandleRow[] {
  return EXPECTED_MINUTES_IST.map((_minute, index) => {
    const price = round2(17000 + index * 0.37);
    return {
      sourceIndex: index,
      candleTime: EXPECTED_TIMESTAMPS[index],
      open: price,
      high: round2(price + 0.5),
      low: round2(price - 0.5),
      close: round2(price + 0.1),
      volume: 1000n + BigInt(index),
      openInterest: null,
    };
  });
}

function withoutMinutes(rows: readonly HistoricalSourceCandleRow[], minutesIst: readonly number[]): HistoricalSourceCandleRow[] {
  const excluded = new Set(minutesIst);
  return rows.filter((row) => !excluded.has(istMinuteOfDay(row.candleTime))).map((row, index) => ({ ...row, sourceIndex: index }));
}

/** Looks up a row's ARRAY POSITION by its actual minute-of-day (IST) -- NEVER by re-deriving a position from the unfiltered `EXPECTED_MINUTES_IST` array, which would silently be wrong for any minute AFTER a removed gap (array positions shift once earlier rows are filtered out). */
function indexOfMinuteInRows(rows: readonly HistoricalSourceCandleRow[], minuteIst: number): number {
  const index = rows.findIndex((row) => istMinuteOfDay(row.candleTime) === minuteIst);
  if (index === -1) throw new Error(`No row for minute ${minuteIst} IST found in the given row set.`);
  return index;
}

const GOOD_372_ROWS: readonly HistoricalSourceCandleRow[] = withoutMinutes(fullSessionRows(), MISSING_MINUTES_IST);
const GOOD_372_CHECKSUM = computeSourceRowsSemanticChecksum(GOOD_372_ROWS);

// ---- Fakes ----------------------------------------------------------------

class FakeProvider implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.UPSTOX;
  public readonly calls: HistoricalUnderlyingCandleRangeRequest[] = [];

  constructor(
    private readonly rowsOrError: readonly HistoricalSourceCandleRow[] | Error
  ) {}

  getCapability(): HistoricalProviderCapability {
    throw new Error('FakeProvider.getCapability is not used by NiftyIndexGapImputationService.');
  }

  async fetchCompletedUnderlyingRange(request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    this.calls.push(request);
    if (this.rowsOrError instanceof Error) throw this.rowsOrError;
    return this.rowsOrError;
  }

  async fetchExpiredOptionRange(): Promise<never> {
    throw new Error('FakeProvider.fetchExpiredOptionRange is not used by NiftyIndexGapImputationService.');
  }
}

function regularPlannedDate(tradingDate: string, overrides: Partial<NiftyPlannedDate> = {}): NiftyPlannedDate {
  return {
    tradingDate,
    disposition: NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
    expectedMinuteCount: 375,
    expectedMinutesIst: EXPECTED_MINUTES_IST,
    sessionWindows: [WINDOW],
    explicitReason: null,
    calendarCoverage: null,
    sourceDocument: null,
    ...overrides,
  };
}

class FakePlanner {
  public readonly calls: { fromDate: string; toDate: string }[] = [];
  constructor(private readonly dates: readonly NiftyPlannedDate[], private readonly hasBlockedDates = false) {}

  async buildPlan(request: { fromDate: string; toDate: string }): Promise<Pick<NiftyIngestionPlan, 'dates' | 'hasBlockedDates'>> {
    this.calls.push(request);
    return { dates: this.dates, hasBlockedDates: this.hasBlockedDates };
  }
}

class FakeRetrievalEvidenceService {
  public callCount = 0;
  constructor(private readonly evidence: QualifiedIncompleteSessionEvidence | null) {}

  async findTerminalIncompleteSessionEvidence(): Promise<QualifiedIncompleteSessionEvidence | null> {
    this.callCount += 1;
    return this.evidence;
  }
}

function qualifiedEvidence(overrides: Partial<QualifiedIncompleteSessionEvidence> = {}): QualifiedIncompleteSessionEvidence {
  return {
    retrievalId: 'retrieval-1',
    sessionId: 'session-1',
    providerId: HistoricalProviderId.UPSTOX,
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    timeframe: NIFTY_UNDERLYING_TIMEFRAME,
    tradingDate: TRADING_DATE,
    calendarDisposition: NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
    expectedMinuteCount: 375,
    providerRowCountForDate: 372,
    acceptedRowCount: 372,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    healthStatus: DatasetHealthStatus.INCOMPLETE,
    persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INCOMPLETE,
    sourceRowsSemanticChecksum: GOOD_372_CHECKSUM,
    evidenceSemanticChecksum: 'durable-evidence-checksum-1',
    ...overrides,
  };
}

interface BuiltService {
  readonly service: NiftyIndexGapImputationService;
  readonly provider: FakeProvider;
  readonly planner: FakePlanner;
  readonly retrievalEvidenceService: FakeRetrievalEvidenceService;
}

function buildService(
  options: {
    providerRowsOrError?: readonly HistoricalSourceCandleRow[] | Error;
    plannedDates?: readonly NiftyPlannedDate[];
    hasBlockedDates?: boolean;
    evidence?: QualifiedIncompleteSessionEvidence | null;
    persistArtifactsToDisk?: boolean;
    archiveRoot?: string;
  } = {}
): BuiltService {
  const provider = new FakeProvider(options.providerRowsOrError ?? GOOD_372_ROWS);
  const planner = new FakePlanner(options.plannedDates ?? [regularPlannedDate(TRADING_DATE)], options.hasBlockedDates ?? false);
  const retrievalEvidenceService = new FakeRetrievalEvidenceService(options.evidence === undefined ? qualifiedEvidence() : options.evidence);

  const dependencies: NiftyIndexGapImputationServiceDependencies = {
    primaryProvider: provider,
    plannerService: planner as unknown as NiftyUnderlyingIngestionPlannerService,
    retrievalEvidenceService: retrievalEvidenceService as unknown as HistoricalDataRetrievalEvidenceService,
    primaryRateLimiter: new HistoricalProviderRateLimiterService(0),
    persistArtifactsToDisk: options.persistArtifactsToDisk ?? false,
    archiveRoot: options.archiveRoot,
  };

  return { service: new NiftyIndexGapImputationService(dependencies), provider, planner, retrievalEvidenceService };
}

function corruptedRow(rows: readonly HistoricalSourceCandleRow[], index: number, overrides: Partial<HistoricalSourceCandleRow>): HistoricalSourceCandleRow[] {
  return rows.map((row, i) => (i === index ? { ...row, ...overrides } : row));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof NiftyIndexGapImputationError, `expected NiftyIndexGapImputationError, got ${String(error)}`);
    assert.equal((error as NiftyIndexGapImputationError).code, code);
    return true;
  });
}

// ---- Happy path -------------------------------------------------------

test('happy path: assembles a 375-row derived session (372 observed + 3 imputed)', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });

  assert.equal(result.observedSnapshot.observedRowCount, 372);
  assert.equal(result.derivedSession.realRowCount, 372);
  assert.equal(result.derivedSession.imputedRowCount, 3);
  assert.equal(result.derivedSession.rows.length, 375);
  assert.equal(result.derivedSession.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);

  const imputedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
  const observedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.OBSERVED);
  assert.equal(imputedRows.length, 3);
  assert.equal(observedRows.length, 372);
});

test('happy path: rows are unique ascending expected candle times with zero gaps', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const times = result.derivedSession.rows.map((row) => row.candleTime);
  const expectedTimes = EXPECTED_TIMESTAMPS.map((d) => d.toISOString());
  assert.deepEqual(times, expectedTimes);
  assert.equal(new Set(times).size, 375);
});

test('happy path: exactly zero provider calls before qualification and exactly one after', async () => {
  const { service, provider, retrievalEvidenceService } = buildService();
  await service.buildImputedSession({ tradingDate: TRADING_DATE });
  assert.equal(retrievalEvidenceService.callCount, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].fromTradingDate, TRADING_DATE);
  assert.equal(provider.calls[0].toTradingDate, TRADING_DATE);
  assert.equal(provider.calls[0].instrumentKey, NIFTY_INDEX_INSTRUMENT_KEY);
});

// ---- E: Provenance ------------------------------------------------------

test('provenance: observed rows are marked OBSERVED and link back to the snapshot checksum', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const observedRow = result.derivedSession.rows.find((row) => row.provenance.kind === ResearchRowProvenanceKind.OBSERVED)!;
  assert.equal(observedRow.provenance.kind, ResearchRowProvenanceKind.OBSERVED);
  if (observedRow.provenance.kind === ResearchRowProvenanceKind.OBSERVED) {
    assert.equal(observedRow.provenance.sourceSnapshotChecksum, result.observedSnapshot.snapshotContentChecksum);
  }
});

test('provenance: exactly 3 rows marked IMPUTED, at exactly 10:22/10:23/10:24 IST', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const imputedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
  assert.equal(imputedRows.length, 3);
  const minutes = imputedRows.map((row) => istMinuteOfDay(new Date(row.candleTime))).sort((a, b) => a - b);
  assert.deepEqual(minutes, MISSING_MINUTES_IST);
});

test('provenance: imputed rows never claim a provider-supplied origin (no provider field anywhere in an imputed row)', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const imputedRow = result.derivedSession.rows.find((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED)!;
  const serialized = JSON.stringify(imputedRow);
  assert.ok(!serialized.includes('"provider"'), 'an imputed row must never carry a bare "provider" field claiming synthetic-value origin');
  assert.equal(imputedRow.provenance.kind, ResearchRowProvenanceKind.IMPUTED);
});

test('provenance: imputed rows carry method/policyVersion/authorizationId/reason and both anchors', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const imputedRow = result.derivedSession.rows.find((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED)!;
  assert.equal(imputedRow.provenance.kind, ResearchRowProvenanceKind.IMPUTED);
  if (imputedRow.provenance.kind === ResearchRowProvenanceKind.IMPUTED) {
    assert.equal(imputedRow.provenance.method, 'LINEAR_BOUNDARY_INTERPOLATION');
    assert.equal(imputedRow.provenance.policyVersion, 1);
    assert.equal(imputedRow.provenance.authorizationId, 'NIFTY_2022_03_07_INDEX_GAP_V1');
    assert.equal(imputedRow.provenance.reason, 'INDEX_BROADCAST_DATA_GAP');
    assert.equal(new Date(imputedRow.provenance.leftAnchor.candleTime).toISOString(), EXPECTED_TIMESTAMPS[EXPECTED_MINUTES_IST.indexOf(621)].toISOString());
    assert.equal(imputedRow.provenance.leftAnchor.field, 'CLOSE');
    assert.equal(new Date(imputedRow.provenance.rightAnchor.candleTime).toISOString(), EXPECTED_TIMESTAMPS[EXPECTED_MINUTES_IST.indexOf(625)].toISOString());
    assert.equal(imputedRow.provenance.rightAnchor.field, 'OPEN');
    assert.equal(imputedRow.provenance.sourceSnapshotChecksum, result.observedSnapshot.snapshotContentChecksum);
  }
});

// ---- D: interpolation content ----

test('interpolation: volume=0 and openInterest=null for every imputed row', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const imputedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
  for (const row of imputedRows) {
    assert.equal(row.volume, '0');
    assert.equal(row.openInterest, null);
  }
});

test('interpolation: imputed row continuity -- open of the middle imputed candle equals close of the first', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const imputedRows = result.derivedSession.rows
    .filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED)
    .sort((a, b) => (a.candleTime < b.candleTime ? -1 : 1));
  assert.equal(imputedRows[0].close, imputedRows[1].open);
  assert.equal(imputedRows[1].close, imputedRows[2].open);
});

// ---- F: No lookahead ----------------------------------------------------

test('no-lookahead: all 3 imputed rows share availableAt = one minute after the REAL right-anchor candle (10:26 IST)', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const rightAnchorTimestamp = EXPECTED_TIMESTAMPS[EXPECTED_MINUTES_IST.indexOf(625)];
  const expectedAvailableAt = new Date(rightAnchorTimestamp.getTime() + 60_000).toISOString();
  const imputedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
  for (const row of imputedRows) {
    assert.equal(row.availableAt, expectedAvailableAt);
  }
});

test('no-lookahead: the FIRST imputed row (10:22) is NOT available at its own nominal completion (10:23) -- only at 10:26', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const row1022 = result.derivedSession.rows.find((row) => istMinuteOfDay(new Date(row.candleTime)) === 622)!;
  const naiveOwnCompletion = new Date(new Date(row1022.candleTime).getTime() + 60_000).toISOString(); // what an OBSERVED row's own availableAt would be
  assert.notEqual(row1022.availableAt, naiveOwnCompletion, '10:22 synthetic data must never be causally visible at 10:23');
  assert.ok(new Date(row1022.availableAt).getTime() > new Date(naiveOwnCompletion).getTime());
});

test('no-lookahead: an OBSERVED row keeps ordinary "own candleTime + 1 minute" availability', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const observedRow = result.derivedSession.rows.find((row) => row.provenance.kind === ResearchRowProvenanceKind.OBSERVED)!;
  const expected = new Date(new Date(observedRow.candleTime).getTime() + 60_000).toISOString();
  assert.equal(observedRow.availableAt, expected);
});

// ---- G: Determinism -------------------------------------------------------

test('determinism: two independent runs from the identical qualified source produce identical snapshot + derived checksums', async () => {
  const runOnce = async () => (await buildService().service.buildImputedSession({ tradingDate: TRADING_DATE }));
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.observedSnapshot.snapshotContentChecksum, second.observedSnapshot.snapshotContentChecksum);
  assert.equal(first.derivedSession.derivedContentChecksum, second.derivedSession.derivedContentChecksum);
  assert.deepEqual(first.derivedSession.rows, second.derivedSession.rows);
});

// ---- H: Canonical safety --------------------------------------------------

test('canonical safety: the fakes expose no write/persist method at all -- the orchestrator never references one', async () => {
  const { service, retrievalEvidenceService } = buildService();
  await service.buildImputedSession({ tradingDate: TRADING_DATE });
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(retrievalEvidenceService));
  assert.deepEqual(methods.sort(), ['constructor', 'findTerminalIncompleteSessionEvidence'].sort());
});

test('canonical safety: qualification failing closed leaves zero provider calls', async () => {
  const { service, provider, retrievalEvidenceService } = buildService({ evidence: null });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'NO_DURABLE_INCOMPLETE_EVIDENCE');
  assert.equal(provider.calls.length, 0);
  assert.equal(retrievalEvidenceService.callCount, 1);
});

// ---- Authorization gate --------------------------------------------------

test('DATE_NOT_AUTHORIZED: a different tradingDate fails closed before any DB/provider call', async () => {
  const { service, provider, retrievalEvidenceService } = buildService();
  await expectCode(service.buildImputedSession({ tradingDate: '2022-03-08' }), 'DATE_NOT_AUTHORIZED');
  assert.equal(retrievalEvidenceService.callCount, 0);
  assert.equal(provider.calls.length, 0);
});

// ---- A: Qualification against durable evidence ---------------------------

test('DURABLE_EVIDENCE_FACTS_MISMATCH: wrong calendarDisposition on the durable evidence fails closed before any provider call', async () => {
  const { service, provider } = buildService({ evidence: qualifiedEvidence({ calendarDisposition: NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY }) });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'DURABLE_EVIDENCE_FACTS_MISMATCH');
  assert.equal(provider.calls.length, 0);
});

test('DURABLE_EVIDENCE_FACTS_MISMATCH: wrong expectedMinuteCount fails closed', async () => {
  const { service } = buildService({ evidence: qualifiedEvidence({ expectedMinuteCount: 105 }) });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'DURABLE_EVIDENCE_FACTS_MISMATCH');
});

test('DURABLE_EVIDENCE_FACTS_MISMATCH: wrong providerRowCountForDate fails closed', async () => {
  const { service } = buildService({ evidence: qualifiedEvidence({ providerRowCountForDate: 375 }) });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'DURABLE_EVIDENCE_FACTS_MISMATCH');
});

test('DURABLE_EVIDENCE_FACTS_MISMATCH: wrong acceptedRowCount fails closed', async () => {
  const { service } = buildService({ evidence: qualifiedEvidence({ acceptedRowCount: 370 }) });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'DURABLE_EVIDENCE_FACTS_MISMATCH');
});

// ---- Calendar re-resolution defense-in-depth ------------------------------

test('CALENDAR_BLOCKED: an independently-uncertified calendar fails closed even if durable evidence itself looked fine', async () => {
  const { service } = buildService({ hasBlockedDates: true });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'CALENDAR_BLOCKED');
});

test('CALENDAR_NOT_FETCH_ELIGIBLE: an independently-closed calendar disposition fails closed', async () => {
  const { service } = buildService({ plannedDates: [regularPlannedDate(TRADING_DATE, { disposition: NiftyPlannedDateDisposition.CLOSED_HOLIDAY, expectedMinuteCount: 0, expectedMinutesIst: [], sessionWindows: [] })] });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'CALENDAR_NOT_FETCH_ELIGIBLE');
});

// ---- B: Current observation ------------------------------------------------

test('exact 372 source observation + matching checksum accepted (happy path, re-asserted for section B)', async () => {
  const { service } = buildService();
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  assert.equal(result.observedSnapshot.sourceRowsSemanticChecksum, GOOD_372_CHECKSUM);
});

test('SOURCE_CHECKSUM_DRIFT: current re-observation checksum differs from durable evidence -- fails closed', async () => {
  const { service } = buildService({ evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: 'a'.repeat(64) }) });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_CHECKSUM_DRIFT');
});

test('SOURCE_NO_LONGER_INCOMPLETE: the provider now returns a full 375-row session -- fails closed, never fabricates synthetic candles', async () => {
  const full375 = fullSessionRows();
  const { service } = buildService({
    providerRowsOrError: full375,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(full375) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_NO_LONGER_INCOMPLETE');
});

test('SOURCE_HEALTH_NOT_INCOMPLETE: a duplicate minute in the current re-observation is rejected', async () => {
  const withDuplicate = [...GOOD_372_ROWS, { ...GOOD_372_ROWS[0], sourceIndex: GOOD_372_ROWS.length }];
  const { service } = buildService({
    providerRowsOrError: withDuplicate,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(withDuplicate) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_HEALTH_NOT_INCOMPLETE');
});

test('SOURCE_HEALTH_NOT_INCOMPLETE: invalid OHLC (high < low) in the current re-observation is rejected', async () => {
  const withInvalidOhlc = corruptedRow(GOOD_372_ROWS, 5, { high: 10, low: 20 });
  const { service } = buildService({
    providerRowsOrError: withInvalidOhlc,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(withInvalidOhlc) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_HEALTH_NOT_INCOMPLETE');
});

// ---- B-M7.1-BLOCKER-02: unsupported real-anchor precision, exercised through the orchestrator ----

test('L. UNSUPPORTED_ANCHOR_PRICE_PRECISION (left anchor): fails closed and writes NO snapshot/derived-session artifact', async () => {
  const minute621Index = indexOfMinuteInRows(GOOD_372_ROWS, 621);
  // A fully self-consistent, clean, LITERAL OHLC override (never derived via JS float arithmetic on the original row, which would reintroduce float-representation noise unrelated to the precision this test intends to exercise) -- close carries 3 decimal places (unsupported), open/high/low are clean values that keep the row's own OHLC validity intact.
  const corruptedRows = corruptedRow(GOOD_372_ROWS, minute621Index, { open: 17024.1, high: 17024.6, low: 17023.6, close: 17024.123 });
  const root = mkdtempSync(join(tmpdir(), 'nifty-index-gap-imputation-precision-test-'));
  try {
    const { service } = buildService({
      providerRowsOrError: corruptedRows,
      evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(corruptedRows) }),
      persistArtifactsToDisk: true,
      archiveRoot: root,
    });
    await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'UNSUPPORTED_ANCHOR_PRICE_PRECISION');
    assert.equal(existsSync(join(root, 'observed-incomplete-session-snapshots')), false, 'no observed snapshot artifact may exist');
    assert.equal(existsSync(join(root, 'derived-imputed-sessions')), false, 'no derived session artifact may exist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2. UNSUPPORTED_ANCHOR_PRICE_PRECISION (right anchor): fails closed and writes NO snapshot/derived-session artifact', async () => {
  const minute625Index = indexOfMinuteInRows(GOOD_372_ROWS, 625);
  // Same clean-literal-override approach as the left-anchor test above -- open carries 3 decimal places (unsupported), the rest of the row stays OHLC-valid.
  const corruptedRows = corruptedRow(GOOD_372_ROWS, minute625Index, { open: 17024.129, high: 17024.6, low: 17023.6, close: 17024.3 });
  const root = mkdtempSync(join(tmpdir(), 'nifty-index-gap-imputation-precision-test-'));
  try {
    const { service } = buildService({
      providerRowsOrError: corruptedRows,
      evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(corruptedRows) }),
      persistArtifactsToDisk: true,
      archiveRoot: root,
    });
    await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'UNSUPPORTED_ANCHOR_PRICE_PRECISION');
    assert.equal(existsSync(join(root, 'observed-incomplete-session-snapshots')), false, 'no observed snapshot artifact may exist');
    assert.equal(existsSync(join(root, 'derived-imputed-sessions')), false, 'no derived session artifact may exist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SOURCE_ROW_COUNT_MISMATCH: 371 rows (a 4-minute gap) rejected against durable evidence claiming 372 accepted', async () => {
  const rows371 = withoutMinutes(fullSessionRows(), [...MISSING_MINUTES_IST, 700]);
  const { service } = buildService({
    providerRowsOrError: rows371,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(rows371) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_ROW_COUNT_MISMATCH');
});

test('SOURCE_ROW_COUNT_MISMATCH: 373 rows (only a 2-minute gap) rejected against durable evidence claiming 372 accepted', async () => {
  const rows373 = withoutMinutes(fullSessionRows(), [622, 623]); // 10:24 present -- only 2 missing
  const { service } = buildService({
    providerRowsOrError: rows373,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(rows373) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_ROW_COUNT_MISMATCH');
});

test('SOURCE_MISSING_MINUTE_SET_MISMATCH: an alternate (shifted) 3-minute gap is rejected even though the row count still matches', async () => {
  const shiftedGap = withoutMinutes(fullSessionRows(), [630, 631, 632]);
  const { service } = buildService({
    providerRowsOrError: shiftedGap,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(shiftedGap) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_MISSING_MINUTE_SET_MISMATCH');
});

test('missing left anchor rejected: a gap that swallows the 10:21 anchor itself is rejected', async () => {
  const gapEatsLeftAnchor = withoutMinutes(fullSessionRows(), [621, 622, 623]);
  const { service } = buildService({
    providerRowsOrError: gapEatsLeftAnchor,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(gapEatsLeftAnchor) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_MISSING_MINUTE_SET_MISMATCH');
});

test('missing right anchor rejected: a gap that swallows the 10:25 anchor itself is rejected', async () => {
  const gapEatsRightAnchor = withoutMinutes(fullSessionRows(), [623, 624, 625]);
  const { service } = buildService({
    providerRowsOrError: gapEatsRightAnchor,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(gapEatsRightAnchor) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_MISSING_MINUTE_SET_MISMATCH');
});

test('SOURCE_UNEXPECTED_EXCLUSION: an out-of-window provider row is rejected even though the accepted count still matches', async () => {
  const preMarketRow: HistoricalSourceCandleRow = {
    sourceIndex: 0,
    candleTime: new Date(`${TRADING_DATE}T09:00:00+05:30`),
    open: 17000,
    high: 17000,
    low: 17000,
    close: 17000,
    volume: 1n,
    openInterest: null,
  };
  // Inserted chronologically FIRST (never appended out of order) -- this
  // test isolates the "excluded row" invariant from source-order-anomaly
  // detection, which is a materially different failure mode already covered
  // by the duplicate-minute/invalid-OHLC tests above.
  const withExclusion = [preMarketRow, ...GOOD_372_ROWS].map((row, index) => ({ ...row, sourceIndex: index }));
  const { service } = buildService({
    providerRowsOrError: withExclusion,
    evidence: qualifiedEvidence({ sourceRowsSemanticChecksum: computeSourceRowsSemanticChecksum(withExclusion) }),
  });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'SOURCE_UNEXPECTED_EXCLUSION');
});

test('PRIMARY_FETCH_FAILED: a provider error fails closed without writing any evidence', async () => {
  const { service, retrievalEvidenceService } = buildService({ providerRowsOrError: new Error('simulated network failure') });
  await expectCode(service.buildImputedSession({ tradingDate: TRADING_DATE }), 'PRIMARY_FETCH_FAILED');
  assert.equal(retrievalEvidenceService.callCount, 1); // qualification still ran (read-only) before the fetch attempt
});

// ---- Storage --------------------------------------------------------------

test('persistArtifactsToDisk writes content-addressed snapshot + derived-session JSON files that round-trip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nifty-index-gap-imputation-test-'));
  try {
    const { service } = buildService({ persistArtifactsToDisk: true, archiveRoot: root });
    const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
    assert.ok(result.observedSnapshotStorage);
    assert.ok(result.derivedSessionStorage);
    assert.equal(result.observedSnapshotStorage?.wasNewlyWritten, true);
    assert.equal(result.derivedSessionStorage?.wasNewlyWritten, true);

    const snapshotOnDisk = JSON.parse(readFileSync(result.observedSnapshotStorage!.absolutePath, 'utf8'));
    assert.equal(snapshotOnDisk.snapshotContentChecksum, result.observedSnapshot.snapshotContentChecksum);
    const derivedOnDisk = JSON.parse(readFileSync(result.derivedSessionStorage!.absolutePath, 'utf8'));
    assert.equal(derivedOnDisk.derivedContentChecksum, result.derivedSession.derivedContentChecksum);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistArtifactsToDisk: repeated runs against the same root are idempotent (verified skip)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nifty-index-gap-imputation-test-'));
  try {
    const first = await buildService({ persistArtifactsToDisk: true, archiveRoot: root }).service.buildImputedSession({ tradingDate: TRADING_DATE });
    const second = await buildService({ persistArtifactsToDisk: true, archiveRoot: root }).service.buildImputedSession({ tradingDate: TRADING_DATE });
    assert.equal(first.observedSnapshotStorage?.wasNewlyWritten, true);
    assert.equal(second.observedSnapshotStorage?.wasNewlyWritten, false);
    assert.equal(first.derivedSessionStorage?.wasNewlyWritten, true);
    assert.equal(second.derivedSessionStorage?.wasNewlyWritten, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistArtifactsToDisk=false performs zero filesystem writes -- storage results are both null', async () => {
  const { service } = buildService({ persistArtifactsToDisk: false });
  const result = await service.buildImputedSession({ tradingDate: TRADING_DATE });
  assert.equal(result.observedSnapshotStorage, null);
  assert.equal(result.derivedSessionStorage, null);
});
