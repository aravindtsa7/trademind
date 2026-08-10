import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import { LiveCandleDto } from '../../market-data/dto/live-candle.dto';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { LivePaperStrategyResult } from '../dto/live-paper-strategy.dto';
import { PaperTradingRuntimeState } from '../dto/paper-trading-runtime.dto';
import PaperRuntimeCandleAdapterService from './paper-runtime-candle-adapter.service';

function candle(overrides: Partial<LiveCandleDto> = {}): LiveCandleDto {
  return { instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '5m', candleTime: new Date('2026-08-10T04:00:00.000Z'), open: 24_600, high: 24_620, low: 24_590, close: 24_610, completed: true, ...overrides };
}

function evaluation(overrides: Partial<LivePaperStrategyResult> = {}): LivePaperStrategyResult {
  return { candleTimestamp: new Date('2026-08-10T04:00:00.000Z'), spotPrice: 24_610, ema15: 1, ema35: 1, rsi14: 60, rawEmaSignal: StrategySignal.BUY_CE, timeFilterAllowed: true, finalSignal: StrategySignal.BUY_CE, reasons: ['test'], processed: true, ...overrides };
}

class RuntimeMock {
  state = PaperTradingRuntimeState.RUNNING;
  calls: unknown[] = [];
  next = evaluation();
  failure?: Error;
  getState() { return this.state; }
  async processCompletedCandle(input: unknown): Promise<LivePaperStrategyResult> { this.calls.push(structuredClone(input)); if (this.failure) throw this.failure; return structuredClone(this.next); }
}

class ContractsProviderMock { calls = 0; getContracts() { this.calls += 1; return []; } }
function setup() { const runtime = new RuntimeMock(); const contracts = new ContractsProviderMock(); const bus = new EventEmitter(); const adapter = new PaperRuntimeCandleAdapterService(runtime, contracts, bus); return { runtime, contracts, bus, adapter }; }
function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

test('start registers completed-candle listener', () => {
  const { bus, adapter } = setup(); adapter.start(); assert.equal(bus.listenerCount('market.candle.completed'), 1);
});

test('duplicate start is safe', () => {
  const { bus, adapter } = setup(); adapter.start(); adapter.start(); assert.equal(bus.listenerCount('market.candle.completed'), 1);
});

test('stop removes completed-candle listener', () => {
  const { bus, adapter } = setup(); adapter.start(); adapter.stop(); assert.equal(bus.listenerCount('market.candle.completed'), 0);
});

test('duplicate stop is safe', () => {
  const { bus, adapter } = setup(); adapter.stop(); adapter.stop(); assert.equal(bus.listenerCount('market.candle.completed'), 0);
});

test('forwards a completed NIFTY 5m candle to runtime', async () => {
  const { runtime, bus, adapter } = setup(); adapter.start(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal(runtime.calls.length, 1); assert.equal((runtime.calls[0] as { candle: { close: number; volume: number } }).candle.close, 24_610); assert.equal((runtime.calls[0] as { candle: { volume: number } }).candle.volume, 0);
});

test('ignores NIFTY 1m candles', async () => {
  const { runtime, bus, adapter } = setup(); adapter.start(); bus.emit('market.candle.completed', candle({ timeframe: '1m' })); await flush();
  assert.equal(runtime.calls.length, 0);
});

test('ignores other-instrument candles', async () => {
  const { runtime, bus, adapter } = setup(); adapter.start(); bus.emit('market.candle.completed', candle({ instrumentKey: 'NSE_INDEX|Nifty Bank' })); await flush();
  assert.equal(runtime.calls.length, 0);
});

test('ignores incomplete and malformed candles', async () => {
  const { runtime, bus, adapter } = setup(); adapter.start(); bus.emit('market.candle.completed', candle({ completed: false })); bus.emit('market.candle.completed', { ...candle(), close: Number.NaN }); await flush();
  assert.equal(runtime.calls.length, 0);
});

test('emits paper.strategy.evaluated result', async () => {
  const { bus, adapter } = setup(); const events: unknown[] = []; bus.on('paper.strategy.evaluated', (event) => events.push(event)); adapter.start(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal((events[0] as { finalSignal: StrategySignal }).finalSignal, StrategySignal.BUY_CE);
});

test('includes paper order id when evaluation created an order', async () => {
  const { runtime, bus, adapter } = setup(); runtime.next = evaluation({ orchestration: { order: { id: 'paper-123' } } as never }); const events: unknown[] = []; bus.on('paper.strategy.evaluated', (event) => events.push(event)); adapter.start(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal((events[0] as { paperOrderId: string }).paperOrderId, 'paper-123');
});

test('handles a runtime that is not running without processing', async () => {
  const { runtime, bus, adapter } = setup(); runtime.state = PaperTradingRuntimeState.STOPPED; adapter.start(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal(runtime.calls.length, 0);
});

test('emits paper.strategy.error for evaluation failures', async () => {
  const { runtime, bus, adapter } = setup(); runtime.failure = new Error('Evaluation failed'); const errors: unknown[] = []; bus.on('paper.strategy.error', (event) => errors.push(event)); adapter.start(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal((errors[0] as { message: string }).message, 'Evaluation failed');
});

test('stopped adapter ignores completed candles', async () => {
  const { runtime, bus, adapter } = setup(); adapter.start(); adapter.stop(); bus.emit('market.candle.completed', candle()); await flush();
  assert.equal(runtime.calls.length, 0);
});

test('does not mutate completed candle event input', async () => {
  const { bus, adapter } = setup(); const event = candle(); const original = structuredClone(event); adapter.start(); bus.emit('market.candle.completed', event); await flush();
  assert.deepEqual(event, original);
});
