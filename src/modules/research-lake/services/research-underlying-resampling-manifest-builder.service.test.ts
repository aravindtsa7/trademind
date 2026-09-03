import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { AuthorizedDerivedImputedSessionSourceSelection, RealCanonicalSessionSourceSelection, ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from '../domain/research-session-source-selection';
import { buildResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION, RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION, storeResearchUnderlyingDatasetAssembly } from '../domain/research-underlying-assembly.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { ResearchResampleSessionDescriptor, ResearchResampleSessionStatus } from '../domain/research-underlying-resampled-candle.types';
import { readResearchUnderlyingResamplingManifest } from '../domain/research-underlying-resampling-manifest.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ResolveResearchSessionRowsOutcome } from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplingManifestBuilderService, {
  ResearchUnderlyingResamplingCalendarWindowMismatchError,
  ResearchUnderlyingResamplingTargetTimeframeSetError,
  SessionResampler,
  SessionRowsResolver,
  SessionWindowsResolver,
} from './research-underlying-resampling-manifest-builder.service';
import { ResearchResampleSessionRequest } from './research-underlying-resampler.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const REGULAR_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'resampling-manifest-builder-test-'));
}

function tier1Selection(tradingDate: string, windows: readonly SessionWindow[] = [REGULAR_WINDOW]): RealCanonicalSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate },
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: windows,
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
  };
}

function tier3Selection(tradingDate: string): AuthorizedDerivedImputedSessionSourceSelection {
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
  };
}

function unavailableSelection(tradingDate: string): ResearchSessionSourceSelection {
  return { precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE, tradingDate, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE, reason: ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED };
}

function writeAssembly(root: string, sessions: ResearchSessionSourceSelection[]) {
  const assembly = buildResearchUnderlyingDatasetAssembly({
    schemaVersion: RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
    assemblySemanticsVersion: RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2022 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_abc', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions,
  });
  storeResearchUnderlyingDatasetAssembly(root, assembly);
  return assembly;
}

class FakeSessionWindowsResolver implements SessionWindowsResolver {
  constructor(private readonly windowsByDate: Record<string, readonly SessionWindow[]>) {}
  async resolveSessionWindowsForDates(dates: readonly string[]): Promise<Record<string, readonly SessionWindow[]>> {
    const result: Record<string, readonly SessionWindow[]> = {};
    for (const date of dates) result[date] = this.windowsByDate[date] ?? [REGULAR_WINDOW];
    return result;
  }
}

class FakeSessionRowsResolver implements SessionRowsResolver {
  public calls: Array<{ instrumentKey: string; timeframe: string; selection: ResearchSessionSourceSelection }> = [];
  constructor(private readonly outcomeByDate: Record<string, ResolveResearchSessionRowsOutcome | Error>) {}
  async resolveSessionRows(instrumentKey: string, timeframe: string, selection: ResearchSessionSourceSelection): Promise<ResolveResearchSessionRowsOutcome> {
    this.calls.push({ instrumentKey, timeframe, selection });
    const outcome = this.outcomeByDate[selection.tradingDate];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error(`FakeSessionRowsResolver: no fake outcome registered for tradingDate '${selection.tradingDate}'`);
    return outcome;
  }
}

function fakeDescriptorFor(request: ResearchResampleSessionRequest): ResearchResampleSessionDescriptor {
  return {
    researchResamplingSchemaVersion: 1,
    researchResamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: request.sourceAssemblyChecksum,
    tradingDate: request.tradingDate,
    sourcePrecedenceTier: request.sourcePrecedenceTier,
    sourceContentChecksum: request.sourceContentChecksum,
    targetTimeframe: request.targetTimeframe,
    sessionWindows: request.sessionWindows,
    sourceRowCount: request.sourceRows.length,
    expectedSourceMinuteCount: request.sourceRows.length,
    outputCandleCount: 1,
    structuralTrailingRowCount: 0,
    missingSourceMinuteCount: 0,
    realCanonicalConstituentRowCount: 0,
    derivedObservedConstituentRowCount: 0,
    derivedImputedConstituentRowCount: 0,
    candlesContainingImputation: 0,
    researchDerivedContentChecksum: 'x'.repeat(64),
    status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
  };
}

class FakeSessionResampler implements SessionResampler {
  public requests: ResearchResampleSessionRequest[] = [];
  resampleSession(request: ResearchResampleSessionRequest) {
    this.requests.push(request);
    return { candles: [], descriptor: fakeDescriptorFor(request) };
  }
}

function resolvedOutcome(): ResolveResearchSessionRowsOutcome {
  return { kind: 'RESOLVED', rows: [] };
}

// ============================================================================
// Orchestration
// ============================================================================

test('builds one manifest session entry per resampleable date, skipping UNAVAILABLE dates, resampling all 3 targets each', async () => {
  const root = tempRoot();
  try {
    const assembly = writeAssembly(root, [tier1Selection('2022-01-03'), tier3Selection('2022-03-07'), unavailableSelection('2022-12-31')]);
    const windowsResolver = new FakeSessionWindowsResolver({});
    const rowsResolver = new FakeSessionRowsResolver({ '2022-01-03': resolvedOutcome(), '2022-03-07': resolvedOutcome() });
    const resampler = new FakeSessionResampler();
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: windowsResolver,
      sessionRowsResolver: rowsResolver,
      sessionResampler: resampler,
    });

    const { manifest, sourceAssembly } = await service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum });

    assert.equal(sourceAssembly.assemblyContentChecksum, assembly.assemblyContentChecksum);
    assert.equal(manifest.sessions.length, 2);
    assert.deepEqual(
      manifest.sessions.map((s) => s.tradingDate),
      ['2022-01-03', '2022-03-07']
    );
    assert.equal(manifest.sourceSessionCounts.expectedSessions, 3);
    assert.equal(manifest.sourceSessionCounts.unavailableSessions, 1);
    assert.equal(manifest.summary.resolvedSessions, 2);
    // 2 dates x 3 targets each.
    assert.equal(resampler.requests.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sourceContentChecksum resolution: tier1/2 -> canonicalContentChecksum, tier3 -> derivedContentChecksum', async () => {
  const root = tempRoot();
  try {
    const tier1 = tier1Selection('2022-01-03');
    const tier3 = tier3Selection('2022-03-07');
    const assembly = writeAssembly(root, [tier1, tier3]);
    const rowsResolver = new FakeSessionRowsResolver({ '2022-01-03': resolvedOutcome(), '2022-03-07': resolvedOutcome() });
    const resampler = new FakeSessionResampler();
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: new FakeSessionWindowsResolver({}),
      sessionRowsResolver: rowsResolver,
      sessionResampler: resampler,
    });

    await service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum });

    const tier1Requests = resampler.requests.filter((r) => r.tradingDate === '2022-01-03');
    const tier3Requests = resampler.requests.filter((r) => r.tradingDate === '2022-03-07');
    assert.ok(tier1Requests.every((r) => r.sourceContentChecksum === tier1.canonicalContentChecksum));
    assert.ok(tier3Requests.every((r) => r.sourceContentChecksum === tier3.derivedContentChecksum));
    assert.ok(resampler.requests.every((r) => r.sourceAssemblyChecksum === assembly.assemblyContentChecksum));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tier 1/2 calendar window mismatch against the freshly-resolved certified calendar fails closed', async () => {
  const root = tempRoot();
  try {
    const mismatchedWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 660 };
    const assembly = writeAssembly(root, [tier1Selection('2022-01-03', [REGULAR_WINDOW])]);
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: new FakeSessionWindowsResolver({ '2022-01-03': [mismatchedWindow] }),
      sessionRowsResolver: new FakeSessionRowsResolver({ '2022-01-03': resolvedOutcome() }),
      sessionResampler: new FakeSessionResampler(),
    });
    await assert.rejects(() => service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum }), ResearchUnderlyingResamplingCalendarWindowMismatchError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tier 3 (no pinned calendarSessionWindows) uses the freshly-resolved certified calendar windows directly', async () => {
  const root = tempRoot();
  try {
    const certifiedWindow: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };
    const assembly = writeAssembly(root, [tier3Selection('2022-03-07')]);
    const resampler = new FakeSessionResampler();
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: new FakeSessionWindowsResolver({ '2022-03-07': [certifiedWindow] }),
      sessionRowsResolver: new FakeSessionRowsResolver({ '2022-03-07': resolvedOutcome() }),
      sessionResampler: resampler,
    });
    await service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum });
    assert.ok(resampler.requests.every((r) => r.sessionWindows[0].openMinuteIst === certifiedWindow.openMinuteIst));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the 1m reader returning UNAVAILABLE for a non-UNAVAILABLE selection fails closed', async () => {
  const root = tempRoot();
  try {
    const assembly = writeAssembly(root, [tier1Selection('2022-01-03')]);
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: new FakeSessionWindowsResolver({}),
      sessionRowsResolver: new FakeSessionRowsResolver({ '2022-01-03': { kind: 'UNAVAILABLE' } }),
      sessionResampler: new FakeSessionResampler(),
    });
    await assert.rejects(() => service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a 1m reader error (drifted canonical DB content / corrupted derived artifact) propagates un-caught, never silently produces output', async () => {
  const root = tempRoot();
  try {
    const assembly = writeAssembly(root, [tier1Selection('2022-01-03')]);
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      sessionWindowsResolver: new FakeSessionWindowsResolver({}),
      sessionRowsResolver: new FakeSessionRowsResolver({ '2022-01-03': new Error('canonical content drift detected') }),
      sessionResampler: new FakeSessionResampler(),
    });
    await assert.rejects(() => service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum }), /canonical content drift detected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a wrong target timeframe set (missing 3m/5m) fails closed before ever reading the source assembly', async () => {
  const service = new ResearchUnderlyingResamplingManifestBuilderService({
    sourceAssemblyRoot: '/this/path/does/not/exist',
    targetTimeframes: [ResampleTargetTimeframe.TWO_MINUTE],
  });
  await assert.rejects(() => service.buildYearManifest({ sourceAssemblyChecksum: '0'.repeat(64) }), ResearchUnderlyingResamplingTargetTimeframeSetError);
});

test('an extra target timeframe beyond 2m/3m/5m fails closed', async () => {
  const service = new ResearchUnderlyingResamplingManifestBuilderService({
    sourceAssemblyRoot: '/this/path/does/not/exist',
    targetTimeframes: [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE, '10m' as ResampleTargetTimeframe],
  });
  await assert.rejects(() => service.buildYearManifest({ sourceAssemblyChecksum: '0'.repeat(64) }), ResearchUnderlyingResamplingTargetTimeframeSetError);
});

test('persistManifest writes a content-addressed manifest that reads back and re-verifies cleanly', async () => {
  const root = tempRoot();
  const manifestRoot = tempRoot();
  try {
    const assembly = writeAssembly(root, [tier1Selection('2022-01-03')]);
    const service = new ResearchUnderlyingResamplingManifestBuilderService({
      sourceAssemblyRoot: root,
      manifestArtifactRoot: manifestRoot,
      sessionWindowsResolver: new FakeSessionWindowsResolver({}),
      sessionRowsResolver: new FakeSessionRowsResolver({ '2022-01-03': resolvedOutcome() }),
      sessionResampler: new FakeSessionResampler(),
    });
    const { manifest } = await service.buildYearManifest({ sourceAssemblyChecksum: assembly.assemblyContentChecksum });
    const storage = service.persistManifest(manifest);
    assert.equal(storage.wasNewlyWritten, true);
    const readBack = readResearchUnderlyingResamplingManifest(manifestRoot, manifest.manifestContentChecksum);
    assert.equal(readBack.manifestContentChecksum, manifest.manifestContentChecksum);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(manifestRoot, { recursive: true, force: true });
  }
});
