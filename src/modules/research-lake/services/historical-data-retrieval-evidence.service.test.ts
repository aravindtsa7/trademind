import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';
import { HistoricalCandleSessionPersistenceOutcome, HistoricalDataRetrievalStatus } from '../domain';
import { SourceAcquisitionEvidenceAvailability } from '../domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * B-F2C FIX-1: `findLatestAvailableSessionEvidence` must enforce BOTH the
 * session's own accepted persistence outcome AND the PARENT retrieval's
 * successful terminal status IN the Prisma query itself (Terra defect H-1),
 * with a fully deterministic multi-key ordering (Terra defect M-1) -- never
 * `createdAt` alone. This suite fakes the Prisma client with a tiny,
 * generic in-memory query engine that actually applies the exact `where`/
 * `orderBy` argument objects the service constructs against seeded
 * candidate rows -- proving the filter/order live in the query contract
 * itself, not in some separate pure helper the real query could ignore
 * (see historical-candle-research-persistence.service.integration.test.ts
 * for the sibling dedicated-DB suite that exercises the real MySQL query
 * planner; this suite is intentionally zero-DB/zero-network).
 */

interface FakeRetrieval {
  readonly id: string;
  readonly providerId: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

interface FakeSessionRow {
  readonly id: string;
  readonly retrievalId: string;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly persistenceOutcome: string;
  readonly providerRowCountForDate: number;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly healthStatus: string;
  readonly evidenceSemanticChecksum: string;
  readonly createdAt: Date;
  readonly retrieval: FakeRetrieval;
}

function retrieval(overrides: Partial<FakeRetrieval> & { id: string; status: string }): FakeRetrieval {
  return {
    providerId: HistoricalProviderId.UPSTOX,
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

function sessionRow(overrides: Partial<FakeSessionRow> & { id: string; retrieval: FakeRetrieval }): FakeSessionRow {
  return {
    retrievalId: overrides.retrieval.id,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: '2024-01-19',
    persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW,
    providerRowCountForDate: 375,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    healthStatus: DatasetHealthStatus.HEALTHY,
    evidenceSemanticChecksum: `checksum-${overrides.id}`,
    createdAt: new Date('2024-01-19T10:00:00.000Z'),
    ...overrides,
  };
}

// ---- Minimal, generic in-memory simulation of Prisma's `where`/`orderBy` shape for ONE table + its to-one `retrieval` relation. ----

type WhereClause = Record<string, unknown>;
type OrderByClause = readonly Record<string, unknown>[];

function getPath(row: FakeSessionRow, path: readonly string[]): unknown {
  let current: unknown = row;
  for (const key of path) current = (current as Record<string, unknown> | undefined)?.[key];
  return current;
}

function matchesCondition(row: FakeSessionRow, path: readonly string[], condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const entries = Object.entries(condition as Record<string, unknown>);
    const [key, value] = entries[0];
    if (key === 'in') return (value as readonly unknown[]).includes(getPath(row, path));
    return matchesCondition(row, [...path, key], value);
  }
  return getPath(row, path) === condition;
}

function matchesWhere(row: FakeSessionRow, where: WhereClause): boolean {
  return Object.entries(where).every(([key, condition]) => matchesCondition(row, [key], condition));
}

function flattenOrderClause(clause: Record<string, unknown>): { path: readonly string[]; direction: 'asc' | 'desc' } {
  const path: string[] = [];
  let cursor: unknown = clause;
  for (;;) {
    const [key, value] = Object.entries(cursor as Record<string, unknown>)[0];
    path.push(key);
    if (value === 'asc' || value === 'desc') return { path, direction: value };
    cursor = value;
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  return 0;
}

function selectFirst(rows: readonly FakeSessionRow[], args: { where: WhereClause; orderBy: OrderByClause }): FakeSessionRow | null {
  const matched = rows.filter((row) => matchesWhere(row, args.where));
  if (matched.length === 0) return null;
  const clauses = args.orderBy.map(flattenOrderClause);
  const sorted = [...matched].sort((left, right) => {
    for (const clause of clauses) {
      const cmp = compareValues(getPath(left, clause.path), getPath(right, clause.path));
      if (cmp !== 0) return clause.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return sorted[0];
}

class FakePrismaClient {
  public readonly capturedFindFirstArgs: { where: WhereClause; orderBy: OrderByClause }[] = [];

  constructor(private readonly rows: readonly FakeSessionRow[]) {}

  readonly historicalDataRetrievalSession = {
    findFirst: async (args: { where: WhereClause; orderBy: OrderByClause }): Promise<FakeSessionRow | null> => {
      this.capturedFindFirstArgs.push(args);
      return selectFirst(this.rows, args);
    },
  };

  /** B-F8 CORRECTION (blocker 2): `findLatestAvailableSessionEvidence` now also looks up composite repair evidence for the winning session -- every test in this file exercises the ORIGINAL find-latest-session logic, never composite provenance, so this stub always reports "no composite repair evidence exists" (`null`), exactly as a genuinely pure-primary session would. */
  readonly historicalCandleRepairEvidence = {
    findFirst: async (): Promise<null> => null,
  };
}

function newService(rows: readonly FakeSessionRow[]): { service: HistoricalDataRetrievalEvidenceService; prisma: FakePrismaClient } {
  const prisma = new FakePrismaClient(rows);
  const service = new HistoricalDataRetrievalEvidenceService(prisma as unknown as PrismaClient);
  return { service, prisma };
}

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const TRADING_DATE = '2024-01-19';

// ---- QUERY CONTRACT: the where/orderBy shape itself, enforced IN the query ----

test('FIX-1 query contract: where clause filters on accepted persistence outcomes AND successful terminal parent statuses; orderBy is a deterministic multi-key array', async () => {
  const { service, prisma } = newService([]);
  await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);

  assert.equal(prisma.capturedFindFirstArgs.length, 1);
  const args = prisma.capturedFindFirstArgs[0];

  const outcomeFilter = args.where.persistenceOutcome as { in: string[] };
  assert.deepEqual(new Set(outcomeFilter.in), new Set([HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW, HistoricalCandleSessionPersistenceOutcome.ACCEPTED_IDEMPOTENT]));

  const retrievalFilter = args.where.retrieval as { status: { in: string[] } };
  assert.deepEqual(new Set(retrievalFilter.status.in), new Set([HistoricalDataRetrievalStatus.PROCESSED, HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES]));
  assert.ok(!retrievalFilter.status.in.includes(HistoricalDataRetrievalStatus.STARTED), 'STARTED must never be in the successful-terminal filter');
  assert.ok(!retrievalFilter.status.in.includes(HistoricalDataRetrievalStatus.FETCHED), 'FETCHED must never be in the successful-terminal filter');
  assert.ok(!retrievalFilter.status.in.includes(HistoricalDataRetrievalStatus.FAILED), 'FAILED must never be in the successful-terminal filter');

  assert.ok(Array.isArray(args.orderBy) && args.orderBy.length >= 3, 'orderBy must be a multi-key array, never createdAt alone');
  const orderedPaths = args.orderBy.map((clause) => flattenOrderClause(clause).path.join('.'));
  assert.ok(orderedPaths.includes('retrieval.completedAt'), 'must order primarily by the parent retrieval finalized timestamp');
  assert.ok(!orderedPaths.includes('createdAt') || orderedPaths.length > 1, 'must never rely on createdAt alone');
});

// ---- H-1: STARTED / FETCHED / FAILED parent must never qualify ----

test('H1-A: parent STARTED, session ACCEPTED_NEW -- no AVAILABLE provenance', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.STARTED });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

test('H1-B: parent FETCHED, session ACCEPTED_NEW -- no AVAILABLE provenance (Terra crash-window reproduction)', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.FETCHED });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

test('H1-C: parent FAILED, session ACCEPTED_NEW -- no AVAILABLE provenance (fail closed even if theoretically inconsistent)', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.FAILED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

// ---- H-1: PROCESSED / COMPLETED_WITH_ISSUES parent DOES qualify ----

test('H1-D: parent PROCESSED, session ACCEPTED_NEW -- AVAILABLE', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence?.availability, SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE);
});

test('H1-E: parent COMPLETED_WITH_ISSUES (mixed chunk), session ACCEPTED_IDEMPOTENT -- AVAILABLE', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.ACCEPTED_IDEMPOTENT })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence?.availability, SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE);
});

// ---- H-1: CONFLICT / INVALID / INCOMPLETE session outcomes must never qualify, even under a successful terminal parent ----

test('H1-F: parent successful terminal, session CONFLICT -- no AVAILABLE provenance', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.CONFLICT })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

test('H1-G: parent successful terminal, session INVALID -- no AVAILABLE provenance', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INVALID })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

test('H1-G: parent successful terminal, session INCOMPLETE -- no AVAILABLE provenance', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const { service } = newService([sessionRow({ id: 's1', retrieval: r, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INCOMPLETE })]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});

// ---- M-1: deterministic selection policy ----

test('M1-A: two accepted terminal candidates with different completedAt -- the newer FINALIZED retrieval is selected', async () => {
  const older = retrieval({ id: 'r-older', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const newer = retrieval({ id: 'r-newer', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const { service } = newService([
    sessionRow({ id: 's-older', retrieval: older, evidenceSemanticChecksum: 'checksum-A' }),
    sessionRow({ id: 's-newer', retrieval: newer, evidenceSemanticChecksum: 'checksum-B' }),
  ]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence?.evidenceSemanticChecksum, 'checksum-B');
});

test('M1-B: identical completedAt to DATETIME(3) precision -- stable secondary ordering selects exactly one deterministic row', async () => {
  const sameCompletedAt = new Date('2024-01-19T11:00:00.000Z');
  const rA = retrieval({ id: 'r-aaaa', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: sameCompletedAt, startedAt: new Date('2024-01-19T09:00:00.000Z') });
  const rB = retrieval({ id: 'r-bbbb', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: sameCompletedAt, startedAt: new Date('2024-01-19T09:00:00.000Z') });
  const rows = [sessionRow({ id: 's-aaaa', retrieval: rA }), sessionRow({ id: 's-bbbb', retrieval: rB })];

  const { service: service1 } = newService(rows);
  const { service: service2 } = newService([...rows].reverse());
  const evidence1 = await service1.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  const evidence2 = await service2.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);

  assert.notEqual(evidence1, null);
  assert.deepEqual(evidence1, evidence2, 'selection must be independent of input/storage order -- exactly one deterministic row wins regardless of tie on completedAt/startedAt');
});

test('M1-C: same semantic evidence, different retrieval UUID/timestamps -- selected row may differ, but evidenceSemanticChecksum is identical either way', async () => {
  const sharedChecksum = 'checksum-shared-semantic-content';
  const rA = retrieval({ id: 'r-aaaa', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const rB = retrieval({ id: 'r-bbbb', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-03-01T11:00:00.000Z') });
  const { service } = newService([
    sessionRow({ id: 's-aaaa', retrieval: rA, evidenceSemanticChecksum: sharedChecksum }),
    sessionRow({ id: 's-bbbb', retrieval: rB, evidenceSemanticChecksum: sharedChecksum }),
  ]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence?.evidenceSemanticChecksum, sharedChecksum);
});

test('M1-D: a newer CONFLICT/FAILED/FETCHED attempt after an older valid accepted terminal attempt must NOT hide the valid evidence', async () => {
  const validOlder = retrieval({ id: 'r-valid', status: HistoricalDataRetrievalStatus.PROCESSED, completedAt: new Date('2024-01-19T11:00:00.000Z') });
  const newerFailed = retrieval({ id: 'r-failed', status: HistoricalDataRetrievalStatus.FAILED, completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const newerFetched = retrieval({ id: 'r-fetched', status: HistoricalDataRetrievalStatus.FETCHED, completedAt: null, startedAt: new Date('2024-07-01T09:00:00.000Z') });
  const { service } = newService([
    sessionRow({ id: 's-valid', retrieval: validOlder, evidenceSemanticChecksum: 'checksum-valid' }),
    sessionRow({ id: 's-failed', retrieval: newerFailed, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.CONFLICT, evidenceSemanticChecksum: 'checksum-failed' }),
    sessionRow({ id: 's-fetched', retrieval: newerFetched, evidenceSemanticChecksum: 'checksum-fetched' }),
  ]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence?.evidenceSemanticChecksum, 'checksum-valid');
});

test('no genuine evidence exists for this session identity -- returns null, never a fabricated default', async () => {
  const { service } = newService([]);
  const evidence = await service.findLatestAvailableSessionEvidence(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(evidence, null);
});
