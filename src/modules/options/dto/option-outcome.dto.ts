import { ExpiredOptionCandleDto } from './upstox-expired-option-candle.dto';
import { OptionContract, OptionContractSelectionSignal, OptionContractType } from '../types';

export interface OptionOutcomeEvaluationRequest {
  signalTimestamp: Date;
  signalType: OptionContractSelectionSignal;
  selectedContract: OptionContract;
  candles: readonly ExpiredOptionCandleDto[];
}

export interface OptionPremiumMovementDto {
  premium: number;
  change: number;
  changePercent: number;
}

export interface OptionOutcomeDto {
  signalTimestamp: Date;
  signalType: OptionContractSelectionSignal;
  instrumentKey: string;
  tradingSymbol: string;
  optionType: OptionContractType;
  strikePrice: number;
  expiry: Date;
  entryPremium: number;
  at5m: OptionPremiumMovementDto | null;
  at15m: OptionPremiumMovementDto | null;
  at30m: OptionPremiumMovementDto | null;
  at60m: OptionPremiumMovementDto | null;
  mfe: number;
  mfePercent: number;
  mae: number;
  maePercent: number;
}
