export interface OptionTradeCharges {
  brokerage: number;
  stt: number;
  exchangeTransactionCharges: number;
  sebiCharges: number;
  gst: number;
  stampDuty: number;
  otherCharges: number;
}

export interface OptionTradePnlCalculationRequest {
  entryPremium: number;
  exitPremium: number;
  quantity: number;
  charges: OptionTradeCharges;
}

export interface OptionTradePnlDto {
  entryPremium: number;
  exitPremium: number;
  quantity: number;
  entryValue: number;
  exitValue: number;
  grossPnl: number;
  grossReturnPercent: number;
  charges: OptionTradeCharges;
  totalCharges: number;
  netPnl: number;
  netReturnPercent: number;
}
