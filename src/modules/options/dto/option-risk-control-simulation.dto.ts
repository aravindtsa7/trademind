export type OptionRiskControlRejectionReason =
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_TRADES_PER_DAY'
  | 'MAX_CONSECUTIVE_LOSSES'
  | 'COOL_OFF_AFTER_LOSS'
  | 'MAX_SIMULTANEOUS_POSITIONS'
  | 'DAILY_PROFIT_LOCK';

/** A completed, already-evaluated option trade. No outcome is recalculated here. */
export interface OptionRiskControlTradeInput {
  signalTimestamp: Date;
  exitTimestamp: Date;
  netPnl: number;
  instrumentKey: string;
  tradingSymbol: string;
}

export interface OptionRiskControlConfiguration {
  maxDailyLossAmount?: number;
  maxTradesPerDay?: number;
  maxConsecutiveLosses?: number;
  coolOffMinutesAfterLoss?: number;
  maxSimultaneousPositions?: number;
  dailyProfitLockAmount?: number;
}

export interface OptionRiskControlSimulationRequest {
  trades: readonly OptionRiskControlTradeInput[];
  configuration: OptionRiskControlConfiguration;
}

export interface OptionRiskControlledTrade extends OptionRiskControlTradeInput {
  accepted: boolean;
  rejectionReason: OptionRiskControlRejectionReason | null;
}

export interface OptionRiskControlDailySummary {
  tradingDate: string;
  candidateTrades: number;
  acceptedTrades: number;
  rejectedTrades: number;
  wins: number;
  losses: number;
  realizedDailyPnl: number;
  dailyLossLimitTriggered: boolean;
  profitLockTriggered: boolean;
}

export interface OptionRiskControlSimulationResult {
  acceptedTrades: OptionRiskControlledTrade[];
  rejectedTrades: OptionRiskControlledTrade[];
  decisions: OptionRiskControlledTrade[];
  dailySummaries: OptionRiskControlDailySummary[];
  totalCandidates: number;
  totalAccepted: number;
  totalRejected: number;
  rejectionCounts: Record<OptionRiskControlRejectionReason, number>;
}
