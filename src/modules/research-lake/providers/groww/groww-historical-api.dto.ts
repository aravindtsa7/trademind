/**
 * Groww's LIVE-PROVEN response envelopes (confirmed against a real paid
 * Groww Backtesting API plan -- see the B-F3 final correction pass). Both
 * shapes below were observed on a real HTTP 200 response, not assumed:
 *
 *   GET /v1/historical/expiries  -> { status: "SUCCESS", payload: { expiries: string[] } }
 *   GET /v1/historical/contracts -> { status: "SUCCESS", payload: { contracts: string[] } }
 *
 * `payload` is always a nested object carrying the named array -- it is
 * never itself the array. Every array element is a bare string (Groww's
 * own native contract/expiry identifier); no object-shaped entry or
 * additional metadata field (lotSize/tickSize/tradingSymbol) has been
 * observed on this endpoint, so none is modeled or speculatively parsed
 * here. Validated strictly by `GrowwHistoricalClient`, never trusted
 * as-is -- see `validateSuccessEnvelope`/`extractExpiryStrings`/
 * `extractContractSymbols`.
 */
export interface GrowwApiFailureEnvelope {
  readonly status: 'FAILURE';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly metadata: unknown;
  };
}

export interface GrowwApiSuccessEnvelope {
  readonly status: string;
  readonly payload: unknown;
}

export type GrowwApiEnvelope = GrowwApiSuccessEnvelope | GrowwApiFailureEnvelope;
