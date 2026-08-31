import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import {
  CandleContentValue,
  candleContentEquals,
  computeCandleContentChecksum,
  computeCanonicalCandleSetChecksum,
} from '../domain/historical-candle-content-identity';
import {
  DatasetHealthStatus,
  HistoricalCandleSessionPersistenceOutcome,
  computeEvidenceSemanticChecksum,
} from '../domain';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

const defaultPrismaClient = new PrismaClient();

export interface ResearchCandleSessionMetadata {
  readonly retrievalId: string;
  readonly providerId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly expectedMinuteCount: number;
  readonly providerRowCountForDate: number;
  readonly healthStatus: DatasetHealthStatus;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly sourceRowsSemanticChecksum: string;
  readonly from: Date;
  readonly to: Date;
}

export interface CandleConflictValueSnapshot {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly openInterest: string | null;
}

export interface CandleConflictDetail {
  readonly candleTime: Date;
  readonly existing: CandleConflictValueSnapshot;
  readonly incoming: CandleConflictValueSnapshot;
  readonly existingContentChecksum: string;
  readonly incomingContentChecksum: string;
}

export type ResearchSessionPersistenceOutcome = 'ACCEPTED_NEW' | 'ACCEPTED_IDEMPOTENT' | 'CONFLICT';

/**
 * B-F2C FIX-2: total whole-transaction attempts (including the first). Small
 * and fixed -- this path runs on a bounded, non-hot LOCAL Research Lake
 * backfill, never a high-concurrency live path, so a short deterministic
 * bound is enough to let the InnoDB deadlock "victim" transaction observe
 * the winner's committed content on its next attempt, without ever looping
 * unboundedly.
 */
export const RESEARCH_PERSISTENCE_MAX_ATTEMPTS = 3;
const RESEARCH_PERSISTENCE_RETRY_BASE_DELAY_MS = 20;

/** Deterministic linear backoff (20ms, 40ms, ...) -- never random jitter, so retry timing stays exactly reproducible in tests and adds negligible wall-clock time across a 3-attempt bound. */
function researchPersistenceRetryDelayMs(attempt: number): number {
  return RESEARCH_PERSISTENCE_RETRY_BASE_DELAY_MS * attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * All `RESEARCH_PERSISTENCE_MAX_ATTEMPTS` whole-transaction attempts failed
 * with the same class of MySQL/InnoDB concurrency-transient error -- never a
 * silent swallow. `cause` carries the last underlying Prisma error for
 * diagnostics; never logged/serialized with request credentials (Prisma's
 * raw-query error `meta` here is only ever a DB error code/message, never a
 * connection string or header).
 */
export class ResearchPersistenceConcurrencyRetriesExhaustedError extends Error {
  constructor(public readonly attempts: number, public readonly cause: unknown) {
    super(
      `HistoricalCandleResearchPersistenceService.persistSession: exhausted ${attempts} attempt(s) after repeated MySQL concurrency-transient failures (InnoDB deadlock / Prisma transaction write-conflict). See this error's 'cause' for the last underlying Prisma error.`
    );
    this.name = 'ResearchPersistenceConcurrencyRetriesExhaustedError';
  }
}

/**
 * B-F2C FIX-2: classifies exactly the MySQL/InnoDB concurrency-transient
 * failures `persistSession`'s SERIALIZABLE + `SELECT ... FOR UPDATE`
 * transaction can legitimately produce when two callers race for the same
 * candle range -- deliberately narrow, never a catch-all.
 *
 * Two shapes are retryable, both confirmed against the actually installed
 * Prisma client (v5.22.0, per `@prisma/client/package.json`) and the
 * empirically reproduced integration-test failure:
 *
 * - `P2010` ("Raw query failed") with `meta.code === '1213'`:
 *   `lockExistingRange`'s `SELECT ... FOR UPDATE` is a raw query
 *   (`tx.$queryRaw`), so Prisma surfaces the underlying MySQL driver error
 *   verbatim under `meta` rather than translating it -- this is the EXACT
 *   shape of the reproduced failure (MySQL 1213 / ER_LOCK_DEADLOCK:
 *   "Deadlock found when trying to get lock; try restarting transaction").
 * - `P2034` ("Transaction failed due to a write conflict or a deadlock."):
 *   this Prisma version's query engine can ALSO report a deadlock/write
 *   conflict detected while running a query-engine-issued (non-raw)
 *   statement inside the SAME interactive transaction (e.g.
 *   `historicalDataRetrievalSession.create`) -- confirmed present in the
 *   installed MySQL query-engine binary for this Prisma version (`grep
 *   P2034 node_modules/@prisma/client/runtime/query_engine_bg.mysql.wasm`),
 *   so it is included even though the reproduced failure happened to hit
 *   the raw-query path first.
 *
 * Deliberately NOT retryable: schema/syntax errors, FK violations, invalid
 * input, auth failures, or any other Prisma exception. MySQL 1205 (lock
 * wait timeout) is deliberately EXCLUDED: this transaction's critical
 * section is one short range lock with no external I/O, so a 1205 here
 * would mean a lock held far longer than any legitimate InnoDB
 * deadlock-victim race -- e.g. a stuck/hung competing transaction,
 * connection-pool exhaustion, or a genuine bug -- and retrying it could
 * mask that different failure instead of resolving a benign concurrent
 * insert race. If 1205 is ever observed empirically on this path, it should
 * be investigated on its own terms rather than folded into this set.
 */
export function isRetryableResearchPersistenceConcurrencyError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code === 'P2010' && (error.meta as { code?: unknown } | undefined)?.code === '1213') return true;
  return false;
}

export interface ResearchSessionPersistenceResult {
  readonly outcome: ResearchSessionPersistenceOutcome;
  readonly insertedCount: number;
  readonly idempotentCount: number;
  readonly conflicts: readonly CandleConflictDetail[];
  readonly sessionEvidenceId: string;
}

/** Structural shape this service needs from an existing persisted row -- deliberately loose on numeric field types (`unknown`) because a raw `FOR UPDATE` query's driver-level type mapping for DECIMAL/BIGINT columns is not asserted here; `canonicalDecimalString`/`normalizeBigInt` below accept and validate whatever shape actually arrives. */
export interface ExistingCandleRow {
  readonly candleTime: Date;
  readonly open: unknown;
  readonly high: unknown;
  readonly low: unknown;
  readonly close: unknown;
  readonly volume: unknown;
  readonly openInterest: unknown;
}

export interface SessionPersistencePlan {
  readonly toInsert: readonly CanonicalHistoricalCandle[];
  readonly idempotentCount: number;
  readonly conflicts: readonly CandleConflictDetail[];
}

function normalizeBigInt(field: string, value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  throw new Error(`HistoricalCandleResearchPersistenceService: value for '${field}' cannot be normalized to bigint (received ${typeof value}).`);
}

function toContentValue(instrumentKey: string, timeframe: string, row: ExistingCandleRow): CandleContentValue {
  return {
    instrumentKey,
    timeframe,
    candleTime: row.candleTime,
    open: row.open as number | string | Prisma.Decimal,
    high: row.high as number | string | Prisma.Decimal,
    low: row.low as number | string | Prisma.Decimal,
    close: row.close as number | string | Prisma.Decimal,
    volume: normalizeBigInt('volume', row.volume) ?? 0n,
    openInterest: normalizeBigInt('openInterest', row.openInterest),
  };
}

function toSnapshot(value: CandleContentValue): CandleConflictValueSnapshot {
  const decimalString = (v: number | string | Prisma.Decimal): string => new Prisma.Decimal(v as Prisma.Decimal.Value).toFixed();
  return {
    open: decimalString(value.open),
    high: decimalString(value.high),
    low: decimalString(value.low),
    close: decimalString(value.close),
    volume: value.volume.toString(),
    openInterest: value.openInterest === null ? null : value.openInterest.toString(),
  };
}

/**
 * B-F2C invariants 5-9: the ENTIRE decision of "insert / no-op / conflict"
 * for one trading session, as a pure function over already-fetched
 * existing rows and the already-canonicalized incoming candidate set --
 * zero I/O, so every comparison edge case (OHLC diff, volume diff, OI
 * null-vs-value, OI value-vs-different-value, Decimal/number/string
 * representation equivalence, legacy `source` irrelevance) is directly
 * unit-testable without a database. `HistoricalCandleResearchPersistenceService.
 * persistSession` below is a thin, DB-touching wrapper around this: it
 * fetches `existingRows` under a locking read, calls this, then commits
 * exactly what this function decided inside the SAME transaction.
 */
export function planSessionPersistence(
  instrumentKey: string,
  timeframe: string,
  existingRows: readonly ExistingCandleRow[],
  candidateCandles: readonly CanonicalHistoricalCandle[]
): SessionPersistencePlan {
  const existingByTime = new Map(existingRows.map((row) => [row.candleTime.getTime(), row]));
  const toInsert: CanonicalHistoricalCandle[] = [];
  const conflicts: CandleConflictDetail[] = [];
  let idempotentCount = 0;

  for (const candidate of candidateCandles) {
    const existingRow = existingByTime.get(candidate.candleTime.getTime());
    if (!existingRow) {
      toInsert.push(candidate);
      continue;
    }

    const existingValue = toContentValue(instrumentKey, timeframe, existingRow);
    const incomingValue: CandleContentValue = {
      instrumentKey,
      timeframe,
      candleTime: candidate.candleTime,
      open: candidate.open,
      high: candidate.high,
      low: candidate.low,
      close: candidate.close,
      volume: candidate.volume,
      openInterest: candidate.openInterest,
    };

    if (candleContentEquals(existingValue, incomingValue)) {
      idempotentCount += 1;
      continue;
    }

    conflicts.push({
      candleTime: candidate.candleTime,
      existing: toSnapshot(existingValue),
      incoming: toSnapshot(incomingValue),
      existingContentChecksum: computeCandleContentChecksum(existingValue),
      incomingContentChecksum: computeCandleContentChecksum(incomingValue),
    });
  }

  // B-F2C invariant 8 (session atomicity): a single differing minute makes
  // the caller discard `toInsert`/`idempotentCount` entirely (see
  // `persistSession`) -- this function itself never filters conflicts out
  // of consideration, it only ever reports them.
  return { toInsert, idempotentCount, conflicts };
}

/**
 * B-F2C research-lake-specific immutable persistence: NEVER overwrites an
 * existing `HistoricalCandle` row with different content (no
 * `ON DUPLICATE KEY UPDATE` of OHLCVOI/source/updatedAt for this path --
 * contrast with the pre-existing, UNCHANGED `HistoricalCandleRepository.
 * bulkUpsert`, which every other caller -- live warmup, sync, resume --
 * keeps using exactly as before). Scoped to `NiftyUnderlyingAcquisitionService`
 * only for this milestone; not a global repository redesign.
 *
 * TRANSACTION SAFETY (invariants 8/9): opens a `SERIALIZABLE` transaction,
 * takes an explicit `SELECT ... FOR UPDATE` range lock over the session's
 * full `[from, to]` candleTime span BEFORE comparing anything, then either
 * (a) writes conflict evidence and performs ZERO candle mutation, or (b)
 * inserts only the genuinely-missing rows and writes accepted evidence --
 * all inside that same transaction, so candle state and evidence state for
 * this date always commit together or not at all (no crash window can
 * separate them). InnoDB's row/gap locking is enforced for ANY transaction
 * touching this key range regardless of which code path issued it (a
 * concurrent `bulkUpsert` INSERT ... ON DUPLICATE KEY UPDATE from an
 * unrelated live-warmup/sync caller into the SAME range would itself block
 * until this transaction commits/rolls back) -- so this remains race-safe
 * even against the pre-existing write path, without requiring any change
 * to it. A second concurrent `persistSession` call for the identical
 * session fully serializes behind the first: its own `SELECT ... FOR
 * UPDATE` blocks until the first commits, then sees the first's committed
 * rows and correctly resolves to idempotent-verified or conflict, never a
 * blind second insert/overwrite.
 */
export default class HistoricalCandleResearchPersistenceService {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  /**
   * B-F2C FIX-2: bounded whole-transaction retry around
   * `persistSessionTransactionOnce`. On a classified concurrency-transient
   * failure (see `isRetryableResearchPersistenceConcurrencyError`), the
   * failed SERIALIZABLE transaction has ALREADY been rolled back in full
   * (Prisma rolls back an interactive transaction whose callback throws) --
   * this re-enters a BRAND NEW transaction from scratch (BEGIN -> SELECT
   * ... FOR UPDATE -> semantic comparison -> decision -> write -> COMMIT),
   * never resuming or patching the aborted attempt. This lets a deadlock
   * "victim" observe whatever the winner actually committed and resolve
   * truthfully to ACCEPTED_IDEMPOTENT/CONFLICT -- it never fabricates
   * either outcome from the caught error itself. Retries are pure DB
   * transaction retries: `metadata.retrievalId` is reused unchanged across
   * every attempt (no new `HistoricalDataRetrieval` row, no
   * `providerCallAttempts` increment, no new provider call of any kind).
   * A non-retryable error (or a class the classifier does not recognize)
   * propagates immediately after exactly one attempt.
   */
  async persistSession(metadata: ResearchCandleSessionMetadata, candidateCandles: readonly CanonicalHistoricalCandle[]): Promise<ResearchSessionPersistenceResult> {
    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= RESEARCH_PERSISTENCE_MAX_ATTEMPTS; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each whole-transaction attempt must fully commit or roll back before any retry may re-read committed state; attempts are never run concurrently with each other
        return await this.persistSessionTransactionOnce(metadata, candidateCandles);
      } catch (error) {
        if (!isRetryableResearchPersistenceConcurrencyError(error)) throw error;
        lastRetryableError = error;
        if (attempt === RESEARCH_PERSISTENCE_MAX_ATTEMPTS) break;
        // eslint-disable-next-line no-await-in-loop -- deliberate bounded backoff between whole-transaction retry attempts
        await delay(researchPersistenceRetryDelayMs(attempt));
      }
    }
    throw new ResearchPersistenceConcurrencyRetriesExhaustedError(RESEARCH_PERSISTENCE_MAX_ATTEMPTS, lastRetryableError);
  }

  /**
   * ONE full attempt: BEGIN -> SELECT ... FOR UPDATE -> semantic comparison
   * -> conflict/idempotent/new decision -> candle/evidence write -> COMMIT
   * (or a full automatic rollback on any thrown error, per Prisma's
   * interactive-transaction contract). Only `persistSession` above ever
   * calls this, and only it decides whether a failure here is retried.
   */
  private async persistSessionTransactionOnce(metadata: ResearchCandleSessionMetadata, candidateCandles: readonly CanonicalHistoricalCandle[]): Promise<ResearchSessionPersistenceResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const existingRows = await this.lockExistingRange(tx, metadata.instrumentKey, metadata.timeframe, metadata.from, metadata.to);
        const plan = planSessionPersistence(metadata.instrumentKey, metadata.timeframe, existingRows, candidateCandles);

        if (plan.conflicts.length > 0) {
          const sessionEvidenceId = await this.writeSessionEvidence(tx, metadata, HistoricalCandleSessionPersistenceOutcome.CONFLICT, candidateCandles);
          await this.writeConflicts(tx, sessionEvidenceId, metadata, plan.conflicts);
          return { outcome: 'CONFLICT' as const, insertedCount: 0, idempotentCount: 0, conflicts: plan.conflicts, sessionEvidenceId };
        }

        if (plan.toInsert.length > 0) {
          await this.insertMissing(tx, metadata.instrumentKey, metadata.timeframe, plan.toInsert);
        }

        const outcome = plan.toInsert.length > 0 ? HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW : HistoricalCandleSessionPersistenceOutcome.ACCEPTED_IDEMPOTENT;
        const sessionEvidenceId = await this.writeSessionEvidence(tx, metadata, outcome, candidateCandles);
        return {
          outcome: outcome === HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW ? ('ACCEPTED_NEW' as const) : ('ACCEPTED_IDEMPOTENT' as const),
          insertedCount: plan.toInsert.length,
          idempotentCount: plan.idempotentCount,
          conflicts: [],
          sessionEvidenceId,
        };
      },
      // SERIALIZABLE is the strongest isolation MySQL/InnoDB offers via Prisma; combined with the
      // explicit FOR UPDATE range lock below, this is deliberately more conservative than the minimum
      // (REPEATABLE READ + FOR UPDATE range/gap locks would already suffice) because this path runs on
      // a bounded, non-hot research backfill, not a latency-sensitive live path -- correctness margin is
      // preferred over throughput here.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }
    );
  }

  private async lockExistingRange(tx: Prisma.TransactionClient, instrumentKey: string, timeframe: string, from: Date, to: Date): Promise<ExistingCandleRow[]> {
    return tx.$queryRaw<ExistingCandleRow[]>`
      SELECT \`candleTime\`, \`open\`, \`high\`, \`low\`, \`close\`, \`volume\`, \`openInterest\`
      FROM \`HistoricalCandle\`
      WHERE \`instrumentKey\` = ${instrumentKey} AND \`timeframe\` = ${timeframe}
        AND \`candleTime\` >= ${from} AND \`candleTime\` <= ${to}
      FOR UPDATE
    `;
  }

  private async insertMissing(tx: Prisma.TransactionClient, instrumentKey: string, timeframe: string, candles: readonly CanonicalHistoricalCandle[]): Promise<void> {
    const now = new Date();
    for (const candle of candles) {
      const open = new Prisma.Decimal(candle.open).toFixed();
      const high = new Prisma.Decimal(candle.high).toFixed();
      const low = new Prisma.Decimal(candle.low).toFixed();
      const close = new Prisma.Decimal(candle.close).toFixed();
      // eslint-disable-next-line no-await-in-loop -- one session's inserts stay ordered/attributable within this single already-locked transaction, matching the repository's own bulkUpsert convention
      await tx.$executeRaw`
        INSERT INTO \`HistoricalCandle\`
          (\`id\`, \`instrumentKey\`, \`timeframe\`, \`candleTime\`, \`open\`, \`high\`, \`low\`, \`close\`, \`volume\`, \`openInterest\`, \`source\`, \`createdAt\`, \`updatedAt\`)
        VALUES
          (${randomUUID()}, ${instrumentKey}, ${timeframe}, ${candle.candleTime}, ${open}, ${high}, ${low}, ${close}, ${candle.volume}, ${candle.openInterest}, ${'REST'}, DEFAULT, ${now})
      `;
    }
  }

  private async writeSessionEvidence(
    tx: Prisma.TransactionClient,
    metadata: ResearchCandleSessionMetadata,
    outcome: HistoricalCandleSessionPersistenceOutcome,
    candidateCandles: readonly CanonicalHistoricalCandle[]
  ): Promise<string> {
    const acceptedRowCount = candidateCandles.length;
    // Hashes the ACCEPTED canonical set canonicalization decided on for this session --
    // never the persistence outcome (a CONFLICT date and its would-be-accepted set still get a
    // meaningful checksum here, distinct from the `null` used only when there is truly no candidate
    // content at all, e.g. a healthy-but-empty projection, which should not occur in practice).
    const canonicalContentChecksum =
      acceptedRowCount > 0
        ? computeCanonicalCandleSetChecksum(
            candidateCandles.map((candle) => ({
              instrumentKey: metadata.instrumentKey,
              timeframe: metadata.timeframe,
              candleTime: candle.candleTime,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              openInterest: candle.openInterest,
            }))
          )
        : null;
    const evidenceSemanticChecksum = computeEvidenceSemanticChecksum({
      providerId: metadata.providerId,
      instrumentKey: metadata.instrumentKey,
      timeframe: metadata.timeframe,
      tradingDate: metadata.tradingDate,
      calendarDisposition: metadata.calendarDisposition,
      expectedMinuteCount: metadata.expectedMinuteCount,
      providerRowCountForDate: metadata.providerRowCountForDate,
      acceptedRowCount,
      excludedRowCount: metadata.excludedRowCount,
      sourceOrderAnomalyCount: metadata.sourceOrderAnomalyCount,
      healthStatus: metadata.healthStatus,
      persistenceOutcome: outcome,
      sourceRowsSemanticChecksum: metadata.sourceRowsSemanticChecksum,
      canonicalContentChecksum,
    });

    const created = await tx.historicalDataRetrievalSession.create({
      data: {
        retrievalId: metadata.retrievalId,
        instrumentKey: metadata.instrumentKey,
        timeframe: metadata.timeframe,
        tradingDate: metadata.tradingDate,
        calendarDisposition: metadata.calendarDisposition,
        expectedMinuteCount: metadata.expectedMinuteCount,
        providerRowCountForDate: metadata.providerRowCountForDate,
        acceptedRowCount,
        excludedRowCount: metadata.excludedRowCount,
        sourceOrderAnomalyCount: metadata.sourceOrderAnomalyCount,
        healthStatus: metadata.healthStatus,
        persistenceOutcome: outcome,
        sourceRowsSemanticChecksum: metadata.sourceRowsSemanticChecksum,
        canonicalContentChecksum,
        evidenceSemanticChecksum,
      },
    });
    return created.id;
  }

  private async writeConflicts(tx: Prisma.TransactionClient, retrievalSessionId: string, metadata: ResearchCandleSessionMetadata, conflicts: readonly CandleConflictDetail[]): Promise<void> {
    if (conflicts.length === 0) return;
    await tx.historicalCandleConflict.createMany({
      data: conflicts.map((conflict) => ({
        retrievalSessionId,
        instrumentKey: metadata.instrumentKey,
        timeframe: metadata.timeframe,
        candleTime: conflict.candleTime,
        existingOpen: conflict.existing.open,
        existingHigh: conflict.existing.high,
        existingLow: conflict.existing.low,
        existingClose: conflict.existing.close,
        existingVolume: BigInt(conflict.existing.volume),
        existingOpenInterest: conflict.existing.openInterest === null ? null : BigInt(conflict.existing.openInterest),
        incomingOpen: conflict.incoming.open,
        incomingHigh: conflict.incoming.high,
        incomingLow: conflict.incoming.low,
        incomingClose: conflict.incoming.close,
        incomingVolume: BigInt(conflict.incoming.volume),
        incomingOpenInterest: conflict.incoming.openInterest === null ? null : BigInt(conflict.incoming.openInterest),
        existingContentChecksum: conflict.existingContentChecksum,
        incomingContentChecksum: conflict.incomingContentChecksum,
      })),
    });
  }
}
