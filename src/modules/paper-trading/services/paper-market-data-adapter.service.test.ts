import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { CreatePaperOrderDto } from '../dto/paper-order.dto';
import { PaperOrderStatus } from '../types/paper-trading.types';
import PaperMarketDataAdapterService from './paper-market-data-adapter.service';
import PaperOrderManagerService from './paper-order-manager.service';
import PaperPositionMonitorService from './paper-position-monitor.service';
import PaperPortfolioService, { InMemoryPaperPortfolioRepository } from './paper-portfolio.service';
import { PaperExecutionFillSummary } from '../dto/paper-fill-model.dto';
import { DeterministicExecutionFaultInjector, InjectedExecutionFault } from '../../execution/execution-fault-injection.test-helper';

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
function durableFill(): PaperExecutionFillSummary { return { status:'FILLED', requestedQuantity:75, filledQuantity:75, averageFillPrice:129, worstFillPrice:129, quotedBestPrice:129, fillQuality:'TOP_OF_BOOK_ESTIMATE', slippageVsBestQuote:0, slippageVsLtp:-1, spreadCost:1, depthSlippage:0, totalExecutionSlippage:1, slippagePercent:0.77, sourceTimestamp:entryTimestamp.toISOString(), quoteDataQuality:'FRESH_TOP_OF_BOOK' }; }

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

test('fresh depth marks the authoritative portfolio at executable long-option bid without changing exit rules', () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const order = open(manager);
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => entryTimestamp);
  portfolio.open({ order, strategyId:'V2_TREND_DOWN_PE', underlying:'NIFTY 50', correlationId:'corr', intentId:'intent', sessionDate:'2026-08-10' });
  const adapter = new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager, portfolio, () => '2026-08-10'), bus, portfolio);
  adapter.start();
  bus.emit('market.tick', tick(order.contract.instrumentKey, 101));
  bus.emit('market.depth', { instrumentKey: order.contract.instrumentKey, timestamp: tick(order.contract.instrumentKey, 101).timestamp, quotes: [{ bidPrice:100.5, askPrice:101.5 }] });
  assert.equal(portfolio.getSnapshot('2026-08-10')?.totalUnrealizedPnl, 37.5);
});

test('canonical execution quote snapshot preserves supplied depth and never invents book sides', () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const timestamp = tick('NSE_FO|one', 100).timestamp;
  const adapter = new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager), bus, undefined, 2_000, () => new Date(timestamp));
  adapter.start(); bus.emit('market.tick', tick('NSE_FO|one', 100)); bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp, generationId:7, quotes:[{ bidPrice:99, bidQuantity:'25', askPrice:101, askQuantity:'20' }, { bidPrice:98, bidQuantity:'50', askPrice:102, askQuantity:'40' }] });
  const snapshot = adapter.getExecutionQuoteSnapshot('NSE_FO|one');
  assert.equal(snapshot?.dataQuality, 'FRESH_DEPTH'); assert.equal(snapshot?.bestAsk, 101); assert.equal(snapshot?.depthLevels.length, 2); assert.equal(snapshot?.depthLevels[1].askSize, 40); assert.equal(snapshot?.connectionGenerationId, 7);
});

test('fresh LTP cannot mask stale bid/ask depth in the canonical executable snapshot', () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const base = new Date('2026-08-10T04:00:00.000Z'); let now = new Date(base);
  const adapter = new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager), bus, undefined, 2_000, () => now);
  adapter.start(); bus.emit('market.tick', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), ltp:100 }); bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), quotes:[{ bidPrice:99, bidQuantity:'10', askPrice:101, askQuantity:'10' }] });
  now = new Date(base.getTime() + 2_001); bus.emit('market.tick', { instrumentKey:'NSE_FO|one', timestamp:now.toISOString(), ltp:102 });
  const snapshot = adapter.getExecutionQuoteSnapshot('NSE_FO|one');
  assert.equal(snapshot?.ltpAgeMs, 0); assert.equal(snapshot?.bidAgeMs, 2_001); assert.equal(snapshot?.askAgeMs, 2_001); assert.equal(snapshot?.quoteAgeMs, 2_001); assert.equal(snapshot?.dataQuality, 'STALE');
});

test('captured executable snapshots are immutable and later cache updates cannot change an attempt', () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const base = new Date('2026-08-10T04:00:00.000Z'); let now = new Date(base);
  const adapter = new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager), bus, undefined, 2_000, () => now);
  adapter.start(); bus.emit('market.tick', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), ltp:100 }); bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), quotes:[{ bidPrice:99, askPrice:101 }] });
  const first = adapter.getExecutionQuoteSnapshot('NSE_FO|one')!; const firstRepeat = adapter.getExecutionQuoteSnapshot('NSE_FO|one')!; now = new Date(base.getTime() + 1_000); bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:now.toISOString(), quotes:[{ bidPrice:98, askPrice:102 }] });
  const second = adapter.getExecutionQuoteSnapshot('NSE_FO|one')!;
  assert.equal(first.snapshotId, firstRepeat.snapshotId); assert.notEqual(first, firstRepeat); assert.equal(first.bestAsk, 101); assert.equal(second.bestAsk, 102); assert.notEqual(first.snapshotId, second.snapshotId); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.depthLevels));
});

test('an old WebSocket generation cannot qualify an executable quote or mix with a current depth book', () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter(); const base = new Date('2026-08-10T04:00:00.000Z'); let activeGeneration = 2;
  const adapter = new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager), bus, undefined, 2_000, () => base, () => activeGeneration);
  adapter.start();
  bus.emit('market.tick', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), ltp:100, generationId:1 });
  bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), generationId:1, quotes:[{ bidPrice:99, askPrice:101 }] });
  assert.equal(adapter.getExecutionQuoteSnapshot('NSE_FO|one'), undefined);
  bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), generationId:2, quotes:[{ bidPrice:99, askPrice:101 }] });
  assert.equal(adapter.getExecutionQuoteSnapshot('NSE_FO|one')?.ltp, null);
  bus.emit('market.tick', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), ltp:100, generationId:2 });
  const snapshot = adapter.getExecutionQuoteSnapshot('NSE_FO|one');
  assert.equal(snapshot?.dataQuality, 'FRESH_TOP_OF_BOOK'); assert.equal(snapshot?.connectionGenerationId, 2);
  activeGeneration = 3;
  bus.emit('market.depth', { instrumentKey:'NSE_FO|one', timestamp:base.toISOString(), generationId:2, quotes:[{ bidPrice:98, askPrice:102 }] });
  assert.equal(adapter.getExecutionQuoteSnapshot('NSE_FO|one'), undefined);
});

test('serializes durable exit work: duplicate ticks produce one committed action', async () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter();
  const created = manager.create({ ...input(), executionOrderId:'exec-adapter-durable' }); const order = manager.markOpen(created.id);
  let calls = 0; let resolveCommit!: () => void; const commit = new Promise<void>((resolve) => { resolveCommit = resolve; });
  const monitor = new PaperPositionMonitorService(manager, undefined, () => '2026-08-10', () => durableFill(), undefined, async () => { calls++; await commit; });
  const adapter = new PaperMarketDataAdapterService(monitor, bus); const actions: unknown[] = [];
  bus.on('paper.order.action', (action) => actions.push(action)); adapter.start();
  bus.emit('market.tick', tick(order.contract.instrumentKey, 130));
  bus.emit('market.tick', tick(order.contract.instrumentKey, 130, 2));
  await Promise.resolve(); resolveCommit();
  assert.equal(await adapter.drainDurableExitQueue(1_000), true);
  assert.equal(calls, 1);
  assert.equal(actions.length, 1);
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.TARGET_EXIT);
});

test('shutdown drain times out safely while a durable exit is pending, then settles deterministically', async () => {
  const manager = new PaperOrderManagerService(); const bus = new EventEmitter();
  const created = manager.create({ ...input(), executionOrderId:'exec-adapter-shutdown' }); const order = manager.markOpen(created.id);
  let resolveCommit!: () => void; const commit = new Promise<void>((resolve) => { resolveCommit = resolve; });
  const monitor = new PaperPositionMonitorService(manager, undefined, () => '2026-08-10', () => durableFill(), undefined, async () => { await commit; });
  const adapter = new PaperMarketDataAdapterService(monitor, bus); adapter.start();
  bus.emit('market.tick', tick(order.contract.instrumentKey, 130));
  await Promise.resolve();
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.EXIT_PENDING);
  assert.equal(await adapter.drainDurableExitQueue(0), false);
  resolveCommit();
  assert.equal(await adapter.drainDurableExitQueue(1_000), true);
  assert.equal(manager.getById(order.id)?.status, PaperOrderStatus.TARGET_EXIT);
});

test('shutdown-drain failpoint never completes or creates an additional exit',async()=>{
  const manager=new PaperOrderManagerService();const bus=new EventEmitter();const faults=new DeterministicExecutionFaultInjector();faults.arm('DURING_SHUTDOWN_DRAIN');
  const adapter=new PaperMarketDataAdapterService(new PaperPositionMonitorService(manager),bus,undefined,2_000,()=>entryTimestamp,undefined,faults);
  await assert.rejects(()=>adapter.drainDurableExitQueue(1_000),InjectedExecutionFault);assert.equal(manager.getActiveOrders().length,0);assert.ok(faults.hits.includes('DURING_SHUTDOWN_DRAIN'));
});
