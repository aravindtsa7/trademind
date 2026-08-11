import { HistoricalOptionCandleCacheMetadata } from '../../modules/options/services/historical-option-candle-cache.service';
import { OptionContract } from '../../modules/options/types';

export interface PreparedOptionSignalResolution<TSignal> {
  signal: TSignal;
  selectedContract: OptionContract;
  instrumentKey: string;
  tradingDate: string;
  metadata: HistoricalOptionCandleCacheMetadata;
}

export function prepareOptionSignalResolution<TSignal>(signal: TSignal, selectedContract: OptionContract, tradingDate: string): PreparedOptionSignalResolution<TSignal> {
  return { signal, selectedContract, instrumentKey: selectedContract.instrumentKey, tradingDate, metadata: { tradingSymbol: selectedContract.tradingSymbol, optionType: selectedContract.optionType, strikePrice: selectedContract.strikePrice, expiry: selectedContract.expiry } };
}
