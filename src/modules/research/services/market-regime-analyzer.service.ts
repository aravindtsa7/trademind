import { SuperTrendDirection } from '../../indicators/indicators/supertrend.indicator';
import { MarketRegimeDto, MarketRegimeInputDto } from '../dto/market-regime.dto';
import {
  DirectionalMarketRegime,
  MarketRegimeAnalyzerConfig,
  VolatilityMarketRegime,
} from '../types/market-regime.types';

export default class MarketRegimeAnalyzerService {
  private readonly config: MarketRegimeAnalyzerConfig;

  constructor(config: MarketRegimeAnalyzerConfig) {
    this.validateConfig(config);
    this.config = { ...config };
  }

  analyze(input: MarketRegimeInputDto): MarketRegimeDto {
    this.validateInput(input);

    const atrPercent = (input.atr14 / input.close) * 100;
    const directionalRegime = this.getDirectionalRegime(input);
    const volatilityRegime = this.getVolatilityRegime(atrPercent);

    return {
      timestamp: input.timestamp,
      directionalRegime,
      volatilityRegime,
      close: input.close,
      atrPercent,
      reasons: [
        this.getDirectionalReason(input, directionalRegime),
        this.getVolatilityReason(atrPercent, volatilityRegime),
      ],
    };
  }

  private getDirectionalRegime(input: MarketRegimeInputDto): DirectionalMarketRegime {
    if (input.adx14 < 20) {
      return DirectionalMarketRegime.SIDEWAYS;
    }

    if (
      input.ema20 > input.ema50 &&
      input.superTrendDirection === SuperTrendDirection.UP
    ) {
      return DirectionalMarketRegime.TREND_UP;
    }

    if (
      input.ema20 < input.ema50 &&
      input.superTrendDirection === SuperTrendDirection.DOWN
    ) {
      return DirectionalMarketRegime.TREND_DOWN;
    }

    return DirectionalMarketRegime.SIDEWAYS;
  }

  private getVolatilityRegime(atrPercent: number): VolatilityMarketRegime {
    if (atrPercent >= this.config.highVolatilityThreshold) {
      return VolatilityMarketRegime.HIGH_VOLATILITY;
    }

    if (atrPercent <= this.config.lowVolatilityThreshold) {
      return VolatilityMarketRegime.LOW_VOLATILITY;
    }

    return VolatilityMarketRegime.NORMAL_VOLATILITY;
  }

  private getDirectionalReason(
    input: MarketRegimeInputDto,
    directionalRegime: DirectionalMarketRegime
  ): string {
    switch (directionalRegime) {
      case DirectionalMarketRegime.TREND_UP:
        return `EMA20 is above EMA50, ADX14 ${input.adx14} is at least 20, and SuperTrend is UP.`;
      case DirectionalMarketRegime.TREND_DOWN:
        return `EMA20 is below EMA50, ADX14 ${input.adx14} is at least 20, and SuperTrend is DOWN.`;
      case DirectionalMarketRegime.SIDEWAYS:
        return input.adx14 < 20
          ? `ADX14 ${input.adx14} is below 20.`
          : 'EMA and SuperTrend direction do not confirm the same trend.';
    }
  }

  private getVolatilityReason(
    atrPercent: number,
    volatilityRegime: VolatilityMarketRegime
  ): string {
    switch (volatilityRegime) {
      case VolatilityMarketRegime.HIGH_VOLATILITY:
        return `ATR14 is ${atrPercent}% of close, meeting the high-volatility threshold of ${this.config.highVolatilityThreshold}%.`;
      case VolatilityMarketRegime.LOW_VOLATILITY:
        return `ATR14 is ${atrPercent}% of close, meeting the low-volatility threshold of ${this.config.lowVolatilityThreshold}%.`;
      case VolatilityMarketRegime.NORMAL_VOLATILITY:
        return `ATR14 is ${atrPercent}% of close, between the configured volatility thresholds.`;
    }
  }

  private validateConfig(config: MarketRegimeAnalyzerConfig): void {
    if (
      !Number.isFinite(config.highVolatilityThreshold) ||
      !Number.isFinite(config.lowVolatilityThreshold) ||
      config.highVolatilityThreshold <= 0 ||
      config.lowVolatilityThreshold < 0 ||
      config.lowVolatilityThreshold >= config.highVolatilityThreshold
    ) {
      throw new Error(
        'Market regime volatility thresholds must be finite, non-negative, and low < high.'
      );
    }
  }

  private validateInput(input: MarketRegimeInputDto): void {
    if (
      !(input.timestamp instanceof Date) ||
      Number.isNaN(input.timestamp.getTime()) ||
      !Number.isFinite(input.close) ||
      input.close <= 0 ||
      !Number.isFinite(input.ema20) ||
      !Number.isFinite(input.ema50) ||
      !Number.isFinite(input.adx14) ||
      !Number.isFinite(input.atr14) ||
      input.atr14 < 0 ||
      (input.superTrendDirection !== SuperTrendDirection.UP &&
        input.superTrendDirection !== SuperTrendDirection.DOWN)
    ) {
      throw new Error('Market Regime Analyzer received invalid indicator values.');
    }
  }
}
