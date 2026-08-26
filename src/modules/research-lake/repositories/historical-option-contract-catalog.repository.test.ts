import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import HistoricalOptionContractCatalogRepository from './historical-option-contract-catalog.repository';
import { DiscoveredOptionContractCandidate } from '../domain/historical-option-contract-catalog.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { HistoricalContractState } from '../domain/historical-option-identity.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * TEST DATABASE SAFETY -- mirrors historical-candle.repository.test.ts
 * exactly: this suite NEVER touches DATABASE_URL / the real `trademind`
 * database. It requires a dedicated admin URL via
 * HISTORICAL_CONTRACT_CATALOG_TEST_DATABASE_URL and creates a brand-new,
 * uniquely-named throwaway database per run, guarded by a fail-closed
 * name-shape check before every CREATE/DROP DATABASE. If the env var is
 * not set, every test skips itself -- this suite is optional for the
 * normal run. HISTORICAL_CONTRACT_CATALOG_TEST_REQUIRE=1 makes setup
 * failures fatal instead of skipped.
 */
const adminUrlEnvVar = 'HISTORICAL_CONTRACT_CATALOG_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CONTRACT_CATALOG_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';

const forbiddenDatabaseNames = new Set(['trademind']);
const runSuffix = randomUUID().replace(/-/g, '');
const testDatabaseName = `contract_catalog_repo_test_${runSuffix}`;
const testDatabaseNamePattern = /^contract_catalog_repo_test_[0-9a-f]{32}$/;

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
    // best-effort only -- must never mask the real operation's outcome
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
  CREATE TABLE \`HistoricalOptionContractCatalog\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`provider\` VARCHAR(191) NOT NULL,
    \`providerContractId\` VARCHAR(191) NOT NULL,
    \`underlyingSymbol\` VARCHAR(191) NOT NULL,
    \`exchange\` VARCHAR(191) NOT NULL,
    \`expiry\` DATETIME(3) NOT NULL,
    \`strikePrice\` DECIMAL(65, 30) NOT NULL,
    \`optionType\` VARCHAR(191) NOT NULL,
    \`exchangeTradingSymbol\` VARCHAR(191) NULL,
    \`lotSize\` INTEGER NULL,
    \`tickSize\` DECIMAL(65, 30) NULL,
    \`metadataState\` VARCHAR(191) NOT NULL,
    \`discoveredAt\` DATETIME(3) NOT NULL,
    \`sourceCatalogAsOf\` DATETIME(3) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalOptionContractCatalog_provider_providerContractId_key\`(\`provider\`, \`providerContractId\`),
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

function newRepository(): HistoricalOptionContractCatalogRepository {
  return new HistoricalOptionContractCatalogRepository(newClient());
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

function candidate(overrides: Partial<DiscoveredOptionContractCandidate> = {}): DiscoveredOptionContractCandidate {
  return {
    provider: HistoricalProviderId.GROWW,
    providerContractId: `NSE-NIFTY-02Jan25-28500-CE-${randomUUID()}`,
    exchange: 'NSE',
    underlyingSymbol: 'NIFTY',
    expiry: new Date('2025-01-02T00:00:00+05:30'),
    strikePrice: 28500,
    optionType: HistoricalOptionType.CE,
    exchangeTradingSymbol: null,
    lotSize: null,
    tickSize: null,
    discoveredAt: new Date(),
    ...overrides,
  };
}

test('a new candidate is inserted with METADATA_INCOMPLETE when identity metadata is not fully proven', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const c = candidate();

  const [result] = await repository.upsertMany([c]);
  assert.equal(result.outcome, 'INSERTED');
  assert.equal(result.metadataState, HistoricalContractState.METADATA_INCOMPLETE);

  const stored = await repository.findByProviderContractId(c.provider, c.providerContractId);
  assert.ok(stored);
  assert.equal(stored!.exchangeTradingSymbol, null);
  assert.equal(stored!.metadataState, HistoricalContractState.METADATA_INCOMPLETE);
});

test('an exact duplicate rerun is idempotent: same row, UNCHANGED outcome, no duplicate rows created', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const c = candidate();

  await repository.upsertMany([c]);
  const [second] = await repository.upsertMany([c]);
  assert.equal(second.outcome, 'UNCHANGED');

  const rows = await repository.findByUnderlyingAndExpiry(c.underlyingSymbol, c.exchange, c.expiry);
  const matching = rows.filter((row) => row.providerContractId === c.providerContractId);
  assert.equal(matching.length, 1);
});

test('stronger evidence enriches a previously missing field and upgrades metadataState to CATALOG_KNOWN', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const partial = candidate();
  await repository.upsertMany([partial]);

  const enriched = { ...partial, exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: 75, tickSize: 0.05, discoveredAt: new Date() };
  const [result] = await repository.upsertMany([enriched]);
  assert.equal(result.outcome, 'ENRICHED');
  assert.equal(result.metadataState, HistoricalContractState.CATALOG_KNOWN);

  const stored = await repository.findByProviderContractId(partial.provider, partial.providerContractId);
  assert.equal(stored!.exchangeTradingSymbol, 'NIFTY25JAN28500CE');
  assert.equal(stored!.lotSize, 75);
  assert.equal(Number(stored!.tickSize), 0.05);
  assert.equal(stored!.metadataState, HistoricalContractState.CATALOG_KNOWN);
});

test('a later weaker/null observation can never erase already-proven metadata', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const full = candidate({ exchangeTradingSymbol: 'NIFTY25JAN28500CE', lotSize: 75, tickSize: 0.05 });
  await repository.upsertMany([full]);

  const weaker = { ...full, exchangeTradingSymbol: null, lotSize: null, tickSize: null, discoveredAt: new Date() };
  const [result] = await repository.upsertMany([weaker]);
  assert.equal(result.outcome, 'UNCHANGED'); // nothing material changed -- existing proven values win

  const stored = await repository.findByProviderContractId(full.provider, full.providerContractId);
  assert.equal(stored!.exchangeTradingSymbol, 'NIFTY25JAN28500CE');
  assert.equal(stored!.lotSize, 75);
  assert.equal(Number(stored!.tickSize), 0.05);
  assert.equal(stored!.metadataState, HistoricalContractState.CATALOG_KNOWN);
});

test('discoveredAt is immutable across reruns; sourceCatalogAsOf advances to the latest confirming run', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const firstSeen = new Date('2026-01-01T00:00:00Z');
  const c = candidate({ discoveredAt: firstSeen });
  await repository.upsertMany([c]);

  const laterRun = new Date('2026-02-01T00:00:00Z');
  await repository.upsertMany([{ ...c, discoveredAt: laterRun }]);

  const stored = await repository.findByProviderContractId(c.provider, c.providerContractId);
  assert.equal(stored!.discoveredAt.getTime(), firstSeen.getTime());
  assert.equal(stored!.sourceCatalogAsOf.getTime(), laterRun.getTime());
});

test('a crash-after-persist-before-summary topology still leaves the row idempotently rediscoverable on the next run', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const c = candidate();
  await repository.upsertMany([c]); // simulates the "first run" that persisted successfully

  // simulate a fresh "process" against the same underlying DB state
  const secondRunRepository = newRepository();
  const [result] = await secondRunRepository.upsertMany([c]);
  assert.equal(result.outcome, 'UNCHANGED');

  const rows = await secondRunRepository.findByUnderlyingAndExpiry(c.underlyingSymbol, c.exchange, c.expiry);
  assert.equal(rows.filter((row) => row.providerContractId === c.providerContractId).length, 1);
});
