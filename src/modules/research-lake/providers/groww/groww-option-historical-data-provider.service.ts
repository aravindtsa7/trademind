import { HistoricalAssetType } from '../../domain/historical-asset.types';
import { HistoricalSourceCandleRow } from '../../domain/canonical-historical-candle';
import {
  HistoricalDataProvider,
  HistoricalOptionCandleRangeRequest,
  HistoricalUnderlyingCandleRangeRequest,
} from '../../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import GrowwHistoricalClient from './groww-historical-client';
import { GrowwValidatedCandleRow } from './groww-historical-candle.dto';
import { GROWW_NSE_EXCHANGE } from './groww-historical-contract-provider.service';

export const GROWW_FNO_SEGMENT = 'FNO';

/** Groww's documented maximum span for a single 1-minute Backtesting candle request (task section 1/12). */
export const GROWW_OPTION_CANDLE_MAX_REQUEST_DATE_SPAN_DAYS = 30;

/** Matches the existing conservative default already declared by `GrowwHistoricalContractProviderService.getCapability()` (60/min = 1/sec) -- task section 11 requires reusing an existing Groww-specific policy over inventing a new one. */
export const GROWW_OPTION_CANDLE_MIN_REQUEST_INTERVAL_MS = 1_000;

const NORMAL_SESSION_START_TIME = '09:15:00';
/**
 * The documented section-0 probe example used `end_time=... 15:30:00` for a
 * full 09:15-15:29 session -- copied here verbatim rather than invented,
 * since it is the only concrete request-boundary evidence available
 * without live access (see the B-F4 final report).
 */
const NORMAL_SESSION_END_TIME = '15:30:00';

/**
 * B-F1 `HistoricalDataProvider` implementation for Groww, scoped to
 * completed NIFTY OPTION 1-minute candle acquisition only (task B-F4).
 * Wraps `GrowwHistoricalClient.fetchOptionCandles` -- never reimplements
 * its HTTP/validation logic. Symmetric with
 * `UpstoxHistoricalDataProviderService`: that adapter is underlying-only
 * and throws on `fetchExpiredOptionRange`; this adapter is option-only and
 * throws on `fetchCompletedUnderlyingRange`.
 *
 * `instrumentKey` here is always Groww's own native contract symbol (e.g.
 * `NSE-NIFTY-06Jan22-17200-PE`) -- the same `providerContractId` identity
 * B-F3's catalog uses -- never an Upstox/exchange instrument key.
 */
export default class GrowwOptionHistoricalDataProviderService implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.GROWW;

  constructor(private readonly client: GrowwHistoricalClient) {}

  getCapability(): HistoricalProviderCapability {
    return {
      providerId: HistoricalProviderId.GROWW,
      earliestDocumentedUnderlyingHistory: null, // this adapter is option-candle-only
      earliestDocumentedOptionDiscovery: null, // catalog discovery is GrowwHistoricalContractProviderService's domain (B-F3), not this adapter's
      // Deliberately not populated: not independently proven distinct from
      // the B-F3 discovery horizon (task section 2 on
      // HistoricalProviderCapability's own doc: collapsing independent
      // horizons together would silently lose the distinction).
      earliestDocumentedOptionCandleHistory: null,
      supportsOptionContractDiscovery: false,
      supportsOptionCandleAcquisition: true,
      supportedIntervals: ['1minute'],
      maximumRequestDateSpanDays: GROWW_OPTION_CANDLE_MAX_REQUEST_DATE_SPAN_DAYS,
      contractMetadataIncludesLotSize: false,
      historicalListingStartDateKnown: false, // a candle observation never proves a listing/first-tradable date (task section 4)
      rateLimitPolicy: { policyId: 'GROWW_HISTORICAL_CONSERVATIVE_DEFAULT', maxRequestsPerMinute: 60 },
    };
  }

  /** Intentionally unimplemented: this adapter is option-candle-only (`getCapability().supportsOptionCandleAcquisition` is `true`, underlying is not supported). Fails loudly rather than silently returning an empty/wrong result. */
  async fetchCompletedUnderlyingRange(_request: HistoricalUnderlyingCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('GrowwOptionHistoricalDataProviderService does not support underlying acquisition; it is option-candle-only (task B-F4). Use UpstoxHistoricalDataProviderService for NIFTY_INDEX.');
  }

  async fetchExpiredOptionRange(request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    if (request.assetType !== HistoricalAssetType.NIFTY_OPTION) {
      throw new Error(`GrowwOptionHistoricalDataProviderService only supports NIFTY_OPTION requests; received ${request.assetType}.`);
    }
    if (request.interval !== '1minute') {
      throw new Error(`GrowwOptionHistoricalDataProviderService only supports the '1minute' interval; received '${request.interval}'.`);
    }
    this.assertWithinMaxSpan(request.fromTradingDate, request.toTradingDate);

    const rows = await this.client.fetchOptionCandles({
      exchange: GROWW_NSE_EXCHANGE,
      segment: GROWW_FNO_SEGMENT,
      growwSymbol: request.instrumentKey,
      startTime: `${request.fromTradingDate} ${NORMAL_SESSION_START_TIME}`,
      endTime: `${request.toTradingDate} ${NORMAL_SESSION_END_TIME}`,
      candleInterval: '1minute',
    });

    // Preserved in EXACTLY the order Groww returned them -- never sorted or
    // reversed here (task section 7): unlike Upstox's confirmed-descending
    // order, Groww's raw delivery order was never confirmed live (see the
    // B-F4 final report), so any genuine out-of-order delivery must remain
    // visible to `CanonicalSourceOrderAnomaly` detection downstream.
    return rows.map((candle, index) => this.toSourceRow(candle, index));
  }

  private assertWithinMaxSpan(fromTradingDate: string, toTradingDate: string): void {
    const from = new Date(`${fromTradingDate}T00:00:00Z`);
    const to = new Date(`${toTradingDate}T00:00:00Z`);
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (spanDays > GROWW_OPTION_CANDLE_MAX_REQUEST_DATE_SPAN_DAYS) {
      throw new Error(
        `GrowwOptionHistoricalDataProviderService: requested range ${fromTradingDate}..${toTradingDate} spans ${spanDays} day(s), exceeding Groww's documented ${GROWW_OPTION_CANDLE_MAX_REQUEST_DATE_SPAN_DAYS}-day maximum for a single 1-minute Backtesting request.`
      );
    }
  }

  private toSourceRow(candle: GrowwValidatedCandleRow, sourceIndex: number): HistoricalSourceCandleRow {
    return {
      sourceIndex,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      openInterest: candle.openInterest,
    };
  }
}
