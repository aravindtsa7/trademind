export enum AdaptivePrimaryMarketRegime {
  TREND_UP = 'TREND_UP',
  TREND_DOWN = 'TREND_DOWN',
  SIDEWAYS = 'SIDEWAYS',
}

export enum AdaptiveVolatilityRegime {
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  NORMAL_VOLATILITY = 'NORMAL_VOLATILITY',
  LOW_VOLATILITY = 'LOW_VOLATILITY',
}

export enum AdaptiveBreakoutDirection {
  NONE = 'NONE',
  BREAKOUT_UP = 'BREAKOUT_UP',
  BREAKOUT_DOWN = 'BREAKOUT_DOWN',
}

export interface AdaptiveMarketRegimeConfig {
  trendStrengthThreshold: number;
  emaProximityPercent: number;
  highVolatilityThreshold: number;
  lowVolatilityThreshold: number;
}
