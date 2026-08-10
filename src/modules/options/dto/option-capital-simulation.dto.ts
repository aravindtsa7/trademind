import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';

export type CapitalSimulationRejectionReason = 'INSUFFICIENT_CAPITAL';

/**
 * A completed one-lot trade supplied by historical research. When entryCharges
 * are unavailable, the simulator locks entryValue only and applies totalCharges
 * through the pre-calculated netPnl when the trade exits.
 */
export interface OptionCapitalSimulationTradeInput {
  signalTimestamp: Date;
  exitTimestamp: Date;
  signalType: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  instrumentKey: string;
  tradingSymbol: string;
  /** Quantity must represent exactly one already-resolved option lot. */
  quantity: number;
  entryPremium: number;
  exitPremium: number;
  entryValue: number;
  totalCharges: number;
  netPnl: number;
  /** Optional known entry-side charge included in capital lock requirements. */
  entryCharges?: number;
}

export interface OptionCapitalSimulationRequest {
  initialCapital: number;
  trades: readonly OptionCapitalSimulationTradeInput[];
}

export interface SimulatedOptionTrade extends OptionCapitalSimulationTradeInput {
  executed: boolean;
  capitalBefore: number;
  capitalLocked: number;
  availableCashAfterEntry: number;
  capitalAfterExit: number | null;
  rejectionReason: CapitalSimulationRejectionReason | null;
}

export interface OptionCapitalEquityEvent {
  timestamp: Date;
  type: 'INITIAL' | 'ENTRY' | 'EXIT';
  instrumentKey?: string;
  availableCash: number;
  capitalDeployed: number;
  equity: number;
}

export interface OptionCapitalSimulationResult {
  initialCapital: number;
  finalCapital: number;
  totalNetPnl: number;
  returnPercent: number;
  totalCandidateTrades: number;
  executedTrades: number;
  rejectedTrades: number;
  profitableTrades: number;
  losingTrades: number;
  maximumCapitalDeployed: number;
  averageCapitalDeployed: number;
  maximumSimultaneousPositions: number;
  minimumAvailableCash: number;
  insufficientCapitalRejectedTrades: number;
  equityEvents: OptionCapitalEquityEvent[];
  peakEquity: number;
  minimumEquity: number;
  maximumDrawdownAmount: number;
  maximumDrawdownPercent: number;
  trades: SimulatedOptionTrade[];
}
