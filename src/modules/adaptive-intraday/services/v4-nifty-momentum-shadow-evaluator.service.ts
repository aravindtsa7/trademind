import AdxIndicator, { AdxValue } from '../../indicators/indicators/adx.indicator';
import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import AdaptiveMarketRegimeService from './adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../types/adaptive-market-regime.types';

export const v4MomentumShadowStrategyId = 'V4_NIFTY_MOMENTUM_PE_SHADOW';
export const v4MomentumShadowPolicy = { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } as const;
export const v4MomentumShadowConfig = { timeframeMinutes: 3, direction: 'PE', compressionBars: 3, compressionRangeAtrMaximum: 2, bodyAtrMinimum: 1, breakoutAtr: 0.1, requirePrimaryRegimeAlignment: true, cooldownMinutes: 5 } as const;
export interface V4MomentumShadowEvaluation {
  timestamp: Date; close: number; regime?: AdaptivePrimaryMarketRegime; atr: number | null; compressionRange: number | null; compressionRangeAtr: number | null; body: number | null; bodyAtr: number | null; breakoutThreshold: number | null; breakoutPassed: boolean; regimeAligned: boolean; cooldownEligible: boolean; signal: boolean; rejectionReason: string;
}

/** Frozen V4 PE Momentum rule. This service owns no order or paper-position state. */
export default class V4NiftyMomentumShadowEvaluatorService {
  private readonly aggregator = new CandleTimeframeAggregatorService();
  private readonly engine = new IndicatorEngineService();
  private readonly regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.1, lowVolatilityThreshold: 0.05 });
  private readonly oneMinute: Candle[] = [];
  private readonly threeMinute: Candle[] = [];
  private readonly fiveMinute: Candle[] = [];
  private readonly seededThreeMinute = new Set<number>();
  private readonly seededFiveMinute = new Set<number>();
  private lastEntryAt: number | undefined;

  seedHistoricalOneMinute(candles: readonly Candle[]): void {
    if (this.oneMinute.length > 0) throw new Error('V4 shadow historical seed may only run once.');
    candles.forEach((candle, index) => {
      if (!(candle.timestamp instanceof Date) || !Number.isFinite(candle.close) || candle.close <= 0 || (index > 0 && candle.timestamp <= candles[index - 1].timestamp)) throw new Error('V4 shadow warm-up requires chronological valid one-minute candles.');
      this.oneMinute.push(clone(candle));
    });
    const completeOnly = { incompleteLeadingBucket: 'discard' as const, incompleteTrailingBucket: 'discard' as const };
    this.aggregator.aggregate(this.oneMinute, '3m', completeOnly).forEach((candle) => { this.threeMinute.push(clone(candle)); this.seededThreeMinute.add(candle.timestamp.getTime()); });
    this.aggregator.aggregate(this.oneMinute, '5m', completeOnly).forEach((candle) => { this.fiveMinute.push(clone(candle)); this.seededFiveMinute.add(candle.timestamp.getTime()); });
  }

  /**
   * Adds only unseen completed one-minute recovery data; no historical signal is evaluated and
   * cooldown state is preserved. `excludeThreeMinuteBucketsFrom`, when supplied, withholds any
   * 3m bucket starting at or after it from `threeMinute`/`seededThreeMinute` (5m regime state is
   * always seeded in full) -- used only by the A7-H6 source-boundary evaluation path, which
   * needs the one genuine final forward-evaluation opportunity delivered through
   * evaluateCompletedThreeMinute() itself rather than silently pre-seeded here as history.
   */
  recoverHistoricalOneMinute(candles: readonly Candle[], excludeThreeMinuteBucketsFrom?: Date): void {
    let latest = this.oneMinute.at(-1)?.timestamp.getTime() ?? Number.NEGATIVE_INFINITY;
    for (const candle of candles) {
      if (!(candle.timestamp instanceof Date) || !Number.isFinite(candle.close) || candle.close <= 0) throw new Error('V4 recovery requires valid one-minute candles.');
      const timestamp = candle.timestamp.getTime(); if (timestamp <= latest) continue;
      this.oneMinute.push(clone(candle)); latest = timestamp;
    }
    const completeOnly = { incompleteLeadingBucket: 'discard' as const, incompleteTrailingBucket: 'discard' as const };
    const excludeFromMs = excludeThreeMinuteBucketsFrom?.getTime();
    this.aggregator.aggregate(this.oneMinute, '3m', completeOnly).forEach((candle) => { if (excludeFromMs !== undefined && candle.timestamp.getTime() >= excludeFromMs) return; if (!this.threeMinute.some((value) => value.timestamp.getTime() === candle.timestamp.getTime())) { this.threeMinute.push(clone(candle)); this.seededThreeMinute.add(candle.timestamp.getTime()); } });
    this.aggregator.aggregate(this.oneMinute, '5m', completeOnly).forEach((candle) => { if (!this.fiveMinute.some((value) => value.timestamp.getTime() === candle.timestamp.getTime())) { this.fiveMinute.push(clone(candle)); this.seededFiveMinute.add(candle.timestamp.getTime()); } });
  }

  /**
   * Returns the complete 3m bucket starting exactly at `bucketStart`, aggregated fresh from
   * already-recovered one-minute history, without seeding it into `threeMinute`. Used only by
   * the A7-H6 source-boundary evaluation path to reconstruct the one bucket
   * recoverHistoricalOneMinute() above was told to withhold.
   */
  getReconstructedThreeMinuteBucket(bucketStart: Date): Candle | undefined {
    const completeOnly = { incompleteLeadingBucket: 'discard' as const, incompleteTrailingBucket: 'discard' as const };
    return this.aggregator.aggregate(this.oneMinute, '3m', completeOnly).find((candle) => candle.timestamp.getTime() === bucketStart.getTime());
  }

  processCompletedFiveMinute(candle: Candle): void {
    if (this.seededFiveMinute.has(candle.timestamp.getTime()) || this.fiveMinute.some((value) => value.timestamp.getTime() === candle.timestamp.getTime())) return;
    if (this.fiveMinute.length && candle.timestamp <= this.fiveMinute.at(-1)!.timestamp) return;
    this.fiveMinute.push(clone(candle));
  }

  evaluateCompletedThreeMinute(candle: Candle): V4MomentumShadowEvaluation {
    const timestamp = new Date(candle.timestamp.getTime() + v4MomentumShadowConfig.timeframeMinutes * 60_000);
    if (this.seededThreeMinute.has(candle.timestamp.getTime()) || this.threeMinute.some((value) => value.timestamp.getTime() === candle.timestamp.getTime())) return empty(timestamp, candle.close, 'OVERLAPPING_OR_DUPLICATE_COMPLETED_3M_CANDLE');
    if (this.threeMinute.length && candle.timestamp <= this.threeMinute.at(-1)!.timestamp) return empty(timestamp, candle.close, 'OUT_OF_ORDER_COMPLETED_3M_CANDLE');
    this.threeMinute.push(clone(candle));
    const currentDate = marketDate(candle.timestamp);
    const currentSession = this.threeMinute.filter((value) => marketDate(value.timestamp) === currentDate);
    if (currentSession.length < 4) return empty(timestamp, candle.close, 'INSUFFICIENT_CURRENT_SESSION_COMPRESSION_HISTORY');
    const all = this.threeMinute.slice(-84 - currentSession.length, this.threeMinute.length);
    const atr = scalar(this.engine.calculate(all, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }), IndicatorType.ATR, 14).get(candle.timestamp.getTime());
    if (atr === undefined || atr <= 0) return empty(timestamp, candle.close, 'ATR_NOT_READY');
    const prior = currentSession.slice(-4, -1); const high = Math.max(...prior.map((value) => value.high)); const low = Math.min(...prior.map((value) => value.low));
    const range = high - low; const body = Math.abs(candle.close - candle.open); const threshold = low - atr * v4MomentumShadowConfig.breakoutAtr;
    const breakout = candle.close <= threshold && candle.close < candle.open;
    const regime = this.latestRegime(timestamp);
    const aligned = regime === AdaptivePrimaryMarketRegime.TREND_DOWN;
    const cooldown = this.lastEntryAt === undefined || timestamp.getTime() - this.lastEntryAt >= v4MomentumShadowConfig.cooldownMinutes * 60_000;
    const compression = range <= atr * v4MomentumShadowConfig.compressionRangeAtrMaximum; const bodyPass = body >= atr * v4MomentumShadowConfig.bodyAtrMinimum;
    const reason = !compression ? 'COMPRESSION_RANGE_EXCEEDS_2_ATR' : !bodyPass ? 'EXPANSION_BODY_BELOW_1_ATR' : !breakout ? 'BREAKOUT_THRESHOLD_NOT_MET' : !aligned ? 'REGIME_NOT_TREND_DOWN' : !cooldown ? 'COOLDOWN_ACTIVE' : 'V4_MOMENTUM_PE_SIGNAL';
    const signal = reason === 'V4_MOMENTUM_PE_SIGNAL'; if (signal) this.lastEntryAt = timestamp.getTime();
    return { timestamp, close: candle.close, regime, atr, compressionRange: range, compressionRangeAtr: range / atr, body, bodyAtr: body / atr, breakoutThreshold: threshold, breakoutPassed: breakout, regimeAligned: aligned, cooldownEligible: cooldown, signal, rejectionReason: reason };
  }

  private latestRegime(availableAt: Date): AdaptivePrimaryMarketRegime | undefined {
    const all = this.fiveMinute.slice(-50 - this.fiveMinute.filter((value) => marketDate(value.timestamp) === marketDate(availableAt)).length);
    const result = this.engine.calculate(all, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 }] });
    const ema15 = scalar(result, IndicatorType.EMA, 15); const ema35 = scalar(result, IndicatorType.EMA, 35); const rsi = scalar(result, IndicatorType.RSI, 14); const atr = scalar(result, IndicatorType.ATR, 14); const adx = adxMap(result);
    const eligible = all.filter((candle) => candle.timestamp.getTime() + 5 * 60_000 <= availableAt.getTime()).at(-1); if (!eligible) return undefined;
    const key = eligible.timestamp.getTime(); const value = adx.get(key); const fast = ema15.get(key); const slow = ema35.get(key); const r = rsi.get(key); const a = atr.get(key);
    return value === undefined || fast === undefined || slow === undefined || r === undefined || a === undefined ? undefined : this.regimeService.classify({ timestamp: eligible.timestamp, close: eligible.close, ema15: fast, ema35: slow, rsi14: r, adx14: value.adx, atr14: a }).primaryRegime;
  }
}
function scalar(result: ReturnType<IndicatorEngineService['calculate']>, type: IndicatorType, period: number): Map<number, number> { const item = result.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period); const map = new Map<number, number>(); if (!item || !('values' in item.result)) return map; item.result.values.forEach((value) => { if ('value' in value && typeof value.value === 'number') map.set(value.timestamp.getTime(), value.value); }); return map; }
function adxMap(result: ReturnType<IndicatorEngineService['calculate']>): Map<number, AdxValue> { const item = result.indicators.find((entry) => entry.config.type === IndicatorType.ADX); const map = new Map<number, AdxValue>(); if (!item || !('values' in item.result)) return map; item.result.values.forEach((value) => { if ('adx' in value) map.set(value.timestamp.getTime(), value as AdxValue); }); return map; }
function empty(timestamp: Date, close: number, reason: string): V4MomentumShadowEvaluation { return { timestamp, close, regime: undefined, atr: null, compressionRange: null, compressionRangeAtr: null, body: null, bodyAtr: null, breakoutThreshold: null, breakoutPassed: false, regimeAligned: false, cooldownEligible: false, signal: false, rejectionReason: reason }; }
function clone(candle: Candle): Candle { return { ...candle, timestamp: new Date(candle.timestamp.getTime()) }; }
function marketDate(value: Date): string { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value).map((part) => [part.type, part.value])); return `${p.year}-${p.month}-${p.day}`; }
