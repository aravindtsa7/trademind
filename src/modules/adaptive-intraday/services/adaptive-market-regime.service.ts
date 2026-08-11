import {
  AdaptiveMarketRegimeDto,
  AdaptiveMarketRegimeInputDto,
} from '../dto/adaptive-market-regime.dto';
import {
  AdaptiveBreakoutDirection,
  AdaptiveMarketRegimeConfig,
  AdaptivePrimaryMarketRegime,
  AdaptiveVolatilityRegime,
} from '../types/adaptive-market-regime.types';

/**
 * Pure V2 market-state classifier. It consumes precomputed values and keeps
 * primary trend, volatility, and breakout conditions independently visible.
 */
export default class AdaptiveMarketRegimeService {
  private readonly config: AdaptiveMarketRegimeConfig;

  constructor(config: AdaptiveMarketRegimeConfig) {
    this.validateConfig(config);
    this.config = { ...config };
  }

  classify(input: AdaptiveMarketRegimeInputDto): AdaptiveMarketRegimeDto {
    this.validateInput(input);
    const emaDistancePercent = (Math.abs(input.ema15 - input.ema35) / input.close) * 100;
    const atrPercent = (input.atr14 / input.close) * 100;
    const primaryRegime = this.getPrimaryRegime(input, emaDistancePercent);
    const volatilityRegime = this.getVolatilityRegime(atrPercent);
    const breakoutDirection = this.getBreakoutDirection(input);

    return {
      timestamp: new Date(input.timestamp.getTime()),
      primaryRegime,
      volatilityRegime,
      breakoutDirection,
      emaDistancePercent,
      atrPercent,
      reasons: [
        this.getPrimaryReason(input, emaDistancePercent, primaryRegime),
        this.getVolatilityReason(atrPercent, volatilityRegime),
        this.getBreakoutReason(input, breakoutDirection),
      ],
    };
  }

  private getPrimaryRegime(
    input: AdaptiveMarketRegimeInputDto,
    emaDistancePercent: number
  ): AdaptivePrimaryMarketRegime {
    if (
      input.adx14 < this.config.trendStrengthThreshold ||
      emaDistancePercent <= this.config.emaProximityPercent
    ) {
      return AdaptivePrimaryMarketRegime.SIDEWAYS;
    }
    if (input.ema15 > input.ema35 && input.rsi14 > 50) {
      return AdaptivePrimaryMarketRegime.TREND_UP;
    }
    if (input.ema15 < input.ema35 && input.rsi14 < 50) {
      return AdaptivePrimaryMarketRegime.TREND_DOWN;
    }
    return AdaptivePrimaryMarketRegime.SIDEWAYS;
  }

  private getVolatilityRegime(atrPercent: number): AdaptiveVolatilityRegime {
    if (atrPercent >= this.config.highVolatilityThreshold) return AdaptiveVolatilityRegime.HIGH_VOLATILITY;
    if (atrPercent <= this.config.lowVolatilityThreshold) return AdaptiveVolatilityRegime.LOW_VOLATILITY;
    return AdaptiveVolatilityRegime.NORMAL_VOLATILITY;
  }

  private getBreakoutDirection(input: AdaptiveMarketRegimeInputDto): AdaptiveBreakoutDirection {
    if (input.recentHigh !== undefined && input.close > input.recentHigh) return AdaptiveBreakoutDirection.BREAKOUT_UP;
    if (input.recentLow !== undefined && input.close < input.recentLow) return AdaptiveBreakoutDirection.BREAKOUT_DOWN;
    return AdaptiveBreakoutDirection.NONE;
  }

  private getPrimaryReason(
    input: AdaptiveMarketRegimeInputDto,
    emaDistancePercent: number,
    regime: AdaptivePrimaryMarketRegime
  ): string {
    if (regime === AdaptivePrimaryMarketRegime.TREND_UP) {
      return `TREND_UP: EMA15 is above EMA35, RSI14 ${input.rsi14} is above 50, and ADX14 ${input.adx14} meets ${this.config.trendStrengthThreshold}.`;
    }
    if (regime === AdaptivePrimaryMarketRegime.TREND_DOWN) {
      return `TREND_DOWN: EMA15 is below EMA35, RSI14 ${input.rsi14} is below 50, and ADX14 ${input.adx14} meets ${this.config.trendStrengthThreshold}.`;
    }
    if (input.adx14 < this.config.trendStrengthThreshold) {
      return `SIDEWAYS: ADX14 ${input.adx14} is below the trend-strength threshold of ${this.config.trendStrengthThreshold}.`;
    }
    if (emaDistancePercent <= this.config.emaProximityPercent) {
      return `SIDEWAYS: EMA distance ${emaDistancePercent}% is within the proximity threshold of ${this.config.emaProximityPercent}%.`;
    }
    return 'SIDEWAYS: EMA direction and RSI14 do not confirm the same directional trend.';
  }

  private getVolatilityReason(atrPercent: number, regime: AdaptiveVolatilityRegime): string {
    if (regime === AdaptiveVolatilityRegime.HIGH_VOLATILITY) {
      return `HIGH_VOLATILITY: ATR14 is ${atrPercent}% of close, meeting ${this.config.highVolatilityThreshold}%.`;
    }
    if (regime === AdaptiveVolatilityRegime.LOW_VOLATILITY) {
      return `LOW_VOLATILITY: ATR14 is ${atrPercent}% of close, at or below ${this.config.lowVolatilityThreshold}%.`;
    }
    return `NORMAL_VOLATILITY: ATR14 is ${atrPercent}% of close, between configured volatility thresholds.`;
  }

  private getBreakoutReason(input: AdaptiveMarketRegimeInputDto, breakout: AdaptiveBreakoutDirection): string {
    if (breakout === AdaptiveBreakoutDirection.BREAKOUT_UP) return `BREAKOUT_UP: close ${input.close} is above supplied recent high ${input.recentHigh}.`;
    if (breakout === AdaptiveBreakoutDirection.BREAKOUT_DOWN) return `BREAKOUT_DOWN: close ${input.close} is below supplied recent low ${input.recentLow}.`;
    return 'No supplied recent high/low breakout condition is met.';
  }

  private validateConfig(config: AdaptiveMarketRegimeConfig): void {
    if (!config || typeof config !== 'object'
      || !Number.isFinite(config.trendStrengthThreshold) || config.trendStrengthThreshold <= 0
      || !Number.isFinite(config.emaProximityPercent) || config.emaProximityPercent < 0
      || !Number.isFinite(config.highVolatilityThreshold) || config.highVolatilityThreshold <= 0
      || !Number.isFinite(config.lowVolatilityThreshold) || config.lowVolatilityThreshold < 0
      || config.lowVolatilityThreshold >= config.highVolatilityThreshold) {
      throw new Error('Adaptive market regime configuration requires positive trend/high thresholds, non-negative proximity/low thresholds, and low volatility < high volatility.');
    }
  }

  private validateInput(input: AdaptiveMarketRegimeInputDto): void {
    if (!input || typeof input !== 'object'
      || !(input.timestamp instanceof Date) || Number.isNaN(input.timestamp.getTime())
      || !Number.isFinite(input.close) || input.close <= 0
      || !Number.isFinite(input.ema15) || input.ema15 <= 0
      || !Number.isFinite(input.ema35) || input.ema35 <= 0
      || !Number.isFinite(input.rsi14) || input.rsi14 < 0 || input.rsi14 > 100
      || !Number.isFinite(input.adx14) || input.adx14 < 0
      || !Number.isFinite(input.atr14) || input.atr14 < 0
      || (input.recentHigh !== undefined && (!Number.isFinite(input.recentHigh) || input.recentHigh <= 0))
      || (input.recentLow !== undefined && (!Number.isFinite(input.recentLow) || input.recentLow <= 0))) {
      throw new Error('Adaptive market regime received invalid market or indicator values.');
    }
  }
}
