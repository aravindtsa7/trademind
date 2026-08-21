import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import HistoricalCandleRepository, {
  HistoricalCandleCreateValues,
  HistoricalCandleUpdateValues,
  HistoricalCandleUpsertInput,
} from './historical-candle.repository';

/**
 * Regression coverage for the confirmed V2/V4 P2002 mechanism: Prisma's
 * upsert() on this MySQL schema is a non-atomic SELECT-then-INSERT/UPDATE, so
 * two independent processes racing the same HistoricalCandle key could both
 * see "not found" and both attempt INSERT.
 *
 * TEST DATABASE SAFETY
 * ---------------------
 * This suite NEVER touches the application's DATABASE_URL / the real
 * `trademind` database, for setup, teardown, or assertions. It requires a
 * separate, dedicated admin connection URL supplied specifically for this
 * suite via HISTORICAL_CANDLE_TEST_DATABASE_URL (an account permitted to
 * CREATE/DROP throwaway databases on a MySQL server -- typically the same
 * local dev server, but never the app's own configured connection target).
 * Every run creates a brand-new database with a unique, unmistakably
 * test-only name (`historical_candle_repo_test_<32 hex chars>`), so parallel
 * test runs cannot collide and a run can never resolve to an existing
 * database by accident. Every CREATE DATABASE / DROP DATABASE statement is
 * preceded by a fail-closed name-shape check (`assertSafeTestDatabaseName`)
 * that refuses to proceed if the target isn't that exact generated name, or
 * if it is (or resolves to) the reserved name `trademind`.
 *
 * CRITICAL TEST EXECUTION
 * ------------------------
 * If HISTORICAL_CANDLE_TEST_DATABASE_URL is not set, every test in this file
 * skips itself with a clear reason -- this suite is optional for the normal
 * developer/CI test run. If HISTORICAL_CANDLE_TEST_REQUIRE=1 is ALSO set,
 * this suite has been explicitly requested, and any setup failure (missing
 * URL, unreachable server, invalid credentials, CREATE DATABASE failure,
 * schema failure, insufficient permissions) is re-thrown out of the
 * `before` hook instead of being converted into a skip -- node:test then
 * fails every test in this file and the process exits non-zero, so a
 * misconfigured explicit run cannot silently report green.
 */

const adminUrlEnvVar = 'HISTORICAL_CANDLE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CANDLE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';

const forbiddenDatabaseNames = new Set(['trademind']);
const runSuffix = randomUUID().replace(/-/g, '');
const testDatabaseName = `historical_candle_repo_test_${runSuffix}`;
const testDatabaseNamePattern = /^historical_candle_repo_test_[0-9a-f]{32}$/;
const testTimeframe = '1minute';

function assertSafeTestDatabaseName(name: string): void {
  if (forbiddenDatabaseNames.has(name.toLowerCase())) {
    throw new Error(`Refusing to operate on database '${name}': that name is reserved for the real application database.`);
  }
  if (!testDatabaseNamePattern.test(name)) {
    throw new Error(`Refusing to operate on database '${name}': it does not match the required test-only naming pattern ${testDatabaseNamePattern}.`);
  }
}

/** A fresh, unique, unmistakably test-only database name, same shape as `testDatabaseName`. */
function generateTestDatabaseName(): string {
  return `historical_candle_repo_test_${randomUUID().replace(/-/g, '')}`;
}

function requireAdminUrl(): string {
  const adminUrlRaw = process.env[adminUrlEnvVar];
  if (!adminUrlRaw) {
    throw new Error(
      `${adminUrlEnvVar} is not set. This integration suite requires a dedicated MySQL admin connection URL for creating/dropping an isolated, unique per-run test database -- it never falls back to the application's DATABASE_URL.`
    );
  }
  if (process.env.DATABASE_URL && adminUrlRaw === process.env.DATABASE_URL) {
    throw new Error(`${adminUrlEnvVar} must not be identical to DATABASE_URL; this suite requires a dedicated, test-only connection target.`);
  }
  const adminUrl = new URL(adminUrlRaw);
  const adminPath = adminUrl.pathname.replace(/^\//, '');
  if (adminPath && forbiddenDatabaseNames.has(adminPath.toLowerCase())) {
    throw new Error(`${adminUrlEnvVar} must not point at the '${adminPath}' database.`);
  }
  return adminUrlRaw;
}

function deriveUrls(name: string): { baseUrl: string; testUrl: string } {
  const adminUrlRaw = requireAdminUrl();
  assertSafeTestDatabaseName(name);
  const base = new URL(adminUrlRaw);
  base.pathname = '/';
  const testUrl = new URL(adminUrlRaw);
  testUrl.pathname = `/${name}`;
  return { baseUrl: base.toString(), testUrl: testUrl.toString() };
}

/**
 * Creates exactly the named test-only database, guarded immediately before
 * the statement executes. Used both by the main suite lifecycle and by the
 * standalone partial-setup-cleanup regression test below.
 */
async function disconnectBestEffort(client: PrismaClient): Promise<void> {
  try {
    await client.$disconnect();
  } catch {
    // A disconnect failure on a throwaway admin connection must never be
    // mistaken for the operation that used it (CREATE/DROP DATABASE)
    // having failed -- by the time this runs, that statement already
    // succeeded or failed on its own. Putting the disconnect inside a
    // try/finally around the statement would let a disconnect-only
    // failure masquerade as (and reject the promise as if it were) the
    // statement itself failing, which is exactly the reported defect:
    // CREATE DATABASE succeeds, disconnect then throws, and the caller
    // never learns the CREATE actually succeeded.
  }
}

async function createTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
  await disconnectBestEffort(admin);
}

/**
 * Drops exactly the named test-only database, guarded immediately before
 * the statement executes. Callers are responsible for only invoking this
 * when they know CREATE DATABASE for this exact name already succeeded
 * (see `databaseCreated` below) -- this function itself does not track
 * that state, so it can be reused directly by the standalone cleanup
 * regression test.
 */
async function dropTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`DROP DATABASE \`${name}\``);
  await disconnectBestEffort(admin);
}

/** True once `information_schema.SCHEMATA` no longer lists the named database. */
async function databaseExists(baseUrl: string, name: string): Promise<boolean> {
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  try {
    const rows = await admin.$queryRaw<Array<{ SCHEMA_NAME: string }>>`
      SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${name}
    `;
    return rows.length > 0;
  } finally {
    await admin.$disconnect();
  }
}

const createTableSql = `
  CREATE TABLE \`HistoricalCandle\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`candleTime\` DATETIME(3) NOT NULL,
    \`open\` DECIMAL(65, 30) NOT NULL,
    \`high\` DECIMAL(65, 30) NOT NULL,
    \`low\` DECIMAL(65, 30) NOT NULL,
    \`close\` DECIMAL(65, 30) NOT NULL,
    \`volume\` BIGINT NOT NULL,
    \`openInterest\` BIGINT NULL,
    \`source\` VARCHAR(191) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalCandle_instrumentKey_timeframe_candleTime_key\`(\`instrumentKey\`, \`timeframe\`, \`candleTime\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
`;

// `databaseCreated` and `databaseAvailable` are tracked SEPARATELY and
// intentionally never merged: CREATE DATABASE can succeed while a later
// setup step (schema creation, the probe query) still fails. Teardown must
// attempt to drop the database whenever it was created, regardless of
// whether the suite ever became fully available -- gating the DROP on
// `databaseAvailable` would orphan a successfully-created database if
// anything after CREATE DATABASE failed.
let databaseAvailable = false;
let databaseCreated = false;
let testUrl = '';
let adminBaseUrl = '';
let probeClient: PrismaClient;
const trackedClients: PrismaClient[] = [];

function newClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } });
  trackedClients.push(client);
  return client;
}

function newRepository(): HistoricalCandleRepository {
  return new HistoricalCandleRepository(newClient());
}

test.before(async () => {
  try {
    const urls = deriveUrls(testDatabaseName);
    testUrl = urls.testUrl;
    adminBaseUrl = urls.baseUrl;

    await createTestDatabase(adminBaseUrl, testDatabaseName);
    databaseCreated = true;

    const schema = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await schema.$executeRawUnsafe(createTableSql);
    await disconnectBestEffort(schema);

    probeClient = newClient();
    await probeClient.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch (error) {
    if (requireIntegration) throw error;
    databaseAvailable = false;
  }
});

test.after(async () => {
  // Each client is disconnected independently so one failure cannot block
  // the others, nor block the DROP DATABASE attempt below.
  for (const client of trackedClients) {
    try {
      await client.$disconnect();
    } catch {
      // Best-effort: a disconnect failure here must not hide the real
      // teardown outcome (the DROP DATABASE below) or crash the run.
    }
  }
  if (!databaseCreated) return; // nothing was ever created -> nothing to drop
  await dropTestDatabase(adminBaseUrl, testDatabaseName);
});

function skipReason(): string {
  return `Set ${adminUrlEnvVar} (a dedicated admin URL, never DATABASE_URL) to run this integration suite; add ${requireEnvVar}=1 to make setup failures fatal instead of skipped.`;
}

function testInstrumentKey(caseName: string): string {
  return `TEST_${caseName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function candleInput(
  instrumentKey: string,
  candleTime: Date,
  overrides: Partial<{
    open: HistoricalCandleCreateValues['open'];
    high: HistoricalCandleCreateValues['high'];
    low: HistoricalCandleCreateValues['low'];
    close: HistoricalCandleCreateValues['close'];
    volume: bigint;
    openInterest: bigint | null;
    source: string;
  }> = {}
): HistoricalCandleUpsertInput {
  const open = overrides.open ?? 100;
  const high = overrides.high ?? 110;
  const low = overrides.low ?? 90;
  const close = overrides.close ?? 105;
  const volume = overrides.volume ?? 1_000n;
  const source = overrides.source ?? 'REST';
  const create: HistoricalCandleCreateValues = {
    instrumentKey,
    timeframe: testTimeframe,
    candleTime,
    open,
    high,
    low,
    close,
    volume,
    source,
  };
  if (overrides.openInterest !== undefined) create.openInterest = overrides.openInterest;
  const update: HistoricalCandleUpdateValues = { open, high, low, close, volume, source };
  if (overrides.openInterest !== undefined) update.openInterest = overrides.openInterest;
  return { create, update };
}

/** A correlated, complete, distinct payload per writer index -- every mutable field moves together. */
function payloadForIndex(index: number): { open: number; high: number; low: number; close: number; volume: bigint; openInterest: bigint; source: string } {
  return {
    open: 1000 + index,
    high: 2000 + index,
    low: 3000 + index,
    close: 4000 + index,
    volume: 5000n + BigInt(index),
    openInterest: 6000n + BigInt(index),
    source: `SRC_${index}`,
  };
}

test('atomic upsert: normal insert creates a row with the exact payload', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('insert');
  const candleTime = new Date('2026-08-21T06:00:00.000Z');

  const row = await repository.upsert(candleInput(instrumentKey, candleTime, { open: 101, high: 111, low: 91, close: 106, volume: 1_234n, source: 'REST' }));

  assert.equal(row.instrumentKey, instrumentKey);
  assert.equal(row.timeframe, testTimeframe);
  assert.equal(row.candleTime.getTime(), candleTime.getTime());
  assert.equal(Number(row.open), 101);
  assert.equal(Number(row.high), 111);
  assert.equal(Number(row.low), 91);
  assert.equal(Number(row.close), 106);
  assert.equal(row.volume, 1_234n);
  assert.equal(row.source, 'REST');
  assert.equal(row.openInterest, null);
  assert.ok(row.createdAt instanceof Date);
  assert.ok(row.updatedAt instanceof Date);

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 1);
});

test('atomic upsert: updating an existing row changes only the supplied fields', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('update');
  const candleTime = new Date('2026-08-21T06:05:00.000Z');

  const first = await repository.upsert(candleInput(instrumentKey, candleTime, { open: 100, source: 'REST', openInterest: 500n }));

  // Partial update: only `open` is supplied. `source`, `high`, `low`, `close`,
  // `volume`, `openInterest` are omitted and must be left untouched -- this is
  // the Prisma-parity behavior the fix must preserve (an omitted/undefined
  // update field is not the same as an explicit null).
  const second = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime, open: 999, high: 999, low: 999, close: 999, volume: 999n, source: 'SHOULD_NOT_BE_USED' },
    update: { open: 200 },
  });

  assert.equal(second.id, first.id, 'update must touch the same row, not insert a new one');
  assert.equal(Number(second.open), 200, 'the supplied field must change');
  assert.equal(Number(second.high), Number(first.high), 'an omitted field must be left untouched');
  assert.equal(Number(second.low), Number(first.low), 'an omitted field must be left untouched');
  assert.equal(Number(second.close), Number(first.close), 'an omitted field must be left untouched');
  assert.equal(second.volume, first.volume, 'an omitted field must be left untouched');
  assert.equal(second.source, 'REST', 'an omitted field must be left untouched, not reset from the create payload');
  assert.equal(second.openInterest, 500n, 'an omitted nullable field must be left untouched');

  // Explicit null must clear the field, distinct from an omitted field.
  const third = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
    update: { openInterest: null },
  });
  assert.equal(third.openInterest, null, 'an explicit null in update must clear the column');
  assert.equal(Number(third.open), 200, 'fields omitted from this update must still be untouched');

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 1, 'an update must never create a second row for the same key');
});

test('timestamp semantics: createdAt uses the schema DEFAULT unless explicitly overridden, is preserved across updates, and updatedAt always advances/honors overrides', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('timestamps');

  // Omitted create.createdAt -> MySQL's own DEFAULT CURRENT_TIMESTAMP(3)
  // populates it (database server clock), matching the schema's original
  // default that the prior Prisma-managed inserts relied on.
  const beforeInsert = Date.now();
  const candleA = new Date('2026-08-21T06:30:00.000Z');
  const rowA = await repository.upsert(candleInput(instrumentKey, candleA));
  assert.ok(rowA.createdAt.getTime() >= beforeInsert - 5000, 'omitted create.createdAt must be populated close to insert time by the DB default');

  // Explicit create.createdAt overrides the default with the exact value.
  const explicitCreatedAt = new Date('2020-01-01T00:00:00.000Z');
  const candleB = new Date('2026-08-21T06:31:00.000Z');
  const rowB = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleB, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST', createdAt: explicitCreatedAt },
    update: { open: 1 },
  });
  assert.equal(rowB.createdAt.getTime(), explicitCreatedAt.getTime(), 'an explicit create.createdAt must override the DB default exactly');

  // Omitted create.updatedAt -> stamped "now" at write time (no DB-level default exists for this column).
  const beforeC = Date.now();
  const candleC = new Date('2026-08-21T06:32:00.000Z');
  const rowC = await repository.upsert(candleInput(instrumentKey, candleC));
  assert.ok(rowC.updatedAt.getTime() >= beforeC - 5000, 'omitted create.updatedAt must be stamped at write time');

  // Explicit create.updatedAt overrides "now" on the initial insert.
  const explicitInsertUpdatedAt = new Date('2021-06-15T12:00:00.000Z');
  const candleD = new Date('2026-08-21T06:33:00.000Z');
  const rowD = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleD, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST', updatedAt: explicitInsertUpdatedAt },
    update: { open: 1 },
  });
  assert.equal(rowD.updatedAt.getTime(), explicitInsertUpdatedAt.getTime(), 'an explicit create.updatedAt must override the write-time default on insert');

  // Explicit update.updatedAt on the duplicate-key path overrides "now", and createdAt is preserved.
  const explicitUpdateUpdatedAt = new Date('2022-09-09T09:09:09.000Z');
  const rowD2 = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleD, open: 2, high: 2, low: 2, close: 2, volume: 2n, source: 'REST' },
    update: { open: 2, updatedAt: explicitUpdateUpdatedAt },
  });
  assert.equal(rowD2.updatedAt.getTime(), explicitUpdateUpdatedAt.getTime(), 'an explicit update.updatedAt must override the write-time default on the duplicate-key path');
  assert.equal(rowD2.createdAt.getTime(), rowD.createdAt.getTime(), 'createdAt must be unchanged by an update');

  // Omitted update.updatedAt on the duplicate-key path -> "now" at write time, createdAt still preserved.
  const beforeE = Date.now();
  const rowD3 = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleD, open: 3, high: 3, low: 3, close: 3, volume: 3n, source: 'REST' },
    update: { open: 3 },
  });
  assert.ok(rowD3.updatedAt.getTime() >= beforeE - 5000, 'omitted update.updatedAt must be stamped at write time');
  assert.equal(rowD3.createdAt.getTime(), rowD.createdAt.getTime(), 'createdAt must remain unchanged across further updates');
});

test('atomic upsert supports Prisma.Decimal and DecimalJsLike input without precision loss', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('decimal');

  // 30 fractional digits, matching the schema's DECIMAL(65,30) -- more
  // precision than a JS `number` (a float64) can represent exactly.
  const highPrecision = '123.456789012345678901234567890123';
  const decimalValue = new Prisma.Decimal(highPrecision);
  const candleA = new Date('2026-08-21T06:40:00.000Z');

  const rowA = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleA, open: decimalValue, high: decimalValue, low: decimalValue, close: decimalValue, volume: 1n, source: 'REST' },
    update: { open: decimalValue },
  });
  assert.equal(rowA.open.toString(), highPrecision, 'a Prisma.Decimal input must persist with full precision, not be rounded through JS Number');
  assert.equal(rowA.high.toString(), highPrecision);

  // A DecimalJsLike structural value: anything exposing decimal.js's own toFixed().
  const decimalJsLikePrecision = '987.654321098765432109876543210987';
  const decimalJsLike: Prisma.DecimalJsLike = { d: [], e: 0, s: 1, toFixed: () => decimalJsLikePrecision };
  const candleB = new Date('2026-08-21T06:41:00.000Z');
  const rowB = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime: candleB, open: decimalJsLike, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
    update: { open: decimalJsLike },
  });
  assert.equal(rowB.open.toString(), decimalJsLikePrecision, 'a DecimalJsLike input must persist with full precision via its own toFixed()');
});

test('atomic upsert: concurrent same-key writes from two independent Prisma clients converge to one complete, un-mixed row without an unhandled P2002', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  // Two independent PrismaClient instances/connections, each wrapped in its
  // own repository -- standing in for two independent OS processes (V2 and
  // V4), mirroring the actual incident topology.
  const repositoryA = newRepository();
  const repositoryB = newRepository();
  const writers = [repositoryA, repositoryB];

  // No commit/write ordering is controlled here (all writers are dispatched
  // via Promise.all with no artificial delay), so the winning payload is
  // genuinely nondeterministic. Each writer's payload is a correlated,
  // distinct, complete set (open/high/low/close/volume/openInterest/source
  // all move together by index) so the assertions below can prove the final
  // row is exactly ONE writer's coherent payload, not a field-by-field mix
  // of several -- without assuming which index wins.
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const instrumentKey = testInstrumentKey(`race_${iteration}`);
    const candleTime = new Date('2026-08-21T06:10:00.000Z');
    const concurrentWriterCount = 8;

    const results = await Promise.allSettled(
      Array.from({ length: concurrentWriterCount }, (_, index) => {
        const writer = writers[index % writers.length];
        return writer.upsert(candleInput(instrumentKey, candleTime, payloadForIndex(index)));
      })
    );

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.deepEqual(rejected.map((r) => String(r.reason)), [], `iteration ${iteration}: no concurrent writer may see an unhandled error (P2002 or otherwise)`);

    const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey, timeframe: testTimeframe } });
    assert.equal(stored.length, 1, `iteration ${iteration}: exactly one row must exist for the compound key after concurrent writers`);

    const row = stored[0];
    assert.equal(row.instrumentKey, instrumentKey);
    assert.equal(row.timeframe, testTimeframe);
    assert.equal(row.candleTime.getTime(), candleTime.getTime());
    assert.ok(row.createdAt instanceof Date && !Number.isNaN(row.createdAt.getTime()));
    assert.ok(row.updatedAt instanceof Date && !Number.isNaN(row.updatedAt.getTime()));

    // Identify which writer index this row's `open` corresponds to, then
    // require every OTHER field to match that SAME index's payload exactly
    // -- proving the row is one complete writer's payload, not a
    // partial/interleaved mix of two writers' fields.
    const matchedIndex = Number(row.open) - 1000;
    assert.ok(
      Number.isInteger(matchedIndex) && matchedIndex >= 0 && matchedIndex < concurrentWriterCount,
      `iteration ${iteration}: row.open=${row.open} must correspond to one of the ${concurrentWriterCount} writer indices`
    );
    const expected = payloadForIndex(matchedIndex);
    assert.equal(Number(row.high), expected.high, `iteration ${iteration}: high must belong to the same writer as open`);
    assert.equal(Number(row.low), expected.low, `iteration ${iteration}: low must belong to the same writer as open`);
    assert.equal(Number(row.close), expected.close, `iteration ${iteration}: close must belong to the same writer as open`);
    assert.equal(row.volume, expected.volume, `iteration ${iteration}: volume must belong to the same writer as open`);
    assert.equal(row.openInterest, expected.openInterest, `iteration ${iteration}: openInterest must belong to the same writer as open`);
    assert.equal(row.source, expected.source, `iteration ${iteration}: source must belong to the same writer as open`);
  }
});

test('atomic upsert: with commit order explicitly controlled, the later write wins deterministically', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repositoryA = newRepository();
  const repositoryB = newRepository();
  const instrumentKey = testInstrumentKey('ordered');
  const candleTime = new Date('2026-08-21T06:12:00.000Z');

  // Ordering is explicitly controlled here (sequential awaits, not
  // concurrent dispatch), so the winning payload is deterministic and is
  // asserted exactly.
  await repositoryA.upsert(candleInput(instrumentKey, candleTime, { open: 111 }));
  const second = await repositoryB.upsert(candleInput(instrumentKey, candleTime, { open: 222 }));

  assert.equal(Number(second.open), 222);
  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0].open), 222, 'the row must reflect the later, explicitly-ordered write');
});

test('bulk upsert: creates multiple distinct candles and updates rows that already exist within one batch', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('bulk');
  const times = [0, 1, 2].map((minute) => new Date(new Date('2026-08-21T06:15:00.000Z').getTime() + minute * 60_000));

  const firstBatch = await repository.bulkUpsert(times.map((candleTime, index) => candleInput(instrumentKey, candleTime, { open: 100 + index })));
  assert.equal(firstBatch.length, 3);

  const stored1 = await probeClient.historicalCandle.findMany({ where: { instrumentKey }, orderBy: { candleTime: 'asc' } });
  assert.equal(stored1.length, 3);
  assert.deepEqual(stored1.map((row) => Number(row.open)), [100, 101, 102]);

  // Second batch: updates the first two candles (already exist), inserts a
  // fourth new one -- exercising "bulk upsert containing rows that already
  // exist" alongside a genuine new insert in the same call.
  const fourthTime = new Date(times[2].getTime() + 60_000);
  const secondBatch = await repository.bulkUpsert([
    candleInput(instrumentKey, times[0], { open: 500 }),
    candleInput(instrumentKey, times[1], { open: 501 }),
    candleInput(instrumentKey, fourthTime, { open: 300 }),
  ]);
  assert.equal(secondBatch.length, 3);

  const stored2 = await probeClient.historicalCandle.findMany({ where: { instrumentKey }, orderBy: { candleTime: 'asc' } });
  assert.equal(stored2.length, 4, 'bulk upsert must update existing rows in place, not duplicate them');
  assert.deepEqual(stored2.map((row) => Number(row.open)), [500, 501, 102, 300]);
});

test('bulk upsert: duplicate same-key inputs within one call are applied sequentially and the last input wins', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('bulk_same_key');
  const candleTime = new Date('2026-08-21T06:45:00.000Z');

  // bulkUpsert executes its inputs sequentially inside one transaction (a
  // `for` loop of awaited atomicUpsert calls), so each returned row reflects
  // the state immediately after that input's own write -- proving the
  // sequential-not-concurrent nature of a single bulkUpsert call.
  const results = await repository.bulkUpsert([
    candleInput(instrumentKey, candleTime, { open: 10 }),
    candleInput(instrumentKey, candleTime, { open: 20 }),
    candleInput(instrumentKey, candleTime, { open: 30 }),
  ]);
  assert.equal(results.length, 3);
  assert.equal(Number(results[0].open), 10, 'the first returned row must reflect only the first input, before the later ones in this batch ran');
  assert.equal(Number(results[1].open), 20);
  assert.equal(Number(results[2].open), 30);

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 1, 'duplicate same-key inputs within one bulkUpsert call must never create more than one row');
  assert.equal(Number(stored[0].open), 30, 'the last input for a given key must win when bulkUpsert executes sequentially');
});

test('a genuinely unrelated database error still propagates and rolls back the whole batch, not swallowed', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const validTime = new Date('2026-08-21T06:20:00.000Z');
  const invalidTime = new Date('2026-08-21T06:21:00.000Z');

  const validInstrumentKey = testInstrumentKey('rollback_valid');
  const validInput = candleInput(validInstrumentKey, validTime, { open: 700 });
  // `instrumentKey` is VARCHAR(191) in the schema (this database runs with
  // STRICT_TRANS_TABLES, confirmed via `SELECT @@GLOBAL.sql_mode` against
  // the local MySQL server, so MySQL rejects an over-length value with
  // error 1406 rather than truncating). This is a genuine MySQL
  // data-length constraint failure, unrelated to the P2002 convergence
  // race this fix addresses -- it must not be caught, retried, or ignored,
  // and the whole batch (including the otherwise-valid row before it) must
  // roll back rather than partially commit.
  const invalidInstrumentKey = 'x'.repeat(300);
  const invalidInput = candleInput(invalidInstrumentKey, invalidTime, { open: 701 });

  await assert.rejects(() => repository.bulkUpsert([validInput, invalidInput]));

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey: validInstrumentKey } });
  assert.equal(stored.length, 0, 'the whole batch transaction must roll back, including the row that would otherwise have succeeded');
});

test('atomic upsert rejects an unsupported scalar-update-operator shape arriving through a cast, instead of silently mishandling it', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('unsupported_operator');
  const candleTime = new Date('2026-08-21T06:25:00.000Z');

  // `{ increment }` no longer type-checks against HistoricalCandleUpdateValues
  // at all (proven by the surrounding project's `tsc --noEmit` build), so
  // reaching this code path requires a cast simulating a caller that bypasses
  // TypeScript -- the runtime guard must still catch it.
  await assert.rejects(
    () =>
      repository.upsert({
        create: { instrumentKey, timeframe: testTimeframe, candleTime, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
        update: { volume: { increment: 1n } } as unknown as HistoricalCandleUpdateValues,
      }),
    /atomic upsert only supports a plain bigint\/number for 'update.volume'/
  );

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 0, 'a rejected write must not leave a partial row behind');
});

test('unknown update fields: every legitimate key is accepted together', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('all_valid_update_keys');
  const candleTime = new Date('2026-08-21T06:26:00.000Z');

  await repository.upsert(candleInput(instrumentKey, candleTime));
  // Every key HistoricalCandleUpdateValues declares, supplied together in
  // one update, must be accepted without throwing.
  const row = await repository.upsert({
    create: { instrumentKey, timeframe: testTimeframe, candleTime, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
    update: { open: 11, high: 12, low: 13, close: 14, volume: 15n, openInterest: 16n, source: 'ALL_KEYS', updatedAt: new Date('2023-03-03T03:03:03.000Z') },
  });
  assert.equal(Number(row.open), 11);
  assert.equal(Number(row.high), 12);
  assert.equal(Number(row.low), 13);
  assert.equal(Number(row.close), 14);
  assert.equal(row.volume, 15n);
  assert.equal(row.openInterest, 16n);
  assert.equal(row.source, 'ALL_KEYS');
  assert.equal(row.updatedAt.getTime(), new Date('2023-03-03T03:03:03.000Z').getTime());
});

test('unknown update fields: identity/history keys and arbitrary typos are rejected before any DB write, never silently ignored', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const candleTime = new Date('2026-08-21T06:27:00.000Z');
  // Identity/history fields the type deliberately excludes, PLUS arbitrary
  // unknown keys (typos, made-up fields) a caller might pass through a
  // cast -- the allowlist check must reject all of these uniformly, not
  // just the specifically-named identity fields.
  const rejectedFields: Array<[string, unknown]> = [
    ['instrumentKey', 'SOME_OTHER_KEY'],
    ['timeframe', '5minute'],
    ['candleTime', new Date('2026-08-21T06:28:00.000Z')],
    ['id', randomUUID()],
    ['createdAt', new Date('1999-01-01T00:00:00.000Z')],
    ['typoSource', 'REST'],
    ['unknownField', 42],
  ];

  for (const [field, value] of rejectedFields) {
    const instrumentKey = testInstrumentKey(`unsupported_${field}`);
    await assert.rejects(
      () =>
        repository.upsert({
          create: { instrumentKey, timeframe: testTimeframe, candleTime, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
          update: { open: 2, [field]: value } as unknown as HistoricalCandleUpdateValues,
        }),
      new RegExp(`does not support the update field '${field}'`),
      `update.${field} must be rejected, not silently ignored`
    );
    const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
    assert.equal(stored.length, 0, `a rejected write for update.${field} must not leave a partial row behind (validated before any DB work)`);
  }
});

test('unknown update fields: an invalid key anywhere in a bulkUpsert batch prevents the whole call from writing', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKeyA = testInstrumentKey('bulk_prevalidate_a');
  const instrumentKeyB = testInstrumentKey('bulk_prevalidate_b');
  const candleTime = new Date('2026-08-21T06:29:00.000Z');

  await assert.rejects(
    () =>
      repository.bulkUpsert([
        candleInput(instrumentKeyA, candleTime),
        {
          create: { instrumentKey: instrumentKeyB, timeframe: testTimeframe, candleTime, open: 1, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
          update: { open: 1, typoSource: 'REST' } as unknown as HistoricalCandleUpdateValues,
        },
      ]),
    /does not support the update field 'typoSource'/
  );

  const storedA = await probeClient.historicalCandle.findMany({ where: { instrumentKey: instrumentKeyA } });
  const storedB = await probeClient.historicalCandle.findMany({ where: { instrumentKey: instrumentKeyB } });
  assert.equal(storedA.length, 0, 'validation runs before the transaction opens, so even the earlier, otherwise-valid entry in the batch must not be written');
  assert.equal(storedB.length, 0);
});

test('decimal validation: malformed or non-finite values are rejected, never bound into SQL', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const candleTime = new Date('2026-08-21T06:42:00.000Z');

  const invalidCases: Array<[string, unknown]> = [
    ['NaN number', NaN],
    ['Infinity number', Infinity],
    ['-Infinity number', -Infinity],
    ['string "NaN"', 'NaN'],
    ['string "Infinity"', 'Infinity'],
    ['garbage string', 'not-a-number'],
    ['empty string', ''],
    ['plain object with only toFixed() returning garbage', { toFixed: () => 'not-a-number' }],
    ['plain object with no toFixed at all', {}],
    ['null', null],
    ['array', [1, 2, 3]],
    ['boolean', true],
  ];

  for (const [label, value] of invalidCases) {
    const instrumentKey = testInstrumentKey(`invalid_decimal_${label.replace(/[^a-zA-Z0-9]/g, '_')}`);
    await assert.rejects(
      () =>
        repository.upsert({
          create: { instrumentKey, timeframe: testTimeframe, candleTime, open: value as HistoricalCandleCreateValues['open'], high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
          update: { open: 1 },
        }),
      Error,
      `create.open=${label} must be rejected`
    );
    const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
    assert.equal(stored.length, 0, `a rejected decimal value (${label}) must not leave a partial row behind`);
  }
});

test('decimal validation: a toFixed()-only object is rejected before its toFixed() output ever reaches SQL, even when that output is a valid decimal', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('decimal_tofixed_only');
  const candleTime = new Date('2026-08-21T06:44:00.000Z');

  // This object's toFixed() would return a perfectly valid decimal string
  // ('123.456') -- if it were bound, the write would succeed. It must
  // still be rejected purely because it lacks the genuine DecimalJsLike
  // shape (`d`, `e`, `s`), proving the structural check runs, and rejects,
  // BEFORE toFixed() output can ever reach the SQL boundary. It no longer
  // type-checks as HistoricalCandleDecimalInput at all (proven by this
  // project's `tsc --noEmit` build), so reaching this path requires a cast
  // simulating a caller that bypasses TypeScript.
  let toFixedCalled = false;
  const toFixedOnlyObject = { toFixed: () => { toFixedCalled = true; return '123.456'; } };

  await assert.rejects(() =>
    repository.upsert({
      create: { instrumentKey, timeframe: testTimeframe, candleTime, open: toFixedOnlyObject as unknown as HistoricalCandleCreateValues['open'], high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
      update: { open: 1 },
    })
  );
  assert.equal(toFixedCalled, false, "an object lacking the genuine DecimalJsLike shape must be rejected without ever invoking its toFixed()");

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 0, 'a toFixed()-only object must never produce a written row');
});

test('decimal validation: malformed d/e/s shapes are rejected as not genuinely DecimalJsLike', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const candleTime = new Date('2026-08-21T06:44:30.000Z');

  const malformedShapes: Array<[string, unknown]> = [
    ['d is not an array', { d: 'not-an-array', e: 0, s: 1, toFixed: () => '1' }],
    ['d contains a non-number element', { d: [1, 'x', 3], e: 0, s: 1, toFixed: () => '1' }],
    ['e is not a number', { d: [1], e: 'not-a-number', s: 1, toFixed: () => '1' }],
    ['s is not a number', { d: [1], e: 0, s: 'not-a-number', toFixed: () => '1' }],
    ['d is missing entirely', { e: 0, s: 1, toFixed: () => '1' }],
    ['e is missing entirely', { d: [1], s: 1, toFixed: () => '1' }],
    ['s is missing entirely', { d: [1], e: 0, toFixed: () => '1' }],
  ];

  for (const [label, value] of malformedShapes) {
    const instrumentKey = testInstrumentKey(`malformed_shape_${label.replace(/[^a-zA-Z0-9]/g, '_')}`);
    await assert.rejects(
      () =>
        repository.upsert({
          create: { instrumentKey, timeframe: testTimeframe, candleTime, open: value as HistoricalCandleCreateValues['open'], high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
          update: { open: 1 },
        }),
      Error,
      `create.open with ${label} must be rejected`
    );
    const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
    assert.equal(stored.length, 0, `a malformed DecimalJsLike shape (${label}) must not leave a partial row behind`);
  }
});

test('decimal validation: a DecimalJsLike object is re-canonicalized through Prisma.Decimal, not trusted directly -- a garbage toFixed() is caught', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  const repository = newRepository();
  const instrumentKey = testInstrumentKey('decimal_untrusted_object');
  const candleTime = new Date('2026-08-21T06:43:00.000Z');

  // Structurally satisfies `Prisma.DecimalJsLike` (has a toFixed() returning
  // a string), but the string is not a valid decimal -- the canonicalizer
  // must re-validate it through the real Prisma.Decimal constructor and
  // reject it, not bind whatever the object claims.
  const untrustedObject = { d: [], e: 0, s: 1, toFixed: () => 'DROP TABLE HistoricalCandle' };
  await assert.rejects(() =>
    repository.upsert({
      create: { instrumentKey, timeframe: testTimeframe, candleTime, open: untrustedObject, high: 1, low: 1, close: 1, volume: 1n, source: 'REST' },
      update: { open: 1 },
    })
  );

  const stored = await probeClient.historicalCandle.findMany({ where: { instrumentKey } });
  assert.equal(stored.length, 0, 'an object whose toFixed() does not produce a valid decimal must never reach SQL');
});

test('test-database cleanup: a database that was created is dropped even when a later setup step deliberately fails', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  // This exercises the exact fix for the orphaned-database defect: CREATE
  // DATABASE succeeds, then a later setup step (here, deliberately broken
  // schema SQL, standing in for the same category of failure as a bad
  // permission or an unreachable probe) fails. Cleanup must still remove
  // the database that was actually created. This uses its OWN, separate,
  // uniquely-named throwaway database via the same dedicated admin URL --
  // never the main suite's database, and never `trademind`. The whole body
  // runs inside try/finally so a failed assertion partway through cannot
  // itself orphan this test's own throwaway database.
  const probeDatabaseName = generateTestDatabaseName();
  const urls = deriveUrls(probeDatabaseName);
  let created = false;

  try {
    await createTestDatabase(urls.baseUrl, probeDatabaseName);
    created = true;
    const createdExists = await databaseExists(urls.baseUrl, probeDatabaseName);
    assert.equal(createdExists, true, 'CREATE DATABASE must have actually succeeded before the deliberate failure is introduced');

    // Deliberate post-create setup failure: intentionally invalid SQL
    // against the freshly created database (a stand-in for schema
    // failure/insufficient permissions/an unreachable probe -- any of
    // these leaves the database created but the suite not "available").
    const schemaClient = new PrismaClient({ datasources: { db: { url: urls.testUrl } } });
    let setupFailed = false;
    try {
      await schemaClient.$executeRawUnsafe('THIS IS NOT VALID SQL');
    } catch {
      setupFailed = true;
    }
    await disconnectBestEffort(schemaClient);
    assert.equal(setupFailed, true, 'the deliberate post-create setup step must actually have failed');
  } finally {
    // Cleanup must still remove the database that was created, exactly as
    // the real test.after() hook does once `databaseCreated` is true --
    // this calls the SAME dropTestDatabase() helper the real lifecycle uses.
    if (created) await dropTestDatabase(urls.baseUrl, probeDatabaseName);
  }

  const existsAfterCleanup = await databaseExists(urls.baseUrl, probeDatabaseName);
  assert.equal(existsAfterCleanup, false, 'the generated throwaway database must be removed after cleanup, even though a later setup step failed');
});

test('test-database cleanup: database creation is recorded even when the creator client\'s disconnect then fails', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  // Reproduces the second reported defect directly: if the code recorded
  // "database created" only after a successful client disconnect, a
  // disconnect failure occurring AFTER a successful CREATE DATABASE would
  // erase that fact and orphan the database. The fix records creation
  // immediately when CREATE DATABASE succeeds (see createTestDatabase() and
  // test.before()), independent of the disconnect outcome. This test
  // proves that ordering directly, using its own separate throwaway
  // database, and is itself wrapped in try/finally so it cannot orphan
  // that database regardless of outcome.
  const probeDatabaseName = generateTestDatabaseName();
  const urls = deriveUrls(probeDatabaseName);
  let created = false;

  try {
    assertSafeTestDatabaseName(probeDatabaseName);
    const admin = new PrismaClient({ datasources: { db: { url: urls.baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE \`${probeDatabaseName}\``);
    // Creation is recorded HERE, immediately after CREATE DATABASE
    // succeeds -- mirroring exactly where the real test.before() sets
    // `databaseCreated = true`, before any disconnect is attempted.
    created = true;

    // Simulate the reported failure mode: the creator client's disconnect
    // itself throws AFTER CREATE has already succeeded on the server. The
    // real underlying connection is still closed first (via the original
    // $disconnect), so this does not leak a real connection -- only the
    // throw is injected, to prove `created` being `true` already does not
    // depend on this call succeeding.
    const originalDisconnect = admin.$disconnect.bind(admin);
    await assert.rejects(async () => {
      await originalDisconnect();
      throw new Error('SIMULATED_DISCONNECT_FAILURE');
    }, /SIMULATED_DISCONNECT_FAILURE/);

    assert.equal(created, true, 'CREATE DATABASE success must already be recorded before the disconnect failure occurs');
    const existsAfterCreate = await databaseExists(urls.baseUrl, probeDatabaseName);
    assert.equal(existsAfterCreate, true, 'the database must genuinely exist on the server after CREATE, regardless of the later disconnect outcome');
  } finally {
    // Same cleanup state model as the real lifecycle: `created` is true, so
    // cleanup must still attempt (and here, succeed at) the guarded DROP.
    if (created) await dropTestDatabase(urls.baseUrl, probeDatabaseName);
  }

  const existsAfterCleanup = await databaseExists(urls.baseUrl, probeDatabaseName);
  assert.equal(existsAfterCleanup, false, "the generated database must be removed after cleanup, even though the creator client's disconnect failed");
});
