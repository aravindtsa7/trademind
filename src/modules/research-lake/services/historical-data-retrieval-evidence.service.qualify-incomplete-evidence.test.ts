import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import HistoricalDataRetrievalEvidenceService, {
  QualifiedIncompleteEvidenceAmbiguousError,
  QualifiedIncompleteEvidenceInvariantError,
} from './historical-data-retrieval-evidence.service';
import { HistoricalCandleSessionPersistenceOutcome, HistoricalDataRetrievalStatus } from '../domain';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * B-M7.1: dedicated, zero-DB/zero-network test suite for
 * `findTerminalIncompleteSessionEvidence`, using the SAME tiny in-memory
 * Prisma-query-shape simulation `historical-data-retrieval-evidence.service.test.ts`
 * already established for `findLatestAvailableSessionEvidence` -- extended
 * with `findMany` (this method's ambiguity check requires seeing every
 * match, never just the first one `findFirst` would return).
 */

interface FakeRetrieval {
  readonly id: string;
  readonly providerId: string;
  readonly status: string;
  readonly requestedFromDate: string;
  readonly requestedToDate: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

interface FakeSessionRow {
  readonly id: string;
  readonly retrievalId: string;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly expectedMinuteCount: number;
  readonly providerRowCountForDate: number;
  readonly acceptedRowCount: number;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly persistenceOutcome: string;
  readonly healthStatus: string;
  readonly sourceRowsSemanticChecksum: string | null;
  readonly evidenceSemanticChecksum: string;
  readonly retrieval: FakeRetrieval;
}

function retrieval(overrides: Partial<FakeRetrieval> & { id: string; status: string }): FakeRetrieval {
  return {
    providerId: HistoricalProviderId.UPSTOX,
    // Defaults to an exact single-day request (matching the ROW's own
    // 2022-03-07 tradingDate default below) so a test that doesn't care
    // about retrieval scope at all still builds a self-consistent fixture.
    requestedFromDate: '2022-03-07',
    requestedToDate: '2022-03-07',
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    completedAt: new Date('2024-01-01T11:00:00.000Z'),
    ...overrides,
  };
}

function incompleteSessionRow(overrides: Partial<FakeSessionRow> & { id: string; retrieval: FakeRetrieval }): FakeSessionRow {
  return {
    retrievalId: overrides.retrieval.id,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: '2022-03-07',
    calendarDisposition: 'REGULAR_TRADING_DAY',
    expectedMinuteCount: 375,
    providerRowCountForDate: 372,
    acceptedRowCount: 372,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INCOMPLETE,
    healthStatus: DatasetHealthStatus.INCOMPLETE,
    sourceRowsSemanticChecksum: `checksum-${overrides.id}`,
    evidenceSemanticChecksum: `evidence-checksum-${overrides.id}`,
    ...overrides,
  };
}

type WhereClause = Record<string, unknown>;

/**
 * Unlike the sibling `findLatestAvailableSessionEvidence` fake (which only
 * ever nests ONE key deep, e.g. `retrieval: { status: { in: [...] } }`),
 * `findTerminalIncompleteSessionEvidence`'s WHERE clause nests TWO sibling
 * keys under `retrieval` (`providerId` AND `status`) -- so this matcher
 * treats every key of a plain-object condition as an AND'd sub-condition
 * against the correspondingly-nested field, rather than assuming exactly one
 * key per nesting level.
 */
function matchesField(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const entries = Object.entries(condition as Record<string, unknown>);
    if (entries.length === 1 && entries[0][0] === 'in') {
      return (entries[0][1] as readonly unknown[]).includes(value);
    }
    return entries.every(([subKey, subCondition]) => matchesField((value as Record<string, unknown> | undefined)?.[subKey], subCondition));
  }
  return value === condition;
}

function matchesWhere(row: FakeSessionRow, where: WhereClause): boolean {
  return Object.entries(where).every(([key, condition]) => matchesField((row as unknown as Record<string, unknown>)[key], condition));
}

class FakePrismaClient {
  public readonly capturedFindManyArgs: { where: WhereClause }[] = [];

  constructor(private readonly rows: readonly FakeSessionRow[]) {}

  readonly historicalDataRetrievalSession = {
    findMany: async (args: { where: WhereClause }): Promise<FakeSessionRow[]> => {
      this.capturedFindManyArgs.push(args);
      return this.rows.filter((row) => matchesWhere(row, args.where));
    },
  };
}

function newService(rows: readonly FakeSessionRow[]): { service: HistoricalDataRetrievalEvidenceService; prisma: FakePrismaClient } {
  const prisma = new FakePrismaClient(rows);
  const service = new HistoricalDataRetrievalEvidenceService(prisma as unknown as PrismaClient);
  return { service, prisma };
}

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const TRADING_DATE = '2022-03-07';

function qualify(service: HistoricalDataRetrievalEvidenceService) {
  return service.findTerminalIncompleteSessionEvidence({ expectedProviderId: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate: TRADING_DATE });
}

/** B-M7.1 CORRECTION: the exact-single-date scope B-M7.1 itself requires (`requiredRetrievalRange: { fromDate: tradingDate, toDate: tradingDate }`). */
function qualifyExactDay(service: HistoricalDataRetrievalEvidenceService) {
  return service.findTerminalIncompleteSessionEvidence({
    expectedProviderId: HistoricalProviderId.UPSTOX,
    instrumentKey: INSTRUMENT_KEY,
    timeframe: TIMEFRAME,
    tradingDate: TRADING_DATE,
    requiredRetrievalRange: { fromDate: TRADING_DATE, toDate: TRADING_DATE },
  });
}

// ---- A: exact historical incomplete evidence accepted ----

test('exact terminal INCOMPLETE evidence for the expected provider is accepted', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.equal(evidence?.sourceRowsSemanticChecksum, 'checksum-s1');
  assert.equal(evidence?.evidenceSemanticChecksum, 'evidence-checksum-s1');
  assert.equal(evidence?.providerId, HistoricalProviderId.UPSTOX);
  assert.equal(evidence?.acceptedRowCount, 372);
  assert.equal(evidence?.expectedMinuteCount, 375);
});

test('query is scoped by findMany (never findFirst) -- the capturedFindManyArgs call actually happened', async () => {
  const { service, prisma } = newService([]);
  await qualify(service);
  assert.equal(prisma.capturedFindManyArgs.length, 1);
});

test('no matching evidence at all -> returns null, never a fabricated default', async () => {
  const { service } = newService([]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

// ---- A: wrong provider rejected ----

test('a GROWW retrieval for the same session identity is never returned when UPSTOX is expected', async () => {
  const r = retrieval({ id: 'r1', providerId: HistoricalProviderId.GROWW, status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

// ---- A: wrong instrument rejected ----

test('a row for a different instrumentKey is never returned', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, instrumentKey: 'NSE_INDEX|Bank Nifty' })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

// ---- A: wrong date rejected ----

test('a row for a different tradingDate is never returned', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, tradingDate: '2022-03-08' })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

// ---- A: wrong timeframe rejected ----

test('a row for a different timeframe is never returned', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, timeframe: '5minute' })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

// ---- A: wrong expected count rejected ----

test('the caller sees the true (possibly unexpected) expectedMinuteCount -- structural facts are the caller\'s responsibility to lock, not this method\'s', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, expectedMinuteCount: 105 })]);
  const evidence = await qualify(service);
  assert.equal(evidence?.expectedMinuteCount, 105);
});

// ---- A: wrong observed count surfaced truthfully ----

test('a differing providerRowCountForDate/acceptedRowCount is surfaced truthfully, not silently normalized', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, providerRowCountForDate: 371, acceptedRowCount: 371 })]);
  const evidence = await qualify(service);
  assert.equal(evidence?.providerRowCountForDate, 371);
  assert.equal(evidence?.acceptedRowCount, 371);
});

// ---- A: missing source checksum rejected ----

test('a row with a null sourceRowsSemanticChecksum fails closed with QualifiedIncompleteEvidenceInvariantError', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, sourceRowsSemanticChecksum: null })]);
  await assert.rejects(() => qualify(service), QualifiedIncompleteEvidenceInvariantError);
});

// ---- A: non-terminal/inappropriate evidence rejected ----

test('parent STARTED never qualifies', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.STARTED, completedAt: null });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

test('parent FETCHED never qualifies', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.FETCHED, completedAt: null });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

test('parent FAILED never qualifies', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.FAILED });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

test('parent PROCESSED (terminal) qualifies', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.PROCESSED });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r })]);
  const evidence = await qualify(service);
  assert.notEqual(evidence, null);
});

test('a session whose own persistenceOutcome is not INCOMPLETE (e.g. ACCEPTED_NEW) is never returned by this method', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.PROCESSED });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW })]);
  const evidence = await qualify(service);
  assert.equal(evidence, null);
});

test('a session with persistenceOutcome=INCOMPLETE but healthStatus != INCOMPLETE (e.g. legacy INVALID row) fails closed', async () => {
  const r = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r, healthStatus: DatasetHealthStatus.INVALID })]);
  await assert.rejects(() => qualify(service), QualifiedIncompleteEvidenceInvariantError);
});

// ---- A: no ambiguity -- deterministic selection or fail closed ----

test('two matching terminal INCOMPLETE evidence rows for the identical identity are ambiguous -- fails closed rather than silently picking one', async () => {
  const r1 = retrieval({ id: 'r1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES });
  const r2 = retrieval({ id: 'r2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: r1 }), incompleteSessionRow({ id: 's2', retrieval: r2 })]);
  await assert.rejects(() => qualify(service), QualifiedIncompleteEvidenceAmbiguousError);
});

test('a newer unrelated FAILED/STARTED retrieval alongside one genuinely terminal INCOMPLETE row is not ambiguous -- only successful-terminal rows count', async () => {
  const validTerminal = retrieval({ id: 'r-valid', status: HistoricalDataRetrievalStatus.PROCESSED });
  const failedNewer = retrieval({ id: 'r-failed', status: HistoricalDataRetrievalStatus.FAILED, completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const { service } = newService([incompleteSessionRow({ id: 's-valid', retrieval: validTerminal }), incompleteSessionRow({ id: 's-failed', retrieval: failedNewer })]);
  const evidence = await qualify(service);
  assert.equal(evidence?.sessionId, 's-valid');
});

// ============================================================================
// B-M7.1 CORRECTION: `requiredRetrievalRange` -- exact PARENT-retrieval
// request-scope qualification. Every test above (no `requiredRetrievalRange`
// passed) is completely unaffected by this correction -- these tests
// exercise only the NEW optional narrowing + multi-exact-day-candidate
// equivalence/conflict semantics.
// ============================================================================

test('exact-range requirement: a monthly-scoped candidate + an exact-day-scoped candidate for the same date -- only the exact-day candidate qualifies', async () => {
  const monthlyRetrieval = retrieval({ id: 'r-monthly', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-01', requestedToDate: '2022-03-31' });
  const exactDayRetrieval = retrieval({ id: 'r-exact', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([
    incompleteSessionRow({ id: 's-monthly', retrieval: monthlyRetrieval, sourceRowsSemanticChecksum: 'monthly-checksum', evidenceSemanticChecksum: 'monthly-evidence-checksum' }),
    incompleteSessionRow({ id: 's-exact', retrieval: exactDayRetrieval, sourceRowsSemanticChecksum: 'exact-checksum', evidenceSemanticChecksum: 'exact-evidence-checksum' }),
  ]);
  const evidence = await qualifyExactDay(service);
  assert.equal(evidence?.sessionId, 's-exact');
  assert.equal(evidence?.sourceRowsSemanticChecksum, 'exact-checksum');
});

test('exact-range requirement: only a monthly-scoped candidate exists -- returns null, NEVER falls back to it', async () => {
  const monthlyRetrieval = retrieval({ id: 'r-monthly', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-01', requestedToDate: '2022-03-31' });
  const { service } = newService([incompleteSessionRow({ id: 's-monthly', retrieval: monthlyRetrieval })]);
  const evidence = await qualifyExactDay(service);
  assert.equal(evidence, null);
});

test('exact-range requirement: an exact-day-scoped candidate whose parent retrieval is non-terminal (STARTED) is ignored', async () => {
  const nonTerminal = retrieval({ id: 'r-started', status: HistoricalDataRetrievalStatus.STARTED, completedAt: null, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: nonTerminal })]);
  const evidence = await qualifyExactDay(service);
  assert.equal(evidence, null);
});

test('exact-range requirement: an exact-day-scoped candidate from the wrong provider is ignored', async () => {
  const wrongProvider = retrieval({ id: 'r-groww', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, providerId: HistoricalProviderId.GROWW, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([incompleteSessionRow({ id: 's1', retrieval: wrongProvider })]);
  const evidence = await qualifyExactDay(service);
  assert.equal(evidence, null);
});

test('exact-range requirement: two exact-day candidates with identical qualification semantics/checksums are accepted as equivalent duplicates', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07', completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const { service } = newService([
    incompleteSessionRow({ id: 's-a', retrieval: r1, sourceRowsSemanticChecksum: 'same-checksum', evidenceSemanticChecksum: 'same-evidence-checksum' }),
    incompleteSessionRow({ id: 's-b', retrieval: r2, sourceRowsSemanticChecksum: 'same-checksum', evidenceSemanticChecksum: 'same-evidence-checksum' }),
  ]);
  const evidence = await qualifyExactDay(service);
  assert.notEqual(evidence, null);
  assert.equal(evidence?.sourceRowsSemanticChecksum, 'same-checksum');
});

test('exact-range requirement: equivalent exact-day duplicates are selected deterministically, independent of input/query ordering', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const rowA = incompleteSessionRow({ id: 's-aaa', retrieval: r1, sourceRowsSemanticChecksum: 'dup-checksum', evidenceSemanticChecksum: 'dup-evidence-checksum' });
  const rowB = incompleteSessionRow({ id: 's-bbb', retrieval: r2, sourceRowsSemanticChecksum: 'dup-checksum', evidenceSemanticChecksum: 'dup-evidence-checksum' });

  const { service: forwardOrder } = newService([rowA, rowB]);
  const { service: reverseOrder } = newService([rowB, rowA]);

  const forwardResult = await qualifyExactDay(forwardOrder);
  const reverseResult = await qualifyExactDay(reverseOrder);

  assert.equal(forwardResult?.sessionId, reverseResult?.sessionId);
  // Documented ordering: ascending session id -- 's-aaa' < 's-bbb'.
  assert.equal(forwardResult?.sessionId, 's-aaa');
});

test('exact-range requirement: two exact-day candidates with DIFFERENT sourceRowsSemanticChecksum fail closed as a conflict -- never selects latest', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07', completedAt: new Date('2024-06-01T11:00:00.000Z') });
  const { service } = newService([
    incompleteSessionRow({ id: 's-a', retrieval: r1, sourceRowsSemanticChecksum: 'checksum-a' }),
    incompleteSessionRow({ id: 's-b', retrieval: r2, sourceRowsSemanticChecksum: 'checksum-b' }),
  ]);
  await assert.rejects(() => qualifyExactDay(service), QualifiedIncompleteEvidenceAmbiguousError);
});

test('exact-range requirement: two exact-day candidates with the SAME sourceRowsSemanticChecksum but a different qualification-relevant durable fact (evidenceSemanticChecksum) fail closed as a conflict', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([
    incompleteSessionRow({ id: 's-a', retrieval: r1, sourceRowsSemanticChecksum: 'same-checksum', acceptedRowCount: 372, evidenceSemanticChecksum: 'evidence-a' }),
    incompleteSessionRow({ id: 's-b', retrieval: r2, sourceRowsSemanticChecksum: 'same-checksum', acceptedRowCount: 371, evidenceSemanticChecksum: 'evidence-b' }),
  ]);
  await assert.rejects(() => qualifyExactDay(service), QualifiedIncompleteEvidenceAmbiguousError);
});

test('exact-range requirement: a null sourceRowsSemanticChecksum on ANY exact-day candidate fails closed with an invariant error, even when its sibling looks fine', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([
    incompleteSessionRow({ id: 's-a', retrieval: r1, sourceRowsSemanticChecksum: 'checksum-a' }),
    incompleteSessionRow({ id: 's-b', retrieval: r2, sourceRowsSemanticChecksum: null }),
  ]);
  await assert.rejects(() => qualifyExactDay(service), QualifiedIncompleteEvidenceInvariantError);
});

test('exact-range requirement: a healthStatus != INCOMPLETE on ANY exact-day candidate fails closed with an invariant error, even when its sibling looks fine', async () => {
  const r1 = retrieval({ id: 'r-exact-1', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const r2 = retrieval({ id: 'r-exact-2', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([incompleteSessionRow({ id: 's-a', retrieval: r1 }), incompleteSessionRow({ id: 's-b', retrieval: r2, healthStatus: DatasetHealthStatus.INVALID })]);
  await assert.rejects(() => qualifyExactDay(service), QualifiedIncompleteEvidenceInvariantError);
});

// ============================================================================
// REAL-WORLD REGRESSION SHAPE: the exact topology from the real March-7
// operator attempt (one monthly-chunk row, one exact-day row, both terminal
// INCOMPLETE UPSTOX evidence, 2022-03-07, 375 expected/372 observed).
// Deliberately does NOT use the real database UUIDs as logic -- only the
// SHAPE (differing parent request scope) matters here.
// ============================================================================

test('real-world regression shape: monthly candidate A + exact-day candidate B -- B qualifies alone, A is outside the comparison domain, no ambiguity', async () => {
  const candidateA = retrieval({ id: 'retrieval-monthly-chunk', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-01', requestedToDate: '2022-03-31' });
  const candidateB = retrieval({ id: 'retrieval-exact-day', status: HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES, requestedFromDate: '2022-03-07', requestedToDate: '2022-03-07' });
  const { service } = newService([
    incompleteSessionRow({ id: 'session-monthly', retrieval: candidateA, sourceRowsSemanticChecksum: 'checksum-a-monthly-scope', evidenceSemanticChecksum: 'evidence-a-monthly-scope' }),
    incompleteSessionRow({ id: 'session-exact', retrieval: candidateB, sourceRowsSemanticChecksum: 'checksum-b-exact-scope', evidenceSemanticChecksum: 'evidence-b-exact-scope' }),
  ]);

  const evidence = await qualifyExactDay(service);
  assert.equal(evidence?.sessionId, 'session-exact');
  assert.equal(evidence?.sourceRowsSemanticChecksum, 'checksum-b-exact-scope');
});
