import assert from 'node:assert/strict';
import test from 'node:test';
import { CreatePaperOrderDto } from '../dto/paper-order.dto';
import { PaperOrderExitReason, PaperOrderStatus } from '../types/paper-trading.types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import PaperOrderManagerService from './paper-order-manager.service';

function input(): CreatePaperOrderDto {
  return {
    signalTimestamp: new Date('2026-08-10T04:00:00.000Z'),
    signalType: StrategySignal.BUY_CE,
    contract: { instrumentKey: 'NSE_FO|example', tradingSymbol: 'NIFTY EXAMPLE CE', optionType: 'CE', strikePrice: 24_500, expiry: new Date('2026-08-13T00:00:00.000Z'), lotSize: 75, quantity: 75 },
    entry: { entryTimestamp: new Date('2026-08-10T04:00:00.000Z'), observedEntryPremium: 100, simulatedEntryPremium: 101 },
    exitConfiguration: { targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 },
  };
}

function close(exitReason: PaperOrderExitReason = PaperOrderStatus.TARGET_EXIT) {
  return { exitReason, exitTimestamp: new Date('2026-08-10T04:30:00.000Z'), observedExitPremium: 130, simulatedExitPremium: 129, grossPnl: 2100, charges: { brokerage: 40, stt: 10, exchangeTransactionCharges: 3, sebiCharges: 1, gst: 8, stampDuty: 2, otherCharges: 0 }, netPnl: 2036 };
}

test('creates a pending paper order with calculated target and stop premiums', () => {
  const order = new PaperOrderManagerService().create(input());
  assert.equal(order.status, PaperOrderStatus.PENDING);
  assert.equal(order.targetPremium, 131.3);
  assert.ok(Math.abs(order.stopPremium - 80.8) < 1e-10);
});

test('marks a pending order open', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input());
  assert.equal(manager.markOpen(pending.id).status, PaperOrderStatus.OPEN);
});

test('closes an open paper order at target', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input()); manager.markOpen(pending.id);
  const order = manager.close(pending.id, close(PaperOrderStatus.TARGET_EXIT));
  assert.equal(order.status, PaperOrderStatus.TARGET_EXIT);
  assert.equal(order.exit?.exitReason, PaperOrderStatus.TARGET_EXIT);
});

test('closes an open paper order at stop', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input()); manager.markOpen(pending.id);
  assert.equal(manager.close(pending.id, close(PaperOrderStatus.STOP_EXIT)).status, PaperOrderStatus.STOP_EXIT);
});

test('closes an open paper order at time exit', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input()); manager.markOpen(pending.id);
  assert.equal(manager.close(pending.id, close(PaperOrderStatus.TIME_EXIT)).status, PaperOrderStatus.TIME_EXIT);
});

test('cancels a pending order', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input());
  assert.equal(manager.updateStatus(pending.id, PaperOrderStatus.CANCELLED).status, PaperOrderStatus.CANCELLED);
});

test('rejects invalid lifecycle transitions', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input());
  assert.throws(() => manager.updateStatus(pending.id, PaperOrderStatus.TARGET_EXIT), /Invalid paper-order transition/);
  manager.markOpen(pending.id);
  assert.throws(() => manager.updateStatus(pending.id, PaperOrderStatus.CANCELLED), /Invalid paper-order transition/);
});

test('does not reopen a closed order', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input()); manager.markOpen(pending.id); manager.close(pending.id, close());
  assert.throws(() => manager.markOpen(pending.id), /Invalid paper-order transition/);
});

test('retrieves only pending and open orders as active', () => {
  const manager = new PaperOrderManagerService(); const pending = manager.create(input()); const open = manager.create(input()); const closed = manager.create(input());
  manager.markOpen(open.id); manager.markOpen(closed.id); manager.close(closed.id, close());
  assert.deepEqual(manager.getActiveOrders().map((order) => order.id).sort(), [pending.id, open.id].sort());
});

test('supports multiple simultaneous orders', () => {
  const manager = new PaperOrderManagerService(); const first = manager.create(input()); const second = manager.create({ ...input(), signalType: StrategySignal.BUY_PE, contract: { ...input().contract, optionType: 'PE', instrumentKey: 'NSE_FO|second' } });
  manager.markOpen(first.id); manager.markOpen(second.id);
  assert.equal(manager.getActiveOrders().filter((order) => order.status === PaperOrderStatus.OPEN).length, 2);
});

test('creates unique order ids', () => {
  const manager = new PaperOrderManagerService();
  assert.notEqual(manager.create(input()).id, manager.create(input()).id);
});

test('does not mutate caller input or returned snapshots', () => {
  const manager = new PaperOrderManagerService(); const request = input(); const original = structuredClone(request);
  const order = manager.create(request);
  request.contract.tradingSymbol = 'MUTATED'; request.entry.simulatedEntryPremium = 1; order.contract.tradingSymbol = 'MUTATED SNAPSHOT';
  const stored = manager.getById(order.id);
  assert.deepEqual(request.signalTimestamp, original.signalTimestamp);
  assert.equal(stored?.contract.tradingSymbol, original.contract.tradingSymbol);
  assert.equal(stored?.entry.simulatedEntryPremium, original.entry.simulatedEntryPremium);
});
