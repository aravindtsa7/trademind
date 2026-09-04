import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestDatasetKind, UnderlyingSessionIdentity } from '../modules/research-lake/domain/dataset-manifest.types';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResearchSessionCompositeRepairProvenanceKind, ResearchSessionSourceSelection, ResearchSessionUnavailableReason } from '../modules/research-lake/domain/research-session-source-selection';
import {
  buildResearchUnderlyingDatasetAssembly,
  computeResearchUnderlyingAssemblyChecksum,
  deriveResearchUnderlyingAssemblySessionCounts,
  ResearchUnderlyingDatasetAssemblyIdentity,
  ResearchUnderlyingDatasetAssemblyV1,
} from '../modules/research-lake/domain/research-underlying-assembly.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { DatasetHealthStatus } from '../modules/research-lake/domain/dataset-health.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import { NiftyUnderlyingResearchAssemblyResult, RequestedSessionsResolver } from '../modules/research-lake/services/nifty-underlying-research-assembly.service';
import { ManifestRequestedSessions } from '../modules/research-lake/services/manifest-calendar-session-resolver.service';
import { findAuthoritativeNseEquityCalendarFixture } from '../modules/research-lake/domain/data/authoritative-nse-equity-calendar-fixtures';
import { ExplicitCalendarClassification, isWeekend, SessionWindow } from '../modules/research-lake/domain/exchange-calendar.types';
import { addExchangeCalendarDays } from '../modules/research-lake/domain/exchange-calendar-date';
import { regularSessionWindow } from '../modules/research-lake/domain/session-window-expected-minutes.util';
import { AssembleAndPersistNiftyUnderlyingResearchAssembly, runNifty2025ResearchAssembly } from './research-nifty-2025-research-assembly';

/**
 * Zero-DB, zero-network unit suite for the B-M11 2025 research-assembly CLI.
 * Mirrors `research-nifty-2024-research-assembly.test.ts`'s TERRA-hardened
 * discipline, adapted for 2025's topology: 249 certified sessions, 246
 * real-canonical, exactly THREE composite-repaired sessions (2025-03-25,
 * 2025-04-04, 2025-04-23 -- the reviewed Groww secondary-provider repairs
 * unblocked by the B-M11 null-volume correction), 0 authorized-derived, 0
 * unavailable. Never imports the real assembly/calendar-resolver service
 * CLASS as a value.
 */

const INSTRUMENT_KEY = NIFTY_INDEX_INSTRUMENT_KEY;
const TIMEFRAME = NIFTY_UNDERLYING_TIMEFRAME;
const FEB1_DATE = '2025-02-01';
const OCT21_DATE = '2025-10-21';
const COMPOSITE_REPAIRED_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];

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

class FakeCalendarResolver implements RequestedSessionsResolver {
  public callCount = 0;
  public lastRequest: { fromDate: string; toDate: string } | null = null;
  constructor(private readonly result: ManifestRequestedSessions) {}
  async resolveRequestedSessions(request: { fromDate: string; toDate: string }): Promise<ManifestRequestedSessions> {
    this.callCount += 1;
    this.lastRequest = request;
    return this.result;
  }
}

/**
 * Independently expands the checked-in AUTHORITATIVE NSE/EQUITY 2025
 * calendar fixture into the exact certified 2025 trading-date set + session
 * windows, entirely offline (no DB). Mirrors
 * `certifiedNifty2024RequestedSessions` exactly -- zero dates hand-typed
 * here, so a change to the checked-in fixture automatically flows through.
 */
function certifiedNifty2025RequestedSessions(): ManifestRequestedSessions {
  const fixture = findAuthoritativeNseEquityCalendarFixture(2025);
  assert.ok(fixture, 'expected a registered authoritative NSE/EQUITY calendar fixture for 2025');
  const explicitByDate = new Map(fixture!.days.map((day) => [day.tradingDate, day]));

  const tradingDates: string[] = [];
  const calendarSessionWindows: Record<string, readonly SessionWindow[]> = {};

  let cursor = fixture!.coverageFrom;
  while (cursor <= fixture!.coverageTo) {
    const explicitDay = explicitByDate.get(cursor);
    if (explicitDay) {
      if (explicitDay.classification === ExplicitCalendarClassification.SPECIAL_SESSION) {
        tradingDates.push(cursor);
        calendarSessionWindows[cursor] = explicitDay.windows ?? [];
      } else if (explicitDay.classification === ExplicitCalendarClassification.REGULAR_SESSION) {
        tradingDates.push(cursor);
        calendarSessionWindows[cursor] = [regularSessionWindow()];
      }
      // EXCHANGE_HOLIDAY / EXCEPTIONAL_CLOSURE: closed, deliberately excluded.
    } else if (!isWeekend(cursor)) {
      tradingDates.push(cursor);
      calendarSessionWindows[cursor] = [regularSessionWindow()];
    }
    cursor = addExchangeCalendarDays(cursor, 1);
  }

  return { tradingDates, calendarSessionWindows };
}

function certifiedCalendarResolver(): FakeCalendarResolver {
  return new FakeCalendarResolver(certifiedNifty2025RequestedSessions());
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

function compositeRepairedSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
    tradingDate,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
    repairProvenance: { kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED, primaryProvider: HistoricalProviderId.UPSTOX, repairProvider: 'GROWW' as HistoricalProviderId, repairedMinuteCount: 1, repairPolicyVersion: 1 },
  };
}

function derivedSelection(tradingDate: string): ResearchSessionSourceSelection {
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    tradingDate,
    authorizationId: 'SOME_UNEXPECTED_AUTHORIZATION',
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
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2025, ...identityOverrides },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
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
      datasetId: 'UNDERLYING_1M_xyz',
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2025-01-01', requestedToDate: '2025-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/** Bypasses `buildResearchUnderlyingDatasetAssembly`'s own duplicate-date guard to exercise this CLI's OWN `DUPLICATE_TRADING_DATE` defense-in-depth check -- mirrors `rawFixtureResult` in the 2024 suite exactly. */
function rawFixtureResult(sessions: ResearchSessionSourceSelection[]): NiftyUnderlyingResearchAssemblyResult {
  const identity = { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2025 };
  const canonicalManifestRef = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 };
  const payload = { schemaVersion: 1, assemblySemanticsVersion: 1, identity, canonicalManifest: canonicalManifestRef, sessions };
  const assembly: ResearchUnderlyingDatasetAssemblyV1 = {
    ...payload,
    sessionCounts: deriveResearchUnderlyingAssemblySessionCounts(sessions),
    assemblyContentChecksum: computeResearchUnderlyingAssemblyChecksum(payload),
  };
  return {
    assembly,
    canonicalManifest: {
      manifestSchemaVersion: 5,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      canonicalizationVersion: 1,
      healthSemanticsVersion: 1,
      datasetChecksum: 'f'.repeat(64),
      datasetId: 'UNDERLYING_1M_xyz',
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2025-01-01', requestedToDate: '2025-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/** Every certified 2025 date EXCEPT the three composite-repaired dates -- 246 dates, straight from the authoritative fixture. */
function certifiedDatesExcludingCompositeRepaired(): string[] {
  return certifiedNifty2025RequestedSessions().tradingDates.filter((date) => !COMPOSITE_REPAIRED_DATES.includes(date));
}

/** Exactly the locked-production-happy-path session set: 246 real canonical + 3 composite-repaired, 0 derived, 0 unavailable, matching the certified 2025 calendar exactly. */
function fullyValidSessions(): ResearchSessionSourceSelection[] {
  return certifiedNifty2025RequestedSessions().tradingDates.map((date) => (COMPOSITE_REPAIRED_DATES.includes(date) ? compositeRepairedSelection(date) : realSelection(date)));
}

// ---- A: happy path ----

test('A. exact certified 2025 date set (246/246 real, 3 composite-repaired, 0 derived, 0 unavailable) -> SUCCESS, artifact persisted exactly once', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(calendarResolver.callCount, 1);
  assert.deepEqual(calendarResolver.lastRequest, { fromDate: '2025-01-01', toDate: '2025-12-31' });
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes(`instrument=${INSTRUMENT_KEY}`));
  assert.ok(summary.includes(`timeframe=${TIMEFRAME}`));
  assert.ok(summary.includes('year=2025'));
  assert.ok(summary.includes('expectedSessions=249'));
  assert.ok(summary.includes('researchReadySessions=249'));
  assert.ok(summary.includes('realCanonicalSessions=246'));
  assert.ok(summary.includes('compositeRepairedSessions=3'));
  assert.ok(summary.includes(`compositeRepairedTradingDates=${[...COMPOSITE_REPAIRED_DATES].sort().join(',')}`));
  assert.ok(summary.includes('authorizedDerivedSessions=0'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('derivedTradingDates=NONE'));
  assert.ok(summary.includes('canonicalManifestChecksum='));
  assert.ok(summary.includes('researchAssemblyChecksum='));
  assert.ok(summary.includes('researchAssemblyArtifact='));
});

// ---- B: an unavailable session in place of one composite-repaired date -> FAILED ----

test('B. 248 certified-real/composite + 1 unavailable (in place of a composite-repaired date) -> FAILED, no artifact persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingCompositeRepaired().map((d) => realSelection(d)), compositeRepairedSelection(COMPOSITE_REPAIRED_DATES[0]), compositeRepairedSelection(COMPOSITE_REPAIRED_DATES[1]), unavailableSelection(COMPOSITE_REPAIRED_DATES[2])];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=INCOMPLETE_RESEARCH_READY_SESSIONS'));
});

// ---- C: expectedSessions != 249 -> FAILED ----

test('C. expectedSessions !== 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = sequentialDates(99, '2020-01-01').map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPECTED_SESSION_COUNT'));
});

// ---- D: an unexpected authorized-derived session in place of a composite-repaired date -> FAILED (wrong tier) ----

test('D. an unexpected authorized-derived session appears in place of a composite-repaired date -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingCompositeRepaired().map((d) => realSelection(d)), compositeRepairedSelection(COMPOSITE_REPAIRED_DATES[0]), compositeRepairedSelection(COMPOSITE_REPAIRED_DATES[1]), derivedSelection(COMPOSITE_REPAIRED_DATES[2])];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS'));
});

// ---- E: composite-repaired count wrong ----

test('E1. composite-repaired count is 0 (all three downgraded to pure real-canonical) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = certifiedNifty2025RequestedSessions().tradingDates.map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_SESSION_COUNT'));
});

test('E2. composite-repaired count is 4 (an extra unrelated date also marked composite-repaired) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = fullyValidSessions().map((s) => (s.tradingDate === '2025-01-02' ? compositeRepairedSelection(s.tradingDate) : s));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_SESSION_COUNT'));
});

test('E3. composite-repaired count is 2 (one of the three reviewed repairs downgraded to real-canonical) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = fullyValidSessions().map((s) => (s.tradingDate === COMPOSITE_REPAIRED_DATES[0] ? realSelection(s.tradingDate) : s));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_SESSION_COUNT'));
});

// ---- F: composite-repaired session present but at the WRONG date (count still exactly 3) ----

test('F. a composite-repaired tier present at the wrong date (count still exactly 3) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = certifiedNifty2025RequestedSessions().tradingDates.map((d) => {
    if (d === COMPOSITE_REPAIRED_DATES[0]) return realSelection(d); // downgrade one reviewed repair
    if (d === '2025-01-02') return compositeRepairedSelection(d); // and upgrade an unrelated date instead
    if (COMPOSITE_REPAIRED_DATES.includes(d)) return compositeRepairedSelection(d);
    return realSelection(d);
  });
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
  assert.ok(summary.includes('2025-01-02'));
});

// ---- G: wrong instrument/timeframe/year -> FAILED ----

test('G. wrong instrument identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { instrumentKey: 'NSE_INDEX|Bank Nifty' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_INSTRUMENT'));
});

test('G. wrong timeframe identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { timeframe: '5minute' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TIMEFRAME'));
});

test('G. wrong year identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { year: 2024 }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_YEAR'));
});

// ---- H: service exception -> non-zero, no SUCCESS, no persistence ----

test('H. assembleYear throws -> FAILED, non-zero, no persistence attempted', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(new Error('trusted derived artifact integrity check failed'));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('status=FAILED'));
  assert.ok(summary.includes('trusted derived artifact integrity check failed'));
});

// ---- I: persistence exception AFTER valid postconditions -> non-zero, no SUCCESS ----

test('I. persistAssembly throws even though every postcondition passed -> FAILED, non-zero, no SUCCESS output', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()), new Error('disk full'));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('status=FAILED'));
  assert.ok(summary.includes('code=PERSISTENCE_FAILED'));
  assert.ok(summary.includes('disk full'));
});

// ---- misc ----

test('the service is called exactly once per run (assembleYear), and persistAssembly at most once', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = certifiedCalendarResolver();
  await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(service.assembleCallCount, 1);
  assert.equal(service.persistCallCount, 1);
});

test('structural: this test file never imports the real assembly/calendar-resolver service class, Prisma, or a provider client as a value', () => {
  const source = readFileSync(__filename, 'utf8');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
  assert.equal(/import\s+NiftyUnderlyingResearchAssemblyService\b/.test(source), false);
  assert.equal(/import\s+ManifestCalendarSessionResolverService\b/.test(source), false);
});

test('structural: the CLI reads no environment variable and makes zero provider calls', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-research-assembly.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI persists the trusted artifact ONLY after BOTH postcondition validations -- persistAssembly appears after validateLockedProductionPostconditions AND validateCertifiedDateSetPostcondition in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-research-assembly.ts'), 'utf8');
  const countPostconditionIndex = source.indexOf('validateLockedProductionPostconditions(result.assembly)');
  const dateSetPostconditionIndex = source.indexOf('validateCertifiedDateSetPostcondition(result.assembly, certified)');
  const persistIndex = source.indexOf('service.persistAssembly(result.assembly)');
  assert.ok(countPostconditionIndex > 0 && dateSetPostconditionIndex > 0 && persistIndex > 0);
  assert.ok(countPostconditionIndex < dateSetPostconditionIndex);
  assert.ok(dateSetPostconditionIndex < persistIndex);
});

test('structural: production main() wires the real ManifestCalendarSessionResolverService, never a stub/no-op', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-research-assembly.ts'), 'utf8');
  assert.match(source, /buildCalendarSessionResolverService:\s*\(\)\s*=>\s*new ManifestCalendarSessionResolverService\(\)/);
});

// ============================================================
// TERRA BLOCKER CORRECTION (carried forward from 2023/2024): exact certified
// date-set adversarial tests. Every scenario below satisfies EVERY aggregate
// per-tier count check (249 total / 246 real-canonical / 3 composite-repaired
// / 0 derived / 0 unavailable) so it reaches, and must be rejected by, the
// exact-date-set gate -- proving the count-only checks alone are NOT
// sufficient, and that persistence never occurs before that gate passes.
// ============================================================

test('J. one certified date removed and replaced with an unrelated (non-certified) date, total remains 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2025RequestedSessions().tradingDates;
  const removedDate = certifiedDates.find((d) => !COMPOSITE_REPAIRED_DATES.includes(d))!;
  const substitutedDates = [...certifiedDates.filter((d) => d !== removedDate), '2020-06-15'];
  assert.equal(substitutedDates.length, 249);
  const sessions = substitutedDates.map((d) => (COMPOSITE_REPAIRED_DATES.includes(d) ? compositeRepairedSelection(d) : realSelection(d)));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

test('K. one date duplicated and a DIFFERENT certified date removed, total remains 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2025RequestedSessions().tradingDates;
  const nonCompositeDates = certifiedDates.filter((d) => !COMPOSITE_REPAIRED_DATES.includes(d));
  const removedDate = nonCompositeDates[0];
  const duplicatedDate = nonCompositeDates[1];
  const withoutRemoved = certifiedDates.filter((d) => d !== removedDate);
  const duplicatedSet = [...withoutRemoved, duplicatedDate];
  assert.equal(duplicatedSet.length, 249);
  const sessions = duplicatedSet.map((d) => (COMPOSITE_REPAIRED_DATES.includes(d) ? compositeRepairedSelection(d) : realSelection(d)));
  // Uses `rawFixtureResult` (not `fixtureResult`) -- the real builder already refuses to construct a
  // duplicate-date assembly, so this simulates a forged/malformed fake-service result to actually
  // reach the CLI's own duplicate-date defense-in-depth check.
  const service = new FakeAssemblyService(rawFixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=DUPLICATE_TRADING_DATE'));
  assert.ok(errorLines.join('\n').includes(duplicatedDate));
});

test('L. a composite-repaired date (2025-03-25) removed and substituted with an unrelated date, total remains 249 -> FAILED at the composite-repaired-date gate (the most specific/actionable check, reached before the generic exact-date-set gate), no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2025RequestedSessions().tradingDates;
  const substitutedDates = [...certifiedDates.filter((d) => d !== '2025-03-25'), '2020-06-15'];
  assert.equal(substitutedDates.length, 249);
  // Keeps the composite-repaired TIER COUNT correct (3) by moving the missing repair onto the
  // substituted date -- this still isolates a genuine "2025-03-25 is gone" defect, just caught by the
  // earlier, MORE SPECIFIC `WRONG_COMPOSITE_REPAIRED_TRADING_DATES` gate in
  // `validateLockedProductionPostconditions` rather than the later, generic exact-date-set gate.
  const sessions = substitutedDates.map((d) => {
    if (d === '2020-06-15') return compositeRepairedSelection(d);
    if (COMPOSITE_REPAIRED_DATES.includes(d)) return compositeRepairedSelection(d);
    return realSelection(d);
  });
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 0, 'the certified-calendar resolver is never even called once the earlier aggregate-tier gate has already failed closed');
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
  assert.ok(summary.includes('2025-03-25'));
});

test('M. TERRA-style reproduction: 246 unrelated sequential real-canonical dates + the three composite-repaired dates -- every aggregate count is superficially valid, but the exact date set is wrong -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(246, '2020-01-01').map((d) => realSelection(d)), ...COMPOSITE_REPAIRED_DATES.map((d) => compositeRepairedSelection(d))];
  assert.equal(sessions.length, 249);
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false, 'this fixture reproduces the exact Terra-class bypass shape -- it MUST be rejected');
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

// ---- window-mismatch tests: each special session's window is independently validated ----

test('N1. the certified calendar source resolves the wrong 2025-02-01 window -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2025RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [FEB1_DATE]: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=FEB1_WINDOW_MISMATCH'));
});

test('N2. the certified calendar source resolves the wrong 2025-10-21 Muhurat window -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2025RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [OCT21_DATE]: [{ windowIndex: 0, openMinuteIst: 1080, closeMinuteIst: 1140 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=OCT21_WINDOW_MISMATCH'));
});

test('O. the certified calendar source itself resolves a session count other than 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2025RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates.slice(0, 248), calendarSessionWindows: genuine.calendarSessionWindows };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=CERTIFIED_CALENDAR_SESSION_COUNT_MISMATCH'));
});

test('P. certified calendar resolution itself throws -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  class ThrowingCalendarResolver implements RequestedSessionsResolver {
    async resolveRequestedSessions(): Promise<ManifestRequestedSessions> {
      throw new Error('calendar coverage lookup failed');
    }
  }
  const success = await runNifty2025ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => new ThrowingCalendarResolver(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=CERTIFIED_CALENDAR_RESOLUTION_FAILED'));
  assert.ok(summary.includes('calendar coverage lookup failed'));
});

test('R. exact certified date set derived from the authoritative 2025 fixture contains exactly 249 dates, includes both special sessions plus the three composite-repaired dates, and matches fullyValidSessions() one-for-one', () => {
  const certified = certifiedNifty2025RequestedSessions();
  assert.equal(certified.tradingDates.length, 249);
  assert.ok(certified.tradingDates.includes(FEB1_DATE));
  assert.ok(certified.tradingDates.includes(OCT21_DATE));
  for (const date of COMPOSITE_REPAIRED_DATES) assert.ok(certified.tradingDates.includes(date));
  assert.deepEqual(new Set(certified.tradingDates).size, 249, 'no duplicate certified dates');
  assert.deepEqual(
    fullyValidSessions().map((s) => s.tradingDate).sort(),
    [...certified.tradingDates].sort()
  );
});
