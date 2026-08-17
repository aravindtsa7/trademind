import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import AdaptiveMarketRegimeService from './adaptive-market-regime.service';
import { prepareCrossSessionIndicatorWarmup } from '../../../tests/helpers/cross-session-indicator-warmup';
import { evaluateV8BullishReclaimFrames, V8BullishReclaimConfig, V8BullishReclaimEvaluation, V8BullishReclaimSignal, V8IndicatorContext, V8PreparedSession } from '../../research/v8-nifty-bullish-reclaim';

export interface V8LiveFrameEvaluation {
  evaluation: V8BullishReclaimEvaluation;
  signal?: V8BullishReclaimSignal;
}

export interface V8LiveCandleEvent {
  instrumentKey?: unknown;
  completed?: unknown;
  candleTime?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
}

/** The live adapter is deliberately fed only completed, valid underlying bars. */
export function isV8CompletedUnderlyingCandleEvent(value: V8LiveCandleEvent, underlyingInstrument: string): boolean {
  return value.instrumentKey === underlyingInstrument
    && value.completed === true
    && value.candleTime instanceof Date
    && !Number.isNaN(value.candleTime.getTime())
    && [value.open, value.high, value.low, value.close].every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/** Runtime-only counters used by concise shadow-status observability. */
export class V8ShadowRuntimeCounters {
  private completed2m = 0;
  private signals = 0;
  private closed = 0;
  markCompleted2m(): void { this.completed2m += 1; }
  markSignal(): void { this.signals += 1; }
  markClosed(): void { this.closed += 1; }
  snapshot(): Readonly<{ completed2m: number; signals: number; closed: number }> {
    return Object.freeze({ completed2m: this.completed2m, signals: this.signals, closed: this.closed });
  }
}

/** Live adapter around the frozen research engine. It only evaluates completed frames. */
export default class V8BullishReclaimShadowEvaluatorService {
  private readonly byMinute = new Map<number, Candle>();
  private readonly emitted = new Set<number>();
  constructor(private readonly config: V8BullishReclaimConfig) {}
  seedHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  recoverHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  processCompletedOneMinute(candle: Candle): void { this.add(candle); }
  evaluateCompletedFrame(candle: Candle): V8BullishReclaimSignal | undefined {
    return this.evaluateCompletedFrameWithDiagnostics(candle).signal;
  }
  /**
   * Returns the frozen decision plus a read-only explanation for its completed
   * frame.  Duplicate completed-frame callbacks remain suppressed here rather
   * than leaking through to the shadow runtime.
   */
  evaluateCompletedFrameWithDiagnostics(candle: Candle): V8LiveFrameEvaluation {
    const sessions = this.prepare();
    const indicators = this.indicators(sessions);
    const timestamp = candle.timestamp.getTime() + this.config.timeframe * 60_000;
    const evaluation = evaluateV8BullishReclaimFrames(sessions, this.config, indicators)
      .find((value) => value.timestamp.getTime() === timestamp);
    if (!evaluation) throw new Error(`V8 completed frame has no diagnostic evaluation at ${new Date(timestamp).toISOString()}.`);
    if (!evaluation.signalValue) return { evaluation };
    if (this.emitted.has(timestamp)) {
      return { evaluation: { ...evaluation, signal: false, signalValue: undefined, reason: 'DUPLICATE_COMPLETED_FRAME_SUPPRESSED' } };
    }
    this.emitted.add(timestamp);
    return { evaluation, signal: evaluation.signalValue };
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
