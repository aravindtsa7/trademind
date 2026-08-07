import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PerformanceMetricsDto,
  SignalPerformanceResultDto,
} from '../modules/research/dto/performance-metrics.dto';
import StrategyAnalyzerService from '../modules/research/services/strategy-analyzer.service';

const generatedAt = new Date('2026-08-07T09:15:00.000Z');

function createSignalResult(
  signal: SignalPerformanceResultDto['signal'] = 'BUY_CE'
): SignalPerformanceResultDto {
  return {
    signal,
    directionalPoints: { '5m': 1, '15m': 2, '30m': 3, '60m': 4 },
    mfe: 5,
    mae: 2,
  };
}

function createInput(
  signalResults: readonly SignalPerformanceResultDto[],
  sessionCount?: number
) {
  return {
    strategyId: 'ema-trend-confirmation',
    strategyName: 'EMA Trend Confirmation',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '5m',
    fromDate: '2026-07-10',
    toDate: '2026-08-05',
    signalResults,
    sessionCount,
  };
}

function createAnalyzer(): StrategyAnalyzerService {
  return new StrategyAnalyzerService(undefined, () => new Date(generatedAt));
}

test('creates a report for valid mixed strategy results', () => {
  const report = createAnalyzer().analyze(
    createInput([createSignalResult('BUY_CE'), createSignalResult('BUY_PE')], 2)
  );

  assert.equal(report.strategyId, 'ema-trend-confirmation');
  assert.equal(report.strategyName, 'EMA Trend Confirmation');
  assert.equal(report.instrumentKey, 'NSE_INDEX|Nifty 50');
  assert.equal(report.performanceMetrics.totalSignals, 2);
  assert.equal(report.dominantSignalDirection, 'BALANCED');
  assert.equal(report.signalFrequencyPerSession, 1);
  assert.deepEqual(report.generatedAt, generatedAt);
});

test('identifies a BUY_CE-dominant strategy', () => {
  const report = createAnalyzer().analyze(
    createInput([createSignalResult('BUY_CE'), createSignalResult('BUY_CE'), createSignalResult('BUY_PE')])
  );

  assert.equal(report.dominantSignalDirection, 'BUY_CE');
});

test('identifies a BUY_PE-dominant strategy', () => {
  const report = createAnalyzer().analyze(
    createInput([createSignalResult('BUY_CE'), createSignalResult('BUY_PE'), createSignalResult('BUY_PE')])
  );

  assert.equal(report.dominantSignalDirection, 'BUY_PE');
});

test('identifies a balanced strategy', () => {
  const report = createAnalyzer().analyze(
    createInput([createSignalResult('BUY_CE'), createSignalResult('BUY_PE')])
  );

  assert.equal(report.dominantSignalDirection, 'BALANCED');
});

test('reports NONE for an empty signal list', () => {
  const report = createAnalyzer().analyze(createInput([]));

  assert.equal(report.performanceMetrics.totalSignals, 0);
  assert.equal(report.dominantSignalDirection, 'NONE');
});

test('calculates signal frequency when a positive session count is provided', () => {
  const report = createAnalyzer().analyze(
    createInput(
      [createSignalResult('BUY_CE'), createSignalResult('BUY_CE'), createSignalResult('BUY_PE')],
      2
    )
  );

  assert.equal(report.signalFrequencyPerSession, 1.5);
});

test('omits signal frequency for missing or zero session counts', () => {
  const missingSessionCountReport = createAnalyzer().analyze(createInput([createSignalResult()]));
  const zeroSessionCountReport = createAnalyzer().analyze(createInput([createSignalResult()], 0));

  assert.equal(missingSessionCountReport.signalFrequencyPerSession, undefined);
  assert.equal(zeroSessionCountReport.signalFrequencyPerSession, undefined);
});

test('delegates performance metrics to the Performance Analyzer', () => {
  const expectedMetrics: PerformanceMetricsDto = {
    totalSignals: 7,
    evaluableSignals: 6,
    buyCeSignals: 5,
    buyPeSignals: 2,
    correct5m: 4,
    correct15m: 4,
    correct30m: 3,
    correct60m: 3,
    accuracy5m: 57.14,
    accuracy15m: 57.14,
    accuracy30m: 42.86,
    accuracy60m: 42.86,
    avg5m: 1,
    avg15m: 2,
    avg30m: 3,
    avg60m: 4,
    avgMFE: 5,
    avgMAE: 2,
  };
  const calls: SignalPerformanceResultDto[][] = [];
  const input = createInput([createSignalResult()]);
  const analyzer = new StrategyAnalyzerService(
    {
      analyze(signalResults) {
        calls.push([...signalResults]);
        return expectedMetrics;
      },
    },
    () => new Date(generatedAt)
  );

  const report = analyzer.analyze(input);

  assert.deepEqual(calls, [[...input.signalResults]]);
  assert.equal(report.performanceMetrics, expectedMetrics);
});

test('does not mutate the strategy analysis input', () => {
  const input = createInput([createSignalResult('BUY_CE'), createSignalResult('BUY_PE')], 2);
  const originalInput = {
    ...input,
    signalResults: input.signalResults.map((result) => ({
      ...result,
      directionalPoints: { ...result.directionalPoints },
    })),
  };

  createAnalyzer().analyze(input);

  assert.deepEqual(input, originalInput);
});
