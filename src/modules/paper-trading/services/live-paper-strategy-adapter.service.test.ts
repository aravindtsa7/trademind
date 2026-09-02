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

test('seeds historical candles without evaluating or orchestrating, then evaluates the first newer live candle', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60);
  const firstTimestamp = new Date('2026-08-10T03:45:00.000Z');
  const historical = Array.from({ length: 36 }, (_, index) => candle(new Date(firstTimestamp.getTime() + index * 5 * 60_000)));
  const original = structuredClone(historical);

  context.adapter.seedHistoricalCandles(historical);
  assert.equal(context.adapter.isWarmupReady(), true);
  assert.equal(context.orchestrator.calls.length, 0);
  assert.deepEqual(historical, original);

  const result = await context.adapter.processCompletedCandle({
    candle: candle(new Date(firstTimestamp.getTime() + 36 * 5 * 60_000)), completed: true, contracts: optionContracts,
  });
  assert.equal(result.processed, true);
  assert.equal(result.finalSignal, StrategySignal.BUY_CE);
  assert.equal(context.orchestrator.calls.length, 1);
});

test('rejects duplicate warm-up timestamps and ignores a live candle overlapping seeded history', async () => {
  const context = adapter(StrategySignal.BUY_CE, 60);
  const timestamp = new Date('2026-08-10T03:45:00.000Z');
  assert.throws(() => context.adapter.seedHistoricalCandles([candle(timestamp), candle(timestamp)]), /duplicate timestamps/);

  context.adapter.seedHistoricalCandles(Array.from({ length: 36 }, (_, index) => candle(new Date(timestamp.getTime() + index * 5 * 60_000))));
  const overlap = await context.adapter.processCompletedCandle({ candle: candle(timestamp), completed: true, contracts: optionContracts });
  assert.equal(overlap.processed, false);
  assert.match(overlap.reasons[0], /overlaps seeded historical/);
  assert.equal(context.orchestrator.calls.length, 0);
});

/**
 * F-01: immutable per-instance V2 identity/exit-policy config. A mock indicator engine that
 * additionally supplies ADX14/ATR14 (required by processV2's regime classification) so these
 * tests can drive the V2 branch directly, independent of process.env.
 */
class V2CapableEngineMock {
  constructor(private readonly rsi = 30) {}
  calculate(candles: readonly Candle[]): IndicatorEngineResult {
    const previous = candles[candles.length - 2]; const current = candles[candles.length - 1];
    return {
      indicators: [
        { config: { type: IndicatorType.EMA, period: 15 }, result: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 11 }] } },
        { config: { type: IndicatorType.EMA, period: 35 }, result: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: 10 }, { timestamp: current.timestamp, value: 10 }] } },
        { config: { type: IndicatorType.RSI, period: 14 }, result: { type: IndicatorType.RSI, period: 14, values: [{ timestamp: current.timestamp, value: this.rsi }] } },
        { config: { type: IndicatorType.ADX, period: 14 }, result: { type: IndicatorType.ADX, period: 14, values: [{ timestamp: current.timestamp, adx: 25, plusDI: 15, minusDI: 25 }] } },
        { config: { type: IndicatorType.ATR, period: 14 }, result: { type: IndicatorType.ATR, period: 14, values: [{ timestamp: current.timestamp, value: 50 }] } },
      ],
    } as IndicatorEngineResult;
  }
}

const v2Config = { v2: true, paperTradingOnly: true, v2ExitPolicy: { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } };

test('F-01/1: an explicit v2 config runs the actual V2 decision path even when TRADING_STRATEGY_VERSION is absent from process.env', async () => {
  const original = process.env.TRADING_STRATEGY_VERSION;
  delete process.env.TRADING_STRATEGY_VERSION;
  try {
    const orchestrator = new OrchestratorMock();
    const instance = new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(), new CrossMock(StrategySignal.NO_TRADE), () => false, v2Config);
    const result = await evaluate(instance, new Date('2026-08-10T04:55:00.000Z'));
    // processV2 always stamps a "V2 <reason>: ..." prefix -- the EMA-cross (non-V2) branch never
    // does. This proves the actual branch taken, not merely a label/fingerprint.
    assert.match(result.reasons[0], /^V2 /);
  } finally {
    if (original === undefined) delete process.env.TRADING_STRATEGY_VERSION; else process.env.TRADING_STRATEGY_VERSION = original;
  }
});

test('F-01/2: an already-constructed V2 instance is unaffected by process.env.TRADING_STRATEGY_VERSION changing afterward', async () => {
  const original = process.env.TRADING_STRATEGY_VERSION;
  delete process.env.TRADING_STRATEGY_VERSION;
  const orchestrator = new OrchestratorMock();
  const instance = new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(), new CrossMock(StrategySignal.NO_TRADE), () => false, v2Config);
  try {
    process.env.TRADING_STRATEGY_VERSION = 'NOT_V2_AT_ALL';
    const result = await evaluate(instance, new Date('2026-08-10T04:55:00.000Z'));
    assert.match(result.reasons[0], /^V2 /);
  } finally {
    if (original === undefined) delete process.env.TRADING_STRATEGY_VERSION; else process.env.TRADING_STRATEGY_VERSION = original;
  }
});

test('F-01/3+4: V2 exit policy is frozen/immutable after construction and defaults to target=5, stop=5, hold=15', () => {
  const orchestrator = new OrchestratorMock();
  const instance = new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(), new CrossMock(StrategySignal.NO_TRADE), () => false, v2Config);
  const policy = (instance as unknown as { v2ExitPolicy: { targetPercent: number; stopLossPercent: number; maximumHoldingMinutes: number } }).v2ExitPolicy;
  assert.deepEqual(policy, { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 });
  assert.throws(() => { (policy as { targetPercent: number }).targetPercent = 999; }, TypeError);
  assert.equal(policy.targetPercent, 5);
});

test('F-01/5: a configured V2 exit-policy override resolves once and is honored', async () => {
  const orchestrator = new OrchestratorMock();
  const overridden = { v2: true, paperTradingOnly: true, v2ExitPolicy: { targetPercent: 7, stopLossPercent: 3, maximumHoldingMinutes: 20 } };
  const instance = new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(20), new CrossMock(StrategySignal.NO_TRADE), () => false, overridden);
  const policy = (instance as unknown as { v2ExitPolicy: { targetPercent: number; stopLossPercent: number; maximumHoldingMinutes: number } }).v2ExitPolicy;
  assert.deepEqual(policy, { targetPercent: 7, stopLossPercent: 3, maximumHoldingMinutes: 20 });
});

test('F-01/6: a non-V2 adapter remains non-V2 regardless of process.env.TRADING_STRATEGY_VERSION', async () => {
  const original = process.env.TRADING_STRATEGY_VERSION;
  process.env.TRADING_STRATEGY_VERSION = 'V2';
  try {
    const orchestrator = new OrchestratorMock();
    const instance = new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(60), new CrossMock(StrategySignal.BUY_CE), undefined, { v2: false, paperTradingOnly: false, v2ExitPolicy: { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } });
    const result = await evaluate(instance, new Date('2026-08-10T04:55:00.000Z'));
    // The EMA-cross branch reports the raw CrossMock reason ("raw BUY_CE"), never a "V2 " prefix.
    assert.equal(result.finalSignal, StrategySignal.BUY_CE);
    assert.ok(!result.reasons.some((reason) => reason.startsWith('V2 ')));
  } finally {
    if (original === undefined) delete process.env.TRADING_STRATEGY_VERSION; else process.env.TRADING_STRATEGY_VERSION = original;
  }
});

test('F-01/7: simultaneous construction of a non-V2 instance cannot alter an already-constructed V2 instance (simulates V4/V8 starting alongside V2)', async () => {
  const v2Orchestrator = new OrchestratorMock();
  const v2Instance = new LivePaperStrategyAdapterService(v2Orchestrator, new V2CapableEngineMock(), new CrossMock(StrategySignal.NO_TRADE), () => false, v2Config);
  // Simulates a sibling V4/V8 runner constructing its OWN non-V2-identity adapter in the same
  // process, after V2's instance already exists.
  const siblingOrchestrator = new OrchestratorMock();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _sibling = new LivePaperStrategyAdapterService(siblingOrchestrator, new EngineMock(60), new CrossMock(StrategySignal.BUY_CE), undefined, { v2: false, paperTradingOnly: false, v2ExitPolicy: { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } });
  const result = await evaluate(v2Instance, new Date('2026-08-10T04:55:00.000Z'));
  assert.match(result.reasons[0], /^V2 /);
});

test('F-01: constructing a V2 instance without PAPER_TRADING_ONLY=true fails closed', () => {
  const orchestrator = new OrchestratorMock();
  assert.throws(
    () => new LivePaperStrategyAdapterService(orchestrator, new V2CapableEngineMock(), new CrossMock(StrategySignal.NO_TRADE), () => false, { v2: true, paperTradingOnly: false, v2ExitPolicy: { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } }),
    /paper-only/,
  );
});
