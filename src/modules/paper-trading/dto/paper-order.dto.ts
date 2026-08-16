import { OptionTradeCharges } from '../../options/dto/option-trade-pnl.dto';
import {
  PaperOrderContract,
  PaperOrderEntry,
  PaperOrderExitConfiguration,
  PaperOrderExitReason,
  PaperOrderSignalType,
} from '../types/paper-trading.types';
import { PaperExecutionFillSummary } from './paper-fill-model.dto';

export interface CreatePaperOrderDto {
  executionOrderId?: string;
  signalTimestamp: Date;
  signalType: PaperOrderSignalType;
  contract: PaperOrderContract;
  entry: PaperOrderEntry;
  exitConfiguration: PaperOrderExitConfiguration;
}

export interface ClosePaperOrderDto {
  exitReason: PaperOrderExitReason;
  exitTimestamp: Date;
  observedExitPremium: number;
  simulatedExitPremium: number;
  grossPnl?: number;
  charges?: OptionTradeCharges;
  netPnl?: number;
  executionFill?: PaperExecutionFillSummary;
}

