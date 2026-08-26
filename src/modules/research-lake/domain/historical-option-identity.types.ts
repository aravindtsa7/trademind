import { HistoricalOptionType } from './historical-asset.types';

/**
 * Point-in-time option contract identity as documented by a historical
 * provider. `instrumentKey` / `tradingSymbol` / `underlyingKey` are always
 * required -- a provider that cannot even name what it found has not
 * really discovered a contract. Every other field is nullable because a
 * historical/expired-contract provider may legitimately not document it;
 * `null` here always means "provider did not supply this", never "unknown
 * placeholder value". Nothing in this module invents a value for a missing
 * field (no hardcoded historical lot-size timeline, no fallback to the
 * live `Instrument` table, no fabricated `listingDate`).
 */
export interface HistoricalOptionContractIdentity {
  readonly instrumentKey: string;
  readonly tradingSymbol: string;
  readonly underlyingKey: string;
  readonly expiry: Date | null;
  readonly strikePrice: number | null;
  readonly optionType: HistoricalOptionType | null;
  readonly lotSize: number | null;
  readonly tickSize: number | null;
}

/**
 * Quality/tradability state for a historical option contract.
 *
 * Important semantic rule: `CATALOG_KNOWN` does NOT prove the contract was
 * tradable at a past timestamp -- it only means complete identity metadata
 * is available. `OBSERVED_TRADING` / `SESSION_COVERED` require actual
 * candle evidence, supplied by the caller via `HistoricalContractStateEvidence`
 * (this module does not itself fetch candles). `PROVIDER_UNAVAILABLE` is
 * for a provider that returned no catalog entry at all -- callers of a
 * `HistoricalContractProvider` return that directly; it is not produced by
 * `resolveHistoricalContractState`, since a resolver needs an identity to
 * reason about in the first place.
 */
export enum HistoricalContractState {
  CATALOG_KNOWN = 'CATALOG_KNOWN',
  OBSERVED_TRADING = 'OBSERVED_TRADING',
  SESSION_COVERED = 'SESSION_COVERED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  METADATA_INCOMPLETE = 'METADATA_INCOMPLETE',
}

/**
 * Trading evidence a caller has already gathered for a contract (e.g. from
 * `HistoricalDataProvider.fetchExpiredOptionRange` /
 * `CanonicalSessionProjectorService`), passed in rather than fetched here
 * so this resolver stays a pure function of its inputs.
 */
export interface HistoricalContractStateEvidence {
  readonly hasObservedTradingCandle: boolean;
  readonly hasCompleteCanonicalSessionCoverage: boolean;
}

const NO_EVIDENCE: HistoricalContractStateEvidence = {
  hasObservedTradingCandle: false,
  hasCompleteCanonicalSessionCoverage: false,
};

function isNonEmptyTrimmedString(value: string): boolean {
  return value.trim().length > 0;
}

function isValidDate(value: Date | null): value is Date {
  return value !== null && !Number.isNaN(value.getTime());
}

function isValidOptionType(value: HistoricalOptionType | null): value is HistoricalOptionType {
  return value !== null && Object.values(HistoricalOptionType).includes(value);
}

/**
 * `strikePrice` / `tickSize`: finite and strictly positive. Rejects `null`,
 * `NaN`, `Infinity`/`-Infinity`, `0`, and negative values -- a strike or
 * tick size of `0` or below is not a legitimate historical value, it is
 * malformed provider data.
 */
function isPositiveFiniteNumber(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0;
}

/**
 * `lotSize`: a positive whole number. `0`, negative, or non-integer values
 * (e.g. a provider sending a fractional or zero lot size) are treated as
 * malformed, not as a legitimate historical lot size.
 */
function isPositiveInteger(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value > 0;
}

function isMetadataIncomplete(identity: HistoricalOptionContractIdentity): boolean {
  return (
    !isNonEmptyTrimmedString(identity.instrumentKey) ||
    !isNonEmptyTrimmedString(identity.tradingSymbol) ||
    !isNonEmptyTrimmedString(identity.underlyingKey) ||
    !isValidDate(identity.expiry) ||
    !isPositiveFiniteNumber(identity.strikePrice) ||
    !isValidOptionType(identity.optionType) ||
    !isPositiveInteger(identity.lotSize) ||
    !isPositiveFiniteNumber(identity.tickSize)
  );
}

/**
 * Resolves a contract's `HistoricalContractState` from its identity
 * metadata plus any trading evidence already gathered by the caller.
 * `METADATA_INCOMPLETE` always takes priority: this module never claims a
 * tradability state (`OBSERVED_TRADING` / `SESSION_COVERED`) for a contract
 * whose identity is not fully known, however strong the evidence.
 */
export function resolveHistoricalContractState(
  identity: HistoricalOptionContractIdentity,
  evidence: HistoricalContractStateEvidence = NO_EVIDENCE
): HistoricalContractState {
  if (isMetadataIncomplete(identity)) return HistoricalContractState.METADATA_INCOMPLETE;
  if (evidence.hasCompleteCanonicalSessionCoverage) return HistoricalContractState.SESSION_COVERED;
  if (evidence.hasObservedTradingCandle) return HistoricalContractState.OBSERVED_TRADING;
  return HistoricalContractState.CATALOG_KNOWN;
}
