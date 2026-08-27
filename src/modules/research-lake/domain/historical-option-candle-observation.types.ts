import { DatasetHealthReport, DatasetHealthStatus } from './dataset-health.types';
import { HistoricalContractStateEvidence } from './historical-option-identity.types';

/**
 * Truthful per-session candle-observation state for a `NIFTY_OPTION`
 * contract (task B-F4, sections 4/8/14) -- deliberately NOT expressed by
 * reusing `HistoricalContractState` directly. That enum's
 * `METADATA_INCOMPLETE` branch (`resolveHistoricalContractState`) takes
 * unconditional priority over any trading evidence, by design, for B-F3's
 * catalog-completeness question ("do we know lotSize/tickSize/a proven
 * tradingSymbol"). Every Groww-discovered contract's B-F3 catalog metadata
 * is `METADATA_INCOMPLETE` today (see `historical-option-contract-catalog.types.ts`),
 * so forcing real B-F4 candle evidence through that same resolver would
 * silently hide truthful `OBSERVED_TRADING`/`SESSION_COVERED` evidence
 * behind `METADATA_INCOMPLETE` -- exactly the "incorrectly promote/hide"
 * failure task section 14 warns against. This type keeps "do we know this
 * contract's identity metadata" (B-F3, unchanged) and "what did we actually
 * observe trading-wise for this session" (B-F4, this type) as two always
 * separately-reported facts -- the additive evidence model task section 14
 * calls for instead of lying via the combined enum.
 *
 * `toHistoricalContractStateEvidence` below still lets a caller feed this
 * evidence into the EXISTING `resolveHistoricalContractState` when a
 * combined catalog+candle judgement is wanted -- reusing that resolver's
 * already-tested priority rule (metadata incompleteness still wins there),
 * never reimplementing it.
 */
export enum OptionCandleObservationState {
  /** The fetch itself succeeded but returned zero candles for this session -- legitimate for an illiquid, not-yet-listed, or already-quiet-by-expiry strike. Never treated as a provider failure. */
  NO_OBSERVED_TRADING = 'NO_OBSERVED_TRADING',
  /** At least one candle observed, but the canonical session is not complete (missing minutes). Proves OBSERVED_TRADING only -- never SESSION_COVERED (task section 8). */
  PARTIAL_OBSERVED_SESSION = 'PARTIAL_OBSERVED_SESSION',
  /** The canonical session has exactly the healthy 375-row 09:15-15:29 IST contract (pre/post-market rows may have been excluded first). Proves SESSION_COVERED for this date. */
  COMPLETE_SESSION = 'COMPLETE_SESSION',
  /** The request itself technically failed (after retries were exhausted) -- distinct from a successful-but-empty response. Never conflated with NO_OBSERVED_TRADING. */
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  /** Canonical rows failed structural validation (duplicate timestamp/out-of-order/invalid OHLC/negative volume or OI/non-finite value). Fails closed -- never persisted. */
  INVALID = 'INVALID',
}

/**
 * Resolves the truthful `OptionCandleObservationState` from a
 * `DatasetHealthReport` ALREADY produced by the shared, unmodified
 * `DatasetHealthValidatorService`/`CanonicalSessionProjectorService` for a
 * `NIFTY_OPTION` session -- never reimplements that validator's structural
 * logic (duplicate/gap/OHLC/OI checks stay defined exactly once).
 *
 * Must only ever be called for a session whose FETCH itself already
 * succeeded: a technical fetch failure (401/403/exhausted retries) is
 * classified as `PROVIDER_UNAVAILABLE` directly by the caller BEFORE a
 * `DatasetHealthReport` can even exist (see
 * `GrowwOptionCandleAcquisitionService`) -- which is exactly why this
 * function reinterprets `DatasetHealthStatus.PROVIDER_UNAVAILABLE` (the
 * shared validator's own "zero source rows" signal, correct as literal
 * provider-down evidence for the always-trading `NIFTY_INDEX`) as
 * `NO_OBSERVED_TRADING` here: for an OPTION, a successful-but-empty
 * response is truthful "no observed trading", never "the provider is
 * down" (task section 8).
 */
export function resolveOptionCandleObservationState(report: DatasetHealthReport): OptionCandleObservationState {
  switch (report.status) {
    case DatasetHealthStatus.PROVIDER_UNAVAILABLE:
      return OptionCandleObservationState.NO_OBSERVED_TRADING;
    case DatasetHealthStatus.HEALTHY:
    case DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS:
      return OptionCandleObservationState.COMPLETE_SESSION;
    case DatasetHealthStatus.INCOMPLETE:
      return OptionCandleObservationState.PARTIAL_OBSERVED_SESSION;
    case DatasetHealthStatus.INVALID:
    case DatasetHealthStatus.METADATA_INCOMPLETE:
    case DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED:
      // Defensively folded into INVALID rather than silently dropped:
      // METADATA_INCOMPLETE (bad instrumentKey/tradingDate) and
      // SPECIAL_SESSION_EXCLUDED (an UNDECLARED_SPECIAL_SESSION
      // declaration) should be unreachable given this service always
      // supplies a concrete instrumentKey/tradingDate and always declares
      // NORMAL_NIFTY_SESSION -- mirrors the same defensive pattern in
      // `NiftyUnderlyingAcquisitionService.mapHealthStatusToBucket`.
      return OptionCandleObservationState.INVALID;
    default: {
      const exhaustive: never = report.status;
      throw new Error(`resolveOptionCandleObservationState: unhandled DatasetHealthStatus '${String(exhaustive)}'.`);
    }
  }
}

export function isCompleteSessionCoverage(state: OptionCandleObservationState): boolean {
  return state === OptionCandleObservationState.COMPLETE_SESSION;
}

export function hasObservedTrading(state: OptionCandleObservationState): boolean {
  return state === OptionCandleObservationState.COMPLETE_SESSION || state === OptionCandleObservationState.PARTIAL_OBSERVED_SESSION;
}

/**
 * Bridges this module's truthful per-session evidence into B-F1's existing
 * `HistoricalContractStateEvidence` shape, for a caller that wants a
 * combined catalog-identity + candle-evidence judgement via the existing,
 * already-tested `resolveHistoricalContractState` (task section 4). Never
 * reimplements that resolver's own priority rule -- metadata incompleteness
 * still wins there, exactly as before this module existed.
 */
export function toHistoricalContractStateEvidence(state: OptionCandleObservationState): HistoricalContractStateEvidence {
  return {
    hasObservedTradingCandle: hasObservedTrading(state),
    hasCompleteCanonicalSessionCoverage: isCompleteSessionCoverage(state),
  };
}
