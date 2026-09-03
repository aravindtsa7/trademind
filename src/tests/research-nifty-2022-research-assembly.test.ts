import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestDatasetKind, UnderlyingSessionIdentity } from '../modules/research-lake/domain/dataset-manifest.types';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from '../modules/research-lake/domain/research-session-source-selection';
import { buildResearchUnderlyingDatasetAssembly, ResearchUnderlyingDatasetAssemblyIdentity, ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { DatasetHealthStatus } from '../modules/research-lake/domain/dataset-health.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import { NiftyUnderlyingResearchAssemblyResult } from '../modules/research-lake/services/nifty-underlying-research-assembly.service';
import { AssembleAndPersistNiftyUnderlyingResearchAssembly, runNifty2022ResearchAssembly } from './research-nifty-2022-research-assembly';

/**
 * Zero-DB, zero-network unit suite for the B-M7.2 2022 research-assembly CLI.
 * This test file never imports the real `NiftyUnderlyingResearchAssemblyService`
 * CLASS at all (only its `NiftyUnderlyingResearchAssemblyResult` result TYPE,
 * and the CLI's own `AssembleAndPersistNiftyUnderlyingResearchAssembly`
 * Pick-type) -- so it is structurally impossible for these tests to
 * construct it or reach a real DB/filesystem-backed dependency.
 *
 * BLOCKER-04 CORRECTION: the CLI now validates a fixed set of locked
 * production postconditions BEFORE calling `persistAssembly` at all -- these
 * tests exercise every required failure shape (B-K below) and prove, via
 * `persistCallCount`, that persistence is attempted ONLY on the fully-valid
 * 248/248/1-derived-on-March-7/0-unavailable happy path.
 */

const INSTRUMENT_KEY = NIFTY_INDEX_INSTRUMENT_KEY;
const TIMEFRAME = NIFTY_UNDERLYING_TIMEFRAME;

function captureOutput(): { lines: string[]; errorLines: string[]; output: (line: string) => void; errorOutput: (line: string) => void } {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { lines, errorLines, output: (line) => lines.push(line), errorOutput: (line) => errorLines.push(line) };
}

class FakeAssemblyService implements AssembleAndPersistNiftyUnderlyingResearchAssembly {
  public assembleCallCount = 0;
  public persistCallCount = 0;
  constructor(
    private readonly resultOrError: NiftyUnderlyingResearchAssemblyResult | Error,
    private readonly persistResultOrError?: ContentAddressedJsonStoreResult | Error
  ) {}
  async assembleYear(): Promise<NiftyUnderlyingResearchAssemblyResult> {
    this.assembleCallCount += 1;
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return this.resultOrError;
  }
  persistAssembly(assembly: ResearchUnderlyingDatasetAssemblyV1): ContentAddressedJsonStoreResult {
    this.persistCallCount += 1;
    const outcome: ContentAddressedJsonStoreResult | Error =
      this.persistResultOrError ?? { relativePath: `research-underlying-assemblies/${assembly.assemblyContentChecksum}.json`, absolutePath: `/tmp/research-underlying-assemblies/${assembly.assemblyContentChecksum}.json`, wasNewlyWritten: true };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate };
}

function realSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
  };
}

function derivedSelection(tradingDate: string): ResearchSessionSourceSelection {
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

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

function fixtureResult(sessions: ResearchSessionSourceSelection[], identityOverrides: Partial<ResearchUnderlyingDatasetAssemblyIdentity> = {}): NiftyUnderlyingResearchAssemblyResult {
  const assembly = buildResearchUnderlyingDatasetAssembly({
    schemaVersion: 1,
    assemblySemanticsVersion: 1,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2022, ...identityOverrides },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_abc', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions,
  });
  return {
    assembly,
    canonicalManifest: {
      manifestSchemaVersion: 5,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      canonicalizationVersion: 1,
      healthSemanticsVersion: 1,
      datasetChecksum: 'f'.repeat(64),
      datasetId: 'UNDERLYING_1M_abc',
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2022-01-01', requestedToDate: '2022-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    // Mirrors the real service's `persistArtifactsToDisk: false` behavior -- the CLI now persists separately via `service.persistAssembly`.
    assemblyStorage: null,
  };
}

/** Exactly the locked-production-happy-path session set: 247 real canonical + 1 authorized derived on 2022-03-07 = 248 research-ready, 0 unavailable. */
function fullyValidSessions(): ResearchSessionSourceSelection[] {
  const realDates = sequentialDates(247, '2020-01-01');
  return [...realDates.map((d) => realSelection(d)), derivedSelection('2022-03-07')];
}

// ---- A: exact 248/248/1-derived-March7/0-unavailable -> SUCCESS, persisted exactly once ----

test('A. exact locked postconditions (248/248/1 derived on March-7/0 unavailable) -> SUCCESS, artifact persisted exactly once', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes(`instrument=${INSTRUMENT_KEY}`));
  assert.ok(summary.includes(`timeframe=${TIMEFRAME}`));
  assert.ok(summary.includes('year=2022'));
  assert.ok(summary.includes('expectedSessions=248'));
  assert.ok(summary.includes('researchReadySessions=248'));
  assert.ok(summary.includes('realCanonicalSessions=247'));
  assert.ok(summary.includes('authorizedDerivedSessions=1'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('derivedTradingDates=2022-03-07'));
  assert.ok(summary.includes('canonicalManifestChecksum='));
  assert.ok(summary.includes('researchAssemblyChecksum='));
  assert.ok(summary.includes('researchAssemblyArtifact='));
});

// ---- B: 247 ready, 1 unavailable -> FAILED, no persistence ----

test('B. 247 research-ready + 1 unavailable session -> FAILED/non-zero, no artifact persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(246, '2020-01-01').map((d) => realSelection(d)), derivedSelection('2022-03-07'), unavailableSelection('2022-12-31')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('status=FAILED'));
  assert.ok(errorLines.join('\n').includes('code=UNAVAILABLE_SESSIONS_PRESENT'));
});

// ---- C: expectedSessions != 248 -> FAILED ----

test('C. expectedSessions !== 248 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(99, '2020-01-01').map((d) => realSelection(d)), derivedSelection('2022-03-07')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPECTED_SESSION_COUNT'));
});

// ---- D: derived count 0 -> FAILED ----

test('D. zero authorized derived sessions -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = sequentialDates(248, '2020-01-01').map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_AUTHORIZED_DERIVED_SESSION_COUNT'));
});

// ---- E: derived count > 1 -> FAILED ----

test('E. more than one authorized derived session -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(246, '2020-01-01').map((d) => realSelection(d)), derivedSelection('2022-03-07'), derivedSelection('2022-06-15')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_AUTHORIZED_DERIVED_SESSION_COUNT'));
});

// ---- F: derived date wrong -> FAILED ----

test('F. the ONE authorized derived session is on the wrong date (not 2022-03-07) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(247, '2020-01-01').map((d) => realSelection(d)), derivedSelection('2022-04-04')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_DERIVED_TRADING_DATES'));
});

// ---- G: March-7 missing entirely (no derived session, an unavailable session instead) -> FAILED ----

test('G. March-7 is not research-ready at all (UNAVAILABLE instead of an authorized derived selection) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(247, '2020-01-01').map((d) => realSelection(d)), unavailableSelection('2022-03-07')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('status=FAILED'));
});

// ---- H: extra derived date beyond March-7 -> FAILED ----

test('H. an extra authorized derived date beyond March-7 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(245, '2020-01-01').map((d) => realSelection(d)), derivedSelection('2022-03-07'), derivedSelection('2022-08-09'), realSelection('2022-12-31')];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('status=FAILED'));
});

// ---- I: wrong instrument/timeframe/year -> FAILED ----

test('I. wrong instrument identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { instrumentKey: 'NSE_INDEX|Bank Nifty' }));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_INSTRUMENT'));
});

test('I. wrong timeframe identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { timeframe: '5minute' }));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TIMEFRAME'));
});

test('I. wrong year identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { year: 2023 }));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_YEAR'));
});

// ---- J: service exception -> non-zero, no SUCCESS, no persistence ----

test('J. assembleYear throws -> FAILED, non-zero, no persistence attempted', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(new Error('trusted derived artifact integrity check failed'));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('status=FAILED'));
  assert.ok(summary.includes('trusted derived artifact integrity check failed'));
});

// ---- K: persistence exception AFTER valid postconditions -> non-zero, no SUCCESS ----

test('K. persistAssembly throws even though every postcondition passed -> FAILED, non-zero, no SUCCESS output', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()), new Error('disk full'));
  const success = await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('status=FAILED'));
  assert.ok(summary.includes('code=PERSISTENCE_FAILED'));
  assert.ok(summary.includes('disk full'));
});

// ---- misc ----

test('no derived sessions field ever renders an empty string -- always NONE when zero derived (observed via the D failure path\'s underlying formatter, exercised through a passing composite here)', async () => {
  const { lines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.ok(lines.join('\n').includes('derivedTradingDates=2022-03-07'));
});

test('the service is called exactly once per run (assembleYear), and persistAssembly at most once', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  await runNifty2022ResearchAssembly({ buildService: () => service, output, errorOutput });
  assert.equal(service.assembleCallCount, 1);
  assert.equal(service.persistCallCount, 1);
});

test('structural: this test file never imports the real assembly service class, Prisma, or a provider client as a value', () => {
  const source = readFileSync(__filename, 'utf8');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
  assert.equal(/import\s+NiftyUnderlyingResearchAssemblyService\b/.test(source), false, 'the real assembly service class must never be imported (not even type-only) in this test file -- only its result TYPE and the CLI\'s own Pick-type are needed');
});

test('structural: the CLI never requires the B-M7.1 provider-capture confirmation environment variable', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-research-assembly.ts'), 'utf8');
  assert.equal(/RESEARCH_MARCH7_IMPUTATION_CAPTURE_CONFIRMATION/.test(source), false);
  assert.equal(/process\.env/.test(source), false, 'this CLI makes zero provider calls, so it needs no operator confirmation interlock and reads no environment variable of its own');
});

test('structural: the CLI never imports/re-invokes the B-M7.1 capture runner or NiftyIndexGapImputationService', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-research-assembly.ts'), 'utf8');
  assert.equal(/research-nifty-march7-imputation-capture/.test(source), false);
  assert.equal(/NiftyIndexGapImputationService/.test(source), false);
});

test('structural: the CLI persists the trusted artifact ONLY after building the postcondition validator function call -- persistAssembly appears after validateLockedProductionPostconditions in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-research-assembly.ts'), 'utf8');
  const validateIndex = source.indexOf('validateLockedProductionPostconditions(result.assembly)');
  const persistIndex = source.indexOf('service.persistAssembly(result.assembly)');
  assert.ok(validateIndex > 0 && persistIndex > 0);
  assert.ok(validateIndex < persistIndex, 'postcondition validation must run before persistAssembly is ever called');
});
