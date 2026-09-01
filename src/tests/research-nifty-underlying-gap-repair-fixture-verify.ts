import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import logger from '../core/logger/logger';
import { assertSafeIsolatedTestDatabaseUrl } from '../modules/research-lake/domain/isolated-test-database-guard';
import NiftyUnderlyingGapRepairService, { NiftyGapRepairResult } from '../modules/research-lake/services/nifty-underlying-gap-repair.service';
import HistoricalDataRetrievalEvidenceService from '../modules/research-lake/services/historical-data-retrieval-evidence.service';
import HistoricalCandleRepairEvidenceService from '../modules/research-lake/services/historical-candle-repair-evidence.service';
import HistoricalCandleResearchPersistenceService from '../modules/research-lake/services/historical-candle-research-persistence.service';
import NiftyUnderlyingIngestionPlannerService, { NiftyIngestionPlan, NiftyPlannedDate, NiftyPlannedDateDisposition } from '../modules/research-lake/services/nifty-underlying-ingestion-planner.service';
import { HistoricalDataProvider, HistoricalUnderlyingCandleRangeRequest } from '../modules/research-lake/interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import {
  Exchange,
  ExchangeSegment,
  expectedCanonicalTimestamps,
  expectedMinutesForWindow,
  HistoricalSourceCandleRow,
  regularSessionWindow,
} from '../modules/research-lake/domain';
import { NIFTY_INDEX_INSTRUMENT_KEY } from '../modules/research-lake/services/nifty-underlying-identity';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-gap-repair-fixture-verify-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface FixtureRow {
  readonly candleTime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: string;
  readonly openInterest: string | null;
}

/**
 * B-F8 CORRECTION (post-Terra-review blocker 3): a deterministic,
 * FIXTURE-DRIVEN repair provider adapter for CONTROLLED, MANUAL,
 * ISOLATED-TEST-DATABASE-ONLY verification -- explicitly NOT a production
 * secondary NIFTY 1-minute data source (see the B-F8 correction report,
 * section 16: no real alternative NIFTY-index-1m provider adapter exists in
 * this repository). This class is used ONLY by this file. The ordinary
 * operational entrypoint (`research-nifty-underlying-gap-repair.ts`) never
 * imports it -- that structural separation is itself verified by a
 * source-text regression test (see `nifty-underlying-gap-repair-cli-safety.
 * test.ts`).
 */
class FixtureRepairProvider implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.GROWW;
  constructor(private readonly rows: readonly HistoricalSourceCandleRow[]) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: this.providerId,
      earliestDocumentedUnderlyingHistory: null,
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: 1,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false,
      rateLimitPolicy: { policyId: 'FIXTURE_REPAIR_PROVIDER' },
    };
  }

  async fetchCompletedUnderlyingRange(_request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    return this.rows;
  }

  async fetchExpiredOptionRange(): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('FixtureRepairProvider does not support option candles.');
  }
}

/**
 * HIGH 3 CORRECTION (post-Terra-review): the SAME deterministic, isolated-
 * test-database-only fixture treatment as `FixtureRepairProvider` above, but
 * standing in for the PRIMARY provider. Before this correction,
 * `NiftyUnderlyingGapRepairService`'s constructor defaulted an unsupplied
 * `primaryProvider` to a real `UpstoxHistoricalDataProviderService` -- so a
 * "fixture verification" that injected only a fixture REPAIR provider could
 * still reach a genuine Upstox network call for the primary re-fetch. This
 * class is used ONLY by this file, exactly like `FixtureRepairProvider`.
 */
class FixturePrimaryProvider implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.UPSTOX;
  constructor(private readonly rows: readonly HistoricalSourceCandleRow[]) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: this.providerId,
      earliestDocumentedUnderlyingHistory: null,
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: 1,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false,
      rateLimitPolicy: { policyId: 'FIXTURE_PRIMARY_PROVIDER' },
    };
  }

  async fetchCompletedUnderlyingRange(_request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    return this.rows;
  }

  async fetchExpiredOptionRange(): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('FixturePrimaryProvider does not support option candles.');
  }
}

/**
 * HIGH 3 CORRECTION: a deterministic, calendar-network-free stand-in for
 * `NiftyUnderlyingIngestionPlannerService`, scoped to exactly the ONE
 * requested `tradingDate` as an ordinary REGULAR_TRADING_DAY (the shape of
 * the generic incident this script reproduces: 375 expected minutes). The
 * throwaway database this script creates never has the `ExchangeCalendar*`
 * tables at all (see `CREATE_TABLES_SQL` below) -- the real planner would
 * fail outright against it, and even if it did not, resolving real calendar
 * certification is exactly the kind of non-deterministic, environment-
 * dependent behavior a controlled fixture verification must not depend on.
 */
class FixturePlannerService {
  constructor(private readonly tradingDate: string, private readonly plannedDate: NiftyPlannedDate) {}

  async buildPlan(request: { fromDate: string; toDate: string }): Promise<NiftyIngestionPlan> {
    if (request.fromDate !== this.tradingDate || request.toDate !== this.tradingDate) {
      throw new Error(`FixturePlannerService: only configured for ${this.tradingDate}, received a request for ${request.fromDate}..${request.toDate}.`);
    }
    return {
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      exchange: Exchange.NSE,
      calendarSegment: ExchangeSegment.EQUITY,
      requestedFromDate: request.fromDate,
      requestedToDate: request.toDate,
      dates: [this.plannedDate],
      providerRequestChunks: [],
      totalCalendarDateCount: 1,
      totalExpectedCandles: this.plannedDate.expectedMinuteCount,
      regularTradingDateCount: 1,
      specialSessionDateCount: 0,
      closedDateCount: 0,
      blockedDateCount: 0,
      hasBlockedDates: false,
    };
  }
}

function regularFixturePlannedDate(tradingDate: string): NiftyPlannedDate {
  const window = regularSessionWindow();
  return {
    tradingDate,
    disposition: NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
    expectedMinuteCount: 375,
    expectedMinutesIst: expectedMinutesForWindow(window),
    sessionWindows: [window],
    explicitReason: null,
    calendarCoverage: null,
    sourceDocument: null,
  };
}

/** Deterministic synthetic OHLCV content -- never real market data -- keyed only by a stable index so the same index always produces the same content across runs. */
function syntheticContentFor(index: number): { open: number; high: number; low: number; close: number; volume: bigint; openInterest: null } {
  return { open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 1_000n + BigInt(index), openInterest: null };
}

/**
 * HIGH 3 CORRECTION: derives a deterministic, synthetic PRIMARY fixture
 * response that reproduces the generic real incident structurally -- the
 * full calendar-authoritative expected-minute vector for `tradingDate`,
 * MINUS exactly the timestamps the loaded repair fixture supplies (never a
 * hard-coded index list, so this works for whatever exact timestamps the
 * operator's repair fixture file names). Throws if the repair fixture is
 * empty (nothing to verify) or names a timestamp outside the expected
 * session (a mistake in the fixture file itself, not something this script
 * should silently tolerate).
 */
function buildSyntheticPrimaryRows(tradingDate: string, repairFixtureRows: readonly HistoricalSourceCandleRow[]): { primaryRows: HistoricalSourceCandleRow[]; expectedMinuteCount: number; plannedDate: NiftyPlannedDate } {
  if (repairFixtureRows.length === 0) {
    throw new Error('RESEARCH_REPAIR_FIXTURE_PATH must contain at least one candle row -- there is nothing to verify against an empty repair fixture.');
  }
  const plannedDate = regularFixturePlannedDate(tradingDate);
  const expectedTimestamps = expectedCanonicalTimestamps(tradingDate, plannedDate.expectedMinutesIst);
  const expectedTimestampSet = new Set(expectedTimestamps.map((t) => t.getTime()));
  const missingTimestampSet = new Set<number>();
  for (const row of repairFixtureRows) {
    const key = row.candleTime.getTime();
    if (!expectedTimestampSet.has(key)) {
      throw new Error(`RESEARCH_REPAIR_FIXTURE_PATH names ${row.candleTime.toISOString()}, which is not one of the expected canonical minutes for ${tradingDate}'s regular session.`);
    }
    missingTimestampSet.add(key);
  }
  const primaryRows: HistoricalSourceCandleRow[] = expectedTimestamps
    .filter((candleTime) => !missingTimestampSet.has(candleTime.getTime()))
    .map((candleTime, sourceIndex) => ({ sourceIndex, candleTime, ...syntheticContentFor(sourceIndex) }));
  return { primaryRows, expectedMinuteCount: plannedDate.expectedMinuteCount, plannedDate };
}

async function loadFixtureRows(fixturePath: string): Promise<HistoricalSourceCandleRow[]> {
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as readonly FixtureRow[];
  if (!Array.isArray(parsed)) {
    throw new Error(`RESEARCH_REPAIR_FIXTURE_PATH must contain a JSON array of candle rows; received ${typeof parsed}.`);
  }
  return parsed.map((row, sourceIndex) => ({
    sourceIndex,
    candleTime: new Date(row.candleTime),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: BigInt(row.volume),
    openInterest: row.openInterest === null || row.openInterest === undefined ? null : BigInt(row.openInterest),
  }));
}

// Matches prisma/schema.prisma's HistoricalCandle model + the B-F2C/B-F8 evidence models exactly
// (mirrors the identical DDL already established in nifty-underlying-gap-repair.service.integration.test.ts).
const CREATE_TABLES_SQL = `
  CREATE TABLE \`HistoricalCandle\` (
    \`id\` VARCHAR(191) NOT NULL, \`instrumentKey\` VARCHAR(191) NOT NULL, \`timeframe\` VARCHAR(191) NOT NULL,
    \`candleTime\` DATETIME(3) NOT NULL, \`open\` DECIMAL(65, 30) NOT NULL, \`high\` DECIMAL(65, 30) NOT NULL,
    \`low\` DECIMAL(65, 30) NOT NULL, \`close\` DECIMAL(65, 30) NOT NULL, \`volume\` BIGINT NOT NULL,
    \`openInterest\` BIGINT NULL, \`source\` VARCHAR(191) NOT NULL, \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalCandle_instrumentKey_timeframe_candleTime_key\`(\`instrumentKey\`, \`timeframe\`, \`candleTime\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalDataRetrieval\` (
    \`id\` VARCHAR(191) NOT NULL, \`providerId\` VARCHAR(191) NOT NULL, \`assetType\` VARCHAR(191) NOT NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL, \`timeframe\` VARCHAR(191) NOT NULL, \`requestedFromDate\` VARCHAR(191) NOT NULL,
    \`requestedToDate\` VARCHAR(191) NOT NULL, \`status\` VARCHAR(191) NOT NULL, \`startedAt\` DATETIME(3) NOT NULL,
    \`completedAt\` DATETIME(3) NULL, \`providerCallAttempts\` INTEGER NOT NULL DEFAULT 0, \`sourceRowCount\` INTEGER NULL,
    \`sourceRowsSemanticChecksum\` VARCHAR(191) NULL, \`errorCategory\` VARCHAR(191) NULL, \`errorCode\` VARCHAR(191) NULL,
    \`errorMessage\` VARCHAR(191) NULL, \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` DATETIME(3) NOT NULL,
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalDataRetrievalSession\` (
    \`id\` VARCHAR(191) NOT NULL, \`retrievalId\` VARCHAR(191) NOT NULL, \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL, \`tradingDate\` VARCHAR(191) NOT NULL, \`calendarDisposition\` VARCHAR(191) NOT NULL,
    \`expectedMinuteCount\` INTEGER NOT NULL, \`providerRowCountForDate\` INTEGER NOT NULL, \`acceptedRowCount\` INTEGER NOT NULL,
    \`excludedRowCount\` INTEGER NOT NULL, \`sourceOrderAnomalyCount\` INTEGER NOT NULL, \`healthStatus\` VARCHAR(191) NOT NULL,
    \`persistenceOutcome\` VARCHAR(191) NOT NULL, \`sourceRowsSemanticChecksum\` VARCHAR(191) NULL,
    \`canonicalContentChecksum\` VARCHAR(191) NULL, \`evidenceSemanticChecksum\` VARCHAR(191) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` DATETIME(3) NOT NULL,
    UNIQUE INDEX \`HistoricalDataRetrievalSession_retrievalId_tradingDate_key\`(\`retrievalId\`, \`tradingDate\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleConflict\` (
    \`id\` VARCHAR(191) NOT NULL, \`retrievalSessionId\` VARCHAR(191) NOT NULL, \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL, \`candleTime\` DATETIME(3) NOT NULL, \`existingOpen\` DECIMAL(65, 30) NOT NULL,
    \`existingHigh\` DECIMAL(65, 30) NOT NULL, \`existingLow\` DECIMAL(65, 30) NOT NULL, \`existingClose\` DECIMAL(65, 30) NOT NULL,
    \`existingVolume\` BIGINT NOT NULL, \`existingOpenInterest\` BIGINT NULL, \`incomingOpen\` DECIMAL(65, 30) NOT NULL,
    \`incomingHigh\` DECIMAL(65, 30) NOT NULL, \`incomingLow\` DECIMAL(65, 30) NOT NULL, \`incomingClose\` DECIMAL(65, 30) NOT NULL,
    \`incomingVolume\` BIGINT NOT NULL, \`incomingOpenInterest\` BIGINT NULL, \`existingContentChecksum\` VARCHAR(191) NOT NULL,
    \`incomingContentChecksum\` VARCHAR(191) NOT NULL, \`detectedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleRepairEvidence\` (
    \`id\` VARCHAR(191) NOT NULL, \`primaryRetrievalId\` VARCHAR(191) NOT NULL, \`primarySessionId\` VARCHAR(191) NOT NULL,
    \`repairProviderId\` VARCHAR(191) NOT NULL, \`repairRetrievalId\` VARCHAR(191) NULL, \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL, \`tradingDate\` VARCHAR(191) NOT NULL, \`calendarDisposition\` VARCHAR(191) NOT NULL,
    \`repairPolicyVersion\` INTEGER NOT NULL, \`primaryProviderId\` VARCHAR(191) NOT NULL, \`expectedMinuteCount\` INTEGER NOT NULL,
    \`primaryAcceptedRowCount\` INTEGER NOT NULL, \`missingMinuteCount\` INTEGER NOT NULL, \`repairAcceptedMinuteCount\` INTEGER NOT NULL,
    \`corroboratedOverlapCount\` INTEGER NOT NULL, \`conflictingOverlapCount\` INTEGER NOT NULL, \`outcome\` VARCHAR(191) NOT NULL,
    \`resultingSessionId\` VARCHAR(191) NULL, \`missingMinutesChecksum\` VARCHAR(191) NOT NULL, \`repairSemanticChecksum\` VARCHAR(191) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleRepairSessionWindow\` (
    \`id\` VARCHAR(191) NOT NULL, \`repairEvidenceId\` VARCHAR(191) NOT NULL, \`windowIndex\` INTEGER NOT NULL,
    \`openMinuteIst\` INTEGER NOT NULL, \`closeMinuteIst\` INTEGER NOT NULL, \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX \`HistoricalCandleRepairSessionWindow_repairEvidenceId_windowI_key\`(\`repairEvidenceId\`, \`windowIndex\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleRepairContribution\` (
    \`id\` VARCHAR(191) NOT NULL, \`repairEvidenceId\` VARCHAR(191) NOT NULL, \`candleTime\` DATETIME(3) NOT NULL,
    \`role\` VARCHAR(191) NOT NULL, \`repairProviderId\` VARCHAR(191) NOT NULL, \`repairRetrievalId\` VARCHAR(191) NULL,
    \`repairContentChecksum\` VARCHAR(191) NOT NULL, \`primaryContentChecksum\` VARCHAR(191) NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX \`HistoricalCandleRepairContribution_repairEvidenceId_candleTi_key\`(\`repairEvidenceId\`, \`candleTime\`, \`role\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  ALTER TABLE \`HistoricalDataRetrievalSession\` ADD CONSTRAINT \`HistoricalDataRetrievalSession_retrievalId_fkey\` FOREIGN KEY (\`retrievalId\`) REFERENCES \`HistoricalDataRetrieval\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleConflict\` ADD CONSTRAINT \`HistoricalCandleConflict_retrievalSessionId_fkey\` FOREIGN KEY (\`retrievalSessionId\`) REFERENCES \`HistoricalDataRetrievalSession\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleRepairEvidence\` ADD CONSTRAINT \`HistoricalCandleRepairEvidence_primarySessionId_fkey\` FOREIGN KEY (\`primarySessionId\`) REFERENCES \`HistoricalDataRetrievalSession\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleRepairEvidence\` ADD CONSTRAINT \`HistoricalCandleRepairEvidence_resultingSessionId_fkey\` FOREIGN KEY (\`resultingSessionId\`) REFERENCES \`HistoricalDataRetrievalSession\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleRepairSessionWindow\` ADD CONSTRAINT \`HistoricalCandleRepairSessionWindow_repairEvidenceId_fkey\` FOREIGN KEY (\`repairEvidenceId\`) REFERENCES \`HistoricalCandleRepairEvidence\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE \`HistoricalCandleRepairContribution\` ADD CONSTRAINT \`HistoricalCandleRepairContribution_repairEvidenceId_fkey\` FOREIGN KEY (\`repairEvidenceId\`) REFERENCES \`HistoricalCandleRepairEvidence\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
`;

async function disconnectBestEffort(client: PrismaClient): Promise<void> {
  try {
    await client.$disconnect();
  } catch {
    // best-effort
  }
}

/**
 * Research-only, MANUAL-VERIFICATION-ONLY B-F8 entrypoint (task invariant
 * J/M, corrected per blocker 3). Requires `HISTORICAL_CANDLE_TEST_REQUIRE=1`
 * and a `HISTORICAL_CANDLE_TEST_DATABASE_URL` that is genuinely distinct
 * from `DATABASE_URL` -- enforced by `assertSafeIsolatedTestDatabaseUrl`
 * BEFORE any connection is opened. Creates its OWN uniquely-named throwaway
 * database, applies the schema, runs one fixture-driven repair attempt, and
 * drops the database again. It is structurally impossible for this script to
 * write fixture data into the shared application database: it never reads
 * `DATABASE_URL` as a write target, only as the value it must NOT match.
 *
 * Usage (PowerShell):
 *   $env:HISTORICAL_CANDLE_TEST_REQUIRE = '1'
 *   $env:HISTORICAL_CANDLE_TEST_DATABASE_URL = 'mysql://root:pw@localhost:3306/'
 *   $env:RESEARCH_REPAIR_TRADING_DATE = '2022-03-07'
 *   $env:RESEARCH_REPAIR_FIXTURE_PATH = 'C:\path\to\missing-minutes.json'
 *   npm run research:nifty-gap-repair:fixture-verify
 */
async function run(): Promise<void> {
  if (process.env.HISTORICAL_CANDLE_TEST_REQUIRE !== '1') {
    throw new Error('HISTORICAL_CANDLE_TEST_REQUIRE=1 is required to run this manual verification script.');
  }
  // Captured once so the application DB env var is read exactly one time in this file's source text
  // (a source-text regression test enforces this) even though the MEDIUM-4 defense-in-depth
  // re-validation below calls the safety guard a second time, against the DERIVED write-target URL.
  const applicationDatabaseUrl = process.env.DATABASE_URL;
  assertSafeIsolatedTestDatabaseUrl(process.env.HISTORICAL_CANDLE_TEST_DATABASE_URL, applicationDatabaseUrl);
  const adminUrlRaw = process.env.HISTORICAL_CANDLE_TEST_DATABASE_URL!;

  const tradingDate = process.env.RESEARCH_REPAIR_TRADING_DATE?.trim();
  if (!tradingDate || !DATE_PATTERN.test(tradingDate)) {
    throw new Error('RESEARCH_REPAIR_TRADING_DATE is required and must be YYYY-MM-DD.');
  }
  const fixturePath = process.env.RESEARCH_REPAIR_FIXTURE_PATH?.trim();
  if (!fixturePath) {
    throw new Error('RESEARCH_REPAIR_FIXTURE_PATH is required.');
  }

  // MySQL identifiers are capped at 64 characters -- `research_gap_repair_fixture_verify_` (35 chars)
  // plus a full 32-hex-character UUID (67 total) exceeds that limit and MySQL rejects the CREATE
  // DATABASE statement outright (error 1059, confirmed via an actual isolated-MySQL run). 16 hex
  // characters (64 bits of randomness) keeps the name well under the limit while remaining
  // collision-safe for this manual, low-frequency verification workflow.
  const databaseName = `research_gap_repair_fixture_verify_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const base = new URL(adminUrlRaw);
  base.pathname = '/';
  const testUrl = new URL(adminUrlRaw);
  testUrl.pathname = `/${databaseName}`;
  // MEDIUM 4 CORRECTION (post-Terra-review): `HISTORICAL_CANDLE_TEST_DATABASE_URL` above is only the
  // ADMIN CONNECTION TARGET (typically an empty database-name path segment, used only to CREATE/DROP
  // the throwaway database) -- re-validating it does not, by itself, prove the ACTUAL TEST DATABASE
  // this script is about to write every table row into is safe. `testUrl` names that real write
  // target (the uniquely generated `databaseName`); re-running the same guard against it is the
  // concrete proof this script never issues a canonical/test table write against the application
  // database name, not merely against the admin URL a caller happened to supply.
  assertSafeIsolatedTestDatabaseUrl(testUrl.toString(), applicationDatabaseUrl);

  const admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
  await disconnectBestEffort(admin);

  const schema = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
  try {
    for (const statement of CREATE_TABLES_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop -- DDL statements must run in order
      await schema.$executeRawUnsafe(statement);
    }
  } finally {
    await disconnectBestEffort(schema);
  }

  const client = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
  let result: NiftyGapRepairResult;
  try {
    // HIGH 3 CORRECTION (post-Terra-review): BOTH the primary and repair
    // providers are explicit, deterministic fixture adapters -- never the
    // real `UpstoxHistoricalDataProviderService` a caller-omitted
    // `primaryProvider` used to default to. `buildSyntheticPrimaryRows`
    // derives the primary fixture's 372(-of-375) synthetic rows directly
    // from whichever exact timestamps the repair fixture file supplies, so
    // the two fixtures are always structurally consistent for any date.
    const repairFixtureRows = await loadFixtureRows(fixturePath);
    const { primaryRows, plannedDate } = buildSyntheticPrimaryRows(tradingDate, repairFixtureRows);
    const primaryProvider = new FixturePrimaryProvider(primaryRows);
    const repairProvider = new FixtureRepairProvider(repairFixtureRows);
    const plannerService = new FixturePlannerService(tradingDate, plannedDate);
    const service = new NiftyUnderlyingGapRepairService({
      primaryProvider,
      repairProvider,
      plannerService: plannerService as unknown as NiftyUnderlyingIngestionPlannerService,
      retrievalEvidenceService: new HistoricalDataRetrievalEvidenceService(client),
      repairEvidenceService: new HistoricalCandleRepairEvidenceService(client),
      researchPersistenceService: new HistoricalCandleResearchPersistenceService(client),
    });

    console.log(
      JSON.stringify({
        event: 'research:nifty-gap-repair:fixture-verify starting',
        tradingDate,
        isolatedDatabase: databaseName,
        primaryFixtureRowCount: primaryRows.length,
        repairFixtureRowCount: repairFixtureRows.length,
        note: 'Both the primary and repair providers are deterministic, network-free fixtures -- no Upstox/Groww provider is constructed by this script.',
      })
    );
    result = await service.repairSession({ tradingDate });
  } finally {
    await disconnectBestEffort(client);
    const dropper = new PrismaClient({ datasources: { db: { url: base.toString() } } });
    await dropper.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
    await disconnectBestEffort(dropper);
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, artifact: ARTIFACT_PATH, isolatedDatabase: databaseName, note: 'This result was written to a throwaway database that has already been dropped -- it never touched the shared application database.' }, null, 2));
}

// Only auto-executes when run directly -- never when imported (defense in depth, matching the
// operational CLI's own guard; this script is not currently imported anywhere).
if (require.main === module) {
  run().catch((error) => {
    console.error('B-F8 NIFTY underlying gap repair fixture-verify failed.', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
