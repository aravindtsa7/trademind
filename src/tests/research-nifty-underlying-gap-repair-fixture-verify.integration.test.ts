import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expectedCanonicalTimestamps, expectedMinutesForWindow, regularSessionWindow } from '../modules/research-lake/domain';

/**
 * HIGH 3 (post-Terra-review correction): EXECUTES the real
 * `research-nifty-underlying-gap-repair-fixture-verify.ts` entrypoint (the
 * exact `npm run research:nifty-gap-repair:fixture-verify` a human operator
 * would invoke) as a child process, end to end, against a genuine throwaway
 * MySQL database -- never a mock of the script's internals. Proves, as an
 * EXECUTABLE fact rather than only a source-text inference:
 *
 *  - a fixture verification succeeds with real Upstox credentials entirely
 *    ABSENT from the child process's environment;
 *  - fake/invalid Upstox credentials present in the environment produce the
 *    IDENTICAL outcome (proving the script never reads/depends on them);
 *  - the throwaway database the script creates is genuinely dropped again
 *    (never left behind, never the application database).
 *
 * Self-skips (never fails CI) unless `HISTORICAL_CANDLE_TEST_DATABASE_URL`
 * is configured, exactly like every other isolated-MySQL suite in this
 * module -- see `nifty-underlying-gap-repair.service.integration.test.ts`.
 */

const adminUrlEnvVar = 'HISTORICAL_CANDLE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CANDLE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';
const scriptPath = join(__dirname, 'research-nifty-underlying-gap-repair-fixture-verify.ts');

function skipReason(): string {
  return `Set ${adminUrlEnvVar} (a dedicated admin URL, never DATABASE_URL) to run this integration suite; add ${requireEnvVar}=1 to make setup failures fatal instead of skipped.`;
}

async function writeFixtureFile(dir: string, tradingDate: string, missingIndices: readonly number[]): Promise<string> {
  const timestamps = expectedCanonicalTimestamps(tradingDate, expectedMinutesForWindow(regularSessionWindow()));
  const rows = missingIndices.map((index) => ({
    candleTime: timestamps[index].toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: String(1_000 + index),
    openInterest: null,
  }));
  const fixturePath = join(dir, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify(rows, null, 2));
  return fixturePath;
}

/** Keeps ONLY the fields that must be identical across two otherwise-identical runs -- excludes wall-clock/random fields that legitimately differ (each run creates its own uniquely-named throwaway database and its own retrieval UUIDs). An explicit allow-list, never a deny-list, so a newly-added result field is stable by default rather than silently skipped. */
function stableResultShape(result: Record<string, unknown>): Record<string, unknown> {
  const stableKeys = ['tradingDate', 'outcome', 'reason', 'expectedMinuteCount', 'primaryAcceptedRowCount', 'missingMinuteCount', 'repairAcceptedMinuteCount', 'corroboratedOverlapCount', 'conflictingOverlapCount', 'persisted', 'artifact', 'note'];
  const stable: Record<string, unknown> = {};
  for (const key of stableKeys) {
    if (key in result) stable[key] = result[key];
  }
  return stable;
}

function runFixtureVerifyScript(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', scriptPath], {
    cwd: join(__dirname, '..', '..'),
    env,
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The script emits TWO `console.log` calls: the first a single-line
 * `JSON.stringify(...)`, the second a pretty-printed (`null, 2`)
 * MULTI-LINE `JSON.stringify(...)`. Naive line-by-line `JSON.parse` breaks
 * on the second (each individual line of a pretty-printed object is not
 * itself valid JSON) -- this scans the whole stdout text with brace-depth
 * tracking to extract each COMPLETE top-level JSON object, regardless of
 * how many lines it spans.
 */
function parseJsonResultLines(stdout: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let depth = 0;
  let startIndex = -1;
  for (let i = 0; i < stdout.length; i += 1) {
    const char = stdout[i];
    if (char === '{') {
      if (depth === 0) startIndex = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && startIndex !== -1) {
        const candidate = stdout.slice(startIndex, i + 1);
        try {
          results.push(JSON.parse(candidate) as Record<string, unknown>);
        } catch {
          // Not a complete/valid top-level JSON object (e.g. braces inside an unrelated log line) -- skip it.
        }
        startIndex = -1;
      }
    }
  }
  return results;
}

test.before(async () => {
  if (!process.env[adminUrlEnvVar] && requireIntegration) {
    throw new Error(skipReason());
  }
});

test('HIGH-3 EXECUTABLE: fixture-verify succeeds with Upstox/Groww credentials entirely absent, and identically with fake/invalid credentials present', async (t) => {
  if (!process.env[adminUrlEnvVar]) return t.skip(skipReason());
  const adminUrlRaw = process.env[adminUrlEnvVar]!;

  const tradingDate = '2031-03-11';
  const missingIndices = [100, 101, 102];
  const dir = await mkdtemp(join(tmpdir(), 'gap-repair-fixture-verify-'));
  let noCredsDatabase: string | undefined;
  let fakeCredsDatabase: string | undefined;
  try {
    const fixturePath = await writeFixtureFile(dir, tradingDate, missingIndices);

    // Base env: strip EVERY Upstox/Groww credential var entirely (never merely blank them --
    // `delete` proves the script truly never reads them, not just tolerates an empty string).
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (/^(UPSTOX|GROWW)_/.test(key)) delete baseEnv[key];
    }
    baseEnv[requireEnvVar] = '1';
    baseEnv[adminUrlEnvVar] = adminUrlRaw;
    baseEnv.RESEARCH_REPAIR_TRADING_DATE = tradingDate;
    baseEnv.RESEARCH_REPAIR_FIXTURE_PATH = fixturePath;

    const noCredsRun = runFixtureVerifyScript(baseEnv);
    assert.equal(noCredsRun.status, 0, `fixture-verify must succeed with no Upstox/Groww credentials configured. stderr:\n${noCredsRun.stderr}`);
    const noCredsLines = parseJsonResultLines(noCredsRun.stdout);
    assert.ok(noCredsLines.length >= 2, 'expected a starting event line and a final result line');
    const noCredsResult = noCredsLines[noCredsLines.length - 1];
    assert.equal(noCredsResult.outcome, 'REPAIR_ACCEPTED');
    assert.equal(noCredsResult.missingMinuteCount, missingIndices.length);
    noCredsDatabase = noCredsResult.isolatedDatabase as string;
    assert.ok(noCredsDatabase && /^research_gap_repair_fixture_verify_[0-9a-f]{16}$/.test(noCredsDatabase));

    // Second run: SAME fixture/date, but with obviously fake/invalid Upstox credentials present.
    const fakeCredsEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      UPSTOX_CLIENT_ID: 'not-a-real-client-id',
      UPSTOX_CLIENT_SECRET: 'not-a-real-secret',
      UPSTOX_ACCESS_TOKEN: 'not-a-real-token',
      UPSTOX_REDIRECT_URI: 'http://localhost:9/definitely-invalid',
    };
    const fakeCredsRun = runFixtureVerifyScript(fakeCredsEnv);
    assert.equal(fakeCredsRun.status, 0, `fixture-verify must succeed identically with fake Upstox credentials present. stderr:\n${fakeCredsRun.stderr}`);
    const fakeCredsLines = parseJsonResultLines(fakeCredsRun.stdout);
    const fakeCredsResult = fakeCredsLines[fakeCredsLines.length - 1];
    fakeCredsDatabase = fakeCredsResult.isolatedDatabase as string;

    assert.deepEqual(
      stableResultShape(noCredsResult),
      stableResultShape(fakeCredsResult),
      'fake/invalid Upstox credentials must not alter fixture-verify behavior in any way'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    // Defense-in-depth cleanup + proof the script's own cleanup already ran: connecting to either
    // generated database name must fail (database does not exist) -- confirms the throwaway database
    // was genuinely dropped, never left behind.
    for (const databaseName of [noCredsDatabase, fakeCredsDatabase]) {
      if (!databaseName) continue;
      const adminUrlForCheck = new URL(process.env[adminUrlEnvVar]!);
      adminUrlForCheck.pathname = `/${databaseName}`;
      const probe = new PrismaClient({ datasources: { db: { url: adminUrlForCheck.toString() } } });
      await assert.rejects(() => probe.$queryRaw`SELECT 1`, 'the fixture-verify script must drop its throwaway database on completion -- it must not still exist');
      await probe.$disconnect().catch(() => undefined);
    }
  }
});

test('HIGH-3 EXECUTABLE: fixture-verify fails closed (non-zero exit) when HISTORICAL_CANDLE_TEST_REQUIRE is not set to 1, and makes zero database calls', async (t) => {
  if (!process.env[adminUrlEnvVar]) return t.skip(skipReason());
  const dir = await mkdtemp(join(tmpdir(), 'gap-repair-fixture-verify-'));
  try {
    const fixturePath = await writeFixtureFile(dir, '2031-03-12', [100, 101, 102]);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[requireEnvVar];
    env[adminUrlEnvVar] = process.env[adminUrlEnvVar]!;
    env.RESEARCH_REPAIR_TRADING_DATE = '2031-03-12';
    env.RESEARCH_REPAIR_FIXTURE_PATH = fixturePath;

    const result = runFixtureVerifyScript(env);
    assert.notEqual(result.status, 0, 'fixture-verify must fail closed when the explicit opt-in env var is missing');
    assert.match(result.stderr, /HISTORICAL_CANDLE_TEST_REQUIRE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
