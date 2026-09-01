import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import DatasetManifestService from './dataset-manifest.service';
import { ManifestCalendarSessionWindowsByDate, ManifestDatasetKind, SourceAcquisitionEvidence, SourceAcquisitionEvidenceAvailability, SourceAcquisitionProvenanceComposition } from '../domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const OPTION_CONTRACT_ID = 'NSE-NIFTY-06Jan22-17200-PE';

interface FakeRow {
  candleTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: bigint;
  openInterest: bigint | null;
}

function makeRow(candleTime: Date, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(tradingDate: string): FakeRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

/** Only implements `findRange` -- the only method `DatasetManifestService` ever calls (task section 16.W: "no provider API request during manifest generation/verification"; here, no OTHER repository method is called either). */
class FakeHistoricalCandleRepository {
  rows: FakeRow[] = [];
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<FakeRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

class FakeHistoricalOptionCandleLakeRepository {
  rows: FakeRow[] = [];
  findRangeCallCount = 0;

  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<FakeRow[]> {
    this.findRangeCallCount += 1;
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

/**
 * B-F2C: `DatasetManifestService` now looks up durable retrieval evidence
 * per underlying session via `HistoricalDataRetrievalEvidenceService` --
 * defaults to a REAL, Prisma-backed instance, which every test in this file
 * must avoid touching. `evidenceByKey` lets a test seed genuine-looking
 * evidence for a specific (instrumentKey, timeframe, tradingDate); every
 * other lookup truthfully returns `null` (no evidence), exactly matching
 * every pre-B-F2C test's expectation of `UNAVAILABLE_FROM_PERSISTED_STORE`.
 */
class FakeRetrievalEvidenceService {
  calls: { instrumentKey: string; timeframe: string; tradingDate: string }[] = [];
  constructor(private readonly evidenceByKey: ReadonlyMap<string, SourceAcquisitionEvidence> = new Map()) {}
  async findLatestAvailableSessionEvidence(instrumentKey: string, timeframe: string, tradingDate: string): Promise<SourceAcquisitionEvidence | null> {
    this.calls.push({ instrumentKey, timeframe, tradingDate });
    return this.evidenceByKey.get(`${instrumentKey}|${timeframe}|${tradingDate}`) ?? null;
  }
}

function newService(retrievalEvidenceService: FakeRetrievalEvidenceService = new FakeRetrievalEvidenceService()): {
  service: DatasetManifestService;
  candleRepo: FakeHistoricalCandleRepository;
  optionRepo: FakeHistoricalOptionCandleLakeRepository;
  retrievalEvidenceService: FakeRetrievalEvidenceService;
} {
  const candleRepo = new FakeHistoricalCandleRepository();
  const optionRepo = new FakeHistoricalOptionCandleLakeRepository();
  const service = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: optionRepo as unknown as HistoricalOptionCandleLakeRepository,
    retrievalEvidenceService: retrievalEvidenceService as unknown as HistoricalDataRetrievalEvidenceService,
  });
  return { service, candleRepo, optionRepo, retrievalEvidenceService };
}

test('(I) generatedAt changes between two runs, but dataset identity (checksum/id) stays the same for unchanged content', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });

  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.datasetChecksum, second.datasetChecksum);
  assert.equal(first.datasetId, second.datasetId);
});

test('(J) same sessions requested in a different order -> same dataset ID', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const forward = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  const reversed = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-04', '2022-01-03'] });

  assert.equal(forward.datasetId, reversed.datasetId);
  assert.deepEqual(forward.sessions.map((s) => s.identity.tradingDate), ['2022-01-03', '2022-01-04']); // sessions are stored sorted regardless of request order
});

test('(K)/(L) adding or removing a session changes the dataset ID', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const oneSession = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  const twoSessions = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });

  assert.notEqual(oneSession.datasetId, twoSessions.datasetId);
});

test('(M) a duplicate logical session (same trading date requested twice) is rejected', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');

  await assert.rejects(
    () => service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-03'] }),
    /duplicates/
  );
});

test('rejects an empty tradingDates list -- never defaults to a bulk scan', async () => {
  const { service } = newService();
  await assert.rejects(() => service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [] }), /non-empty tradingDates/);
});

test('(W) manifest generation never calls anything beyond findRange on the repository (no provider API request)', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  assert.equal(candleRepo.findRangeCallCount, 1);
});

test('generates a manifest for the EXPIRED_OPTION_1M dataset kind, keyed by providerContractId', async () => {
  const { service, optionRepo } = newService();
  optionRepo.rows = [makeRow(new Date('2022-01-03T09:15:00+05:30'), { openInterest: 500n })];

  const manifest = await service.generateOptionManifest({
    provider: HistoricalProviderId.GROWW,
    providerContractId: OPTION_CONTRACT_ID,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-01-06T00:00:00+05:30'),
    timeframe: '1minute',
    tradingDates: ['2022-01-03'],
  });

  assert.equal(manifest.datasetKind, ManifestDatasetKind.EXPIRED_OPTION_1M);
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].rowsWithOi, 1);
});

test('(R) verification succeeds against unchanged persisted data', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, true);
  assert.equal(result.datasetChecksumMatches, true);
  assert.deepEqual(result.mismatchedTradingDates, []);
});

test('(S) a mutated persisted row causes verification to fail closed, identifying the affected trading date', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows[10] = { ...candleRepo.rows[10], close: new Prisma.Decimal(9999) };
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

// ============================================================================
// B-F2D CORRECTION: manifest wire-contract versioning -- verifyManifest()
// rejects an incompatible/invalid manifestSchemaVersion BEFORE interpreting
// any session/provenance field (Terra's required test 12).
// ============================================================================

test('(B-F2D 12) verifyManifest() rejects a future schema version before verification logic interprets session fields -- no repository lookup is even attempted', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
  candleRepo.findRangeCallCount = 0;

  const future = { ...manifest, manifestSchemaVersion: manifest.manifestSchemaVersion + 1 };
  await assert.rejects(() => service.verifyManifest(future), /manifest schema version/i);
  assert.equal(candleRepo.findRangeCallCount, 0, 'verifyManifest must reject before ever reading the persisted store for a session');
});

test('(B-F2D) verifyManifest() rejects an unknown provenanceComposition enum value fail-closed, never silently treating it as PRIMARY_ONLY', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  const tampered = { ...manifest, sessions: manifest.sessions.map((session) => ({ ...session, sourceAcquisitionEvidence: { ...session.sourceAcquisitionEvidence, provenanceComposition: 'NOT_A_REAL_VALUE' as SourceAcquisitionProvenanceComposition } })) };
  await assert.rejects(() => service.verifyManifest(tampered), /provenanceComposition/);
});

// ============================================================================
// B-F2D CORRECTION (Terra re-review HIGH-2): verifyManifest() must behave
// according to EACH supported historical version's OWN schema, never the
// current v5 shape -- see manifest-schema-compatibility.util.ts's own
// compatibility-matrix doc for the exact v1/v2/v3 field history this strips
// down to.
// ============================================================================

function stripManifestToVersion(manifest: Awaited<ReturnType<DatasetManifestService['generateUnderlyingManifest']>>, version: 1 | 2 | 3): Awaited<ReturnType<DatasetManifestService['generateUnderlyingManifest']>> {
  return {
    ...manifest,
    manifestSchemaVersion: version,
    sessions: manifest.sessions.map((session) => {
      const { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus, provider, evidenceSemanticChecksum } = session.sourceAcquisitionEvidence;
      const evidence = version === 1 ? { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus } : { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus, provider, evidenceSemanticChecksum };
      const withEvidence = { ...session, sourceAcquisitionEvidence: evidence };
      if (version === 3) return withEvidence;
      const withoutWindows = { ...withEvidence } as Record<string, unknown>;
      delete withoutWindows.calendarSessionWindows;
      return withoutWindows;
    }),
  } as unknown as Awaited<ReturnType<DatasetManifestService['generateUnderlyingManifest']>>;
}

for (const version of [1, 2, 3] as const) {
  test(`(B-F2D verifyManifest v${version}) a genuine v${version}-shaped manifest verifies successfully against unchanged persisted data, exactly like the current v5 shape`, async () => {
    const { service, candleRepo } = newService();
    candleRepo.rows = normalSessionRows('2022-01-03');
    const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
    const historical = stripManifestToVersion(manifest, version);

    const result = await service.verifyManifest(historical);

    assert.equal(result.verified, true);
    assert.equal(result.datasetChecksumMatches, true);
    assert.deepEqual(result.mismatchedTradingDates, []);
  });

  test(`(B-F2D verifyManifest v${version}) a genuine v${version}-shaped manifest still detects a mutated persisted row, exactly like the current v5 shape`, async () => {
    const { service, candleRepo } = newService();
    candleRepo.rows = normalSessionRows('2022-01-03');
    const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
    const historical = stripManifestToVersion(manifest, version);

    candleRepo.rows[10] = { ...candleRepo.rows[10], close: new Prisma.Decimal(9999) };
    const result = await service.verifyManifest(historical);

    assert.equal(result.verified, false);
    assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
  });
}

test('(T) a missing persisted row causes verification to fail closed', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows.splice(10, 1);
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

test('(U) an extra persisted row causes verification to fail closed', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  candleRepo.rows.push(makeRow(new Date('2022-01-03T04:20:00.000Z')));
  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
});

// ---- Root-defect correction regression tests (independent review) --------

test('(REVIEW-K) generation never fabricates source-acquisition evidence, and verification preserves the same persisted-content/source-evidence distinction', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = normalSessionRows('2022-01-03');
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.excludedRowCount, null);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.sourceOrderAnomalyCount, null);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.sourceHealthStatus, null);

  const result = await service.verifyManifest(manifest);
  assert.equal(result.verified, true);
  assert.equal(result.sessionResults[0].originalPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(result.sessionResults[0].recomputedPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  // Verify never introduces or asserts a source-acquisition health value anywhere in its result -- there is no such field to fabricate.
  assert.ok(!('sourceHealthStatus' in result.sessionResults[0]));
});

test('(REVIEW-L) manifest generation remains deterministic after the correction -- datasetChecksum/datasetId are unaffected by the source-acquisition-evidence rename', async () => {
  const { service, candleRepo } = newService();
  candleRepo.rows = [...normalSessionRows('2022-01-03'), ...normalSessionRows('2022-01-04')];

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03', '2022-01-04'] });
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-04', '2022-01-03'] });

  assert.equal(first.datasetChecksum, second.datasetChecksum);
  assert.equal(first.datasetId, second.datasetId);
  assert.equal(first.sessionCounts.healthy, 2);
  assert.equal(first.sessionCounts.incomplete, 0);
  assert.equal(first.sessionCounts.invalid, 0);
});

// ============================================================================
// B-F2C: manifest integration -- durable evidence truthfulness (invariant 13)
// ============================================================================

test('(B-F2C T) MANIFEST LEGACY TRUTH -- a session with no durable retrieval evidence stays UNAVAILABLE_FROM_PERSISTED_STORE, never fabricated AVAILABLE', async () => {
  const { service, candleRepo, retrievalEvidenceService } = newService(new FakeRetrievalEvidenceService()); // empty map -> every lookup returns null
  candleRepo.rows = normalSessionRows('2022-01-03');

  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });

  assert.equal(retrievalEvidenceService.calls.length, 1);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.provider, null);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.evidenceSemanticChecksum, null);
});

test('(B-F2C S/13) MANIFEST EVIDENCE AVAILABLE -- genuine durable evidence is exposed truthfully, and NEVER perturbs datasetChecksum/datasetId (evidence is observability-only, exactly like every other pre-B-F2C SourceAcquisitionEvidence field)', async () => {
  const date = '2022-01-03';
  const genuineEvidence: SourceAcquisitionEvidence = {
    availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
    providerRowCount: 375,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    sourceHealthStatus: DatasetHealthStatus.HEALTHY,
    provider: HistoricalProviderId.UPSTOX,
    provenanceComposition: SourceAcquisitionProvenanceComposition.PRIMARY_ONLY,
    compositeRepair: null,
    evidenceSemanticChecksum: 'stable-evidence-checksum-abc123',
  };
  const evidenceService = new FakeRetrievalEvidenceService(new Map([[`${INSTRUMENT_KEY}|1minute|${date}`, genuineEvidence]]));

  const { service: withoutEvidence, candleRepo: repoA } = newService(new FakeRetrievalEvidenceService());
  repoA.rows = normalSessionRows(date);
  const baseline = await withoutEvidence.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });

  const { service: withEvidence, candleRepo: repoB } = newService(evidenceService);
  repoB.rows = normalSessionRows(date);
  const withGenuineEvidence = await withEvidence.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });

  // The evidence itself is exposed truthfully.
  assert.equal(withGenuineEvidence.sessions[0].sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE);
  assert.equal(withGenuineEvidence.sessions[0].sourceAcquisitionEvidence.provider, HistoricalProviderId.UPSTOX);
  assert.equal(withGenuineEvidence.sessions[0].sourceAcquisitionEvidence.evidenceSemanticChecksum, 'stable-evidence-checksum-abc123');

  // VERY IMPORTANT (invariant 13): dataset identity is completely unaffected by whether evidence exists at all.
  assert.equal(baseline.datasetChecksum, withGenuineEvidence.datasetChecksum);
  assert.equal(baseline.datasetId, withGenuineEvidence.datasetId);
  assert.equal(baseline.sessions[0].contentChecksum, withGenuineEvidence.sessions[0].contentChecksum);
});

test('(B-F2C S) MANIFEST EVIDENCE STABILITY -- two manifests generated for identical semantic content at different wall-clock moments report the IDENTICAL evidenceSemanticChecksum, never perturbed by retrieval UUID/retrievedAt', async () => {
  const date = '2022-01-05';
  // Simulates two DIFFERENT retrieval attempts (different retrievalId/retrievedAt in a real system) that
  // happened to observe the identical semantic provider content -- their OWN evidenceSemanticChecksum
  // (computed by computeEvidenceSemanticChecksum, which excludes id/retrievalId/timestamps) is therefore
  // identical by construction; the manifest must surface that identical value both times.
  const stableChecksum = 'identical-semantic-checksum-xyz';
  const evidence: SourceAcquisitionEvidence = {
    availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
    providerRowCount: 375,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    sourceHealthStatus: DatasetHealthStatus.HEALTHY,
    provider: HistoricalProviderId.UPSTOX,
    provenanceComposition: SourceAcquisitionProvenanceComposition.PRIMARY_ONLY,
    compositeRepair: null,
    evidenceSemanticChecksum: stableChecksum,
  };
  const evidenceService = new FakeRetrievalEvidenceService(new Map([[`${INSTRUMENT_KEY}|1minute|${date}`, evidence]]));
  const { service, candleRepo } = newService(evidenceService);
  candleRepo.rows = normalSessionRows(date);

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });

  assert.notEqual(first.generatedAt, second.generatedAt); // wall-clock observability differs, as expected
  assert.equal(first.sessions[0].sourceAcquisitionEvidence.evidenceSemanticChecksum, stableChecksum);
  assert.equal(second.sessions[0].sourceAcquisitionEvidence.evidenceSemanticChecksum, stableChecksum);
  assert.equal(first.datasetChecksum, second.datasetChecksum);
});

// ============================================================================
// B-F5 CALENDAR FIX: `calendarSessionWindows` -- SPECIAL_SESSION health must
// never be scored against the fixed 375-row regular contract.
// ============================================================================

/** A 60-minute Muhurat-style special session window: 16:45-17:45 IST. */
const MUHURAT_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 };
/** A two-window special session: 09:15-10:00 and 11:30-12:30 IST, with an undeclared gap in between that must never be bridged. */
const MULTI_WINDOWS: readonly SessionWindow[] = [
  { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
  { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
];

function rowsForWindows(tradingDate: string, windows: readonly SessionWindow[]): FakeRow[] {
  const dayStartMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const rows: FakeRow[] = [];
  for (const window of windows) {
    for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) {
      rows.push(makeRow(new Date(dayStartMs + minute * 60_000)));
    }
  }
  return rows;
}

test('(4) a SPECIAL_SESSION date with its real (reduced) minute count is HEALTHY, never scored against the fixed 375-row default', async () => {
  const date = '2022-11-04'; // Muhurat-style trading date
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const calendarSessionWindows: ManifestCalendarSessionWindowsByDate = { [date]: [MUHURAT_WINDOW] };

  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows });

  assert.equal(manifest.sessions[0].canonicalRowCount, 60);
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.deepEqual(manifest.sessions[0].calendarSessionWindows, [MUHURAT_WINDOW]);
});

test('the SAME persisted 60-row special session is INCOMPLETE when no calendarSessionWindows is supplied -- proving the fixed-375 default is the actual pre-fix defect, not a strawman', async () => {
  const date = '2022-11-04';
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);

  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });

  assert.equal(manifest.sessions[0].canonicalRowCount, 60);
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.INCOMPLETE);
  assert.deepEqual(manifest.sessions[0].calendarSessionWindows, []);
});

test('(5) a multi-window special session uses the exact disjoint windows -- the undeclared gap between them is never bridged into a false-missing-minute claim', async () => {
  const date = '2022-06-01';
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, MULTI_WINDOWS);
  const calendarSessionWindows: ManifestCalendarSessionWindowsByDate = { [date]: MULTI_WINDOWS };

  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows });

  assert.equal(manifest.sessions[0].canonicalRowCount, 45 + 60);
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});

test('(10) UNDERLYING_1M honors calendar-declared session windows end to end', async () => {
  const date = '2022-11-04';
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const manifest = await service.generateUnderlyingManifest({
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: INSTRUMENT_KEY,
    timeframe: '1minute',
    tradingDates: [date],
    calendarSessionWindows: { [date]: [MUHURAT_WINDOW] },
  });
  assert.equal(manifest.datasetKind, ManifestDatasetKind.UNDERLYING_1M);
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});

test('(11) EXPIRED_OPTION_1M honors the SAME calendar-declared session windows end to end', async () => {
  const date = '2022-11-04';
  const { service, optionRepo } = newService();
  optionRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]).map((row) => ({ ...row, openInterest: 500n }));
  const manifest = await service.generateOptionManifest({
    provider: HistoricalProviderId.GROWW,
    providerContractId: OPTION_CONTRACT_ID,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-11-10T00:00:00+05:30'),
    timeframe: '1minute',
    tradingDates: [date],
    calendarSessionWindows: { [date]: [MUHURAT_WINDOW] },
  });
  assert.equal(manifest.datasetKind, ManifestDatasetKind.EXPIRED_OPTION_1M);
  assert.equal(manifest.sessions[0].canonicalRowCount, 60);
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});

test('(12) durable retrieval evidence selection (B-F2C FIX-1) is unaffected by calendarSessionWindows', async () => {
  const date = '2022-11-04';
  const genuineEvidence: SourceAcquisitionEvidence = {
    availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
    providerRowCount: 60,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    sourceHealthStatus: DatasetHealthStatus.HEALTHY,
    provider: HistoricalProviderId.UPSTOX,
    provenanceComposition: SourceAcquisitionProvenanceComposition.PRIMARY_ONLY,
    compositeRepair: null,
    evidenceSemanticChecksum: 'special-session-evidence-checksum',
  };
  const evidenceService = new FakeRetrievalEvidenceService(new Map([[`${INSTRUMENT_KEY}|1minute|${date}`, genuineEvidence]]));
  const { service, candleRepo } = newService(evidenceService);
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);

  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows: { [date]: [MUHURAT_WINDOW] } });

  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE);
  assert.equal(manifest.sessions[0].sourceAcquisitionEvidence.evidenceSemanticChecksum, 'special-session-evidence-checksum');
});

test('(13) determinism: calendarSessionWindows never perturbs datasetChecksum/datasetId -- it changes health, never content identity', async () => {
  const date = '2022-11-04';
  const { service: withoutWindows, candleRepo: repoA } = newService();
  repoA.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const baseline = await withoutWindows.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date] });

  const { service: withWindows, candleRepo: repoB } = newService();
  repoB.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const withCalendarTruth = await withWindows.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows: { [date]: [MUHURAT_WINDOW] } });

  // Health differs (this is the whole point of the fix)...
  assert.equal(baseline.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.INCOMPLETE);
  assert.equal(withCalendarTruth.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  // ...but content identity (checksum/id) is completely unaffected -- same persisted candles, same identity, same canonicalization/health-semantics version.
  assert.equal(baseline.sessions[0].contentChecksum, withCalendarTruth.sessions[0].contentChecksum);
  assert.equal(baseline.datasetChecksum, withCalendarTruth.datasetChecksum);
  assert.equal(baseline.datasetId, withCalendarTruth.datasetId);
});

test('generation is deterministic across repeated calls with the identical calendarSessionWindows input', async () => {
  const date = '2022-11-04';
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const calendarSessionWindows: ManifestCalendarSessionWindowsByDate = { [date]: [MUHURAT_WINDOW] };

  const first = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows });
  const second = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows });

  assert.equal(first.datasetChecksum, second.datasetChecksum);
  assert.equal(first.sessions[0].persistedCanonicalHealthStatus, second.sessions[0].persistedCanonicalHealthStatus);
});

test('verifyManifest recomputes the SAME special-session health from the manifest\'s own recorded calendarSessionWindows -- never a live calendar lookup', async () => {
  const date = '2022-11-04';
  const { service, candleRepo } = newService();
  candleRepo.rows = rowsForWindows(date, [MUHURAT_WINDOW]);
  const manifest = await service.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: [date], calendarSessionWindows: { [date]: [MUHURAT_WINDOW] } });
  assert.equal(manifest.sessions[0].persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);

  const result = await service.verifyManifest(manifest);

  assert.equal(result.verified, true);
  assert.equal(result.sessionResults[0].originalPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(result.sessionResults[0].recomputedPersistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});
