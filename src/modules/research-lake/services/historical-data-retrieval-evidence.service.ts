import { PrismaClient } from '@prisma/client';
import {
  DatasetHealthStatus,
  HistoricalCandleRepairOutcome,
  HistoricalCandleSessionPersistenceOutcome,
  HistoricalDataRetrievalErrorCategory,
  HistoricalDataRetrievalStatus,
  computeEvidenceSemanticChecksum,
} from '../domain';
import {
  CompositeRepairProvenance,
  SourceAcquisitionEvidence,
  SourceAcquisitionEvidenceAvailability,
  SourceAcquisitionProvenanceComposition,
} from '../domain/dataset-manifest.types';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

const defaultPrismaClient = new PrismaClient();

export interface StartRetrievalInput {
  readonly providerId: HistoricalProviderId;
  readonly assetType: HistoricalAssetType;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly requestedFromDate: string;
  readonly requestedToDate: string;
}

export interface RecordFetchedInput {
  readonly sourceRowCount: number;
  readonly sourceRowsSemanticChecksum: string;
  readonly providerCallAttempts: number;
}

export interface RecordFailedInput {
  readonly errorCategory: HistoricalDataRetrievalErrorCategory;
  readonly errorMessage: string;
  readonly providerCallAttempts: number;
}

export interface NonPersistableSessionInput {
  readonly retrievalId: string;
  readonly providerId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly expectedMinuteCount: number;
  readonly providerRowCountForDate: number;
  readonly acceptedRowCount: number;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly healthStatus: DatasetHealthStatus;
  readonly persistenceOutcome:
    | HistoricalCandleSessionPersistenceOutcome.INCOMPLETE
    | HistoricalCandleSessionPersistenceOutcome.INVALID
    | HistoricalCandleSessionPersistenceOutcome.NO_PROVIDER_DATA_FOR_DATE;
  readonly sourceRowsSemanticChecksum: string | null;
}

/**
 * B-M7.1 CORRECTION: an OPTIONAL requirement that the PARENT
 * `HistoricalDataRetrieval.requestedFromDate`/`requestedToDate` exactly
 * equal `fromDate`/`toDate` -- see `findTerminalIncompleteSessionEvidence`'s
 * doc for why parent request SCOPE (not just row content) determines
 * whether one evidence row's `sourceRowsSemanticChecksum` is even
 * comparable to a fresh re-observation's checksum
 * (`SOURCE_ROWS_CHECKSUM_VERSION=1` folds each row's request-array-relative
 * `sourceIndex` into the digest, so a March-7 row sliced out of a
 * 2022-03-01..2022-03-31 monthly request and the SAME candle content
 * fetched via an exact 2022-03-07..2022-03-07 request do NOT produce the
 * same checksum, even though neither necessarily reflects drifted OHLC
 * data).
 */
export interface RequiredRetrievalRange {
  readonly fromDate: string;
  readonly toDate: string;
}

/** B-M7.1: input for `findTerminalIncompleteSessionEvidence` -- see that method's doc. */
export interface QualifyTerminalIncompleteEvidenceInput {
  readonly expectedProviderId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  /**
   * OPTIONAL. When supplied, only terminal INCOMPLETE evidence whose PARENT
   * retrieval was requested for EXACTLY this `[fromDate, toDate]` range may
   * qualify -- filtered IN the query itself (never fetched-then-filtered in
   * JS). Omitted callers keep the ORIGINAL, unscoped "single match or
   * ambiguous" behavior unchanged. A caller whose own re-observation is
   * itself an exact single-date request (e.g. B-M7.1) MUST supply
   * `{ fromDate: tradingDate, toDate: tradingDate }` here so its checksum
   * comparison baseline is drawn only from request-scope-compatible
   * evidence -- see the module doc on `RequiredRetrievalRange`.
   */
  readonly requiredRetrievalRange?: RequiredRetrievalRange;
}

/** B-M7.1: the exact durable facts `findTerminalIncompleteSessionEvidence` proves before returning -- a caller qualifies its own date-specific locked facts (e.g. 375/372 for 2022-03-07) on top of this. */
export interface QualifiedIncompleteSessionEvidence {
  readonly retrievalId: string;
  readonly sessionId: string;
  readonly providerId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly calendarDisposition: string;
  readonly expectedMinuteCount: number;
  readonly providerRowCountForDate: number;
  readonly acceptedRowCount: number;
  readonly excludedRowCount: number;
  readonly sourceOrderAnomalyCount: number;
  readonly healthStatus: DatasetHealthStatus;
  readonly persistenceOutcome: HistoricalCandleSessionPersistenceOutcome;
  readonly sourceRowsSemanticChecksum: string;
  readonly evidenceSemanticChecksum: string;
}

/** B-M7.1 task section 3: "no ambiguity exists ... selection must be deterministic and fail closed" -- thrown instead of silently picking one row. */
export class QualifiedIncompleteEvidenceAmbiguousError extends Error {
  constructor(instrumentKey: string, timeframe: string, tradingDate: string, readonly matchCount: number) {
    super(
      `HistoricalDataRetrievalEvidenceService.findTerminalIncompleteSessionEvidence: ${matchCount} terminal INCOMPLETE evidence rows matched ${instrumentKey}/${timeframe}/${tradingDate} for the expected provider -- ambiguous, refusing to pick one.`
    );
    this.name = 'QualifiedIncompleteEvidenceAmbiguousError';
  }
}

/** B-M7.1: the one matched row exists but fails a required structural invariant (see `findTerminalIncompleteSessionEvidence`'s doc for the exact checks). */
export class QualifiedIncompleteEvidenceInvariantError extends Error {
  constructor(message: string) {
    super(`HistoricalDataRetrievalEvidenceService.findTerminalIncompleteSessionEvidence: ${message}`);
    this.name = 'QualifiedIncompleteEvidenceInvariantError';
  }
}

const AVAILABLE_PERSISTENCE_OUTCOMES: ReadonlySet<string> = new Set([
  HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW,
  HistoricalCandleSessionPersistenceOutcome.ACCEPTED_IDEMPOTENT,
]);

/**
 * B-F2C FIX-1 (Terra defect H-1): a session's persistence outcome alone is
 * not enough to prove manifest provenance is truthfully AVAILABLE -- the
 * PARENT `HistoricalDataRetrieval` must also have reached a successful
 * TERMINAL status. `STARTED`/`FETCHED` mean the logical retrieval is still
 * in flight (or the process crashed before `finalizeRetrieval()`), and
 * `FAILED` means the provider call itself failed; none of these may ever
 * back an AVAILABLE manifest claim, even if one session row was atomically
 * committed as ACCEPTED_NEW/ACCEPTED_IDEMPOTENT before the crash.
 * `COMPLETED_WITH_ISSUES` DOES qualify: it means the overall request itself
 * finished (never in-flight), even though some OTHER date in the same
 * monthly chunk hit CONFLICT/INVALID/INCOMPLETE -- an individual accepted
 * date within that chunk is still genuinely, truthfully available.
 */
const SUCCESSFUL_TERMINAL_RETRIEVAL_STATUSES: ReadonlySet<string> = new Set([
  HistoricalDataRetrievalStatus.PROCESSED,
  HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES,
]);

/**
 * B-F2C durable retrieval-lifecycle evidence writer/reader. Deliberately
 * separate from `HistoricalCandleResearchPersistenceService` (which owns
 * the conflict-safe candle write + its OWN session/conflict evidence row,
 * atomically, inside one DB transaction): this service owns the
 * RETRIEVAL-level lifecycle (STARTED/FETCHED/FAILED/finalize) plus the
 * per-date evidence row for dates that never reach the persistence
 * transaction at all (INCOMPLETE/INVALID/NO_PROVIDER_DATA_FOR_DATE --
 * no candle mutation is ever possible for these, so a single plain insert
 * is sufficient; no transaction is needed for atomicity with a candle
 * write that never happens).
 *
 * Never persists an access token, Authorization header, API secret, or
 * complete Axios config -- `recordFailed` only ever receives an already-
 * sanitized `errorMessage` (see `NiftyUnderlyingAcquisitionService.describeError`).
 */
export default class HistoricalDataRetrievalEvidenceService {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  /** B-F2C invariant 1/2: called BEFORE the provider is ever invoked for this logical retrieval. */
  async startRetrieval(input: StartRetrievalInput): Promise<string> {
    const created = await this.prisma.historicalDataRetrieval.create({
      data: {
        providerId: input.providerId,
        assetType: input.assetType,
        instrumentKey: input.instrumentKey,
        timeframe: input.timeframe,
        requestedFromDate: input.requestedFromDate,
        requestedToDate: input.requestedToDate,
        status: HistoricalDataRetrievalStatus.STARTED,
        startedAt: new Date(),
      },
    });
    return created.id;
  }

  async recordFetched(retrievalId: string, input: RecordFetchedInput): Promise<void> {
    await this.prisma.historicalDataRetrieval.update({
      where: { id: retrievalId },
      data: {
        status: HistoricalDataRetrievalStatus.FETCHED,
        sourceRowCount: input.sourceRowCount,
        sourceRowsSemanticChecksum: input.sourceRowsSemanticChecksum,
        providerCallAttempts: input.providerCallAttempts,
      },
    });
  }

  /** B-F2C invariant 14: the provider call itself failed -- the retrieval evidence must never claim ACCEPTED. */
  async recordFailed(retrievalId: string, input: RecordFailedInput): Promise<void> {
    await this.prisma.historicalDataRetrieval.update({
      where: { id: retrievalId },
      data: {
        status: HistoricalDataRetrievalStatus.FAILED,
        errorCategory: input.errorCategory,
        errorMessage: input.errorMessage,
        providerCallAttempts: input.providerCallAttempts,
        completedAt: new Date(),
      },
    });
  }

  /** Finalizes the retrieval's overall lifecycle once every date it covered has reached a terminal per-date outcome. Never called if the provider call itself failed (see `recordFailed`) or if the run is `dryRun` (never called at all in that case). */
  async finalizeRetrieval(retrievalId: string, status: HistoricalDataRetrievalStatus.PROCESSED | HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES): Promise<void> {
    await this.prisma.historicalDataRetrieval.update({
      where: { id: retrievalId },
      data: { status, completedAt: new Date() },
    });
  }

  /** For a date that never reaches the persistence transaction (INCOMPLETE/INVALID/NO_PROVIDER_DATA_FOR_DATE) -- no candle mutation is possible here, so a single plain insert is sufficient (task invariant 10: exclusions/anomalies remain durable evidence even when nothing is persistable). */
  async recordNonPersistableSession(input: NonPersistableSessionInput): Promise<string> {
    const evidenceSemanticChecksum = computeEvidenceSemanticChecksum({
      providerId: input.providerId,
      instrumentKey: input.instrumentKey,
      timeframe: input.timeframe,
      tradingDate: input.tradingDate,
      calendarDisposition: input.calendarDisposition,
      expectedMinuteCount: input.expectedMinuteCount,
      providerRowCountForDate: input.providerRowCountForDate,
      acceptedRowCount: input.acceptedRowCount,
      excludedRowCount: input.excludedRowCount,
      sourceOrderAnomalyCount: input.sourceOrderAnomalyCount,
      healthStatus: input.healthStatus,
      persistenceOutcome: input.persistenceOutcome,
      sourceRowsSemanticChecksum: input.sourceRowsSemanticChecksum,
      canonicalContentChecksum: null,
    });
    const created = await this.prisma.historicalDataRetrievalSession.create({
      data: {
        retrievalId: input.retrievalId,
        instrumentKey: input.instrumentKey,
        timeframe: input.timeframe,
        tradingDate: input.tradingDate,
        calendarDisposition: input.calendarDisposition,
        expectedMinuteCount: input.expectedMinuteCount,
        providerRowCountForDate: input.providerRowCountForDate,
        acceptedRowCount: input.acceptedRowCount,
        excludedRowCount: input.excludedRowCount,
        sourceOrderAnomalyCount: input.sourceOrderAnomalyCount,
        healthStatus: input.healthStatus,
        persistenceOutcome: input.persistenceOutcome,
        sourceRowsSemanticChecksum: input.sourceRowsSemanticChecksum,
        canonicalContentChecksum: null,
        evidenceSemanticChecksum,
      },
    });
    return created.id;
  }

  /**
   * B-F2C invariant 13 (manifest truthfulness): looks up the most recent
   * durably-ACCEPTED (`ACCEPTED_NEW`/`ACCEPTED_IDEMPOTENT`) session evidence
   * for one session identity, for `DatasetManifestService` to expose as
   * `SourceAcquisitionEvidence`. Returns `null` (never a fabricated
   * default) when no such evidence exists -- a legacy, pre-B-F2C session
   * (or one this milestone's acquisition path never actually retrieved)
   * has genuinely no evidence to report.
   *
   * FIX-1 (Terra defect H-1): the session's own persistence outcome is not
   * sufficient -- the WHERE clause also requires the parent retrieval to be
   * in a `SUCCESSFUL_TERMINAL_RETRIEVAL_STATUSES` status, enforced IN the
   * query itself (never fetched then filtered in JS), so a session that was
   * atomically committed just before a crash left the parent `STARTED`/
   * `FETCHED` can never surface as AVAILABLE provenance. This method never
   * finalizes, repairs, or otherwise mutates the unfinished parent -- it
   * only declines to report it as available (read-only, fail-closed).
   *
   * FIX-1 (Terra defect M-1): "latest" is a fully deterministic, total
   * ordering, never `createdAt` alone (two rows can share an identical
   * DATETIME(3) `createdAt`). Ordered primarily by the PARENT retrieval's
   * `completedAt` (its finalized timestamp -- availability only becomes
   * valid once the logical retrieval is finalized, so that is the
   * meaningful "latest" instant), then by `retrieval.startedAt`, then by the
   * persisted `retrievalId`/session `id` as final stable tie-breakers. These
   * UUID tie-breakers select one deterministic persisted row ONLY -- they
   * never enter `evidenceSemanticChecksum`/`datasetChecksum`/`datasetId`, so
   * two semantically-identical accepted retrievals still produce identical
   * dataset identity regardless of which one this selection picks.
   */
  async findLatestAvailableSessionEvidence(instrumentKey: string, timeframe: string, tradingDate: string): Promise<SourceAcquisitionEvidence | null> {
    const row = await this.prisma.historicalDataRetrievalSession.findFirst({
      where: {
        instrumentKey,
        timeframe,
        tradingDate,
        persistenceOutcome: { in: [...AVAILABLE_PERSISTENCE_OUTCOMES] },
        retrieval: { status: { in: [...SUCCESSFUL_TERMINAL_RETRIEVAL_STATUSES] } },
      },
      orderBy: [{ retrieval: { completedAt: 'desc' } }, { retrieval: { startedAt: 'desc' } }, { retrievalId: 'desc' }, { id: 'desc' }],
      include: { retrieval: true },
    });
    if (!row) return null;

    // B-F8 CORRECTION (post-Terra-review blocker 2): a session's ACCEPTED
    // evidence row alone cannot say whether it is a pure-primary session or
    // a COMPOSITE session assembled by `NiftyUnderlyingGapRepairService` --
    // that fact lives only in `HistoricalCandleRepairEvidence`. Looked up
    // here (never inferred/guessed) so the manifest read path can never
    // silently misattribute a composite session as though ONE provider
    // supplied every accepted row.
    //
    // HIGH 1 CORRECTION (post-Terra-re-review): a session's
    // `provenanceComposition` is decided by a THREE-WAY, fail-closed
    // determination, never a simple "found a fully-provenanced row? yes/no"
    // binary -- doing so previously conflated "genuinely never repaired"
    // with "repaired, but a legacy row cannot prove exactly how" into the
    // SAME false `PRIMARY_ONLY` value.
    //
    //   (A) No REPAIR_ACCEPTED evidence at all for this resultingSessionId
    //       -> PRIMARY_ONLY (genuinely, provably pure-primary).
    //   (B) At least one FULLY-PROVENANCED REPAIR_ACCEPTED row exists
    //       (`calendarDisposition`/`primaryProviderId`/`repairPolicyVersion`
    //       all non-NULL -- see BLOCKER 1B / the migration's own doc
    //       comment for why these are nullable at the DB level at all)
    //       -> COMPOSITE_REPAIRED, attributed to the latest such row.
    //   (C) REPAIR_ACCEPTED evidence exists, but NONE of it carries
    //       sufficient durable provenance (a legacy row predating migration
    //       20260831174417) -> UNKNOWN_LEGACY_REPAIR_PROVENANCE, NEVER
    //       PRIMARY_ONLY -- this session IS known to be a repair composite;
    //       only its exact provider/policy attribution is unrecoverable.
    //       `compositeRepair` stays `null` here too (never fabricated).
    //
    // Two separate queries (never one query silently collapsing (B)/(C)):
    // the first only asks "does REPAIR_ACCEPTED evidence exist at all"
    // (case A vs B-or-C); the second (unchanged from the BLOCKER 1B
    // correction) finds the latest FULLY-PROVENANCED row, if any (B vs C).
    const anyRepairAcceptedEvidence = await this.prisma.historicalCandleRepairEvidence.findFirst({
      where: { resultingSessionId: row.id, outcome: HistoricalCandleRepairOutcome.REPAIR_ACCEPTED },
      select: { id: true },
    });

    let provenanceComposition = SourceAcquisitionProvenanceComposition.PRIMARY_ONLY;
    let compositeRepair: CompositeRepairProvenance | null = null;

    if (anyRepairAcceptedEvidence) {
      // BLOCKER 1B CORRECTION (post-Terra-review, unchanged): `calendarDisposition` /
      // `primaryProviderId` / `repairPolicyVersion` are nullable at the DB
      // level (see `prisma/migrations/20260831174417_.../migration.sql`'s doc
      // comment) because a row written before that migration cannot
      // truthfully populate them. This query requires all three to be
      // non-NULL IN THE QUERY ITSELF (never fetched then filtered in JS,
      // exactly like the FIX-1 terminal-status filter above).
      const composite = await this.prisma.historicalCandleRepairEvidence.findFirst({
        where: {
          resultingSessionId: row.id,
          outcome: HistoricalCandleRepairOutcome.REPAIR_ACCEPTED,
          calendarDisposition: { not: null },
          primaryProviderId: { not: null },
          repairPolicyVersion: { not: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      // Defensive null-check kept even though the WHERE clause above already
      // excludes incomplete rows -- this function must NEVER fabricate
      // `primaryProvider`/`repairPolicyVersion` from a `null`, so if a future
      // change ever weakens that WHERE clause, this still fails closed
      // rather than emitting bogus provenance.
      if (composite && composite.primaryProviderId !== null && composite.repairPolicyVersion !== null) {
        provenanceComposition = SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED;
        compositeRepair = {
          primaryProvider: composite.primaryProviderId as HistoricalProviderId,
          primaryRetrievalId: composite.primaryRetrievalId,
          repairProvider: composite.repairProviderId as HistoricalProviderId,
          repairRetrievalId: composite.repairRetrievalId,
          repairEvidenceId: composite.id,
          repairedMinuteCount: composite.repairAcceptedMinuteCount,
          repairPolicyVersion: composite.repairPolicyVersion,
        };
      } else {
        // Case (C): REPAIR_ACCEPTED evidence exists, but none of it is fully
        // provenanced. Fail closed to UNKNOWN_LEGACY_REPAIR_PROVENANCE --
        // this must NEVER fall through to PRIMARY_ONLY (HIGH 1).
        provenanceComposition = SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE;
        compositeRepair = null;
      }
    }

    return {
      availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
      providerRowCount: row.providerRowCountForDate,
      excludedRowCount: row.excludedRowCount,
      sourceOrderAnomalyCount: row.sourceOrderAnomalyCount,
      sourceHealthStatus: row.healthStatus as DatasetHealthStatus,
      provider: row.retrieval.providerId as HistoricalProviderId,
      evidenceSemanticChecksum: row.evidenceSemanticChecksum,
      provenanceComposition,
      compositeRepair,
    };
  }

  /**
   * B-M7.1 task section 3: READ-ONLY qualification lookup for the single
   * deterministic terminal INCOMPLETE `HistoricalDataRetrievalSession`
   * evidence row for one session identity, if one genuinely exists. Never
   * mutates or rewrites anything -- this is a pure read, exactly like
   * `findLatestAvailableSessionEvidence`, just aimed at the INCOMPLETE
   * persistence outcome instead of the ACCEPTED ones.
   *
   * Mirrors `findLatestAvailableSessionEvidence`'s FIX-1 discipline: BOTH
   * the session's own `persistenceOutcome` (`INCOMPLETE`) AND the parent
   * retrieval's successful terminal `status` (`PROCESSED`/
   * `COMPLETED_WITH_ISSUES`, never `STARTED`/`FETCHED`/`FAILED`) are
   * required IN the query itself -- an INCOMPLETE session evidence row
   * whose parent retrieval never reached a successful terminal state is not
   * yet trustworthy durable evidence of anything. `expectedProviderId`
   * additionally narrows to the exact primary provider a caller expects
   * (task section 3: "provider is the expected primary historical
   * provider"), never any provider's INCOMPLETE evidence.
   *
   * FAILS CLOSED, never guesses/defaults/silently picks one, on:
   *  - no matching row at all -> returns `null` (a caller decides whether
   *    that itself is a qualification failure);
   *  - MORE THAN ONE row matches this exact identity + outcome + provider +
   *    terminal-status filter -> `QualifiedIncompleteEvidenceAmbiguousError`
   *    (task section 3: "no ambiguity exists ... selection must be
   *    deterministic and fail closed" -- deliberately `findMany`, never
   *    `findFirst`, so ambiguity can never be silently resolved by picking
   *    whichever row the query planner happened to return first);
   *  - the matched row's `healthStatus` is not `DatasetHealthStatus.INCOMPLETE`
   *    -> `QualifiedIncompleteEvidenceInvariantError` (a session can be
   *    `persistenceOutcome === INCOMPLETE` while, in principle, structurally
   *    `INVALID`/`PROVIDER_UNAVAILABLE` at the health layer -- see
   *    `HistoricalCandleSessionPersistenceOutcome` -- never silently treated
   *    as a clean missing-minutes gap);
   *  - `sourceRowsSemanticChecksum` is `null` -> `QualifiedIncompleteEvidenceInvariantError`
   *    (a caller can never qualify a controlled re-observation against an
   *    evidence row with no checksum to compare against).
   *
   * B-M7.1 CORRECTION (real production reproduction): `input.requiredRetrievalRange`
   * is an OPTIONAL, additional, IN-QUERY filter on the PARENT retrieval's own
   * `requestedFromDate`/`requestedToDate`. When OMITTED, every behavior above
   * is byte-for-byte unchanged (0/1/ambiguous>1, exactly as before) --
   * existing unscoped callers see no behavior change whatsoever. When
   * SUPPLIED, this narrows the candidate set to only evidence produced by a
   * parent retrieval requested for that EXACT range (see `RequiredRetrievalRange`'s
   * doc for why: `SOURCE_ROWS_CHECKSUM_VERSION=1` folds each row's
   * request-array-relative `sourceIndex` into the digest, so a monthly-chunk
   * evidence row and an exact-single-date evidence row for the identical
   * trading date are NOT directly checksum-comparable, even when the
   * underlying OHLC content is identical) -- and, if MORE THAN ONE row
   * still matches after that narrowing, this method no longer immediately
   * throws ambiguous. Repeated exact-range acquisitions of the SAME date are
   * legitimate durable history, so each candidate is first proven to
   * individually satisfy the invariants above, then compared PAIRWISE across
   * every qualification-relevant durable fact (identity, calendar/count
   * facts, health, persistence outcome, `sourceRowsSemanticChecksum`,
   * `evidenceSemanticChecksum`):
   *  - if every candidate agrees on all of it, they are genuinely
   *    interchangeable duplicate OBSERVATIONS of the same reality --
   *    qualification succeeds, selecting ONE persisted representative via a
   *    deterministic, TOTAL ordering (ascending session `id`). Because every
   *    candidate already proved equivalent, WHICH one is selected can never
   *    change the returned checksums/facts -- only its opaque `sessionId`/
   *    `retrievalId`, which never enter any downstream artifact identity;
   *  - if ANY candidate disagrees on ANY of it, these are genuinely
   *    CONFLICTING observations -- `QualifiedIncompleteEvidenceAmbiguousError`
   *    is thrown, exactly like the unscoped case. This method never selects
   *    "latest" among conflicting observations.
   */
  async findTerminalIncompleteSessionEvidence(input: QualifyTerminalIncompleteEvidenceInput): Promise<QualifiedIncompleteSessionEvidence | null> {
    const retrievalWhere: { providerId: HistoricalProviderId; status: { in: string[] }; requestedFromDate?: string; requestedToDate?: string } = {
      providerId: input.expectedProviderId,
      status: { in: [...SUCCESSFUL_TERMINAL_RETRIEVAL_STATUSES] },
    };
    if (input.requiredRetrievalRange) {
      retrievalWhere.requestedFromDate = input.requiredRetrievalRange.fromDate;
      retrievalWhere.requestedToDate = input.requiredRetrievalRange.toDate;
    }

    const rows = await this.prisma.historicalDataRetrievalSession.findMany({
      where: {
        instrumentKey: input.instrumentKey,
        timeframe: input.timeframe,
        tradingDate: input.tradingDate,
        persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INCOMPLETE,
        retrieval: retrievalWhere,
      },
      include: { retrieval: true },
    });

    if (rows.length === 0) return null;

    // Unscoped callers keep the ORIGINAL behavior verbatim: >1 match is
    // immediately ambiguous, never reaching the per-row invariant checks
    // below (matches the pre-correction code path exactly).
    if (rows.length > 1 && !input.requiredRetrievalRange) {
      throw new QualifiedIncompleteEvidenceAmbiguousError(input.instrumentKey, input.timeframe, input.tradingDate, rows.length);
    }

    const assertRowInvariants = (row: (typeof rows)[number]): void => {
      if (row.healthStatus !== DatasetHealthStatus.INCOMPLETE) {
        throw new QualifiedIncompleteEvidenceInvariantError(
          `Terminal INCOMPLETE-persistence evidence for ${input.instrumentKey}/${input.timeframe}/${input.tradingDate} (session ${row.id}) has healthStatus='${row.healthStatus}', not '${DatasetHealthStatus.INCOMPLETE}'.`
        );
      }
      if (!row.sourceRowsSemanticChecksum) {
        throw new QualifiedIncompleteEvidenceInvariantError(
          `Terminal INCOMPLETE-persistence evidence for ${input.instrumentKey}/${input.timeframe}/${input.tradingDate} (session ${row.id}) has no sourceRowsSemanticChecksum -- cannot qualify a re-observation against it.`
        );
      }
    };
    // Every candidate is validated BEFORE any equivalence/selection decision
    // is made -- a structurally-invalid candidate must fail closed even when
    // its siblings all look fine (task: "First validate that each candidate
    // has the required structural invariants").
    rows.forEach(assertRowInvariants);

    const toQualifiedEvidence = (row: (typeof rows)[number]): QualifiedIncompleteSessionEvidence => ({
      retrievalId: row.retrievalId,
      sessionId: row.id,
      providerId: row.retrieval.providerId as HistoricalProviderId,
      instrumentKey: row.instrumentKey,
      timeframe: row.timeframe,
      tradingDate: row.tradingDate,
      calendarDisposition: row.calendarDisposition,
      expectedMinuteCount: row.expectedMinuteCount,
      providerRowCountForDate: row.providerRowCountForDate,
      acceptedRowCount: row.acceptedRowCount,
      excludedRowCount: row.excludedRowCount,
      sourceOrderAnomalyCount: row.sourceOrderAnomalyCount,
      healthStatus: row.healthStatus as DatasetHealthStatus,
      persistenceOutcome: row.persistenceOutcome as HistoricalCandleSessionPersistenceOutcome,
      sourceRowsSemanticChecksum: row.sourceRowsSemanticChecksum as string,
      evidenceSemanticChecksum: row.evidenceSemanticChecksum,
    });

    if (rows.length === 1) {
      return toQualifiedEvidence(rows[0]);
    }

    // rows.length > 1 with input.requiredRetrievalRange set (the only way to
    // reach here -- the unscoped case already threw above). Every candidate
    // already individually passed assertRowInvariants; now prove they are
    // genuinely INTERCHANGEABLE duplicate observations, never merely
    // "close enough". `evidenceSemanticChecksum` already canonically covers
    // every field compared here except id/timestamps (it is computed FROM
    // them, including sourceRowsSemanticChecksum -- see
    // `computeEvidenceSemanticChecksum`), but `sourceRowsSemanticChecksum` is
    // still compared explicitly and separately: it is the exact
    // re-observation comparison anchor B-M7.1 relies on, so this never
    // leans on "evidenceSemanticChecksum equality implies it" alone.
    const rowsAreEquivalent = (a: (typeof rows)[number], b: (typeof rows)[number]): boolean =>
      a.retrieval.providerId === b.retrieval.providerId &&
      a.instrumentKey === b.instrumentKey &&
      a.timeframe === b.timeframe &&
      a.tradingDate === b.tradingDate &&
      a.calendarDisposition === b.calendarDisposition &&
      a.expectedMinuteCount === b.expectedMinuteCount &&
      a.providerRowCountForDate === b.providerRowCountForDate &&
      a.acceptedRowCount === b.acceptedRowCount &&
      a.excludedRowCount === b.excludedRowCount &&
      a.sourceOrderAnomalyCount === b.sourceOrderAnomalyCount &&
      a.healthStatus === b.healthStatus &&
      a.persistenceOutcome === b.persistenceOutcome &&
      a.sourceRowsSemanticChecksum === b.sourceRowsSemanticChecksum &&
      a.evidenceSemanticChecksum === b.evidenceSemanticChecksum;

    const [first, ...rest] = rows;
    const allEquivalent = rest.every((row) => rowsAreEquivalent(first, row));
    if (!allEquivalent) {
      throw new QualifiedIncompleteEvidenceAmbiguousError(input.instrumentKey, input.timeframe, input.tradingDate, rows.length);
    }

    // Deterministic, TOTAL, documented ordering (ascending persisted session
    // `id`) -- selects ONE representative only. Never `createdAt`/wall-clock
    // ordering (two rows can share an identical DATETIME(3)), and never
    // "latest": every candidate has already been proven semantically
    // equivalent above, so this pick cannot change the returned facts.
    const representative = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    return toQualifiedEvidence(representative);
  }
}
