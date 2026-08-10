export interface OptionSlippageConfiguration {
  entrySlippagePercent: number;
  exitSlippagePercent: number;
}

export interface OptionSlippageCalculationRequest {
  entryPremium: number;
  exitPremium: number;
  slippage: OptionSlippageConfiguration;
}

export interface OptionSlippageDto {
  originalEntryPremium: number;
  originalExitPremium: number;
  adjustedEntryPremium: number;
  adjustedExitPremium: number;
  entrySlippageAmount: number;
  exitSlippageAmount: number;
  entrySlippagePercent: number;
  exitSlippagePercent: number;
}
