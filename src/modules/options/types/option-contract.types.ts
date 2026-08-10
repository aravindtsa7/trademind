import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';

export type OptionContractType = 'CE' | 'PE';

export type OptionContractSelectionSignal = StrategySignal.BUY_CE | StrategySignal.BUY_PE;

export interface OptionContract {
  instrumentKey: string;
  tradingSymbol: string;
  underlying: string;
  strikePrice: number;
  expiry: Date;
  optionType: OptionContractType;
  exchange: string;
  segment: string;
  lotSize?: number;
}

export interface OptionContractSelectionRequest {
  underlying: string;
  spotPrice: number;
  signal: OptionContractSelectionSignal;
  timestamp: Date;
  contracts: readonly OptionContract[];
}

export interface OptionContractSelectionResult {
  instrumentKey: string;
  tradingSymbol: string;
  underlying: string;
  optionType: OptionContractType;
  strikePrice: number;
  expiry: Date;
  spotPrice: number;
  strikeDistance: number;
}
