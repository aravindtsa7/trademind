import { HistoricalAssetType } from '../domain/historical-asset.types';
import { CanonicalHistoricalCandle, HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import { CanonicalSessionDeclaration } from '../domain/canonical-session.types';
import { OptionCandleObservationState, resolveOptionCandleObservationState } from '../domain/historical-option-candle-observation.types';
import {
  HISTORICAL_SESSION_ROW_COUNT,
  isCompleteHistoricalSession,
} from '../../historical-candles/utils/historical-session-completeness.util';
import { HistoricalDataProvider } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
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
import HistoricalOptionCandleLakeRepository, { HistoricalOptionCandleLakeIdentity } from '../repositories/historical-option-candle-lake.repository';
import { GrowwAuthenticationError } from '../providers/groww/groww-historical-client';
import { GROWW_OPTION_CANDLE_MIN_REQUEST_INTERVAL_MS } from '../providers/groww/groww-option-historical-data-provider.service';
import { GROWW_NSE_EXCHANGE, GROWW_NIFTY_UNDERLYING } from '../providers/groww/groww-historical-contract-provider.service';
import { GrowwSymbolKind, parseGrowwSymbol } from '../providers/groww/groww-contract-symbol-parser';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One explicit contract + explicit trading-date set to acquire. Never a full chain, never an implicit/default date range (task section 5/16). */
export interface GrowwOptionCandleAcquisitionRequest {
  readonly providerContractId: string;
  readonly tradingDates: readonly string[];
  readonly dryRun?: boolean;
}

export enum GrowwOptionAcquisitionFailureReason {
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  FETCH_PERMANENT = 'FETCH_PERMANENT',
  FETCH_RETRY_EXHAUSTED = 'FETCH_RETRY_EXHAUSTED',
  POST_PERSIST_RECONCILIATION_FAILED = 'POST_PERSIST_RECONCILIATION_FAILED',
}

export interface GrowwOptionAcquisitionFailedSession {
  readonly tradingDate: string;
  readonly reason: GrowwOptionAcquisitionFailureReason;
  /** Message text only -- never request headers/tokens (see `describeError`). */
  readonly detail: string;
}

export type GrowwOptionSessionBucket =
  | 'ALREADY_COMPLETE'
  | 'NEWLY_COMPLETE'
  | 'OBSERVED_PARTIAL'
  | 'NO_OBSERVED_TRADING'
  | 'INVALID'
  | 'PROVIDER_UNAVAILABLE';

export interface GrowwOptionSessionAcquisitionDetail {
  readonly tradingDate: string;
  readonly bucket: GrowwOptionSessionBucket;
  /** `null` only for `ALREADY_COMPLETE` (no re-fetch/re-validation ran this session) and a fetch-layer `PROVIDER_UNAVAILABLE` (no `DatasetHealthReport` could ever exist -- the fetch itself failed). */
  readonly observationState: OptionCandleObservationState | null;
  readonly providerRowCount: number;
  readonly canonicalRowCount: number;
  readonly excludedRowCount: number;
  readonly rowsWithOi: number;
  readonly rowsWithNullOi: number;
  readonly persisted: boolean;
}

export interface GrowwOptionCandleAcquisitionResult {
  readonly provider: HistoricalProviderId.GROWW;
  readonly providerContractId: string;
  readonly requestedSessions: readonly string[];
  readonly dryRun: boolean;
  readonly requests: number;
  readonly providerRows: number;
  readonly canonicalRows: number;
  readonly excludedRows: number;
  readonly sessions: {
    readonly alreadyComplete: readonly string[];
    readonly newlyComplete: readonly string[];
    readonly observedPartial: readonly string[];
    readonly noObservedTrading: readonly string[];
    readonly invalid: readonly string[];
    readonly providerUnavailable: readonly string[];
  };
  readonly oi: { readonly rowsWithOi: number; readonly rowsWithNullOi: number };
  readonly retries: number;
  readonly rateLimitBackoffs: number;
  readonly failedSessions: readonly GrowwOptionAcquisitionFailedSession[];
  /** `true` once any session in this run hit a 401/403 -- the run stops requesting further sessions immediately when this becomes true (task section 10: "fail clearly", never burn through remaining sessions against a known-bad token). */
  readonly authenticationFailed: boolean;
  readonly sessionDetails: readonly GrowwOptionSessionAcquisitionDetail[];
}

export interface GrowwOptionCandleAcquisitionServiceDependencies {
  readonly provider: HistoricalDataProvider;
  readonly projector?: CanonicalSessionProjectorService;
  readonly validator?: DatasetHealthValidatorService;
  readonly repository?: HistoricalOptionCandleLakeRepository;
  readonly rateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
}

const BUCKET_TO_SESSIONS_KEY: Record<GrowwOptionSessionBucket, keyof GrowwOptionCandleAcquisitionResult['sessions']> = {
  ALREADY_COMPLETE: 'alreadyComplete',
  NEWLY_COMPLETE: 'newlyComplete',
  OBSERVED_PARTIAL: 'observedPartial',
  NO_OBSERVED_TRADING: 'noObservedTrading',
  INVALID: 'invalid',
  PROVIDER_UNAVAILABLE: 'providerUnavailable',
};

/**
 * B-F4 orchestrator: acquires, canonicalizes, validates, persists, resumes,
 * and reports on ONE Groww NIFTY option contract's 1-minute candles across
 * an explicit, caller-supplied set of trading dates. Deliberately mirrors
 * `NiftyUnderlyingAcquisitionService`'s architecture (resume-before-fetch,
 * persist-only-on-healthy, re-read-and-reconcile-after-write) but diverges
 * where option semantics genuinely differ (task section 8):
 *
 *   - A session with ZERO observed candles is NOT a failure
 *     (`NO_OBSERVED_TRADING`, not `PROVIDER_UNAVAILABLE`) -- illiquid/
 *     not-yet-listed/already-quiet strikes legitimately do not trade every
 *     minute of every pre-expiry session.
 *   - A `PARTIAL_OBSERVED_SESSION` (some but not all 375 minutes) is still
 *     persisted -- it is genuine observed research data -- but is NEVER
 *     reported/bucketed as complete/`SESSION_COVERED`.
 *
 * Never fetches a full option chain or an implicit/default date range
 * (task section 5/16): `providerContractId` and `tradingDates` are always
 * caller-supplied and explicit.
 */
export default class GrowwOptionCandleAcquisitionService {
  private readonly provider: HistoricalDataProvider;
  private readonly projector: CanonicalSessionProjectorService;
  private readonly validator: DatasetHealthValidatorService;
  private readonly repository: HistoricalOptionCandleLakeRepository;
  private readonly rateLimiter: HistoricalProviderRateLimiterService;
  private readonly retryOptions: HistoricalProviderRetryOptions;

  constructor(dependencies: GrowwOptionCandleAcquisitionServiceDependencies) {
    this.provider = dependencies.provider;
    this.projector = dependencies.projector ?? new CanonicalSessionProjectorService();
    this.validator = dependencies.validator ?? new DatasetHealthValidatorService();
    this.repository = dependencies.repository ?? new HistoricalOptionCandleLakeRepository();
    this.rateLimiter = dependencies.rateLimiter ?? new HistoricalProviderRateLimiterService(GROWW_OPTION_CANDLE_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
  }

  async acquire(request: GrowwOptionCandleAcquisitionRequest): Promise<GrowwOptionCandleAcquisitionResult> {
    if (request.tradingDates.length === 0) {
      throw new Error('GrowwOptionCandleAcquisitionService requires at least one explicit tradingDate; it never defaults to a bulk/full-chain range (task section 5/16).');
    }
    const uniqueSortedDates = [...new Set(request.tradingDates)].sort();
    for (const date of uniqueSortedDates) this.assertValidDate(date);

    const identity = this.parseIdentity(request.providerContractId);
    const dryRun = request.dryRun === true;
    const stats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };

    let requests = 0;
    let providerRows = 0;
    let canonicalRows = 0;
    let excludedRows = 0;
    let rowsWithOi = 0;
    let rowsWithNullOi = 0;
    let authenticationFailed = false;
    const failedSessions: GrowwOptionAcquisitionFailedSession[] = [];
    const sessionDetails: GrowwOptionSessionAcquisitionDetail[] = [];
    const sessions = {
      alreadyComplete: [] as string[],
      newlyComplete: [] as string[],
      observedPartial: [] as string[],
      noObservedTrading: [] as string[],
      invalid: [] as string[],
      providerUnavailable: [] as string[],
    };
    const pushBucket = (bucket: GrowwOptionSessionBucket, date: string): void => {
      sessions[BUCKET_TO_SESSIONS_KEY[bucket]].push(date);
    };

    for (const tradingDate of uniqueSortedDates) {
      if (authenticationFailed) break;

      const { from, to } = this.dayBounds(tradingDate);
      // eslint-disable-next-line no-await-in-loop -- one session's fetch/persist must complete before the next begins, matching NiftyUnderlyingAcquisitionService
      const existing = await this.repository.findRange(request.providerContractId, '1minute', from, to);
      if (isCompleteHistoricalSession(existing)) {
        pushBucket('ALREADY_COMPLETE', tradingDate);
        sessionDetails.push(this.detail(tradingDate, 'ALREADY_COMPLETE', null, 0, existing.length, 0, 0, 0, false));
        continue;
      }

      let rawRows: readonly HistoricalSourceCandleRow[];
      requests += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        rawRows = await withHistoricalProviderRetry(
          () =>
            this.rateLimiter.schedule(() =>
              this.provider.fetchExpiredOptionRange({
                assetType: HistoricalAssetType.NIFTY_OPTION,
                instrumentKey: request.providerContractId,
                interval: '1minute',
                fromTradingDate: tradingDate,
                toTradingDate: tradingDate,
              })
            ),
          stats,
          this.retryOptions
        );
      } catch (error) {
        const isAuth = this.isAuthenticationFailure(error);
        if (isAuth) authenticationFailed = true;
        const reason = isAuth
          ? GrowwOptionAcquisitionFailureReason.AUTHENTICATION_FAILED
          : error instanceof HistoricalProviderRetryExhaustedError
            ? GrowwOptionAcquisitionFailureReason.FETCH_RETRY_EXHAUSTED
            : GrowwOptionAcquisitionFailureReason.FETCH_PERMANENT;
        failedSessions.push({ tradingDate, reason, detail: this.describeError(error) });
        pushBucket('PROVIDER_UNAVAILABLE', tradingDate);
        sessionDetails.push(this.detail(tradingDate, 'PROVIDER_UNAVAILABLE', null, 0, 0, 0, 0, 0, false));
        continue;
      }
      providerRows += rawRows.length;

      const projection = this.projector.project({
        assetType: HistoricalAssetType.NIFTY_OPTION,
        instrumentKey: request.providerContractId,
        tradingDate,
        sessionDeclaration: CanonicalSessionDeclaration.NORMAL_NIFTY_SESSION,
        sourceRows: rawRows,
      });
      const report = this.validator.validate(projection);
      const observationState = resolveOptionCandleObservationState(report);
      const sessionOi = this.countOi(projection.acceptedRows);
      rowsWithOi += sessionOi.withOi;
      rowsWithNullOi += sessionOi.withNullOi;
      canonicalRows += projection.acceptedRows.length;
      excludedRows += projection.excludedRows.length;

      let bucket = this.mapObservationStateToBucket(observationState);
      let persisted = false;
      const shouldPersist =
        !dryRun &&
        (observationState === OptionCandleObservationState.COMPLETE_SESSION ||
          observationState === OptionCandleObservationState.PARTIAL_OBSERVED_SESSION);

      if (shouldPersist) {
        // eslint-disable-next-line no-await-in-loop
        await this.repository.upsertCandles(identity, '1minute', projection.acceptedRows);
        // eslint-disable-next-line no-await-in-loop
        const reread = await this.repository.findRange(request.providerContractId, '1minute', from, to);
        if (observationState === OptionCandleObservationState.COMPLETE_SESSION && !isCompleteHistoricalSession(reread)) {
          failedSessions.push({
            tradingDate,
            reason: GrowwOptionAcquisitionFailureReason.POST_PERSIST_RECONCILIATION_FAILED,
            detail: `Post-persist reconciliation read for ${tradingDate} found ${reread.length} row(s), not the expected ${HISTORICAL_SESSION_ROW_COUNT}-row complete session.`,
          });
          bucket = 'INVALID';
        } else {
          persisted = true;
        }
      }

      pushBucket(bucket, tradingDate);
      sessionDetails.push(
        this.detail(tradingDate, bucket, observationState, rawRows.length, projection.acceptedRows.length, projection.excludedRows.length, sessionOi.withOi, sessionOi.withNullOi, persisted)
      );
    }

    return {
      provider: HistoricalProviderId.GROWW,
      providerContractId: request.providerContractId,
      requestedSessions: uniqueSortedDates,
      dryRun,
      requests,
      providerRows,
      canonicalRows,
      excludedRows,
      sessions,
      oi: { rowsWithOi, rowsWithNullOi },
      retries: stats.retryCount,
      rateLimitBackoffs: stats.rateLimitBackoffCount,
      failedSessions,
      authenticationFailed,
      sessionDetails,
    };
  }

  private parseIdentity(providerContractId: string): HistoricalOptionCandleLakeIdentity {
    const parsed = parseGrowwSymbol(providerContractId, { exchange: GROWW_NSE_EXCHANGE, underlyingSymbol: GROWW_NIFTY_UNDERLYING });
    if (!parsed.ok) {
      throw new Error(`GrowwOptionCandleAcquisitionService requires a valid NSE NIFTY Groww option symbol; '${providerContractId}' failed to parse: ${parsed.failure.reason} (${parsed.failure.detail}).`);
    }
    if (parsed.value.kind !== GrowwSymbolKind.OPTION) {
      throw new Error(`GrowwOptionCandleAcquisitionService requires an OPTION symbol; '${providerContractId}' parsed as a FUTURE.`);
    }
    return {
      providerContractId,
      optionType: parsed.value.optionType,
      strikePrice: parsed.value.strikePrice,
      expiry: parsed.value.expiry,
    };
  }

  private mapObservationStateToBucket(state: OptionCandleObservationState): GrowwOptionSessionBucket {
    switch (state) {
      case OptionCandleObservationState.NO_OBSERVED_TRADING:
        return 'NO_OBSERVED_TRADING';
      case OptionCandleObservationState.PARTIAL_OBSERVED_SESSION:
        return 'OBSERVED_PARTIAL';
      case OptionCandleObservationState.COMPLETE_SESSION:
        return 'NEWLY_COMPLETE';
      case OptionCandleObservationState.INVALID:
        return 'INVALID';
      case OptionCandleObservationState.PROVIDER_UNAVAILABLE:
        // Unreachable: `resolveOptionCandleObservationState` never returns
        // this member -- a fetch failure is caught and bucketed before a
        // `DatasetHealthReport` can even exist. Folded here defensively
        // rather than silently mismapped.
        return 'PROVIDER_UNAVAILABLE';
      default: {
        const exhaustive: never = state;
        throw new Error(`Unhandled OptionCandleObservationState: ${String(exhaustive)}`);
      }
    }
  }

  private countOi(rows: readonly CanonicalHistoricalCandle[]): { withOi: number; withNullOi: number } {
    let withOi = 0;
    let withNullOi = 0;
    for (const row of rows) {
      if (row.openInterest === null) withNullOi += 1;
      else withOi += 1;
    }
    return { withOi, withNullOi };
  }

  /** True for a `GrowwAuthenticationError` thrown directly by the client, or wrapped as `HistoricalProviderPermanentError.cause` by the shared retry wrapper. */
  private isAuthenticationFailure(error: unknown): boolean {
    if (error instanceof GrowwAuthenticationError) return true;
    return error instanceof HistoricalProviderPermanentError && error.cause instanceof GrowwAuthenticationError;
  }

  /** Only ever reads `.message` -- never `.config` (where request headers/tokens live) -- matching `NiftyUnderlyingAcquisitionService.describeError`. */
  private describeError(error: unknown): string {
    if (error instanceof HistoricalProviderPermanentError || error instanceof HistoricalProviderRetryExhaustedError) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private detail(
    tradingDate: string,
    bucket: GrowwOptionSessionBucket,
    observationState: OptionCandleObservationState | null,
    providerRowCount: number,
    canonicalRowCount: number,
    excludedRowCount: number,
    rowsWithOi: number,
    rowsWithNullOi: number,
    persisted: boolean
  ): GrowwOptionSessionAcquisitionDetail {
    return { tradingDate, bucket, observationState, providerRowCount, canonicalRowCount, excludedRowCount, rowsWithOi, rowsWithNullOi, persisted };
  }

  private dayBounds(tradingDate: string): { from: Date; to: Date } {
    return { from: new Date(`${tradingDate}T00:00:00+05:30`), to: new Date(`${tradingDate}T23:59:59.999+05:30`) };
  }

  private assertValidDate(value: string): void {
    if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`GrowwOptionCandleAcquisitionService requires every tradingDate to be a valid YYYY-MM-DD date; received '${value}'.`);
    }
  }
}
