import { createHash } from 'crypto';
import logger from '../../core/logger/logger';
import { PaperExecutionFillSummary } from '../paper-trading/dto/paper-fill-model.dto';
import { ExecutionRepository, FileExecutionRepository } from './execution.repository';
import { DurableExecutionState, ExecutionFill, ExecutionHealth, ExecutionIntent, ExecutionOrder, ExecutionOrderStatus, ExecutionReconciliationResult } from './execution.types';

const transitions: Readonly<Record<ExecutionOrderStatus, readonly ExecutionOrderStatus[]>> = {
  CREATED: ['RISK_APPROVED', 'REJECTED', 'RECONCILIATION_REQUIRED', 'FAULTED'], RISK_APPROVED: ['SUBMISSION_PENDING', 'REJECTED', 'RECONCILIATION_REQUIRED', 'FAULTED'],
  SUBMISSION_PENDING: ['SUBMITTED', 'REJECTED', 'RECONCILIATION_REQUIRED', 'FAULTED'], SUBMITTED: ['ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCEL_PENDING', 'RECONCILIATION_REQUIRED', 'FAULTED'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCEL_PENDING', 'RECONCILIATION_REQUIRED', 'FAULTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED', 'FAULTED'], FILLED: ['EXIT_PENDING', 'RECONCILIATION_REQUIRED', 'FAULTED'],
  CANCEL_PENDING: ['CANCELLED', 'RECONCILIATION_REQUIRED', 'FAULTED'], CANCELLED: [], REJECTED: [], EXIT_PENDING: ['PARTIALLY_FILLED', 'CLOSED', 'RECONCILIATION_REQUIRED', 'FAULTED'],
  CLOSED: [], RECONCILIATION_REQUIRED: [], FAULTED: [],
};

export class ExecutionStateTransitionError extends Error { constructor(message: string) { super(message); this.name = 'ExecutionStateTransitionError'; } }
export class DuplicateExecutionIntentError extends Error { constructor(public readonly intentId: string) { super(`Execution intent ${intentId} already has a durable order.`); this.name = 'DuplicateExecutionIntentError'; } }

/**
 * Broker-neutral durable event owner. The paper adapter supplies fills; this
 * service never invokes a broker API and invalid state is deliberately
 * unrecoverable for new exposure until reconciliation succeeds.
 */
export default class ExecutionEngineService {
  private readonly stateBySession = new Map<string, DurableExecutionState>();
  private readonly healthBySession = new Map<string, ExecutionHealth>();
  constructor(private readonly repository: ExecutionRepository = new FileExecutionRepository(), private readonly now = () => new Date()) {}

  createRiskApprovedOrder(intent: ExecutionIntent): ExecutionOrder {
    this.validateIntent(intent); const state = this.state(intent.sessionDate);
    const existing = state.orders.find((order) => order.intentId === intent.intentId);
    if (existing) return clone(existing);
    const createdAt = this.now().toISOString(); const executionOrderId = id('execution-order', intent.intentId);
    const order: ExecutionOrder = { executionOrderId, intentId:intent.intentId, strategyId:intent.strategyId, runtimeId:intent.runtimeId, sessionDate:intent.sessionDate, instrumentKey:intent.instrumentKey, side:intent.side, quantity:intent.quantity, requestedPrice:intent.requestedPrice, executionMode:'PAPER', status:'CREATED', cumulativeFilledQuantity:0, cumulativeExitQuantity:0, remainingQuantity:intent.quantity, averageFillPrice:null, averageExitPrice:null, createdAt, updatedAt:createdAt, correlationId:intent.correlationId, version:0, fills:[], transitions:[] };
    this.transitionInternal(order, 'RISK_APPROVED'); this.transitionInternal(order, 'SUBMISSION_PENDING'); this.transitionInternal(order, 'SUBMITTED'); this.transitionInternal(order, 'ACKNOWLEDGED'); state.orders.push(order); this.persist(state); logger.info('EXECUTION_ORDER_CREATED', log(order)); return clone(order);
  }

  getByIntent(intentId: string, sessionDate: string): ExecutionOrder | undefined { return this.state(sessionDate).orders.find((order) => order.intentId === intentId) ? clone(this.state(sessionDate).orders.find((order) => order.intentId === intentId) as ExecutionOrder) : undefined; }
  getById(executionOrderId: string, sessionDate: string): ExecutionOrder | undefined { const order = this.state(sessionDate).orders.find((item) => item.executionOrderId === executionOrderId); return order ? clone(order) : undefined; }
  attachPaperOrder(executionOrderId: string, sessionDate: string, paperOrderId: string): ExecutionOrder {
    const order = this.require(executionOrderId, sessionDate); if (order.paperOrderId && order.paperOrderId !== paperOrderId) throw new ExecutionStateTransitionError('Execution order already maps to a different paper order.');
    order.paperOrderId = paperOrderId; this.persist(this.state(sessionDate)); return clone(order);
  }
  recordEntryFill(executionOrderId: string, sessionDate: string, summary: PaperExecutionFillSummary, timestamp = this.now()): ExecutionOrder {
    return this.recordFill(executionOrderId, sessionDate, 'ENTRY', summary, timestamp);
  }
  requestExit(executionOrderId: string, sessionDate: string): ExecutionOrder {
    const order = this.require(executionOrderId, sessionDate); if (order.status === 'CLOSED') return clone(order); if (order.status !== 'EXIT_PENDING') this.transitionInternal(order, 'EXIT_PENDING'); this.persist(this.state(sessionDate)); return clone(order);
  }
  recordExitFill(executionOrderId: string, sessionDate: string, summary: PaperExecutionFillSummary, timestamp = this.now()): ExecutionOrder {
    return this.recordFill(executionOrderId, sessionDate, 'EXIT', summary, timestamp);
  }
  cancelResidual(executionOrderId: string, sessionDate: string): ExecutionOrder {
    const order = this.require(executionOrderId, sessionDate); if (order.status === 'CANCELLED') return clone(order); this.transitionInternal(order, 'CANCEL_PENDING'); this.transitionInternal(order, 'CANCELLED'); this.persist(this.state(sessionDate)); return clone(order);
  }
  reject(executionOrderId: string, sessionDate: string, reason: string): ExecutionOrder {
    const order = this.require(executionOrderId, sessionDate); if (order.status === 'REJECTED') return clone(order);
    this.transitionInternal(order, 'REJECTED', reason); this.persist(this.state(sessionDate)); return clone(order);
  }
  reconcile(sessionDate: string, knownPaperOrderIds: readonly string[] = []): ExecutionReconciliationResult {
    const state = this.state(sessionDate); const known = new Set(knownPaperOrderIds); const unresolved: string[] = []; const repaired: string[] = []; const errors: string[] = [];
    for (const order of state.orders) {
      const entry = order.fills.filter((fill) => fill.leg === 'ENTRY'); const exit = order.fills.filter((fill) => fill.leg === 'EXIT');
      const entryQuantity = entry.reduce((sum, fill) => sum + fill.quantity, 0); const exitQuantity = exit.reduce((sum, fill) => sum + fill.quantity, 0);
      if (entryQuantity > order.quantity || exitQuantity > entryQuantity || new Set(order.fills.map((fill) => fill.fillId)).size !== order.fills.length) { errors.push(`IRRECONCILABLE:${order.executionOrderId}`); continue; }
      if (entryQuantity !== order.cumulativeFilledQuantity || exitQuantity !== order.cumulativeExitQuantity) { order.cumulativeFilledQuantity = entryQuantity; order.cumulativeExitQuantity = exitQuantity; order.remainingQuantity = order.status === 'EXIT_PENDING' || order.status === 'CLOSED' ? entryQuantity - exitQuantity : order.quantity - entryQuantity; repaired.push(order.executionOrderId); }
      if (order.status === 'RECONCILIATION_REQUIRED' || ((order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED' || order.status === 'EXIT_PENDING') && (!order.paperOrderId || !known.has(order.paperOrderId)))) unresolved.push(order.executionOrderId);
    }
    const status = errors.length ? 'IRRECONCILABLE' : unresolved.length ? 'RECONCILIATION_REQUIRED' : repaired.length ? 'REPAIRED_FROM_DURABLE_EVENTS' : 'CONSISTENT';
    const result: ExecutionReconciliationResult = { sessionDate, status, unresolvedOrderIds:unresolved, repairedOrderIds:repaired, errors, timestamp:this.now().toISOString() };
    state.reconciliation = result; if (status !== 'CONSISTENT' && status !== 'REPAIRED_FROM_DURABLE_EVENTS') for (const id of unresolved) { const order = this.require(id, sessionDate); if (order.status !== 'RECONCILIATION_REQUIRED') this.transitionInternal(order, 'RECONCILIATION_REQUIRED', status); }
    this.healthBySession.set(sessionDate, { ready:status === 'CONSISTENT' || status === 'REPAIRED_FROM_DURABLE_EVENTS', reconciliationRequired:status === 'RECONCILIATION_REQUIRED' || status === 'IRRECONCILABLE', status }); this.persist(state);
    logger.info(status === 'IRRECONCILABLE' ? 'EXECUTION_RECONCILIATION_FAILED' : 'EXECUTION_RECONCILIATION_COMPLETED', { sessionDate, status, unresolvedOrderIds:unresolved, repairedOrderIds:repaired, errors }); return clone(result);
  }
  getHealth(sessionDate: string): ExecutionHealth { return this.healthBySession.get(sessionDate) ?? { ready:false, reconciliationRequired:true, status:'NOT_STARTED' }; }

  private recordFill(executionOrderId: string, sessionDate: string, leg: 'ENTRY'|'EXIT', summary: PaperExecutionFillSummary, timestamp: Date): ExecutionOrder {
    const order = this.require(executionOrderId, sessionDate); if (!summary || !Number.isInteger(summary.filledQuantity) || summary.filledQuantity <= 0 || !Number.isFinite(summary.averageFillPrice) || summary.averageFillPrice <= 0) throw new ExecutionStateTransitionError('Execution fill must contain a positive filled quantity and price.');
    if (leg === 'EXIT' && order.status !== 'EXIT_PENDING') throw new ExecutionStateTransitionError('Exit fill requires EXIT_PENDING.');
    const fillId = id(`execution-fill-${leg.toLowerCase()}`, `${executionOrderId}|${timestamp.toISOString()}|${summary.filledQuantity}|${summary.averageFillPrice}`);
    if (order.fills.some((fill) => fill.fillId === fillId)) return clone(order);
    const allowed = leg === 'ENTRY' ? order.quantity - order.cumulativeFilledQuantity : order.cumulativeFilledQuantity - order.cumulativeExitQuantity;
    if (summary.filledQuantity > allowed) throw new ExecutionStateTransitionError('Execution fill exceeds remaining quantity.');
    const fill: ExecutionFill = { fillId, executionOrderId, leg, quantity:summary.filledQuantity, price:summary.averageFillPrice, timestamp:timestamp.toISOString(), source:'PAPER_FILL_MODEL', quoteQuality:summary.fillQuality, slippage:summary.totalExecutionSlippage, correlationId:order.correlationId };
    order.fills.push(fill);
    if (leg === 'ENTRY') { const prior = order.cumulativeFilledQuantity; order.cumulativeFilledQuantity += fill.quantity; order.remainingQuantity = order.quantity - order.cumulativeFilledQuantity; order.averageFillPrice = weighted(order.averageFillPrice, prior, fill.price, fill.quantity); this.transitionInternal(order, order.remainingQuantity === 0 ? 'FILLED' : 'PARTIALLY_FILLED'); }
    else { const prior = order.cumulativeExitQuantity; order.cumulativeExitQuantity += fill.quantity; order.remainingQuantity = order.cumulativeFilledQuantity - order.cumulativeExitQuantity; order.averageExitPrice = weighted(order.averageExitPrice, prior, fill.price, fill.quantity); this.transitionInternal(order, order.remainingQuantity === 0 ? 'CLOSED' : 'PARTIALLY_FILLED'); }
    this.persist(this.state(sessionDate)); logger.info(leg === 'ENTRY' && order.status === 'PARTIALLY_FILLED' ? 'EXECUTION_PARTIAL_FILL' : 'EXECUTION_FILL_RECORDED', log(order)); return clone(order);
  }
  private transitionInternal(order: ExecutionOrder, next: ExecutionOrderStatus, reason?: string): void {
    if (order.status === next) return; if (!transitions[order.status].includes(next)) throw new ExecutionStateTransitionError(`Invalid execution transition: ${order.status} -> ${next}.`);
    const previousState = order.status; order.status = next; order.version += 1; order.updatedAt = this.now().toISOString(); order.transitions.push({ transitionId:id('execution-transition', `${order.executionOrderId}|${order.version}|${next}`), executionOrderId:order.executionOrderId, previousState, nextState:next, timestamp:order.updatedAt, reason, correlationId:order.correlationId }); logger.info('EXECUTION_STATE_CHANGED', { ...log(order), previousState, newState:next, reason:reason ?? null });
  }
  private state(sessionDate: string): DurableExecutionState { let state = this.stateBySession.get(sessionDate); if (!state) { try { state = this.repository.load(sessionDate); } catch (error) { throw new ExecutionStateTransitionError(`Unable to load durable execution state: ${error instanceof Error ? error.message : 'unknown error'}`); } if (!state) state = { schemaVersion:1, sessionDate, orders:[], reconciliation:null, updatedAt:this.now().toISOString() }; this.stateBySession.set(sessionDate, state); } return state; }
  private persist(state: DurableExecutionState): void { state.updatedAt = this.now().toISOString(); this.repository.save(clone(state)); }
  private require(idValue: string, sessionDate: string): ExecutionOrder { const order = this.state(sessionDate).orders.find((item) => item.executionOrderId === idValue); if (!order) throw new ExecutionStateTransitionError(`Execution order ${idValue} was not found.`); return order; }
  private validateIntent(intent: ExecutionIntent): void { if (!intent || !intent.intentId || !intent.strategyId || !intent.runtimeId || !intent.sessionDate || !intent.instrumentKey || !intent.correlationId || (intent.side !== 'BUY_CE' && intent.side !== 'BUY_PE') || !Number.isInteger(intent.quantity) || intent.quantity <= 0 || !Date.parse(intent.timestamp)) throw new ExecutionStateTransitionError('Invalid execution intent.'); }
}

function id(prefix: string, value: string): string { return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`; }
function weighted(previousPrice: number | null, previousQuantity: number, price: number, quantity: number): number { return ((previousPrice ?? 0) * previousQuantity + price * quantity) / (previousQuantity + quantity); }
function log(order: ExecutionOrder): Record<string, unknown> { return { orderId:order.executionOrderId, intentId:order.intentId, strategyId:order.strategyId, instrument:order.instrumentKey, status:order.status, quantity:order.quantity, filledQuantity:order.cumulativeFilledQuantity, remainingQuantity:order.remainingQuantity, correlationId:order.correlationId }; }
function clone<T>(value: T): T { return structuredClone(value); }
