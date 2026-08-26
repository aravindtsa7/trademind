import { DiscoveredOptionContractCandidate, resolveCatalogMetadataState } from '../domain/historical-option-contract-catalog.types';
import { HistoricalContractState } from '../domain/historical-option-identity.types';
import HistoricalOptionContractCatalogRepository, {
  HistoricalOptionContractCatalogUpsertResult,
} from '../repositories/historical-option-contract-catalog.repository';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import GrowwHistoricalContractProviderService, {
  GROWW_NIFTY_UNDERLYING,
  GROWW_NSE_EXCHANGE,
} from '../providers/groww/groww-historical-contract-provider.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import {
  HistoricalProviderPermanentError,
  HistoricalProviderRetryExhaustedError,
  HistoricalProviderRetryOptions,
  HistoricalProviderRetryStats,
  withHistoricalProviderRetry,
} from './historical-provider-retry.util';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Groww's Backtesting rate-limit bucket for this endpoint is not clearly documented; this is a deliberately conservative research default (task section 11), not an authoritative Groww-published limit. */
const GROWW_HISTORICAL_MIN_REQUEST_INTERVAL_MS = 1_000;
/** Bounded sample retained in the result so a run with many malformed symbols cannot grow the result unboundedly; `malformedContracts` is always the true total. */
const MALFORMED_SYMBOL_SAMPLE_LIMIT = 25;

export interface NiftyContractCatalogAcquisitionRequest {
  /** Required. Never implicitly defaulted -- callers must state the range explicitly (task section 9/13). */
  readonly toDate: string;
  /** Optional; defaults to the provider's documented `earliestDocumentedOptionDiscovery` capability (2020-01-01). */
  readonly fromDate?: string;
  /** When true: fetches/parses from Groww exactly as normal, but never writes to the database. */
  readonly dryRun?: boolean;
}

export interface NiftyContractCatalogExpiryDetail {
  readonly expiry: string;
  readonly contractSymbolsReceived: number;
  readonly parsedOptionContracts: number;
  readonly ignoredFutures: number;
  readonly malformedContracts: number;
  readonly duplicateContracts: number;
  readonly newlyDiscovered: number;
  readonly enriched: number;
  readonly alreadyKnown: number;
  readonly failed: boolean;
  readonly failureReason: string | null;
}

export interface NiftyContractCatalogAcquisitionResult {
  readonly provider: HistoricalProviderId;
  readonly underlyingSymbol: string;
  readonly exchange: string;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly dryRun: boolean;

  readonly expiryRequests: number;
  readonly expiriesReceived: number;
  readonly expiriesAccepted: number;

  readonly contractRequests: number;
  readonly contractSymbolsReceived: number;

  readonly parsedOptionContracts: number;
  readonly ignoredFutures: number;
  readonly malformedContracts: number;
  readonly duplicateContracts: number;

  readonly metadataComplete: number;
  readonly metadataIncomplete: number;

  readonly alreadyKnown: number;
  readonly newlyDiscovered: number;
  readonly enriched: number;

  readonly retryCount: number;
  readonly rateLimitBackoffCount: number;

  /** Year-level expiry-discovery failures (e.g. an auth/scope failure that prevented ANY expiry for that year from being seen at all) -- distinct from `failedExpiries`, which requires a resolved expiry identity. */
  readonly failedExpiryYears: readonly { readonly year: number; readonly reason: string }[];
  readonly failedExpiries: readonly { readonly expiry: string; readonly reason: string }[];
  readonly malformedSymbolSamples: readonly { readonly rawSymbol: string; readonly reason: string; readonly detail: string }[];
  readonly expiryDetails: readonly NiftyContractCatalogExpiryDetail[];
}

export interface NiftyContractCatalogAcquisitionServiceDependencies {
  readonly adapter?: GrowwHistoricalContractProviderService;
  readonly repository?: HistoricalOptionContractCatalogRepository;
  readonly rateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
}

/**
 * NIFTY-specific (not generic multi-underlying) B-F3 orchestrator:
 * discovers, strictly parses, and idempotently persists a point-in-time
 * NSE NIFTY historical option-contract catalog via Groww. Discovery only
 * -- no option candle acquisition (B-F4).
 *
 * Reuses, never reimplements: `HistoricalProviderRateLimiterService` /
 * `withHistoricalProviderRetry` (the exact B-F2 primitives -- ONE shared
 * limiter instance governs every Groww request this service makes,
 * including every retry attempt), `GrowwHistoricalContractProviderService`
 * for discovery+parsing, and
 * `HistoricalOptionContractCatalogRepository.upsertMany` for idempotent,
 * evidence-preserving persistence.
 */
export default class NiftyHistoricalContractCatalogAcquisitionService {
  private readonly adapter: GrowwHistoricalContractProviderService;
  private readonly repository: HistoricalOptionContractCatalogRepository;
  private readonly rateLimiter: HistoricalProviderRateLimiterService;
  private readonly retryOptions: HistoricalProviderRetryOptions;

  constructor(dependencies: NiftyContractCatalogAcquisitionServiceDependencies = {}) {
    this.adapter = dependencies.adapter ?? new GrowwHistoricalContractProviderService();
    this.repository = dependencies.repository ?? new HistoricalOptionContractCatalogRepository();
    this.rateLimiter = dependencies.rateLimiter ?? new HistoricalProviderRateLimiterService(GROWW_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
  }

  async acquire(request: NiftyContractCatalogAcquisitionRequest): Promise<NiftyContractCatalogAcquisitionResult> {
    this.assertValidDate('toDate', request.toDate);
    const capability = this.adapter.getCapability();
    const fromDate = request.fromDate ?? capability.earliestDocumentedOptionDiscovery ?? undefined;
    if (!fromDate) {
      throw new Error('NiftyHistoricalContractCatalogAcquisitionService requires an explicit fromDate: the provider does not document a default earliestDocumentedOptionDiscovery.');
    }
    this.assertValidDate('fromDate', fromDate);
    if (fromDate > request.toDate) {
      throw new Error(`fromDate (${fromDate}) must not be after toDate (${request.toDate}).`);
    }
    const dryRun = request.dryRun === true;

    const stats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };
    let expiryRequests = 0;
    let expiriesReceivedRaw: string[] = [];
    const fromYear = Number(fromDate.slice(0, 4));
    const toYear = Number(request.toDate.slice(0, 4));
    const failedExpiryYears: Array<{ year: number; reason: string }> = [];

    for (let year = fromYear; year <= toYear; year += 1) {
      expiryRequests += 1;
      try {
        const yearExpiries = await this.rateLimiter.schedule(() =>
          withHistoricalProviderRetry(() => this.adapter.discoverExpiriesForYearMonth(year), stats, this.retryOptions)
        );
        expiriesReceivedRaw = expiriesReceivedRaw.concat(yearExpiries);
      } catch (error) {
        // A failed YEAR-level expiry request yields no expiries for that
        // year -- other years are unaffected -- but the failure itself
        // must never be silently indistinguishable from "Groww genuinely
        // returned zero expiries" (confirmed live: a 403/authentication
        // failure here previously vanished into expiriesReceived=0 with no
        // trace anywhere in the result). Recorded here, separately from
        // the per-expiry `failedExpiries` below (which requires a resolved
        // expiry identity a failed year-level request never reaches).
        failedExpiryYears.push({ year, reason: this.describeError(error) });
      }
    }

    const acceptedExpiries = this.dedupeValidateAndFilterExpiries(expiriesReceivedRaw, fromDate, request.toDate);

    let contractRequests = 0;
    let contractSymbolsReceived = 0;
    let parsedOptionContracts = 0;
    let ignoredFutures = 0;
    let malformedContracts = 0;
    let duplicateContracts = 0;
    let metadataComplete = 0;
    let metadataIncomplete = 0;
    let alreadyKnown = 0;
    let newlyDiscovered = 0;
    let enriched = 0;
    const failedExpiries: Array<{ expiry: string; reason: string }> = [];
    const malformedSymbolSamples: Array<{ rawSymbol: string; reason: string; detail: string }> = [];
    const expiryDetails: NiftyContractCatalogExpiryDetail[] = [];

    for (const expiry of acceptedExpiries) {
      contractRequests += 1;
      let outcome:
        | { readonly candidates: readonly DiscoveredOptionContractCandidate[]; readonly ignoredFutureSymbols: readonly string[]; readonly malformedSymbols: readonly { rawSymbol: string; reason: string; detail: string }[] }
        | null = null;
      try {
        outcome = await this.rateLimiter.schedule(() =>
          withHistoricalProviderRetry(() => this.adapter.discoverContractsForExpiry(expiry), stats, this.retryOptions)
        );
      } catch (error) {
        const reason = this.describeError(error);
        failedExpiries.push({ expiry, reason });
        expiryDetails.push({
          expiry,
          contractSymbolsReceived: 0,
          parsedOptionContracts: 0,
          ignoredFutures: 0,
          malformedContracts: 0,
          duplicateContracts: 0,
          newlyDiscovered: 0,
          enriched: 0,
          alreadyKnown: 0,
          failed: true,
          failureReason: reason,
        });
        continue; // one bad expiry must not corrupt other successful expiries
      }

      const receivedCount = outcome.candidates.length + outcome.ignoredFutureSymbols.length + outcome.malformedSymbols.length;
      contractSymbolsReceived += receivedCount;
      ignoredFutures += outcome.ignoredFutureSymbols.length;
      malformedContracts += outcome.malformedSymbols.length;
      for (const malformed of outcome.malformedSymbols) {
        if (malformedSymbolSamples.length < MALFORMED_SYMBOL_SAMPLE_LIMIT) malformedSymbolSamples.push(malformed);
      }

      const { deduped, duplicateCount } = this.dedupeCandidates(outcome.candidates);
      duplicateContracts += duplicateCount;
      parsedOptionContracts += deduped.length;

      let expiryNewlyDiscovered = 0;
      let expiryEnriched = 0;
      let expiryAlreadyKnown = 0;

      if (deduped.length > 0) {
        let upsertResults: readonly HistoricalOptionContractCatalogUpsertResult[];
        if (dryRun) {
          upsertResults = deduped.map((candidate) => ({
            providerContractId: candidate.providerContractId,
            outcome: 'INSERTED' as const, // dry-run "would discover" projection -- see NiftyContractCatalogAcquisitionResult.dryRun for the caller-visible distinction
            metadataState: this.projectMetadataStateOnly(candidate),
          } satisfies HistoricalOptionContractCatalogUpsertResult));
        } else {
          upsertResults = await this.repository.upsertMany(deduped);
        }

        for (const result of upsertResults) {
          if (result.metadataState === HistoricalContractState.CATALOG_KNOWN) metadataComplete += 1;
          else metadataIncomplete += 1;
          if (result.outcome === 'INSERTED') { newlyDiscovered += 1; expiryNewlyDiscovered += 1; }
          else if (result.outcome === 'ENRICHED') { enriched += 1; expiryEnriched += 1; }
          else { alreadyKnown += 1; expiryAlreadyKnown += 1; }
        }
      }

      expiryDetails.push({
        expiry,
        contractSymbolsReceived: receivedCount,
        parsedOptionContracts: deduped.length,
        ignoredFutures: outcome.ignoredFutureSymbols.length,
        malformedContracts: outcome.malformedSymbols.length,
        duplicateContracts: duplicateCount,
        newlyDiscovered: expiryNewlyDiscovered,
        enriched: expiryEnriched,
        alreadyKnown: expiryAlreadyKnown,
        failed: false,
        failureReason: null,
      });
    }

    return {
      provider: HistoricalProviderId.GROWW,
      underlyingSymbol: GROWW_NIFTY_UNDERLYING,
      exchange: GROWW_NSE_EXCHANGE,
      requestedStartDate: fromDate,
      requestedEndDate: request.toDate,
      dryRun,
      expiryRequests,
      expiriesReceived: expiriesReceivedRaw.length,
      expiriesAccepted: acceptedExpiries.length,
      contractRequests,
      contractSymbolsReceived,
      parsedOptionContracts,
      ignoredFutures,
      malformedContracts,
      duplicateContracts,
      metadataComplete,
      metadataIncomplete,
      alreadyKnown,
      newlyDiscovered,
      enriched,
      retryCount: stats.retryCount,
      rateLimitBackoffCount: stats.rateLimitBackoffCount,
      failedExpiryYears,
      failedExpiries,
      malformedSymbolSamples,
      expiryDetails,
    };
  }

  /** Deduplicates, validates YYYY-MM-DD format, and range-filters raw expiry strings -- deterministic ascending output (task section 9). */
  private dedupeValidateAndFilterExpiries(raw: readonly string[], fromDate: string, toDate: string): string[] {
    const unique = new Set<string>();
    for (const value of raw) {
      if (DATE_PATTERN.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
        unique.add(value);
      }
    }
    return [...unique].filter((date) => date >= fromDate && date <= toDate).sort();
  }

  /**
   * Deduplicates by `providerContractId` within one run's discovery
   * (task section 9: "duplicate provider results must not create
   * duplicate catalog rows"), then sorts deterministically: expiry
   * ascending, strike ascending, optionType (CE before PE), then
   * providerContractId as the final tie-break.
   */
  private dedupeCandidates(candidates: readonly DiscoveredOptionContractCandidate[]): { deduped: DiscoveredOptionContractCandidate[]; duplicateCount: number } {
    const seen = new Map<string, DiscoveredOptionContractCandidate>();
    let duplicateCount = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.providerContractId)) {
        duplicateCount += 1;
        continue;
      }
      seen.set(candidate.providerContractId, candidate);
    }
    const deduped = [...seen.values()].sort((left, right) => {
      const expiryDiff = left.expiry.getTime() - right.expiry.getTime();
      if (expiryDiff !== 0) return expiryDiff;
      const strikeDiff = left.strikePrice - right.strikePrice;
      if (strikeDiff !== 0) return strikeDiff;
      const optionTypeDiff = left.optionType.localeCompare(right.optionType);
      if (optionTypeDiff !== 0) return optionTypeDiff;
      return left.providerContractId.localeCompare(right.providerContractId);
    });
    return { deduped, duplicateCount };
  }

  /** Dry-run projection of metadataState without touching the database (never calls the repository). Delegates to the same B-F1-backed resolver the repository itself uses, so dry-run and real-run classification can never drift apart. */
  private projectMetadataStateOnly(
    candidate: DiscoveredOptionContractCandidate
  ): HistoricalContractState.CATALOG_KNOWN | HistoricalContractState.METADATA_INCOMPLETE {
    return resolveCatalogMetadataState(candidate);
  }

  private assertValidDate(field: string, value: string): void {
    if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`NiftyHistoricalContractCatalogAcquisitionService requires ${field} to be a valid YYYY-MM-DD date; received '${value}'.`);
    }
  }

  /** Only ever reads `.message` (never `.config`, where a bearer token would live) -- mirrors the B-F2 orchestrator's `describeError`. Prefers a GrowwAuthenticationError's specific reason when the shared retry wrapper wrapped one. */
  private describeError(error: unknown): string {
    if (error instanceof HistoricalProviderPermanentError || error instanceof HistoricalProviderRetryExhaustedError) {
      if (error.cause instanceof Error) return error.cause.message;
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
