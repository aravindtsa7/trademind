import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestDatasetKind, UnderlyingSessionIdentity } from './dataset-manifest.types';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResearchSessionCompositeRepairProvenanceKind, ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from './research-session-source-selection';
import { DatasetHealthStatus } from './dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  assertNoDuplicateTradingDateSelections,
  buildResearchUnderlyingDatasetAssembly,
  BuildResearchUnderlyingDatasetAssemblyInput,
  CanonicalManifestReference,
  deriveResearchUnderlyingAssemblySessionCounts,
  readResearchUnderlyingDatasetAssembly,
  ResearchUnderlyingAssemblyIntegrityError,
  storeResearchUnderlyingDatasetAssembly,
} from './research-underlying-assembly.types';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';

function canonicalManifestReference(overrides: Partial<CanonicalManifestReference> = {}): CanonicalManifestReference {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_abc123', datasetChecksum: 'a'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1, ...overrides };
}

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
}

function realSelection(tradingDate: string, canonicalContentChecksum = `checksum-${tradingDate}`): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum,
    canonicalRowCount: 375,
  };
}

function compositeSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: `checksum-${tradingDate}`,
    canonicalRowCount: 375,
    repairProvenance: { kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED, primaryProvider: HistoricalProviderId.UPSTOX, repairProvider: HistoricalProviderId.GROWW, repairedMinuteCount: 3, repairPolicyVersion: 1 },
  };
}

function derivedSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    tradingDate,
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    derivedContentChecksum: 'derived-checksum',
    derivedArtifactRelativePath: 'derived-imputed-sessions/derived-checksum.json',
    sourceSnapshotChecksum: 'source-snapshot-checksum',
    sourceSnapshotProviderId: 'UPSTOX',
    realRowCount: 372,
    imputedRowCount: 3,
  };
}

function unavailableSelection(tradingDate: string): ResearchSessionSourceSelection {
  return { precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE, tradingDate, persistedCanonicalHealthStatus: DatasetHealthStatus.INCOMPLETE, reason: ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED };
}

function baseInput(overrides: Partial<BuildResearchUnderlyingDatasetAssemblyInput> = {}): BuildResearchUnderlyingDatasetAssemblyInput {
  return {
    schemaVersion: 1,
    assemblySemanticsVersion: 1,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2022 },
    canonicalManifest: canonicalManifestReference(),
    sessions: [realSelection('2022-01-03'), realSelection('2022-01-04'), derivedSelection('2022-03-07')],
    ...overrides,
  };
}

test('sessions are sorted ascending by tradingDate regardless of input order', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [derivedSelection('2022-03-07'), realSelection('2022-01-04'), realSelection('2022-01-03')] }));
  assert.deepEqual(assembly.sessions.map((s) => s.tradingDate), ['2022-01-03', '2022-01-04', '2022-03-07']);
});

test('sessionCounts is correctly derived from the tier of each selection', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), derivedSelection('2022-03-07'), unavailableSelection('2022-01-05')] }));
  assert.equal(assembly.sessionCounts.expectedSessions, 3);
  assert.equal(assembly.sessionCounts.realCanonicalSessions, 1);
  assert.equal(assembly.sessionCounts.authorizedDerivedSessions, 1);
  assert.equal(assembly.sessionCounts.unavailableSessions, 1);
  assert.equal(assembly.sessionCounts.compositeRepairedSessions, 0);
  assert.equal(assembly.sessionCounts.researchReadySessions, 2);
});

test('input-array-order permutations produce an IDENTICAL assemblyContentChecksum', () => {
  const a = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), realSelection('2022-01-04'), derivedSelection('2022-03-07')] }));
  const b = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [derivedSelection('2022-03-07'), realSelection('2022-01-04'), realSelection('2022-01-03')] }));
  assert.equal(a.assemblyContentChecksum, b.assemblyContentChecksum);
});

test('changing one selected session checksum changes the assembly checksum', () => {
  const a = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03', 'checksum-A')] }));
  const b = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03', 'checksum-B')] }));
  assert.notEqual(a.assemblyContentChecksum, b.assemblyContentChecksum);
});

// ---- HIGH-06: no wall-clock generatedAt field exists anywhere in the artifact ----

test('HIGH-06: ResearchUnderlyingDatasetAssemblyV1 carries no generatedAt field at all -- BuildResearchUnderlyingDatasetAssemblyInput has no generatedAt input either (a TS compile error would occur if a caller tried to pass one)', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  assert.equal('generatedAt' in assembly, false);
  const serialized = JSON.stringify(assembly);
  assert.equal(/"generatedAt"/.test(serialized), false, 'no generatedAt key may ever appear in the serialized B-M7.2 assembly artifact');
});

test('HIGH-06: two independent builds of the IDENTICAL semantic input (built at genuinely different wall-clock moments) produce byte-identical serialized assembly JSON', async () => {
  const a = buildResearchUnderlyingDatasetAssembly(baseInput());
  // A real, non-simulated wall-clock gap between the two builds -- since neither `buildResearchUnderlyingDatasetAssembly` nor its input accepts any clock/time value any more, this alone is a genuine reproduction of Terra's "Run A at T1, Run B at T2" scenario.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = buildResearchUnderlyingDatasetAssembly(baseInput());
  assert.equal(a.assemblyContentChecksum, b.assemblyContentChecksum);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'serialized assembly bytes must be identical for identical semantic input regardless of wall-clock time');
  assert.deepEqual(a, b);
});

test('HIGH-06: no other current-time/wall-clock/run-varying field exists anywhere in the content-addressed assembly artifact', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), compositeSelection('2022-01-04'), derivedSelection('2022-03-07'), unavailableSelection('2022-01-05')] }));
  const serialized = JSON.stringify(assembly);
  for (const forbidden of ['generatedAt', 'createdAt', 'updatedAt', 'runStartedAt', 'completedAt', 'timestamp', 'retrievalId', 'evidenceId', 'primaryRetrievalId', 'repairRetrievalId', 'repairEvidenceId']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `'${forbidden}' must never appear as a key in the content-addressed B-M7.2 assembly artifact`);
  }
});

test('sessionCounts alone (holding sessions constant) never needs to be supplied by the caller -- it is always derived, never an independent identity input', () => {
  // Documentation-as-test: BuildResearchUnderlyingDatasetAssemblyInput has no sessionCounts field at all -- a TS compile error would occur if a caller tried to pass one, proving counts can never drift from the actual sessions array.
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  assert.equal(assembly.sessionCounts.expectedSessions, assembly.sessions.length);
});

test('the assembly never embeds a duplicate 247-session candle payload -- each REAL_CANONICAL selection carries only identifiers/checksums, never OHLC rows', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  const serialized = JSON.stringify(assembly);
  assert.equal(/"open"\s*:/.test(serialized), false, 'no per-candle OHLC field should ever appear in the assembly artifact');
  assert.equal(/"rows"\s*:/.test(serialized), false, 'no embedded candle rows array should ever appear in the assembly artifact');
});

test('assertNoDuplicateTradingDateSelections fails closed on a duplicate tradingDate, never silently deduplicates', () => {
  assert.throws(() => assertNoDuplicateTradingDateSelections([realSelection('2022-01-03'), realSelection('2022-01-03')]));
});

test('buildResearchUnderlyingDatasetAssembly fails closed on a duplicate tradingDate selection', () => {
  assert.throws(() => buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), realSelection('2022-01-03')] })));
});

// ---- HIGH-02: no persistence UUID anywhere in the assembly identity payload ----

test('HIGH-02: a COMPOSITE_REPAIRED selection never carries primaryRetrievalId/repairRetrievalId/repairEvidenceId in the assembly -- semantic repair facts only', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [compositeSelection('2022-01-03')] }));
  const serialized = JSON.stringify(assembly);
  assert.equal(/retrievalId|evidenceId/i.test(serialized), false, 'no persistence UUID field name may ever appear in the B-M7.2 assembly artifact');
});

test('HIGH-02: two assemblies built from composite selections that are semantically identical (same repairProvenance) produce the SAME assemblyContentChecksum', () => {
  const a = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [compositeSelection('2022-01-03')] }));
  const b = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [compositeSelection('2022-01-03')] }));
  assert.equal(a.assemblyContentChecksum, b.assemblyContentChecksum);
});

// ---- content-addressed storage round trip ----------------------------------

let tempRoot: string;

test.beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'research-underlying-assembly-test-'));
});

test.afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test('storeResearchUnderlyingDatasetAssembly + readResearchUnderlyingDatasetAssembly round-trip', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  const stored = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  assert.equal(stored.wasNewlyWritten, true);
  assert.equal(stored.relativePath, `research-underlying-assemblies/${assembly.assemblyContentChecksum}.json`);

  const reread = readResearchUnderlyingDatasetAssembly(tempRoot, assembly.assemblyContentChecksum);
  assert.equal(reread.assemblyContentChecksum, assembly.assemblyContentChecksum);
  assert.deepEqual(reread.sessions, assembly.sessions);

  const onDisk = JSON.parse(readFileSync(stored.absolutePath, 'utf8'));
  assert.equal(onDisk.assemblyContentChecksum, assembly.assemblyContentChecksum);
});

test('storing the identical assembly twice is an idempotent, verified skip -- never a mutable overwrite', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  const first = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  const second = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  assert.equal(first.wasNewlyWritten, true);
  assert.equal(second.wasNewlyWritten, false);
});

test('the stored artifact path/filename is never a random UUID, timestamp, or "latest.json" -- always the content checksum', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  const stored = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  assert.equal(stored.relativePath.includes('latest'), false);
  assert.match(stored.relativePath, /^research-underlying-assemblies\/[a-f0-9]{64}\.json$/);
});

// ---- HIGH-05: sessionCounts integrity on read ------------------------------

test('deriveResearchUnderlyingAssemblySessionCounts is the ONE function used both at build time and read time', () => {
  const sessions = [realSelection('2022-01-03'), derivedSelection('2022-03-07'), unavailableSelection('2022-01-05')];
  const counts = deriveResearchUnderlyingAssemblySessionCounts(sessions);
  assert.equal(counts.expectedSessions, 3);
  assert.equal(counts.researchReadySessions, 2);
});

test('HIGH-05 tamper test: a stored artifact whose sessionCounts is edited (sessions/assemblyContentChecksum left untouched) is REJECTED on read', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), derivedSelection('2022-03-07'), unavailableSelection('2022-01-05')] }));
  const stored = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);

  const onDisk = JSON.parse(readFileSync(stored.absolutePath, 'utf8'));
  // Tamper ONLY sessionCounts -- sessions and assemblyContentChecksum (the only hashed fields) are left exactly as they were, so a generic content-addressed checksum re-hash alone would still pass.
  onDisk.sessionCounts = { ...onDisk.sessionCounts, unavailableSessions: 0, researchReadySessions: 3 };
  writeFileSync(stored.absolutePath, JSON.stringify(onDisk, null, 2));

  assert.throws(() => readResearchUnderlyingDatasetAssembly(tempRoot, assembly.assemblyContentChecksum), ResearchUnderlyingAssemblyIntegrityError);
});

test('HIGH-05: an untampered artifact with correct counts reads successfully', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03'), derivedSelection('2022-03-07'), unavailableSelection('2022-01-05')] }));
  storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  const reread = readResearchUnderlyingDatasetAssembly(tempRoot, assembly.assemblyContentChecksum);
  assert.deepEqual(reread.sessionCounts, assembly.sessionCounts);
});

test('HIGH-05: a stored artifact with a duplicate tradingDate (bypassing the build-time guard by writing raw JSON) is REJECTED on read', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput({ sessions: [realSelection('2022-01-03')] }));
  const stored = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  const onDisk = JSON.parse(readFileSync(stored.absolutePath, 'utf8'));
  onDisk.sessions = [onDisk.sessions[0], onDisk.sessions[0]];
  writeFileSync(stored.absolutePath, JSON.stringify(onDisk, null, 2));
  assert.throws(() => readResearchUnderlyingDatasetAssembly(tempRoot, assembly.assemblyContentChecksum), ResearchUnderlyingAssemblyIntegrityError);
});

test('HIGH-05: an unsupported schemaVersion is rejected on read', () => {
  const assembly = buildResearchUnderlyingDatasetAssembly(baseInput());
  const stored = storeResearchUnderlyingDatasetAssembly(tempRoot, assembly);
  const onDisk = JSON.parse(readFileSync(stored.absolutePath, 'utf8'));
  onDisk.schemaVersion = 999;
  writeFileSync(stored.absolutePath, JSON.stringify(onDisk, null, 2));
  assert.throws(() => readResearchUnderlyingDatasetAssembly(tempRoot, assembly.assemblyContentChecksum), ResearchUnderlyingAssemblyIntegrityError);
});
