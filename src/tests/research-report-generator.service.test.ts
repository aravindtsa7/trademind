import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceMetricsDto } from '../modules/research/dto/performance-metrics.dto';
import { ResearchRunResult } from '../modules/research/dto/research-run.dto';
import ResearchReportGeneratorService from '../modules/research/services/research-report-generator.service';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../modules/research/types/market-regime.types';

const generator = new ResearchReportGeneratorService();
const generatedAt = new Date('2026-08-07T00:00:00.000Z');

function createMetrics(overrides: Partial<PerformanceMetricsDto> = {}): PerformanceMetricsDto {
  return {
    totalSignals: 4,
    evaluableSignals: 3,
    buyCeSignals: 2,
    buyPeSignals: 2,
    correct5m: 2,
    correct15m: 2,
    correct30m: 1,
    correct60m: 2,
    accuracy5m: 50,
    accuracy15m: 50,
    accuracy30m: 25,
    accuracy60m: 66.6666666667,
    avg5m: 1.25,
    avg15m: 2.5,
    avg30m: 3.75,
    avg60m: 5,
    avgMFE: 7.5,
    avgMAE: 2.25,
    ...overrides,
  };
}

function createRun(
  strategyName = 'EMA Cross Strategy',
  overrides: Partial<ResearchRunResult> = {}
): ResearchRunResult {
  const metrics = createMetrics();
  const directionalGroup = (regime: DirectionalMarketRegime) => ({
    regime,
    signalCount: 1,
    evaluableSignalCount: 1,
    performanceMetrics: metrics,
  });
  const volatilityGroup = (regime: VolatilityMarketRegime) => ({
    regime,
    signalCount: 1,
    evaluableSignalCount: 1,
    performanceMetrics: metrics,
  });

  return {
    strategyId: strategyName.toLowerCase().replace(/ /g, '-'),
    strategyName,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '5m',
    fromDate: '2026-07-10',
    toDate: '2026-08-05',
    sessionCount: 19,
    candleCount: 1425,
    totalRawEvaluations: 1425,
    emittedSignals: 4,
    signalOutcomes: [],
    strategyReport: {
      strategyId: 'ema-cross',
      strategyName,
      instrumentKey: 'NSE_INDEX|Nifty 50',
      timeframe: '5m',
      fromDate: '2026-07-10',
      toDate: '2026-08-05',
      performanceMetrics: metrics,
      signalFrequencyPerSession: 4 / 19,
      dominantSignalDirection: 'BALANCED',
      generatedAt,
    },
    regimeStrategyReport: {
      strategyId: 'ema-cross',
      strategyName,
      instrumentKey: 'NSE_INDEX|Nifty 50',
      timeframe: '5m',
      fromDate: '2026-07-10',
      toDate: '2026-08-05',
      overallPerformance: metrics,
      directionalRegimePerformance: {
        TREND_UP: directionalGroup(DirectionalMarketRegime.TREND_UP),
        TREND_DOWN: directionalGroup(DirectionalMarketRegime.TREND_DOWN),
        SIDEWAYS: directionalGroup(DirectionalMarketRegime.SIDEWAYS),
      },
      volatilityRegimePerformance: {
        HIGH_VOLATILITY: volatilityGroup(VolatilityMarketRegime.HIGH_VOLATILITY),
        NORMAL_VOLATILITY: volatilityGroup(VolatilityMarketRegime.NORMAL_VOLATILITY),
        LOW_VOLATILITY: volatilityGroup(VolatilityMarketRegime.LOW_VOLATILITY),
      },
      bestDirectionalRegime: DirectionalMarketRegime.TREND_UP,
      worstDirectionalRegime: DirectionalMarketRegime.TREND_DOWN,
      bestVolatilityRegime: VolatilityMarketRegime.NORMAL_VOLATILITY,
      worstVolatilityRegime: VolatilityMarketRegime.LOW_VOLATILITY,
    },
    generatedAt,
    ...overrides,
  };
}

test('generates structured plain-text sections for a single research run', () => {
  const report = generator.generate(createRun());

  assert.equal(report.sections.length, 4);
  assert.match(report.text, /\[EMA Cross Strategy — Metadata\]/);
  assert.match(report.text, /Emitted signals: 4/);
  assert.match(report.text, /Accuracy 60m: 66\.67%/);
  assert.match(report.text, /Best directional regime: TREND_UP/);
});

test('adds a comparison summary for multiple research runs', () => {
  const report = generator.generate([createRun('EMA Cross Strategy'), createRun('EMA Trend Strategy')]);

  assert.equal(report.sections.length, 9);
  assert.equal(report.sections[8].type, 'COMPARISON_SUMMARY');
  assert.match(report.text, /Research Run Comparison Summary/);
  assert.match(report.text, /EMA Cross Strategy \| 4/);
  assert.match(report.text, /EMA Trend Strategy \| 4/);
});

test('formats empty optional regime winners as N\/A', () => {
  const report = generator.generate(
    createRun('EMA Cross Strategy', {
      regimeStrategyReport: {
        ...createRun().regimeStrategyReport,
        bestDirectionalRegime: null,
        worstDirectionalRegime: null,
        bestVolatilityRegime: null,
        worstVolatilityRegime: null,
      },
    })
  );

  assert.match(report.text, /Best directional regime: N\/A/);
  assert.match(report.text, /Worst volatility regime: N\/A/);
});

test('formats missing signal frequency as N\/A', () => {
  const run = createRun();
  run.strategyReport.signalFrequencyPerSession = undefined;

  const report = generator.generate(run);

  assert.match(report.text, /Signal frequency per session: N\/A/);
});

test('formats null horizon metrics as N\/A', () => {
  const metrics = createMetrics({ avg60m: null as unknown as number, accuracy60m: null as unknown as number });
  const run = createRun();
  run.strategyReport.performanceMetrics = metrics;

  const report = generator.generate(run);

  assert.match(report.text, /Accuracy 60m: N\/A/);
  assert.match(report.text, /Average 60m movement: N\/A/);
});

test('formats the same input deterministically', () => {
  const run = createRun();

  assert.deepEqual(generator.generate(run), generator.generate(run));
});

test('does not mutate research run input', () => {
  const run = createRun();
  const originalRun = structuredClone(run);

  generator.generate(run);

  assert.deepEqual(run, originalRun);
});
