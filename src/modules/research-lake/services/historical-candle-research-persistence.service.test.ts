import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleResearchPersistenceService, {
  ExistingCandleRow,
  RESEARCH_PERSISTENCE_MAX_ATTEMPTS,
  ResearchCandleSessionMetadata,
  ResearchPersistenceConcurrencyRetriesExhaustedError,
  ResearchSessionPersistenceResult,
  isRetryableResearchPersistenceConcurrencyError,
  planSessionPersistence,
} from './historical-candle-research-persistence.service';

/**
 * B-F2C invariants 5-9, task matrix items B/C/D/E/F: `planSessionPersistence`
 * is the ENTIRE deterministic insert/no-op/conflict decision, as a pure
 * function -- zero I/O, so every comparison edge case is directly testable
 * here without a database. `HistoricalCandleResearchPersistenceService.
 * persistSession` (the DB-touching wrapper) is covered separately by the
 * skippable dedicated-DB integration test.
 */

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const T0 = new Date('2024-01-19T03:45:00.000Z');
const T1 = new Date('2024-01-19T03:46:00.000Z');
const T2 = new Date('2024-01-19T03:47:00.000Z');

function candidate(candleTime: Date, overrides: Partial<CanonicalHistoricalCandle> = {}): CanonicalHistoricalCandle {
  return {
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
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

function existing(candleTime: Date, overrides: Partial<ExistingCandleRow> = {}): ExistingCandleRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

// ---- A/matrix-item context: brand-new session, nothing pre-existing ----

test('A: NEW SESSION -- no existing rows: every candidate is planned for insert, zero conflicts, zero idempotent', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [], [candidate(T0), candidate(T1), candidate(T2)]);
  assert.equal(plan.toInsert.length, 3);
  assert.equal(plan.idempotentCount, 0);
  assert.deepEqual(plan.conflicts, []);
});

// ---- B: IDENTICAL RE-DOWNLOAD ----

test('B: IDENTICAL RE-DOWNLOAD -- existing content semantically identical to incoming: zero inserts planned, all counted idempotent, zero conflicts', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0), existing(T1)], [candidate(T0), candidate(T1)]);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.idempotentCount, 2);
  assert.deepEqual(plan.conflicts, []);
});

test('B: IDENTICAL RE-DOWNLOAD -- equivalent representation (existing as Prisma.Decimal, incoming as plain number) is still idempotent, never a conflict', () => {
  const plan = planSessionPersistence(
    INSTRUMENT_KEY,
    TIMEFRAME,
    [existing(T0, { open: new Prisma.Decimal('100.000000') })],
    [candidate(T0, { open: 100 })]
  );
  assert.equal(plan.idempotentCount, 1);
  assert.deepEqual(plan.conflicts, []);
});

test('B: a session mixing already-identical rows with genuinely missing rows plans ONLY the missing ones for insert, and counts the rest idempotent (the realistic crash-recovery/partial-resume shape)', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0), existing(T1)], [candidate(T0), candidate(T1), candidate(T2)]);
  assert.equal(plan.toInsert.length, 1);
  assert.equal(plan.toInsert[0].candleTime.getTime(), T2.getTime());
  assert.equal(plan.idempotentCount, 2);
  assert.deepEqual(plan.conflicts, []);
});

// ---- C: OHLC CONFLICT ----

test('C: OHLC CONFLICT -- open differs: reported as a conflict, never silently inserted/updated', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { open: new Prisma.Decimal(100) })], [candidate(T0, { open: 105 })]);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.idempotentCount, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].existing.open, '100');
  assert.equal(plan.conflicts[0].incoming.open, '105');
});

test('C: OHLC CONFLICT -- high differs: reported as a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { high: new Prisma.Decimal(101) })], [candidate(T0, { high: 150 })]);
  assert.equal(plan.conflicts.length, 1);
});

test('C: OHLC CONFLICT -- low differs: reported as a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { low: new Prisma.Decimal(99) })], [candidate(T0, { low: 50 })]);
  assert.equal(plan.conflicts.length, 1);
});

test('C: OHLC CONFLICT -- close differs: reported as a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { close: new Prisma.Decimal(100.5) })], [candidate(T0, { close: 200 })]);
  assert.equal(plan.conflicts.length, 1);
});

// ---- D: VOLUME CONFLICT ----

test('D: VOLUME CONFLICT -- volume differs: reported as a conflict, never a last-writer-wins overwrite', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { volume: 1_000n })], [candidate(T0, { volume: 5_000n })]);
  assert.equal(plan.toInsert.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].existing.volume, '1000');
  assert.equal(plan.conflicts[0].incoming.volume, '5000');
});

// ---- E: OPEN-INTEREST CONFLICT ----

test('E: OPEN-INTEREST CONFLICT -- null (existing) vs a real value (incoming): reported as a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { openInterest: null })], [candidate(T0, { openInterest: 500n })]);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].existing.openInterest, null);
  assert.equal(plan.conflicts[0].incoming.openInterest, '500');
});

test('E: OPEN-INTEREST CONFLICT -- one value vs a DIFFERENT value: reported as a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { openInterest: 500n })], [candidate(T0, { openInterest: 600n })]);
  assert.equal(plan.conflicts.length, 1);
});

test('E: OPEN-INTEREST -- null vs null is idempotent, never a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { openInterest: null })], [candidate(T0, { openInterest: null })]);
  assert.equal(plan.idempotentCount, 1);
  assert.deepEqual(plan.conflicts, []);
});

test('E: OPEN-INTEREST -- the same real value on both sides is idempotent, never a conflict', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { openInterest: 500n })], [candidate(T0, { openInterest: 500n })]);
  assert.equal(plan.idempotentCount, 1);
  assert.deepEqual(plan.conflicts, []);
});

// ---- F: LEGACY SOURCE LABEL is structurally irrelevant ----

test('F: LEGACY SOURCE LABEL -- `ExistingCandleRow` carries no `source` field at all, so a legacy REST-labeled row with identical OHLCVOI content is idempotent, never a conflict, regardless of provenance labeling', () => {
  // `existing()` here stands in for a legacy row (source='REST' in the real HistoricalCandle table) --
  // ExistingCandleRow structurally has no `source` field, so there is nothing for a provider-identified
  // (e.g. UPSTOX) incoming candle to disagree with on that axis.
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0)], [candidate(T0)]);
  assert.equal(plan.idempotentCount, 1);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.toInsert.length, 0);
});

// ---- Invariant 8: session atomicity -- a single conflict does not prevent reporting, and never silently drops other rows into toInsert ----

test('session atomicity: one conflicting minute among several candidates still reports the OTHER (missing) candidates as evidence, but the caller (persistSession) is the one responsible for discarding toInsert entirely on any conflict -- this function itself reports both facts truthfully', () => {
  const plan = planSessionPersistence(INSTRUMENT_KEY, TIMEFRAME, [existing(T0, { close: new Prisma.Decimal(100.5) })], [candidate(T0, { close: 999 }), candidate(T1)]);
  assert.equal(plan.conflicts.length, 1);
  // T1 is genuinely missing and would be inserted in isolation -- `planSessionPersistence` reports it in
  // `toInsert`; `HistoricalCandleResearchPersistenceService.persistSession` is what enforces that ANY
  // conflict anywhere in the session discards `toInsert` entirely (see that method's own doc/tests).
  assert.equal(plan.toInsert.length, 1);
  assert.equal(plan.toInsert[0].candleTime.getTime(), T1.getTime());
});

// ---- B-F2C FIX-2: bounded whole-transaction retry around persistSession(), zero-DB ----
//
// `persistSessionTransactionOnce` (the actual `$transaction(...)` call, including the
// `SELECT ... FOR UPDATE` / semantic comparison / write) is exercised for real ONLY by the
// dedicated-DB integration suite (historical-candle-research-persistence.service.integration.test.ts,
// tests 4/5) -- that is the one place a genuine MySQL deadlock can occur, and it is where FIX-2's
// production behavior (a losing transaction re-reading the winner's committed content and resolving
// truthfully to ACCEPTED_IDEMPOTENT/CONFLICT) is actually proven. This suite instead fakes
// `PrismaClient.$transaction` itself -- the exact boundary `persistSession`'s retry loop calls through
// `persistSessionTransactionOnce` -- to prove the RETRY LOOP's own contract in isolation: how many
// times it calls through, which errors it retries, and what it does at exhaustion.

function metadataFixture(): ResearchCandleSessionMetadata {
  return {
    retrievalId: 'retrieval-fixture-id',
    providerId: HistoricalProviderId.UPSTOX,
    instrumentKey: INSTRUMENT_KEY,
    timeframe: TIMEFRAME,
    tradingDate: '2024-01-19',
    calendarDisposition: 'REGULAR_TRADING_DAY',
    expectedMinuteCount: 1,
    providerRowCountForDate: 1,
    healthStatus: DatasetHealthStatus.HEALTHY,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    sourceRowsSemanticChecksum: 'test-checksum',
    from: new Date('2024-01-19T00:00:00+05:30'),
    to: new Date('2024-01-19T23:59:59.999+05:30'),
  };
}

const successfulResultFixture: ResearchSessionPersistenceResult = {
  outcome: 'ACCEPTED_NEW',
  insertedCount: 1,
  idempotentCount: 0,
  conflicts: [],
  sessionEvidenceId: 'session-evidence-fixture-id',
};

/** Byte-for-byte the shape Terra's reproduced integration failure actually threw (see service file doc). */
function deadlockRawQueryError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock; try restarting transaction`",
    { code: 'P2010', clientVersion: '5.22.0', meta: { code: '1213', message: 'Deadlock found when trying to get lock; try restarting transaction' } }
  );
}

function transactionWriteConflictError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock. Please retry your transaction', {
    code: 'P2034',
    clientVersion: '5.22.0',
  });
}

class FakeTransactionPrismaClient {
  public callCount = 0;
  constructor(private readonly behaviors: readonly (() => Promise<unknown>)[]) {}

  $transaction = async (): Promise<unknown> => {
    const behavior = this.behaviors[this.callCount];
    this.callCount += 1;
    if (!behavior) throw new Error('FakeTransactionPrismaClient.$transaction invoked more times than configured behaviors -- the retry loop is not bounded as expected');
    return behavior();
  };
}

function newServiceWithBehaviors(behaviors: readonly (() => Promise<unknown>)[]): { service: HistoricalCandleResearchPersistenceService; prisma: FakeTransactionPrismaClient } {
  const prisma = new FakeTransactionPrismaClient(behaviors);
  const service = new HistoricalCandleResearchPersistenceService(prisma as unknown as PrismaClient);
  return { service, prisma };
}

test('FIX-2 retry classifier: P2010 raw-query deadlock (meta.code 1213) is retryable -- the exact reproduced failure shape', () => {
  assert.equal(isRetryableResearchPersistenceConcurrencyError(deadlockRawQueryError()), true);
});

test('FIX-2 retry classifier: P2034 transaction write-conflict/deadlock is retryable', () => {
  assert.equal(isRetryableResearchPersistenceConcurrencyError(transactionWriteConflictError()), true);
});

test('FIX-2 retry classifier: P2010 raw-query failure with a DIFFERENT underlying MySQL code (e.g. a syntax error) is NOT retryable', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `1064`. Message: `You have an error in your SQL syntax`', {
    code: 'P2010',
    clientVersion: '5.22.0',
    meta: { code: '1064', message: 'You have an error in your SQL syntax' },
  });
  assert.equal(isRetryableResearchPersistenceConcurrencyError(error), false);
});

test('FIX-2 retry classifier: an unrelated Prisma known-request error (e.g. P2002 unique constraint) is NOT retryable', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0', meta: { target: ['id'] } });
  assert.equal(isRetryableResearchPersistenceConcurrencyError(error), false);
});

test('FIX-2 retry classifier: MySQL 1205 lock-wait-timeout is deliberately NOT retryable (see service file doc)', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `1205`. Message: `Lock wait timeout exceeded; try restarting transaction`', {
    code: 'P2010',
    clientVersion: '5.22.0',
    meta: { code: '1205', message: 'Lock wait timeout exceeded; try restarting transaction' },
  });
  assert.equal(isRetryableResearchPersistenceConcurrencyError(error), false);
});

test('FIX-2 retry classifier: a plain non-Prisma Error is NOT retryable', () => {
  assert.equal(isRetryableResearchPersistenceConcurrencyError(new Error('some unrelated failure')), false);
});

test('FIX-2 DEADLOCK-THEN-SUCCESS: attempt 1 throws the exact reproduced 1213 shape, attempt 2 succeeds -- transaction attempted exactly twice, final result returned, first error never surfaced', async () => {
  const { service, prisma } = newServiceWithBehaviors([
    () => Promise.reject(deadlockRawQueryError()),
    () => Promise.resolve(successfulResultFixture),
  ]);

  const candidate: CanonicalHistoricalCandle[] = [
    { assetType: HistoricalAssetType.NIFTY_INDEX, instrumentKey: INSTRUMENT_KEY, candleTime: T0, open: 100, high: 101, low: 99, close: 100.5, volume: 1_000n, openInterest: null },
  ];

  const result = await service.persistSession(metadataFixture(), candidate);

  assert.deepEqual(result, successfulResultFixture);
  assert.equal(prisma.callCount, 2, 'must retry the WHOLE transaction exactly once after the deadlock, never more');
});

test('FIX-2 NON-RETRYABLE ERROR: exactly one attempt, original error propagated unchanged', async () => {
  const originalError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0', meta: { target: ['id'] } });
  const { service, prisma } = newServiceWithBehaviors([() => Promise.reject(originalError)]);

  await assert.rejects(
    () => service.persistSession(metadataFixture(), []),
    (error: unknown) => error === originalError
  );
  assert.equal(prisma.callCount, 1, 'a non-retryable error must never trigger a second attempt');
});

test('FIX-2 RETRY EXHAUSTION: retryable error on every attempt stops at the configured maximum, final failure propagates as a typed exhaustion error, no infinite loop', async () => {
  const behaviors = Array.from({ length: RESEARCH_PERSISTENCE_MAX_ATTEMPTS }, () => () => Promise.reject(deadlockRawQueryError()));
  const { service, prisma } = newServiceWithBehaviors(behaviors);

  await assert.rejects(
    () => service.persistSession(metadataFixture(), []),
    (error: unknown) => {
      assert.ok(error instanceof ResearchPersistenceConcurrencyRetriesExhaustedError);
      assert.equal(error.attempts, RESEARCH_PERSISTENCE_MAX_ATTEMPTS);
      assert.ok(error.cause instanceof Prisma.PrismaClientKnownRequestError);
      assert.equal((error.cause as Prisma.PrismaClientKnownRequestError).code, 'P2010');
      return true;
    }
  );
  assert.equal(prisma.callCount, RESEARCH_PERSISTENCE_MAX_ATTEMPTS, `must attempt exactly ${RESEARCH_PERSISTENCE_MAX_ATTEMPTS} times, never more (bounded, no infinite loop)`);
});

test('FIX-2 exhaustion error never leaks connection/credential detail -- message is a fixed, generic diagnostic string', async () => {
  const behaviors = Array.from({ length: RESEARCH_PERSISTENCE_MAX_ATTEMPTS }, () => () => Promise.reject(deadlockRawQueryError()));
  const { service } = newServiceWithBehaviors(behaviors);

  try {
    await service.persistSession(metadataFixture(), []);
    assert.fail('expected persistSession to throw after exhausting retries');
  } catch (error) {
    assert.ok(error instanceof ResearchPersistenceConcurrencyRetriesExhaustedError);
    assert.doesNotMatch(error.message, /mysql:\/\/|password|@.*:.*\d{2,5}\//i);
  }
});
