/**
 * Durable, broker-neutral lifecycle.  `ExecutionOrder` represents one paper
 * round trip today; an eventual broker adapter can use the same intent/order/
 * fill vocabulary without leaking broker state into strategies.
 */
export type ExecutionOrderStatus =
  | 'CREATED' | 'RISK_APPROVED' | 'SUBMISSION_PENDING' | 'SUBMITTED'
  | 'ACKNOWLEDGED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCEL_PENDING'
  | 'CANCELLED' | 'REJECTED' | 'EXIT_PENDING' | 'CLOSED'
  | 'RECONCILIATION_REQUIRED' | 'FAULTED';

export type ExecutionFillLeg = 'ENTRY' | 'EXIT';
export type ExecutionReconciliationStatus = 'CONSISTENT' | 'REPAIRED_FROM_DURABLE_EVENTS' | 'RECONCILIATION_REQUIRED' | 'IRRECONCILABLE';

export interface ExecutionIntent {
  intentId: string;
  strategyId: string;
  runtimeId: string;
  sessionDate: string;
  instrumentKey: string;
  side: 'BUY_CE' | 'BUY_PE';
  quantity: number;
  requestedPrice?: number;
  executionMode: 'PAPER';
  timestamp: string;
  correlationId: string;
}

export interface ExecutionFill {
  fillId: string;
  executionOrderId: string;
  leg: ExecutionFillLeg;
  quantity: number;
  price: number;
  timestamp: string;
  source: 'PAPER_FILL_MODEL';
  quoteQuality: string;
  slippage: number;
  correlationId: string;
}

export interface ExecutionStateTransition {
  transitionId: string;
  executionOrderId: string;
  previousState: ExecutionOrderStatus | null;
  nextState: ExecutionOrderStatus;
  timestamp: string;
  reason?: string;
  correlationId: string;
}

export interface ExecutionOrder {
  executionOrderId: string;
  intentId: string;
  strategyId: string;
  runtimeId: string;
  sessionDate: string;
  instrumentKey: string;
  side: 'BUY_CE' | 'BUY_PE';
  quantity: number;
  requestedPrice?: number;
  executionMode: 'PAPER';
  status: ExecutionOrderStatus;
  cumulativeFilledQuantity: number;
  cumulativeExitQuantity: number;
  remainingQuantity: number;
  averageFillPrice: number | null;
  averageExitPrice: number | null;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  version: number;
  externalOrderId?: string;
  paperOrderId?: string;
  fills: ExecutionFill[];
  transitions: ExecutionStateTransition[];
}

export interface ExecutionReconciliationResult {
  sessionDate: string;
  status: ExecutionReconciliationStatus;
  unresolvedOrderIds: readonly string[];
  repairedOrderIds: readonly string[];
  errors: readonly string[];
  timestamp: string;
}

export interface DurableExecutionState {
  schemaVersion: 1;
  sessionDate: string;
  orders: ExecutionOrder[];
  reconciliation: ExecutionReconciliationResult | null;
  updatedAt: string;
}

export interface ExecutionHealth {
  ready: boolean;
  reconciliationRequired: boolean;
  status: ExecutionReconciliationStatus | 'NOT_STARTED';
}
