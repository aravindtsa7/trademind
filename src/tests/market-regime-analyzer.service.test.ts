import assert from 'node:assert/strict';
import test from 'node:test';
import { SuperTrendDirection } from '../modules/indicators/indicators/supertrend.indicator';
import { MarketRegimeInputDto } from '../modules/research/dto/market-regime.dto';
import MarketRegimeAnalyzerService from '../modules/research/services/market-regime-analyzer.service';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../modules/research/types/market-regime.types';

const analyzer = new MarketRegimeAnalyzerService({
  highVolatilityThreshold: 0.5,
  lowVolatilityThreshold: 0.1,
});
const timestamp = new Date('2026-08-03T09:15:00+05:30');

function createInput(overrides: Partial<MarketRegimeInputDto> = {}): MarketRegimeInputDto {
  return {
    timestamp,
    close: 100,
    ema20: 102,
    ema50: 100,
    adx14: 25,
    atr14: 0.2,
    superTrendDirection: SuperTrendDirection.UP,
    ...overrides,
  };
}

test('classifies a confirmed upward trend', () => {
  const result = analyzer.analyze(createInput());

  assert.equal(result.directionalRegime, DirectionalMarketRegime.TREND_UP);
});

test('classifies a confirmed downward trend', () => {
  const result = analyzer.analyze(
    createInput({
      ema20: 98,
      ema50: 100,
      superTrendDirection: SuperTrendDirection.DOWN,
    })
  );

  assert.equal(result.directionalRegime, DirectionalMarketRegime.TREND_DOWN);
});

test('classifies low-ADX conditions as sideways', () => {
  const result = analyzer.analyze(createInput({ adx14: 19 }));

  assert.equal(result.directionalRegime, DirectionalMarketRegime.SIDEWAYS);
});

test('classifies high volatility from ATR percentage', () => {
  const result = analyzer.analyze(createInput({ atr14: 0.5 }));

  assert.equal(result.atrPercent, 0.5);
  assert.equal(result.volatilityRegime, VolatilityMarketRegime.HIGH_VOLATILITY);
});

test('classifies low volatility from ATR percentage', () => {
  const result = analyzer.analyze(createInput({ atr14: 0.1 }));

  assert.equal(result.volatilityRegime, VolatilityMarketRegime.LOW_VOLATILITY);
});

test('classifies ATR percentages between thresholds as normal volatility', () => {
  const result = analyzer.analyze(createInput({ atr14: 0.2 }));

  assert.equal(result.volatilityRegime, VolatilityMarketRegime.NORMAL_VOLATILITY);
});

test('treats ADX exactly at 20 as eligible for trend classification', () => {
  const result = analyzer.analyze(createInput({ adx14: 20 }));

  assert.equal(result.directionalRegime, DirectionalMarketRegime.TREND_UP);
});

test('rejects invalid volatility thresholds', () => {
  assert.throws(
    () =>
      new MarketRegimeAnalyzerService({ highVolatilityThreshold: 0.1, lowVolatilityThreshold: 0.1 }),
    /low < high/
  );
  assert.throws(
    () =>
      new MarketRegimeAnalyzerService({ highVolatilityThreshold: Number.NaN, lowVolatilityThreshold: 0.1 }),
    /thresholds/
  );
});

test('rejects invalid close and ATR values', () => {
  assert.throws(() => analyzer.analyze(createInput({ close: 0 })), /invalid indicator values/);
  assert.throws(() => analyzer.analyze(createInput({ atr14: -1 })), /invalid indicator values/);
});

test('does not mutate pre-calculated indicator input', () => {
  const input = createInput();
  const originalInput = { ...input };

  analyzer.analyze(input);

  assert.deepEqual(input, originalInput);
});
