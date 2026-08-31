import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import HistoricalCandleResearchPersistenceService from './historical-candle-research-persistence.service';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * B-F2C invariants 8/9 (session atomicity, concurrency safety) --
 * DEDICATED, ISOLATED test database only, following the EXACT same
 * convention already established by
 * `historical-candle.repository.test.ts`: this suite NEVER touches the
 * application's `DATABASE_URL` / the real `trademind` database, reuses the
 * SAME dedicated admin URL env var (`HISTORICAL_CANDLE_TEST_DATABASE_URL`,
 * with `HISTORICAL_CANDLE_TEST_REQUIRE=1` to make setup failures fatal
 * instead of skipped), and creates its own uniquely-named throwaway
 * database (`research_persistence_test_<32 hex chars>`), guarded by the
 * same fail-closed name-shape checks.
 *
 * If this env var is not configured, EVERY test below skips itself with a
 * clear reason -- this suite is optional for the normal developer/CI run,
 * exactly like its sibling. It must NEVER be run against the normal/shared
 * database.
 */

const adminUrlEnvVar = 'HISTORICAL_CANDLE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CANDLE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';

const forbiddenDatabaseNames = new Set(['trademind']);
const runSuffix = randomUUID().replace(/-/g, '');
const testDatabaseName = `research_persistence_test_${runSuffix}`;
const testDatabaseNamePattern = /^research_persistence_test_[0-9a-f]{32}$/;
const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';

function assertSafeTestDatabaseName(name: string): void {
  if (forbiddenDatabaseNames.has(name.toLowerCase())) {
    throw new Error(`Refusing to operate on database '${name}': that name is reserved for the real application database.`);
  }
  if (!testDatabaseNamePattern.test(name)) {
    throw new Error(`Refusing to operate on database '${name}': it does not match the required test-only naming pattern ${testDatabaseNamePattern}.`);
  }
}

function requireAdminUrl(): string {
  const adminUrlRaw = process.env[adminUrlEnvVar];
  if (!adminUrlRaw) {
    throw new Error(`${adminUrlEnvVar} is not set. This integration suite requires a dedicated MySQL admin connection URL -- it never falls back to the application's DATABASE_URL.`);
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

async function disconnectBestEffort(client: PrismaClient): Promise<void> {
  try {
    await client.$disconnect();
  } catch {
    // A disconnect failure on a throwaway admin connection must never be mistaken for the statement itself failing.
  }
}

async function createTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
  await disconnectBestEffort(admin);
}

async function dropTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`DROP DATABASE \`${name}\``);
  await disconnectBestEffort(admin);
}

// Matches prisma/schema.prisma's HistoricalCandle model + the 3 B-F2C models exactly (see
// prisma/migrations/20260831090000_add_historical_data_retrieval_evidence/migration.sql).
const createTablesSql = `
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

  CREATE TABLE \`HistoricalDataRetrieval\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`providerId\` VARCHAR(191) NOT NULL,
    \`assetType\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`requestedFromDate\` VARCHAR(191) NOT NULL,
    \`requestedToDate\` VARCHAR(191) NOT NULL,
    \`status\` VARCHAR(191) NOT NULL,
    \`startedAt\` DATETIME(3) NOT NULL,
    \`completedAt\` DATETIME(3) NULL,
    \`providerCallAttempts\` INTEGER NOT NULL DEFAULT 0,
    \`sourceRowCount\` INTEGER NULL,
    \`sourceRowsSemanticChecksum\` VARCHAR(191) NULL,
    \`errorCategory\` VARCHAR(191) NULL,
    \`errorCode\` VARCHAR(191) NULL,
    \`errorMessage\` VARCHAR(191) NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalDataRetrievalSession\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`retrievalId\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`tradingDate\` VARCHAR(191) NOT NULL,
    \`calendarDisposition\` VARCHAR(191) NOT NULL,
    \`expectedMinuteCount\` INTEGER NOT NULL,
    \`providerRowCountForDate\` INTEGER NOT NULL,
    \`acceptedRowCount\` INTEGER NOT NULL,
    \`excludedRowCount\` INTEGER NOT NULL,
    \`sourceOrderAnomalyCount\` INTEGER NOT NULL,
    \`healthStatus\` VARCHAR(191) NOT NULL,
    \`persistenceOutcome\` VARCHAR(191) NOT NULL,
    \`sourceRowsSemanticChecksum\` VARCHAR(191) NULL,
    \`canonicalContentChecksum\` VARCHAR(191) NULL,
    \`evidenceSemanticChecksum\` VARCHAR(191) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalDataRetrievalSession_retrievalId_tradingDate_key\`(\`retrievalId\`, \`tradingDate\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleConflict\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`retrievalSessionId\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`candleTime\` DATETIME(3) NOT NULL,
    \`existingOpen\` DECIMAL(65, 30) NOT NULL,
    \`existingHigh\` DECIMAL(65, 30) NOT NULL,
    \`existingLow\` DECIMAL(65, 30) NOT NULL,
    \`existingClose\` DECIMAL(65, 30) NOT NULL,
    \`existingVolume\` BIGINT NOT NULL,
    \`existingOpenInterest\` BIGINT NULL,
    \`incomingOpen\` DECIMAL(65, 30) NOT NULL,
    \`incomingHigh\` DECIMAL(65, 30) NOT NULL,
    \`incomingLow\` DECIMAL(65, 30) NOT NULL,
    \`incomingClose\` DECIMAL(65, 30) NOT NULL,
    \`incomingVolume\` BIGINT NOT NULL,
    \`incomingOpenInterest\` BIGINT NULL,
    \`existingContentChecksum\` VARCHAR(191) NOT NULL,
    \`incomingContentChecksum\` VARCHAR(191) NOT NULL,
    \`detectedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  ALTER TABLE \`HistoricalDataRetrievalSession\` ADD CONSTRAINT \`HistoricalDataRetrievalSession_retrievalId_fkey\` FOREIGN KEY (\`retrievalId\`) REFERENCES \`HistoricalDataRetrieval\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleConflict\` ADD CONSTRAINT \`HistoricalCandleConflict_retrievalSessionId_fkey\` FOREIGN KEY (\`retrievalSessionId\`) REFERENCES \`HistoricalDataRetrievalSession\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
`;

let databaseAvailable = false;
let databaseCreated = false;
let testUrl = '';
let adminBaseUrl = '';
const trackedClients: PrismaClient[] = [];

function newClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } });
  trackedClients.push(client);
  return client;
}

function newPersistenceService(): HistoricalCandleResearchPersistenceService {
  return new HistoricalCandleResearchPersistenceService(newClient());
}

test.before(async () => {
  try {
    const urls = deriveUrls(testDatabaseName);
    testUrl = urls.testUrl;
    adminBaseUrl = urls.baseUrl;

    await createTestDatabase(adminBaseUrl, testDatabaseName);
    databaseCreated = true;

    const schema = new PrismaClient({ datasources: { db: { url: testUrl } } });
    for (const statement of createTablesSql.split(';').map((s) => s.trim()).filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop -- DDL statements must run in order
      await schema.$executeRawUnsafe(statement);
    }
    await disconnectBestEffort(schema);

    const probe = newClient();
    await probe.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch (error) {
    if (requireIntegration) throw error;
    databaseAvailable = false;
  }
});

test.after(async () => {
  for (const client of trackedClients) {
    try {
      await client.$disconnect();
    } catch {
      // best-effort
    }
  }
  if (!databaseCreated) return;
  await dropTestDatabase(adminBaseUrl, testDatabaseName);
});

function skipReason(): string {
  return `Set ${adminUrlEnvVar} (a dedicated admin URL, never DATABASE_URL) to run this integration suite; add ${requireEnvVar}=1 to make setup failures fatal instead of skipped.`;
}

function uniqueInstrumentKey(): string {
  return `${INSTRUMENT_KEY}_TEST_${randomUUID()}`;
}

function candidate(candleTime: Date, instrumentKey: string, overrides: Partial<CanonicalHistoricalCandle> = {}): CanonicalHistoricalCandle {
  return {
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey,
    candleTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function metadataFor(instrumentKey: string, retrievalId: string, from: Date, to: Date) {
  return {
    retrievalId,
    providerId: HistoricalProviderId.UPSTOX,
    instrumentKey,
    timeframe: TIMEFRAME,
    tradingDate: '2024-01-19',
    calendarDisposition: 'REGULAR_TRADING_DAY',
    expectedMinuteCount: 2,
    providerRowCountForDate: 2,
    healthStatus: DatasetHealthStatus.HEALTHY,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    sourceRowsSemanticChecksum: 'test-checksum',
    from,
    to,
  };
}

async function seedFakeRetrieval(client: PrismaClient, instrumentKey: string): Promise<string> {
  const retrieval = await client.historicalDataRetrieval.create({
    data: {
      providerId: HistoricalProviderId.UPSTOX,
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey,
      timeframe: TIMEFRAME,
      requestedFromDate: '2024-01-19',
      requestedToDate: '2024-01-19',
      status: 'STARTED',
      startedAt: new Date(),
    },
  });
  return retrieval.id;
}

test('B-F2C integration: NEW SESSION -- persistSession inserts missing rows and writes ACCEPTED_NEW evidence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const instrumentKey = uniqueInstrumentKey();
  const admin = newClient();
  const retrievalId = await seedFakeRetrieval(admin, instrumentKey);
  const service = newPersistenceService();

  const from = new Date('2024-01-19T00:00:00+05:30');
  const to = new Date('2024-01-19T23:59:59.999+05:30');
  const t0 = new Date('2024-01-19T09:15:00+05:30');
  const t1 = new Date('2024-01-19T09:16:00+05:30');

  const result = await service.persistSession(metadataFor(instrumentKey, retrievalId, from, to), [candidate(t0, instrumentKey), candidate(t1, instrumentKey)]);

  assert.equal(result.outcome, 'ACCEPTED_NEW');
  assert.equal(result.insertedCount, 2);
  assert.equal(result.idempotentCount, 0);

  const rows = await admin.$queryRaw<{ candleTime: Date }[]>`SELECT \`candleTime\` FROM \`HistoricalCandle\` WHERE \`instrumentKey\` = ${instrumentKey}`;
  assert.equal(rows.length, 2);

  const sessionEvidence = await admin.historicalDataRetrievalSession.findUnique({ where: { id: result.sessionEvidenceId } });
  assert.equal(sessionEvidence?.persistenceOutcome, 'ACCEPTED_NEW');
});

test('B-F2C integration: IDENTICAL RE-DOWNLOAD -- zero HistoricalCandle mutation, updatedAt unchanged, ACCEPTED_IDEMPOTENT', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const instrumentKey = uniqueInstrumentKey();
  const admin = newClient();
  const service = newPersistenceService();
  const from = new Date('2024-01-19T00:00:00+05:30');
  const to = new Date('2024-01-19T23:59:59.999+05:30');
  const t0 = new Date('2024-01-19T09:15:00+05:30');

  const retrievalId1 = await seedFakeRetrieval(admin, instrumentKey);
  await service.persistSession(metadataFor(instrumentKey, retrievalId1, from, to), [candidate(t0, instrumentKey)]);
  const firstRow = await admin.historicalCandle.findFirstOrThrow({ where: { instrumentKey } });

  await new Promise((resolve) => setTimeout(resolve, 1100)); // ensure updatedAt would visibly change (DATETIME(3) granularity) if mutated

  const retrievalId2 = await seedFakeRetrieval(admin, instrumentKey);
  const result = await service.persistSession(metadataFor(instrumentKey, retrievalId2, from, to), [candidate(t0, instrumentKey)]);

  assert.equal(result.outcome, 'ACCEPTED_IDEMPOTENT');
  assert.equal(result.insertedCount, 0);
  assert.equal(result.idempotentCount, 1);

  const secondRow = await admin.historicalCandle.findFirstOrThrow({ where: { instrumentKey } });
  assert.equal(secondRow.id, firstRow.id);
  assert.equal(secondRow.updatedAt.getTime(), firstRow.updatedAt.getTime(), 'an idempotent equivalent re-download must never touch updatedAt');
  assert.equal(secondRow.source, firstRow.source, 'an idempotent equivalent re-download must never relabel source');
});

test('B-F2C integration: CONFLICT + SESSION ATOMICITY -- existing content is left byte-for-byte unchanged, the other (missing) minute in the same session is NOT partially inserted, and conflict evidence is written', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const instrumentKey = uniqueInstrumentKey();
  const admin = newClient();
  const service = newPersistenceService();
  const from = new Date('2024-01-19T00:00:00+05:30');
  const to = new Date('2024-01-19T23:59:59.999+05:30');
  const t0 = new Date('2024-01-19T09:15:00+05:30');
  const t1 = new Date('2024-01-19T09:16:00+05:30');

  const retrievalId1 = await seedFakeRetrieval(admin, instrumentKey);
  await service.persistSession(metadataFor(instrumentKey, retrievalId1, from, to), [candidate(t0, instrumentKey, { close: 100.5 })]);
  const original = await admin.historicalCandle.findFirstOrThrow({ where: { instrumentKey, candleTime: t0 } });

  const retrievalId2 = await seedFakeRetrieval(admin, instrumentKey);
  const result = await service.persistSession(metadataFor(instrumentKey, retrievalId2, from, to), [
    candidate(t0, instrumentKey, { close: 999 }), // conflicts with the original
    candidate(t1, instrumentKey), // would otherwise be a genuinely new, independent minute
  ]);

  assert.equal(result.outcome, 'CONFLICT');
  assert.equal(result.conflicts.length, 1);

  const afterExisting = await admin.historicalCandle.findFirstOrThrow({ where: { instrumentKey, candleTime: t0 } });
  assert.equal(afterExisting.close.toString(), original.close.toString(), 'existing candle content must remain byte-for-byte unchanged on conflict');
  assert.equal(afterExisting.updatedAt.getTime(), original.updatedAt.getTime());

  const t1Row = await admin.historicalCandle.findFirst({ where: { instrumentKey, candleTime: t1 } });
  assert.equal(t1Row, null, 'session atomicity: the OTHER, non-conflicting minute must NOT be partially inserted');

  const conflictRows = await admin.historicalCandleConflict.findMany({ where: { retrievalSessionId: result.sessionEvidenceId } });
  assert.equal(conflictRows.length, 1);
  assert.equal(conflictRows[0].incomingClose.toString(), '999');
});

test('B-F2C integration CONCURRENCY: two concurrent persistSession calls for the SAME key with IDENTICAL content converge without a false conflict or a duplicate-key crash', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const instrumentKey = uniqueInstrumentKey();
  const admin = newClient();
  const from = new Date('2024-01-19T00:00:00+05:30');
  const to = new Date('2024-01-19T23:59:59.999+05:30');
  const t0 = new Date('2024-01-19T09:15:00+05:30');

  const serviceA = newPersistenceService();
  const serviceB = newPersistenceService();
  const retrievalIdA = await seedFakeRetrieval(admin, instrumentKey);
  const retrievalIdB = await seedFakeRetrieval(admin, instrumentKey);

  const [resultA, resultB] = await Promise.all([
    serviceA.persistSession(metadataFor(instrumentKey, retrievalIdA, from, to), [candidate(t0, instrumentKey)]),
    serviceB.persistSession(metadataFor(instrumentKey, retrievalIdB, from, to), [candidate(t0, instrumentKey)]),
  ]);

  // Exactly one writer inserts; the other, serialized behind it by the SERIALIZABLE range lock, sees the
  // committed row and resolves idempotent -- never a P2002/duplicate-key crash, never two rows for one key.
  const outcomes = [resultA.outcome, resultB.outcome].sort();
  assert.deepEqual(outcomes, ['ACCEPTED_IDEMPOTENT', 'ACCEPTED_NEW']);

  const rows = await admin.$queryRaw<{ id: string }[]>`SELECT \`id\` FROM \`HistoricalCandle\` WHERE \`instrumentKey\` = ${instrumentKey} AND \`candleTime\` = ${t0}`;
  assert.equal(rows.length, 1, 'exactly one physical row must exist for this logical key, regardless of the race');

  // FIX-2: even if one side's SERIALIZABLE transaction hit an InnoDB deadlock and was internally
  // retried (whole-transaction, from scratch), the retried/rolled-back attempt must leave ZERO durable
  // trace -- exactly one session-evidence row per logical retrieval attempt, never a duplicate.
  const sessionEvidenceRows = await admin.historicalDataRetrievalSession.findMany({ where: { retrievalId: { in: [retrievalIdA, retrievalIdB] } } });
  assert.equal(sessionEvidenceRows.length, 2, 'exactly one durable session-evidence row per retrieval attempt -- a rolled-back deadlock attempt must never leave a duplicate/orphaned row');
  assert.deepEqual([...sessionEvidenceRows].map((r) => r.persistenceOutcome).sort(), ['ACCEPTED_IDEMPOTENT', 'ACCEPTED_NEW']);
});

test('B-F2C integration CONCURRENCY: two concurrent persistSession calls for the SAME key with DIFFERENT content never last-write-win -- accepted history stays one immutable version, the loser reports CONFLICT', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const instrumentKey = uniqueInstrumentKey();
  const admin = newClient();
  const from = new Date('2024-01-19T00:00:00+05:30');
  const to = new Date('2024-01-19T23:59:59.999+05:30');
  const t0 = new Date('2024-01-19T09:15:00+05:30');

  const serviceA = newPersistenceService();
  const serviceB = newPersistenceService();
  const retrievalIdA = await seedFakeRetrieval(admin, instrumentKey);
  const retrievalIdB = await seedFakeRetrieval(admin, instrumentKey);

  const [resultA, resultB] = await Promise.all([
    serviceA.persistSession(metadataFor(instrumentKey, retrievalIdA, from, to), [candidate(t0, instrumentKey, { close: 111 })]),
    serviceB.persistSession(metadataFor(instrumentKey, retrievalIdB, from, to), [candidate(t0, instrumentKey, { close: 222 })]),
  ]);

  // Whichever transaction's SELECT ... FOR UPDATE commits first inserts (ACCEPTED_NEW); the other, unblocked
  // only after the first commits, sees DIFFERENT content than its own candidate and must report CONFLICT --
  // never silently overwrite, never both report ACCEPTED_NEW.
  const outcomes = [resultA.outcome, resultB.outcome].sort();
  assert.deepEqual(outcomes, ['ACCEPTED_NEW', 'CONFLICT']);

  const rows = await admin.$queryRaw<{ close: Prisma.Decimal }[]>`SELECT \`close\` FROM \`HistoricalCandle\` WHERE \`instrumentKey\` = ${instrumentKey} AND \`candleTime\` = ${t0}`;
  assert.equal(rows.length, 1, 'accepted history remains exactly one immutable version, never a mix/overwrite');
  const winningClose = rows[0].close.toString();
  assert.ok(winningClose === '111' || winningClose === '222');

  const loser = resultA.outcome === 'CONFLICT' ? resultA : resultB;
  assert.equal(loser.outcome, 'CONFLICT');
  assert.equal(loser.conflicts.length, 1);
  // The loser's reported "existing" snapshot must match whatever actually won and committed to the
  // database -- proving the conflict evidence itself is truthful, not just that SOME conflict was reported.
  assert.equal(loser.conflicts[0].existing.close, winningClose);

  // FIX-2: this is the exact scenario that originally deadlocked (MySQL 1213) and was internally
  // retried -- prove the retried/rolled-back attempt left ZERO durable trace: exactly one
  // session-evidence row per logical retrieval attempt (never a duplicate ACCEPTED/CONFLICT row from
  // an aborted try), and exactly one conflict-evidence row overall (never an orphaned row from a
  // rolled-back attempt).
  const sessionEvidenceRows = await admin.historicalDataRetrievalSession.findMany({ where: { retrievalId: { in: [retrievalIdA, retrievalIdB] } } });
  assert.equal(sessionEvidenceRows.length, 2, 'exactly one durable session-evidence row per retrieval attempt, even though a deadlock forced an internal whole-transaction retry');
  assert.deepEqual([...sessionEvidenceRows].map((r) => r.persistenceOutcome).sort(), ['ACCEPTED_NEW', 'CONFLICT']);

  const conflictRowCount = await admin.historicalCandleConflict.count({ where: { retrievalSessionId: { in: sessionEvidenceRows.map((r) => r.id) } } });
  assert.equal(conflictRowCount, 1, 'exactly one conflict-evidence row must exist -- a rolled-back deadlock attempt must never leave orphaned conflict evidence');
});
