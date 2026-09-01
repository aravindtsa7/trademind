import { Prisma, PrismaClient } from '@prisma/client';
import { HistoricalCandleRepairContributionRole, HistoricalCandleRepairOutcome, computeRepairEvidenceSemanticChecksum } from '../domain';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

const defaultPrismaClient = new PrismaClient();

export interface RepairContributionInput {
  readonly candleTime: Date;
  readonly role: HistoricalCandleRepairContributionRole;
  readonly repairContentChecksum: string;
  /** Populated only for `CORROBORATED_OVERLAP`/`CONFLICTING_OVERLAP` -- the already-persisted-or-primary-accepted content this repair row was compared against. `null` for `REPAIR_FILLED_MISSING` (no primary content existed at that timestamp). */
  readonly primaryContentChecksum: string | null;
}

export interface RecordRepairAttemptInput {
  readonly primaryRetrievalId: string;
  readonly primaryProviderId: HistoricalProviderId;
  readonly primarySessionId: string;
  readonly repairProviderId: HistoricalProviderId;
  readonly repairRetrievalId: string | null;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly repairPolicyVersion: number;
  /** The exact authoritative calendar session window(s) this attempt was resolved against -- task invariant B-F8/5 (durable, normalized, never a future calendar-table dependency). */
  readonly sessionWindows: readonly SessionWindow[];
  readonly expectedMinuteCount: number;
  readonly primaryAcceptedRowCount: number;
  readonly missingMinuteCount: number;
  readonly repairAcceptedMinuteCount: number;
  readonly corroboratedOverlapCount: number;
  readonly conflictingOverlapCount: number;
  readonly outcome: HistoricalCandleRepairOutcome;
  readonly resultingSessionId: string | null;
  readonly missingMinutesChecksum: string;
  /** Task invariant B-F8/1 (blocker 1): per-timestamp durable contribution evidence -- see `HistoricalCandleRepairContribution` schema doc. May be empty (e.g. a `REPAIR_INCOMPLETE` attempt that resolved zero minutes). */
  readonly contributions: readonly RepairContributionInput[];
}

/**
 * B-F8: durable, append-only writer for `HistoricalCandleRepairEvidence` and
 * its two child tables (`HistoricalCandleRepairSessionWindow`,
 * `HistoricalCandleRepairContribution`). Deliberately separate from
 * `HistoricalDataRetrievalEvidenceService` (which owns the B-F2C
 * retrieval-lifecycle vocabulary this service never mutates) and from
 * `HistoricalCandleResearchPersistenceService` (which owns the actual candle
 * write) -- this service owns ONLY the composite gap-repair provenance rows
 * themselves. This SERVICE's own write path never mutates or deletes an
 * existing row: a rerun writes a brand-new evidence row (and its own fresh
 * window/contribution rows), never revising a prior one, exactly like every
 * other B-F2C evidence table. (LOW 5 CORRECTION, post-Terra-review: this is
 * a service-level convention, not a database-permanent retention guarantee
 * -- see `HistoricalCandleRepairEvidence`'s schema doc comment for the exact
 * scope of what "append-only" means here.)
 *
 * All three tables for one attempt are written inside ONE transaction when
 * called via `recordRepairAttempt` -- unlike `recordNonPersistableSession`
 * (a single-row insert, no transaction needed), this write spans up to
 * three related tables and must never leave a durable evidence row with an
 * incomplete/missing window or contribution set (task invariant B-F8/1:
 * "the result must be queryable from durable DB state alone"). HIGH 2
 * CORRECTION (post-Terra-review): `recordRepairAttemptWithinTransaction`
 * writes the SAME three tables using a caller-supplied, ALREADY-OPEN
 * transaction instead -- see that method's own doc comment.
 */
/** Structural shape this service needs to issue its three writes -- satisfied by both `PrismaClient` and a `Prisma.TransactionClient` (an already-open interactive transaction handed in by a caller, e.g. `HistoricalCandleResearchPersistenceService`'s `onAcceptedWithinTransaction` hook). */
type RepairEvidenceWriter = Pick<PrismaClient | Prisma.TransactionClient, 'historicalCandleRepairEvidence' | 'historicalCandleRepairSessionWindow' | 'historicalCandleRepairContribution'>;

export default class HistoricalCandleRepairEvidenceService {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  /**
   * Original entry point: opens its OWN transaction and writes all three
   * tables inside it. Unchanged behavior for every existing caller (e.g. a
   * `REPAIR_CONFLICT`/`REPAIR_INCOMPLETE` attempt, which has no accepted
   * canonical session to be atomic with in the first place).
   */
  async recordRepairAttempt(input: RecordRepairAttemptInput): Promise<string> {
    return this.prisma.$transaction((tx) => this.writeRepairAttempt(tx, input));
  }

  /**
   * HIGH 2 CORRECTION (post-Terra-review): writes the SAME three tables
   * using an ALREADY-OPEN transaction/client the caller supplies, instead of
   * opening a new nested one. Exists specifically so
   * `HistoricalCandleResearchPersistenceService.persistSession`'s
   * `onAcceptedWithinTransaction` hook can call this from INSIDE its own
   * SERIALIZABLE transaction -- after the resulting `HistoricalCandle` rows
   * and accepted `HistoricalDataRetrievalSession` are written but BEFORE
   * COMMIT -- so a crash between "candles committed" and "repair provenance
   * committed" (the exact Terra-reproduced crash window) becomes impossible:
   * either the whole transaction (candles + session + repair evidence)
   * commits together, or a thrown error here rolls back everything,
   * including the candle rows.
   */
  async recordRepairAttemptWithinTransaction(tx: Prisma.TransactionClient, input: RecordRepairAttemptInput): Promise<string> {
    return this.writeRepairAttempt(tx, input);
  }

  private async writeRepairAttempt(client: RepairEvidenceWriter, input: RecordRepairAttemptInput): Promise<string> {
    const repairSemanticChecksum = computeRepairEvidenceSemanticChecksum({
      instrumentKey: input.instrumentKey,
      timeframe: input.timeframe,
      tradingDate: input.tradingDate,
      repairProviderId: input.repairProviderId,
      expectedMinuteCount: input.expectedMinuteCount,
      primaryAcceptedRowCount: input.primaryAcceptedRowCount,
      missingMinuteCount: input.missingMinuteCount,
      repairAcceptedMinuteCount: input.repairAcceptedMinuteCount,
      corroboratedOverlapCount: input.corroboratedOverlapCount,
      conflictingOverlapCount: input.conflictingOverlapCount,
      outcome: input.outcome,
      missingMinutesChecksum: input.missingMinutesChecksum,
    });

    const created = await client.historicalCandleRepairEvidence.create({
      data: {
        primaryRetrievalId: input.primaryRetrievalId,
        primaryProviderId: input.primaryProviderId,
        primarySessionId: input.primarySessionId,
        repairProviderId: input.repairProviderId,
        repairRetrievalId: input.repairRetrievalId,
        instrumentKey: input.instrumentKey,
        timeframe: input.timeframe,
        tradingDate: input.tradingDate,
        calendarDisposition: input.calendarDisposition,
        repairPolicyVersion: input.repairPolicyVersion,
        expectedMinuteCount: input.expectedMinuteCount,
        primaryAcceptedRowCount: input.primaryAcceptedRowCount,
        missingMinuteCount: input.missingMinuteCount,
        repairAcceptedMinuteCount: input.repairAcceptedMinuteCount,
        corroboratedOverlapCount: input.corroboratedOverlapCount,
        conflictingOverlapCount: input.conflictingOverlapCount,
        outcome: input.outcome,
        resultingSessionId: input.resultingSessionId,
        missingMinutesChecksum: input.missingMinutesChecksum,
        repairSemanticChecksum,
      },
    });

    if (input.sessionWindows.length > 0) {
      await client.historicalCandleRepairSessionWindow.createMany({
        data: input.sessionWindows.map((window) => ({
          repairEvidenceId: created.id,
          windowIndex: window.windowIndex,
          openMinuteIst: window.openMinuteIst,
          closeMinuteIst: window.closeMinuteIst,
        })),
      });
    }

    if (input.contributions.length > 0) {
      await client.historicalCandleRepairContribution.createMany({
        data: input.contributions.map((contribution) => ({
          repairEvidenceId: created.id,
          candleTime: contribution.candleTime,
          role: contribution.role,
          repairProviderId: input.repairProviderId,
          repairRetrievalId: input.repairRetrievalId,
          repairContentChecksum: contribution.repairContentChecksum,
          primaryContentChecksum: contribution.primaryContentChecksum,
        })),
      });
    }

    return created.id;
  }
}
