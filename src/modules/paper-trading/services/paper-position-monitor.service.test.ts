import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { CreatePaperOrderDto } from '../dto/paper-order.dto';
import { PaperOrderStatus, PaperPremiumUpdate } from '../types/paper-trading.types';
import PaperOrderManagerService from './paper-order-manager.service';
import PaperPortfolioService, { InMemoryPaperPortfolioRepository } from './paper-portfolio.service';
import PaperFillModelService from './paper-fill-model.service';
import PaperPositionMonitorService from './paper-position-monitor.service';

const entryTime = new Date('2026-08-10T04:00:00.000Z');

function orderInput(instrumentKey = 'NSE_FO|first'): CreatePaperOrderDto {
  return {
    signalTimestamp: new Date(entryTime.getTime()),
    signalType: StrategySignal.BUY_CE,
    contract: { instrumentKey, tradingSymbol: `NIFTY ${instrumentKey}`, optionType: 'CE', strikePrice: 24_500, expiry: new Date('2026-08-13T00:00:00.000Z'), lotSize: 75, quantity: 75 },
    entry: { entryTimestamp: new Date(entryTime.getTime()), observedEntryPremium: 100, simulatedEntryPremium: 100 },
    exitConfiguration: { targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 },
  };
}

function update(instrumentKey: string, premium: number, minutes = 1): PaperPremiumUpdate {
  return { instrumentKey, premium, timestamp: new Date(entryTime.getTime() + minutes * 60_000) };
}

function open(manager: PaperOrderManagerService, instrumentKey = 'NSE_FO|first') {
  const order = manager.create(orderInput(instrumentKey));
  return manager.markOpen(order.id);
}

test('returns NONE when premium is between target and stop', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const results = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 100));
  assert.equal(results[0].action, 'NONE');
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});

test('closes matching open order on target', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 130));
  assert.equal(result[0].action, PaperOrderStatus.TARGET_EXIT);
  assert.equal(manager.getById(order.id)?.exit?.simulatedExitPremium, 130);
});

test('closes matching open order on stop', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 80));
  assert.equal(result[0].action, PaperOrderStatus.STOP_EXIT);
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.STOP_EXIT);
});

test('closes matching open order on time limit', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 100, 60));
  assert.equal(result[0].action, PaperOrderStatus.TIME_EXIT);
});

test('uses target precedence over time exit', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 130, 60));
  assert.equal(result[0].action, PaperOrderStatus.TARGET_EXIT);
});

test('uses stop precedence over time exit', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 80, 60));
  assert.equal(result[0].action, PaperOrderStatus.STOP_EXIT);
});

test('ignores orders for a different instrument', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const result = new PaperPositionMonitorService(manager).monitor(update('NSE_FO|other', 130));
  assert.deepEqual(result, []);
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});

test('ignores pending orders', () => {
  const manager = new PaperOrderManagerService(); const order = manager.create(orderInput()); const result = new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 130));
  assert.deepEqual(result, []);
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.PENDING);
});

test('ignores already closed orders', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); manager.close(order.id, { exitReason: PaperOrderStatus.TARGET_EXIT, exitTimestamp: update(order.contract.instrumentKey, 130).timestamp, observedExitPremium: 130, simulatedExitPremium: 130 });
  assert.deepEqual(new PaperPositionMonitorService(manager).monitor(update(order.contract.instrumentKey, 140)), []);
});

test('processes multiple open orders for the same instrument', () => {
  const manager = new PaperOrderManagerService(); const first = open(manager); const second = open(manager); const results = new PaperPositionMonitorService(manager).monitor(update(first.contract.instrumentKey, 130));
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.action === PaperOrderStatus.TARGET_EXIT));
  assert.equal(manager.getById(second.id)?.status, PaperOrderStatus.TARGET_EXIT);
});

test('processes only the matching instrument among multiple instruments', () => {
  const manager = new PaperOrderManagerService(); const first = open(manager, 'NSE_FO|first'); const second = open(manager, 'NSE_FO|second'); const results = new PaperPositionMonitorService(manager).monitor(update(first.contract.instrumentKey, 130));
  assert.equal(results.length, 1);
  assert.equal(manager.getById(first.id)?.status, PaperOrderStatus.TARGET_EXIT);
  assert.equal(manager.getById(second.id)?.status, PaperOrderStatus.OPEN);
});

test('does not mutate the caller premium update', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const liveUpdate = update(order.contract.instrumentKey, 100); const original = structuredClone(liveUpdate);
  const result = new PaperPositionMonitorService(manager).monitor(liveUpdate);
  assert.deepEqual(liveUpdate, original);
  result[0].timestamp.setTime(0);
  assert.notEqual(manager.getById(order.id)?.entry.entryTimestamp.getTime(), 0);
});

test('V2 EOD uses the existing TIME_EXIT close path exactly once for an open paper position', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const monitor = new PaperPositionMonitorService(manager); const eod = new Date('2026-08-10T10:00:00.000Z');
  const first = monitor.closeAtSessionEnd(eod, () => 101); const second = monitor.closeAtSessionEnd(eod, () => 101);
  assert.equal(first[0].action, PaperOrderStatus.TIME_EXIT); assert.equal(first[0].observedPremium, 101); assert.deepEqual(second, []); assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.TIME_EXIT);
});

test('V2 target and EOD monitor callbacks update the authoritative portfolio exactly once', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager);
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => entryTime);
  portfolio.open({ order, strategyId: 'V2_TREND_DOWN_PE', underlying: 'NIFTY 50', correlationId: 'corr', intentId: 'intent', sessionDate: '2026-08-10' });
  const monitor = new PaperPositionMonitorService(manager, portfolio, () => '2026-08-10');
  monitor.monitor(update(order.contract.instrumentKey, 130));
  monitor.monitor(update(order.contract.instrumentKey, 140));
  assert.equal(portfolio.getSnapshot('2026-08-10')?.totalRealizedPnl, 2250);
  assert.equal(portfolio.getSnapshot('2026-08-10')?.closedPositionCount, 1);
  assert.equal(portfolio.getSnapshot('2026-08-10')?.openPositionCount, 0);
});

test('a triggered V2 exit uses executable BID fill for P&L while retaining frozen target trigger semantics', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => entryTime);
  portfolio.open({ order, strategyId:'V2_TREND_DOWN_PE', underlying:'NIFTY 50', correlationId:'corr', intentId:'intent', sessionDate:'2026-08-10' });
  const fills = new PaperFillModelService();
  const monitor = new PaperPositionMonitorService(manager, portfolio, () => '2026-08-10', (active, tick) => fills.toSummary(fills.fill({ side:'SELL', requestedQuantity:active.contract.quantity, intentTimestamp:active.entry.entryTimestamp, quote:{ instrumentKey:active.contract.instrumentKey, sourceTimestamp:tick.timestamp.toISOString(), receivedTimestamp:tick.timestamp.toISOString(), quoteAgeMs:0, ltp:130, bestBid:129, bestAsk:131, bidSize:null, askSize:null, depthLevels:[], spreadAbsolute:2, spreadPercent:2, connectionGenerationId:1, dataQuality:'FRESH_TOP_OF_BOOK' } })));
  const result = monitor.monitor(update(order.contract.instrumentKey, 130));
  assert.equal(result[0].action, PaperOrderStatus.TARGET_EXIT); assert.equal(manager.getById(order.id)?.exit?.simulatedExitPremium, 129);
  assert.equal(portfolio.getSnapshot('2026-08-10')?.totalRealizedPnl, 2175);
});

test('partial exit depth never closes a full V2 paper position at an invented residual quantity', () => {
  const manager = new PaperOrderManagerService(); const order = open(manager); const fills = new PaperFillModelService();
  const monitor = new PaperPositionMonitorService(manager, undefined, () => '2026-08-10', (active, tick) => {
    const result = fills.fill({ side:'SELL', requestedQuantity:active.contract.quantity, intentTimestamp:active.entry.entryTimestamp, quote:{ instrumentKey:active.contract.instrumentKey, sourceTimestamp:tick.timestamp.toISOString(), receivedTimestamp:tick.timestamp.toISOString(), quoteAgeMs:0, ltp:130, bestBid:129, bestAsk:131, bidSize:10, askSize:10, depthLevels:[{ bid:129,bidSize:10,ask:131,askSize:10 }], spreadAbsolute:2, spreadPercent:2, connectionGenerationId:1, dataQuality:'FRESH_DEPTH' } });
    return result.status === 'FILLED' ? fills.toSummary(result) : undefined;
  });
  const result = monitor.monitor(update(order.contract.instrumentKey, 130));
  assert.equal(result[0].action, 'NONE'); assert.equal(result[0].executionUnavailable, true); assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.OPEN);
});
