import { HistoricalAssetType, HistoricalSourceCandleRow } from '../domain';
import { HistoricalProviderCapability, HistoricalProviderId } from './historical-provider-capability.types';

export interface HistoricalUnderlyingCandleRangeRequest {
  readonly assetType: HistoricalAssetType.NIFTY_INDEX;
  readonly instrumentKey: string;
  readonly interval: string;
  readonly fromTradingDate: string;
  readonly toTradingDate: string;
}

export interface HistoricalOptionCandleRangeRequest {
  readonly assetType: HistoricalAssetType.NIFTY_OPTION;
  readonly instrumentKey: string;
  readonly interval: string;
  readonly fromTradingDate: string;
  readonly toTradingDate: string;
}

/**
 * Provider-neutral abstraction for acquiring historical candle rows.
 * Deliberately scoped to *completed* ranges only (an already-finished
 * underlying history range, or an already-expired option's candle range) --
 * Phase B does not require current-day/live acquisition through this
 * interface. No provider implements this in B-F1.
 */
export interface HistoricalDataProvider {
  readonly providerId: HistoricalProviderId;
  getCapability(): HistoricalProviderCapability;
  fetchCompletedUnderlyingRange(
    request: HistoricalUnderlyingCandleRangeRequest
  ): Promise<readonly HistoricalSourceCandleRow[]>;
  fetchExpiredOptionRange(
    request: HistoricalOptionCandleRangeRequest
  ): Promise<readonly HistoricalSourceCandleRow[]>;
}
