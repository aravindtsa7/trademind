import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import NiftyUnderlyingGapRepairService, { NiftyGapRepairRepairProviderFetchFailedError } from './nifty-underlying-gap-repair.service';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';
import HistoricalCandleRepairEvidenceService from './historical-candle-repair-evidence.service';
import HistoricalCandleResearchPersistenceService from './historical-candle-research-persistence.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';
import NiftyUnderlyingIngestionPlannerService, { NiftyIngestionPlan, NiftyPlannedDate, NiftyPlannedDateDisposition } from './nifty-underlying-ingestion-planner.service';
import { HistoricalDataProvider, HistoricalOptionCandleRangeRequest, HistoricalUnderlyingCandleRangeRequest } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  Exchange,
  ExchangeSegment,
  expectedCanonicalTimestamps,
  expectedMinutesForWindow,
  HistoricalCandleRepairContributionRole,
  HistoricalCandleRepairOutcome,
  HistoricalSourceCandleRow,
  regularSessionWindow,
} from '../domain';
import GrowwHistoricalClient from '../providers/groww/groww-historical-client';
import GrowwUnderlyingHistoricalDataProviderService from '../providers/groww/groww-underlying-historical-data-provider.service';
import GrowwUnderlyingGapRepairProviderService from '../providers/groww/groww-underlying-gap-repair-provider.service';
import { GrowwValidatedCandleRow } from '../providers/groww/groww-historical-candle.dto';
import { candleContentEquals, CandleContentValue } from '../domain/historical-candle-content-identity';

/**
 * B-M10 Part 7 (D/E/F/G/I), extended by the targeted GROWW missing-minute
 * correction: proves the REAL production wiring -- the
 * `GrowwUnderlyingHistoricalDataProviderService` adapter AND the
 * repair-scoped `GrowwUnderlyingGapRepairProviderService` wrapper, called
 * through the UNCHANGED `NiftyUnderlyingGapRepairService` and UNCHANGED
 * `HistoricalCandleResearchPersistenceService` -- reproduce the exact
 * verified 2024-12-12 repair topology end-to-end. Only the HTTP transport is
 * faked (`GrowwHistoricalClient.fetchUnderlyingCandles` is stubbed with a
 * fixture responder); every other class in the chain is the real production
 * class. `NiftyUnderlyingGapRepairService`'s own generic repair-topology
 * behavior (duplicate/overlap/incomplete resolution rules) is already
 * exhaustively covered by `nifty-underlying-gap-repair.service.integration.test.ts`
 * -- this suite deliberately does not re-derive that matrix; it exists only
 * to prove the NEW adapter/wrapper participate in that already-proven
 * pipeline correctly, including the live-verified 15:30 IST boundary row and
 * the ROOT CAUSE of the first real REPAIR_CONFLICT attempt: Upstox NIFTY
 * index candles carry `openInterest = 0n` while Groww's carry `null`, so the
 * UNCHANGED `candleContentEquals` correctly treats every raw overlapping
 * minute as a genuine content conflict -- the repair-scoped wrapper fixes
 * this by never exposing an overlapping row at all, not by weakening that
 * comparison.
 *
 * ISOLATED test database only -- same convention as the sibling integration
 * suite (see that file's header doc). Never touches the application's
 * `DATABASE_URL` / the real `trademind` database. If
 * `HISTORICAL_CANDLE_TEST_DATABASE_URL` is not configured, every test below
 * self-skips with a clear reason.
 */

const adminUrlEnvVar = 'HISTORICAL_CANDLE_TEST_DATABASE_URL';
const requireEnvVar = 'HISTORICAL_CANDLE_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';

const forbiddenDatabaseNames = new Set(['trademind']);
// MySQL identifiers are capped at 64 characters -- a full 32-hex-character UUID plus a longer prefix
// exceeds that (confirmed via an actual isolated-MySQL run, error 1059), so this mirrors the same
// 16-hex-character convention `research-nifty-underlying-gap-repair-fixture-verify.ts` already uses.
const runSuffix = randomUUID().replace(/-/g, '').slice(0, 16);
const testDatabaseName = `research_groww_secondary_${runSuffix}`;
const testDatabaseNamePattern = /^research_groww_secondary_[0-9a-f]{16}$/;

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

// Identical schema to nifty-underlying-gap-repair.service.integration.test.ts (matches
// prisma/schema.prisma's HistoricalCandle model + the 4 B-F2C/B-F8 evidence models exactly).
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

  CREATE TABLE \`HistoricalCandleRepairEvidence\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`primaryRetrievalId\` VARCHAR(191) NOT NULL,
    \`primarySessionId\` VARCHAR(191) NOT NULL,
    \`repairProviderId\` VARCHAR(191) NOT NULL,
    \`repairRetrievalId\` VARCHAR(191) NULL,
    \`instrumentKey\` VARCHAR(191) NOT NULL,
    \`timeframe\` VARCHAR(191) NOT NULL,
    \`tradingDate\` VARCHAR(191) NOT NULL,
    \`calendarDisposition\` VARCHAR(191) NULL,
    \`repairPolicyVersion\` INTEGER NULL,
    \`primaryProviderId\` VARCHAR(191) NULL,
    \`expectedMinuteCount\` INTEGER NOT NULL,
    \`primaryAcceptedRowCount\` INTEGER NOT NULL,
    \`missingMinuteCount\` INTEGER NOT NULL,
    \`repairAcceptedMinuteCount\` INTEGER NOT NULL,
    \`corroboratedOverlapCount\` INTEGER NOT NULL,
    \`conflictingOverlapCount\` INTEGER NOT NULL,
    \`outcome\` VARCHAR(191) NOT NULL,
    \`resultingSessionId\` VARCHAR(191) NULL,
    \`missingMinutesChecksum\` VARCHAR(191) NOT NULL,
    \`repairSemanticChecksum\` VARCHAR(191) NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleRepairSessionWindow\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`repairEvidenceId\` VARCHAR(191) NOT NULL,
    \`windowIndex\` INTEGER NOT NULL,
    \`openMinuteIst\` INTEGER NOT NULL,
    \`closeMinuteIst\` INTEGER NOT NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX \`HistoricalCandleRepairSessionWindow_repairEvidenceId_windowI_key\`(\`repairEvidenceId\`, \`windowIndex\`),
    PRIMARY KEY (\`id\`)
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE TABLE \`HistoricalCandleRepairContribution\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`repairEvidenceId\` VARCHAR(191) NOT NULL,
    \`candleTime\` DATETIME(3) NOT NULL,
    \`role\` VARCHAR(191) NOT NULL,
    \`repairProviderId\` VARCHAR(191) NOT NULL,
    \`repairRetrievalId\` VARCHAR(191) NULL,
    \`repairContentChecksum\` VARCHAR(191) NOT NULL,
    \`primaryContentChecksum\` VARCHAR(191) NULL,
    \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX \`HistoricalCandleRepairContribution_repairEvidenceId_idx\`(\`repairEvidenceId\`),
    INDEX \`HistoricalCandleRepairContribution_candleTime_idx\`(\`candleTime\`),
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

// ---- Fakes -------------------------------------------------------------------

class FakePlanner {
  constructor(private readonly plannedByDate: Map<string, NiftyPlannedDate>) {}

  async buildPlan(request: { fromDate: string; toDate: string }): Promise<NiftyIngestionPlan> {
    const planned = this.plannedByDate.get(request.fromDate);
    if (!planned) throw new Error(`FakePlanner: no planned date registered for ${request.fromDate}`);
    return {
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      exchange: Exchange.NSE,
      calendarSegment: ExchangeSegment.EQUITY,
      requestedFromDate: request.fromDate,
      requestedToDate: request.toDate,
      dates: [planned],
      providerRequestChunks: [],
      totalCalendarDateCount: 1,
      totalExpectedCandles: planned.expectedMinuteCount,
      regularTradingDateCount: 1,
      specialSessionDateCount: 0,
      closedDateCount: 0,
      blockedDateCount: 0,
      hasBlockedDates: false,
    };
  }
}

function regularPlannedDate(tradingDate: string): NiftyPlannedDate {
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

/** Deterministic, non-network, never-Upstox stand-in for the PRIMARY provider -- this suite's own fixture, exactly like `FixturePrimaryProvider` in the manual fixture-verify script. */
class FakePrimaryProvider implements HistoricalDataProvider {
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
      rateLimitPolicy: { policyId: 'FAKE_PRIMARY_PROVIDER' },
    };
  }

  async fetchCompletedUnderlyingRange(_request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    return this.rows;
  }

  async fetchExpiredOptionRange(_request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('FakePrimaryProvider does not support option candles.');
  }
}

/** Stubs ONLY the HTTP transport (`GrowwHistoricalClient.fetchUnderlyingCandles`) -- the REAL `GrowwUnderlyingHistoricalDataProviderService` adapter wraps this, exactly as it would wrap a real network client. No axios/network call is ever made. */
function fakeGrowwClient(rows: readonly GrowwValidatedCandleRow[]): GrowwHistoricalClient {
  return { fetchUnderlyingCandles: async () => rows } as unknown as GrowwHistoricalClient;
}

/**
 * Upstox-realistic primary content: `openInterest = 0n` -- the exact
 * locked ROOT CAUSE fact ("Upstox NIFTY index: openInterest = 0n"). OHLC/
 * volume are deterministic per index; only OI is vendor-specific.
 */
function primaryContentFor(index: number): { open: number; high: number; low: number; close: number; volume: bigint; openInterest: bigint } {
  return { open: 24600 + index, high: 24601 + index, low: 24599 + index, close: 24600.5 + index, volume: 0n, openInterest: 0n };
}

/**
 * Groww-realistic content: `openInterest = null` -- the exact locked ROOT
 * CAUSE fact ("Groww NIFTY index: openInterest = null"), and the ONLY value
 * `GrowwUnderlyingHistoricalDataProviderService` ever accepts (it fails
 * closed on any non-null OI for NIFTY_INDEX). Same OHLC/volume formula as
 * `primaryContentFor` so a deliberately-unwrapped-adapter test's ONLY
 * content difference at an overlapping minute is the OI field, exactly
 * matching the real production observation.
 */
function contentFor(index: number): { open: number; high: number; low: number; close: number; volume: bigint; openInterest: null } {
  return { open: 24600 + index, high: 24601 + index, low: 24599 + index, close: 24600.5 + index, volume: 0n, openInterest: null };
}

function regularTimestamps(tradingDate: string): readonly Date[] {
  return expectedCanonicalTimestamps(tradingDate, expectedMinutesForWindow(regularSessionWindow()));
}

/** The certified regular session's 375 canonical minute indices, minus every index in `missingIndices` -- matching the real B-M10 2024-12-12 acquisition shape (providerRowsReceived 92519 systemwide, this one date short exactly one minute) when given a single missing index. */
function primaryRowsMissing(tradingDate: string, missingIndices: readonly number[]): HistoricalSourceCandleRow[] {
  const timestamps = regularTimestamps(tradingDate);
  const missing = new Set(missingIndices);
  const indices = Array.from({ length: 375 }, (_, i) => i).filter((i) => !missing.has(i));
  return indices.map((index, sourceIndex) => ({ sourceIndex, candleTime: timestamps[index], ...primaryContentFor(index) }));
}

/** The full, complete 375-row certified regular session -- no gap at all. */
function primaryRowsComplete(tradingDate: string): HistoricalSourceCandleRow[] {
  return primaryRowsMissing(tradingDate, []);
}

/**
 * A live-shaped Groww CASH response: minute-of-day 555 (09:15) through 930
 * (15:30) inclusive -- 376 rows, matching the B-M10 live-verified boundary
 * behavior exactly. `contentOverrides` lets a test substitute specific
 * day-indices' OHLC (e.g. a deliberate conflict). Every ordinary index uses
 * `contentFor` (OI = null) -- the SAME OHLC/volume as `primaryContentFor`
 * but with Groww's real `openInterest = null`, so exposing the full
 * (unwrapped) adapter directly as a repair provider reproduces the real
 * OI-mismatch conflict on every overlapping minute, exactly as observed in
 * the first real repair attempt.
 */
function growwFullDayRows(tradingDate: string, contentOverrides: ReadonlyMap<number, ReturnType<typeof contentFor>> = new Map(), omitIndices: ReadonlySet<number> = new Set()): GrowwValidatedCandleRow[] {
  const dayStartUtcMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const rows: GrowwValidatedCandleRow[] = [];
  for (let minuteOfDay = 555; minuteOfDay <= 930; minuteOfDay += 1) {
    const dayIndex = minuteOfDay - 555; // 0..374 real session minutes, 375 == the 15:30 boundary row
    if (omitIndices.has(dayIndex)) continue;
    const candleTime = new Date(dayStartUtcMs + minuteOfDay * 60_000); // minuteOfDay, never dayIndex -- candle time is minutes since IST midnight
    const content = contentOverrides.get(dayIndex) ?? (dayIndex < 375 ? contentFor(dayIndex) : { open: 0, high: 0, low: 0, close: 0, volume: 0n, openInterest: null });
    rows.push({ candleTime, ...content });
  }
  return rows;
}

/** Counts invocations of `fetchCompletedUnderlyingRange` on a wrapped `HistoricalDataProvider` without altering its behavior -- proves a repair provider was (or was not) actually engaged, independent of/in addition to the result's own `repairRetrievalId` signal. */
function countingProvider(delegate: HistoricalDataProvider): { provider: HistoricalDataProvider; callCount: () => number } {
  let calls = 0;
  const provider: HistoricalDataProvider = {
    providerId: delegate.providerId,
    getCapability: () => delegate.getCapability(),
    fetchCompletedUnderlyingRange: async (request) => {
      calls += 1;
      return delegate.fetchCompletedUnderlyingRange(request);
    },
    fetchExpiredOptionRange: (request) => delegate.fetchExpiredOptionRange(request),
  };
  return { provider, callCount: () => calls };
}

function newRepairService(
  planned: NiftyPlannedDate,
  primaryRows: readonly HistoricalSourceCandleRow[],
  repairProvider: HistoricalDataProvider
): { service: NiftyUnderlyingGapRepairService; client: PrismaClient } {
  const client = newClient();
  const planner = new FakePlanner(new Map([[planned.tradingDate, planned]]));
  const primaryProvider = new FakePrimaryProvider(primaryRows);
  const service = new NiftyUnderlyingGapRepairService({
    primaryProvider,
    repairProvider,
    plannerService: planner as unknown as NiftyUnderlyingIngestionPlannerService,
    retrievalEvidenceService: new HistoricalDataRetrievalEvidenceService(client),
    repairEvidenceService: new HistoricalCandleRepairEvidenceService(client),
    researchPersistenceService: new HistoricalCandleResearchPersistenceService(client),
  });
  return { service, client };
}

async function findPersistedCandles(client: PrismaClient, tradingDate: string) {
  const from = new Date(`${tradingDate}T00:00:00+05:30`);
  const to = new Date(`${tradingDate}T23:59:59.999+05:30`);
  return client.historicalCandle.findMany({ where: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, candleTime: { gte: from, lte: to } } });
}

const MISSING_INDEX = 27; // 09:15 + 27 minutes == 09:42 IST, the exact live-verified missing minute

function newWrappedRepairProvider(growwRows: readonly GrowwValidatedCandleRow[], expectedMissingMinuteUtc: Date): GrowwUnderlyingGapRepairProviderService {
  const delegate = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient(growwRows));
  return new GrowwUnderlyingGapRepairProviderService(delegate, expectedMissingMinuteUtc);
}

// ---- ROOT CAUSE regression: the UNWRAPPED adapter reproduces the real REPAIR_CONFLICT ----

test('ROOT CAUSE: exposing the full (unwrapped) Groww adapter directly as repairProvider reproduces the real REPAIR_CONFLICT -- every overlapping minute conflicts on openInterest (Upstox 0n vs Groww null) even though all OHLC/volume prices agree', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-11';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX]); // 374 rows, openInterest = 0n (Upstox-realistic)
  const growwRows = growwFullDayRows(tradingDate); // 376 rows, openInterest = null (Groww-realistic) -- OHLC/volume identical to primary at every overlapping index
  const repairProvider = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient(growwRows)); // UNWRAPPED -- the exact misconfiguration the first real attempt used

  // Independent proof, using the UNCHANGED candleContentEquals directly (never modified by this
  // correction): a primary row (OI=0n) and the corresponding Groww row (OI=null) at the SAME
  // overlapping timestamp are NOT content-equal, which is the root cause explaining every conflict below.
  const overlapIndex = 100;
  const primaryContentValue: CandleContentValue = { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, candleTime: regularTimestamps(tradingDate)[overlapIndex], ...primaryContentFor(overlapIndex) };
  const growwContentValue: CandleContentValue = { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, candleTime: regularTimestamps(tradingDate)[overlapIndex], ...contentFor(overlapIndex) };
  assert.equal(candleContentEquals(primaryContentValue, growwContentValue), false, 'candleContentEquals (unmodified) correctly treats 0n openInterest and null openInterest as different content');

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_CONFLICT);
  assert.ok(result.conflictingOverlapCount !== undefined && result.conflictingOverlapCount > 300, `expected the full session's overlapping minutes to conflict on OI mismatch; got conflictingOverlapCount=${result.conflictingOverlapCount}`);
  assert.equal(result.persisted, false);
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});

// ---- 8: successful B-M10 topology via the repair-scoped wrapper -----------

test('8: repair-scoped wrapper supplies exactly the missing 09:42 minute from a live-shaped 376-row Groww day -> REPAIR_ACCEPTED, exactly 375 persisted, 09:42 attributed to GROWW, boundary row never persisted, zero conflicts', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-12';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX]); // 374 rows, openInterest = 0n
  const growwRows = growwFullDayRows(tradingDate); // 376 rows, openInterest = null -- the wrapper narrows this to exactly 1 row
  const repairedTimestamp = regularTimestamps(tradingDate)[MISSING_INDEX];
  const repairProvider = newWrappedRepairProvider(growwRows, repairedTimestamp);

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_ACCEPTED);
  assert.equal(result.missingMinuteCount, 1);
  assert.equal(result.repairAcceptedMinuteCount, 1);
  assert.equal(result.conflictingOverlapCount, 0, 'the wrapper never exposes an overlapping row, so the OI mismatch never has a chance to conflict');
  assert.equal(result.corroboratedOverlapCount, 0);
  assert.equal(result.persisted, true);
  assert.ok(result.resultingSessionId);

  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 375, 'exactly the certified 375 canonical minutes -- the Groww 15:30 boundary row must never be persisted');
  const boundaryTimestamp = new Date(new Date(`${tradingDate}T00:00:00+05:30`).getTime() + 930 * 60_000); // 15:30 IST == minute 930
  assert.equal(persisted.some((row) => row.candleTime.getTime() === boundaryTimestamp.getTime()), false);

  const repairedRow = persisted.find((row) => row.candleTime.getTime() === repairedTimestamp.getTime());
  assert.ok(repairedRow, '09:42 IST must be present in the persisted composite session');
  assert.equal(repairedRow?.openInterest?.toString() ?? null, null, 'the persisted repaired minute keeps Groww\'s real (untouched) null OI -- never normalized to 0n');

  const repairEvidence = await client.historicalCandleRepairEvidence.findMany({ where: { tradingDate } });
  assert.equal(repairEvidence.length, 1);
  const contributions = await client.historicalCandleRepairContribution.findMany({ where: { repairEvidenceId: repairEvidence[0].id, candleTime: repairedTimestamp } });
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].role, HistoricalCandleRepairContributionRole.REPAIR_FILLED_MISSING);
  assert.equal(contributions[0].repairProviderId, HistoricalProviderId.GROWW);

  // All other 374 accepted-session minutes remain primary (UPSTOX) provenance -- no HistoricalCandleRepairContribution row exists for any of them.
  const allContributions = await client.historicalCandleRepairContribution.findMany({ where: { repairEvidenceId: repairEvidence[0].id } });
  assert.equal(allContributions.length, 1, 'exactly one contribution row -- only the repaired minute, never the 374 primary-provenance minutes');
});

// ---- 4: wrong operator candidate, a genuine additional gap remains -> REPAIR_INCOMPLETE ----

test('4: operator authorizes 09:42 correctly, but primary ALSO unexpectedly misses a different minute -> merged session still incomplete, zero persistence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-20';
  const planned = regularPlannedDate(tradingDate);
  const otherMissingIndex = 200;
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX, otherMissingIndex]); // TWO real gaps, operator only knows about one
  const growwRows = growwFullDayRows(tradingDate);
  const repairedTimestamp = regularTimestamps(tradingDate)[MISSING_INDEX];
  const repairProvider = newWrappedRepairProvider(growwRows, repairedTimestamp); // authorized candidate exists and is genuinely correct for THIS minute

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_INCOMPLETE, 'the authorized candidate alone cannot resolve a session with a SECOND, unauthorized gap');
  assert.equal(result.persisted, false);
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});

// ---- 9: wrong operator candidate entirely -> lands on an already-accepted primary minute -> REPAIR_CONFLICT ----

test('9: primary is NOT actually missing the operator-authorized minute (it is missing a different one) -> the authorized candidate overlaps an already-accepted primary row and conflicts on OI -> REPAIR_CONFLICT, zero persistence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-21';
  const planned = regularPlannedDate(tradingDate);
  const actualMissingIndex = 200; // primary's REAL gap
  const primaryRows = primaryRowsMissing(tradingDate, [actualMissingIndex]); // index 27 (09:42) IS already present in primary
  const growwRows = growwFullDayRows(tradingDate);
  const wrongAuthorizedTimestamp = regularTimestamps(tradingDate)[MISSING_INDEX]; // operator wrongly authorized 09:42
  const repairProvider = newWrappedRepairProvider(growwRows, wrongAuthorizedTimestamp);

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_CONFLICT, 'the wrongly-authorized candidate overlaps an already-accepted primary minute with a different OI -> conflict, never a silent/incorrect accept');
  assert.equal(result.persisted, false);
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});

// ---- 10: primary unexpectedly already complete -> repair provider never engaged --------

test('10: primary re-fetch is already complete (375/375) -> repair provider is NEVER called, no duplicate/composite repair is created, primary persists via REPAIR_NOT_ATTEMPTED', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-22';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsComplete(tradingDate); // no gap at all
  const growwRows = growwFullDayRows(tradingDate);
  const repairedTimestamp = regularTimestamps(tradingDate)[MISSING_INDEX];
  const { provider: repairProvider, callCount } = countingProvider(newWrappedRepairProvider(growwRows, repairedTimestamp));

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED);
  assert.equal(result.persisted, true);
  assert.equal(result.repairRetrievalId, undefined, 'no repair retrieval was ever started');
  assert.equal(callCount(), 0, 'the repair-scoped Groww provider must never be called when the primary is already complete');

  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 375);
  const repairEvidence = await client.historicalCandleRepairEvidence.findMany({ where: { tradingDate } });
  assert.equal(repairEvidence.length, 0, 'no repair evidence row is created when no repair was attempted');
});

/** Walks a chain of `.cause` (or `.cause.cause`, ...) links -- `withHistoricalProviderRetry` wraps a PERMANENT error in its own `HistoricalProviderPermanentError`, which `NiftyUnderlyingGapRepairService` wraps AGAIN in `NiftyGapRepairRepairProviderFetchFailedError` -- and returns the first message matching `pattern`, or `undefined`. */
function findCauseMessageMatching(error: unknown, pattern: RegExp): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      if (pattern.test(current.message)) return current.message;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

// ---- 2 (integration): candidate absent -- Groww secondary omits the authorized 09:42 minute ----

test('2 (integration): Groww secondary response omits the authorized 09:42 minute -> the wrapper fails closed (zero candidates), the repair-provider fetch fails, zero persistence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-13';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX]);
  const growwRows = growwFullDayRows(tradingDate, new Map(), new Set([MISSING_INDEX])); // 09:42 never supplied by the secondary either
  const repairedTimestamp = regularTimestamps(tradingDate)[MISSING_INDEX];
  const repairProvider = newWrappedRepairProvider(growwRows, repairedTimestamp);

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  await assert.rejects(service.repairSession({ tradingDate }), (error: unknown) => {
    assert.ok(error instanceof NiftyGapRepairRepairProviderFetchFailedError);
    assert.ok(findCauseMessageMatching(error, /zero repair candidates/i), 'expected the wrapper\'s "zero repair candidates" fail-closed message somewhere in the error cause chain');
    return true;
  });
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});

// ---- F (integration): duplicate candidate for the same missing minute (via the wrapper) ----

test('F: two Groww candles exist at the SAME authorized missing 09:42 timestamp -> the wrapper itself fails closed, the repair-provider fetch fails, zero persistence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-14';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX]);
  const growwRows = [...growwFullDayRows(tradingDate)];
  const duplicateCandleTime = regularTimestamps(tradingDate)[MISSING_INDEX]; // the same 09:42 timestamp growwFullDayRows already supplies one (correct) candidate for
  // A second, differently-priced row at the exact same missing timestamp -- the client never dedupes (see the adapter's own doc), so the wrapper's own duplicate-candidate rule fires.
  growwRows.push({ candleTime: duplicateCandleTime, ...contentFor(MISSING_INDEX), open: 99999 });
  const repairProvider = newWrappedRepairProvider(growwRows, duplicateCandleTime);

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  await assert.rejects(service.repairSession({ tradingDate }), (error: unknown) => {
    assert.ok(error instanceof NiftyGapRepairRepairProviderFetchFailedError);
    assert.ok(findCauseMessageMatching(error, /duplicate candidate/i), 'expected the wrapper\'s "duplicate candidate" fail-closed message somewhere in the error cause chain');
    return true;
  });
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});

// ---- G: conflicting overlap with an already-accepted primary minute (unwrapped) -------

test('G: Groww secondary disagrees with an already-accepted primary minute (not the missing one, unwrapped full response) -> REPAIR_CONFLICT, zero persistence', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const tradingDate = '2024-12-16';
  const planned = regularPlannedDate(tradingDate);
  const primaryRows = primaryRowsMissing(tradingDate, [MISSING_INDEX]);
  const conflictingIndex = 50; // an ordinary already-accepted primary minute, distinct from the missing one
  const growwRows = growwFullDayRows(tradingDate, new Map([[conflictingIndex, { ...contentFor(conflictingIndex), close: contentFor(conflictingIndex).close + 500 }]]));
  const repairProvider = new GrowwUnderlyingHistoricalDataProviderService(fakeGrowwClient(growwRows));

  const { service, client } = newRepairService(planned, primaryRows, repairProvider);
  const result = await service.repairSession({ tradingDate });

  assert.equal(result.outcome, HistoricalCandleRepairOutcome.REPAIR_CONFLICT);
  assert.equal(result.persisted, false);
  const persisted = await findPersistedCandles(client, tradingDate);
  assert.equal(persisted.length, 0);
});
