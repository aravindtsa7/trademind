import UpstoxHistoricalClient from '../../../historical-candles/client/upstox-historical.client';
import { UpstoxHistoricalCandleDto } from '../../../historical-candles/dto/upstox-historical-candle.dto';
import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalSourceCandleRow } from '../../domain/canonical-historical-candle';
import {
  HistoricalDataProvider,
  HistoricalOptionCandleRangeRequest,
  HistoricalUnderlyingCandleRangeRequest,
} from '../../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';

/**
 * Upstox's documented earliest 1-minute underlying history for
 * NSE_INDEX|Nifty 50. B-F2 is underlying-only -- option discovery/candle
 * horizons are deliberately left `null` here rather than guessed; an
 * option-scoped Upstox adapter is out of scope for this task.
 */
export const UPSTOX_UNDERLYING_HISTORY_START_DATE = '2022-01-01';

/** Upstox's documented maximum span for a single 1-minute historical-candle request: one calendar month. */
export const UPSTOX_ONE_MINUTE_MAX_REQUEST_DATE_SPAN_DAYS = 31;

/**
 * B-F1 `HistoricalDataProvider` implementation for Upstox, scoped to
 * completed NIFTY underlying (index) 1-minute history only. Wraps the
 * existing `UpstoxHistoricalClient` -- never reimplements its HTTP request
 * logic -- and converts its DTOs into the provider-neutral
 * `HistoricalSourceCandleRow` shape B-F1's projector/validator consume.
 *
 * Never logs or otherwise exposes the client's bearer token: this adapter
 * never reads `UpstoxHistoricalClient`'s internal access token, and never
 * constructs an error message from anything beyond `error.message` /
 * `error.response.status` (see `historical-provider-retry.util.ts`).
 */
export default class UpstoxHistoricalDataProviderService implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.UPSTOX;

  constructor(private readonly client: UpstoxHistoricalClient = new UpstoxHistoricalClient()) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.UPSTOX,
      earliestDocumentedUnderlyingHistory: UPSTOX_UNDERLYING_HISTORY_START_DATE,
      // Deliberately not populated -- this adapter is underlying-only for B-F2.
      earliestDocumentedOptionDiscovery: null,
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: false,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: UPSTOX_ONE_MINUTE_MAX_REQUEST_DATE_SPAN_DAYS,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: true,
      rateLimitPolicy: { policyId: 'UPSTOX_HISTORICAL_V3_DEFAULT', maxRequestsPerMinute: 60 },
    };
  }

  async fetchCompletedUnderlyingRange(
    request: HistoricalUnderlyingCandleRangeRequest
  ): Promise<readonly HistoricalSourceCandleRow[]> {
    if (request.assetType !== HistoricalAssetType.NIFTY_INDEX) {
      throw new Error(`UpstoxHistoricalDataProviderService only supports NIFTY_INDEX underlying requests; received ${request.assetType}.`);
    }
    if (request.interval !== '1minute') {
      throw new Error(`UpstoxHistoricalDataProviderService only supports the '1minute' interval; received '${request.interval}'.`);
    }

    // UpstoxHistoricalClient's parameter order is (instrumentKey, toDate, fromDate) -- preserved exactly as the existing client/sync-service call it.
    const candles = await this.client.fetchOneMinuteCandles(request.instrumentKey, request.toTradingDate, request.fromTradingDate);
    // Upstox's v3 historical-candle endpoint delivers rows newest-first
    // (strictly descending by candleTime) -- confirmed against the live
    // API, not merely assumed. `HistoricalSourceCandleRow.sourceIndex` and
    // B-F1's `CanonicalSourceOrderAnomaly` evidence both assume this
    // adapter's own emitted order is the ascending/chronological one (the
    // same assumption every other B-F2 test and the orchestrator make), so
    // Upstox's native descending order is normalized here, at the provider
    // boundary, exactly where provider-specific behavior belongs (never in
    // research-lake domain/projector logic). A plain `.reverse()` -- not a
    // `.sort()` -- is used deliberately: it exactly mirrors whatever order
    // Upstox actually sent, so a genuine delivery-order glitch (rows out of
    // Upstox's own descending sequence) still surfaces as a break in the
    // resulting ascending order and remains detectable; a `.sort()` would
    // instead force perfect ascending order unconditionally and silently
    // erase that evidence.
    const ascendingCandles = [...candles].reverse();
    return ascendingCandles.map((candle, index) => this.toSourceRow(candle, index));
  }

  /**
   * Intentionally unimplemented: this adapter is scoped to underlying
   * acquisition only for B-F2 (`getCapability()` already reports
   * `supportsOptionCandleAcquisition: false`). Fails loudly rather than
   * silently returning an empty/wrong result if ever accidentally called.
   */
  async fetchExpiredOptionRange(_request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error(
      'UpstoxHistoricalDataProviderService does not support option candle acquisition in B-F2 (underlying-only scope); see getCapability().supportsOptionCandleAcquisition.'
    );
  }

  private toSourceRow(candle: UpstoxHistoricalCandleDto, sourceIndex: number): HistoricalSourceCandleRow {
    return {
      sourceIndex,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      openInterest: candle.openInterest ?? null,
    };
  }
}
