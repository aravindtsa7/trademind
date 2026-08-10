import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import { Candle } from '../../indicators/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from '../dto/live-paper-strategy.dto';
import { PaperTradingRuntimeState } from '../dto/paper-trading-runtime.dto';
import { PaperOrderStatus } from '../types/paper-trading.types';
import PaperTradingRuntimeService from './paper-trading-runtime.service';

function input(): LivePaperCompletedCandleInput {
  const candle: Candle = { timestamp: new Date('2026-08-10T04:00:00.000Z'), open: 24_600, high: 24_610, low: 24_590, close: 24_605, volume: 1 };
  return { candle, completed: true, contracts: [] };
}

function result(overrides: Partial<LivePaperStrategyResult> = {}): LivePaperStrategyResult {
  return {
    candleTimestamp: new Date('2026-08-10T04:00:00.000Z'), spotPrice: 24_605, ema15: 1, ema35: 1, rsi14: 50,
    rawEmaSignal: StrategySignal.NO_TRADE, timeFilterAllowed: true, finalSignal: StrategySignal.NO_TRADE,
    reasons: ['test'], processed: true, ...overrides,
  };
}

class StrategyAdapterMock {
  calls = 0;
  next = result();
  async processCompletedCandle(_input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> { this.calls += 1; return structuredClone(this.next); }
}

class MarketAdapterMock {
  starts = 0;
  stops = 0;
  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }
}

class OrderManagerMock {
  active: unknown[] = [];
  getActiveOrders() { return this.active as never[]; }
}

function setup() {
  const strategy = new StrategyAdapterMock(); const market = new MarketAdapterMock(); const orders = new OrderManagerMock(); const bus = new EventEmitter();
  return { strategy, market, orders, bus, runtime: new PaperTradingRuntimeService(strategy, market, orders, bus) };
}

test('starts in STOPPED state', () => {
  const { runtime } = setup(); assert.equal(runtime.getState(), PaperTradingRuntimeState.STOPPED);
});

test('starts successfully and registers runtime listeners', () => {
  const { runtime, market, bus } = setup(); const status = runtime.start();
  assert.equal(status.state, PaperTradingRuntimeState.RUNNING); assert.equal(market.starts, 1); assert.equal(bus.listenerCount('paper.order.action'), 1);
});

test('duplicate start is idempotent', () => {
  const { runtime, market, bus } = setup(); runtime.start(); runtime.start();
  assert.equal(market.starts, 1); assert.equal(bus.listenerCount('paper.order.action'), 1);
});

test('stops successfully without closing active orders', () => {
  const { runtime, market, orders } = setup(); orders.active = [{ id: 'open' }]; runtime.start(); const stop = runtime.stop();
  assert.equal(stop.status.state, PaperTradingRuntimeState.STOPPED); assert.equal(stop.openOrdersRemaining, 1); assert.equal(market.stops, 1);
});

test('duplicate stop is idempotent', () => {
  const { runtime, market } = setup(); runtime.start(); runtime.stop(); runtime.stop();
  assert.equal(market.stops, 1);
});

test('delegates completed candle processing while running', async () => {
  const { runtime, strategy } = setup(); runtime.start(); const output = await runtime.processCompletedCandle(input());
  assert.equal(strategy.calls, 1); assert.equal(output.finalSignal, StrategySignal.NO_TRADE); assert.equal(runtime.getStatus().completedCandlesProcessed, 1);
});

test('rejects candle processing while stopped', async () => {
  const { runtime, strategy } = setup(); await assert.rejects(() => runtime.processCompletedCandle(input()), /must be RUNNING/);
  assert.equal(strategy.calls, 0);
});

test('counts paper order creations', async () => {
  const { runtime, strategy } = setup(); strategy.next = result({ rawEmaSignal: StrategySignal.BUY_CE, finalSignal: StrategySignal.BUY_CE, orchestration: {} as never }); runtime.start(); await runtime.processCompletedCandle(input());
  assert.equal(runtime.getStatus().paperOrdersCreated, 1);
});

test('counts no-trade evaluations', async () => {
  const { runtime } = setup(); runtime.start(); await runtime.processCompletedCandle(input());
  assert.equal(runtime.getStatus().noTradeEvaluations, 1);
});

test('counts filtered signals as no-trade evaluations', async () => {
  const { runtime, strategy } = setup(); strategy.next = result({ rawEmaSignal: StrategySignal.BUY_CE, timeFilterAllowed: false, finalSignal: StrategySignal.NO_TRADE }); runtime.start(); await runtime.processCompletedCandle(input());
  const status = runtime.getStatus(); assert.equal(status.filteredSignals, 1); assert.equal(status.noTradeEvaluations, 1);
});

test('counts target, stop, and time exits from shared events', () => {
  const { runtime, bus } = setup(); runtime.start();
  bus.emit('paper.order.action', { action: PaperOrderStatus.TARGET_EXIT }); bus.emit('paper.order.action', { action: PaperOrderStatus.STOP_EXIT }); bus.emit('paper.order.action', { action: PaperOrderStatus.TIME_EXIT });
  const status = runtime.getStatus(); assert.equal(status.targetExits, 1); assert.equal(status.stopExits, 1); assert.equal(status.timeExits, 1);
});

test('reports active-order count in status', () => {
  const { runtime, orders } = setup(); orders.active = [{ id: 'one' }, { id: 'two' }];
  assert.equal(runtime.getStatus().activeOrderCount, 2);
});

test('cleans up paper.order.action listener on stop', () => {
  const { runtime, bus } = setup(); runtime.start(); runtime.stop(); bus.emit('paper.order.action', { action: PaperOrderStatus.TARGET_EXIT });
  assert.equal(bus.listenerCount('paper.order.action'), 0); assert.equal(runtime.getStatus().targetExits, 0);
});

test('does not mutate completed-candle input', async () => {
  const { runtime } = setup(); const request = input(); const original = structuredClone(request); runtime.start(); await runtime.processCompletedCandle(request);
  assert.deepEqual(request, original);
});
