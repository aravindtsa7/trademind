import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import HistoricalDataRetrievalEvidenceService from './services/historical-data-retrieval-evidence.service';
import { SourceAcquisitionProvenanceComposition } from './domain';

/**
 * BLOCKER 1 / BLOCKER 1B (post-Terra-review correction): applies the REAL,
 * ON-DISK B-F2D migration chain -- never a hand-rolled equivalent schema --
 * against a fresh, isolated, throwaway MySQL database, in chronological
 * order:
 *
 *   20260831090000_add_historical_data_retrieval_evidence  (B-F2C)
 *   20260831171125_add_historical_candle_repair_evidence   (migration #1, already applied to the shared dev DB -- read-only here, never edited)
 *   20260831174417_add_historical_candle_repair_contribution_provenance (corrected migration #2)
 *
 * Proves, as EXECUTABLE facts:
 *  - the chain applies cleanly end to end, in order, from the literal SQL files;
 *  - migration #2's ALTER TABLE targets the EXACT table migration #1 created
 *    (`HistoricalCandleRepairEvidence`, not `historicalcandlerepairevidence`)
 *    -- this local MySQL runs with `lower_case_table_names=1` (confirmed via
 *    `SHOW VARIABLES`), which tolerates a case mismatch, so this alone does
 *    NOT reproduce the case-sensitive Linux production failure; see the
 *    companion STRUCTURAL test below (`migration #2's SQL text...`), which
 *    proves the correct-case identifier by construction, independent of any
 *    single server's collation configuration;
 *  - migration #2 is safe whether migration #1's table is EMPTY or already
 *    contains a legacy row written before migration #2's columns existed
 *    (BLOCKER 1B) -- the legacy row's three new columns read back NULL,
 *    never a fabricated value, and the generated Prisma client (this same
 *    schema, unmodified) can read that legacy row without throwing;
 *  - the generated Prisma client can perform a full, fully-populated
 *    composite write/read cycle against the freshly-migrated schema (proof
 *    that `prisma/schema.prisma` matches the final migrated DDL).
 *
 * Self-skips (never fails CI) unless `HISTORICAL_CANDLE_TEST_DATABASE_URL`
 * is configured, exactly like every other isolated-MySQL suite in this
 * module.
 */

const adminUrlEnvVar = 'HISTORICAL_CANDLE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CANDLE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';
const forbiddenDatabaseNames = new Set(['trademind']);

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
const MIGRATION_B_F2C = '20260831090000_add_historical_data_retrieval_evidence';
const MIGRATION_1_REPAIR_EVIDENCE = '20260831171125_add_historical_candle_repair_evidence';
const MIGRATION_2_CONTRIBUTION_PROVENANCE = '20260831174417_add_historical_candle_repair_contribution_provenance';

function skipReason(): string {
  return `Set ${adminUrlEnvVar} (a dedicated admin URL, never DATABASE_URL) to run this integration suite; add ${requireEnvVar}=1 to make setup failures fatal instead of skipped.`;
}

async function readMigrationSql(migrationName: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, migrationName, 'migration.sql'), 'utf8');
}

/** Strips SQL comments (`/* ... *\/` and `-- ...`) before splitting on `;` -- migration #2's own doc comment contains example SQL-like prose that must never be mistaken for a statement to execute. */
function statementsFromMigrationSql(sql: string): string[] {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLineComments = withoutBlockComments
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(client: PrismaClient, migrationName: string): Promise<void> {
  const sql = await readMigrationSql(migrationName);
  for (const statement of statementsFromMigrationSql(sql)) {
    // eslint-disable-next-line no-await-in-loop -- DDL statements must run in order
    await client.$executeRawUnsafe(statement);
  }
}

function assertSafeGeneratedDatabaseName(name: string): void {
  if (forbiddenDatabaseNames.has(name.toLowerCase())) {
    throw new Error(`Refusing to operate on database '${name}': reserved for the real application database.`);
  }
  if (!/^research_migration_chain_test_[0-9a-f]{16}$/.test(name)) {
    throw new Error(`Refusing to operate on database '${name}': does not match the required test-only naming pattern.`);
  }
}

async function disconnectBestEffort(client: PrismaClient): Promise<void> {
  try {
    await client.$disconnect();
  } catch {
    // best-effort
  }
}

async function withFreshDatabase<T>(fn: (testUrl: string) => Promise<T>): Promise<T> {
  const adminUrlRaw = process.env[adminUrlEnvVar]!;
  if (process.env.DATABASE_URL && adminUrlRaw === process.env.DATABASE_URL) {
    throw new Error(`${adminUrlEnvVar} must not be identical to DATABASE_URL.`);
  }
  const databaseName = `research_migration_chain_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  assertSafeGeneratedDatabaseName(databaseName);

  const base = new URL(adminUrlRaw);
  base.pathname = '/';
  const testUrl = new URL(adminUrlRaw);
  testUrl.pathname = `/${databaseName}`;

  const admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
  await disconnectBestEffort(admin);

  try {
    return await fn(testUrl.toString());
  } finally {
    const dropper = new PrismaClient({ datasources: { db: { url: base.toString() } } });
    await dropper.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
    await disconnectBestEffort(dropper);
  }
}

let databaseAvailable = false;

test.before(async () => {
  if (!process.env[adminUrlEnvVar]) {
    if (requireIntegration) throw new Error(skipReason());
    return;
  }
  databaseAvailable = true;
});

// ============================================================================
// STRUCTURAL: proves the corrected identifier by construction -- this is the
// part that would catch a regression on ANY server, regardless of that
// server's `lower_case_table_names` setting (this local dev server runs with
// `lower_case_table_names=1`, which tolerates a case mismatch and therefore
// cannot itself reproduce the Linux production failure mode).
// ============================================================================

test("BLOCKER-1 STRUCTURAL: migration #2's ALTER TABLE targets the EXACT-CASE identifier migration #1 created, never the lower-case defect", async () => {
  // Checked against the EXECUTABLE statements only (comments stripped) -- migration #2's own doc
  // comment legitimately mentions the historical lower-case defect identifier in prose explaining
  // what was fixed; that prose must never be mistaken for a live SQL reference.
  const statements = statementsFromMigrationSql(await readMigrationSql(MIGRATION_2_CONTRIBUTION_PROVENANCE));
  const alterStatement = statements.find((s) => /^ALTER TABLE/i.test(s) && /calendarDisposition/.test(s));
  assert.ok(alterStatement, 'expected an ALTER TABLE statement adding calendarDisposition');
  assert.match(alterStatement!, /ALTER TABLE `HistoricalCandleRepairEvidence`/, "migration #2 must ALTER TABLE `HistoricalCandleRepairEvidence` (exact case)");
  assert.equal(/historicalcandlerepairevidence/.test(alterStatement!), false, 'migration #2 must never reference the lower-case defect identifier in an executable statement');
});

test('BLOCKER-1B STRUCTURAL: migration #2 adds the three new columns as NULLable, never NOT NULL without a default', async () => {
  const statements = statementsFromMigrationSql(await readMigrationSql(MIGRATION_2_CONTRIBUTION_PROVENANCE));
  const alterStatement = statements.find((s) => /^ALTER TABLE/i.test(s) && /calendarDisposition/.test(s));
  assert.ok(alterStatement);
  for (const column of ['calendarDisposition', 'primaryProviderId', 'repairPolicyVersion']) {
    // Bounded to stop at the next comma (or end of statement) -- an unbounded match would run past
    // this column's own clause into unrelated SQL text.
    const columnDeclRegex = new RegExp(`ADD COLUMN \`${column}\`[^,]*(,|$)`, 'i');
    const columnMatch: RegExpMatchArray | null = alterStatement!.match(columnDeclRegex);
    assert.ok(columnMatch, `expected an ADD COLUMN clause for ${column}`);
    assert.match(columnMatch![0], /\bNULL\b/i, `${column} must be added as NULL-able (safe for a non-empty pre-existing table)`);
    assert.equal(/NOT NULL/i.test(columnMatch![0]), false, `${column} must never be added as NOT NULL without a default`);
  }
});

/**
 * BLOCKER 1 IMMUTABILITY (post-Terra-re-review, strengthened): this is NOT
 * derived from the file itself at runtime -- that would be a tautology (any
 * edit to the file would just produce a new "expected" hash matching the new
 * content, silently accepting the edit). This exact literal was captured via
 * a READ-ONLY query against the shared dev database's own
 * `_prisma_migrations.checksum` for this migration on 2026-09-01 (the row
 * Prisma itself recorded the moment this migration was actually applied),
 * confirmed to equal a plain SHA-256 of the file's raw bytes computed
 * independently in the same session. If this migration's file content ever
 * changes for ANY reason, this constant must be updated ONLY by re-deriving
 * it from a fresh read-only comparison against the shared DB's own recorded
 * checksum (see the companion `_prisma_migrations.checksum` test below) --
 * never by simply re-hashing the locally-edited file.
 */
const TRUSTED_MIGRATION_1_SHA256 = 'cd63c1b2b96d93de1ddaf85c3de9686e1824c15705e263c432015ed146d471ea';

test('BLOCKER-1 IMMUTABILITY: migration #1 on disk hashes to the FIXED, previously-recorded SHA-256 -- a true byte-identity proof, never a hash re-derived from this same file at runtime', async () => {
  const raw = await readFile(join(MIGRATIONS_DIR, MIGRATION_1_REPAIR_EVIDENCE, 'migration.sql'));
  const actualSha256 = createHash('sha256').update(raw).digest('hex');
  assert.equal(actualSha256, TRUSTED_MIGRATION_1_SHA256, "migration #1's bytes no longer match the trusted, previously-recorded SHA-256 -- this file must never be edited (see the constant's own doc comment for the recovery procedure if this ever legitimately fires)");

  const sql = raw.toString('utf8');
  assert.match(sql, /CREATE TABLE `HistoricalCandleRepairEvidence`/);
  assert.equal(/historicalcandlerepairevidence/.test(sql), false);
});

test('BLOCKER-1 IMMUTABILITY (shared DB, READ-ONLY): the on-disk hash matches _prisma_migrations.checksum on the shared dev database, when one is safely configured -- never mutates it', async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not configured -- skipping the read-only shared-DB comparison (this is an informational check, not required for the suite to pass).');

  const sharedDbClient = new PrismaClient();
  try {
    const rows: { checksum: string }[] = await sharedDbClient.$queryRaw`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${MIGRATION_1_REPAIR_EVIDENCE}`;
    if (rows.length === 0) return t.skip(`No _prisma_migrations row found for ${MIGRATION_1_REPAIR_EVIDENCE} on the configured DATABASE_URL -- skipping (informational check only).`);

    const raw = await readFile(join(MIGRATIONS_DIR, MIGRATION_1_REPAIR_EVIDENCE, 'migration.sql'));
    const actualSha256 = createHash('sha256').update(raw).digest('hex');
    assert.equal(actualSha256, rows[0].checksum, "the on-disk migration #1 file no longer matches what the shared DB recorded when it was actually applied -- this must never happen for an already-applied migration");
    assert.equal(actualSha256, TRUSTED_MIGRATION_1_SHA256, 'the shared DB checksum itself must also match the fixed, hard-coded trusted value above -- proves the trusted constant has not drifted from reality');
  } finally {
    // READ-ONLY: this connection only ever issued a SELECT. No write, no migrate command, no schema
    // change of any kind is performed against the shared database by this test.
    await sharedDbClient.$disconnect().catch(() => undefined);
  }
});

// ============================================================================
// EXECUTABLE: applies the real migration SQL, in order, to a fresh isolated
// MySQL database.
// ============================================================================

test('BLOCKER-1 EXECUTABLE: the real migration chain (B-F2C -> #1 -> corrected #2) applies cleanly to a fresh database, empty-table scenario', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  await withFreshDatabase(async (testUrl) => {
    const schemaClient = new PrismaClient({ datasources: { db: { url: testUrl } } });
    try {
      await applyMigration(schemaClient, MIGRATION_B_F2C);
      await applyMigration(schemaClient, MIGRATION_1_REPAIR_EVIDENCE);
      await applyMigration(schemaClient, MIGRATION_2_CONTRIBUTION_PROVENANCE);
    } finally {
      await disconnectBestEffort(schemaClient);
    }

    const client = new PrismaClient({ datasources: { db: { url: testUrl } } });
    try {
      // Prove the child tables/FKs/uniques from migration #2 exist and are usable. Compared
      // case-INsensitively here on purpose: `INFORMATION_SCHEMA.TABLES.TABLE_NAME` itself reports
      // lower-cased names on this server (confirmed: `lower_case_table_names=1`) even though the DDL
      // that created them used exact-case identifiers throughout -- this check only proves EXISTENCE,
      // never case-sensitivity (see the STRUCTURAL test above for the case-sensitivity proof).
      const tableNames: { TABLE_NAME: string }[] = await client.$queryRaw`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) IN ('historicalcandlerepairevidence', 'historicalcandlerepairsessionwindow', 'historicalcandlerepaircontribution')
      `;
      assert.deepEqual(
        new Set(tableNames.map((r) => r.TABLE_NAME.toLowerCase())),
        new Set(['historicalcandlerepairevidence', 'historicalcandlerepairsessionwindow', 'historicalcandlerepaircontribution'])
      );

      // Prove the three new columns exist and are nullable.
      const columns: { COLUMN_NAME: string; IS_NULLABLE: string }[] = await client.$queryRaw`
        SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HistoricalCandleRepairEvidence'
          AND COLUMN_NAME IN ('calendarDisposition', 'primaryProviderId', 'repairPolicyVersion')
      `;
      assert.equal(columns.length, 3);
      for (const column of columns) {
        assert.equal(column.IS_NULLABLE, 'YES', `${column.COLUMN_NAME} must be nullable`);
      }

      // Prove `prisma/schema.prisma` (unmodified, this same generated client) matches the final
      // migrated DDL by performing a FULL, fully-populated composite write/read cycle through it.
      const retrieval = await client.historicalDataRetrieval.create({
        data: { providerId: 'UPSTOX', assetType: 'NIFTY_INDEX', instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', requestedFromDate: '2031-05-01', requestedToDate: '2031-05-01', status: 'PROCESSED', startedAt: new Date(), completedAt: new Date() },
      });
      const session = await client.historicalDataRetrievalSession.create({
        data: {
          retrievalId: retrieval.id, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2031-05-01', calendarDisposition: 'REGULAR_TRADING_DAY',
          expectedMinuteCount: 375, providerRowCountForDate: 375, acceptedRowCount: 375, excludedRowCount: 0, sourceOrderAnomalyCount: 0, healthStatus: 'HEALTHY',
          persistenceOutcome: 'ACCEPTED_NEW', evidenceSemanticChecksum: 'checksum-1',
        },
      });
      const evidence = await client.historicalCandleRepairEvidence.create({
        data: {
          primaryRetrievalId: retrieval.id, primaryProviderId: 'UPSTOX', primarySessionId: session.id, repairProviderId: 'GROWW', instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute',
          tradingDate: '2031-05-01', calendarDisposition: 'REGULAR_TRADING_DAY', repairPolicyVersion: 1, expectedMinuteCount: 375, primaryAcceptedRowCount: 372, missingMinuteCount: 3,
          repairAcceptedMinuteCount: 3, corroboratedOverlapCount: 0, conflictingOverlapCount: 0, outcome: 'REPAIR_ACCEPTED', resultingSessionId: session.id,
          missingMinutesChecksum: 'missing-checksum', repairSemanticChecksum: 'repair-checksum',
        },
      });
      await client.historicalCandleRepairSessionWindow.create({ data: { repairEvidenceId: evidence.id, windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 } });
      await client.historicalCandleRepairContribution.create({
        data: { repairEvidenceId: evidence.id, candleTime: new Date('2031-05-01T04:15:00.000Z'), role: 'REPAIR_FILLED_MISSING', repairProviderId: 'GROWW', repairContentChecksum: 'checksum-a' },
      });

      const readBack = await client.historicalCandleRepairEvidence.findUniqueOrThrow({ where: { id: evidence.id }, include: { sessionWindows: true, contributions: true } });
      assert.equal(readBack.primaryProviderId, 'UPSTOX');
      assert.equal(readBack.calendarDisposition, 'REGULAR_TRADING_DAY');
      assert.equal(readBack.repairPolicyVersion, 1);
      assert.equal(readBack.sessionWindows.length, 1);
      assert.equal(readBack.contributions.length, 1);
    } finally {
      await disconnectBestEffort(client);
    }
  });
});

test('BLOCKER-1B EXECUTABLE: the migration chain is safe when migration #1\'s table already contains a legacy row -- no false provenance is fabricated', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  await withFreshDatabase(async (testUrl) => {
    const schemaClient = new PrismaClient({ datasources: { db: { url: testUrl } } });
    let legacyEvidenceId: string;
    let legacyRetrievalId: string;
    let legacySessionId: string;
    try {
      await applyMigration(schemaClient, MIGRATION_B_F2C);
      await applyMigration(schemaClient, MIGRATION_1_REPAIR_EVIDENCE);

      // Simulate a LEGACY row written before migration #2's columns existed -- a raw insert against
      // migration #1's original (narrower) column set, exactly as production code running against
      // ONLY migration #1 would have produced.
      legacyRetrievalId = randomUUID();
      legacySessionId = randomUUID();
      legacyEvidenceId = randomUUID();
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalDataRetrieval` (`id`, `providerId`, `assetType`, `instrumentKey`, `timeframe`, `requestedFromDate`, `requestedToDate`, `status`, `startedAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        legacyRetrievalId, 'UPSTOX', 'NIFTY_INDEX', 'NSE_INDEX|Nifty 50', '1minute', '2031-04-01', '2031-04-01', 'PROCESSED', new Date(), new Date()
      );
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalDataRetrievalSession` (`id`, `retrievalId`, `instrumentKey`, `timeframe`, `tradingDate`, `calendarDisposition`, `expectedMinuteCount`, `providerRowCountForDate`, `acceptedRowCount`, `excludedRowCount`, `sourceOrderAnomalyCount`, `healthStatus`, `persistenceOutcome`, `evidenceSemanticChecksum`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        legacySessionId, legacyRetrievalId, 'NSE_INDEX|Nifty 50', '1minute', '2031-04-01', 'REGULAR_TRADING_DAY', 375, 375, 375, 0, 0, 'HEALTHY', 'ACCEPTED_NEW', 'legacy-checksum', new Date()
      );
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalCandleRepairEvidence` (`id`, `primaryRetrievalId`, `primarySessionId`, `repairProviderId`, `instrumentKey`, `timeframe`, `tradingDate`, `expectedMinuteCount`, `primaryAcceptedRowCount`, `missingMinuteCount`, `repairAcceptedMinuteCount`, `corroboratedOverlapCount`, `conflictingOverlapCount`, `outcome`, `resultingSessionId`, `missingMinutesChecksum`, `repairSemanticChecksum`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        legacyEvidenceId, legacyRetrievalId, legacySessionId, 'GROWW', 'NSE_INDEX|Nifty 50', '1minute', '2031-04-01', 375, 372, 3, 3, 0, 0, 'REPAIR_ACCEPTED', legacySessionId, 'legacy-missing-checksum', 'legacy-repair-checksum'
      );

      // NOW apply the corrected migration #2 against a table that already holds this legacy row.
      await applyMigration(schemaClient, MIGRATION_2_CONTRIBUTION_PROVENANCE);
    } finally {
      await disconnectBestEffort(schemaClient);
    }

    const client = new PrismaClient({ datasources: { db: { url: testUrl } } });
    try {
      // The legacy row must still be readable through the SAME generated Prisma client -- never a
      // crash, never a fabricated non-null value for the three new columns.
      const legacyRow = await client.historicalCandleRepairEvidence.findUniqueOrThrow({ where: { id: legacyEvidenceId! } });
      assert.equal(legacyRow.calendarDisposition, null, 'a legacy row must read back NULL, never a fabricated calendar disposition');
      assert.equal(legacyRow.primaryProviderId, null, 'a legacy row must read back NULL, never a fabricated primary provider');
      assert.equal(legacyRow.repairPolicyVersion, null, 'a legacy row must read back NULL, never a fabricated repair-policy version');
      assert.equal(legacyRow.outcome, 'REPAIR_ACCEPTED', 'the legacy row itself is otherwise unmodified');

      // A NEW row created after migration #2 must still be fully, correctly populated.
      const freshRetrieval = await client.historicalDataRetrieval.create({
        data: { providerId: 'UPSTOX', assetType: 'NIFTY_INDEX', instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', requestedFromDate: '2031-05-02', requestedToDate: '2031-05-02', status: 'PROCESSED', startedAt: new Date() },
      });
      const freshSession = await client.historicalDataRetrievalSession.create({
        data: {
          retrievalId: freshRetrieval.id, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2031-05-02', calendarDisposition: 'REGULAR_TRADING_DAY',
          expectedMinuteCount: 375, providerRowCountForDate: 375, acceptedRowCount: 375, excludedRowCount: 0, sourceOrderAnomalyCount: 0, healthStatus: 'HEALTHY',
          persistenceOutcome: 'ACCEPTED_NEW', evidenceSemanticChecksum: 'checksum-fresh',
        },
      });
      const freshEvidence = await client.historicalCandleRepairEvidence.create({
        data: {
          primaryRetrievalId: freshRetrieval.id, primaryProviderId: 'UPSTOX', primarySessionId: freshSession.id, repairProviderId: 'GROWW', instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute',
          tradingDate: '2031-05-02', calendarDisposition: 'REGULAR_TRADING_DAY', repairPolicyVersion: 1, expectedMinuteCount: 375, primaryAcceptedRowCount: 372, missingMinuteCount: 3,
          repairAcceptedMinuteCount: 3, corroboratedOverlapCount: 0, conflictingOverlapCount: 0, outcome: 'REPAIR_ACCEPTED', resultingSessionId: freshSession.id,
          missingMinutesChecksum: 'fresh-missing-checksum', repairSemanticChecksum: 'fresh-repair-checksum',
        },
      });
      assert.equal(freshEvidence.primaryProviderId, 'UPSTOX');
      assert.equal(freshEvidence.calendarDisposition, 'REGULAR_TRADING_DAY');
      assert.equal(freshEvidence.repairPolicyVersion, 1);

      // Both rows coexist without interfering with each other.
      const all = await client.historicalCandleRepairEvidence.findMany({ orderBy: { tradingDate: 'asc' } });
      assert.equal(all.length, 2);
    } finally {
      await disconnectBestEffort(client);
    }
  });
});

// ============================================================================
// HIGH 1 (post-Terra-re-review correction): migration-chain-to-manifest --
// the FULL chain (B-F2C -> #1 -> corrected #2) applied to a fresh database
// that already holds a legacy REPAIR_ACCEPTED row, then read through the
// REAL `HistoricalDataRetrievalEvidenceService.findLatestAvailableSessionEvidence`
// (the exact manifest read path), proving no false PRIMARY_ONLY attribution
// end to end -- not merely at the raw-row level (BLOCKER-1B EXECUTABLE above)
// but at the actual manifest/source-evidence read layer this milestone exists
// to protect.
// ============================================================================

test('HIGH-1 MIGRATION-CHAIN-TO-MANIFEST: migration #1 legacy row -> corrected migration #2 -> findLatestAvailableSessionEvidence never reports PRIMARY_ONLY for it', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());

  await withFreshDatabase(async (testUrl) => {
    const schemaClient = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const legacyRetrievalId = randomUUID();
    const legacySessionId = randomUUID();
    const instrumentKey = 'NSE_INDEX|Nifty 50';
    const timeframe = '1minute';
    const tradingDate = '2031-04-15';
    try {
      await applyMigration(schemaClient, MIGRATION_B_F2C);
      await applyMigration(schemaClient, MIGRATION_1_REPAIR_EVIDENCE);

      // A genuinely ACCEPTED, terminal-finalized session -- exactly the shape
      // `findLatestAvailableSessionEvidence`'s FIX-1 gate requires to even be
      // considered AVAILABLE at all.
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalDataRetrieval` (`id`, `providerId`, `assetType`, `instrumentKey`, `timeframe`, `requestedFromDate`, `requestedToDate`, `status`, `startedAt`, `completedAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        legacyRetrievalId, 'UPSTOX', 'NIFTY_INDEX', instrumentKey, timeframe, tradingDate, tradingDate, 'PROCESSED', new Date(), new Date(), new Date()
      );
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalDataRetrievalSession` (`id`, `retrievalId`, `instrumentKey`, `timeframe`, `tradingDate`, `calendarDisposition`, `expectedMinuteCount`, `providerRowCountForDate`, `acceptedRowCount`, `excludedRowCount`, `sourceOrderAnomalyCount`, `healthStatus`, `persistenceOutcome`, `evidenceSemanticChecksum`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        legacySessionId, legacyRetrievalId, instrumentKey, timeframe, tradingDate, 'REGULAR_TRADING_DAY', 375, 375, 375, 0, 0, 'HEALTHY', 'ACCEPTED_NEW', 'chain-to-manifest-checksum', new Date()
      );
      // Legacy repair evidence -- written against migration #1's original (narrower) column set only,
      // exactly as production code running before migration #2 existed would have produced.
      await schemaClient.$executeRawUnsafe(
        'INSERT INTO `HistoricalCandleRepairEvidence` (`id`, `primaryRetrievalId`, `primarySessionId`, `repairProviderId`, `instrumentKey`, `timeframe`, `tradingDate`, `expectedMinuteCount`, `primaryAcceptedRowCount`, `missingMinuteCount`, `repairAcceptedMinuteCount`, `corroboratedOverlapCount`, `conflictingOverlapCount`, `outcome`, `resultingSessionId`, `missingMinutesChecksum`, `repairSemanticChecksum`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), legacyRetrievalId, legacySessionId, 'GROWW', instrumentKey, timeframe, tradingDate, 375, 372, 3, 3, 0, 0, 'REPAIR_ACCEPTED', legacySessionId, 'chain-missing-checksum', 'chain-repair-checksum'
      );

      // NOW apply the corrected migration #2 against a table that already holds this legacy row.
      await applyMigration(schemaClient, MIGRATION_2_CONTRIBUTION_PROVENANCE);
    } finally {
      await disconnectBestEffort(schemaClient);
    }

    const client = new PrismaClient({ datasources: { db: { url: testUrl } } });
    try {
      // The REAL manifest/source-evidence read path -- never a raw query re-implemented for this test.
      const evidenceService = new HistoricalDataRetrievalEvidenceService(client);
      const evidence = await evidenceService.findLatestAvailableSessionEvidence(instrumentKey, timeframe, tradingDate);

      assert.ok(evidence, 'the session is genuinely ACCEPTED + terminal-finalized -- it must be AVAILABLE');
      assert.notEqual(evidence!.provenanceComposition, SourceAcquisitionProvenanceComposition.PRIMARY_ONLY, 'a legacy REPAIR_ACCEPTED row surviving the real migration chain must never manifest as PRIMARY_ONLY');
      assert.equal(evidence!.provenanceComposition, SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE);
      assert.equal(evidence!.compositeRepair, null, 'never fabricate primary provider/policy version for a legacy row read through the real migration chain');
    } finally {
      await disconnectBestEffort(client);
    }
  });
});
