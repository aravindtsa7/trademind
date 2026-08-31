import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import {
  HISTORICAL_SESSION_ROW_COUNT,
  isCompleteHistoricalSession,
} from '../../historical-candles/utils/historical-session-completeness.util';
import {
  CanonicalSessionDeclaration,
  CanonicalSessionExclusion,
  computeSourceRowsSemanticChecksum,
  DatasetHealthIssue,
  DatasetHealthReport,
  DatasetHealthStatus,
  expectedMinutesForWindows,
  HistoricalAssetType,
  HistoricalCandleSessionPersistenceOutcome,
  HistoricalDataRetrievalErrorCategory,
  HistoricalDataRetrievalStatus,
  HistoricalSourceCandleRow,
  isCompleteCalendarSession,
  istCalendarDate,
  SessionWindow,
  validateSessionWindows,
} from '../domain';
import { CalendarDateRange, splitIntoCalendarMonthChunks } from '../domain/calendar-month-chunking.util';
import { HistoricalDataProvider } from '../interfaces/historical-data-provider.interface';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import DatasetHealthValidatorService from './dataset-health-validator.service';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';
import HistoricalCandleResearchPersistenceService, {
  ResearchSessionPersistenceResult,
} from './historical-candle-research-persistence.service';
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
  CLOSED_DISPOSITIONS,
  NiftyIngestionPlan,
  NiftyPlannedDate,
  NiftyPlannedDateDisposition,
} from './nifty-underlying-ingestion-planner.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';

export { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME };

const FETCH_ELIGIBLE_DISPOSITIONS: ReadonlySet<NiftyPlannedDateDisposition> = new Set([
  NiftyPlannedDateDisposition.REGULAR_TRADING_DAY,
  NiftyPlannedDateDisposition.SPECIAL_SESSION_DAY,
]);

/**
 * Thrown BEFORE any provider construction/call (task B-F2-CAL-2 section
 * 12/13/33) when the calendar plan for the FULL requested range contains one
 * or more `BLOCKED_UNCERTIFIED` dates. Deliberately whole-range fail-closed,
 * never a partial per-date skip/clamp: a blocked date anywhere in the range
 * means the entire acquisition request is not execution-ready, exactly
 * mirroring the CAL-1 plan-only CLI's `hasBlockedDates` contract.
 */
export class NiftyAcquisitionCalendarBlockedError extends Error {
  readonly blockedDates: readonly string[];

  constructor(plan: NiftyIngestionPlan) {
    const blockedDates = plan.dates
      .filter((date) => date.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED)
      .map((date) => date.tradingDate);
    const preview = blockedDates.slice(0, 5).join(', ');
    const suffix = blockedDates.length > 5 ? ', ...' : '';
    super(
      `NiftyUnderlyingAcquisitionService: requested range ${plan.requestedFromDate}..${plan.requestedToDate} contains ` +
        `${blockedDates.length} BLOCKED_UNCERTIFIED date(s) (${preview}${suffix}); acquisition fails closed before any provider call.`
    );
    this.name = 'NiftyAcquisitionCalendarBlockedError';
    this.blockedDates = blockedDates;
  }
}

/**
 * B-F2-CAL-2-FIX-1: `NiftyPlannedDate` carries three independent
 * representations of the same session truth (`sessionWindows`,
 * `expectedMinutesIst`, `expectedMinuteCount`). Terra's review found that
 * production consumers each trusted a different one of these fields without
 * ever proving they agree, so an internally-inconsistent plan entry (e.g. a
 * [555,600) window whose `expectedMinuteCount` lies as 44 instead of 45)
 * could reach the provider, persist, and only be caught by AFTER-THE-FACT
 * post-persist reconciliation -- never before acquisition. Typed reason for
 * the corresponding fail-closed error.
 */
export enum NiftyAcquisitionCalendarPlanInvariantReason {
  SESSION_WINDOWS_MISSING = 'SESSION_WINDOWS_MISSING',
  EXPECTED_MINUTE_COUNT_MISMATCH = 'EXPECTED_MINUTE_COUNT_MISMATCH',
  EXPECTED_MINUTE_SET_MISMATCH = 'EXPECTED_MINUTE_SET_MISMATCH',
  CLOSED_DATE_HAS_SESSION_EXPECTATION = 'CLOSED_DATE_HAS_SESSION_EXPECTATION',
}

/**
 * Thrown BEFORE any provider construction/call, immediately after the whole
 * plan is built and the `BLOCKED_UNCERTIFIED` check passes (task B-F2-CAL-2
 * -FIX-1 section 4/7): whole-plan, whole-request fail-closed -- exactly one
 * inconsistent date anywhere in the requested range aborts the entire
 * acquisition, never a partial/per-date skip. Deliberately exposes only
 * counts/identifiers, never the full minute arrays (section 11: "do not
 * dump huge minute arrays into normal logs").
 */
export class NiftyAcquisitionCalendarPlanInvariantError extends Error {
  readonly tradingDate: string;
  readonly disposition: NiftyPlannedDateDisposition;
  readonly reason: NiftyAcquisitionCalendarPlanInvariantReason;
  readonly expectedMinuteCount: number;
  readonly derivedMinuteCount: number;

  constructor(
    tradingDate: string,
    disposition: NiftyPlannedDateDisposition,
    reason: NiftyAcquisitionCalendarPlanInvariantReason,
    expectedMinuteCount: number,
    derivedMinuteCount: number
  ) {
    super(
      `NiftyUnderlyingAcquisitionService: calendar plan invariant violated for ${tradingDate} (${disposition}): ${reason} ` +
        `(plan.expectedMinuteCount=${expectedMinuteCount}, canonically-derived minute count=${derivedMinuteCount}); ` +
        'acquisition fails closed before any provider call.'
    );
    this.name = 'NiftyAcquisitionCalendarPlanInvariantError';
    this.tradingDate = tradingDate;
    this.disposition = disposition;
    this.reason = reason;
    this.expectedMinuteCount = expectedMinuteCount;
    this.derivedMinuteCount = derivedMinuteCount;
  }
}

/**
 * The ONE authoritative internal representation an acquisition run may
 * trust downstream of whole-plan validation (task section 5/6): a
 * `NiftyPlannedDate` that has been proven internally consistent (or, for a
 * closed disposition, proven to carry zero session expectation) and whose
 * `sessionWindows`/`expectedMinutesIst`/`expectedMinuteCount` are the
 * CANONICAL, mutually-derived values -- never the raw, independently-typed
 * plan fields. `CanonicalSessionProjectorService`, `DatasetHealthValidatorService`,
 * `isCompleteCalendarSession`, and post-persist reconciliation all consume
 * ONLY this type from this point on.
 */
interface ValidatedNiftyPlannedDate {
  readonly tradingDate: string;
  readonly disposition: NiftyPlannedDateDisposition;
  readonly sessionWindows: readonly SessionWindow[];
  readonly expectedMinutesIst: readonly number[];
  readonly expectedMinuteCount: number;
}

/** Upstox's documented sustained rate for the historical-candle endpoint: 1 request/second. */
export const UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS = 1_000;

export interface NiftyUnderlyingAcquisitionRequest {
  /** Required. Never implicitly defaulted to "today" -- an incomplete current/future session must never be silently requested. */
  readonly toDate: string;
  /** Optional; defaults to the provider's documented `earliestDocumentedUnderlyingHistory` capability. */
  readonly fromDate?: string;
  /**
   * B-F2-CAL-3: when true, this is a NETWORK-FREE, MUTATION-FREE
   * acquisition-level dry run. The calendar plan is still resolved and
   * whole-plan CAL-2-validated (UNCERTIFIED still fails closed, an
   * internally-inconsistent plan entry still throws
   * `NiftyAcquisitionCalendarPlanInvariantError`), and already-complete
   * local sessions are still detected via a read-only repository lookup --
   * but for any date that WOULD require provider retrieval, this run makes
   * ZERO calls to `HistoricalDataProvider` (no `fetchCompletedUnderlyingRange`)
   * and performs ZERO persistence (no `bulkUpsert`). Such dates are reported
   * under `sessions.dryRunAcquisitionPlanned` /
   * `NiftySessionAcquisitionDetail.bucket === 'DRY_RUN_ACQUISITION_PLANNED'`,
   * never fabricated into a fetched/validated/persisted bucket.
   * `NiftySessionAcquisitionDetail.persisted` reports `false` for every date
   * in a dry run, so the result is never ambiguous about what actually
   * reached the database.
   */
  readonly dryRun?: boolean;
}

export type NiftySessionAcquisitionBucket =
  | 'ALREADY_COMPLETE'
  | 'NEWLY_COMPLETED'
  | 'NORMALIZED_WITH_EXCLUSIONS'
  | 'INCOMPLETE'
  | 'INVALID'
  | 'SPECIAL_SESSION_EXCLUDED'
  | 'UNRESOLVED_NO_DATA'
  | 'CLOSED_NO_DATA_EXPECTED'
  /**
   * B-F2-CAL-3: this date is fetch-eligible and NOT already locally
   * complete, so a real (`dryRun: false`) run WOULD have called the
   * provider for it -- but this run is `dryRun: true`, so zero provider
   * calls and zero persistence occurred for it. Never conflated with
   * `UNRESOLVED_NO_DATA` (which means a real provider request ran and
   * returned nothing for this date).
   */
  | 'DRY_RUN_ACQUISITION_PLANNED'
  /**
   * B-F2C invariant 7: the incoming, canonicalization-accepted candle set
   * for this date disagreed (any OHLC/volume/openInterest difference, for
   * at least one minute) with already-persisted `HistoricalCandle` content
   * at the same logical key. `HistoricalCandle` is left completely
   * unchanged for this date -- zero mutation, not even for the other,
   * non-conflicting minutes in the same session (session atomicity) --
   * and durable conflict evidence is written. Never reused as
   * `INCOMPLETE`/`INVALID`/`UNRESOLVED_NO_DATA`: a content conflict is a
   * materially different, more serious condition than a merely-missing or
   * structurally-invalid session.
   */
  | 'SOURCE_CONFLICT';

/**
 * Typed reason for an orchestrator-level (not B-F1 validator-level) failure
 * mode: kept deliberately separate from `DatasetHealthIssueReason` rather
 * than extending that B-F1 enum, since this is not a candle-health finding
 * -- it is "the write this run performed did not converge to a complete
 * session when read back."
 */
export enum NiftyAcquisitionIssueReason {
  POST_PERSIST_RECONCILIATION_FAILED = 'POST_PERSIST_RECONCILIATION_FAILED',
  /** B-F2C: see `NiftySessionAcquisitionBucket.SOURCE_CONFLICT` doc -- kept deliberately distinct, never folded into a generic incomplete/invalid reason. */
  SOURCE_CONTENT_CONFLICT = 'SOURCE_CONTENT_CONFLICT',
}

export interface NiftyAcquisitionIssue {
  readonly reason: NiftyAcquisitionIssueReason;
  readonly detail: string;
}

export interface NiftySessionAcquisitionDetail {
  readonly tradingDate: string;
  readonly bucket: NiftySessionAcquisitionBucket;
  /** `null` only for `ALREADY_COMPLETE` (no re-validation was run this session) and `UNRESOLVED_NO_DATA` (no session was ever seen to validate). */
  readonly healthStatus: DatasetHealthStatus | null;
  readonly issues: readonly DatasetHealthIssue[];
  readonly acquisitionIssues: readonly NiftyAcquisitionIssue[];
  readonly sourceRowCount: number;
  readonly canonicalRowCount: number;
  readonly excludedRowCount: number;
  readonly exclusions: readonly CanonicalSessionExclusion[];
  /** Whether THIS run actually wrote rows for this date (always `false` for `ALREADY_COMPLETE`, `UNRESOLVED_NO_DATA`, a non-persistable health status, or `dryRun`). */
  readonly persisted: boolean;
  /**
   * B-F2-CAL-3: populated ONLY for bucket `DRY_RUN_ACQUISITION_PLANNED` --
   * the CAL-2-canonical, already-invariant-validated expected minute count
   * for this date, taken directly from the calendar plan. Informational
   * only: it is a planning fact, never a claim that any row was actually
   * fetched, validated, or persisted (`sourceRowCount`/`canonicalRowCount`
   * stay `0` for this bucket).
   */
  readonly plannedExpectedMinuteCount?: number;
  /**
   * B-F2C: the durable `HistoricalDataRetrieval.id` this date's provider
   * data (if any was actually fetched) belongs to -- lets a caller/year
   * runner trace a result back to its durable evidence. `undefined` for
   * every date this run never called the provider for (`ALREADY_COMPLETE`,
   * `CLOSED_NO_DATA_EXPECTED`, `DRY_RUN_ACQUISITION_PLANNED`) -- invariant
   * 12: never a fabricated retrieval reference.
   */
  readonly retrievalId?: string;
  /** B-F2C: populated only for bucket `SOURCE_CONFLICT` -- the number of conflicting minutes found; see `HistoricalCandleConflict` evidence for full detail. */
  readonly conflictCount?: number;
}

export interface NiftyUnderlyingAcquisitionResult {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly monthlyChunksAttempted: number;
  readonly monthlyChunksSucceeded: number;
  readonly monthlyChunksFailed: number;
  readonly providerRowsReceived: number;
  readonly canonicalRowsAccepted: number;
  readonly excludedRows: number;
  readonly sessions: {
    readonly alreadyComplete: readonly string[];
    readonly newlyCompleted: readonly string[];
    readonly normalizedWithExclusions: readonly string[];
    readonly incomplete: readonly string[];
    readonly invalid: readonly string[];
    /**
     * Always empty in B-F2: reaching `SPECIAL_SESSION_EXCLUDED` requires the
     * projector's explicit `UNDECLARED_SPECIAL_SESSION` declaration, which
     * requires a special-session registry B-F2 does not build (see task
     * section 6). Kept as a typed bucket so a future registry-aware caller
     * can declare a date special without changing this result shape.
     */
    readonly specialSessionExcluded: readonly string[];
    readonly unresolvedNoData: readonly string[];
    /**
     * B-F2-CAL-2: dates the certified calendar resolved as `CLOSED_HOLIDAY`,
     * `CLOSED_EXCEPTIONAL`, or `CLOSED_WEEKEND` -- zero expected minutes, no
     * provider request issued, never persisted, and NEVER conflated with
     * `unresolvedNoData` (which means the calendar expected real trading
     * data and none arrived).
     */
    readonly closedNoDataExpected: readonly string[];
    /**
     * B-F2-CAL-3: dates that ARE fetch-eligible and NOT already locally
     * complete, but for which this `dryRun: true` run performed ZERO
     * provider retrieval and ZERO persistence. Always empty when `dryRun`
     * is `false` -- a real run either fetches and buckets these elsewhere,
     * or the chunk fetch itself fails into `failedChunks`.
     */
    readonly dryRunAcquisitionPlanned: readonly string[];
    /**
     * B-F2C: dates whose incoming provider content conflicted with
     * already-persisted `HistoricalCandle` content at the same logical key.
     * Never treated as healthy/completed by this result or by the year
     * runner -- `HistoricalCandle` is left unchanged for every date here.
     */
    readonly sourceConflict: readonly string[];
  };
  /** Full typed detail for every date this run touched -- not just the problematic ones -- so nothing is free-form-only. */
  readonly sessionDetails: readonly NiftySessionAcquisitionDetail[];
  readonly retryCount: number;
  readonly rateLimitBackoffCount: number;
  /** Message text only -- see `describeError`; never includes request headers/tokens. */
  readonly failedChunks: readonly { fromDate: string; toDate: string; error: string }[];
  /** B-F2-CAL-3: echoes the request's `dryRun` flag so a caller/report can distinguish a genuinely executed run from a network-free planning-only run without re-threading the original request. */
  readonly dryRun: boolean;
}

export interface NiftyUnderlyingAcquisitionServiceDependencies {
  readonly provider?: HistoricalDataProvider;
  readonly projector?: CanonicalSessionProjectorService;
  readonly validator?: DatasetHealthValidatorService;
  readonly repository?: HistoricalCandleRepository;
  readonly rateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
  /**
   * B-F2-CAL-2: the single authoritative source of each requested date's
   * trading-day disposition and session windows (task section 3's core
   * architectural invariant). Defaults to a real
   * `NiftyUnderlyingIngestionPlannerService` (itself defaulting to a real,
   * Prisma-backed `ExchangeCalendarResolverService`) -- the same default
   * pattern already used for `provider`/`repository` above. Tests inject a
   * fake/duck-typed planner so no unit test touches a live database.
   */
  readonly plannerService?: NiftyUnderlyingIngestionPlannerService;
  /**
   * B-F2C: durable, crash-truthful retrieval-lifecycle evidence writer/reader
   * (invariants 1/2/14). Defaults to a real, Prisma-backed instance. Tests
   * inject a fake/duck-typed service so no unit test touches a live database.
   */
  readonly retrievalEvidenceService?: HistoricalDataRetrievalEvidenceService;
  /**
   * B-F2C: the ONLY write path this service uses for accepted candle
   * content -- conflict-safe, session-atomic, never a blind overwrite (see
   * `HistoricalCandleResearchPersistenceService`). Defaults to a real
   * instance. Deliberately NOT `HistoricalCandleRepository.bulkUpsert`
   * (still used, unchanged, by every other existing caller).
   */
  readonly researchPersistenceService?: HistoricalCandleResearchPersistenceService;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const BUCKET_TO_SESSIONS_KEY: Record<NiftySessionAcquisitionBucket, keyof NiftyUnderlyingAcquisitionResult['sessions']> = {
  ALREADY_COMPLETE: 'alreadyComplete',
  NEWLY_COMPLETED: 'newlyCompleted',
  NORMALIZED_WITH_EXCLUSIONS: 'normalizedWithExclusions',
  INCOMPLETE: 'incomplete',
  INVALID: 'invalid',
  SPECIAL_SESSION_EXCLUDED: 'specialSessionExcluded',
  UNRESOLVED_NO_DATA: 'unresolvedNoData',
  CLOSED_NO_DATA_EXPECTED: 'closedNoDataExpected',
  DRY_RUN_ACQUISITION_PLANNED: 'dryRunAcquisitionPlanned',
  SOURCE_CONFLICT: 'sourceConflict',
};

/**
 * NIFTY-underlying-specific (not a generic multi-instrument orchestrator --
 * see task B-F2 section 4) acquisition service: safely acquires, canonicalizes,
 * validates, persists, resumes, and reports on NSE_INDEX|Nifty 50 1-minute
 * historical candles.
 *
 * Reuses, never reimplements: `CanonicalSessionProjectorService` /
 * `DatasetHealthValidatorService` (B-F1) for session canonicalization and
 * health, `HistoricalCandleRepository.bulkUpsert` (its internal
 * `atomicUpsert`/`INSERT ... ON DUPLICATE KEY UPDATE`) for race-safe
 * persistence, and `isCompleteHistoricalSession` /
 * `HISTORICAL_SESSION_ROW_COUNT` for the completeness contract itself.
 * `HistoricalCandleSyncService` (the operational sync path) is not
 * imported, modified, or wrapped -- this is an independent, additive
 * research-lake orchestrator.
 */
export default class NiftyUnderlyingAcquisitionService {
  private readonly provider: HistoricalDataProvider;
  private readonly projector: CanonicalSessionProjectorService;
  private readonly validator: DatasetHealthValidatorService;
  private readonly repository: HistoricalCandleRepository;
  private readonly rateLimiter: HistoricalProviderRateLimiterService;
  private readonly retryOptions: HistoricalProviderRetryOptions;
  private readonly plannerService: NiftyUnderlyingIngestionPlannerService;
  private readonly retrievalEvidenceService: HistoricalDataRetrievalEvidenceService;
  private readonly researchPersistenceService: HistoricalCandleResearchPersistenceService;

  constructor(dependencies: NiftyUnderlyingAcquisitionServiceDependencies = {}) {
    this.provider = dependencies.provider ?? new UpstoxHistoricalDataProviderService();
    this.projector = dependencies.projector ?? new CanonicalSessionProjectorService();
    this.validator = dependencies.validator ?? new DatasetHealthValidatorService();
    this.repository = dependencies.repository ?? new HistoricalCandleRepository();
    this.rateLimiter = dependencies.rateLimiter ?? new HistoricalProviderRateLimiterService(UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
    this.plannerService = dependencies.plannerService ?? new NiftyUnderlyingIngestionPlannerService();
    this.retrievalEvidenceService = dependencies.retrievalEvidenceService ?? new HistoricalDataRetrievalEvidenceService();
    this.researchPersistenceService = dependencies.researchPersistenceService ?? new HistoricalCandleResearchPersistenceService();
  }

  async acquire(request: NiftyUnderlyingAcquisitionRequest): Promise<NiftyUnderlyingAcquisitionResult> {
    this.assertValidDate('toDate', request.toDate);
    const capability = this.provider.getCapability();
    const fromDate = request.fromDate ?? capability.earliestDocumentedUnderlyingHistory ?? undefined;
    if (!fromDate) {
      throw new Error(
        'NiftyUnderlyingAcquisitionService requires an explicit fromDate: the provider does not document a default earliestDocumentedUnderlyingHistory.'
      );
    }
    this.assertValidDate('fromDate', fromDate);
    if (fromDate > request.toDate) {
      throw new Error(`fromDate (${fromDate}) must not be after toDate (${request.toDate}).`);
    }
    const dryRun = request.dryRun === true;

    // B-F2-CAL-2 core invariant (task section 3): build ONE authoritative
    // calendar plan for the FULL requested range before any provider
    // construction/call, and consult it exclusively for every date's
    // disposition/session-windows/expected-minutes -- never re-derived by
    // weekday heuristic or a second hardcoded session window. A blocked
    // (UNCERTIFIED) date anywhere in the range fails the WHOLE request
    // closed before any network acquisition (task section 12/13/33).
    const plan = await this.plannerService.buildPlan({ fromDate, toDate: request.toDate });
    if (plan.hasBlockedDates) {
      throw new NiftyAcquisitionCalendarBlockedError(plan);
    }
    // B-F2-CAL-2-FIX-1 (task section 4/7): prove every planned date's
    // sessionWindows/expectedMinutesIst/expectedMinuteCount agree with each
    // other BEFORE any provider work -- not lazily inside processCandidateDate,
    // and not only for the date that happens to be fetched first. A single
    // inconsistent date anywhere in the range fails the WHOLE request closed.
    const validatedDates = this.validateAndCanonicalizePlan(plan);
    const validatedByDate = new Map(validatedDates.map((validated) => [validated.tradingDate, validated]));

    const stats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };
    const monthlyChunks = splitIntoCalendarMonthChunks(fromDate, request.toDate);

    let monthlyChunksSucceeded = 0;
    let monthlyChunksFailed = 0;
    let providerRowsReceived = 0;
    let canonicalRowsAccepted = 0;
    let excludedRowsTotal = 0;
    const failedChunks: Array<{ fromDate: string; toDate: string; error: string }> = [];
    const sessionDetails: NiftySessionAcquisitionDetail[] = [];
    const sessions = {
      alreadyComplete: [] as string[],
      newlyCompleted: [] as string[],
      normalizedWithExclusions: [] as string[],
      incomplete: [] as string[],
      invalid: [] as string[],
      specialSessionExcluded: [] as string[],
      unresolvedNoData: [] as string[],
      closedNoDataExpected: [] as string[],
      dryRunAcquisitionPlanned: [] as string[],
      sourceConflict: [] as string[],
    };
    const pushBucket = (bucket: NiftySessionAcquisitionBucket, date: string): void => {
      sessions[BUCKET_TO_SESSIONS_KEY[bucket]].push(date);
    };

    for (const chunk of monthlyChunks) {
      const chunkPlannedDates = this.plannedDatesInRange(validatedDates, chunk.fromDate, chunk.toDate);
      const alreadyCompleteInChunk = await this.findAlreadyCompleteDatesInRange(chunk.fromDate, chunk.toDate, validatedByDate);

      // Calendar-certified closed dates (task section 7/8/9/15) never cause
      // a provider request and are never treated as missing data.
      for (const planned of chunkPlannedDates) {
        if (!CLOSED_DISPOSITIONS.has(planned.disposition)) continue;
        sessionDetails.push(this.closedNoDataDetail(planned.tradingDate));
        pushBucket('CLOSED_NO_DATA_EXPECTED', planned.tradingDate);
      }

      const pendingFetchEligible = chunkPlannedDates.filter(
        (planned) => FETCH_ELIGIBLE_DISPOSITIONS.has(planned.disposition) && !alreadyCompleteInChunk.has(planned.tradingDate)
      );

      for (const date of alreadyCompleteInChunk) {
        sessionDetails.push(this.alreadyCompleteDetail(date, validatedByDate.get(date)));
        pushBucket('ALREADY_COMPLETE', date);
      }

      if (pendingFetchEligible.length === 0) {
        // Every date in this chunk is either already complete or certified
        // closed -- no provider request is needed at all (task section 15).
        monthlyChunksSucceeded += 1;
        continue;
      }

      if (dryRun) {
        // B-F2-CAL-3 core fix: a true acquire-level dry-run must never
        // reach `HistoricalDataProvider` -- report what WOULD require
        // provider retrieval using only the calendar plan + the read-only
        // local-completeness check already performed above, and stop
        // BEFORE `fetchChunk` (and therefore before any network call,
        // any `bulkUpsert`, and any post-persist reconciliation read).
        for (const planned of pendingFetchEligible) {
          sessionDetails.push(this.dryRunPlannedDetail(planned));
          pushBucket('DRY_RUN_ACQUISITION_PLANNED', planned.tradingDate);
        }
        monthlyChunksSucceeded += 1;
        continue;
      }

      // B-F2C invariants 1/2: durable STARTED retrieval-attempt evidence is
      // created BEFORE the provider is ever called for this chunk -- a
      // crash between here and the provider responding leaves a truthful
      // STARTED row, never a fabricated ACCEPTED claim. Never reached for
      // dryRun (the branch above already returned) or for a chunk with no
      // fetch-eligible work (the branch above already returned) -- so no
      // evidence is ever created for a date this run never genuinely
      // attempts against a provider (invariant 12).
      const retrievalId = await this.retrievalEvidenceService.startRetrieval({
        providerId: this.provider.providerId,
        assetType: HistoricalAssetType.NIFTY_INDEX,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        timeframe: NIFTY_UNDERLYING_TIMEFRAME,
        requestedFromDate: chunk.fromDate,
        requestedToDate: chunk.toDate,
      });
      const retryCountBeforeChunk = stats.retryCount;

      let rawRows: readonly HistoricalSourceCandleRow[];
      try {
        rawRows = await this.fetchChunk(chunk, stats);
      } catch (error) {
        monthlyChunksFailed += 1;
        failedChunks.push({ fromDate: chunk.fromDate, toDate: chunk.toDate, error: this.describeError(error) });
        // B-F2C invariant 14: the provider call itself failed -- evidence
        // must never claim ACCEPTED. No per-date session evidence is
        // written for a failed chunk: there is nothing per-date to report,
        // since rows were never partitioned by date.
        await this.retrievalEvidenceService.recordFailed(retrievalId, {
          errorCategory: this.classifyErrorCategory(error),
          errorMessage: this.describeError(error),
          providerCallAttempts: 1 + (stats.retryCount - retryCountBeforeChunk),
        });
        continue; // one bad chunk must not abort other, healthy chunks
      }
      monthlyChunksSucceeded += 1;
      providerRowsReceived += rawRows.length;

      const sourceRowsSemanticChecksum = computeSourceRowsSemanticChecksum(rawRows);
      await this.retrievalEvidenceService.recordFetched(retrievalId, {
        sourceRowCount: rawRows.length,
        sourceRowsSemanticChecksum,
        providerCallAttempts: 1 + (stats.retryCount - retryCountBeforeChunk),
      });

      const byDate = this.groupRowsByTradingDate(rawRows);
      let anyIssueThisRetrieval = false;

      for (const planned of pendingFetchEligible) {
        const date = planned.tradingDate;
        if (!byDate.has(date)) continue; // handled by the UNRESOLVED_NO_DATA pass below
        // eslint-disable-next-line no-await-in-loop -- persistence must stay ordered per date, one date's write must complete/reconcile before the next begins
        const detail = await this.processCandidateDate(planned, byDate.get(date) ?? [], dryRun, retrievalId);
        sessionDetails.push(detail);
        pushBucket(detail.bucket, date);
        canonicalRowsAccepted += detail.canonicalRowCount;
        excludedRowsTotal += detail.excludedRowCount;
        if (detail.bucket === 'INCOMPLETE' || detail.bucket === 'INVALID' || detail.bucket === 'SOURCE_CONFLICT') anyIssueThisRetrieval = true;
      }

      for (const planned of pendingFetchEligible) {
        if (byDate.has(planned.tradingDate)) continue;
        sessionDetails.push(this.unresolvedDetail(planned.tradingDate, retrievalId));
        pushBucket('UNRESOLVED_NO_DATA', planned.tradingDate);
        anyIssueThisRetrieval = true;
        // eslint-disable-next-line no-await-in-loop -- matches the ordered-per-date convention already used above
        await this.retrievalEvidenceService.recordNonPersistableSession({
          retrievalId,
          providerId: this.provider.providerId,
          instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
          timeframe: NIFTY_UNDERLYING_TIMEFRAME,
          tradingDate: planned.tradingDate,
          calendarDisposition: planned.disposition,
          expectedMinuteCount: planned.expectedMinuteCount,
          providerRowCountForDate: 0,
          acceptedRowCount: 0,
          excludedRowCount: 0,
          sourceOrderAnomalyCount: 0,
          healthStatus: DatasetHealthStatus.PROVIDER_UNAVAILABLE,
          persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.NO_PROVIDER_DATA_FOR_DATE,
          sourceRowsSemanticChecksum,
        });
      }

      await this.retrievalEvidenceService.finalizeRetrieval(
        retrievalId,
        anyIssueThisRetrieval ? HistoricalDataRetrievalStatus.COMPLETED_WITH_ISSUES : HistoricalDataRetrievalStatus.PROCESSED
      );
    }

    return {
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      requestedStartDate: fromDate,
      requestedEndDate: request.toDate,
      monthlyChunksAttempted: monthlyChunks.length,
      monthlyChunksSucceeded,
      monthlyChunksFailed,
      providerRowsReceived,
      canonicalRowsAccepted,
      excludedRows: excludedRowsTotal,
      sessions,
      sessionDetails,
      retryCount: stats.retryCount,
      rateLimitBackoffCount: stats.rateLimitBackoffCount,
      failedChunks,
      dryRun,
    };
  }

  private async fetchChunk(chunk: CalendarDateRange, stats: HistoricalProviderRetryStats): Promise<readonly HistoricalSourceCandleRow[]> {
    return withHistoricalProviderRetry(
      () =>
        this.rateLimiter.schedule(() =>
          this.provider.fetchCompletedUnderlyingRange({
            assetType: HistoricalAssetType.NIFTY_INDEX,
            instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
            interval: NIFTY_UNDERLYING_TIMEFRAME,
            fromTradingDate: chunk.fromDate,
            toTradingDate: chunk.toDate,
          })
        ),
      stats,
      this.retryOptions
    );
  }

  /**
   * Runs one candidate trading date's raw rows through the B-F1
   * projector/validator -- ALWAYS via `CALENDAR_DECLARED_SESSION` using the
   * plan's own `sessionWindows`/`expectedMinutesIst` (task section 3/6/10/11:
   * one authoritative window derivation for both a regular day, where the
   * plan's window already equals the classic [555,930), and a special day)
   * -- then persists ONLY if the resulting health is `HEALTHY` or
   * `NORMALIZED_WITH_EXCLUSIONS` (section 5's "normal healthy acceptance")
   * and `dryRun` is not set. After a real write, re-reads the date from the
   * repository and re-checks completeness against that SAME expected-minute
   * set -- a session is never reported complete on the strength of the
   * in-memory write alone (section 8), and a special session is never
   * scored against the fixed 375-row regular contract (task section 22:
   * `REGULAR_TRADING_DAY` keeps using `isCompleteHistoricalSession` byte-for
   * -byte unchanged, so already-persisted regular-session data is never
   * reinterpreted).
   */
  private async processCandidateDate(
    planned: ValidatedNiftyPlannedDate,
    rows: readonly HistoricalSourceCandleRow[],
    dryRun: boolean,
    retrievalId: string
  ): Promise<NiftySessionAcquisitionDetail> {
    const date = planned.tradingDate;
    const projection = this.projector.project({
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      tradingDate: date,
      sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
      sessionWindows: planned.sessionWindows,
      sourceRows: rows,
    });
    const report = this.validator.validate(projection, planned.expectedMinutesIst);
    const isPersistable = report.status === DatasetHealthStatus.HEALTHY || report.status === DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS;
    const sourceRowsSemanticChecksum = computeSourceRowsSemanticChecksum(rows);

    if (!isPersistable) {
      // B-F2C invariant 10: a non-persistable date (INCOMPLETE/INVALID/...)
      // never touches HistoricalCandle, but its exclusion/anomaly/health
      // evidence must not disappear -- it is durably recorded here.
      await this.retrievalEvidenceService.recordNonPersistableSession({
        retrievalId,
        providerId: this.provider.providerId,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        timeframe: NIFTY_UNDERLYING_TIMEFRAME,
        tradingDate: date,
        calendarDisposition: planned.disposition,
        expectedMinuteCount: planned.expectedMinuteCount,
        providerRowCountForDate: rows.length,
        acceptedRowCount: report.canonicalRowCount,
        excludedRowCount: report.excludedRowCount,
        sourceOrderAnomalyCount: projection.sourceOrderAnomalies.length,
        healthStatus: report.status,
        persistenceOutcome:
          report.status === DatasetHealthStatus.INVALID
            ? HistoricalCandleSessionPersistenceOutcome.INVALID
            : HistoricalCandleSessionPersistenceOutcome.INCOMPLETE,
        sourceRowsSemanticChecksum,
      });
      return this.buildDetail(date, report, false, [], undefined, retrievalId);
    }

    if (dryRun) {
      // Structurally unreachable post-CAL-3: the chunk loop's dryRun branch
      // already returns before `fetchChunk`/this method is ever called.
      // Kept as defense-in-depth exactly like the pre-B-F2C code did.
      return this.buildDetail(date, report, false, [], undefined, retrievalId);
    }

    // B-F2C invariants 5-9: NEVER `HistoricalCandleRepository.bulkUpsert`
    // for this path -- `projection.acceptedRows` (by construction, exactly
    // the canonical accepted set; excluded rows never entered it) is
    // compared against already-persisted content inside one conflict-safe,
    // session-atomic transaction. See `HistoricalCandleResearchPersistenceService`.
    const { from, to } = this.istRangeBounds(date, date);
    const persistenceResult: ResearchSessionPersistenceResult = await this.researchPersistenceService.persistSession(
      {
        retrievalId,
        providerId: this.provider.providerId,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        timeframe: NIFTY_UNDERLYING_TIMEFRAME,
        tradingDate: date,
        calendarDisposition: planned.disposition,
        expectedMinuteCount: planned.expectedMinuteCount,
        providerRowCountForDate: rows.length,
        healthStatus: report.status,
        excludedRowCount: report.excludedRowCount,
        sourceOrderAnomalyCount: projection.sourceOrderAnomalies.length,
        sourceRowsSemanticChecksum,
        from,
        to,
      },
      projection.acceptedRows
    );

    if (persistenceResult.outcome === 'CONFLICT') {
      const acquisitionIssue: NiftyAcquisitionIssue = {
        reason: NiftyAcquisitionIssueReason.SOURCE_CONTENT_CONFLICT,
        detail: `Source-content conflict for ${date}: ${persistenceResult.conflicts.length} candle(s) differ from already-persisted content; existing HistoricalCandle rows are unchanged and nothing was persisted for this session.`,
      };
      return this.buildDetail(date, report, false, [acquisitionIssue], 'SOURCE_CONFLICT', retrievalId, persistenceResult.conflicts.length);
    }

    // ACCEPTED_NEW or ACCEPTED_IDEMPOTENT: `persisted` reflects whether THIS
    // run actually wrote a new row (invariant 6: an idempotent equivalent
    // re-download inserts nothing and must not report `persisted: true`).
    const persisted = persistenceResult.insertedCount > 0;
    const reread = await this.repository.findRange(NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME, from, to);

    if (!this.isSessionComplete(reread, date, planned)) {
      const acquisitionIssue: NiftyAcquisitionIssue = {
        reason: NiftyAcquisitionIssueReason.POST_PERSIST_RECONCILIATION_FAILED,
        detail: `Post-persist reconciliation read for ${date} found ${reread.length} row(s), not a complete ${planned.expectedMinuteCount}-row session; not marked complete.`,
      };
      return this.buildDetail(date, report, persisted, [acquisitionIssue], 'INCOMPLETE', retrievalId);
    }

    return this.buildDetail(date, report, persisted, [], undefined, retrievalId);
  }

  /**
   * `REGULAR_TRADING_DAY` keeps the existing shared
   * `isCompleteHistoricalSession` contract exactly (task section 22:
   * preserves compatibility with already-persisted regular-session data and
   * every other caller of that shared 375-row completeness contract, e.g.
   * the V8 strategy shadow service). `SPECIAL_SESSION_DAY` uses the
   * calendar-parameterized `isCompleteCalendarSession` against the plan's
   * own `expectedMinutesIst` -- never the fixed 375-row shape.
   */
  private isSessionComplete(rows: readonly { candleTime: Date }[], date: string, planned: ValidatedNiftyPlannedDate): boolean {
    if (planned.disposition === NiftyPlannedDateDisposition.REGULAR_TRADING_DAY) {
      return isCompleteHistoricalSession(rows);
    }
    return isCompleteCalendarSession(rows, date, planned.expectedMinutesIst);
  }

  private buildDetail(
    date: string,
    report: DatasetHealthReport,
    persisted: boolean,
    acquisitionIssues: readonly NiftyAcquisitionIssue[],
    bucketOverride?: NiftySessionAcquisitionBucket,
    retrievalId?: string,
    conflictCount?: number
  ): NiftySessionAcquisitionDetail {
    return {
      tradingDate: date,
      bucket: bucketOverride ?? this.mapHealthStatusToBucket(report.status),
      healthStatus: report.status,
      issues: report.issues,
      acquisitionIssues,
      sourceRowCount: report.sourceRowCount,
      canonicalRowCount: report.canonicalRowCount,
      excludedRowCount: report.excludedRowCount,
      exclusions: report.exclusions,
      persisted,
      retrievalId,
      conflictCount,
    };
  }

  private mapHealthStatusToBucket(status: DatasetHealthStatus): NiftySessionAcquisitionBucket {
    switch (status) {
      case DatasetHealthStatus.HEALTHY:
        return 'NEWLY_COMPLETED';
      case DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS:
        return 'NORMALIZED_WITH_EXCLUSIONS';
      case DatasetHealthStatus.INCOMPLETE:
        return 'INCOMPLETE';
      case DatasetHealthStatus.INVALID:
        return 'INVALID';
      case DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED:
        return 'SPECIAL_SESSION_EXCLUDED';
      case DatasetHealthStatus.PROVIDER_UNAVAILABLE:
      case DatasetHealthStatus.METADATA_INCOMPLETE:
        // Neither should be reachable here: this method is only ever called
        // with rows this run itself just fetched (so sourceRowCount > 0)
        // for a concrete, always-populated instrumentKey/tradingDate.
        // Folded into INVALID rather than silently dropped if it ever does occur.
        return 'INVALID';
      default: {
        const exhaustive: never = status;
        throw new Error(`Unhandled DatasetHealthStatus: ${exhaustive}`);
      }
    }
  }

  /** `expectedRowCount` defaults to the classic 375 only when no plan entry is available (should not occur in practice: every date in range has a planned entry). */
  private alreadyCompleteDetail(date: string, planned: ValidatedNiftyPlannedDate | undefined): NiftySessionAcquisitionDetail {
    return {
      tradingDate: date,
      bucket: 'ALREADY_COMPLETE',
      healthStatus: null,
      issues: [],
      acquisitionIssues: [],
      sourceRowCount: 0,
      canonicalRowCount: planned?.expectedMinuteCount ?? HISTORICAL_SESSION_ROW_COUNT,
      excludedRowCount: 0,
      exclusions: [],
      persisted: false, // not persisted BY THIS RUN -- it was already complete from a prior run
    };
  }

  private unresolvedDetail(date: string, retrievalId: string): NiftySessionAcquisitionDetail {
    return {
      tradingDate: date,
      bucket: 'UNRESOLVED_NO_DATA',
      healthStatus: null,
      issues: [],
      acquisitionIssues: [],
      sourceRowCount: 0,
      canonicalRowCount: 0,
      excludedRowCount: 0,
      exclusions: [],
      persisted: false,
      retrievalId,
    };
  }

  /**
   * B-F2-CAL-3: truthful placeholder detail for a fetch-eligible,
   * not-already-complete date this `dryRun: true` run deliberately did NOT
   * retrieve from the provider. `sourceRowCount`/`canonicalRowCount` stay
   * `0` (nothing was fetched or accepted this run) and `persisted` stays
   * `false`; only `plannedExpectedMinuteCount` carries a non-zero, already
   * CAL-2-invariant-validated fact from the calendar plan itself.
   */
  private dryRunPlannedDetail(planned: ValidatedNiftyPlannedDate): NiftySessionAcquisitionDetail {
    return {
      tradingDate: planned.tradingDate,
      bucket: 'DRY_RUN_ACQUISITION_PLANNED',
      healthStatus: null,
      issues: [],
      acquisitionIssues: [],
      sourceRowCount: 0,
      canonicalRowCount: 0,
      excludedRowCount: 0,
      exclusions: [],
      persisted: false,
      plannedExpectedMinuteCount: planned.expectedMinuteCount,
    };
  }

  /**
   * Calendar-certified closed date (task section 7/8/9): zero expected
   * minutes, never persisted, never an error -- distinct from
   * `UNRESOLVED_NO_DATA`, which means the calendar expected a real trading
   * session and none arrived.
   */
  private closedNoDataDetail(date: string): NiftySessionAcquisitionDetail {
    return {
      tradingDate: date,
      bucket: 'CLOSED_NO_DATA_EXPECTED',
      healthStatus: null,
      issues: [],
      acquisitionIssues: [],
      sourceRowCount: 0,
      canonicalRowCount: 0,
      excludedRowCount: 0,
      exclusions: [],
      persisted: false,
    };
  }

  /**
   * B-F2-CAL-2-FIX-1 core correction (task section 4/5/7/8/9): proves every
   * date's `sessionWindows`/`expectedMinutesIst`/`expectedMinuteCount`
   * agree with each other, for the WHOLE requested plan, before any
   * provider/chunk/persistence work begins. Throws
   * `NiftyAcquisitionCalendarPlanInvariantError` on the FIRST inconsistent
   * date found (deterministic ascending order, since `plan.dates` is
   * already ascending) -- the entire request fails closed, never a partial
   * per-date skip.
   */
  private validateAndCanonicalizePlan(plan: NiftyIngestionPlan): ValidatedNiftyPlannedDate[] {
    return plan.dates.map((planned) => this.validateAndCanonicalizePlannedDate(planned));
  }

  private validateAndCanonicalizePlannedDate(planned: NiftyPlannedDate): ValidatedNiftyPlannedDate {
    if (CLOSED_DISPOSITIONS.has(planned.disposition)) {
      if (planned.sessionWindows.length > 0 || planned.expectedMinutesIst.length > 0 || planned.expectedMinuteCount !== 0) {
        throw new NiftyAcquisitionCalendarPlanInvariantError(
          planned.tradingDate,
          planned.disposition,
          NiftyAcquisitionCalendarPlanInvariantReason.CLOSED_DATE_HAS_SESSION_EXPECTATION,
          planned.expectedMinuteCount,
          0
        );
      }
      return { tradingDate: planned.tradingDate, disposition: planned.disposition, sessionWindows: [], expectedMinutesIst: [], expectedMinuteCount: 0 };
    }

    if (!FETCH_ELIGIBLE_DISPOSITIONS.has(planned.disposition)) {
      // BLOCKED_UNCERTIFIED cannot reach here: `acquire()` already returned
      // via `NiftyAcquisitionCalendarBlockedError` whenever `plan.hasBlockedDates`
      // is true, and that flag is derived from these exact same `plan.dates`.
      // Passed through unvalidated/uncanonicalized defensively rather than
      // asserted unreachable, since this disposition carries no session
      // expectation this invariant governs either way.
      return {
        tradingDate: planned.tradingDate,
        disposition: planned.disposition,
        sessionWindows: planned.sessionWindows,
        expectedMinutesIst: planned.expectedMinutesIst,
        expectedMinuteCount: planned.expectedMinuteCount,
      };
    }

    if (planned.sessionWindows.length === 0) {
      throw new NiftyAcquisitionCalendarPlanInvariantError(
        planned.tradingDate,
        planned.disposition,
        NiftyAcquisitionCalendarPlanInvariantReason.SESSION_WINDOWS_MISSING,
        planned.expectedMinuteCount,
        0
      );
    }

    // Reuses the existing production calendar-core window validator/expected-
    // minute deriver (task section 4: "using the existing production utility
    // expectedMinutesForWindows") -- never a re-implementation of window
    // shape/overlap rules or minute expansion.
    const validatedWindows = validateSessionWindows(planned.sessionWindows);
    const canonicalExpectedMinutesIst = expectedMinutesForWindows(validatedWindows);

    if (planned.expectedMinuteCount !== canonicalExpectedMinutesIst.length) {
      throw new NiftyAcquisitionCalendarPlanInvariantError(
        planned.tradingDate,
        planned.disposition,
        NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_COUNT_MISMATCH,
        planned.expectedMinuteCount,
        canonicalExpectedMinutesIst.length
      );
    }

    if (!this.exactPositionalEquality(planned.expectedMinutesIst, canonicalExpectedMinutesIst)) {
      throw new NiftyAcquisitionCalendarPlanInvariantError(
        planned.tradingDate,
        planned.disposition,
        NiftyAcquisitionCalendarPlanInvariantReason.EXPECTED_MINUTE_SET_MISMATCH,
        planned.expectedMinuteCount,
        canonicalExpectedMinutesIst.length
      );
    }

    return {
      tradingDate: planned.tradingDate,
      disposition: planned.disposition,
      sessionWindows: validatedWindows,
      expectedMinutesIst: canonicalExpectedMinutesIst,
      expectedMinuteCount: canonicalExpectedMinutesIst.length,
    };
  }

  /**
   * Strict positional (same length, same order, same values) equality --
   * deliberately NOT a `Set`-based comparison (task section 12/18: a
   * duplicate-plus-missing or reordered array must never be silently
   * normalized into a false match).
   */
  private exactPositionalEquality(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  /** Every date in `[fromDate, toDate]`, ascending, restricted to the FULL, already-validated plan's own entries (the chunk is always a sub-range of the plan's requested range). */
  private plannedDatesInRange(validatedDates: readonly ValidatedNiftyPlannedDate[], fromDate: string, toDate: string): readonly ValidatedNiftyPlannedDate[] {
    return validatedDates.filter((planned) => planned.tradingDate >= fromDate && planned.tradingDate <= toDate);
  }

  private async findAlreadyCompleteDatesInRange(
    fromDate: string,
    toDate: string,
    validatedByDate: ReadonlyMap<string, ValidatedNiftyPlannedDate>
  ): Promise<Set<string>> {
    const { from, to } = this.istRangeBounds(fromDate, toDate);
    const existing = await this.repository.findRange(NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME, from, to);
    const byDate = this.groupByTradingDate(existing);
    const complete = new Set<string>();
    for (const [date, rows] of byDate) {
      const planned = validatedByDate.get(date);
      if (!planned || !FETCH_ELIGIBLE_DISPOSITIONS.has(planned.disposition)) continue;
      if (this.isSessionComplete(rows, date, planned)) complete.add(date);
    }
    return complete;
  }

  private groupRowsByTradingDate(rows: readonly HistoricalSourceCandleRow[]): Map<string, HistoricalSourceCandleRow[]> {
    return this.groupByTradingDate(rows);
  }

  private groupByTradingDate<T extends { candleTime: Date }>(rows: readonly T[]): Map<string, T[]> {
    const byDate = new Map<string, T[]>();
    for (const row of rows) {
      const date = istCalendarDate(row.candleTime);
      const existing = byDate.get(date);
      if (existing) existing.push(row);
      else byDate.set(date, [row]);
    }
    return byDate;
  }

  private istRangeBounds(fromDate: string, toDate: string): { from: Date; to: Date } {
    return { from: new Date(`${fromDate}T00:00:00+05:30`), to: new Date(`${toDate}T23:59:59.999+05:30`) };
  }

  private assertValidDate(field: string, value: string): void {
    if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`NiftyUnderlyingAcquisitionService requires ${field} to be a valid YYYY-MM-DD date; received '${value}'.`);
    }
  }

  /** Only ever reads `.message` -- never `.config` (where request headers/tokens live on an axios error) -- so a token can never leak into a report. */
  private describeError(error: unknown): string {
    if (error instanceof HistoricalProviderPermanentError || error instanceof HistoricalProviderRetryExhaustedError) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** B-F2C invariant 14: safe failure classification for durable evidence -- reads only the existing typed retry-error classes, never anything from the underlying axios error beyond what `describeError` already exposes. */
  private classifyErrorCategory(error: unknown): HistoricalDataRetrievalErrorCategory {
    if (error instanceof HistoricalProviderPermanentError) return HistoricalDataRetrievalErrorCategory.PERMANENT;
    if (error instanceof HistoricalProviderRetryExhaustedError) return HistoricalDataRetrievalErrorCategory.RETRY_EXHAUSTED;
    return HistoricalDataRetrievalErrorCategory.UNKNOWN;
  }
}
