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
import { AssembleAndPersistNiftyUnderlyingResearchAssembly, runNifty2024ResearchAssembly } from './research-nifty-2024-research-assembly';

/**
 * Zero-DB, zero-network unit suite for the B-M10 2024 research-assembly CLI.
 * Mirrors `research-nifty-2023-research-assembly.test.ts`'s TERRA-hardened
 * discipline, adapted for 2024's NON-clean topology: 249 certified sessions,
 * 248 real-canonical, exactly ONE composite-repaired session (2024-12-12,
 * the reviewed Groww secondary-provider repair), 0 authorized-derived, 0
 * unavailable. Never imports the real assembly/calendar-resolver service
 * CLASS as a value.
 */

const INSTRUMENT_KEY = NIFTY_INDEX_INSTRUMENT_KEY;
const TIMEFRAME = NIFTY_UNDERLYING_TIMEFRAME;
const JAN20_DATE = '2024-01-20';
const MAR2_DATE = '2024-03-02';
const MAY18_DATE = '2024-05-18';
const MUHURAT_DATE = '2024-11-01';
const COMPOSITE_REPAIRED_DATE = '2024-12-12';

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
 * Independently expands the checked-in AUTHORITATIVE NSE/EQUITY 2024
 * calendar fixture into the exact certified 2024 trading-date set + session
 * windows, entirely offline (no DB). Mirrors
 * `certifiedNifty2023RequestedSessions` exactly -- zero dates hand-typed
 * here, so a change to the checked-in fixture automatically flows through.
 */
function certifiedNifty2024RequestedSessions(): ManifestRequestedSessions {
  const fixture = findAuthoritativeNseEquityCalendarFixture(2024);
  assert.ok(fixture, 'expected a registered authoritative NSE/EQUITY calendar fixture for 2024');
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
  return new FakeCalendarResolver(certifiedNifty2024RequestedSessions());
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
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2024, ...identityOverrides },
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
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2024-01-01', requestedToDate: '2024-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/** Bypasses `buildResearchUnderlyingDatasetAssembly`'s own duplicate-date guard to exercise this CLI's OWN `DUPLICATE_TRADING_DATE` defense-in-depth check -- mirrors `rawFixtureResult` in the 2023 suite exactly. */
function rawFixtureResult(sessions: ResearchSessionSourceSelection[]): NiftyUnderlyingResearchAssemblyResult {
  const identity = { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2024 };
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
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2024-01-01', requestedToDate: '2024-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/** Every certified 2024 date EXCEPT the composite-repaired date -- 248 dates, straight from the authoritative fixture. */
function certifiedDatesExcludingCompositeRepaired(): string[] {
  return certifiedNifty2024RequestedSessions().tradingDates.filter((date) => date !== COMPOSITE_REPAIRED_DATE);
}

/** Exactly the locked-production-happy-path session set: 248 real canonical + 1 composite-repaired (2024-12-12), 0 derived, 0 unavailable, matching the certified 2024 calendar exactly. */
function fullyValidSessions(): ResearchSessionSourceSelection[] {
  return certifiedNifty2024RequestedSessions().tradingDates.map((date) => (date === COMPOSITE_REPAIRED_DATE ? compositeRepairedSelection(date) : realSelection(date)));
}

// ---- A: happy path ----

test('A. exact certified 2024 date set (248/248 real, 1 composite-repaired at 2024-12-12, 0 derived, 0 unavailable) -> SUCCESS, artifact persisted exactly once', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(calendarResolver.callCount, 1);
  assert.deepEqual(calendarResolver.lastRequest, { fromDate: '2024-01-01', toDate: '2024-12-31' });
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes(`instrument=${INSTRUMENT_KEY}`));
  assert.ok(summary.includes(`timeframe=${TIMEFRAME}`));
  assert.ok(summary.includes('year=2024'));
  assert.ok(summary.includes('expectedSessions=249'));
  assert.ok(summary.includes('researchReadySessions=249'));
  assert.ok(summary.includes('realCanonicalSessions=248'));
  assert.ok(summary.includes('compositeRepairedSessions=1'));
  assert.ok(summary.includes(`compositeRepairedTradingDates=${COMPOSITE_REPAIRED_DATE}`));
  assert.ok(summary.includes('authorizedDerivedSessions=0'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('derivedTradingDates=NONE'));
  assert.ok(summary.includes('canonicalManifestChecksum='));
  assert.ok(summary.includes('researchAssemblyChecksum='));
  assert.ok(summary.includes('researchAssemblyArtifact='));
});

// ---- B: an unavailable session in place of the composite-repaired date -> FAILED ----

test('B. 248 certified-real + 1 unavailable (in place of the composite-repaired date) -> FAILED, no artifact persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingCompositeRepaired().map((d) => realSelection(d)), unavailableSelection(COMPOSITE_REPAIRED_DATE)];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPECTED_SESSION_COUNT'));
});

// ---- D: an unexpected authorized-derived session in place of the composite-repaired date -> FAILED (wrong tier) ----

test('D. an unexpected authorized-derived session appears in place of the composite-repaired date -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingCompositeRepaired().map((d) => realSelection(d)), derivedSelection(COMPOSITE_REPAIRED_DATE)];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS'));
});

// ---- E: composite-repaired count wrong ----

test('E1. composite-repaired count is 0 (2024-12-12 downgraded to pure real-canonical) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = certifiedNifty2024RequestedSessions().tradingDates.map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_SESSION_COUNT'));
});

test('E2. composite-repaired count is 2 (an extra unrelated date also marked composite-repaired) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = fullyValidSessions().map((s) => (s.tradingDate === '2024-01-02' ? compositeRepairedSelection(s.tradingDate) : s));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_COMPOSITE_REPAIRED_SESSION_COUNT'));
});

// ---- F: composite-repaired session present but at the WRONG date ----

test('F. composite-repaired tier present at the wrong date (count still exactly 1) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = certifiedNifty2024RequestedSessions().tradingDates.map((d) => (d === '2024-01-02' ? compositeRepairedSelection(d) : realSelection(d)));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
  assert.ok(summary.includes('2024-01-02'));
});

// ---- G: wrong instrument/timeframe/year -> FAILED ----

test('G. wrong instrument identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { instrumentKey: 'NSE_INDEX|Bank Nifty' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_INSTRUMENT'));
});

test('G. wrong timeframe identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { timeframe: '5minute' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TIMEFRAME'));
});

test('G. wrong year identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { year: 2023 }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_YEAR'));
});

// ---- H: service exception -> non-zero, no SUCCESS, no persistence ----

test('H. assembleYear throws -> FAILED, non-zero, no persistence attempted', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(new Error('trusted derived artifact integrity check failed'));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const source = readFileSync(join(__dirname, 'research-nifty-2024-research-assembly.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI persists the trusted artifact ONLY after BOTH postcondition validations -- persistAssembly appears after validateLockedProductionPostconditions AND validateCertifiedDateSetPostcondition in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2024-research-assembly.ts'), 'utf8');
  const countPostconditionIndex = source.indexOf('validateLockedProductionPostconditions(result.assembly)');
  const dateSetPostconditionIndex = source.indexOf('validateCertifiedDateSetPostcondition(result.assembly, certified)');
  const persistIndex = source.indexOf('service.persistAssembly(result.assembly)');
  assert.ok(countPostconditionIndex > 0 && dateSetPostconditionIndex > 0 && persistIndex > 0);
  assert.ok(countPostconditionIndex < dateSetPostconditionIndex);
  assert.ok(dateSetPostconditionIndex < persistIndex);
});

test('structural: production main() wires the real ManifestCalendarSessionResolverService, never a stub/no-op', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2024-research-assembly.ts'), 'utf8');
  assert.match(source, /buildCalendarSessionResolverService:\s*\(\)\s*=>\s*new ManifestCalendarSessionResolverService\(\)/);
});

// ============================================================
// TERRA BLOCKER CORRECTION (carried forward from 2023): exact certified
// date-set adversarial tests. Every scenario below satisfies EVERY aggregate
// per-tier count check (249 total / 248 real-canonical / 1 composite-repaired
// / 0 derived / 0 unavailable) so it reaches, and must be rejected by, the
// exact-date-set gate -- proving the count-only checks alone are NOT
// sufficient, and that persistence never occurs before that gate passes.
// ============================================================

test('J. one certified date removed and replaced with an unrelated (non-certified) date, total remains 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2024RequestedSessions().tradingDates;
  const removedDate = certifiedDates.find((d) => d !== COMPOSITE_REPAIRED_DATE)!;
  const substitutedDates = [...certifiedDates.filter((d) => d !== removedDate), '2020-06-15'];
  assert.equal(substitutedDates.length, 249);
  const sessions = substitutedDates.map((d) => (d === COMPOSITE_REPAIRED_DATE ? compositeRepairedSelection(d) : realSelection(d)));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

test('K. one date duplicated and a DIFFERENT certified date removed, total remains 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2024RequestedSessions().tradingDates;
  const nonCompositeDates = certifiedDates.filter((d) => d !== COMPOSITE_REPAIRED_DATE);
  const removedDate = nonCompositeDates[0];
  const duplicatedDate = nonCompositeDates[1];
  const withoutRemoved = certifiedDates.filter((d) => d !== removedDate);
  const duplicatedSet = [...withoutRemoved, duplicatedDate];
  assert.equal(duplicatedSet.length, 249);
  const sessions = duplicatedSet.map((d) => (d === COMPOSITE_REPAIRED_DATE ? compositeRepairedSelection(d) : realSelection(d)));
  // Uses `rawFixtureResult` (not `fixtureResult`) -- the real builder already refuses to construct a
  // duplicate-date assembly, so this simulates a forged/malformed fake-service result to actually
  // reach the CLI's own duplicate-date defense-in-depth check.
  const service = new FakeAssemblyService(rawFixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=DUPLICATE_TRADING_DATE'));
  assert.ok(errorLines.join('\n').includes(duplicatedDate));
});

test('L. the composite-repaired date (2024-12-12) removed and substituted with an unrelated date, total remains 249 -> FAILED at the composite-repaired-date gate (the most specific/actionable check, reached before the generic exact-date-set gate), no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2024RequestedSessions().tradingDates;
  const substitutedDates = [...certifiedDates.filter((d) => d !== COMPOSITE_REPAIRED_DATE), '2020-06-15'];
  assert.equal(substitutedDates.length, 249);
  // Keeps the composite-repaired TIER COUNT correct (1) by moving it onto the substituted date -- this
  // still isolates a genuine "2024-12-12 is gone" defect, just caught by the earlier, MORE SPECIFIC
  // `WRONG_COMPOSITE_REPAIRED_TRADING_DATES` gate in `validateLockedProductionPostconditions` rather
  // than the later, generic exact-date-set gate (which J/M above already exercise directly).
  const sessions = substitutedDates.map((d) => (d === '2020-06-15' ? compositeRepairedSelection(d) : realSelection(d)));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 0, 'the certified-calendar resolver is never even called once the earlier aggregate-tier gate has already failed closed');
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=WRONG_COMPOSITE_REPAIRED_TRADING_DATES'));
  assert.ok(summary.includes(COMPOSITE_REPAIRED_DATE));
});

test('M. TERRA-style reproduction: 248 unrelated sequential real-canonical dates + composite-repaired 2024-12-12 -- every aggregate count is superficially valid, but the exact date set is wrong -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(248, '2020-01-01').map((d) => realSelection(d)), compositeRepairedSelection(COMPOSITE_REPAIRED_DATE)];
  assert.equal(sessions.length, 249);
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false, 'this fixture reproduces the exact Terra-class bypass shape -- it MUST be rejected');
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

// ---- window-mismatch tests: each special session's window is independently validated ----

test('N1. the certified calendar source resolves the wrong Muhurat (2024-11-01) window -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2024RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [MUHURAT_DATE]: [{ windowIndex: 0, openMinuteIst: 1095, closeMinuteIst: 1155 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_WINDOW_MISMATCH'));
});

test('N2. the certified calendar source resolves the wrong 2024-01-20 window -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2024RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [JAN20_DATE]: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=JAN20_WINDOW_MISMATCH'));
});

test('N3. the certified calendar source resolves the wrong 2024-03-02 DR-switchover windows (bridged into one window) -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2024RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [MAR2_DATE]: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 750 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MAR2_WINDOW_MISMATCH'));
});

test('N4. the certified calendar source resolves the wrong 2024-05-18 DR-switchover windows -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2024RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates, calendarSessionWindows: { ...genuine.calendarSessionWindows, [MAY18_DATE]: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 }] } };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MAY18_WINDOW_MISMATCH'));
});

test('O. the certified calendar source itself resolves a session count other than 249 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2024RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates.slice(0, 248), calendarSessionWindows: genuine.calendarSessionWindows };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const success = await runNifty2024ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => new ThrowingCalendarResolver(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=CERTIFIED_CALENDAR_RESOLUTION_FAILED'));
  assert.ok(summary.includes('calendar coverage lookup failed'));
});

test('R. exact certified date set derived from the authoritative 2024 fixture contains exactly 249 dates, includes all four special sessions plus the composite-repaired date, and matches fullyValidSessions() one-for-one', () => {
  const certified = certifiedNifty2024RequestedSessions();
  assert.equal(certified.tradingDates.length, 249);
  assert.ok(certified.tradingDates.includes(JAN20_DATE));
  assert.ok(certified.tradingDates.includes(MAR2_DATE));
  assert.ok(certified.tradingDates.includes(MAY18_DATE));
  assert.ok(certified.tradingDates.includes(MUHURAT_DATE));
  assert.ok(certified.tradingDates.includes(COMPOSITE_REPAIRED_DATE));
  assert.deepEqual(new Set(certified.tradingDates).size, 249, 'no duplicate certified dates');
  assert.deepEqual(
    fullyValidSessions().map((s) => s.tradingDate).sort(),
    [...certified.tradingDates].sort()
  );
});
