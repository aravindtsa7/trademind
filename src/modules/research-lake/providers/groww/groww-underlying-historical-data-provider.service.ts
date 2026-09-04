import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalSourceCandleRow } from '../../domain/canonical-historical-candle';
import {
  HistoricalDataProvider,
  HistoricalOptionCandleRangeRequest,
  HistoricalUnderlyingCandleRangeRequest,
} from '../../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import { NIFTY_INDEX_INSTRUMENT_KEY } from '../../services/nifty-underlying-identity';
import GrowwHistoricalClient from './groww-historical-client';
import { GrowwValidatedCandleRow } from './groww-historical-candle.dto';
import { GROWW_NSE_EXCHANGE } from './groww-historical-contract-provider.service';

export const GROWW_UNDERLYING_SEGMENT = 'CASH';

/**
 * Groww's own native wire symbol for the NIFTY 50 index, live-verified
 * against a real `GET /v1/historical/candles?exchange=NSE&segment=CASH&
 * groww_symbol=NSE-NIFTY&...` HTTP 200 (B-M10 controlled probe, 2024-12-12).
 * Deliberately distinct from `NIFTY_INDEX_INSTRUMENT_KEY`
 * (`'NSE_INDEX|Nifty 50'`) -- that is this system's OWN canonical
 * cross-provider instrument identity (the Upstox-shaped key every
 * `HistoricalCandle` row is stored under), never a Groww wire value. This
 * adapter is the ONE place that translates between the two, exactly once.
 */
export const GROWW_NIFTY_UNDERLYING_SYMBOL = 'NSE-NIFTY';

/**
 * Live-verified request-boundary strings (B-M10 controlled probe): Groww's
 * CASH candle response for `[start_time, end_time]` included a boundary row
 * AT `end_time` itself (376 rows for a 375-minute certified session,
 * extra row at 15:30 IST) -- copied here verbatim as the proven contract,
 * never invented. This adapter does NOT special-case or drop that boundary
 * row itself: it is passed through as an ordinary source row, and the
 * EXISTING, unmodified `CanonicalSessionProjectorService` (reused unchanged
 * by `NiftyUnderlyingGapRepairService`) is what excludes it from becoming
 * canonical data, via its already-established half-open
 * `[openMinuteIst, closeMinuteIst)` window classification -- exactly the
 * same mechanism every other provider adapter's boundary rows go through.
 * See this class's `fetchCompletedUnderlyingRange` doc for detail.
 */
const NORMAL_SESSION_START_TIME = '09:15:00';
const NORMAL_SESSION_END_TIME = '15:30:00';

/**
 * B-M10 `HistoricalDataProvider` implementation for Groww, scoped to
 * completed NIFTY underlying (index) 1-minute history only -- the secondary
 * repair provider `NiftyUnderlyingGapRepairService` calls when a primary
 * (Upstox) session comes back INCOMPLETE. Wraps
 * `GrowwHistoricalClient.fetchUnderlyingCandles` -- never reimplements its
 * HTTP/validation logic. Symmetric with `GrowwOptionHistoricalDataProviderService`
 * (that adapter is option-only and throws on `fetchCompletedUnderlyingRange`;
 * this adapter is underlying-only and throws on `fetchExpiredOptionRange`).
 *
 * Scope is deliberately narrow, matching exactly what the B-M10 live probe
 * proved and nothing more: `NIFTY_INDEX` only, the fixed canonical
 * `NIFTY_INDEX_INSTRUMENT_KEY`, `'1minute'` only, and a SINGLE trading date
 * per request (the verified contract has only ever been proven for one
 * date at a time; a broad date-range request is out of scope and rejected
 * before any provider call).
 */
export default class GrowwUnderlyingHistoricalDataProviderService implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.GROWW;

  constructor(private readonly client: GrowwHistoricalClient) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.GROWW,
      // Deliberately not populated: only a single date (2024-12-12) has been
      // live-verified for this contract -- no broader documented horizon
      // exists to report, and guessing one would violate the "never invent"
      // rule this module holds every capability field to.
      earliestDocumentedUnderlyingHistory: null,
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: 1,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false,
      rateLimitPolicy: { policyId: 'GROWW_HISTORICAL_CONSERVATIVE_DEFAULT', maxRequestsPerMinute: 60 },
    };
  }

  /**
   * Fetches one trading date's raw underlying candles from Groww and maps
   * them into provider-neutral `HistoricalSourceCandleRow`s. Fails closed
   * (throws, zero provider call made) on anything outside the proven B-M10
   * scope: a non-`NIFTY_INDEX` asset type, any `instrumentKey` other than
   * the fixed canonical `NIFTY_INDEX_INSTRUMENT_KEY`, any interval other
   * than `'1minute'`, or a `fromTradingDate`/`toTradingDate` range wider
   * than a single date.
   *
   * The 15:30 IST boundary row Groww's response includes is intentionally
   * NOT filtered here -- see the module-level doc above and
   * `CanonicalSessionProjectorService`, which already excludes it from the
   * certified `[09:15,15:30)` session window unchanged.
   */
  async fetchCompletedUnderlyingRange(
    request: HistoricalUnderlyingCandleRangeRequest
  ): Promise<readonly HistoricalSourceCandleRow[]> {
    if (request.assetType !== HistoricalAssetType.NIFTY_INDEX) {
      throw new Error(`GrowwUnderlyingHistoricalDataProviderService only supports NIFTY_INDEX underlying requests; received ${request.assetType}.`);
    }
    if (request.instrumentKey !== NIFTY_INDEX_INSTRUMENT_KEY) {
      throw new Error(`GrowwUnderlyingHistoricalDataProviderService only supports instrumentKey '${NIFTY_INDEX_INSTRUMENT_KEY}'; received '${request.instrumentKey}'.`);
    }
    if (request.interval !== '1minute') {
      throw new Error(`GrowwUnderlyingHistoricalDataProviderService only supports the '1minute' interval; received '${request.interval}'.`);
    }
    if (request.fromTradingDate !== request.toTradingDate) {
      throw new Error(
        `GrowwUnderlyingHistoricalDataProviderService only supports a single trading date per request (the live-verified Groww underlying contract has only been proven for one date at a time); received a range ${request.fromTradingDate}..${request.toTradingDate}.`
      );
    }

    const candles = await this.client.fetchUnderlyingCandles({
      exchange: GROWW_NSE_EXCHANGE,
      segment: GROWW_UNDERLYING_SEGMENT,
      growwSymbol: GROWW_NIFTY_UNDERLYING_SYMBOL,
      startTime: `${request.fromTradingDate} ${NORMAL_SESSION_START_TIME}`,
      endTime: `${request.toTradingDate} ${NORMAL_SESSION_END_TIME}`,
      candleInterval: '1minute',
    });

    // Preserved in EXACTLY the order Groww returned them -- never sorted,
    // reversed, or deduplicated here (matching every other adapter in this
    // module): a genuine duplicate/out-of-order delivery must remain
    // visible to `CanonicalSourceOrderAnomaly` detection and to
    // `NiftyUnderlyingGapRepairService`'s own missing-minute/overlap
    // resolution downstream, never silently collapsed at this boundary.
    return candles.map((candle, index) => this.toSourceRow(candle, index));
  }

  /**
   * Intentionally unimplemented: this adapter is scoped to underlying
   * acquisition only (`getCapability().supportsOptionCandleAcquisition` is
   * `false`). Fails loudly rather than silently returning an empty/wrong
   * result if ever accidentally called.
   */
  async fetchExpiredOptionRange(_request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error(
      'GrowwUnderlyingHistoricalDataProviderService does not support option candle acquisition; it is underlying-index-only (B-M10). Use GrowwOptionHistoricalDataProviderService for NIFTY_OPTION.'
    );
  }

  /**
   * B-M11 PROVIDER-TO-CANONICAL SEMANTIC NORMALIZATION (NIFTY_INDEX
   * underlying ONLY -- this is the ONE place in the whole system allowed to
   * perform it): Groww's NSE-NIFTY CASH candles have been live-confirmed to
   * report `volume` as either a numeric non-negative integer (2024-12-12,
   * value `0`) OR an explicit `null` (2025-03-25T10:42:00 IST,
   * `[...,null,null]`) -- both are genuine, non-error provider responses for
   * this non-traded index, never a malformed row. `GrowwHistoricalClient`
   * itself preserves this truthfully as `bigint | null` and does NOT decide
   * what it means downstream (see that client's own doc); THIS method is
   * where the decision is made, explicitly and only for `NIFTY_INDEX`:
   * Groww `null` volume -> canonical `0n`, because `HistoricalSourceCandleRow`/
   * `CanonicalHistoricalCandle` require a `bigint` and the established
   * canonical index representation already uses numeric `0` volume (the
   * 2024-12-12 precedent) for this always-non-traded instrument. A numeric
   * Groww volume is preserved EXACTLY, never touched. This normalization is
   * NEVER applied to OHLC, NEVER applied to open interest (see the check
   * below), and NEVER reused by `GrowwOptionHistoricalDataProviderService`
   * (FNO/option volume remains strictly required and is never null by the
   * time it reaches that adapter).
   */
  private toSourceRow(candle: GrowwValidatedCandleRow, sourceIndex: number): HistoricalSourceCandleRow {
    if (candle.openInterest !== null) {
      // Live-verified contract: a NIFTY_INDEX candle carries no open
      // interest (the B-M10 probe returned `openInterest = null` for every
      // row). A non-null value here is outside that proven contract and is
      // rejected rather than silently accepted/forwarded as if it meant
      // something -- this adapter never fabricates or reinterprets provider
      // data (task section "fail closed on ... invalid OI").
      throw new Error(
        `GrowwUnderlyingHistoricalDataProviderService: expected openInterest to be null for a NIFTY_INDEX candle at ${candle.candleTime.toISOString()} (index candles carry no open interest), but received ${candle.openInterest.toString()}.`
      );
    }
    return {
      sourceIndex,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      // B-M11: Groww `null` volume -> canonical `0n`, NIFTY_INDEX-only normalization -- see this
      // method's own doc above. A numeric Groww volume passes through unchanged.
      volume: candle.volume === null ? 0n : candle.volume,
      openInterest: null,
    };
  }
}
