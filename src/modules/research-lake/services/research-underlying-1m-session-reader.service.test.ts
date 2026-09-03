import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { RealCanonicalSessionSourceSelection, ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from '../domain/research-session-source-selection';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import DatasetSessionManifestBuilderService, { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import ResearchUnderlying1mSessionReaderService, { HistoricalCandleRangeReader, ResearchCanonicalContentDriftError, ResolvedResearchRowSourceKind } from './research-underlying-1m-session-reader.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const TRADING_DATE = '2022-06-01';
const REAL_DERIVED_ARTIFACT_ROOT = 'artifacts/research-lake';
const MARCH_7_DERIVED_CHECKSUM = '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf';

type FakeCandleRow = PersistedManifestCandleRow;

function fakeRow(minuteOffset: number): FakeCandleRow {
  const candleTime = new Date(Date.UTC(2022, 5, 1, 3, 45, 0) + minuteOffset * 60_000); // 2022-06-01T09:15 IST + offset
  const price = 17000 + minuteOffset * 0.1;
  return { candleTime, open: new Prisma.Decimal(price), high: new Prisma.Decimal(price + 0.5), low: new Prisma.Decimal(price - 0.5), close: new Prisma.Decimal(price + 0.1), volume: 1000n, openInterest: null };
}

/** Exactly the 3-minute window `fakeRow(0..2)` covers (09:15-09:17 IST) -- so a 3-row fixture is a genuinely COMPLETE session under this declared window, matching how `selectResearchSessionSource` would only ever have selected tier 1/2 for complete content in the first place. */
const THREE_MINUTE_WINDOW: readonly SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 558 }];

class FakeHistoricalCandleRepository implements HistoricalCandleRangeReader {
  public calls: { instrumentKey: string; timeframe: string; start: Date; end: Date }[] = [];
  constructor(private readonly rows: readonly FakeCandleRow[]) {}
  async findRange(instrumentKey: string, timeframe: string, start: Date, end: Date) {
    this.calls.push({ instrumentKey, timeframe, start, end });
    return this.rows as unknown as Awaited<ReturnType<HistoricalCandleRangeReader['findRange']>>;
  }
}

const realBuilder = new DatasetSessionManifestBuilderService();

/**
 * Builds a REAL_CANONICAL selection whose `canonicalContentChecksum`/
 * `persistedCanonicalHealthStatus`/etc. GENUINELY match what
 * `DatasetSessionManifestBuilderService` (the SAME builder the reader now
 * reuses for BLOCKER-03 drift verification) recomputes from `rows` under
 * `THREE_MINUTE_WINDOW` -- required now that the reader independently
 * re-verifies canonical content rather than trusting the selection blindly.
 */
function realCanonicalSelectionForRows(tradingDate: string, rows: readonly FakeCandleRow[]): RealCanonicalSessionSourceSelection {
  const manifest = realBuilder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate, rows, sessionWindows: THREE_MINUTE_WINDOW });
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: manifest.persistedCanonicalHealthStatus,
    identity: manifest.identity,
    canonicalizationVersion: manifest.canonicalizationVersion,
    healthSemanticsVersion: manifest.healthSemanticsVersion,
    calendarSessionWindows: manifest.calendarSessionWindows,
    canonicalContentChecksum: manifest.contentChecksum,
    canonicalRowCount: manifest.canonicalRowCount,
  };
}

function derivedSelection(): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    tradingDate: '2022-03-07',
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    derivedContentChecksum: MARCH_7_DERIVED_CHECKSUM,
    derivedArtifactRelativePath: `derived-imputed-sessions/${MARCH_7_DERIVED_CHECKSUM}.json`,
    sourceSnapshotChecksum: 'ed869ef97d6c34d38249c820e36bb01ba4a5e5a7331262ff7c31c83969dea0c1',
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    realRowCount: 372,
    imputedRowCount: 3,
  };
}

function unavailableSelection(): ResearchSessionSourceSelection {
  return { precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE, tradingDate: '2022-03-08', persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE, reason: ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED };
}

// ---- REAL_CANONICAL rows: happy path ---------------------------------------

test('REAL_CANONICAL selection resolves rows from the historical candle repository, sorted ascending, availableAt = candleTime + 1m', async () => {
  const rows = [fakeRow(1), fakeRow(0), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  assert.equal(selection.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY, 'fixture sanity: the 3-row window must genuinely be complete');
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo, derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection);
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    assert.equal(outcome.rows.length, 3);
    const times = outcome.rows.map((r) => r.candleTime);
    assert.deepEqual(times, [...times].sort());
    for (const row of outcome.rows) {
      const expectedAvailableAt = new Date(new Date(row.candleTime).getTime() + 60_000).toISOString();
      assert.equal(row.availableAt, expectedAvailableAt);
    }
  }
});

// ---- 29: real canonical rows expose no false imputation provenance --------

test('29. REAL_CANONICAL rows carry ONLY { sourceKind: REAL_CANONICAL } -- no imputation-shaped fields anywhere', async () => {
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo, derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection);
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    assert.equal(outcome.rows[0].provenance.sourceKind, ResolvedResearchRowSourceKind.REAL_CANONICAL);
    const serialized = JSON.stringify(outcome.rows[0].provenance);
    assert.equal(serialized, JSON.stringify({ sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL }));
    assert.equal(/imput/i.test(serialized), false, 'no imputation-shaped field may ever appear on a REAL_CANONICAL row');
  }
});

test('REAL_CANONICAL rows never carry an authorizationId/leftAnchor/rightAnchor field (no false imputation provenance)', async () => {
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo, derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection);
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    const row = outcome.rows[0] as unknown as Record<string, unknown>;
    assert.equal('authorizationId' in row, false);
    assert.equal('leftAnchor' in row, false);
  }
});

// ---- BLOCKER-03: canonical content-binding / drift verification -----------

test('10. current canonical rows exactly match the selected canonicalContentChecksum -> reader succeeds', async () => {
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection);
  assert.equal(outcome.kind, 'RESOLVED');
});

test('11. one changed canonical price -> reader fails closed with ResearchCanonicalContentDriftError (checksum mismatch)', async () => {
  const originalRows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, originalRows);
  const driftedRows = [originalRows[0], { ...originalRows[1], close: new Prisma.Decimal(99999.99) }, originalRows[2]];
  const repo = new FakeHistoricalCandleRepository(driftedRows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  await assert.rejects(() => reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection), ResearchCanonicalContentDriftError);
});

test('12. a missing canonical minute -> reader fails closed (checksum mismatch AND the session is no longer complete)', async () => {
  const originalRows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, originalRows);
  const repo = new FakeHistoricalCandleRepository([fakeRow(0), fakeRow(2)]); // minute 1 (offset 1) now missing
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  await assert.rejects(() => reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection), ResearchCanonicalContentDriftError);
});

test('13. a duplicate canonical candle time -> reader fails closed (recomputed health becomes INVALID, no longer complete)', async () => {
  const originalRows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, originalRows);
  const repo = new FakeHistoricalCandleRepository([fakeRow(0), fakeRow(0), fakeRow(2)]); // offset 1 duplicated as offset 0, offset 1 itself now absent
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  await assert.rejects(() => reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection), ResearchCanonicalContentDriftError);
});

test('14. wrong canonical identity (a selection built for a different instrument) -> reader fails closed before trusting mismatched content', async () => {
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  await assert.rejects(() => reader.resolveSessionRows('NSE_INDEX|Bank Nifty', TIMEFRAME, selection), ResearchCanonicalContentDriftError);
});

test('15. an incomplete reconstructed session (fewer rows than the selected calendarSessionWindows expect) fails closed even though the row COUNT alone might look plausible', async () => {
  const originalRows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, originalRows);
  // Same row COUNT (3) as the original selection, but shifted -- misses expected minute 555 (offset 0) and extends past the declared window.
  const shiftedRows = [fakeRow(1), fakeRow(2), fakeRow(3)];
  const repo = new FakeHistoricalCandleRepository(shiftedRows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo });
  await assert.rejects(() => reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection), ResearchCanonicalContentDriftError);
});

// ---- DERIVED rows: 27/28 -- availableAt/provenance preserved exactly, against the REAL committed B-M7.1 artifact ----

test('27. AUTHORIZED_DERIVED_IMPUTED selection preserves the 3 imputed rows\' availableAt at exactly 10:26 IST', async () => {
  const reader = new ResearchUnderlying1mSessionReaderService({ derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, derivedSelection());
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    assert.equal(outcome.rows.length, 375);
    const imputedRows = outcome.rows.filter((r) => r.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && r.provenance.derivedRowProvenance.kind === 'IMPUTED');
    assert.equal(imputedRows.length, 3);
    const expectedAvailableAt = new Date('2022-03-07T10:26:00+05:30').toISOString();
    for (const row of imputedRows) assert.equal(row.availableAt, expectedAvailableAt);
  }
});

test('28. AUTHORIZED_DERIVED_IMPUTED selection preserves OBSERVED vs IMPUTED provenance exactly (372 OBSERVED, 3 IMPUTED)', async () => {
  const reader = new ResearchUnderlying1mSessionReaderService({ derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, derivedSelection());
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    const observed = outcome.rows.filter((r) => r.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && r.provenance.derivedRowProvenance.kind === 'OBSERVED');
    const imputed = outcome.rows.filter((r) => r.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && r.provenance.derivedRowProvenance.kind === 'IMPUTED');
    assert.equal(observed.length, 372);
    assert.equal(imputed.length, 3);
  }
});

test('DERIVED rows never have their availableAt normalized to candleTime + 1m -- the derived rows keep their own B-M7.1 semantics', async () => {
  const reader = new ResearchUnderlying1mSessionReaderService({ derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, derivedSelection());
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind === 'RESOLVED') {
    const row0622 = outcome.rows.find((r) => new Date(r.candleTime).toISOString() === new Date('2022-03-07T10:22:00+05:30').toISOString());
    assert.ok(row0622);
    const naiveOwnCompletion = new Date(new Date(row0622!.candleTime).getTime() + 60_000).toISOString();
    assert.notEqual(row0622!.availableAt, naiveOwnCompletion, '10:22 synthetic data must never be causally visible at 10:23 in the read boundary either');
  }
});

// ---- UNAVAILABLE ----

test('UNAVAILABLE selection resolves to { kind: UNAVAILABLE }, never fabricated rows', async () => {
  const reader = new ResearchUnderlying1mSessionReaderService({ derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  const outcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, unavailableSelection());
  assert.equal(outcome.kind, 'UNAVAILABLE');
});

// ---- 37: future B-M7.3 consumes rows through this typed boundary without inspecting artifact filenames itself ----

test('37. a consumer resolves rows purely from the typed ResearchSessionSourceSelection -- never needs to know an artifact filename/path itself', async () => {
  const rows = [fakeRow(0), fakeRow(1), fakeRow(2)];
  const selection = realCanonicalSelectionForRows(TRADING_DATE, rows);
  const repo = new FakeHistoricalCandleRepository(rows);
  const reader = new ResearchUnderlying1mSessionReaderService({ historicalCandleRepository: repo, derivedArtifactRoot: REAL_DERIVED_ARTIFACT_ROOT });
  // The consumer only ever passes the selection object -- resolveSessionRows resolves the artifact path internally via `derivedArtifactRelativePath`/`derivedContentChecksum` on the selection, never requiring the caller to construct a path itself.
  const canonicalOutcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, selection);
  const derivedOutcome = await reader.resolveSessionRows(INSTRUMENT_KEY, TIMEFRAME, derivedSelection());
  assert.equal(canonicalOutcome.kind, 'RESOLVED');
  assert.equal(derivedOutcome.kind, 'RESOLVED');
});
