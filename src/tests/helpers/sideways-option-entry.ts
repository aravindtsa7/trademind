import { Candle } from '../../modules/indicators/types';

export type SidewaysEntryFamily = 'FALSE_BREAKOUT_DOWN_CE' | 'FALSE_BREAKOUT_UP_PE' | 'SUPPORT_BOUNCE_CE' | 'RESISTANCE_REJECTION_PE';

export interface SidewaysEntryMatchRequest {
  family: SidewaysEntryFamily;
  candle: Candle;
  priorCandles: readonly Candle[];
  breakThresholdPercent?: number;
  reclaimPercent?: number;
  proximityPercent?: number;
}

export function matchesSidewaysOptionEntry(request: SidewaysEntryMatchRequest): boolean {
  const { family, candle, priorCandles } = request;
  if (priorCandles.length === 0) return false;
  const support = Math.min(...priorCandles.map((entry) => entry.low));
  const resistance = Math.max(...priorCandles.map((entry) => entry.high));
  if (family === 'FALSE_BREAKOUT_DOWN_CE') {
    const threshold = request.breakThresholdPercent ?? 0;
    const reclaim = request.reclaimPercent ?? 0;
    return candle.low < support * (1 - threshold / 100) && candle.close >= support * (1 + reclaim / 100);
  }
  if (family === 'FALSE_BREAKOUT_UP_PE') {
    const threshold = request.breakThresholdPercent ?? 0;
    const reclaim = request.reclaimPercent ?? 0;
    return candle.high > resistance * (1 + threshold / 100) && candle.close <= resistance * (1 - reclaim / 100);
  }
  const proximity = request.proximityPercent ?? 0;
  if (family === 'SUPPORT_BOUNCE_CE') return candle.close >= support && (candle.close - support) / candle.close * 100 <= proximity;
  return candle.close <= resistance && (resistance - candle.close) / candle.close * 100 <= proximity;
}
