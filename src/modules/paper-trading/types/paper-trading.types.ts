import { OptionTradeCharges } from '../../options/dto/option-trade-pnl.dto';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { PaperExecutionFillSummary } from '../dto/paper-fill-model.dto';

export enum PaperOrderStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  TARGET_EXIT = 'TARGET_EXIT',
  STOP_EXIT = 'STOP_EXIT',
  TIME_EXIT = 'TIME_EXIT',
  CANCELLED = 'CANCELLED',
}

export type PaperOrderSignalType = StrategySignal.BUY_CE | StrategySignal.BUY_PE;
export type PaperOrderOptionType = 'CE' | 'PE';
export type PaperOrderExitReason = PaperOrderStatus.TARGET_EXIT | PaperOrderStatus.STOP_EXIT | PaperOrderStatus.TIME_EXIT;

export interface PaperOrderContract {
  instrumentKey: string;
  tradingSymbol: string;
  optionType: PaperOrderOptionType;
  strikePrice: number;
  expiry: Date;
  lotSize: number;
  quantity: number;
}

export interface PaperOrderEntry {
  entryTimestamp: Date;
  observedEntryPremium: number;
  simulatedEntryPremium: number;
  /** Observed/reference price remains separate from executable-estimated fill. */
  executionFill?: PaperExecutionFillSummary;
}

export interface PaperOrderExitConfiguration {
  targetPercent: number;
  stopLossPercent: number;
  maximumHoldingMinutes: number;
}

export interface PaperOrderExit {
  exitTimestamp: Date;
  observedExitPremium: number;
  simulatedExitPremium: number;
  exitReason: PaperOrderExitReason;
  grossPnl?: number;
  charges?: OptionTradeCharges;
  netPnl?: number;
  executionFill?: PaperExecutionFillSummary;
}

export interface PaperOrder {
  id: string;
  status: PaperOrderStatus;
  signalTimestamp: Date;
  signalType: PaperOrderSignalType;
  contract: PaperOrderContract;
  entry: PaperOrderEntry;
  exitConfiguration: PaperOrderExitConfiguration;
  targetPremium: number;
  stopPremium: number;
  exit?: PaperOrderExit;
}

export interface PaperPremiumUpdate {
  instrumentKey: string;
  timestamp: Date;
  premium: number;
}

export type PaperPositionMonitorAction =
  | 'NONE'
  | PaperOrderStatus.TARGET_EXIT
  | PaperOrderStatus.STOP_EXIT
  | PaperOrderStatus.TIME_EXIT;

export interface PaperPositionMonitoringResult {
  orderId: string;
  instrumentKey: string;
  timestamp: Date;
  observedPremium: number;
  action: PaperPositionMonitorAction;
  executionUnavailable?: boolean;
}
