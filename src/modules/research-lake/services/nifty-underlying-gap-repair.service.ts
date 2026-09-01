import {
  CandleContentValue,
  candleContentEquals,
  computeCandleContentChecksum,
} from '../domain/historical-candle-content-identity';
import {
  CanonicalHistoricalCandle,
  CanonicalSessionDeclaration,
  CanonicalSessionProjectionOutcome,
  CanonicalSessionProjectionResult,
  computeMissingMinutesChecksum,
  computeSourceRowsSemanticChecksum,
  DatasetHealthReport,
  DatasetHealthStatus,
  expectedCanonicalTimestamps,
  HistoricalAssetType,
  HistoricalCandleRepairContributionRole,
  HistoricalCandleRepairOutcome,
  HistoricalCandleSessionPersistenceOutcome,
  HistoricalDataRetrievalErrorCategory,
  HistoricalDataRetrievalStatus,
  HistoricalSourceCandleRow,
  REPAIR_POLICY_VERSION,
} from '../domain';
import { HistoricalDataProvider } from '../interfaces/historical-data-provider.interface';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import DatasetHealthValidatorService from './dataset-health-validator.service';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';
import HistoricalCandleRepairEvidenceService, { RepairContributionInput } from './historical-candle-repair-evidence.service';
import HistoricalCandleResearchPersistenceService from './historical-candle-research-persistence.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import {
  HistoricalProviderPermanentError,
  HistoricalProviderRetryExhaustedError,
  HistoricalProviderRetryOptions,
  HistoricalProviderRetryStats,
  withHistoricalProviderRetry,
} from './historical-provider-retry.util';
import UpstoxHistoricalDataProviderService from '../providers/upstox/upstox-historical-data-provider.service';
import NiftyUnderlyingIngestionPlannerService, {
  NiftyIngestionPlan,
  NiftyPlannedDateDisposition,
} from './nifty-underlying-ingestion-planner.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';
import { UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS } from './nifty-underlying-acquisition.service';

const FETCH_ELIGIBLE_DISPOSITIONS: ReadonlySet<NiftyPlannedDateDisposition> = new Set([
  NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
  NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY,
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors `NiftyAcquisitionCalendarBlockedError` (task invariant J: repair must fail closed on an UNCERTIFIED date exactly like ordinary acquisition, before any provider call). */
export class NiftyGapRepairCalendarBlockedError extends Error {
  constructor(readonly tradingDate: string) {
    super(`NiftyUnderlyingGapRepairService: calendar truth for ${tradingDate} is UNCERTIFIED; gap repair fails closed before any provider call.`);
    this.name = 'NiftyGapRepairCalendarBlockedError';
  }
}

/** Task invariant J: closed dates (holiday/exceptional/weekend) must never trigger a repair attempt. */
export class NiftyGapRepairNotFetchEligibleError extends Error {
  constructor(readonly tradingDate: string, readonly disposition: NiftyPlannedDateDisposition) {
    super(`NiftyUnderlyingGapRepairService: ${tradingDate} resolved to calendar disposition ${disposition}, which is not a trading session; gap repair does not apply.`);
    this.name = 'NiftyGapRepairNotFetchEligibleError';
  }
}

export class NiftyGapRepairPrimaryFetchFailedError extends Error {
  constructor(readonly tradingDate: string, readonly cause: unknown) {
    super(`NiftyUnderlyingGapRepairService: the primary-provider re-fetch for ${tradingDate} failed; see 'cause'. Durable FAILED evidence has already been recorded for this attempt.`);
    this.name = 'NiftyGapRepairPrimaryFetchFailedError';
  }
}

export class NiftyGapRepairRepairProviderFetchFailedError extends Error {
  constructor(readonly tradingDate: string, readonly cause: unknown) {
    super(`NiftyUnderlyingGapRepairService: the repair-provider fetch for ${tradingDate} failed; see 'cause'. Durable FAILED evidence has already been recorded for this attempt. The primary INCOMPLETE evidence for this date is unaffected.`);
    this.name = 'NiftyGapRepairRepairProviderFetchFailedError';
  }
}

export interface NiftyGapRepairRequest {
  /** Required, YYYY-MM-DD. Date-scoped by design (task invariant J: "preferably date-scoped"). */
  readonly tradingDate: string;
}

export interface NiftyGapRepairResult {
  readonly tradingDate: string;
  readonly outcome: HistoricalCandleRepairOutcome;
  /** Human-readable, machine-stable reason code -- never the sole source of truth (see the durable evidence rows this attempt wrote, when it wrote any). */
  readonly reason: string;
  readonly primaryRetrievalId: string;
  /** `undefined` only when `outcome === REPAIR_NOT_ATTEMPTED` with `reason === 'NO_REPAIR_PROVIDER_CONFIGURED'` -- the primary was never even fetched in that case. */
  readonly primarySessionId?: string;
  readonly expectedMinuteCount?: number;
  readonly primaryAcceptedRowCount?: number;
  readonly missingMinuteCount?: number;
  readonly repairRetrievalId?: string;
  readonly repairAcceptedMinuteCount?: number;
  readonly corroboratedOverlapCount?: number;
  readonly conflictingOverlapCount?: number;
  /** The `HistoricalDataRetrievalSession.id` of the newly-ACCEPTED composite session -- populated only when `outcome === REPAIR_ACCEPTED`. */
  readonly resultingSessionId?: string;
  /** Whether THIS attempt actually inserted new `HistoricalCandle` rows (always `false` unless `outcome === REPAIR_ACCEPTED` and the composite content was genuinely new, never merely idempotent-verified). */
  readonly persisted: boolean;
}

export interface NiftyUnderlyingGapRepairServiceDependencies {
  readonly primaryProvider?: HistoricalDataProvider;
  /**
   * B-F8 invariant A: NEVER defaulted to a real or fake provider. Repair
   * enters consideration only when a caller EXPLICITLY supplies this
   * dependency; omitting it makes every `repairSession` call resolve to
   * `REPAIR_NOT_ATTEMPTED` / `NO_REPAIR_PROVIDER_CONFIGURED` with zero
   * provider calls of any kind, preserving pre-B-F8 fail-closed behavior
   * exactly.
   */
  readonly repairProvider?: HistoricalDataProvider;
  readonly projector?: CanonicalSessionProjectorService;
  readonly validator?: DatasetHealthValidatorService;
  readonly plannerService?: NiftyUnderlyingIngestionPlannerService;
  readonly retrievalEvidenceService?: HistoricalDataRetrievalEvidenceService;
  readonly repairEvidenceService?: HistoricalCandleRepairEvidenceService;
  readonly researchPersistenceService?: HistoricalCandleResearchPersistenceService;
  readonly primaryRateLimiter?: HistoricalProviderRateLimiterService;
  readonly repairRateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
}

function toContentValue(candle: CanonicalHistoricalCandle): CandleContentValue {
  return {
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    timeframe: NIFTY_UNDERLYING_TIMEFRAME,
    candleTime: candle.candleTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    openInterest: candle.openInterest,
  };
}

/**
 * B-F8: explicit, provider-neutral canonical-session GAP-REPAIR orchestrator.
 * Never invoked by `NiftyUnderlyingAcquisitionService`, the year runner, or
 * any existing CLI script -- this is a wholly separate, additive,
 * date-scoped operation a caller must deliberately invoke (task invariant
 * J). Reuses, never reimplements: `NiftyUnderlyingIngestionPlannerService`
 * for calendar truth, `CanonicalSessionProjectorService` /
 * `DatasetHealthValidatorService` for canonicalization and health
 * (including the FINAL whole-session revalidation of the combined
 * primary+repair candidate set -- task invariant F), and
 * `HistoricalCandleResearchPersistenceService.persistSession` UNCHANGED for
 * the actual atomic, conflict-safe, idempotent candle write (task invariant
 * H) -- this service never touches `HistoricalCandle` directly.
 *
 * Flow for one trading date (see class methods for detail): (1) resolve
 * calendar truth and fail closed on UNCERTIFIED/closed exactly like
 * ordinary acquisition; (2) if no `repairProvider` is configured, stop here
 * -- zero provider calls; (3) re-fetch PRIMARY once (never a retry loop) to
 * obtain the actual accepted-row CONTENT this attempt needs to combine (the
 * durable B-F2C evidence for an INCOMPLETE session intentionally never
 * stores row content, only counts/checksums); (4) if primary is already
 * persistable this attempt, just persist it (no repair provider call); (5)
 * if primary is INCOMPLETE, derive the authoritative missing canonical
 * minute vector from the calendar's own `expectedMinutesIst` (never a fixed
 * 375-minute assumption); (6) fetch the repair provider once and canonicalize
 * its rows under the SAME session windows; (7) resolve each missing minute
 * to at most one repair candidate, and cross-check every repair row that
 * overlaps an already-accepted primary minute for corroboration/conflict;
 * (8) on a clean resolution, revalidate the WHOLE combined session via the
 * unmodified `DatasetHealthValidatorService` and persist atomically only if
 * it is HEALTHY.
 */
export default class NiftyUnderlyingGapRepairService {
  private readonly primaryProvider: HistoricalDataProvider;
  private readonly repairProvider: HistoricalDataProvider | undefined;
  private readonly projector: CanonicalSessionProjectorService;
  private readonly validator: DatasetHealthValidatorService;
  private readonly plannerService: NiftyUnderlyingIngestionPlannerService;
  private readonly retrievalEvidenceService: HistoricalDataRetrievalEvidenceService;
  private readonly repairEvidenceService: HistoricalCandleRepairEvidenceService;
  private readonly researchPersistenceService: HistoricalCandleResearchPersistenceService;
  private readonly primaryRateLimiter: HistoricalProviderRateLimiterService;
  private readonly repairRateLimiter: HistoricalProviderRateLimiterService;
  private readonly retryOptions: HistoricalProviderRetryOptions;

  constructor(dependencies: NiftyUnderlyingGapRepairServiceDependencies = {}) {
    this.primaryProvider = dependencies.primaryProvider ?? new UpstoxHistoricalDataProviderService();
    this.repairProvider = dependencies.repairProvider;
    this.projector = dependencies.projector ?? new CanonicalSessionProjectorService();
    this.validator = dependencies.validator ?? new DatasetHealthValidatorService();
    this.plannerService = dependencies.plannerService ?? new NiftyUnderlyingIngestionPlannerService();
    this.retrievalEvidenceService = dependencies.retrievalEvidenceService ?? new HistoricalDataRetrievalEvidenceService();
    this.repairEvidenceService = dependencies.repairEvidenceService ?? new HistoricalCandleRepairEvidenceService();
    this.researchPersistenceService = dependencies.researchPersistenceService ?? new HistoricalCandleResearchPersistenceService();
    this.primaryRateLimiter = dependencies.primaryRateLimiter ?? new HistoricalProviderRateLimiterService(UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.repairRateLimiter = dependencies.repairRateLimiter ?? new HistoricalProviderRateLimiterService(UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
  }

  async repairSession(request: NiftyGapRepairRequest): Promise<NiftyGapRepairResult> {
    const tradingDate = request.tradingDate;
    this.assertValidDate(tradingDate);

    const plan: NiftyIngestionPlan = await this.plannerService.buildPlan({ fromDate: tradingDate, toDate: tradingDate });
    if (plan.hasBlockedDates) throw new NiftyGapRepairCalendarBlockedError(tradingDate);
    const planned = plan.dates.find((date) => date.tradingDate === tradingDate);
    if (!planned || !FETCH_ELIGIBLE_DISPOSITIONS.has(planned.disposition)) {
      throw new NiftyGapRepairNotFetchEligibleError(tradingDate, planned?.disposition ?? NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED);
    }

    // Invariant A, checked BEFORE any provider call of any kind (including
    // the primary re-fetch): repair enters consideration only when a repair
    // provider is explicitly configured.
    if (!this.repairProvider) {
      return {
        tradingDate,
        outcome: HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED,
        reason: 'NO_REPAIR_PROVIDER_CONFIGURED',
        primaryRetrievalId: '',
        persisted: false,
      };
    }

    // ---- Step 1: one primary re-fetch (never a retry loop) --------------
    const primaryStats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };
    const primaryRetrievalId = await this.retrievalEvidenceService.startRetrieval({
      providerId: this.primaryProvider.providerId,
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      requestedFromDate: tradingDate,
      requestedToDate: tradingDate,
    });

    let primaryRawRows: readonly HistoricalSourceCandleRow[];
    try {
      primaryRawRows = await withHistoricalProviderRetry(
        () =>
          this.primaryRateLimiter.schedule(() =>
            this.primaryProvider.fetchCompletedUnderlyingRange({
              assetType: HistoricalAssetType.NIFTY_INDEX,
              instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
              interval: NIFTY_UNDERLYING_TIMEFRAME,
              fromTradingDate: tradingDate,
              toTradingDate: tradingDate,
            })
          ),
        primaryStats,
        this.retryOptions
      );
    } catch (error) {
      await this.retrievalEvidenceService.recordFailed(primaryRetrievalId, {
        errorCategory: this.classifyErrorCategory(error),
        errorMessage: this.describeError(error),
        providerCallAttempts: 1 + primaryStats.retryCount,
      });
      throw new NiftyGapRepairPrimaryFetchFailedError(tradingDate, error);
    }

    const primarySourceRowsSemanticChecksum = computeSourceRowsSemanticChecksum(primaryRawRows);
    await this.retrievalEvidenceService.recordFetched(primaryRetrievalId, {
      sourceRowCount: primaryRawRows.length,
      sourceRowsSemanticChecksum: primarySourceRowsSemanticChecksum,
      providerCallAttempts: 1 + primaryStats.retryCount,
    });

    const primaryProjection = this.projector.project({
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      tradingDate,
      sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
      sessionWindows: planned.sessionWindows,
      sourceRows: primaryRawRows,
    });
    const primaryReport = this.validator.validate(primaryProjection, planned.expectedMinutesIst);

    // ---- Already persistable this attempt: no repair needed -------------
    if (primaryReport.status === DatasetHealthStatus.HEALTHY || primaryReport.status === DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS) {
      const { from, to } = this.istRangeBounds(tradingDate);
      const persistenceResult = await this.researchPersistenceService.persistSession(
        {
          retrievalId: primaryRetrievalId,
          providerId: this.primaryProvider.providerId,
          instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
          timeframe: NIFTY_UNDERLYING_TIMEFRAME,
          tradingDate,
          calendarDisposition: planned.disposition,
          expectedMinuteCount: planned.expectedMinuteCount,
          providerRowCountForDate: primaryRawRows.length,
          healthStatus: primaryReport.status,
          excludedRowCount: primaryReport.excludedRowCount,
          sourceOrderAnomalyCount: primaryProjection.sourceOrderAnomalies.length,
          sourceRowsSemanticChecksum: primarySourceRowsSemanticChecksum,
          from,
          to,
        },
        primaryProjection.acceptedRows
      );
      await this.retrievalEvidenceService.finalizeRetrieval(
        primaryRetrievalId,
        persistenceResult.outcome === 'CONFLICT' ? HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES : HistoricalDataRetrievalStatus.PROCESSED
      );
      return {
        tradingDate,
        outcome: HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED,
        reason: persistenceResult.outcome === 'CONFLICT' ? 'PRIMARY_SOURCE_CONFLICT_ON_REPAIR_ATTEMPT' : 'PRIMARY_ALREADY_COMPLETE_ON_REPAIR_ATTEMPT',
        primaryRetrievalId,
        primaryAcceptedRowCount: primaryReport.canonicalRowCount,
        expectedMinuteCount: planned.expectedMinuteCount,
        persisted: persistenceResult.outcome !== 'CONFLICT' && persistenceResult.insertedCount > 0,
      };
    }

    // ---- Structurally non-repairable (not a missing-minute gap) ---------
    if (primaryReport.status !== DatasetHealthStatus.INCOMPLETE) {
      const primarySessionId = await this.recordNonPersistablePrimary(primaryRetrievalId, tradingDate, planned, primaryReport, primaryRawRows, primarySourceRowsSemanticChecksum);
      await this.retrievalEvidenceService.finalizeRetrieval(primaryRetrievalId, HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES);
      return {
        tradingDate,
        outcome: HistoricalCandleRepairOutcome.REPAIR_UNAVAILABLE,
        reason: 'PRIMARY_STRUCTURALLY_INVALID',
        primaryRetrievalId,
        primarySessionId,
        primaryAcceptedRowCount: primaryReport.canonicalRowCount,
        expectedMinuteCount: planned.expectedMinuteCount,
        persisted: false,
      };
    }

    // ---- INCOMPLETE: durably record the primary attempt, then repair ----
    const primarySessionId = await this.retrievalEvidenceService.recordNonPersistableSession({
      retrievalId: primaryRetrievalId,
      providerId: this.primaryProvider.providerId,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      tradingDate,
      calendarDisposition: planned.disposition,
      expectedMinuteCount: planned.expectedMinuteCount,
      providerRowCountForDate: primaryRawRows.length,
      acceptedRowCount: primaryReport.canonicalRowCount,
      excludedRowCount: primaryReport.excludedRowCount,
      sourceOrderAnomalyCount: primaryProjection.sourceOrderAnomalies.length,
      healthStatus: primaryReport.status,
      persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.INCOMPLETE,
      sourceRowsSemanticChecksum: primarySourceRowsSemanticChecksum,
    });
    await this.retrievalEvidenceService.finalizeRetrieval(primaryRetrievalId, HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES);

    const expectedTimestamps = expectedCanonicalTimestamps(tradingDate, planned.expectedMinutesIst);
    const primaryAcceptedByTime = new Map(primaryProjection.acceptedRows.map((row) => [row.candleTime.getTime(), row]));
    const missingTimestamps = expectedTimestamps.filter((timestamp) => !primaryAcceptedByTime.has(timestamp.getTime()));
    const missingMinutesChecksum = computeMissingMinutesChecksum(missingTimestamps);

    // ---- Step 2: one repair-provider fetch (never a retry loop) ---------
    const repairStats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };
    const repairRetrievalId = await this.retrievalEvidenceService.startRetrieval({
      providerId: this.repairProvider.providerId,
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      requestedFromDate: tradingDate,
      requestedToDate: tradingDate,
    });

    let repairRawRows: readonly HistoricalSourceCandleRow[];
    try {
      repairRawRows = await withHistoricalProviderRetry(
        () =>
          this.repairRateLimiter.schedule(() =>
            this.repairProvider!.fetchCompletedUnderlyingRange({
              assetType: HistoricalAssetType.NIFTY_INDEX,
              instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
              interval: NIFTY_UNDERLYING_TIMEFRAME,
              fromTradingDate: tradingDate,
              toTradingDate: tradingDate,
            })
          ),
        repairStats,
        this.retryOptions
      );
    } catch (error) {
      await this.retrievalEvidenceService.recordFailed(repairRetrievalId, {
        errorCategory: this.classifyErrorCategory(error),
        errorMessage: this.describeError(error),
        providerCallAttempts: 1 + repairStats.retryCount,
      });
      throw new NiftyGapRepairRepairProviderFetchFailedError(tradingDate, error);
    }

    const repairSourceRowsSemanticChecksum = computeSourceRowsSemanticChecksum(repairRawRows);
    await this.retrievalEvidenceService.recordFetched(repairRetrievalId, {
      sourceRowCount: repairRawRows.length,
      sourceRowsSemanticChecksum: repairSourceRowsSemanticChecksum,
      providerCallAttempts: 1 + repairStats.retryCount,
    });

    const repairProjection = this.projector.project({
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      tradingDate,
      sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
      sessionWindows: planned.sessionWindows,
      sourceRows: repairRawRows,
    });

    const repairByTime = new Map<number, CanonicalHistoricalCandle[]>();
    for (const row of repairProjection.acceptedRows) {
      const key = row.candleTime.getTime();
      const existing = repairByTime.get(key);
      if (existing) existing.push(row);
      else repairByTime.set(key, [row]);
    }

    // ---- Resolve each missing minute to at most one repair candidate ----
    // Task invariant B-F8/1 (blocker 1): every resolved minute's exact
    // candleTime + content checksum is captured here as a durable
    // contribution record -- never only a count -- so the exact repaired
    // timestamp set is queryable from DB state alone afterward.
    let hasMissingMinuteConflict = false;
    const resolvedRepairRows: CanonicalHistoricalCandle[] = [];
    const stillMissing: Date[] = [];
    const contributions: RepairContributionInput[] = [];
    for (const timestamp of missingTimestamps) {
      const candidates = repairByTime.get(timestamp.getTime()) ?? [];
      if (candidates.length === 0) {
        stillMissing.push(timestamp);
      } else if (candidates.length === 1) {
        resolvedRepairRows.push(candidates[0]);
        contributions.push({
          candleTime: candidates[0].candleTime,
          role: HistoricalCandleRepairContributionRole.REPAIR_FILLED_MISSING,
          repairContentChecksum: computeCandleContentChecksum(toContentValue(candidates[0])),
          primaryContentChecksum: null,
        });
      } else {
        hasMissingMinuteConflict = true; // task invariant D: >1 candidate for one missing minute fails closed
      }
    }

    // ---- Cross-check every repair row overlapping an already-accepted
    // primary minute: corroboration if identical, conflict if not
    // (task invariant E) ----------------------------------------------
    let corroboratedOverlapCount = 0;
    let conflictingOverlapCount = 0;
    for (const [timeKey, candidates] of repairByTime) {
      const primaryRow = primaryAcceptedByTime.get(timeKey);
      if (!primaryRow) continue; // not an overlap -- either a missing-minute candidate (handled above) or a duplicate at a missing timestamp (already flagged)
      const primaryContent = toContentValue(primaryRow);
      const primaryContentChecksum = computeCandleContentChecksum(primaryContent);
      for (const candidate of candidates) {
        const repairContentChecksum = computeCandleContentChecksum(toContentValue(candidate));
        if (candleContentEquals(primaryContent, toContentValue(candidate))) {
          corroboratedOverlapCount += 1;
          contributions.push({ candleTime: candidate.candleTime, role: HistoricalCandleRepairContributionRole.CORROBORATED_OVERLAP, repairContentChecksum, primaryContentChecksum });
        } else {
          conflictingOverlapCount += 1;
          contributions.push({ candleTime: candidate.candleTime, role: HistoricalCandleRepairContributionRole.CONFLICTING_OVERLAP, repairContentChecksum, primaryContentChecksum });
        }
      }
    }

    const hasConflict = hasMissingMinuteConflict || conflictingOverlapCount > 0;
    let combinedCandidates: readonly CanonicalHistoricalCandle[] | null = null;
    let outcome: HistoricalCandleRepairOutcome;

    if (hasConflict) {
      outcome = HistoricalCandleRepairOutcome.REPAIR_CONFLICT;
    } else if (stillMissing.length > 0) {
      outcome = HistoricalCandleRepairOutcome.REPAIR_INCOMPLETE;
    } else {
      // The repaired minutes are, by construction, interleaved chronologically
      // among the primary minutes (a missing minute is never at the array's
      // logical end) -- re-sort ascending by candleTime before validating,
      // exactly like `CanonicalSessionProjectorService` always does for a
      // fresh projection, so `DatasetHealthValidatorService`'s monotonic-order
      // check reflects true chronological order rather than mere
      // concatenation order.
      const candidate = [...primaryProjection.acceptedRows, ...resolvedRepairRows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
      const combinedProjection: CanonicalSessionProjectionResult = {
        outcome: CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED,
        assetType: HistoricalAssetType.NIFTY_INDEX,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        tradingDate,
        sourceRowCount: candidate.length,
        acceptedRows: candidate,
        excludedRows: [],
        sourceOrderAnomalies: [],
      };
      // Task invariant F: the WHOLE combined session is rebuilt and
      // revalidated through the SAME unmodified validator every ordinary
      // acquisition uses -- never a bespoke "just check the 3 new rows"
      // shortcut.
      const combinedReport = this.validator.validate(combinedProjection, planned.expectedMinutesIst);
      if (combinedReport.status === DatasetHealthStatus.HEALTHY) {
        combinedCandidates = candidate;
        outcome = HistoricalCandleRepairOutcome.REPAIR_ACCEPTED;
      } else {
        outcome = combinedReport.missingMinuteCount > 0 ? HistoricalCandleRepairOutcome.REPAIR_INCOMPLETE : HistoricalCandleRepairOutcome.REPAIR_CONFLICT;
      }
    }

    let resultingSessionId: string | null = null;
    let persisted = false;
    // HIGH 2 CORRECTION (post-Terra-re-review): NEVER a flag the hook itself
    // mutates in this enclosing scope -- a `persistSession` call can retry
    // its ENTIRE SERIALIZABLE transaction on a classified concurrency
    // failure (deadlock/write-conflict), and a hook-mutated outer flag set
    // `true` by a since-rolled-back attempt would incorrectly survive into
    // whatever the FINAL (possibly CONFLICT) attempt actually resolves to --
    // silently skipping this attempt's non-atomic REPAIR_CONFLICT evidence
    // write below. Instead, this is assigned exactly once, synchronously,
    // straight from `persistenceResult.acceptedCompanionResult` -- a field
    // Prisma's interactive-transaction contract guarantees can only ever
    // reflect the ONE attempt that actually committed (see
    // `HistoricalCandleResearchPersistenceService.ResearchSessionPersistenceResult`
    // doc). It is never itself written to from inside the hook.
    let repairEvidenceIdWrittenAtomically: string | null = null;

    if (combinedCandidates) {
      const { from, to } = this.istRangeBounds(tradingDate);
      // Task invariant F/H: the ENTIRE combined session is persisted
      // atomically through the UNCHANGED B-F2C transaction -- never just
      // the repaired minutes. Reuses the exact same conflict-safe,
      // idempotent, retrying transaction every ordinary acquisition uses.
      //
      // HIGH 2 CORRECTION: `onAcceptedWithinTransaction` writes THIS
      // attempt's repair evidence/windows/contributions inside the SAME
      // transaction, right after the resulting session identity is known
      // but before commit -- closing the crash window where canonical
      // candles + accepted session committed while repair provenance did
      // not (see `HistoricalCandleResearchPersistenceService.
      // PersistSessionOptions` doc). Never invoked on the CONFLICT branch.
      // Returns the created evidence id -- this becomes
      // `persistenceResult.acceptedCompanionResult` ONLY if the attempt that
      // ran it is the one that actually commits.
      const persistenceResult = await this.researchPersistenceService.persistSession<string>(
        {
          retrievalId: repairRetrievalId,
          providerId: this.repairProvider.providerId,
          instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
          timeframe: NIFTY_UNDERLYING_TIMEFRAME,
          tradingDate,
          calendarDisposition: planned.disposition,
          expectedMinuteCount: planned.expectedMinuteCount,
          providerRowCountForDate: repairRawRows.length,
          healthStatus: DatasetHealthStatus.HEALTHY,
          excludedRowCount: 0,
          sourceOrderAnomalyCount: 0,
          sourceRowsSemanticChecksum: repairSourceRowsSemanticChecksum,
          from,
          to,
        },
        combinedCandidates,
        {
          onAcceptedWithinTransaction: (tx, accepted) =>
            this.repairEvidenceService.recordRepairAttemptWithinTransaction(tx, {
              primaryRetrievalId,
              primaryProviderId: this.primaryProvider.providerId,
              primarySessionId,
              repairProviderId: this.repairProvider!.providerId,
              repairRetrievalId,
              instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
              timeframe: NIFTY_UNDERLYING_TIMEFRAME,
              tradingDate,
              calendarDisposition: planned.disposition,
              repairPolicyVersion: REPAIR_POLICY_VERSION,
              sessionWindows: planned.sessionWindows,
              expectedMinuteCount: planned.expectedMinuteCount,
              primaryAcceptedRowCount: primaryReport.canonicalRowCount,
              missingMinuteCount: missingTimestamps.length,
              repairAcceptedMinuteCount: resolvedRepairRows.length,
              corroboratedOverlapCount,
              conflictingOverlapCount,
              outcome: HistoricalCandleRepairOutcome.REPAIR_ACCEPTED,
              resultingSessionId: accepted.sessionEvidenceId,
              missingMinutesChecksum,
              contributions,
            }),
        }
      );

      // Read exactly once, synchronously, from the already-resolved result --
      // never mutated by the hook itself (see the variable's own doc above).
      repairEvidenceIdWrittenAtomically = persistenceResult.acceptedCompanionResult;

      if (persistenceResult.outcome === 'CONFLICT') {
        outcome = HistoricalCandleRepairOutcome.REPAIR_CONFLICT;
        conflictingOverlapCount += persistenceResult.conflicts.length;
      } else {
        resultingSessionId = persistenceResult.sessionEvidenceId;
        persisted = persistenceResult.insertedCount > 0;
      }
      await this.retrievalEvidenceService.finalizeRetrieval(
        repairRetrievalId,
        outcome === HistoricalCandleRepairOutcome.REPAIR_ACCEPTED ? HistoricalDataRetrievalStatus.PROCESSED : HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES
      );
    } else {
      await this.retrievalEvidenceService.finalizeRetrieval(repairRetrievalId, HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES);
    }

    // Every outcome that did NOT already write its evidence atomically above
    // (REPAIR_UNAVAILABLE handled earlier via `recordNonPersistablePrimary`
    // never reaches here; REPAIR_INCOMPLETE / REPAIR_CONFLICT -- including a
    // persistence-layer race that flipped an initially-clean resolution into
    // CONFLICT -- always reach here) still gets its own durable evidence row,
    // exactly as before this correction.
    if (!repairEvidenceIdWrittenAtomically) {
      await this.repairEvidenceService.recordRepairAttempt({
        primaryRetrievalId,
        primaryProviderId: this.primaryProvider.providerId,
        primarySessionId,
        repairProviderId: this.repairProvider.providerId,
        repairRetrievalId,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        timeframe: NIFTY_UNDERLYING_TIMEFRAME,
        tradingDate,
        calendarDisposition: planned.disposition,
        repairPolicyVersion: REPAIR_POLICY_VERSION,
        sessionWindows: planned.sessionWindows,
        expectedMinuteCount: planned.expectedMinuteCount,
        primaryAcceptedRowCount: primaryReport.canonicalRowCount,
        missingMinuteCount: missingTimestamps.length,
        repairAcceptedMinuteCount: resolvedRepairRows.length,
        corroboratedOverlapCount,
        conflictingOverlapCount,
        outcome,
        resultingSessionId,
        missingMinutesChecksum,
        contributions,
      });
    }

    return {
      tradingDate,
      outcome,
      reason: outcome,
      primaryRetrievalId,
      primarySessionId,
      expectedMinuteCount: planned.expectedMinuteCount,
      primaryAcceptedRowCount: primaryReport.canonicalRowCount,
      missingMinuteCount: missingTimestamps.length,
      repairRetrievalId,
      repairAcceptedMinuteCount: resolvedRepairRows.length,
      corroboratedOverlapCount,
      conflictingOverlapCount,
      resultingSessionId: resultingSessionId ?? undefined,
      persisted,
    };
  }

  private async recordNonPersistablePrimary(
    retrievalId: string,
    tradingDate: string,
    planned: { disposition: NiftyPlannedDateDisposition; expectedMinuteCount: number },
    report: DatasetHealthReport,
    rawRows: readonly HistoricalSourceCandleRow[],
    sourceRowsSemanticChecksum: string
  ): Promise<string> {
    const persistenceOutcome =
      report.status === DatasetHealthStatus.PROVIDER_UNAVAILABLE
        ? HistoricalCandleSessionPersistenceOutcome.NO_PROVIDER_DATA_FOR_DATE
        : HistoricalCandleSessionPersistenceOutcome.INVALID;
    return this.retrievalEvidenceService.recordNonPersistableSession({
      retrievalId,
      providerId: this.primaryProvider.providerId,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      tradingDate,
      calendarDisposition: planned.disposition,
      expectedMinuteCount: planned.expectedMinuteCount,
      providerRowCountForDate: rawRows.length,
      acceptedRowCount: report.canonicalRowCount,
      excludedRowCount: report.excludedRowCount,
      sourceOrderAnomalyCount: 0,
      healthStatus: report.status,
      persistenceOutcome,
      sourceRowsSemanticChecksum,
    });
  }

  private istRangeBounds(tradingDate: string): { from: Date; to: Date } {
    return { from: new Date(`${tradingDate}T00:00:00+05:30`), to: new Date(`${tradingDate}T23:59:59.999+05:30`) };
  }

  private assertValidDate(value: string): void {
    if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`NiftyUnderlyingGapRepairService requires tradingDate to be a valid YYYY-MM-DD date; received '${value}'.`);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof HistoricalProviderPermanentError || error instanceof HistoricalProviderRetryExhaustedError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }

  private classifyErrorCategory(error: unknown): HistoricalDataRetrievalErrorCategory {
    if (error instanceof HistoricalProviderPermanentError) return HistoricalDataRetrievalErrorCategory.PERMANENT;
    if (error instanceof HistoricalProviderRetryExhaustedError) return HistoricalDataRetrievalErrorCategory.RETRY_EXHAUSTED;
    return HistoricalDataRetrievalErrorCategory.UNKNOWN;
  }
}
