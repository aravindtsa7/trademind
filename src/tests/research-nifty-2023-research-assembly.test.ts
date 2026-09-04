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
import { AssembleAndPersistNiftyUnderlyingResearchAssembly, runNifty2023ResearchAssembly } from './research-nifty-2023-research-assembly';

/**
 * Zero-DB, zero-network unit suite for the B-M9 2023 research-assembly CLI.
 * Mirrors `research-nifty-2022-research-assembly.test.ts` exactly, adapted
 * for the 2023 CLEAN canonical year (246 sessions, 0 authorized-derived).
 * Never imports the real `NiftyUnderlyingResearchAssemblyService` or
 * `ManifestCalendarSessionResolverService` CLASS as a value.
 *
 * TERRA BLOCKER CORRECTION: Terra reproduced a bypass where an assembly
 * containing 245 unrelated dates (sequential from 2020-01-01) plus the
 * 2023-11-12 Muhurat date satisfied every aggregate per-tier count check and
 * was accepted/persisted. The fix under test here is a SEPARATE,
 * independent exact-date-set postcondition
 * (`validateCertifiedDateSetPostcondition` in the CLI itself) that requires
 * the assembly's trading dates to be in EXACT set equality with the
 * certified 2023 calendar, independently re-resolved via an injected
 * `RequestedSessionsResolver` dependency. The happy-path fixture below is
 * built from the checked-in AUTHORITATIVE NSE/EQUITY 2023 calendar fixture
 * (`authoritative-nse-equity-calendar-fixtures.ts`) -- the SAME fixture that
 * was imported to certify the real 2023 calendar this CLI's production
 * `ManifestCalendarSessionResolverService` ultimately resolves against --
 * rather than a hand-typed date list, so it can never silently drift out of
 * sync with real calendar truth.
 */

const INSTRUMENT_KEY = NIFTY_INDEX_INSTRUMENT_KEY;
const TIMEFRAME = NIFTY_UNDERLYING_TIMEFRAME;
const MUHURAT_DATE = '2023-11-12';

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

/**
 * TERRA BLOCKER CORRECTION: fake for the CLI's new, injected
 * `RequestedSessionsResolver` dependency -- never the real, DB-backed
 * `ManifestCalendarSessionResolverService`. Mirrors the exact fake idiom
 * already used for this same dependency type in
 * `nifty-underlying-research-assembly.service.test.ts`.
 */
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
 * Independently expands the checked-in AUTHORITATIVE NSE/EQUITY 2023
 * calendar fixture (`authoritative-nse-equity-calendar-fixtures.ts` --
 * the SAME fixture real 2023 calendar certification was imported from) into
 * the exact certified 2023 trading-date set + session windows, entirely
 * offline (no DB). Applies the SAME locked precedence
 * `ExchangeCalendarResolverService.resolveWithinCertifiedCoverage` uses
 * (explicit day classification wins; otherwise weekday inference) using only
 * already-exported production primitives (`isWeekend`, `regularSessionWindow`)
 * -- never a new parallel calendar model. Zero dates are hand-typed here: a
 * change to the checked-in fixture automatically flows through to this
 * suite's expectations.
 */
function certifiedNifty2023RequestedSessions(): ManifestRequestedSessions {
  const fixture = findAuthoritativeNseEquityCalendarFixture(2023);
  assert.ok(fixture, 'expected a registered authoritative NSE/EQUITY calendar fixture for 2023');
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

/** A fresh `FakeCalendarResolver` seeded with the exact certified 2023 date set/windows -- the ONE resolver every test below injects unless a test is specifically about a corrupted/wrong calendar source. */
function certifiedCalendarResolver(): FakeCalendarResolver {
  return new FakeCalendarResolver(certifiedNifty2023RequestedSessions());
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
    persistedCanonicalHealthStatus: DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS,
    identity: identityFor(tradingDate),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    calendarSessionWindows: [],
    canonicalContentChecksum: 'c'.repeat(64),
    canonicalRowCount: 375,
    repairProvenance: { kind: ResearchSessionCompositeRepairProvenanceKind.UNKNOWN_LEGACY_REPAIR_PROVENANCE },
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
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2023, ...identityOverrides },
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
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2023-01-01', requestedToDate: '2023-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/**
 * TERRA BLOCKER CORRECTION (test K only): `buildResearchUnderlyingDatasetAssembly`
 * itself already refuses to construct an assembly with a duplicate trading
 * date (`assertNoDuplicateTradingDateSelections`, a PRE-EXISTING B-M7.2
 * defensive guard, "structurally unreachable today... kept as an explicit
 * defensive guard" per its own doc). To exercise this CLI's OWN
 * `DUPLICATE_TRADING_DATE` defense-in-depth check -- which exists for
 * exactly the same reason, against exactly the same class of threat Terra
 * described ("a forged/fake assembly can contain...") -- this helper
 * deliberately bypasses that domain-level guard and hand-assembles a
 * `ResearchUnderlyingDatasetAssemblyV1`-shaped object directly, simulating a
 * malformed/forged fake-service result that never actually went through the
 * real builder.
 */
function rawFixtureResult(sessions: ResearchSessionSourceSelection[]): NiftyUnderlyingResearchAssemblyResult {
  const identity = { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, year: 2023 };
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
      provenance: { provider: 'UPSTOX' as never, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: INSTRUMENT_KEY, requestedFromDate: '2023-01-01', requestedToDate: '2023-12-31', acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
      generatedAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      sessionCounts: { requested: 0, included: 0, healthy: 0, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    },
    assemblyStorage: null,
  };
}

/** Every certified 2023 date EXCEPT the Muhurat date -- 245 dates, straight from the authoritative fixture. */
function certifiedDatesExcludingMuhurat(): string[] {
  return certifiedNifty2023RequestedSessions().tradingDates.filter((date) => date !== MUHURAT_DATE);
}

/** Exactly the locked-production-happy-path session set: 246 real canonical, 0 composite, 0 derived, 0 unavailable, matching the certified 2023 calendar exactly (including the Muhurat date as an ordinary real-canonical entry). */
function fullyValidSessions(): ResearchSessionSourceSelection[] {
  return certifiedNifty2023RequestedSessions().tradingDates.map((date) => realSelection(date));
}

// ---- A: exact 246/246 real/0 composite/0 derived/0 unavailable, EXACT certified date set -> SUCCESS, persisted exactly once ----

test('A. exact certified 2023 date set (246/246 real, 0 composite, 0 derived, 0 unavailable) -> SUCCESS, artifact persisted exactly once', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(calendarResolver.callCount, 1);
  assert.deepEqual(calendarResolver.lastRequest, { fromDate: '2023-01-01', toDate: '2023-12-31' });
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes(`instrument=${INSTRUMENT_KEY}`));
  assert.ok(summary.includes(`timeframe=${TIMEFRAME}`));
  assert.ok(summary.includes('year=2023'));
  assert.ok(summary.includes('expectedSessions=246'));
  assert.ok(summary.includes('researchReadySessions=246'));
  assert.ok(summary.includes('realCanonicalSessions=246'));
  assert.ok(summary.includes('compositeRepairedSessions=0'));
  assert.ok(summary.includes('authorizedDerivedSessions=0'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('derivedTradingDates=NONE'));
  assert.ok(summary.includes('canonicalManifestChecksum='));
  assert.ok(summary.includes('researchAssemblyChecksum='));
  assert.ok(summary.includes('researchAssemblyArtifact='));
});

// ---- B: an unavailable session -> FAILED ----

test('B. 245 certified-real + 1 unavailable (in place of Muhurat) -> FAILED/non-zero, no artifact persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingMuhurat().map((d) => realSelection(d)), unavailableSelection(MUHURAT_DATE)];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=INCOMPLETE_RESEARCH_READY_SESSIONS'));
});

// ---- C: expectedSessions != 246 -> FAILED ----

test('C. expectedSessions !== 246 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = sequentialDates(99, '2020-01-01').map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_EXPECTED_SESSION_COUNT'));
});

// ---- D: an unexpected authorized-derived session (in place of Muhurat) -> FAILED (wrong tier) ----

test('D. an unexpected authorized-derived session appears in place of Muhurat -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingMuhurat().map((d) => realSelection(d)), derivedSelection(MUHURAT_DATE)];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS'));
});

// ---- E: an unexpected composite-repaired session (in place of Muhurat) -> FAILED (wrong tier) ----

test('E. an unexpected composite-repaired (tier2) session appears in place of Muhurat -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingMuhurat().map((d) => realSelection(d)), compositeRepairedSelection(MUHURAT_DATE)];
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_COMPOSITE_REPAIRED_SESSIONS'));
});

// ---- F: the Muhurat date is exactly present as real-canonical ----

test('F. the 2023-11-12 Muhurat date is present as an ordinary real-canonical session in a valid run', async () => {
  const { lines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, true);
  assert.ok(lines.join('\n').includes('realCanonicalSessions=246'));
});

// ---- G: wrong instrument/timeframe/year -> FAILED ----

test('G. wrong instrument identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { instrumentKey: 'NSE_INDEX|Bank Nifty' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_INSTRUMENT'));
});

test('G. wrong timeframe identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { timeframe: '5minute' }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TIMEFRAME'));
});

test('G. wrong year identity -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions(), { year: 2022 }));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_YEAR'));
});

// ---- H: service exception -> non-zero, no SUCCESS, no persistence ----

test('H. assembleYear throws -> FAILED, non-zero, no persistence attempted', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(new Error('trusted derived artifact integrity check failed'));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
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
  const source = readFileSync(join(__dirname, 'research-nifty-2023-research-assembly.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI persists the trusted artifact ONLY after BOTH postcondition validations -- persistAssembly appears after validateLockedProductionPostconditions AND validateCertifiedDateSetPostcondition in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-research-assembly.ts'), 'utf8');
  const countPostconditionIndex = source.indexOf('validateLockedProductionPostconditions(result.assembly)');
  const dateSetPostconditionIndex = source.indexOf('validateCertifiedDateSetPostcondition(result.assembly, certified)');
  const persistIndex = source.indexOf('service.persistAssembly(result.assembly)');
  assert.ok(countPostconditionIndex > 0 && dateSetPostconditionIndex > 0 && persistIndex > 0);
  assert.ok(countPostconditionIndex < dateSetPostconditionIndex);
  assert.ok(dateSetPostconditionIndex < persistIndex);
});

test('structural: production main() wires the real ManifestCalendarSessionResolverService, never a stub/no-op', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-research-assembly.ts'), 'utf8');
  assert.match(source, /buildCalendarSessionResolverService:\s*\(\)\s*=>\s*new ManifestCalendarSessionResolverService\(\)/);
});

// ============================================================
// TERRA BLOCKER CORRECTION: exact certified date-set adversarial tests.
// Every scenario below satisfies EVERY aggregate per-tier count check in
// `validateLockedProductionPostconditions` (246 total / 246 real-canonical /
// 0 composite / 0 derived / 0 unavailable) so it reaches, and must be
// rejected by, the NEW `validateCertifiedDateSetPostcondition` gate --
// proving the count-only checks alone are NOT sufficient (Terra's exact
// finding) and that persistence never occurs before that gate passes.
// ============================================================

test('J. one certified date removed and replaced with an unrelated (non-certified) date, total remains 246 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2023RequestedSessions().tradingDates;
  const removedDate = certifiedDates.find((d) => d !== MUHURAT_DATE)!;
  const substitutedDates = [...certifiedDates.filter((d) => d !== removedDate), '2020-06-15'];
  assert.equal(substitutedDates.length, 246);
  const sessions = substitutedDates.map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

test('K. one date duplicated and a DIFFERENT certified date removed, total remains 246 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2023RequestedSessions().tradingDates;
  const nonMuhuratDates = certifiedDates.filter((d) => d !== MUHURAT_DATE);
  const removedDate = nonMuhuratDates[0];
  const duplicatedDate = nonMuhuratDates[1];
  const withoutRemoved = certifiedDates.filter((d) => d !== removedDate);
  const duplicatedSet = [...withoutRemoved, duplicatedDate];
  assert.equal(duplicatedSet.length, 246);
  const sessions = duplicatedSet.map((d) => realSelection(d));
  // Uses `rawFixtureResult` (not `fixtureResult`) -- see its doc: the real
  // `buildResearchUnderlyingDatasetAssembly` already refuses to construct a
  // duplicate-date assembly, so this simulates a forged/malformed fake-service
  // result to actually reach the CLI's own duplicate-date defense-in-depth check.
  const service = new FakeAssemblyService(rawFixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=DUPLICATE_TRADING_DATE'));
  assert.ok(errorLines.join('\n').includes(duplicatedDate));
});

test('L. 2023-11-12 (Muhurat) removed and substituted with an unrelated date, total remains 246 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const certifiedDates = certifiedNifty2023RequestedSessions().tradingDates;
  const substitutedDates = [...certifiedDates.filter((d) => d !== MUHURAT_DATE), '2020-06-15'];
  assert.equal(substitutedDates.length, 246);
  const sessions = substitutedDates.map((d) => realSelection(d));
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=MISSING_CERTIFIED_TRADING_DATE'));
  assert.ok(summary.includes(MUHURAT_DATE));
});

test('M. 2023-11-12 (Muhurat) present but sourced as an authorized-derived (tier3) session -> FAILED at the pre-existing aggregate-tier gate, no persistence', async () => {
  // Distinguishes the pre-existing aggregate-count gate (which already catches this, since a
  // wrong-tier Muhurat necessarily also breaks realCanonicalSessions/authorizedDerivedSessions)
  // from the NEW exact-date-set gate exercised by tests J/K/L/N above/below.
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...certifiedDatesExcludingMuhurat().map((d) => realSelection(d)), derivedSelection(MUHURAT_DATE)];
  assert.equal(sessions.length, 246);
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 0, 'the date-set gate (and its calendar resolver call) must never even run once the earlier aggregate-tier gate has already failed closed');
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS'));
});

test('N. TERRA ORIGINAL BYPASS REPRODUCTION: 245 unrelated sequential dates (from 2020-01-01) + the Muhurat date, all real-canonical -- every aggregate count is superficially valid, but the exact date set is wrong -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const sessions = [...sequentialDates(245, '2020-01-01').map((d) => realSelection(d)), realSelection(MUHURAT_DATE)];
  assert.equal(sessions.length, 246);
  const service = new FakeAssemblyService(fixtureResult(sessions));
  const calendarResolver = certifiedCalendarResolver();
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false, 'THIS is the exact fixture Terra proved was previously accepted -- it MUST now be rejected');
  assert.equal(service.persistCallCount, 0);
  assert.equal(calendarResolver.callCount, 1);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CERTIFIED_TRADING_DATE'));
});

test('O. the certified calendar source itself resolves the wrong Muhurat session window -> FAILED, no persistence (defense-in-depth on the calendar source, not just the assembly)', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2023RequestedSessions();
  const corrupted: ManifestRequestedSessions = {
    tradingDates: genuine.tradingDates,
    calendarSessionWindows: { ...genuine.calendarSessionWindows, [MUHURAT_DATE]: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }] },
  };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_WINDOW_MISMATCH'));
});

test('P. the certified calendar source itself resolves a session count other than 246 -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const genuine = certifiedNifty2023RequestedSessions();
  const corrupted: ManifestRequestedSessions = { tradingDates: genuine.tradingDates.slice(0, 245), calendarSessionWindows: genuine.calendarSessionWindows };
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  const calendarResolver = new FakeCalendarResolver(corrupted);
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => calendarResolver, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=CERTIFIED_CALENDAR_SESSION_COUNT_MISMATCH'));
});

test('Q. certified calendar resolution itself throws -> FAILED, no persistence', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeAssemblyService(fixtureResult(fullyValidSessions()));
  class ThrowingCalendarResolver implements RequestedSessionsResolver {
    async resolveRequestedSessions(): Promise<ManifestRequestedSessions> {
      throw new Error('calendar coverage lookup failed');
    }
  }
  const success = await runNifty2023ResearchAssembly({ buildService: () => service, buildCalendarSessionResolverService: () => new ThrowingCalendarResolver(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=CERTIFIED_CALENDAR_RESOLUTION_FAILED'));
  assert.ok(summary.includes('calendar coverage lookup failed'));
});

test('R. exact certified date set derived from the authoritative 2023 fixture contains exactly 246 dates, includes 2023-11-12, and matches fullyValidSessions() one-for-one', () => {
  const certified = certifiedNifty2023RequestedSessions();
  assert.equal(certified.tradingDates.length, 246);
  assert.ok(certified.tradingDates.includes(MUHURAT_DATE));
  assert.deepEqual(new Set(certified.tradingDates).size, 246, 'no duplicate certified dates');
  assert.deepEqual(
    fullyValidSessions().map((s) => s.tradingDate).sort(),
    [...certified.tradingDates].sort()
  );
});
