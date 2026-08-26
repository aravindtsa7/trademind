import { HistoricalOptionContractIdentity } from '../../domain/historical-option-identity.types';
import { DiscoveredOptionContractCandidate } from '../../domain/historical-option-contract-catalog.types';
import {
  HistoricalContractDiscoveryRequest,
  HistoricalContractProvider,
  HistoricalExpiryDiscoveryRequest,
} from '../../interfaces/historical-contract-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import GrowwHistoricalClient from './groww-historical-client';
import { GrowwSymbolKind, parseGrowwSymbol } from './groww-contract-symbol-parser';

/** Groww's Backtesting API documentation states FNO historical/backtesting data is available from this date. Capability metadata only -- NOT a guarantee every individual date is actually available (task section 4). */
export const GROWW_OPTION_DISCOVERY_START_DATE = '2020-01-01';

export const GROWW_NSE_EXCHANGE = 'NSE';
export const GROWW_NIFTY_UNDERLYING = 'NIFTY';

export interface GrowwContractDiscoveryOutcome {
  readonly candidates: readonly DiscoveredOptionContractCandidate[];
  /** Symbols that parsed as a 4-segment `...-FUT` contract -- explicitly NOT treated as options, never silently dropped from observability. */
  readonly ignoredFutureSymbols: readonly string[];
  /** Symbols that failed strict parsing, with their typed reason -- retained as evidence, never coerced. */
  readonly malformedSymbols: readonly { readonly rawSymbol: string; readonly reason: string; readonly detail: string }[];
}

/**
 * B-F1 `HistoricalContractProvider` implementation for Groww, scoped to
 * NSE NIFTY option contract DISCOVERY only (no candle acquisition -- that
 * is B-F4). Wraps `GrowwHistoricalClient`, never reimplements its HTTP
 * logic.
 *
 * Implements the generic B-F1 interface faithfully (`discoverExpiries` /
 * `discoverContracts`) for future/compatibility use, but the B-F3
 * orchestrator itself uses the richer `discoverContractsForExpiry` below --
 * B-F1's `discoverContracts` return type
 * (`HistoricalOptionContractIdentity[]`) cannot truthfully represent a
 * partially-discovered contract (nullable tradingSymbol/lotSize/tickSize),
 * so forcing Groww's real discovery data through it would either fabricate
 * a tradingSymbol or silently drop partial-metadata contracts. See
 * `historical-option-contract-catalog.types.ts` for why a separate shape
 * is required, per task section 2/6.
 */
export default class GrowwHistoricalContractProviderService implements HistoricalContractProvider {
  readonly providerId = HistoricalProviderId.GROWW;

  constructor(private readonly client: GrowwHistoricalClient = new GrowwHistoricalClient()) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.GROWW,
      earliestDocumentedUnderlyingHistory: null, // this adapter is option-discovery-only; underlying history is Upstox's domain (B-F2)
      earliestDocumentedOptionDiscovery: GROWW_OPTION_DISCOVERY_START_DATE,
      earliestDocumentedOptionCandleHistory: null, // B-F3 does not implement option candle acquisition
      supportsOptionContractDiscovery: true,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: [],
      maximumRequestDateSpanDays: null, // Groww's expiries/contracts endpoints are expiry/year-scoped, not date-range-scoped
      contractMetadataIncludesLotSize: false, // not proven true in general -- see getCapability doc in historical-provider-capability.types.ts; per-contract truth lives in DiscoveredOptionContractCandidate.lotSize
      historicalListingStartDateKnown: false, // discovery never proves a listing/first-tradable date (task section 12)
      rateLimitPolicy: { policyId: 'GROWW_HISTORICAL_CONSERVATIVE_DEFAULT', maxRequestsPerMinute: 60 },
    };
  }

  /**
   * B-F1 interface method: expiries "as of" one date. Interpreted as "the
   * expiries Groww's catalog reports for that date's calendar year" --
   * this method does not itself claim any stronger point-in-time
   * guarantee. Not used by the B-F3 bulk orchestrator (see
   * `discoverExpiriesForYear` below); kept for interface compliance and
   * future single-date callers.
   */
  async discoverExpiries(request: HistoricalExpiryDiscoveryRequest): Promise<readonly Date[]> {
    if (request.underlyingKey !== GROWW_NIFTY_UNDERLYING) {
      throw new Error(`GrowwHistoricalContractProviderService only supports underlyingKey='${GROWW_NIFTY_UNDERLYING}'; received '${request.underlyingKey}'.`);
    }
    const year = Number(request.asOfTradingDate.slice(0, 4));
    const raw = await this.client.fetchExpiries({ exchange: GROWW_NSE_EXCHANGE, underlyingSymbol: GROWW_NIFTY_UNDERLYING, year });
    return raw
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .map((value) => new Date(`${value}T00:00:00+05:30`))
      .filter((date) => !Number.isNaN(date.getTime()));
  }

  /**
   * B-F1 interface method: best-effort mapping down into
   * `HistoricalOptionContractIdentity[]` (empty-string tradingSymbol when
   * unproven, exactly like `resolveCatalogMetadataState`'s translation).
   * The B-F3 orchestrator uses `discoverContractsForExpiry` instead, which
   * preserves the full discovery shape.
   */
  async discoverContracts(request: HistoricalContractDiscoveryRequest): Promise<readonly HistoricalOptionContractIdentity[]> {
    if (request.underlyingKey !== GROWW_NIFTY_UNDERLYING) {
      throw new Error(`GrowwHistoricalContractProviderService only supports underlyingKey='${GROWW_NIFTY_UNDERLYING}'; received '${request.underlyingKey}'.`);
    }
    const expiryDate = this.formatIsoDate(request.expiry);
    const outcome = await this.discoverContractsForExpiry(expiryDate);
    return outcome.candidates.map((candidate) => ({
      instrumentKey: candidate.providerContractId,
      tradingSymbol: candidate.exchangeTradingSymbol ?? '',
      underlyingKey: candidate.underlyingSymbol,
      expiry: candidate.expiry,
      strikePrice: candidate.strikePrice,
      optionType: candidate.optionType,
      lotSize: candidate.lotSize,
      tickSize: candidate.tickSize,
    }));
  }

  /** Raw expiry-date strings for one calendar year (optionally one month), exactly as Groww returned them -- NOT deduplicated/validated/range-filtered. That is the orchestrator's job (task section 9). */
  async discoverExpiriesForYearMonth(year: number, month?: number): Promise<readonly string[]> {
    return this.client.fetchExpiries({ exchange: GROWW_NSE_EXCHANGE, underlyingSymbol: GROWW_NIFTY_UNDERLYING, year, month });
  }

  /**
   * Fetches and strictly parses every contract Groww returns for one
   * expiry date. Options are converted to `DiscoveredOptionContractCandidate`;
   * futures and malformed symbols are separated out, never silently
   * dropped or coerced into an option shape.
   */
  async discoverContractsForExpiry(expiryDate: string): Promise<GrowwContractDiscoveryOutcome> {
    const rows = await this.client.fetchContracts({ exchange: GROWW_NSE_EXCHANGE, underlyingSymbol: GROWW_NIFTY_UNDERLYING, expiryDate });
    const discoveredAt = new Date();

    const candidates: DiscoveredOptionContractCandidate[] = [];
    const ignoredFutureSymbols: string[] = [];
    const malformedSymbols: Array<{ rawSymbol: string; reason: string; detail: string }> = [];

    for (const rawSymbol of rows) {
      const parsed = parseGrowwSymbol(rawSymbol, { exchange: GROWW_NSE_EXCHANGE, underlyingSymbol: GROWW_NIFTY_UNDERLYING });
      if (!parsed.ok) {
        malformedSymbols.push({ rawSymbol: parsed.failure.rawSymbol, reason: parsed.failure.reason, detail: parsed.failure.detail });
        continue;
      }
      if (parsed.value.kind === GrowwSymbolKind.FUTURE) {
        ignoredFutureSymbols.push(rawSymbol);
        continue;
      }
      candidates.push({
        provider: HistoricalProviderId.GROWW,
        providerContractId: rawSymbol,
        exchange: parsed.value.exchange,
        underlyingSymbol: parsed.value.underlyingSymbol,
        expiry: parsed.value.expiry,
        strikePrice: parsed.value.strikePrice,
        optionType: parsed.value.optionType,
        // Not provable from this endpoint's live-proven string-only response -- see task B-F3 final correction pass, section 2.
        exchangeTradingSymbol: null,
        lotSize: null,
        tickSize: null,
        discoveredAt,
      });
    }

    return { candidates, ignoredFutureSymbols, malformedSymbols };
  }

  private formatIsoDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
