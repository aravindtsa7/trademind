/**
 * Known historical data provider identities. An identifier only -- no
 * provider-specific behavior is encoded in research-lake domain logic
 * anywhere in this module; provider differences are expressed exclusively
 * through `HistoricalProviderCapability` data.
 */
export enum HistoricalProviderId {
  UPSTOX = 'UPSTOX',
  GROWW = 'GROWW',
  DHAN = 'DHAN',
}

/**
 * Provider-specific request-rate policy identifier plus optional structured
 * limits. `policyId` is the primary machine-readable contract (e.g. for
 * later rate-limiter wiring in a follow-up phase); the numeric fields are
 * best-effort supplementary detail a provider may or may not document.
 */
export interface HistoricalProviderRateLimitPolicy {
  readonly policyId: string;
  readonly maxRequestsPerMinute?: number;
  readonly maxRequestsPerDay?: number;
}

/**
 * A calendar date only (`YYYY-MM-DD`), with no time-of-day/timezone
 * component -- matches the plain-string `tradingDate` convention already
 * used elsewhere in this module (`CanonicalSessionProjectionRequest.tradingDate`
 * etc.), and sidesteps any ambiguity a `Date` instance would carry (midnight
 * in which timezone?) for a value that only ever means "documented as of
 * this day".
 */
export type HistoricalCapabilityStartDate = string;

/**
 * Declarative capability/metadata surface for one historical provider.
 * Every field here models a real, documented difference between providers
 * this system may integrate with (Upstox today; Groww/Dhan later) so that
 * later acquisition/rate-limiting code can branch on data, not on
 * `providerId` equality checks scattered through domain logic.
 *
 * The three `earliestDocumented*` fields are deliberately separate: a
 * provider's underlying-index history, its option-contract discovery
 * horizon, and its option-candle history horizon are independent facts that
 * can (and in practice do) start on different dates. Collapsing them into
 * one field would silently lose that distinction. `supportsOptionContractDiscovery`
 * / `supportsOptionCandleAcquisition` are a separate concept from these
 * horizons: a provider can support an operation in general while still
 * documenting how far back it actually goes (or not documenting it at all,
 * `null`). No provider populates these in B-F1 -- the type only needs to be
 * capable of expressing them now.
 */
export interface HistoricalProviderCapability {
  readonly providerId: HistoricalProviderId;
  /** Earliest underlying (index) candle history this provider documents, or `null` if undocumented/unknown. */
  readonly earliestDocumentedUnderlyingHistory: HistoricalCapabilityStartDate | null;
  /** Earliest date this provider documents option-contract (expiry/strike) discovery going back to, or `null`. */
  readonly earliestDocumentedOptionDiscovery: HistoricalCapabilityStartDate | null;
  /** Earliest date this provider documents option-candle history going back to, or `null`. */
  readonly earliestDocumentedOptionCandleHistory: HistoricalCapabilityStartDate | null;
  readonly supportsOptionContractDiscovery: boolean;
  readonly supportsOptionCandleAcquisition: boolean;
  /** e.g. '1minute', '1day' -- matches the existing plain-string timeframe convention. */
  readonly supportedIntervals: readonly string[];
  /** Maximum date span a single request may cover, in days, or `null` if unbounded/undocumented. */
  readonly maximumRequestDateSpanDays: number | null;
  readonly contractMetadataIncludesLotSize: boolean;
  readonly historicalListingStartDateKnown: boolean;
  readonly rateLimitPolicy: HistoricalProviderRateLimitPolicy;
}
