import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ParameterAnalysisInputDto,
} from '../modules/research/dto/parameter-analysis-report.dto';
import { PerformanceMetricsDto } from '../modules/research/dto/performance-metrics.dto';
import { StrategyReportDto } from '../modules/research/dto/strategy-report.dto';
import ParameterAnalyzerService from '../modules/research/services/parameter-analyzer.service';

const analyzer = new ParameterAnalyzerService();

function createMetrics(overrides: Partial<PerformanceMetricsDto> = {}): PerformanceMetricsDto {
  return {
    totalSignals: 10,
    evaluableSignals: 10,
    buyCeSignals: 5,
    buyPeSignals: 5,
    correct5m: 5,
    correct15m: 5,
    correct30m: 5,
    correct60m: 5,
    accuracy5m: 50,
    accuracy15m: 50,
    accuracy30m: 50,
    accuracy60m: 50,
    avg5m: 1,
    avg15m: 2,
    avg30m: 3,
    avg60m: 4,
    avgMFE: 6,
    avgMAE: 2,
    ...overrides,
  };
}

function createReport(metrics: PerformanceMetricsDto): StrategyReportDto {
  return {
    strategyId: 'ema-cross',
    strategyName: 'EMA Cross',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '5m',
    fromDate: '2026-07-10',
    toDate: '2026-08-05',
    performanceMetrics: metrics,
    dominantSignalDirection: 'BALANCED',
    generatedAt: new Date('2026-08-07T00:00:00.000Z'),
  };
}

function createInput(reports: readonly StrategyReportDto[]): ParameterAnalysisInputDto {
  return {
    strategyName: 'EMA Cross',
    parameterSets: reports.map((_, index) => ({
      id: `ema-${index + 1}`,
      parameters: { fastPeriod: 10 + index, slowPeriod: 30 + index },
    })),
    reports,
  };
}

test('selects a single configuration for every metric', () => {
  const report = analyzer.analyze(createInput([createReport(createMetrics())]));

  assert.deepEqual(report.testedConfigurations, ['ema-1']);
  assert.equal(report.bestAccuracy5m.configurationId, 'ema-1');
  assert.equal(report.bestAccuracy60m.configurationId, 'ema-1');
  assert.equal(report.bestAverage60mMove.configurationId, 'ema-1');
  assert.equal(report.bestAverageMFE.configurationId, 'ema-1');
  assert.equal(report.lowestAverageMAE.configurationId, 'ema-1');
  assert.equal(report.overallRecommendation, 'ema-1');
});

test('compares multiple parameter configurations by each metric', () => {
  const report = analyzer.analyze(
    createInput([
      createReport(createMetrics({ accuracy5m: 70, accuracy15m: 60, avg60m: 2, avgMFE: 5, avgMAE: 4 })),
      createReport(createMetrics({ accuracy5m: 60, accuracy15m: 80, avg60m: 8, avgMFE: 9, avgMAE: 1 })),
    ])
  );

  assert.equal(report.bestAccuracy5m.configurationId, 'ema-1');
  assert.equal(report.bestAccuracy15m.configurationId, 'ema-2');
  assert.equal(report.bestAverage60mMove.configurationId, 'ema-2');
  assert.equal(report.bestAverageMFE.configurationId, 'ema-2');
  assert.equal(report.lowestAverageMAE.configurationId, 'ema-2');
});

test('returns no unique metric winner or recommendation for ties', () => {
  const report = analyzer.analyze(
    createInput([createReport(createMetrics()), createReport(createMetrics())])
  );

  assert.deepEqual(report.bestAccuracy5m, { configurationId: null, value: 50 });
  assert.deepEqual(report.lowestAverageMAE, { configurationId: null, value: 2 });
  assert.equal(report.overallRecommendation, null);
});

test('handles empty reports', () => {
  const report = analyzer.analyze({ strategyName: 'EMA Cross', parameterSets: [], reports: [] });

  assert.deepEqual(report.testedConfigurations, []);
  assert.deepEqual(report.bestAccuracy5m, { configurationId: null, value: null });
  assert.deepEqual(report.lowestAverageMAE, { configurationId: null, value: null });
  assert.equal(report.overallRecommendation, null);
});

test('handles reports with missing performance metrics', () => {
  const missingMetricsReport = {
    ...createReport(createMetrics()),
    performanceMetrics: undefined,
  } as unknown as StrategyReportDto;
  const report = analyzer.analyze(createInput([missingMetricsReport]));

  assert.deepEqual(report.bestAccuracy5m, { configurationId: null, value: null });
  assert.equal(report.overallRecommendation, null);
});

test('recommends the configuration that wins a strict majority of comparison metrics', () => {
  const report = analyzer.analyze(
    createInput([
      createReport(
        createMetrics({
          accuracy5m: 90,
          accuracy15m: 90,
          accuracy30m: 90,
          accuracy60m: 90,
          avg60m: 1,
          avgMFE: 1,
          avgMAE: 9,
        })
      ),
      createReport(
        createMetrics({
          accuracy5m: 80,
          accuracy15m: 80,
          accuracy30m: 80,
          accuracy60m: 80,
          avg60m: 9,
          avgMFE: 9,
          avgMAE: 1,
        })
      ),
    ])
  );

  assert.equal(report.overallRecommendation, 'ema-1');
});

test('does not mutate parameter sets or strategy reports', () => {
  const input = createInput([createReport(createMetrics()), createReport(createMetrics({ avg60m: 5 }))]);
  const originalInput = {
    ...input,
    parameterSets: input.parameterSets.map((parameterSet) => ({
      ...parameterSet,
      parameters: { ...parameterSet.parameters },
    })),
    reports: input.reports.map((report) => ({
      ...report,
      performanceMetrics: { ...report.performanceMetrics },
    })),
  };

  analyzer.analyze(input);

  assert.deepEqual(input, originalInput);
});
