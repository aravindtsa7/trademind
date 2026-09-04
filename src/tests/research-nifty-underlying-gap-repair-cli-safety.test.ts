import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProductionRepairProvider, shouldPersistRepairArtifact } from './research-nifty-underlying-gap-repair';
import GrowwUnderlyingGapRepairProviderService, {
  assertExpectedMissingMinuteWithinRegularSession,
  parseExpectedMissingMinuteUtc,
} from '../modules/research-lake/providers/groww/groww-underlying-gap-repair-provider.service';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { HistoricalCandleRepairOutcome } from '../modules/research-lake/domain';

/**
 * B-M10, extended by the targeted GROWW missing-minute correction: the
 * operational `research-nifty-underlying-gap-repair.ts` CLI wires a REAL
 * secondary NIFTY 1-minute provider (Groww) into
 * `resolveProductionRepairProvider()`, superseding the earlier B-F8 state
 * this suite previously locked in (where that function always returned
 * `undefined`). Since the first real repair attempt safely returned
 * `REPAIR_CONFLICT` (root cause: Upstox `openInterest=0n` vs Groww
 * `openInterest=null` on every overlapping minute), the CLI now ALSO
 * requires an explicit `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC` and
 * resolves a repair-SCOPED wrapper (`GrowwUnderlyingGapRepairProviderService`),
 * never the raw full-session adapter, as the actual repair provider. This
 * suite re-proves the SAME kind of invariants under the new contract:
 *
 * (1) BEHAVIORAL -- `resolveProductionRepairProvider(providerName, expectedMissingMinuteUtc)`
 *     only ever resolves a real, production, repair-SCOPED adapter for a
 *     supported name + a defined missing-minute `Date`, throws (never
 *     silently returns `undefined`) for anything else, and throws BEFORE any
 *     provider call when Groww credentials or the missing-minute Date are
 *     absent (reusing `GrowwHistoricalClient`'s own constructor gate, never
 *     a duplicate check). `shouldPersistRepairArtifact(outcome)` is proven
 *     `true` for ONLY `REPAIR_ACCEPTED`, for every other outcome value.
 *
 * (2) STRUCTURAL (source-text) -- the operational CLI's source file must
 *     still never import `FixtureRepairProvider`/any fixture-driven adapter,
 *     must never construct `UpstoxHistoricalDataProviderService` as a repair
 *     provider, must require `RESEARCH_REPAIR_PROVIDER`,
 *     `RESEARCH_REPAIR_TRADING_DATE`, AND (for GROWW)
 *     `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC` before doing anything
 *     else, must never support a broad from/to date range, and must never
 *     accept multiple/ranged missing-minute candidates.
 *
 * A companion structural check also confirms the SEPARATE, test-only
 * `research-nifty-underlying-gap-repair-fixture-verify.ts` entrypoint DOES
 * gate itself through `assertSafeIsolatedTestDatabaseUrl` before connecting
 * to anything, and never constructs a real Groww/Upstox provider -- unchanged
 * by this task.
 */

const GROWW_TOKEN_ENV_VAR = 'GROWW_ACCESS_TOKEN';
const VALID_MISSING_MINUTE_UTC = new Date('2024-12-12T04:12:00.000Z'); // the exact B-M10 locked authorized timestamp
const VALID_TRADING_DATE = '2024-12-12';

/** Temporarily overrides GROWW_ACCESS_TOKEN for one synchronous call, then restores whatever was there before -- never leaks a test token into other tests or logs it. */
function withGrowwToken<T>(token: string | undefined, fn: () => T): T {
  const original = process.env[GROWW_TOKEN_ENV_VAR];
  if (token === undefined) delete process.env[GROWW_TOKEN_ENV_VAR];
  else process.env[GROWW_TOKEN_ENV_VAR] = token;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[GROWW_TOKEN_ENV_VAR];
    else process.env[GROWW_TOKEN_ENV_VAR] = original;
  }
}

// ---- resolveProductionRepairProvider ---------------------------------------

test("resolveProductionRepairProvider('GROWW', <validDate>) resolves a real repair-SCOPED GrowwUnderlyingGapRepairProviderService when a Groww token is configured", () => {
  const provider = withGrowwToken('test-only-nonsense-token-value', () => resolveProductionRepairProvider('GROWW', VALID_MISSING_MINUTE_UTC));
  assert.ok(provider instanceof GrowwUnderlyingGapRepairProviderService, 'must resolve the repair-scoped wrapper, never the raw full-session adapter directly');
  assert.equal(provider.providerId, HistoricalProviderId.GROWW);
});

test("resolveProductionRepairProvider('GROWW', <validDate>) throws BEFORE any provider call when GROWW_ACCESS_TOKEN is missing/blank", () => {
  assert.throws(() => withGrowwToken(undefined, () => resolveProductionRepairProvider('GROWW', VALID_MISSING_MINUTE_UTC)), /GROWW_ACCESS_TOKEN/);
  assert.throws(() => withGrowwToken('   ', () => resolveProductionRepairProvider('GROWW', VALID_MISSING_MINUTE_UTC)), /GROWW_ACCESS_TOKEN/);
});

test("resolveProductionRepairProvider('GROWW', undefined) throws even with a valid Groww token configured -- the missing-minute candidate is never optional/implicit", () => {
  assert.throws(() => withGrowwToken('test-only-nonsense-token-value', () => resolveProductionRepairProvider('GROWW', undefined)), /RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC/);
});

test('resolveProductionRepairProvider rejects an unsupported provider name -- never silently falls back to undefined/a default', () => {
  assert.throws(() => resolveProductionRepairProvider('UPSTOX', VALID_MISSING_MINUTE_UTC), /Unsupported RESEARCH_REPAIR_PROVIDER/);
  assert.throws(() => resolveProductionRepairProvider('DHAN', VALID_MISSING_MINUTE_UTC), /Unsupported RESEARCH_REPAIR_PROVIDER/);
  assert.throws(() => resolveProductionRepairProvider('bogus', VALID_MISSING_MINUTE_UTC), /Unsupported RESEARCH_REPAIR_PROVIDER/);
  assert.throws(() => resolveProductionRepairProvider('', VALID_MISSING_MINUTE_UTC), /Unsupported RESEARCH_REPAIR_PROVIDER/);
});

test('resolveProductionRepairProvider is case-sensitive -- "groww" (lowercase) is not silently normalized to "GROWW"', () => {
  assert.throws(() => resolveProductionRepairProvider('groww', VALID_MISSING_MINUTE_UTC), /Unsupported RESEARCH_REPAIR_PROVIDER/);
});

// ---- RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC validation (imported directly, exercised in isolation) ----

test('parseExpectedMissingMinuteUtc/assertExpectedMissingMinuteWithinRegularSession accept the exact B-M10 authorized candidate', () => {
  const parsed = parseExpectedMissingMinuteUtc('2024-12-12T04:12:00.000Z');
  assert.doesNotThrow(() => assertExpectedMissingMinuteWithinRegularSession(parsed, VALID_TRADING_DATE));
});

test('parseExpectedMissingMinuteUtc rejects a non-minute-aligned or non-canonical timestamp before any provider call', () => {
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12T04:12:30.000Z'));
  assert.throws(() => parseExpectedMissingMinuteUtc('2024-12-12 04:12:00'));
  assert.throws(() => parseExpectedMissingMinuteUtc('not-a-timestamp'));
});

test('assertExpectedMissingMinuteWithinRegularSession rejects a timestamp belonging to the wrong trading date', () => {
  assert.throws(() => assertExpectedMissingMinuteWithinRegularSession(VALID_MISSING_MINUTE_UTC, '2024-12-13'));
});

test('assertExpectedMissingMinuteWithinRegularSession rejects a timestamp outside the certified regular session window (e.g. the 15:30 boundary)', () => {
  const boundary = new Date(`${VALID_TRADING_DATE}T15:30:00+05:30`);
  assert.throws(() => assertExpectedMissingMinuteWithinRegularSession(boundary, VALID_TRADING_DATE));
});

// ---- shouldPersistRepairArtifact -------------------------------------------

test('shouldPersistRepairArtifact is true ONLY for REPAIR_ACCEPTED', () => {
  assert.equal(shouldPersistRepairArtifact(HistoricalCandleRepairOutcome.REPAIR_ACCEPTED), true);
  assert.equal(shouldPersistRepairArtifact(HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED), false);
  assert.equal(shouldPersistRepairArtifact(HistoricalCandleRepairOutcome.REPAIR_UNAVAILABLE), false);
  assert.equal(shouldPersistRepairArtifact(HistoricalCandleRepairOutcome.REPAIR_INCOMPLETE), false);
  assert.equal(shouldPersistRepairArtifact(HistoricalCandleRepairOutcome.REPAIR_CONFLICT), false);
});

test('shouldPersistRepairArtifact covers every HistoricalCandleRepairOutcome member -- no future outcome value is silently unhandled', () => {
  const covered = Object.values(HistoricalCandleRepairOutcome).map((outcome) => shouldPersistRepairArtifact(outcome));
  assert.equal(covered.length, Object.values(HistoricalCandleRepairOutcome).length);
  assert.equal(covered.filter(Boolean).length, 1, 'exactly one outcome (REPAIR_ACCEPTED) may persist the artifact');
});

// ---- structural (source-text) safety on the operational CLI ---------------

async function operationalSource(): Promise<string> {
  return readFile(join(__dirname, 'research-nifty-underlying-gap-repair.ts'), 'utf8');
}

test('the operational CLI source file never imports/references FixtureRepairProvider', async () => {
  const source = await operationalSource();
  assert.equal(/FixtureRepairProvider/.test(source), false, 'the operational gap-repair CLI must never reference a fixture/test-only provider adapter');
});

test('the operational CLI source file never reads RESEARCH_REPAIR_FIXTURE_PATH or an "allow test provider" override', async () => {
  const source = await operationalSource();
  assert.equal(/RESEARCH_REPAIR_FIXTURE_PATH/.test(source), false);
  assert.equal(/ALLOW_TEST_PROVIDER/.test(source), false);
});

test('K: the operational CLI requires RESEARCH_REPAIR_PROVIDER to be set before resolving a provider', async () => {
  const source = await operationalSource();
  assert.match(source, /RESEARCH_REPAIR_PROVIDER/);
  assert.match(source, /if \(!providerName\)/);
});

test('K: the operational CLI requires RESEARCH_REPAIR_TRADING_DATE and validates its YYYY-MM-DD shape before any provider resolution', async () => {
  const source = await operationalSource();
  assert.match(source, /RESEARCH_REPAIR_TRADING_DATE/);
  assert.match(source, /DATE_PATTERN/);
  // The trading-date checks must appear textually BEFORE resolveProductionRepairProvider is called.
  const dateCheckIndex = source.indexOf('DATE_PATTERN.test(tradingDate)');
  const resolveCallIndex = source.indexOf('resolveProductionRepairProvider(providerName, expectedMissingMinuteUtc)');
  assert.ok(dateCheckIndex > -1 && resolveCallIndex > -1 && dateCheckIndex < resolveCallIndex, 'trading-date validation must run before provider resolution');
});

test('K: the operational CLI requires RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC for GROWW, parsed/validated BEFORE provider resolution', async () => {
  const source = await operationalSource();
  assert.match(source, /RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC/);
  assert.match(source, /parseExpectedMissingMinuteUtc/);
  assert.match(source, /assertExpectedMissingMinuteWithinRegularSession/);
  const requireCheckIndex = source.indexOf('if (!rawExpectedMissingMinute)');
  const parseCallIndex = source.indexOf('parseExpectedMissingMinuteUtc(rawExpectedMissingMinute)');
  const assertCallIndex = source.indexOf('assertExpectedMissingMinuteWithinRegularSession(expectedMissingMinuteUtc, tradingDate)');
  const resolveCallIndex = source.indexOf('resolveProductionRepairProvider(providerName, expectedMissingMinuteUtc)');
  assert.ok(requireCheckIndex > -1 && parseCallIndex > -1 && assertCallIndex > -1 && resolveCallIndex > -1);
  assert.ok(requireCheckIndex < parseCallIndex, 'presence check must run before parsing');
  assert.ok(parseCallIndex < assertCallIndex, 'format/alignment parsing must run before the session-window check');
  assert.ok(assertCallIndex < resolveCallIndex, 'the missing-minute candidate must be fully validated before provider resolution / any provider call');
});

test('K: no multiple candidate timestamps -- the operational CLI never splits/parses RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC as a list/range', async () => {
  const source = await operationalSource();
  assert.equal(/RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC[\s\S]{0,200}?\.split\(/.test(source), false, 'the operational CLI must never split the missing-minute env var into multiple candidates');
  assert.equal(/RESEARCH_REPAIR_EXPECTED_MISSING_MINUTES?_RANGE/i.test(source), false);
});

test('K: the operational CLI prints the expected missing-minute timestamp safely (it is not secret)', async () => {
  const source = await operationalSource();
  assert.match(source, /expectedMissingMinuteUtc: expectedMissingMinuteUtc/);
});

test('K: no accidental Upstox-as-secondary wiring -- the operational CLI never constructs UpstoxHistoricalDataProviderService', async () => {
  const source = await operationalSource();
  assert.equal(/from '.*upstox.*'|new UpstoxHistoricalDataProviderService\(/i.test(source), false, 'the operational CLI must never import/construct an Upstox provider as the repair provider');
});

test('K: no broad date-range support -- the operational CLI has no from/to date-range input, only a single RESEARCH_REPAIR_TRADING_DATE', async () => {
  const source = await operationalSource();
  assert.equal(/RESEARCH_REPAIR_FROM|RESEARCH_REPAIR_TO_DATE|fromTradingDate.*toTradingDate/i.test(source), false);
  assert.match(source, /repairSession\(\{\s*tradingDate\s*\}\)/, 'repairSession must be called with exactly the single tradingDate field');
});

test('K: the artifact write is gated on shouldPersistRepairArtifact, not unconditional', async () => {
  const source = await operationalSource();
  assert.match(source, /shouldPersistRepairArtifact\(result\.outcome\)/);
  const gateIndex = source.indexOf('const persistArtifact = shouldPersistRepairArtifact(result.outcome);');
  const writeIndex = source.indexOf('await writeFile(ARTIFACT_PATH');
  assert.ok(gateIndex > -1 && writeIndex > -1 && gateIndex < writeIndex, 'the persistArtifact gate must be computed before the artifact write');
});

test('K: no token leakage -- the operational CLI never logs the resolved repairProvider object, only the provider NAME string', async () => {
  const source = await operationalSource();
  const consoleLogBlocks = source.match(/console\.log\([\s\S]*?\);/g) ?? [];
  assert.ok(consoleLogBlocks.length > 0, 'sanity: at least one console.log call must exist to check');
  for (const block of consoleLogBlocks) {
    if (!block.includes('repairProvider')) continue;
    assert.match(block, /repairProvider: providerName/, `console.log block references 'repairProvider' but not as the safe 'repairProvider: providerName' string label: ${block}`);
  }
  assert.match(source, /repairProvider: providerName/, 'only the provider name string is logged, never the provider/client object');
});

test('K: no hardcoded Groww credentials anywhere in the operational CLI source', async () => {
  const source = await operationalSource();
  assert.equal(/GROWW_ACCESS_TOKEN\s*=\s*['"]/.test(source), false);
});

// ---- fixture-verify entrypoint (unchanged by B-M10) ------------------------

test('the fixture-verify entrypoint source file gates itself through assertSafeIsolatedTestDatabaseUrl before connecting to anything', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/assertSafeIsolatedTestDatabaseUrl/.test(source), true, 'the fixture-verify script must call the shared safety guard');
  assert.equal(/HISTORICAL_CANDLE_TEST_REQUIRE/.test(source), true, 'the fixture-verify script must require the explicit test-opt-in env var');
});

test('the fixture-verify entrypoint never references DATABASE_URL as a write/connection target (only as the value it must NOT match)', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  const databaseUrlUsages = source.match(/process\.env\.DATABASE_URL/g) ?? [];
  assert.equal(databaseUrlUsages.length, 1, 'DATABASE_URL must appear exactly once, as the safety-guard comparand, never as a connection target');
});

test('the fixture-verify entrypoint never imports or constructs UpstoxHistoricalDataProviderService', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/from '.*upstox.*'|new UpstoxHistoricalDataProviderService\(/i.test(source), false, 'the fixture-verify script must never import/construct the real Upstox provider');
});

test('the fixture-verify entrypoint never constructs a Groww provider', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/GrowwHistoricalClient|GrowwOptionHistoricalDataProviderService|GrowwUnderlyingHistoricalDataProviderService|groww-historical|groww-underlying/.test(source), false, 'the fixture-verify script must never import/construct a real Groww provider/client');
});

test('the fixture-verify entrypoint never imports axios or any HTTP client', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/from 'axios'|require\('axios'\)/.test(source), false, 'the fixture-verify script must never import axios or perform network I/O');
});

test('the fixture-verify entrypoint explicitly supplies BOTH primaryProvider and repairProvider to NiftyUnderlyingGapRepairService', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/new NiftyUnderlyingGapRepairService\(\{[\s\S]*?primaryProvider,[\s\S]*?repairProvider,[\s\S]*?\}\)/.test(source), true, 'both primaryProvider and repairProvider must be explicitly passed to the service constructor -- never omitted/defaulted');
});

test('the fixture-verify entrypoint defines its own FixturePrimaryProvider (never reuses/imports a real provider class as primary)', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/class FixturePrimaryProvider implements HistoricalDataProvider/.test(source), true);
});

test('fixture verification can succeed with no Upstox/Groww credentials configured, and fake/invalid credentials cannot alter its behavior', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/UPSTOX_|GROWW_/.test(source), false, 'the fixture-verify script must never read any broker credential environment variable');
});
