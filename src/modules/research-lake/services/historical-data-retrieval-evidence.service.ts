import { PrismaClient } from '@prisma/client';
import {
  DatasetHealthStatus,
  HistoricalCandleSessionPersistenceOutcome,
  HistoricalDataRetrievalErrorCategory,
  HistoricalDataRetrievalStatus,
  computeEvidenceSemanticChecksum,
} from '../domain';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import {
  SourceAcquisitionEvidence,
  SourceAcquisitionEvidenceAvailability,
} from '../domain/dataset-manifest.types';
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

    return {
      availability: SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE,
      providerRowCount: row.providerRowCountForDate,
      excludedRowCount: row.excludedRowCount,
      sourceOrderAnomalyCount: row.sourceOrderAnomalyCount,
      sourceHealthStatus: row.healthStatus as DatasetHealthStatus,
      provider: row.retrieval.providerId as HistoricalProviderId,
      evidenceSemanticChecksum: row.evidenceSemanticChecksum,
    };
  }
}
