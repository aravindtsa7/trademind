import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { CreatePaperOrderDto } from '../dto/paper-order.dto';
import { PaperOrderStatus } from '../types/paper-trading.types';
import PaperMarketDataAdapterService from './paper-market-data-adapter.service';
import PaperOrderManagerService from './paper-order-manager.service';
import PaperPositionMonitorService from './paper-position-monitor.service';

const entryTimestamp = new Date('2026-08-10T04:00:00.000Z');

function input(instrumentKey = 'NSE_FO|one'): CreatePaperOrderDto {
  return {
    signalTimestamp: new Date(entryTimestamp.getTime()), signalType: StrategySignal.BUY_CE,
    contract: { instrumentKey, tradingSymbol: instrumentKey, optionType: 'CE', strikePrice: 24_500, expiry: new Date('2026-08-13T00:00:00.000Z'), lotSize: 75, quantity: 75 },
    entry: { entryTimestamp: new Date(entryTimestamp.getTime()), observedEntryPremium: 100, simulatedEntryPremium: 100 },
    exitConfiguration: { targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 },
  };
}

function setup() {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const monitor = new PaperPositionMonitorService(manager); const adapter = new PaperMarketDataAdapterService(monitor, bus);
  return { manager, bus, adapter };
}

function open(manager: PaperOrderManagerService, key = 'NSE_FO|one') { const order = manager.create(input(key)); return manager.markOpen(order.id); }
function tick(instrumentKey: string, ltp: number, minute = 1) { return { instrumentKey, timestamp: new Date(entryTimestamp.getTime() + minute * 60_000).toISOString(), ltp }; }

test('start registers one market.tick listener', () => {
  const { bus, adapter } = setup(); const before = bus.listenerCount('market.tick'); adapter.start();
  assert.equal(bus.listenerCount('market.tick'), before + 1);
});

test('duplicate start does not duplicate the listener', () => {
  const { bus, adapter } = setup(); adapter.start(); const count = bus.listenerCount('market.tick'); adapter.start();
  assert.equal(bus.listenerCount('market.tick'), count);
});

test('stop removes the listener and duplicate stop is safe', () => {
  const { bus, adapter } = setup(); adapter.start(); adapter.stop(); assert.equal(bus.listenerCount('market.tick'), 0); adapter.stop();
  assert.equal(bus.listenerCount('market.tick'), 0);
});

test('forwards a valid tick to monitoring without an exit', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); adapter.start(); bus.emit('market.tick', tick(order.contract.instrumentKey, 100));
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});

test('propagates target exits on the shared event bus', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); const actions: unknown[] = []; bus.on('paper.order.action', (action) => actions.push(action)); adapter.start(); bus.emit('market.tick', tick(order.contract.instrumentKey, 130));
  assert.equal((actions[0] as { action: string }).action, PaperOrderStatus.TARGET_EXIT);
});

test('propagates stop exits on the shared event bus', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); const actions: unknown[] = []; bus.on('paper.order.action', (action) => actions.push(action)); adapter.start(); bus.emit('market.tick', tick(order.contract.instrumentKey, 80));
  assert.equal((actions[0] as { action: string }).action, PaperOrderStatus.STOP_EXIT);
});

test('propagates time exits on the shared event bus', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); const actions: unknown[] = []; bus.on('paper.order.action', (action) => actions.push(action)); adapter.start(); bus.emit('market.tick', tick(order.contract.instrumentKey, 100, 60));
  assert.equal((actions[0] as { action: string }).action, PaperOrderStatus.TIME_EXIT);
});

test('ignores malformed ticks', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); adapter.start(); bus.emit('market.tick', {}); bus.emit('market.tick', { instrumentKey: order.contract.instrumentKey, ltp: 100 });
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});

test('ignores non-positive and non-finite premiums', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); adapter.start(); bus.emit('market.tick', tick(order.contract.instrumentKey, 0)); bus.emit('market.tick', tick(order.contract.instrumentKey, Number.NaN));
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});

test('does not mutate incoming tick data', () => {
  const { manager, bus, adapter } = setup(); const order = open(manager); const event = tick(order.contract.instrumentKey, 100); const original = structuredClone(event); adapter.start(); bus.emit('market.tick', event);
  assert.deepEqual(event, original);
});

test('matches multiple open orders for the same instrument', () => {
  const { manager, bus, adapter } = setup(); const first = open(manager); const second = open(manager); const actions: unknown[] = []; bus.on('paper.order.action', (action) => actions.push(action)); adapter.start(); bus.emit('market.tick', tick(first.contract.instrumentKey, 130));
  assert.equal(actions.length, 2); assert.equal(manager.getById(second.id)?.status, PaperOrderStatus.TARGET_EXIT);
});

test('handles multiple instruments and stopped adapters', () => {
  const { manager, bus, adapter } = setup(); const first = open(manager, 'NSE_FO|one'); const second = open(manager, 'NSE_FO|two'); adapter.start(); bus.emit('market.tick', tick(first.contract.instrumentKey, 130));
  assert.equal(manager.getById(first.id)?.status, PaperOrderStatus.TARGET_EXIT); assert.equal(manager.getById(second.id)?.status, PaperOrderStatus.OPEN);
  adapter.stop(); bus.emit('market.tick', tick(second.contract.instrumentKey, 130));
  assert.equal(manager.getById(second.id)?.status, PaperOrderStatus.OPEN);
});
