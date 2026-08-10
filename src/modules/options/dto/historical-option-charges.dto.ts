import { OptionTradeCharges } from './option-trade-pnl.dto';

export type HistoricalOptionRateUnit = 'DECIMAL_FRACTION' | 'PERCENT' | 'PER_CRORE';
export type HistoricalOptionTurnoverSide = 'BUY' | 'SELL' | 'TOTAL';
export type HistoricalOptionGstTaxableComponent =
  | 'BROKERAGE'
  | 'STT'
  | 'EXCHANGE_TRANSACTION_CHARGES'
  | 'SEBI_CHARGES'
  | 'STAMP_DUTY'
  | 'OTHER_CHARGES';

export interface HistoricalOptionTurnoverRate {
  value: number;
  unit: HistoricalOptionRateUnit;
}

export interface HistoricalOptionPercentageRate {
  value: number;
  unit: Exclude<HistoricalOptionRateUnit, 'PER_CRORE'>;
}

export interface HistoricalOptionFlatOtherCharge {
  id: string;
  kind: 'FLAT_RUPEE';
  amount: number;
}

export interface HistoricalOptionTurnoverOtherCharge {
  id: string;
  kind: 'TURNOVER_RATE';
  side: HistoricalOptionTurnoverSide;
  rate: HistoricalOptionTurnoverRate;
}

export type HistoricalOptionOtherCharge =
  | HistoricalOptionFlatOtherCharge
  | HistoricalOptionTurnoverOtherCharge;

/** Statutory and exchange charge rules selected by the historical trade date. */
export interface HistoricalOptionStatutoryChargesRateConfiguration {
  id: string;
  effectiveFrom: string;
  effectiveTo?: string;
  stt: {
    side: HistoricalOptionTurnoverSide;
    rate: HistoricalOptionTurnoverRate;
  };
  exchangeTransactionChargeRate: HistoricalOptionTurnoverRate;
  sebiTurnoverRate: HistoricalOptionTurnoverRate;
  gst: {
    rate: HistoricalOptionPercentageRate;
    taxableComponents: HistoricalOptionGstTaxableComponent[];
  };
  stampDuty: {
    side: HistoricalOptionTurnoverSide;
    rate: HistoricalOptionTurnoverRate;
  };
  otherCharges?: HistoricalOptionOtherCharge[];
}

/** Broker-plan pricing supplied explicitly by the historical research caller. */
export interface HistoricalOptionBrokerageConfiguration {
  id: string;
  effectiveFrom: string;
  effectiveTo?: string;
  brokeragePerExecutedOrder: number;
  numberOfOrders: number;
}

/** @deprecated Use HistoricalOptionStatutoryChargesRateConfiguration. */
export type HistoricalOptionChargesRateConfiguration = HistoricalOptionStatutoryChargesRateConfiguration;

export interface HistoricalOptionChargesCalculationRequest {
  tradeDate: Date;
  entryPremium: number;
  exitPremium: number;
  quantity: number;
  statutoryRateConfiguration: HistoricalOptionStatutoryChargesRateConfiguration;
  brokerageConfiguration: HistoricalOptionBrokerageConfiguration;
}

export interface HistoricalOptionChargesDto extends OptionTradeCharges {
  totalCharges: number;
  entryTurnover: number;
  exitTurnover: number;
  totalTurnover: number;
  statutoryRateConfigurationId: string;
  statutoryEffectiveFrom: string;
  statutoryEffectiveTo?: string;
  brokerageConfigurationId: string;
  brokerageEffectiveFrom: string;
  brokerageEffectiveTo?: string;
}
