import assert from 'node:assert/strict';
import test from 'node:test';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { AuthorizedDerivedImputedSessionSourceSelection, RealCanonicalSessionSourceSelection, ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from '../domain/research-session-source-selection';
import {
  buildResearchUnderlyingDatasetAssembly,
  collectResearchUnderlyingAssemblySelfConsistencyViolations,
  RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
  ResearchUnderlyingAssemblyIntegrityError,
  ResearchUnderlyingDatasetAssemblyV1,
} from '../domain/research-underlying-assembly.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import {
  buildResearchUnderlyingResamplingManifest,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestSessionEntry,
  ResearchUnderlyingResamplingManifestV1,
} from '../domain/research-underlying-resampling-manifest.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ResolvedResearchRowSourceKind, ResolvedResearchSessionRow, ResolveResearchSessionRowsOutcome } from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplerService from './research-underlying-resampler.service';
import { SessionRowsResolver } from './research-underlying-resampling-manifest-builder.service';
import ResearchUnderlyingResampledSessionReaderService, {
  ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError,
  ResearchUnderlyingResampledSessionNotFoundError,
  ResearchUnderlyingResampledSessionSourceAssemblyBindingError,
  ResearchUnderlyingResampledSessionSourceSelectionMismatchError,
  ResearchUnderlyingResampledSessionVerificationError,
} from './research-underlying-resampled-session-reader.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const TRADING_DATE = '2022-01-03';
const MARCH_7_DATE = '2022-03-07';
const REGULAR_WINDOW = regularSessionWindow();
const resampler = new ResearchUnderlyingResamplerService();
const TWO_MINUTE = ResampleTargetTimeframe.TWO_MINUTE;
const THREE_MINUTE = ResampleTargetTimeframe.THREE_MINUTE;
const FIVE_MINUTE = ResampleTargetTimeframe.FIVE_MINUTE;

function dayStartMs(tradingDate: string): number {
  return new Date(`${tradingDate}T00:00:00+05:30`).getTime();
}

function timeAtMinute(tradingDate: string, minuteOfDay: number): Date {
  return new Date(dayStartMs(tradingDate) + minuteOfDay * 60_000);
}

function realCanonicalRow(tradingDate: string, minuteOfDay: number): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: null,
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL },
  };
}

function derivedObservedRow(tradingDate: string, minuteOfDay: number): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: null,
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.DERIVED, derivedRowProvenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: 'a'.repeat(64) } },
  };
}

function fullRealCanonicalSession(tradingDate: string): ResolvedResearchSessionRow[] {
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) rows.push(realCanonicalRow(tradingDate, minute));
  return rows;
}

function fullDerivedObservedSession(tradingDate: string): ResolvedResearchSessionRow[] {
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) rows.push(derivedObservedRow(tradingDate, minute));
  return rows;
}

function tier1Selection(tradingDate: string, overrides: Partial<RealCanonicalSessionSourceSelection> = {}): RealCanonicalSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate },
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [REGULAR_WINDOW],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
    ...overrides,
  };
}

function tier3Selection(tradingDate: string, overrides: Partial<AuthorizedDerivedImputedSessionSourceSelection> = {}): AuthorizedDerivedImputedSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    tradingDate,
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    derivedContentChecksum: 'd'.repeat(64),
    derivedArtifactRelativePath: `derived-imputed-sessions/${'d'.repeat(64)}.json`,
    sourceSnapshotChecksum: 'e'.repeat(64),
    sourceSnapshotProviderId: 'UPSTOX',
    realRowCount: 372,
    imputedRowCount: 3,
    ...overrides,
  };
}

function buildAssembly(sessions: readonly ResearchSessionSourceSelection[]): ResearchUnderlyingDatasetAssemblyV1 {
  return buildResearchUnderlyingDatasetAssembly({
    schemaVersion: RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
    assemblySemanticsVersion: RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2022 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_abc', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions,
  });
}

/** Expected `sourceContentChecksum` for a selection, per B-M7.2 tier -- mirrors the reader's own `expectedSourceContentChecksumFor`. */
function sourceContentChecksumFor(selection: RealCanonicalSessionSourceSelection | AuthorizedDerivedImputedSessionSourceSelection): string {
  return selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION ? selection.derivedContentChecksum : selection.canonicalContentChecksum;
}

function descriptorFor(
  assemblyChecksum: string,
  selection: RealCanonicalSessionSourceSelection | AuthorizedDerivedImputedSessionSourceSelection,
  targetTimeframe: ResampleTargetTimeframe,
  rows: readonly ResolvedResearchSessionRow[]
) {
  return resampler.resampleSession({
    sourceAssemblyChecksum: assemblyChecksum,
    tradingDate: selection.tradingDate,
    sourcePrecedenceTier: selection.precedenceTier,
    sourceContentChecksum: sourceContentChecksumFor(selection),
    targetTimeframe,
    sessionWindows: [REGULAR_WINDOW],
    sourceRows: rows,
  }).descriptor;
}

function manifestFor(
  assemblyChecksum: string,
  selection: RealCanonicalSessionSourceSelection | AuthorizedDerivedImputedSessionSourceSelection,
  rows: readonly ResolvedResearchSessionRow[]
): ResearchUnderlyingResamplingManifestV1 {
  const sessionEntry: ResearchUnderlyingResamplingManifestSessionEntry = {
    tradingDate: selection.tradingDate,
    targets: {
      [TWO_MINUTE]: descriptorFor(assemblyChecksum, selection, TWO_MINUTE, rows),
      [THREE_MINUTE]: descriptorFor(assemblyChecksum, selection, THREE_MINUTE, rows),
      [FIVE_MINUTE]: descriptorFor(assemblyChecksum, selection, FIVE_MINUTE, rows),
    },
  };
  return buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: assemblyChecksum,
    identity: { instrumentKey: INSTRUMENT_KEY, sourceTimeframe: TIMEFRAME, year: 2022 },
    targetTimeframes: RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
    sourceSessionCounts: { expectedSessions: 1, unavailableSessions: 0 },
    sessions: [sessionEntry],
  });
}

/** Replaces one target's recorded descriptor in a manifest with a caller-supplied override -- used to simulate a tampered/inconsistent B-M7.3 manifest without touching the reader's own real re-resampling path. */
function withTamperedTarget(
  manifest: ResearchUnderlyingResamplingManifestV1,
  tradingDate: string,
  targetTimeframe: ResampleTargetTimeframe,
  overrides: Record<string, unknown>
): ResearchUnderlyingResamplingManifestV1 {
  return {
    ...manifest,
    sessions: manifest.sessions.map((session) =>
      session.tradingDate === tradingDate ? { ...session, targets: { ...session.targets, [targetTimeframe]: { ...session.targets[targetTimeframe], ...overrides } } } : session
    ),
  };
}

class FakeSessionRowsResolver implements SessionRowsResolver {
  public callCount = 0;
  constructor(private readonly outcome: ResolveResearchSessionRowsOutcome | Error) {}
  async resolveSessionRows(): Promise<ResolveResearchSessionRowsOutcome> {
    this.callCount += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

// ============================================================================
// 8. Happy path
// ============================================================================

test('8. happy path: exact valid manifest + exact valid source assembly + matching descriptor -> reader re-resolves/re-resamples/rechecks -> returns candles', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  const result = await reader.readResampledSession({ manifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE });

  assert.equal(result.candles.length, 75);
  assert.equal(rowsResolver.callCount, 1);
  assert.equal(result.descriptor.researchDerivedContentChecksum, manifest.sessions[0].targets[FIVE_MINUTE].researchDerivedContentChecksum);
});

// ============================================================================
// manifest <-> assembly binding in isolation: a fully self-consistent but DIFFERENT assembly
// ============================================================================

test('a fully self-consistent but DIFFERENT source assembly (genuinely valid on its own terms, just the wrong one for this manifest) fails the manifest<->assembly binding check before row resolution', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selectionA = tier1Selection(TRADING_DATE);
  const assemblyA = buildAssembly([selectionA]);
  const manifest = manifestFor(assemblyA.assemblyContentChecksum, selectionA, rows);

  // assemblyB is fully self-consistent on ITS OWN terms (a genuinely different session -> a genuinely different real checksum) -- not a corrupted clone of A.
  const selectionB = tier1Selection(TRADING_DATE, { canonicalContentChecksum: 'b'.repeat(64) });
  const assemblyB = buildAssembly([selectionB]);
  assert.notEqual(assemblyB.assemblyContentChecksum, assemblyA.assemblyContentChecksum);
  assert.deepEqual(collectResearchUnderlyingAssemblySelfConsistencyViolations(assemblyB), []);

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assemblyB, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceAssemblyBindingError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 1. WRONG SOURCE ASSEMBLY SELF-CHECKSUM -- the exact Terra HIGH-01 repro
// ============================================================================

test('1. Terra HIGH-01 repro: a cloned source assembly with assemblyContentChecksum overwritten to 64 zeroes is rejected BEFORE row resolution', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assemblyA = buildAssembly([selection]);
  const manifest = manifestFor(assemblyA.assemblyContentChecksum, selection, rows);

  const forgedAssembly: ResearchUnderlyingDatasetAssemblyV1 = { ...assemblyA, assemblyContentChecksum: '0'.repeat(64) };
  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: forgedAssembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingAssemblyIntegrityError
  );
  assert.equal(rowsResolver.callCount, 0, '1m row resolution must never be attempted after a source-assembly identity failure');
});

// ============================================================================
// 2. FORGED SELF-DECLARED ASSEMBLY CHECKSUM -- proves the fix recomputes, not merely compares the field
// ============================================================================

test('2. semantic assembly content mutated while assemblyContentChecksum is manually kept at the original value -> rejected (proves the fix does not merely trust the self-declared checksum field)', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assemblyA = buildAssembly([selection]);
  const manifest = manifestFor(assemblyA.assemblyContentChecksum, selection, rows);

  // Mutate a stable semantic field of the selected session but KEEP the original assemblyContentChecksum field verbatim.
  const forgedSelection: RealCanonicalSessionSourceSelection = { ...selection, canonicalRowCount: 999 };
  const forgedAssembly: ResearchUnderlyingDatasetAssemblyV1 = { ...assemblyA, sessions: [forgedSelection], assemblyContentChecksum: assemblyA.assemblyContentChecksum };

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: forgedAssembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingAssemblyIntegrityError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 3. WRONG DESCRIPTOR sourceAssemblyChecksum
// ============================================================================

test('3. manifest names assembly A, sourceAssembly is a valid A, but the recorded descriptor claims a different sourceAssemblyChecksum -> fails before row resolution', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assemblyA = buildAssembly([selection]);

  const wrongAssemblyChecksum = 'b'.repeat(64);
  const sessionEntry: ResearchUnderlyingResamplingManifestSessionEntry = {
    tradingDate: TRADING_DATE,
    targets: {
      [TWO_MINUTE]: descriptorFor(wrongAssemblyChecksum, selection, TWO_MINUTE, rows),
      [THREE_MINUTE]: descriptorFor(wrongAssemblyChecksum, selection, THREE_MINUTE, rows),
      [FIVE_MINUTE]: descriptorFor(wrongAssemblyChecksum, selection, FIVE_MINUTE, rows),
    },
  };
  const manifest = buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: assemblyA.assemblyContentChecksum, // manifest itself names A
    identity: { instrumentKey: INSTRUMENT_KEY, sourceTimeframe: TIMEFRAME, year: 2022 },
    targetTimeframes: RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
    sourceSessionCounts: { expectedSessions: 1, unavailableSessions: 0 },
    sessions: [sessionEntry], // but every descriptor claims wrongAssemblyChecksum
  });

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assemblyA, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceAssemblyBindingError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 4. WRONG DESCRIPTOR sourcePrecedenceTier
// ============================================================================

test('4. selected B-M7.2 session is tier 3, but the recorded descriptor claims tier 1 -> fails before row resolution', async () => {
  const rows = fullDerivedObservedSession(MARCH_7_DATE);
  const selection = tier3Selection(MARCH_7_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, MARCH_7_DATE, FIVE_MINUTE, { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION });

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: MARCH_7_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceSelectionMismatchError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 5. WRONG DESCRIPTOR sourceContentChecksum -- tier 1/2
// ============================================================================

test('5. real canonical selected source: descriptor.sourceContentChecksum disagrees with selection.canonicalContentChecksum -> fails before row resolution', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE); // canonicalContentChecksum = 'c'.repeat(64)
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, TRADING_DATE, FIVE_MINUTE, { sourceContentChecksum: 'y'.repeat(64) });

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceSelectionMismatchError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 6. WRONG DESCRIPTOR sourceContentChecksum -- tier 3
// ============================================================================

test('6. authorized derived selected source: descriptor.sourceContentChecksum disagrees with selection.derivedContentChecksum -> fails before row resolution', async () => {
  const rows = fullDerivedObservedSession(MARCH_7_DATE);
  const selection = tier3Selection(MARCH_7_DATE); // derivedContentChecksum = 'd'.repeat(64)
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, MARCH_7_DATE, FIVE_MINUTE, { sourceContentChecksum: 'z'.repeat(64) });

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: MARCH_7_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceSelectionMismatchError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 7. UNAVAILABLE selected source
// ============================================================================

test("7. the supplied source assembly's selection for this date is UNAVAILABLE -> fails before row resolution", async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const tier1 = tier1Selection(TRADING_DATE);
  const unavailable: ResearchSessionSourceSelection = {
    precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE,
    tradingDate: TRADING_DATE,
    persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE,
    reason: ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED,
  };
  const suppliedAssembly = buildAssembly([unavailable]);
  // The manifest's own recorded descriptor is irrelevant here -- the selected-session lookup fails before descriptor tier/content checks are ever reached.
  const manifest = manifestFor(suppliedAssembly.assemblyContentChecksum, tier1, rows);

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: suppliedAssembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceSelectionMismatchError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// a tradingDate with no selection at all in the source assembly
// ============================================================================

test('a tradingDate absent from the source assembly entirely (no selection) fails closed before row resolution', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const tier1 = tier1Selection(TRADING_DATE);
  const assemblyWithoutThisDate = buildAssembly([]);
  const manifest = manifestFor(assemblyWithoutThisDate.assemblyContentChecksum, tier1, rows);

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assemblyWithoutThisDate, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionSourceSelectionMismatchError
  );
  assert.equal(rowsResolver.callCount, 0);
});

// ============================================================================
// 9. Existing drift/verification tests still pass under the corrected (properly bound) fixtures
// ============================================================================

test('9a. changed underlying rows (simulating drifted canonical DB content) still fail closed on read-time re-verification', async () => {
  const originalRows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, originalRows);

  // row[0] is the FIRST constituent of the first bucket -- mutating its `open` (the field actually read) changes every target's output.
  const driftedRows = originalRows.map((row, index) => (index === 0 ? { ...row, open: '999999' } : row));
  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows: driftedRows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionVerificationError
  );
});

test('9b. a 1m reader error (e.g. a changed/corrupted B-M7.1 derived artifact) still propagates un-caught rather than falling back to unverified rows', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver(new Error('derived artifact checksum mismatch')) });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    /derived artifact checksum mismatch/
  );
});

test('9c. the 1m reader returning UNAVAILABLE still fails closed', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'UNAVAILABLE' }) });

  await assert.rejects(() => reader.readResampledSession({ manifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }));
});

test('a tradingDate absent from the manifest throws ResearchUnderlyingResampledSessionNotFoundError', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'RESOLVED', rows }) });

  await assert.rejects(
    () => reader.readResampledSession({ manifest, sourceAssembly: assembly, tradingDate: '2022-06-15', targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionNotFoundError
  );
});

// ============================================================================
// Material descriptor integrity (adjacent to HIGH-01, per Terra's explicit ask)
// ============================================================================

test('a tampered material descriptor field (outputCandleCount) that does not affect researchDerivedContentChecksum still fails closed', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, TRADING_DATE, FIVE_MINUTE, { outputCandleCount: 999 });

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'RESOLVED', rows }) });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError
  );
});

test('a tampered candlesContainingImputation field still fails closed even though the checksum matches', async () => {
  const rows = fullDerivedObservedSession(MARCH_7_DATE);
  const selection = tier3Selection(MARCH_7_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, MARCH_7_DATE, FIVE_MINUTE, { candlesContainingImputation: 999 });

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'RESOLVED', rows }) });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: MARCH_7_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError
  );
});

test('a tampered status field still fails closed even though the checksum matches', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const tamperedManifest = withTamperedTarget(manifest, TRADING_DATE, FIVE_MINUTE, { status: 'BOGUS_STATUS' });

  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'RESOLVED', rows }) });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError
  );
});

// ============================================================================
// B-M7.3-HIGH-02: researchResamplingSemanticsVersion tamper -- Terra's exact adversarial probe
// ============================================================================

test('HIGH-02 Terra repro: researchResamplingSemanticsVersion tampered (1 -> 999) while researchDerivedContentChecksum is left UNCHANGED -> fails closed, never returns the 125 March-7 3m candles', async () => {
  const rows = fullDerivedObservedSession(MARCH_7_DATE);
  const selection = tier3Selection(MARCH_7_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);

  const originalDescriptor = manifest.sessions[0].targets[THREE_MINUTE];
  assert.equal(originalDescriptor.researchResamplingSemanticsVersion, 1);
  assert.equal(originalDescriptor.outputCandleCount, 125);

  const tamperedManifest = withTamperedTarget(manifest, MARCH_7_DATE, THREE_MINUTE, { researchResamplingSemanticsVersion: 999 });
  const tamperedDescriptor = tamperedManifest.sessions[0].targets[THREE_MINUTE];
  // The exact Terra HIGH-02 shape: everything else, INCLUDING the checksum, is left untouched.
  assert.equal(tamperedDescriptor.researchResamplingSemanticsVersion, 999);
  assert.equal(tamperedDescriptor.researchDerivedContentChecksum, originalDescriptor.researchDerivedContentChecksum);

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: MARCH_7_DATE, targetTimeframe: THREE_MINUTE }),
    ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError
  );
  // Unlike a HIGH-01 identity failure, this is legitimately reached only AFTER row resolution/re-resampling -- the 1m reader IS called exactly once.
  assert.equal(rowsResolver.callCount, 1);
});

// ============================================================================
// Exhaustiveness proof: several independently-tampered descriptor fields all fail
// ============================================================================

test('exhaustiveness proof: independently tampering any of several distinct descriptor fields fails closed (proves no field can silently diverge undetected)', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);

  const tamperCases: readonly Record<string, unknown>[] = [
    { researchResamplingSchemaVersion: 999 },
    { researchResamplingSemanticsVersion: 999 },
    { sourceRowCount: 999 },
    { expectedSourceMinuteCount: 999 },
    { outputCandleCount: 999 },
    { structuralTrailingRowCount: 999 },
    { realCanonicalConstituentRowCount: 999 },
    { derivedObservedConstituentRowCount: 999 },
    { derivedImputedConstituentRowCount: 999 },
    { candlesContainingImputation: 999 },
    { status: 'BOGUS_STATUS' },
  ];

  for (const overrides of tamperCases) {
    const tamperedManifest = withTamperedTarget(manifest, TRADING_DATE, FIVE_MINUTE, overrides);
    const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: new FakeSessionRowsResolver({ kind: 'RESOLVED', rows }) });
    await assert.rejects(
      () => reader.readResampledSession({ manifest: tamperedManifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
      ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError,
      `tampering ${JSON.stringify(overrides)} must fail closed`
    );
  }
});

// ============================================================================
// duplicate/ambiguous manifest entry fails closed
// ============================================================================

test('duplicate manifest session entries for the same tradingDate fail closed rather than silently using the first match', async () => {
  const rows = fullRealCanonicalSession(TRADING_DATE);
  const selection = tier1Selection(TRADING_DATE);
  const assembly = buildAssembly([selection]);
  const manifest = manifestFor(assembly.assemblyContentChecksum, selection, rows);
  const ambiguousManifest: ResearchUnderlyingResamplingManifestV1 = { ...manifest, sessions: [...manifest.sessions, ...manifest.sessions] };

  const rowsResolver = new FakeSessionRowsResolver({ kind: 'RESOLVED', rows });
  const reader = new ResearchUnderlyingResampledSessionReaderService({ sessionRowsResolver: rowsResolver });

  await assert.rejects(
    () => reader.readResampledSession({ manifest: ambiguousManifest, sourceAssembly: assembly, tradingDate: TRADING_DATE, targetTimeframe: FIVE_MINUTE }),
    ResearchUnderlyingResampledSessionNotFoundError
  );
  assert.equal(rowsResolver.callCount, 0);
});
