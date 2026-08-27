import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import HistoricalOptionCandleLakeRepository, { HistoricalOptionCandleLakeIdentity } from './historical-option-candle-lake.repository';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import { HistoricalAssetType, HistoricalOptionType } from '../domain/historical-asset.types';

/**
 * TEST DATABASE SAFETY -- mirrors `historical-option-contract-catalog.repository.test.ts`
 * exactly: NEVER touches `DATABASE_URL` / the real `trademind` database.
 * Requires a dedicated admin URL via `HISTORICAL_OPTION_CANDLE_LAKE_TEST_DATABASE_URL`
 * and creates a brand-new, uniquely-named throwaway database per run,
 * guarded by a fail-closed name-shape check before every CREATE/DROP
 * DATABASE. If the env var is not set, every test skips itself.
 * `HISTORICAL_OPTION_CANDLE_LAKE_TEST_REQUIRE=1` makes setup failures fatal
 * instead of skipped.
 */
const adminUrlEnvVar = 'HISTORICAL_OPTION_CANDLE_LAKE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_OPTION_CANDLE_LAKE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';

const forbiddenDatabaseNames = new Set(['trademind']);
const runSuffix = randomUUID().replace(/-/g, '');
const testDatabaseName = `option_candle_lake_repo_test_${runSuffix}`;
const testDatabaseNamePattern = /^option_candle_lake_repo_test_[0-9a-f]{32}$/;

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
    throw new Error(`${adminUrlEnvVar} is not set. This integration suite requires a dedicated MySQL admin connection URL -- it never falls back to DATABASE_URL.`);
  }
  if (process.env.DATABASE_URL && adminUrlRaw === process.env.DATABASE_URL) {
    throw new Error(`${adminUrlEnvVar} must not be identical to DATABASE_URL.`);
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
    // best-effort only
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

const createTableSql = `
  CREATE TABLE \`HistoricalOptionCandle\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`tradingSymbol\` VARCHAR(191) NULL,
    \`optionType\` VARCHAR(191) NULL,
    \`strikePrice\` DECIMAL(65, 30) NULL,
    \`expiry\` DATETIME(3) NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`candleTime\` DATETIME(3) NOT NULL,
    \`open\` DECIMAL(65, 30) NOT NULL,
    \`high\` DECIMAL(65, 30) NOT NULL,
    \`low\` DECIMAL(65, 30) NOT NULL,
    \`close\` DECIMAL(65, 30) NOT NULL,
    \`volume\` BIGINT NOT NULL,
    \`openInterest\` BIGINT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalOptionCandle_instrumentKey_timeframe_candleTime_key\`(\`instrumentKey\`, \`timeframe\`, \`candleTime\`),
    INDEX \`HistoricalOptionCandle_instrumentKey_timeframe_idx\`(\`instrumentKey\`, \`timeframe\`),
    INDEX \`HistoricalOptionCandle_candleTime_idx\`(\`candleTime\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
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

function newRepository(): HistoricalOptionCandleLakeRepository {
  return new HistoricalOptionCandleLakeRepository(newClient());
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

function identity(overrides: Partial<HistoricalOptionCandleLakeIdentity> = {}): HistoricalOptionCandleLakeIdentity {
  return {
    providerContractId: `NSE-NIFTY-06Jan22-17200-PE-${randomUUID()}`,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-01-06T00:00:00+05:30'),
    ...overrides,
  };
}

function candle(candleTime: Date, overrides: Partial<CanonicalHistoricalCandle> = {}): CanonicalHistoricalCandle {
  return {
    assetType: HistoricalAssetType.NIFTY_OPTION,
    instrumentKey: 'unused-by-repository',
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

test('inserting a new candle writes identity metadata (optionType/strikePrice/expiry) plus OHLCV/OI', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const id = identity();
  const time = new Date('2022-01-03T09:15:00+05:30');

  await repository.upsertCandles(id, '1minute', [candle(time, { openInterest: 500n })]);

  const stored = await repository.findRange(id.providerContractId, '1minute', time, time);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].optionType, 'PE');
  assert.equal(Number(stored[0].strikePrice), 17200);
  assert.equal(stored[0].tradingSymbol, null); // never fabricated -- Groww discovery never proves the real exchange trading symbol
  assert.equal(stored[0].openInterest, 500n);
  assert.equal(Number(stored[0].open), 100);
});

test('(R) a conflicting re-upsert updates OHLCV/OI but NEVER rewrites identity fields (instrumentKey/optionType/strikePrice/expiry)', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const id = identity();
  const time = new Date('2022-01-03T09:16:00+05:30');

  await repository.upsertCandles(id, '1minute', [candle(time, { close: 100.5, openInterest: 10n })]);

  // A "weaker/different" second write attempting a different identity for
  // the SAME instrumentKey/timeframe/candleTime -- must never win.
  const conflictingIdentity: HistoricalOptionCandleLakeIdentity = { ...id, optionType: HistoricalOptionType.CE, strikePrice: 99999 };
  await repository.upsertCandles(conflictingIdentity, '1minute', [candle(time, { close: 105, openInterest: 20n })]);

  const stored = await repository.findRange(id.providerContractId, '1minute', time, time);
  assert.equal(stored.length, 1); // no duplicate row
  assert.equal(stored[0].optionType, 'PE'); // unchanged -- never rewritten to CE
  assert.equal(Number(stored[0].strikePrice), 17200); // unchanged -- never rewritten to 99999
  assert.equal(Number(stored[0].close), 105); // OHLCV DOES update on conflict
  assert.equal(stored[0].openInterest, 20n); // OI DOES update on conflict
});

test('(H)/(I) OI zero is stored distinctly from OI null', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const id = identity();
  const zeroTime = new Date('2022-01-03T09:17:00+05:30');
  const nullTime = new Date('2022-01-03T09:18:00+05:30');

  await repository.upsertCandles(id, '1minute', [candle(zeroTime, { openInterest: 0n }), candle(nullTime, { openInterest: null })]);

  const stored = await repository.findRange(id.providerContractId, '1minute', zeroTime, nullTime);
  const zeroRow = stored.find((row) => row.candleTime.getTime() === zeroTime.getTime())!;
  const nullRow = stored.find((row) => row.candleTime.getTime() === nullTime.getTime())!;
  assert.equal(zeroRow.openInterest, 0n);
  assert.equal(nullRow.openInterest, null);
});

test('upsertCandles with an empty array is a no-op', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const count = await repository.upsertCandles(identity(), '1minute', []);
  assert.equal(count, 0);
});

test('(Q) a crash-after-persist-before-summary topology still leaves rows idempotently rediscoverable by a fresh repository instance', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const id = identity();
  const time = new Date('2022-01-03T09:19:00+05:30');
  const firstRun = newRepository();
  await firstRun.upsertCandles(id, '1minute', [candle(time)]);

  const secondRunRepository = newRepository(); // simulates a fresh process
  const stored = await secondRunRepository.findRange(id.providerContractId, '1minute', time, time);
  assert.equal(stored.length, 1);
});
