export enum DirectionalMarketRegime {
  TREND_UP = 'TREND_UP',
  TREND_DOWN = 'TREND_DOWN',
  SIDEWAYS = 'SIDEWAYS',
}

export enum VolatilityMarketRegime {
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_VOLATILITY = 'LOW_VOLATILITY',
  NORMAL_VOLATILITY = 'NORMAL_VOLATILITY',
}

export interface MarketRegimeAnalyzerConfig {
  highVolatilityThreshold: number;
  lowVolatilityThreshold: number;
}
