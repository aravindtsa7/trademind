import {
  AdaptiveBreakoutDirection,
  AdaptivePrimaryMarketRegime,
  AdaptiveVolatilityRegime,
} from '../types/adaptive-market-regime.types';

export interface AdaptiveMarketRegimeInputDto {
  timestamp: Date;
  close: number;
  ema15: number;
  ema35: number;
  rsi14: number;
  adx14: number;
  atr14: number;
  recentHigh?: number;
  recentLow?: number;
}

export interface AdaptiveMarketRegimeDto {
  timestamp: Date;
  primaryRegime: AdaptivePrimaryMarketRegime;
  volatilityRegime: AdaptiveVolatilityRegime;
  breakoutDirection: AdaptiveBreakoutDirection;
  emaDistancePercent: number;
  atrPercent: number;
  reasons: string[];
}
