import assert from 'node:assert/strict';
import test from 'node:test';
import { RegimeStrategyAnalysisInputDto } from '../modules/research/dto/regime-strategy-report.dto';
import RegimeStrategyAnalyzerService from '../modules/research/services/regime-strategy-analyzer.service';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../modules/research/types/market-regime.types';

const analyzer = new RegimeStrategyAnalyzerService();

function createSignal(
  directionalRegime: DirectionalMarketRegime,
  volatilityRegime: VolatilityMarketRegime,
  directional60m: number | null,
  signal: 'BUY_CE' | 'BUY_PE' = 'BUY_CE'
) {
  return {
    signal,
    directionalRegime,
    volatilityRegime,
    directionalPoints: {
      '5m': directional60m,
      '15m': directional60m,
      '30m': directional60m,
      '60m': directional60m,
    },
    mfe: directional60m === null ? null : Math.max(directional60m, 0) + 5,
    mae: directional60m === null ? null : Math.max(-directional60m, 0) + 2,
  };
}

function createInput(
  signalResults: RegimeStrategyAnalysisInputDto['signalResults']
): RegimeStrategyAnalysisInputDto {
  return {
    strategyId: 'ema-trend-confirmation',
    strategyName: 'EMA Trend Confirmation',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '5m',
    fromDate: '2026-07-10',
    toDate: '2026-08-05',
    signalResults,
  };
}

test('groups mixed directional regimes independently', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.NORMAL_VOLATILITY, -2),
      createSignal(DirectionalMarketRegime.SIDEWAYS, VolatilityMarketRegime.NORMAL_VOLATILITY, 1),
    ])
  );

  assert.equal(report.directionalRegimePerformance[DirectionalMarketRegime.TREND_UP].signalCount, 1);
  assert.equal(report.directionalRegimePerformance[DirectionalMarketRegime.TREND_DOWN].signalCount, 1);
  assert.equal(report.directionalRegimePerformance[DirectionalMarketRegime.SIDEWAYS].signalCount, 1);
});

test('groups mixed volatility regimes independently', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.HIGH_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 2),
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.LOW_VOLATILITY, -1),
    ])
  );

  assert.equal(report.volatilityRegimePerformance[VolatilityMarketRegime.HIGH_VOLATILITY].signalCount, 1);
  assert.equal(report.volatilityRegimePerformance[VolatilityMarketRegime.NORMAL_VOLATILITY].signalCount, 1);
  assert.equal(report.volatilityRegimePerformance[VolatilityMarketRegime.LOW_VOLATILITY].signalCount, 1);
});

test('selects the best directional regime by 60-minute accuracy', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.NORMAL_VOLATILITY, -1),
    ])
  );

  assert.equal(report.bestDirectionalRegime, DirectionalMarketRegime.TREND_UP);
});

test('selects the worst directional regime by 60-minute accuracy', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.NORMAL_VOLATILITY, -1),
    ])
  );

  assert.equal(report.worstDirectionalRegime, DirectionalMarketRegime.TREND_DOWN);
});

test('selects the best volatility regime by 60-minute accuracy', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.HIGH_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.LOW_VOLATILITY, -1),
    ])
  );

  assert.equal(report.bestVolatilityRegime, VolatilityMarketRegime.HIGH_VOLATILITY);
});

test('selects the worst volatility regime by 60-minute accuracy', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.HIGH_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.LOW_VOLATILITY, -1),
    ])
  );

  assert.equal(report.worstVolatilityRegime, VolatilityMarketRegime.LOW_VOLATILITY);
});

test('uses average 60-minute movement as a tie-breaker and returns null for a true tie', () => {
  const resolvedTie = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.NORMAL_VOLATILITY, 2),
    ])
  );
  const trueTie = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
    ])
  );

  assert.equal(resolvedTie.bestDirectionalRegime, DirectionalMarketRegime.TREND_UP);
  assert.equal(trueTie.bestDirectionalRegime, null);
  assert.equal(trueTie.worstDirectionalRegime, null);
});

test('includes empty regime groups with zero counts', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
    ])
  );

  assert.equal(report.directionalRegimePerformance[DirectionalMarketRegime.SIDEWAYS].signalCount, 0);
  assert.equal(
    report.volatilityRegimePerformance[VolatilityMarketRegime.HIGH_VOLATILITY].evaluableSignalCount,
    0
  );
});

test('returns null selections when there is no evaluable 60-minute data', () => {
  const report = analyzer.analyze(
    createInput([
      createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, null),
      createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.HIGH_VOLATILITY, null),
    ])
  );

  assert.equal(report.bestDirectionalRegime, null);
  assert.equal(report.worstDirectionalRegime, null);
  assert.equal(report.bestVolatilityRegime, null);
  assert.equal(report.worstVolatilityRegime, null);
});

test('does not mutate regime-tagged signal outcomes', () => {
  const input = createInput([
    createSignal(DirectionalMarketRegime.TREND_UP, VolatilityMarketRegime.NORMAL_VOLATILITY, 5),
    createSignal(DirectionalMarketRegime.TREND_DOWN, VolatilityMarketRegime.HIGH_VOLATILITY, -2),
  ]);
  const originalInput = {
    ...input,
    signalResults: input.signalResults.map((signalResult) => ({
      ...signalResult,
      directionalPoints: { ...signalResult.directionalPoints },
    })),
  };

  analyzer.analyze(input);

  assert.deepEqual(input, originalInput);
});
