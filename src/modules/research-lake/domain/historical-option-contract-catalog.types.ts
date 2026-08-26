import { HistoricalOptionType } from './historical-asset.types';
import {
  HistoricalContractState,
  HistoricalOptionContractIdentity,
  resolveHistoricalContractState,
} from './historical-option-identity.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * B-F1's `HistoricalOptionContractIdentity` requires a non-empty
 * `tradingSymbol` (the identity type's own semantic: "a provider that
 * cannot even name what it found has not really discovered a contract").
 * A Groww-discovered contract's own native symbol
 * (`NSE-NIFTY-02Jan25-28500-PE`) is genuine discovery identity evidence,
 * but it is Groww's OWN provider-native symbol, not proven to BE the real
 * NSE exchange trading symbol -- conflating the two would misrepresent
 * what was actually proven (task B-F3 section 5). This type keeps them
 * distinct rather than forcing Groww's response into B-F1's identity shape:
 *
 *   - `providerContractId`   -- Groww's own symbol; always present for any
 *                               successfully-parsed discovery, never
 *                               claimed to be anything more than Groww's
 *                               own identifier.
 *   - `exchangeTradingSymbol` -- `null` unless the provider response
 *                               ITSELF proves this is the real NSE trading
 *                               symbol (e.g. an explicit `trading_symbol`
 *                               field on the contracts response).
 *
 * `exchange` / `underlyingSymbol` / `expiry` / `strikePrice` / `optionType`
 * are exactly what the symbol's own grammar proves (see
 * `groww-contract-symbol-parser.ts`) -- never guessed.
 *
 * POINT-IN-TIME SAFETY (task section 12): a
 * `DiscoveredOptionContractCandidate` proves only that this contract
 * existed in the provider's historical CATALOG for this expiry. It does
 * NOT prove the contract was tradable, listed, or quoted at any specific
 * earlier date -- there is deliberately no `listingStartDate` field here,
 * and none is invented. A caller must never treat "this contract appears
 * in expiry X's final contract catalog" as "this contract was available at
 * an arbitrary earlier signal timestamp." That requires actual observed
 * candle evidence (B-F4+), represented separately via
 * `HistoricalContractStateEvidence`.
 */
export interface DiscoveredOptionContractCandidate {
  readonly provider: HistoricalProviderId;
  readonly providerContractId: string;
  readonly exchange: string;
  readonly underlyingSymbol: string;
  readonly expiry: Date;
  readonly strikePrice: number;
  readonly optionType: HistoricalOptionType;
  /** `null` unless the provider response itself proved the real NSE trading symbol -- never backfilled from a current-state source. */
  readonly exchangeTradingSymbol: string | null;
  /** `null` unless the provider response itself proved a historical lot size -- never derived from present-day values, never hardcoded by year. */
  readonly lotSize: number | null;
  /** `null` unless the provider response itself proved a historical tick size. */
  readonly tickSize: number | null;
  /** When THIS acquisition run produced this candidate (not when the contract itself was first listed -- that is unknown, see the point-in-time note above). */
  readonly discoveredAt: Date;
}

/**
 * Adapts a `DiscoveredOptionContractCandidate` into B-F1's
 * `HistoricalOptionContractIdentity` shape purely to REUSE
 * `resolveHistoricalContractState`'s existing, already-tested
 * completeness policy -- never reimplemented here. `instrumentKey` is
 * always the provider-native `providerContractId` (a stable discovery
 * identity Groww always supplies for anything successfully parsed);
 * `tradingSymbol` is the unproven, possibly-null `exchangeTradingSymbol`,
 * mapped to `''` when absent, which `isMetadataIncomplete` already treats
 * as missing.
 */
function toIdentityCandidate(candidate: DiscoveredOptionContractCandidate): HistoricalOptionContractIdentity {
  return {
    instrumentKey: candidate.providerContractId,
    tradingSymbol: candidate.exchangeTradingSymbol ?? '',
    underlyingKey: candidate.underlyingSymbol,
    expiry: candidate.expiry,
    strikePrice: candidate.strikePrice,
    optionType: candidate.optionType,
    lotSize: candidate.lotSize,
    tickSize: candidate.tickSize,
  };
}

/**
 * Resolves ONLY `CATALOG_KNOWN` or `METADATA_INCOMPLETE` for a discovered
 * catalog candidate -- B-F3 discovery alone must never produce
 * `OBSERVED_TRADING` or `SESSION_COVERED` (task section 8), since no
 * candle/trading evidence is ever supplied at this phase. `CATALOG_KNOWN`
 * is reached only when every field B-F1's identity contract requires
 * (including `lotSize`/`tickSize`/a proven `tradingSymbol`) has actually
 * been proven -- in practice, discovery-only results are expected to
 * resolve to `METADATA_INCOMPLETE` unless the provider response itself
 * supplied that metadata. This is expected and safe, not a defect.
 */
export function resolveCatalogMetadataState(
  candidate: DiscoveredOptionContractCandidate
): HistoricalContractState.CATALOG_KNOWN | HistoricalContractState.METADATA_INCOMPLETE {
  const state = resolveHistoricalContractState(toIdentityCandidate(candidate));
  if (state !== HistoricalContractState.CATALOG_KNOWN && state !== HistoricalContractState.METADATA_INCOMPLETE) {
    throw new Error(
      `resolveCatalogMetadataState produced ${state}, which B-F3 discovery must never produce (no trading evidence is ever supplied here) -- this indicates a caller passed evidence into resolveHistoricalContractState unexpectedly.`
    );
  }
  return state;
}

/** A discovered candidate plus its resolved catalog metadata state -- the shape this module's persistence layer actually stores. */
export interface HistoricalOptionContractCatalogRecord extends DiscoveredOptionContractCandidate {
  readonly metadataState: HistoricalContractState.CATALOG_KNOWN | HistoricalContractState.METADATA_INCOMPLETE;
}

export function toCatalogRecord(candidate: DiscoveredOptionContractCandidate): HistoricalOptionContractCatalogRecord {
  return { ...candidate, metadataState: resolveCatalogMetadataState(candidate) };
}
