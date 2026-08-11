import { AdaptivePrimaryMarketRegime } from '../types/adaptive-market-regime.types';

export type V2DecisionReason = 'ENTER_TREND_DOWN_PE' | 'BLOCKED_NOT_READY' | 'BLOCKED_NOT_TREND_DOWN' | 'BLOCKED_RSI' | 'BLOCKED_PROXIMITY' | 'BLOCKED_COOLDOWN';
export interface V2TrendDownEntryInput { completedCandleTimestamp: Date; regime: AdaptivePrimaryMarketRegime | undefined; close: number | undefined; high: number | undefined; ema35: number | undefined; rsi14: number | undefined; }
export interface V2TrendDownEntryDecision { entry: boolean; reason: V2DecisionReason; proximityPercent: number | null; cooldownEligible: boolean; }

/** Frozen V2 research rule: close < EMA35, high within 0.20% of EMA35, RSI14 < 35. */
export default class V2TrendDownEntryEvaluatorService {
  private lastEntryTimestamp: number | undefined;
  evaluate(input: V2TrendDownEntryInput): V2TrendDownEntryDecision {
    if (input.close === undefined || input.high === undefined || input.ema35 === undefined || input.rsi14 === undefined || input.ema35 <= 0) return { entry: false, reason: 'BLOCKED_NOT_READY', proximityPercent: null, cooldownEligible: false };
    const proximityPercent = Math.abs(input.high - input.ema35) / input.ema35 * 100;
    const cooldownEligible = this.lastEntryTimestamp === undefined || input.completedCandleTimestamp.getTime() - this.lastEntryTimestamp >= 10 * 60_000;
    if (input.regime !== AdaptivePrimaryMarketRegime.TREND_DOWN) return { entry: false, reason: 'BLOCKED_NOT_TREND_DOWN', proximityPercent, cooldownEligible };
    if (input.rsi14 >= 35) return { entry: false, reason: 'BLOCKED_RSI', proximityPercent, cooldownEligible };
    if (!(input.close < input.ema35 && proximityPercent <= 0.20)) return { entry: false, reason: 'BLOCKED_PROXIMITY', proximityPercent, cooldownEligible };
    if (!cooldownEligible) return { entry: false, reason: 'BLOCKED_COOLDOWN', proximityPercent, cooldownEligible };
    this.lastEntryTimestamp = input.completedCandleTimestamp.getTime();
    return { entry: true, reason: 'ENTER_TREND_DOWN_PE', proximityPercent, cooldownEligible };
  }
}
