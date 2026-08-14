import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import AdaptiveMarketRegimeService from './adaptive-market-regime.service';
import { prepareCrossSessionIndicatorWarmup } from '../../../tests/helpers/cross-session-indicator-warmup';
import { generateV8BullishReclaimSignals, V8BullishReclaimConfig, V8BullishReclaimSignal, V8IndicatorContext, V8PreparedSession } from '../../research/v8-nifty-bullish-reclaim';

/** Live adapter around the frozen research engine. It only evaluates completed frames. */
export default class V8BullishReclaimShadowEvaluatorService {
  private readonly byMinute = new Map<number, Candle>();
  private readonly emitted = new Set<number>();
  constructor(private readonly config: V8BullishReclaimConfig) {}
  seedHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  recoverHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  processCompletedOneMinute(candle: Candle): void { this.add(candle); }
  evaluateCompletedFrame(candle: Candle): V8BullishReclaimSignal | undefined {
    const sessions = this.prepare();
    const indicators = this.indicators(sessions);
    const eligible = generateV8BullishReclaimSignals(sessions, this.config, indicators)
      .filter((signal) => signal.timestamp.getTime() === candle.timestamp.getTime() + this.config.timeframe * 60_000)
      .filter((signal) => !this.emitted.has(signal.timestamp.getTime()));
    const signal = eligible[0];
    if (signal) this.emitted.add(signal.timestamp.getTime());
    return signal;
  }
  private add(candle: Candle): void { this.byMinute.set(candle.timestamp.getTime(), { ...candle, timestamp: new Date(candle.timestamp.getTime()) }); }
  private prepare(): V8PreparedSession[] {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    const grouped = new Map<string, Candle[]>();
    [...this.byMinute.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).forEach((candle) => { const p = Object.fromEntries(date.formatToParts(candle.timestamp).map((part) => [part.type, part.value])); const key = `${p.year}-${p.month}-${p.day}`; grouped.set(key, [...(grouped.get(key) ?? []), candle]); });
    return prepareCrossSessionIndicatorWarmup([...grouped.entries()].map(([day, candles]) => ({ date: day, candles })), new CandleTimeframeAggregatorService(), new IndicatorEngineService(), new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 })) as V8PreparedSession[];
  }
  private indicators(sessions: readonly V8PreparedSession[]): V8IndicatorContext {
    const engine = new IndicatorEngineService();
    return { atr14ByFrame: new Map(([2, 3] as const).map((timeframe) => { const values = new Map<number, number>(); sessions.forEach((session) => engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }).indicators.find((item) => item.config.type === IndicatorType.ATR)?.result.values.forEach((item) => { if ('value' in item && typeof item.value === 'number') values.set(item.timestamp.getTime(), item.value); })); return [timeframe, values] as const; })) };
  }
}
