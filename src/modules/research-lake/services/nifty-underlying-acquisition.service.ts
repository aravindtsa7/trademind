import HistoricalCandleRepository, {
  HistoricalCandleUpsertInput,
} from '../../historical-candles/repositories/historical-candle.repository';
import {
  HISTORICAL_SESSION_ROW_COUNT,
  isCompleteHistoricalSession,
} from '../../historical-candles/utils/historical-session-completeness.util';
import { calendarWeekdays } from '../../research/banknifty-data-audit';
import {
  CanonicalHistoricalCandle,
  CanonicalSessionDeclaration,
  CanonicalSessionExclusion,
  DatasetHealthIssue,
  DatasetHealthReport,
  DatasetHealthStatus,
  HistoricalAssetType,
  HistoricalSourceCandleRow,
  istCalendarDate,
} from '../domain';
import { CalendarDateRange, splitIntoCalendarMonthChunks } from '../domain/calendar-month-chunking.util';
import { HistoricalDataProvider } from '../interfaces/historical-data-provider.interface';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import DatasetHealthValidatorService from './dataset-health-validator.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import {
  HistoricalProviderPermanentError,
  HistoricalProviderRetryExhaustedError,
  HistoricalProviderRetryOptions,
  HistoricalProviderRetryStats,
  withHistoricalProviderRetry,
} from './historical-provider-retry.util';
import UpstoxHistoricalDataProviderService from '../providers/upstox/upstox-historical-data-provider.service';

export const NIFTY_INDEX_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
export const NIFTY_UNDERLYING_TIMEFRAME = '1minute';

/** Upstox's documented sustained rate for the historical-candle endpoint: 1 request/second. */
export const UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS = 1_000;

export interface NiftyUnderlyingAcquisitionRequest {
  /** Required. Never implicitly defaulted to "today" -- an incomplete current/future session must never be silently requested. */
  readonly toDate: string;
  /** Optional; defaults to the provider's documented `earliestDocumentedUnderlyingHistory` capability. */
  readonly fromDate?: string;
  /**
   * When true: fetches from the provider exactly as normal, but never
   * writes to the database (no `bulkUpsert`, no post-write reconciliation
   * read). `NiftySessionAcquisitionDetail.persisted` reports `false` for
   * every date in a dry run, so the result is never ambiguous about what
   * actually reached the database.
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
  | 'UNRESOLVED_NO_DATA';

/**
 * Typed reason for an orchestrator-level (not B-F1 validator-level) failure
 * mode: kept deliberately separate from `DatasetHealthIssueReason` rather
 * than extending that B-F1 enum, since this is not a candle-health finding
 * -- it is "the write this run performed did not converge to a complete
 * session when read back."
 */
export enum NiftyAcquisitionIssueReason {
  POST_PERSIST_RECONCILIATION_FAILED = 'POST_PERSIST_RECONCILIATION_FAILED',
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
  };
  /** Full typed detail for every date this run touched -- not just the problematic ones -- so nothing is free-form-only. */
  readonly sessionDetails: readonly NiftySessionAcquisitionDetail[];
  readonly retryCount: number;
  readonly rateLimitBackoffCount: number;
  /** Message text only -- see `describeError`; never includes request headers/tokens. */
  readonly failedChunks: readonly { fromDate: string; toDate: string; error: string }[];
}

export interface NiftyUnderlyingAcquisitionServiceDependencies {
  readonly provider?: HistoricalDataProvider;
  readonly projector?: CanonicalSessionProjectorService;
  readonly validator?: DatasetHealthValidatorService;
  readonly repository?: HistoricalCandleRepository;
  readonly rateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
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

  constructor(dependencies: NiftyUnderlyingAcquisitionServiceDependencies = {}) {
    this.provider = dependencies.provider ?? new UpstoxHistoricalDataProviderService();
    this.projector = dependencies.projector ?? new CanonicalSessionProjectorService();
    this.validator = dependencies.validator ?? new DatasetHealthValidatorService();
    this.repository = dependencies.repository ?? new HistoricalCandleRepository();
    this.rateLimiter = dependencies.rateLimiter ?? new HistoricalProviderRateLimiterService(UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
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
    };
    const pushBucket = (bucket: NiftySessionAcquisitionBucket, date: string): void => {
      sessions[BUCKET_TO_SESSIONS_KEY[bucket]].push(date);
    };

    for (const chunk of monthlyChunks) {
      const alreadyCompleteInChunk = await this.findAlreadyCompleteDatesInRange(chunk.fromDate, chunk.toDate);

      // Provable-without-a-calendar special case (task section 8: "ideally
      // no unnecessary fetch where plan can prove coverage"): a single-date
      // chunk whose one candidate date is already DB-complete needs no
      // fetch at all. A multi-date chunk cannot be proven fully covered
      // without an NSE trading-day calendar (explicitly out of scope), so
      // it is always fetched.
      if (chunk.fromDate === chunk.toDate && alreadyCompleteInChunk.has(chunk.fromDate)) {
        sessionDetails.push(this.alreadyCompleteDetail(chunk.fromDate));
        pushBucket('ALREADY_COMPLETE', chunk.fromDate);
        monthlyChunksSucceeded += 1;
        continue;
      }

      let rawRows: readonly HistoricalSourceCandleRow[];
      try {
        rawRows = await this.fetchChunk(chunk, stats);
      } catch (error) {
        monthlyChunksFailed += 1;
        failedChunks.push({ fromDate: chunk.fromDate, toDate: chunk.toDate, error: this.describeError(error) });
        continue; // one bad chunk must not abort other, healthy chunks
      }
      monthlyChunksSucceeded += 1;
      providerRowsReceived += rawRows.length;

      const byDate = this.groupRowsByTradingDate(rawRows);

      for (const date of [...byDate.keys()].sort()) {
        if (alreadyCompleteInChunk.has(date)) {
          sessionDetails.push(this.alreadyCompleteDetail(date));
          pushBucket('ALREADY_COMPLETE', date);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- persistence must stay ordered per date, one date's write must complete/reconcile before the next begins
        const detail = await this.processCandidateDate(date, byDate.get(date) ?? [], dryRun);
        sessionDetails.push(detail);
        pushBucket(detail.bucket, date);
        canonicalRowsAccepted += detail.canonicalRowCount;
        excludedRowsTotal += detail.excludedRowCount;
      }

      for (const date of calendarWeekdays(chunk.fromDate, chunk.toDate)) {
        if (alreadyCompleteInChunk.has(date) || byDate.has(date)) continue;
        sessionDetails.push(this.unresolvedDetail(date));
        pushBucket('UNRESOLVED_NO_DATA', date);
      }
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
   * projector/validator, then persists ONLY if the resulting health is
   * `HEALTHY` or `NORMALIZED_WITH_EXCLUSIONS` (section 5's "normal healthy
   * acceptance") and `dryRun` is not set. After a real write, re-reads the
   * date from the repository and re-checks `isCompleteHistoricalSession` --
   * a session is never reported complete on the strength of the in-memory
   * write alone (section 8).
   */
  private async processCandidateDate(
    date: string,
    rows: readonly HistoricalSourceCandleRow[],
    dryRun: boolean
  ): Promise<NiftySessionAcquisitionDetail> {
    const projection = this.projector.project({
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      tradingDate: date,
      sessionDeclaration: CanonicalSessionDeclaration.NORMAL_NIFTY_SESSION,
      sourceRows: rows,
    });
    const report = this.validator.validate(projection);
    const isPersistable = report.status === DatasetHealthStatus.HEALTHY || report.status === DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS;

    if (!isPersistable || dryRun) {
      return this.buildDetail(date, report, false, []);
    }

    // Never persist excluded rows: `projection.acceptedRows` is, by
    // construction, exactly the canonical accepted set -- excluded rows
    // never entered it (see CanonicalSessionProjectorService).
    const upserts = projection.acceptedRows.map((candle) => this.toUpsertInput(candle));
    if (upserts.length > 0) {
      await this.repository.bulkUpsert(upserts);
    }

    const { from, to } = this.istRangeBounds(date, date);
    const reread = await this.repository.findRange(NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME, from, to);

    if (!isCompleteHistoricalSession(reread)) {
      const acquisitionIssue: NiftyAcquisitionIssue = {
        reason: NiftyAcquisitionIssueReason.POST_PERSIST_RECONCILIATION_FAILED,
        detail: `Post-persist reconciliation read for ${date} found ${reread.length} row(s), not a complete ${HISTORICAL_SESSION_ROW_COUNT}-row session; not marked complete.`,
      };
      return this.buildDetail(date, report, true, [acquisitionIssue], 'INCOMPLETE');
    }

    return this.buildDetail(date, report, true, []);
  }

  private buildDetail(
    date: string,
    report: DatasetHealthReport,
    persisted: boolean,
    acquisitionIssues: readonly NiftyAcquisitionIssue[],
    bucketOverride?: NiftySessionAcquisitionBucket
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

  private alreadyCompleteDetail(date: string): NiftySessionAcquisitionDetail {
    return {
      tradingDate: date,
      bucket: 'ALREADY_COMPLETE',
      healthStatus: null,
      issues: [],
      acquisitionIssues: [],
      sourceRowCount: 0,
      canonicalRowCount: HISTORICAL_SESSION_ROW_COUNT,
      excludedRowCount: 0,
      exclusions: [],
      persisted: false, // not persisted BY THIS RUN -- it was already complete from a prior run
    };
  }

  private unresolvedDetail(date: string): NiftySessionAcquisitionDetail {
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
    };
  }

  private async findAlreadyCompleteDatesInRange(fromDate: string, toDate: string): Promise<Set<string>> {
    const { from, to } = this.istRangeBounds(fromDate, toDate);
    const existing = await this.repository.findRange(NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME, from, to);
    const byDate = this.groupByTradingDate(existing);
    const complete = new Set<string>();
    for (const [date, rows] of byDate) {
      if (isCompleteHistoricalSession(rows)) complete.add(date);
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

  private toUpsertInput(candle: CanonicalHistoricalCandle): HistoricalCandleUpsertInput {
    const data = {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      openInterest: candle.openInterest,
      source: 'REST',
    };
    return {
      create: { instrumentKey: candle.instrumentKey, timeframe: NIFTY_UNDERLYING_TIMEFRAME, candleTime: candle.candleTime, ...data },
      update: data,
    };
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
}
