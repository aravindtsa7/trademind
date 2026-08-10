import { OptionTradeCharges } from './option-trade-pnl.dto';

export type UpstoxOptionTransactionType = 'BUY' | 'SELL';

export interface UpstoxOptionChargesRequestDto {
  instrumentToken: string;
  quantity: number;
  product: string;
  transactionType: UpstoxOptionTransactionType;
  price: number;
}

export interface UpstoxOptionChargesDto extends OptionTradeCharges {
  reportedTotalCharges: number;
}

export interface UpstoxBrokerageDetailsApiResponseDto {
  status: string;
  data: {
    charges: {
      total: number;
      brokerage: number;
      taxes: {
        gst: number;
        stt: number;
        stamp_duty: number;
      };
      other_charges: {
        transaction: number;
        sebi_turnover: number;
        [chargeName: string]: number;
      };
    };
  };
}
