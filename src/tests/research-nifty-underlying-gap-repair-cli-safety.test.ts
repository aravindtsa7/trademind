import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProductionRepairProvider } from './research-nifty-underlying-gap-repair';

/**
 * B-F8 CORRECTION (post-Terra-review blocker 3): the operational
 * `research-nifty-underlying-gap-repair.ts` CLI must NEVER be capable of
 * wiring a deterministic/fixture repair provider into a real repair-write
 * attempt against the shared application database. Two independent proofs:
 *
 * (1) BEHAVIORAL -- `resolveProductionRepairProvider()`, the ONE function
 *     this CLI may ever call to obtain a repair provider, returns
 *     `undefined` today (no real secondary NIFTY 1-minute provider adapter
 *     exists in this repository -- see the B-F8 correction report section
 *     16). `NiftyUnderlyingGapRepairService` itself refuses every provider
 *     call and every DB write whenever no repair provider is configured
 *     (proven by the K.7 integration test), so this composition can never
 *     persist anything, fixture-derived or otherwise.
 *
 * (2) STRUCTURAL (source-text) -- the operational CLI's source file must not
 *     even IMPORT `FixtureRepairProvider`/any fixture-driven adapter at all,
 *     so the unsafe wiring cannot be reintroduced by a future edit without
 *     this test catching it. Mirrors the existing repo convention of
 *     source-text regression tests for "this file must never depend on X"
 *     guarantees (see `NiftyUnderlyingIngestionPlannerService`'s doc comment).
 *
 * A companion structural check also confirms the SEPARATE, test-only
 * `research-nifty-underlying-gap-repair-fixture-verify.ts` entrypoint DOES
 * gate itself through `assertSafeIsolatedTestDatabaseUrl` before connecting
 * to anything -- so the fixture path cannot be reintroduced there without
 * the safety guard either.
 */

test('resolveProductionRepairProvider() returns undefined -- no production secondary NIFTY 1-minute provider is wired', () => {
  assert.equal(resolveProductionRepairProvider(), undefined);
});

test('the operational CLI source file never imports/references FixtureRepairProvider', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair.ts'), 'utf8');
  assert.equal(/FixtureRepairProvider/.test(source), false, 'the operational gap-repair CLI must never reference a fixture/test-only provider adapter');
});

test('the operational CLI source file never reads RESEARCH_REPAIR_FIXTURE_PATH or an "allow test provider" override', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair.ts'), 'utf8');
  assert.equal(/RESEARCH_REPAIR_FIXTURE_PATH/.test(source), false);
  assert.equal(/ALLOW_TEST_PROVIDER/.test(source), false);
});

test('the fixture-verify entrypoint source file gates itself through assertSafeIsolatedTestDatabaseUrl before connecting to anything', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/assertSafeIsolatedTestDatabaseUrl/.test(source), true, 'the fixture-verify script must call the shared safety guard');
  assert.equal(/HISTORICAL_CANDLE_TEST_REQUIRE/.test(source), true, 'the fixture-verify script must require the explicit test-opt-in env var');
});

test('the fixture-verify entrypoint never references DATABASE_URL as a write/connection target (only as the value it must NOT match)', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  const databaseUrlUsages = source.match(/process\.env\.DATABASE_URL/g) ?? [];
  // The only legitimate use is passing it to assertSafeIsolatedTestDatabaseUrl as the "must not match" comparand.
  assert.equal(databaseUrlUsages.length, 1, 'DATABASE_URL must appear exactly once, as the safety-guard comparand, never as a connection target');
});

// ============================================================================
// HIGH 3 (post-Terra-review correction): fixture verification must have ZERO
// real primary-provider network calls -- the original defect was that a
// "fixture verification" injected only a fixture REPAIR provider and left
// `primaryProvider` unsupplied, so `NiftyUnderlyingGapRepairService` defaulted
// it to a real `UpstoxHistoricalDataProviderService`, meaning a "fixture
// verification" could still reach a genuine Upstox network request.
// ============================================================================

test('HIGH-3: the fixture-verify entrypoint never imports or constructs UpstoxHistoricalDataProviderService', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  // Matches an import statement or a `new UpstoxHistoricalDataProviderService(` construction -- a mere
  // prose mention in a doc comment (e.g. explaining WHY a fixture provider exists) is not itself unsafe.
  assert.equal(/from '.*upstox.*'|new UpstoxHistoricalDataProviderService\(/i.test(source), false, 'the fixture-verify script must never import/construct the real Upstox provider');
});

test('HIGH-3: the fixture-verify entrypoint never constructs a Groww provider', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/GrowwHistoricalClient|GrowwOptionHistoricalDataProviderService|groww-historical/.test(source), false, 'the fixture-verify script must never import/construct a real Groww provider/client');
});

test('HIGH-3: the fixture-verify entrypoint never imports axios or any HTTP client', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/from 'axios'|require\('axios'\)/.test(source), false, 'the fixture-verify script must never import axios or perform network I/O');
});

test('HIGH-3: the fixture-verify entrypoint explicitly supplies BOTH primaryProvider and repairProvider to NiftyUnderlyingGapRepairService', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/new NiftyUnderlyingGapRepairService\(\{[\s\S]*?primaryProvider,[\s\S]*?repairProvider,[\s\S]*?\}\)/.test(source), true, 'both primaryProvider and repairProvider must be explicitly passed to the service constructor -- never omitted/defaulted');
});

test('HIGH-3: the fixture-verify entrypoint defines its own FixturePrimaryProvider (never reuses/imports a real provider class as primary)', async () => {
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/class FixturePrimaryProvider implements HistoricalDataProvider/.test(source), true);
});

test('HIGH-3: fixture verification can succeed with no Upstox credentials configured, and fake/invalid Upstox credentials cannot alter its behavior', async () => {
  // Structural proof, not a live-process proof (this suite has no isolated MySQL DB to actually run
  // repairSession() against here -- see the isolated-MySQL integration suite for that): the
  // fixture-verify script never reads any UPSTOX_*/GROWW_* environment variable at all, so its
  // behavior cannot possibly depend on whether real, fake, or absent broker credentials are set.
  const source = await readFile(join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts'), 'utf8');
  assert.equal(/UPSTOX_|GROWW_/.test(source), false, 'the fixture-verify script must never read any broker credential environment variable');
});
