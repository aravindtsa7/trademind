import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SignalPerformanceResultDto,
} from '../modules/research/dto/performance-metrics.dto';
import PerformanceAnalyzerService from '../modules/research/services/performance-analyzer.service';

const analyzer = new PerformanceAnalyzerService();

function createResult(
  overrides: Partial<SignalPerformanceResultDto> = {}
): SignalPerformanceResultDto {
  return {
    signal: 'BUY_CE',
    directionalPoints: { '5m': 1, '15m': 2, '30m': 3, '60m': 4 },
    mfe: 6,
    mae: 2,
    ...overrides,
  };
}

test('returns zero metrics for empty input', () => {
  assert.deepEqual(analyzer.analyze([]), {
    totalSignals: 0,
    evaluableSignals: 0,
    buyCeSignals: 0,
    buyPeSignals: 0,
    correct5m: 0,
    correct15m: 0,
    correct30m: 0,
    correct60m: 0,
    accuracy5m: 0,
    accuracy15m: 0,
    accuracy30m: 0,
    accuracy60m: 0,
    avg5m: 0,
    avg15m: 0,
    avg30m: 0,
    avg60m: 0,
    avgMFE: 0,
    avgMAE: 0,
  });
});

test('calculates 100 percent accuracy for all correct signals', () => {
  const metrics = analyzer.analyze([
    createResult(),
    createResult({ signal: 'BUY_PE', directionalPoints: { '5m': 2, '15m': 3, '30m': 4, '60m': 5 } }),
  ]);

  assert.equal(metrics.correct5m, 2);
  assert.equal(metrics.correct15m, 2);
  assert.equal(metrics.correct30m, 2);
  assert.equal(metrics.correct60m, 2);
  assert.equal(metrics.accuracy5m, 100);
  assert.equal(metrics.accuracy60m, 100);
});

test('calculates zero accuracy for all incorrect signals', () => {
  const metrics = analyzer.analyze([
    createResult({ directionalPoints: { '5m': -1, '15m': -2, '30m': -3, '60m': -4 } }),
    createResult({ signal: 'BUY_PE', directionalPoints: { '5m': -2, '15m': -3, '30m': -4, '60m': -5 } }),
  ]);

  assert.equal(metrics.correct5m, 0);
  assert.equal(metrics.correct60m, 0);
  assert.equal(metrics.accuracy5m, 0);
  assert.equal(metrics.accuracy60m, 0);
});

test('calculates counts and accuracy for mixed signal outcomes', () => {
  const metrics = analyzer.analyze([
    createResult(),
    createResult({ signal: 'BUY_PE', directionalPoints: { '5m': -1, '15m': 0, '30m': 2, '60m': -2 } }),
  ]);

  assert.equal(metrics.totalSignals, 2);
  assert.equal(metrics.buyCeSignals, 1);
  assert.equal(metrics.buyPeSignals, 1);
  assert.equal(metrics.correct5m, 1);
  assert.equal(metrics.correct15m, 1);
  assert.equal(metrics.correct30m, 2);
  assert.equal(metrics.correct60m, 1);
  assert.equal(metrics.accuracy5m, 50);
  assert.equal(metrics.accuracy15m, 50);
  assert.equal(metrics.accuracy30m, 100);
  assert.equal(metrics.accuracy60m, 50);
});

test('counts BUY_CE-only input', () => {
  const metrics = analyzer.analyze([createResult(), createResult()]);

  assert.equal(metrics.buyCeSignals, 2);
  assert.equal(metrics.buyPeSignals, 0);
});

test('counts BUY_PE-only input', () => {
  const metrics = analyzer.analyze([
    createResult({ signal: 'BUY_PE' }),
    createResult({ signal: 'BUY_PE' }),
  ]);

  assert.equal(metrics.buyCeSignals, 0);
  assert.equal(metrics.buyPeSignals, 2);
});

test('excludes unavailable evaluations from horizon metrics and risk averages', () => {
  const metrics = analyzer.analyze([
    createResult(),
    createResult({
      directionalPoints: { '5m': -2, '15m': null, '30m': null, '60m': null },
      mfe: null,
      mae: null,
    }),
  ]);

  assert.equal(metrics.evaluableSignals, 1);
  assert.equal(metrics.correct5m, 1);
  assert.equal(metrics.accuracy5m, 50);
  assert.equal(metrics.accuracy15m, 100);
  assert.equal(metrics.accuracy30m, 100);
  assert.equal(metrics.accuracy60m, 100);
  assert.equal(metrics.avgMFE, 6);
  assert.equal(metrics.avgMAE, 2);
});

test('calculates directional, MFE, and MAE averages', () => {
  const metrics = analyzer.analyze([
    createResult({
      directionalPoints: { '5m': 2, '15m': 4, '30m': 6, '60m': 8 },
      mfe: 10,
      mae: 4,
    }),
    createResult({
      directionalPoints: { '5m': 4, '15m': 6, '30m': 8, '60m': 10 },
      mfe: 14,
      mae: 6,
    }),
  ]);

  assert.equal(metrics.avg5m, 3);
  assert.equal(metrics.avg15m, 5);
  assert.equal(metrics.avg30m, 7);
  assert.equal(metrics.avg60m, 9);
  assert.equal(metrics.avgMFE, 12);
  assert.equal(metrics.avgMAE, 5);
});

test('does not mutate signal outcomes', () => {
  const results = [
    createResult(),
    createResult({ signal: 'BUY_PE', directionalPoints: { '5m': -1, '15m': 2, '30m': 0, '60m': null } }),
  ];
  const originalResults = results.map((result) => ({
    ...result,
    directionalPoints: { ...result.directionalPoints },
  }));

  analyzer.analyze(results);

  assert.deepEqual(results, originalResults);
});
