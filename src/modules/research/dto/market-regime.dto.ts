import { SuperTrendDirection } from '../../indicators/indicators/supertrend.indicator';
import {
  DirectionalMarketRegime,
  VolatilityMarketRegime,
} from '../types/market-regime.types';

export interface MarketRegimeInputDto {
  timestamp: Date;
  close: number;
  ema20: number;
  ema50: number;
  adx14: number;
  atr14: number;
  superTrendDirection: SuperTrendDirection;
}

export interface MarketRegimeDto {
  timestamp: Date;
  directionalRegime: DirectionalMarketRegime;
  volatilityRegime: VolatilityMarketRegime;
  close: number;
  atrPercent: number;
  reasons: string[];
}
