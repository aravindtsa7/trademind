import { OptionTradeCharges } from './option-trade-pnl.dto';
import { UpstoxOptionChargesDto } from './upstox-option-charges.dto';

export interface OptionRoundTripChargesRequestDto {
  instrumentKey: string;
  quantity: number;
  product: string;
  entryPrice: number;
  exitPrice: number;
}

export interface OptionRoundTripChargesDto {
  entryCharges: UpstoxOptionChargesDto;
  exitCharges: UpstoxOptionChargesDto;
  combinedCharges: OptionTradeCharges;
  totalCharges: number;
  entryReportedTotal: number;
  exitReportedTotal: number;
  combinedReportedTotal: number;
  reconciliationDifference: number;
}
