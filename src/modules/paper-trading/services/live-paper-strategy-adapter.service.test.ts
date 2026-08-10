import assert from 'node:assert/strict';
import test from 'node:test';
import { Candle, IndicatorType } from '../../indicators/types';
import { IndicatorEngineResult } from '../../indicators/services/indicator-engine.service';
import { OptionContract } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { LivePaperOrchestrator } from '../dto/live-paper-strategy.dto';
import LivePaperStrategyAdapterService from './live-paper-strategy-adapter.service';

function candle(timestamp: Date, close = 24_600): Candle {
  return { timestamp, open: close, high: close + 5, low: close - 5, close, volume: 1 };
}

const optionContracts: readonly OptionContract[] = [{ instrumentKey: 'NSE_FO|24600CE', tradingSymbol: 'NIFTY 24600 CE', underlying: 'NIFTY 50', strikePrice: 24_600, expiry: new Date('2026-08-13T00:00:00.000Z'), optionType: 'CE', exchange: 'NSE', segment: 'NSE_FO', lotSize: 75 }];

class EngineMock {
  constructor(private readonly rsi: number) {}
  calculate(candles: readonly Candle[]): IndicatorEngineResult {
    const previous = candles[candles.length - 2]; const current = candles[candles.length - 1];
    return {
      indicators: [
        { config: { type: IndicatorType.EMA, period: 15 }, result: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 11 }] } },
        { config: { type: IndicatorType.EMA, period: 35 }, result: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 10 }] } },
        { config: { type: IndicatorType.RSI, period: 14 }, result: { type: IndicatorType.RSI, period: 14, values: [{ timestamp: current.timestamp, value: this.rsi }] } },
      ],
    } as IndicatorEngineResult;
  }
}

class CrossMock {
  constructor(private readonly signal: StrategySignal) {}
  evaluate() { return { signal: this.signal, confidence: 60, reasons: [`raw ${this.signal}`] }; }
}

class OrchestratorMock implements LivePaperOrchestrator {
  readonly calls: Parameters<LivePaperOrchestrator['createFromSignal']>[0][] = [];
  async createFromSignal(input: Parameters<LivePaperOrchestrator['createFromSignal']>[0]) {
    this.calls.push(structuredClone(input));
    return { order: { id: `order-${this.calls.length}` } } as Awaited<ReturnType<LivePaperOrchestrator['createFromSignal']>>;
  }
}

function adapter(signal: StrategySignal, rsi: number) {
  const orchestrator = new OrchestratorMock();
  return { orchestrator, adapter: new LivePaperStrategyAdapterService(orchestrator, new EngineMock(rsi), new CrossMock(signal)) };
}

async function warm(adapterService: LivePaperStrategyAdapterService, finalTimestamp: Date): Promise<Candle> {
  for (let index = 35; index > 0; index -= 1) {
    await adapterService.processCompletedCandle({ candle: candle(new Date(finalTimestamp.getTime() - index * 5 * 60_000)), completed: true, contracts: [] });
  }
  return candle(finalTimestamp);
}

async function evaluate(adapterService: LivePaperStrategyAdapterService, finalTimestamp: Date) {
  const finalCandle = await warm(adapterService, finalTimestamp);
  return adapterService.processCompletedCandle({ candle: finalCandle, completed: true, contracts: optionContracts });
}

test('orchestrates BUY_CE for bullish crossover, RSI > 55, and allowed time', async () => {
  const context = adapter(StrategySignal.BUY_CE, 56); const result = await evaluate(context.adapter, new Date('2026-08-10T04:55:00.000Z'));
  assert.equal(result.finalSignal, StrategySignal.BUY_CE); assert.equal(context.orchestrator.calls.length, 1); assert.equal(context.orchestrator.calls[0].signal.spotPrice, 24_600);
});

test('orchestrates BUY_PE for bearish crossover, RSI < 45, and allowed time', async () => {
  const context = adapter(StrategySignal.BUY_PE, 44); const result = await evaluate(context.adapter, new Date('2026-08-10T06:35:00.000Z'));
  assert.equal(result.finalSignal, StrategySignal.BUY_PE); assert.equal(context.orchestrator.calls.length, 1);
});

test('rejects bullish crossover when RSI is at or below 55', async () => {
  const context = adapter(StrategySignal.BUY_CE, 55); const result = await evaluate(context.adapter, new Date('2026-08-10T04:55:00.000Z'));
  assert.equal(result.finalSignal, StrategySignal.NO_TRADE); assert.equal(context.orchestrator.calls.length, 0);
});

test('rejects bearish crossover when RSI is at or above 45', async () => {
  const context = adapter(StrategySignal.BUY_PE, 45); const result = await evaluate(context.adapter, new Date('2026-08-10T04:55:00.000Z'));
  assert.equal(result.finalSignal, StrategySignal.NO_TRADE); assert.equal(context.orchestrator.calls.length, 0);
});

test('does not orchestrate when no EMA crossover exists', async () => {
  const context = adapter(StrategySignal.NO_TRADE, 60); const result = await evaluate(context.adapter, new Date('2026-08-10T04:55:00.000Z'));
  assert.equal(result.finalSignal, StrategySignal.NO_TRADE); assert.equal(context.orchestrator.calls.length, 0);
});

test('filters an otherwise valid signal during 10:30-12:00 IST', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const result = await evaluate(context.adapter, new Date('2026-08-10T05:00:00.000Z'));
  assert.equal(result.timeFilterAllowed, false); assert.equal(result.finalSignal, StrategySignal.NO_TRADE); assert.equal(context.orchestrator.calls.length, 0);
});

test('allows a valid signal before 10:30 IST', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const result = await evaluate(context.adapter, new Date('2026-08-10T04:55:00.000Z'));
  assert.equal(result.timeFilterAllowed, true); assert.equal(context.orchestrator.calls.length, 1);
});

test('allows a valid signal from 12:00 IST onward', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const result = await evaluate(context.adapter, new Date('2026-08-10T06:30:00.000Z'));
  assert.equal(result.timeFilterAllowed, true); assert.equal(context.orchestrator.calls.length, 1);
});

test('does not create a duplicate order for a duplicate completed candle', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const timestamp = new Date('2026-08-10T04:55:00.000Z'); await evaluate(context.adapter, timestamp);
  const duplicate = await context.adapter.processCompletedCandle({ candle: candle(timestamp), completed: true, contracts: optionContracts });
  assert.equal(duplicate.processed, false); assert.equal(context.orchestrator.calls.length, 1);
});

test('returns no trade until enough completed history exists', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const result = await context.adapter.processCompletedCandle({ candle: candle(new Date('2026-08-10T03:45:00.000Z')), completed: true, contracts: [] });
  assert.equal(result.processed, true); assert.equal(result.finalSignal, StrategySignal.NO_TRADE); assert.equal(result.ema15, null);
});

test('ignores incomplete candles', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const result = await context.adapter.processCompletedCandle({ candle: candle(new Date('2026-08-10T03:45:00.000Z')), completed: false, contracts: [] });
  assert.equal(result.processed, false); assert.match(result.reasons[0], /incomplete/);
});

test('does not mutate caller candles or contracts', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60); const timestamp = new Date('2026-08-10T04:55:00.000Z'); const finalCandle = await warm(context.adapter, timestamp); const input = { candle: finalCandle, completed: true, contracts: optionContracts }; const original = structuredClone(input);
  const result = await context.adapter.processCompletedCandle(input); result.candleTimestamp.setTime(0);
  assert.deepEqual(input, original); assert.equal(optionContracts[0].tradingSymbol, original.contracts[0].tradingSymbol);
});
