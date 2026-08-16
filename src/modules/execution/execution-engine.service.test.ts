import assert from 'node:assert/strict';
import test from 'node:test';
import ExecutionEngineService, { ExecutionStateTransitionError } from './execution-engine.service';
import { InMemoryExecutionRepository } from './execution.repository';
import { PaperExecutionFillSummary } from '../paper-trading/dto/paper-fill-model.dto';

const time = new Date('2026-08-14T04:00:00.000Z');
const session = '2026-08-14';
const fill = (quantity = 10, price = 101): PaperExecutionFillSummary => ({ status:quantity === 10 ? 'FILLED' : 'PARTIALLY_FILLED', requestedQuantity:10, filledQuantity:quantity, averageFillPrice:price, worstFillPrice:price, quotedBestPrice:100, fillQuality:'TOP_OF_BOOK_ESTIMATE', slippageVsBestQuote:1, slippageVsLtp:1, spreadCost:1, depthSlippage:0, totalExecutionSlippage:1, slippagePercent:1, sourceTimestamp:time.toISOString(), quoteDataQuality:'FRESH_TOP_OF_BOOK' });
const intent = (id = 'intent-a') => ({ intentId:id, strategyId:'V2_TREND_DOWN_PE', runtimeId:'paper:v2', sessionDate:session, instrumentKey:'NSE_FO|one', side:'BUY_PE' as const, quantity:10, requestedPrice:100, executionMode:'PAPER' as const, timestamp:time.toISOString(), correlationId:'corr-a' });
const engine = (repository = new InMemoryExecutionRepository()) => new ExecutionEngineService(repository, () => time);

test('one intent maps deterministically to one execution order with valid entry lifecycle', () => {
  const service = engine(); const first = service.createRiskApprovedOrder(intent()); const second = service.createRiskApprovedOrder(intent());
  assert.equal(first.executionOrderId, second.executionOrderId); assert.equal(first.status, 'ACKNOWLEDGED');
  const filled = service.recordEntryFill(first.executionOrderId, session, fill());
  assert.equal(filled.status, 'FILLED'); assert.equal(filled.cumulativeFilledQuantity, 10); assert.equal(filled.remainingQuantity, 0);
});

test('partial entry uses actual filled quantity and duplicate fill is harmless', () => {
  const service = engine(); const order = service.createRiskApprovedOrder(intent()); const first = service.recordEntryFill(order.executionOrderId, session, fill(6, 101));
  assert.equal(first.status, 'PARTIALLY_FILLED'); assert.equal(first.cumulativeFilledQuantity, 6); assert.equal(first.remainingQuantity, 4);
  const duplicate = service.recordEntryFill(order.executionOrderId, session, fill(6, 101));
  assert.equal(duplicate.cumulativeFilledQuantity, 6);
});

test('partial exit does not close exposure until exit quantity reaches zero', () => {
  const service = engine(); const order = service.createRiskApprovedOrder(intent()); service.recordEntryFill(order.executionOrderId, session, fill()); service.requestExit(order.executionOrderId, session);
  const partial = service.recordExitFill(order.executionOrderId, session, fill(6, 99));
  assert.equal(partial.status, 'PARTIALLY_FILLED'); assert.equal(partial.remainingQuantity, 4);
  service.requestExit(order.executionOrderId, session);
  const closed = service.recordExitFill(order.executionOrderId, session, fill(4, 98));
  assert.equal(closed.status, 'CLOSED'); assert.equal(closed.remainingQuantity, 0);
});

test('invalid transitions and overfills fail closed', () => {
  const service = engine(); const order = service.createRiskApprovedOrder(intent());
  assert.throws(() => service.recordExitFill(order.executionOrderId, session, fill()), ExecutionStateTransitionError);
  assert.throws(() => service.recordEntryFill(order.executionOrderId, session, fill(11)), ExecutionStateTransitionError);
});

test('restart reconciliation recovers durable totals but blocks missing paper order mapping', () => {
  const repository = new InMemoryExecutionRepository(); const first = engine(repository); const order = first.createRiskApprovedOrder(intent()); first.recordEntryFill(order.executionOrderId, session, fill());
  const restarted = engine(repository); const blocked = restarted.reconcile(session, []);
  assert.equal(blocked.status, 'RECONCILIATION_REQUIRED'); assert.equal(restarted.getHealth(session).ready, false);
  const valid = restarted.reconcile(session, ['paper-a']);
  // Mapping has not yet been attached, so it remains deliberately fail-closed.
  assert.equal(valid.status, 'RECONCILIATION_REQUIRED');
});

test('attached paper order permits consistent restart reconciliation and no zero-exposure assumption', () => {
  const repository = new InMemoryExecutionRepository(); const first = engine(repository); const order = first.createRiskApprovedOrder(intent()); first.recordEntryFill(order.executionOrderId, session, fill()); first.attachPaperOrder(order.executionOrderId, session, 'paper-a');
  const restarted = engine(repository); const result = restarted.reconcile(session, ['paper-a']);
  assert.equal(result.status, 'CONSISTENT'); assert.equal(restarted.getHealth(session).ready, true); assert.equal(restarted.getById(order.executionOrderId, session)?.cumulativeFilledQuantity, 10);
});

test('irreconcilable duplicate durable fills halt future exposure', () => {
  const repository = new InMemoryExecutionRepository(); const service = engine(repository); const order = service.createRiskApprovedOrder(intent()); service.recordEntryFill(order.executionOrderId, session, fill()); service.attachPaperOrder(order.executionOrderId, session, 'paper-a');
  const state = repository.load(session)!; state.orders[0].fills.push({ ...state.orders[0].fills[0] }); repository.save(state);
  const restarted = engine(repository); const result = restarted.reconcile(session, ['paper-a']);
  assert.equal(result.status, 'IRRECONCILABLE'); assert.equal(restarted.getHealth(session).reconciliationRequired, true);
});
