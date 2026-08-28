import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import ExchangeCalendarRepository, {
  ExchangeCalendarImportStatusError,
  ExchangeCalendarLifecycleError,
  ExchangeCalendarVersionConflictError,
} from './exchange-calendar.repository';
import { CalendarClassification, CalendarCoverageStatus, Exchange, ExchangeSegment, ExplicitCalendarClassification, SourceDocumentType } from '../domain/exchange-calendar.types';
import { computeCoverageSourceBundleChecksum, NormalizedCoverageContent } from '../domain/exchange-calendar-checksum';
import { ExchangeCalendarCoverageFixture, validateAndNormalizeCoverageFixture } from '../domain/exchange-calendar-fixture.types';
import ExchangeCalendarResolverService from '../services/exchange-calendar-resolver.service';

const execFileAsync = promisify(execFile);
const adminUrlEnvVar = 'EXCHANGE_CALENDAR_TEST_DATABASE_URL';
const requireEnvVar = 'EXCHANGE_CALENDAR_TEST_REQUIRE';
const requireIntegration = process.env[requireEnvVar] === '1';
const forbiddenDatabaseNames = new Set(['trademind']);
const testDatabaseName = `exchange_calendar_repo_test_${randomUUID().replace(/-/g, '')}`;
const testDatabaseNamePattern = /^exchange_calendar_repo_test_[0-9a-f]{32}$/;
const migrationName = '20260829120000_add_exchange_calendar_core';

function assertSafeTestDatabaseName(name: string): void {
  if (forbiddenDatabaseNames.has(name.toLowerCase()) || !testDatabaseNamePattern.test(name)) {
    throw new Error(`Refusing to operate on unsafe test database name '${name}'.`);
  }
}

function requireAdminUrl(): string {
  const adminUrlRaw = process.env[adminUrlEnvVar];
  if (!adminUrlRaw) throw new Error(`${adminUrlEnvVar} is not set; the suite never falls back to DATABASE_URL.`);
  if (process.env.DATABASE_URL && adminUrlRaw === process.env.DATABASE_URL) throw new Error(`${adminUrlEnvVar} must not equal DATABASE_URL.`);
  const adminUrl = new URL(adminUrlRaw);
  const adminPath = adminUrl.pathname.replace(/^\//, '');
  if (adminPath && forbiddenDatabaseNames.has(adminPath.toLowerCase())) throw new Error(`${adminUrlEnvVar} points at a forbidden database.`);
  return adminUrlRaw;
}

function deriveUrls(name: string): { baseUrl: string; testUrl: string } {
  assertSafeTestDatabaseName(name);
  const adminUrlRaw = requireAdminUrl();
  const base = new URL(adminUrlRaw);
  base.pathname = '/';
  const target = new URL(adminUrlRaw);
  target.pathname = `/${name}`;
  return { baseUrl: base.toString(), testUrl: target.toString() };
}

async function disconnectBestEffort(client: PrismaClient): Promise<void> {
  try {
    await client.$disconnect();
  } catch {
    // Best-effort cleanup only; the throwaway database name remains guarded.
  }
}

async function createTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
  } finally {
    await disconnectBestEffort(admin);
  }
}

async function dropTestDatabase(baseUrl: string, name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE \`${name}\``);
  } finally {
    await disconnectBestEffort(admin);
  }
}

async function applyActualMigrationChain(testUrl: string): Promise<void> {
  const prismaCli = resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', resolve(process.cwd(), 'prisma', 'schema.prisma')], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl },
    windowsHide: true,
  });
}

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

function newRepository(): ExchangeCalendarRepository {
  return new ExchangeCalendarRepository(newClient());
}

/**
 * Test-only real-MySQL transaction fault-injection seam (see H/K below).
 *
 * WHY THIS EXISTS: the original H/K fault injection used a real MySQL
 * `CREATE TRIGGER` sent via `client.$executeRawUnsafe`. MySQL 8.0 rejects
 * `CREATE TRIGGER` with error 1295 ("This command is not supported in the
 * prepared statement protocol yet") because Prisma's query engine always
 * dispatches raw SQL through the binary/prepared-statement protocol, which
 * MySQL has never supported for `CREATE`/`DROP TRIGGER` -- this is a MySQL
 * client-protocol limitation of the TEST HARNESS's chosen fault-injection
 * mechanism, not a defect in `ExchangeCalendarRepository` (see the final
 * report for the full analysis).
 *
 * This replacement injects the fault via Prisma Client's own `$use()` query
 * middleware instead of DDL, registered on a PRIVATE, per-call
 * `PrismaClient` (never the shared `defaultPrismaClient` production
 * singleton, and never reachable from any production code path or
 * configuration -- it exists only inside this test file). Prisma dispatches
 * every query issued through an interactive `$transaction(async (tx) => ...)`
 * callback through the SAME middleware stack as the top-level client
 * (`MiddlewareParams.runInTransaction` exists specifically to let
 * middleware observe this), so `matches` can target one exact statement
 * occurring PARTWAY THROUGH a real, live `ExchangeCalendarRepository`
 * transaction -- every statement before the match still executes for real
 * against the real MySQL database; the injected `Error` is thrown instead of
 * forwarding to `next()`, which aborts the enclosing `$transaction` exactly
 * as a genuine mid-transaction database error would, causing a real MySQL
 * ROLLBACK of everything the transaction had done so far.
 */
function newFaultInjectingRepository(matches: (params: Prisma.MiddlewareParams) => boolean, errorMessage: string): ExchangeCalendarRepository {
  const client = newClient();
  let injected = false;
  client.$use(async (params, next) => {
    if (!injected && matches(params)) {
      injected = true;
      throw new Error(errorMessage);
    }
    return next(params);
  });
  return new ExchangeCalendarRepository(client);
}

test.before(async () => {
  try {
    const urls = deriveUrls(testDatabaseName);
    testUrl = urls.testUrl;
    adminBaseUrl = urls.baseUrl;
    await createTestDatabase(adminBaseUrl, testDatabaseName);
    databaseCreated = true;
    await applyActualMigrationChain(testUrl);
    const probe = newClient();
    await probe.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch (error) {
    if (requireIntegration) throw error;
    databaseAvailable = false;
  }
});

test.after(async () => {
  for (const client of trackedClients) await disconnectBestEffort(client);
  if (databaseCreated) await dropTestDatabase(adminBaseUrl, testDatabaseName);
});

function skipReason(): string {
  return `Set ${adminUrlEnvVar} to a dedicated MySQL admin URL; ${requireEnvVar}=1 makes setup failures fatal.`;
}

let nextSyntheticYear = 2101;
function uniqueYear(): number {
  return nextSyntheticYear++;
}

function fixture(year: number, overrides: Partial<ExchangeCalendarCoverageFixture> = {}): ExchangeCalendarCoverageFixture {
  const documentReference = `SYN-DOC-${randomUUID()}`;
  return {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: year,
    coverageFrom: `${year}-01-01`,
    coverageTo: `${year}-12-31`,
    version: 1,
    status: CalendarCoverageStatus.DRAFT,
    sourceAuthority: 'SYNTHETIC_AUTHORITY',
    sourceDocuments: [
      {
        documentReference,
        documentType: SourceDocumentType.ANNUAL_HOLIDAY_CIRCULAR,
        contentChecksumSha256: 'a'.repeat(64),
      },
    ],
    days: [],
    ...overrides,
  };
}

async function importFixture(repository: ExchangeCalendarRepository, input: ExchangeCalendarCoverageFixture) {
  const normalized = validateAndNormalizeCoverageFixture(input);
  return repository.importCoverage(normalized, input.status, computeCoverageSourceBundleChecksum(normalized));
}

async function activate(repository: ExchangeCalendarRepository, input: ExchangeCalendarCoverageFixture) {
  return repository.activateCertifiedVersion({
    exchange: input.exchange,
    segment: input.segment,
    calendarYear: input.calendarYear,
    version: input.version,
  });
}

test('repository rejects malformed NormalizedCoverageContent before any Prisma call', async () => {
  const repository = new ExchangeCalendarRepository({} as PrismaClient);
  const malformed: NormalizedCoverageContent = {
    exchange: Exchange.NSE,
    segment: ExchangeSegment.EQUITY,
    calendarYear: 2031,
    coverageFrom: '2031-02-29',
    coverageTo: '2031-12-31',
    version: 1,
    sourceAuthority: 'SYNTHETIC_AUTHORITY',
    sourceDocuments: [],
    days: [],
  };
  await assert.rejects(() => repository.importCoverage(malformed, CalendarCoverageStatus.DRAFT, '0'.repeat(64)), /not a valid YYYY-MM-DD/);
});

test('A: actual Prisma migration chain applies the calendar migration artifact', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const client = newClient();
  const rows = await client.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
    SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = ${migrationName}`;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].finished_at);
});

test('B/F: DRAFT import atomically persists children and exceptional provenance resolves after activation', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const input = fixture(year, {
    sourceDocuments: [
      {
        documentReference,
        documentType: SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
        contentChecksumSha256: 'b'.repeat(64),
        referenceUrl: 'https://synthetic.invalid/navigation-only',
      },
    ],
    days: [
      {
        tradingDate: `${year}-01-04`,
        classification: ExplicitCalendarClassification.SPECIAL_SESSION,
        sourceDocumentReference: documentReference,
        windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 780 }],
      },
    ],
  });
  const imported = await importFixture(repository, input);
  assert.equal(imported.kind, 'CREATED');
  assert.equal((await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, year, 1))?.status, CalendarCoverageStatus.DRAFT);
  await activate(repository, input);
  const resolution = await new ExchangeCalendarResolverService(repository).resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, `${year}-01-04`);
  assert.equal(resolution.classification, ExplicitCalendarClassification.SPECIAL_SESSION);
  assert.deepEqual(resolution.sourceDocument, {
    documentReference,
    documentType: SourceDocumentType.SPECIAL_SESSION_CIRCULAR,
    contentChecksumSha256: 'b'.repeat(64),
    referenceUrl: 'https://synthetic.invalid/navigation-only',
  });
});

test('C: identical DRAFT import is idempotent against real unique constraints', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const input = fixture(uniqueYear());
  const first = await importFixture(repository, input);
  const second = await importFixture(repository, input);
  assert.equal(second.kind, 'IDENTICAL_NOOP');
  assert.equal(second.coverageId, first.coverageId);
});

test('D: same year-scoped version with changed content rejects', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const input = fixture(year);
  await importFixture(repository, input);
  await assert.rejects(() => importFixture(repository, { ...input, sourceAuthority: 'CHANGED_SYNTHETIC_AUTHORITY' }), ExchangeCalendarVersionConflictError);
});

test('status idempotency: an activated version cannot be re-imported as an identical DRAFT no-op', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const input = fixture(uniqueYear());
  await importFixture(repository, input);
  await activate(repository, input);
  await assert.rejects(() => importFixture(repository, input), ExchangeCalendarImportStatusError);
});

test('E/G: same-coverage provenance FK persists and an unknown source FK is rejected', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const input = fixture(year, {
    sourceDocuments: [
      {
        documentReference,
        documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
        contentChecksumSha256: 'c'.repeat(64),
      },
    ],
    days: [
      {
        tradingDate: `${year}-02-10`,
        classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE,
        sourceDocumentReference: documentReference,
      },
    ],
  });
  const imported = await importFixture(repository, input);
  const persisted = await repository.findExplicitDay(imported.coverageId, `${year}-02-10`);
  assert.equal(persisted?.sourceDocument?.documentReference, documentReference);

  const client = newClient();
  const supportingDocument = await client.exchangeCalendarSourceDocument.findFirstOrThrow({
    where: { coverageId: imported.coverageId, documentReference },
  });
  await assert.rejects(() => client.exchangeCalendarSourceDocument.delete({ where: { id: supportingDocument.id } }));
  await assert.rejects(() =>
    client.exchangeCalendarDay.create({
      data: {
        coverageId: imported.coverageId,
        tradingDate: new Date(`${year}-02-11T00:00:00.000Z`),
        classification: ExplicitCalendarClassification.EXCHANGE_HOLIDAY,
        sourceDocumentId: randomUUID(),
      },
    })
  );
});

test('H: child-insert database failure rolls back parent, documents, days, and windows', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const client = newClient();
  const before = {
    coverages: await client.exchangeCalendarCoverage.count(),
    documents: await client.exchangeCalendarSourceDocument.count(),
    days: await client.exchangeCalendarDay.count(),
    windows: await client.exchangeCalendarSessionWindow.count(),
  };

  // The parent ExchangeCalendarCoverage row is created by real MySQL earlier
  // in importCoverage's transaction, before the source-document insert loop
  // ever runs -- so by the time this fault fires, the parent insert already
  // genuinely happened against the live database.
  const faultingRepository = newFaultInjectingRepository(
    (params) => params.model === 'ExchangeCalendarSourceDocument' && params.action === 'create',
    'TEST_ONLY_FORCED_CHILD_INSERT_FAILURE'
  );
  await assert.rejects(() => importFixture(faultingRepository, fixture(uniqueYear())), /TEST_ONLY_FORCED_CHILD_INSERT_FAILURE/);

  assert.deepEqual(
    {
      coverages: await client.exchangeCalendarCoverage.count(),
      documents: await client.exchangeCalendarSourceDocument.count(),
      days: await client.exchangeCalendarDay.count(),
      windows: await client.exchangeCalendarSessionWindow.count(),
    },
    before
  );
});

test('I: DRAFT activates to the sole CERTIFIED version and repeated activation is an honest no-op', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const input = fixture(uniqueYear());
  await importFixture(repository, input);
  assert.equal((await activate(repository, input)).kind, 'ACTIVATED');
  assert.equal((await activate(repository, input)).kind, 'ALREADY_CERTIFIED_NOOP');
});

test('certification refuses a DRAFT that has no immutable source provenance', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const input = fixture(uniqueYear(), { sourceDocuments: [], days: [] });
  await importFixture(repository, input);
  await assert.rejects(() => activate(repository, input), /requires at least one immutable source document/);
  assert.equal(
    (await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, input.calendarYear, input.version))?.status,
    CalendarCoverageStatus.DRAFT
  );
});

test('J: activation atomically deprecates certified v1 and certifies corrected DRAFT v2', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const v1 = fixture(year, { version: 1 });
  const v2 = fixture(year, { version: 2, sourceAuthority: 'SYNTHETIC_AUTHORITY_V2' });
  await importFixture(repository, v1);
  await activate(repository, v1);
  await importFixture(repository, v2);
  assert.equal((await activate(repository, v2)).kind, 'REPLACED');
  assert.equal((await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, year, 1))?.status, CalendarCoverageStatus.DEPRECATED);
  assert.equal((await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, year, 2))?.status, CalendarCoverageStatus.CERTIFIED);
  await assert.rejects(() => activate(repository, v1), ExchangeCalendarLifecycleError);
});

test('K: forced activation failure rolls back deprecation and leaves target DRAFT', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const v1 = fixture(year, { version: 1 });
  const v2 = fixture(year, { version: 2, sourceAuthority: 'SYNTHETIC_AUTHORITY_V2' });
  await importFixture(repository, v1);
  await activate(repository, v1);
  await importFixture(repository, v2);

  // activateCertifiedVersion issues the v1 CERTIFIED->DEPRECATED updateMany
  // (data.status === DEPRECATED) BEFORE the v2 DRAFT->CERTIFIED updateMany
  // (data.status === CERTIFIED). Matching only the latter lets the
  // deprecation updateMany execute for real against live MySQL first; the
  // fault then fires on the activation statement itself, so the already-real
  // deprecation is what gets rolled back.
  const faultingRepository = newFaultInjectingRepository(
    (params) =>
      params.model === 'ExchangeCalendarCoverage' &&
      params.action === 'updateMany' &&
      (params.args as { data?: { status?: string } })?.data?.status === CalendarCoverageStatus.CERTIFIED,
    'TEST_ONLY_FORCED_ACTIVATION_FAILURE'
  );
  await assert.rejects(() => activate(faultingRepository, v2), /TEST_ONLY_FORCED_ACTIVATION_FAILURE/);

  assert.equal((await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, year, 1))?.status, CalendarCoverageStatus.CERTIFIED);
  assert.equal((await repository.findCoverageByVersion(Exchange.NSE, ExchangeSegment.EQUITY, year, 2))?.status, CalendarCoverageStatus.DRAFT);
});

test('L: two-client empty-state concurrent activation serializes to one authoritative version', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository1 = newRepository();
  const repository2 = newRepository();
  const client = newClient();
  const year = uniqueYear();
  const v1 = fixture(year, { version: 1 });
  const v2 = fixture(year, { version: 2, sourceAuthority: 'SYNTHETIC_AUTHORITY_V2' });
  await importFixture(repository1, v1);
  await importFixture(repository1, v2);
  const outcomes = await Promise.all([activate(repository1, v1), activate(repository2, v2)]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind).sort(),
    ['ACTIVATED', 'REPLACED']
  );
  const certified = await client.exchangeCalendarCoverage.findMany({
    where: { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: year, status: CalendarCoverageStatus.CERTIFIED },
  });
  assert.equal(certified.length, 1);
  assert.equal(
    await client.exchangeCalendarCoverage.count({
      where: { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: year, status: CalendarCoverageStatus.DEPRECATED },
    }),
    1
  );
  assert.equal(
    await client.exchangeCalendarScopeLock.count({ where: { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: year } }),
    1
  );
});

test('M: concurrent activation for different years uses distinct scope-lock rows', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository1 = newRepository();
  const repository2 = newRepository();
  const client = newClient();
  const year1 = uniqueYear();
  const year2 = uniqueYear();
  const input1 = fixture(year1);
  const input2 = fixture(year2);
  await importFixture(repository1, input1);
  await importFixture(repository2, input2);
  const results = await Promise.all([activate(repository1, input1), activate(repository2, input2)]);
  assert.deepEqual(results.map((result) => result.kind), ['ACTIVATED', 'ACTIVATED']);
  assert.equal(
    await client.exchangeCalendarScopeLock.count({
      where: { exchange: Exchange.NSE, segment: ExchangeSegment.EQUITY, calendarYear: { in: [year1, year2] } },
    }),
    2
  );
});

// B-F7A provenance correction regression coverage: the persisted
// exceptional-day read path (`toPersistedDay`/`toValidatedSourceDocument` in
// exchange-calendar.repository.ts) must fail closed when a persisted source
// document's identity is structurally corrupted -- a blank
// `documentReference`, an unrecognized `documentType`, or a malformed
// `contentChecksumSha256` -- rather than exposing it as authoritative
// provenance. Prisma models `documentReference`/`documentType` as plain
// `String` columns (see prisma/schema.prisma), so a direct, typed
// `update()`/`updateMany()` against the guarded throwaway test database is
// the smallest way to reproduce persisted corruption without any raw SQL or
// production corruption hook.

test('N: exceptional day + whitespace-only persisted documentReference -> repository read path rejects', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const input = fixture(year, {
    sourceDocuments: [{ documentReference, documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE, contentChecksumSha256: 'd'.repeat(64) }],
    days: [{ tradingDate: `${year}-03-10`, classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE, sourceDocumentReference: documentReference }],
  });
  const imported = await importFixture(repository, input);

  const client = newClient();
  await client.exchangeCalendarSourceDocument.updateMany({
    where: { coverageId: imported.coverageId, documentReference },
    data: { documentReference: '   ' },
  });

  await assert.rejects(() => repository.findExplicitDay(imported.coverageId, `${year}-03-10`), /invalid content identity/);
});

test('O: exceptional day + invalid persisted documentType -> repository read path rejects', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const input = fixture(year, {
    sourceDocuments: [{ documentReference, documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE, contentChecksumSha256: 'e'.repeat(64) }],
    days: [{ tradingDate: `${year}-03-11`, classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE, sourceDocumentReference: documentReference }],
  });
  const imported = await importFixture(repository, input);

  const client = newClient();
  await client.exchangeCalendarSourceDocument.updateMany({
    where: { coverageId: imported.coverageId, documentReference },
    data: { documentType: 'NOT_A_DOCUMENT_TYPE' },
  });

  await assert.rejects(() => repository.findExplicitDay(imported.coverageId, `${year}-03-11`), /invalid content identity/);
});

test('P: exceptional day + malformed persisted contentChecksumSha256 -> repository read path rejects', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const input = fixture(year, {
    sourceDocuments: [{ documentReference, documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE, contentChecksumSha256: 'f'.repeat(64) }],
    days: [{ tradingDate: `${year}-03-12`, classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE, sourceDocumentReference: documentReference }],
  });
  const imported = await importFixture(repository, input);

  const client = newClient();
  await client.exchangeCalendarSourceDocument.updateMany({
    where: { coverageId: imported.coverageId, documentReference },
    data: { contentChecksumSha256: 'NOT-HEX' },
  });

  await assert.rejects(() => repository.findExplicitDay(imported.coverageId, `${year}-03-12`), /invalid content identity/);
});

test('Q: valid exceptional provenance still resolves via the repository read path', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const year = uniqueYear();
  const documentReference = `SYN-DOC-${randomUUID()}`;
  const contentChecksumSha256 = 'a1'.repeat(32);
  const input = fixture(year, {
    sourceDocuments: [{ documentReference, documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE, contentChecksumSha256 }],
    days: [{ tradingDate: `${year}-03-13`, classification: ExplicitCalendarClassification.EXCEPTIONAL_CLOSURE, sourceDocumentReference: documentReference }],
  });
  const imported = await importFixture(repository, input);

  const persisted = await repository.findExplicitDay(imported.coverageId, `${year}-03-13`);
  assert.deepEqual(persisted?.sourceDocument, {
    documentReference,
    documentType: SourceDocumentType.EXTRAORDINARY_CLOSURE_NOTICE,
    contentChecksumSha256,
    referenceUrl: null,
  });
});

test('R: UNCERTIFIED resolution is unaffected by the provenance correction and still returns sourceDocument = null', async (t) => {
  if (!databaseAvailable) return t.skip(skipReason());
  const repository = newRepository();
  const resolver = new ExchangeCalendarResolverService(repository);
  const year = uniqueYear();
  const result = await resolver.resolveTradingDay(Exchange.NSE, ExchangeSegment.EQUITY, `${year}-06-15`);
  assert.equal(result.classification, CalendarClassification.UNCERTIFIED);
  assert.equal(result.sourceDocument, null);
});
