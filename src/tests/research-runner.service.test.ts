import assert from 'node:assert/strict';
import test from 'node:test';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { ResearchRunConfig, ResearchStrategyContext } from '../modules/research/dto/research-run.dto';
import ResearchRunnerService from '../modules/research/services/research-runner.service';
import { StrategySignal, StrategySignalDto } from '../modules/strategies/dto/strategy-signal.dto';
import { Strategy } from '../modules/strategies/interfaces/strategy.interface';

const generatedAt = new Date('2026-08-07T00:00:00.000Z');

class SyntheticStrategy implements Strategy<ResearchStrategyContext> {
  constructor(
    readonly id: string,
    private readonly signalAtIndex: number | undefined,
    private readonly signal: StrategySignal = StrategySignal.NO_TRADE
  ) {}

  evaluate(input: ResearchStrategyContext): StrategySignalDto {
    return input.candleIndex === this.signalAtIndex
      ? {
          signal: this.signal,
          confidence: 80,
          reasons: ['Synthetic strategy signal.'],
        }
      : {
          signal: StrategySignal.NO_TRADE,
          confidence: 0,
          reasons: ['No synthetic signal.'],
        };
  }
}

function createCandles(direction: 1 | -1 = 1): Candle[] {
  const startTime = new Date('2026-08-03T09:15:00+05:30').getTime();

  return Array.from({ length: 375 }, (_, index) => {
    const close = 100 + direction * index * 0.1;

    return {
      timestamp: new Date(startTime + index * 60_000),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    };
  });
}

function createConfig(
  strategy: Strategy<ResearchStrategyContext>,
  includeAtr = true
): ResearchRunConfig<ResearchStrategyContext> {
  return {
    strategy,
    strategyName: 'Synthetic Strategy',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '5m',
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    indicatorRequests: [
      { type: IndicatorType.EMA, period: 20 },
      { type: IndicatorType.EMA, period: 50 },
      { type: IndicatorType.ADX, period: 14 },
      ...(includeAtr ? [{ type: IndicatorType.ATR, period: 14 } as const] : []),
      { type: IndicatorType.SUPER_TREND, period: 10, multiplier: 3 },
    ],
    marketRegimeConfig: {
      highVolatilityThreshold: 1,
      lowVolatilityThreshold: 0.1,
    },
    createStrategyInput: (context) => context,
  };
}

function createRunner(): ResearchRunnerService {
  return new ResearchRunnerService(() => new Date(generatedAt));
}

test('runs end-to-end with synthetic candles and existing components', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-buy-ce', 60, StrategySignal.BUY_CE))
  );

  assert.equal(result.candleCount, 75);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.totalRawEvaluations, 75);
  assert.equal(result.emittedSignals, 1);
  assert.deepEqual(result.generatedAt, generatedAt);
});

test('returns no outcomes for a NO_TRADE-only strategy', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-no-trade', undefined))
  );

  assert.equal(result.emittedSignals, 0);
  assert.equal(result.strategyReport.performanceMetrics.totalSignals, 0);
});

test('evaluates BUY_CE directional movement', () => {
  const result = createRunner().run(
    createCandles(1),
    createConfig(new SyntheticStrategy('synthetic-buy-ce', 60, StrategySignal.BUY_CE))
  );

  assert.equal(result.signalOutcomes[0].signal, StrategySignal.BUY_CE);
  assert.ok((result.signalOutcomes[0].directionalPoints['5m'] ?? 0) > 0);
  assert.ok((result.signalOutcomes[0].directionalPoints['60m'] ?? 0) > 0);
});

test('evaluates BUY_PE directional movement', () => {
  const result = createRunner().run(
    createCandles(-1),
    createConfig(new SyntheticStrategy('synthetic-buy-pe', 60, StrategySignal.BUY_PE))
  );

  assert.equal(result.signalOutcomes[0].signal, StrategySignal.BUY_PE);
  assert.ok((result.signalOutcomes[0].directionalPoints['5m'] ?? 0) > 0);
  assert.ok((result.signalOutcomes[0].directionalPoints['60m'] ?? 0) > 0);
});

test('does not evaluate past the end of a trading session', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-session-boundary', 74, StrategySignal.BUY_CE))
  );

  assert.deepEqual(result.signalOutcomes[0].directionalPoints, {
    '5m': null,
    '15m': null,
    '30m': null,
    '60m': null,
  });
  assert.equal(result.signalOutcomes[0].mfe, null);
  assert.equal(result.signalOutcomes[0].mae, null);
});

test('attaches a classified market regime to each signal', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-regime', 60, StrategySignal.BUY_CE))
  );

  assert.equal(result.signalOutcomes[0].directionalRegime, 'TREND_UP');
  assert.ok(result.signalOutcomes[0].volatilityRegime);
});

test('generates a strategy report from signal outcomes', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-report', 60, StrategySignal.BUY_CE))
  );

  assert.equal(result.strategyReport.strategyId, 'synthetic-report');
  assert.equal(result.strategyReport.performanceMetrics.totalSignals, 1);
});

test('generates a regime strategy report from signal outcomes', () => {
  const result = createRunner().run(
    createCandles(),
    createConfig(new SyntheticStrategy('synthetic-regime-report', 60, StrategySignal.BUY_CE))
  );

  assert.equal(result.regimeStrategyReport.strategyId, 'synthetic-regime-report');
  assert.equal(result.regimeStrategyReport.overallPerformance.totalSignals, 1);
});

test('fails clearly when a required regime indicator is missing', () => {
  assert.throws(
    () =>
      createRunner().run(
        createCandles(),
        createConfig(new SyntheticStrategy('synthetic-missing-atr', 60, StrategySignal.BUY_CE), false)
      ),
    /requires one ATR indicator result/
  );
});

test('does not mutate input candles', () => {
  const candles = createCandles();
  const originalCandles = candles.map((candle) => ({ ...candle }));

  createRunner().run(
    candles,
    createConfig(new SyntheticStrategy('synthetic-immutable', 60, StrategySignal.BUY_CE))
  );

  assert.deepEqual(candles, originalCandles);
});
