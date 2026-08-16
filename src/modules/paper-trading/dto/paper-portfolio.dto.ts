export type PaperPositionStatus = 'OPEN_INTENT' | 'ENTRY_FILLED' | 'OPEN' | 'EXIT_REQUESTED' | 'EXIT_FILLED' | 'CLOSED';
export type PaperFillType = 'ENTRY' | 'EXIT';
export type PaperQuoteQuality = 'BID_ASK' | 'LTP_ONLY' | 'STALE_QUOTE' | 'UNAVAILABLE';

export interface PaperFill {
  fillId: string;
  positionId: string;
  type: PaperFillType;
  timestamp: string;
  price: number;
  quantity: number;
  source: 'SIMULATED_ENTRY' | 'SIMULATED_EXIT';
  exitReason?: string;
}

export interface PaperPositionTransition {
  status: PaperPositionStatus;
  timestamp: string;
}

export interface PaperPosition {
  positionId: string;
  strategyId: string;
  instrumentKey: string;
  underlying: string;
  side: 'BUY_CE' | 'BUY_PE';
  quantity: number;
  entryTimestamp: string;
  entryPrice: number;
  currentMarkPrice: number | null;
  quoteQuality: PaperQuoteQuality;
  realizedPnl: number;
  unrealizedPnl: number | null;
  status: PaperPositionStatus;
  correlationId: string;
  originatingIntentId: string;
  originatingOrderId: string;
  exitTimestamp?: string;
  exitPrice?: number;
  exitReason?: string;
  /** Full idempotent lifecycle audit; `status` remains the current state. */
  transitions: PaperPositionTransition[];
  fills: PaperFill[];
}

export interface StrategyExposure {
  strategyId: string;
  openPositionCount: number;
  totalNotional: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
}

export interface UnderlyingExposure {
  underlying: string;
  openPositionCount: number;
  totalNotional: number;
}

export interface PortfolioSnapshot {
  sessionDate: string;
  timestamp: string;
  openPositionCount: number;
  closedPositionCount: number;
  totalNotional: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number | null;
  portfolioEquityDelta: number | null;
  strategyBreakdown: readonly StrategyExposure[];
  underlyingBreakdown: readonly UnderlyingExposure[];
  dataQuality: 'HEALTHY' | 'DEGRADED' | 'INCONSISTENT';
  stateVersion: number;
}

export interface PaperPortfolio {
  schemaVersion: 1;
  sessionDate: string;
  stateVersion: number;
  positions: PaperPosition[];
  inconsistent: boolean;
  updatedAt: string;
}
