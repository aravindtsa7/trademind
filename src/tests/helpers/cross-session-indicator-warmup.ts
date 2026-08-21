import { AdxValue } from '../../modules/indicators/indicators/adx.indicator';
import CandleTimeframeAggregatorService from '../../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../modules/indicators/types';
import AdaptiveMarketRegimeService from '../../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../../modules/adaptive-intraday/types/adaptive-market-regime.types';

export const crossSessionWarmupFiveMinuteBars = 50;
export type CrossSessionEntryTimeframe = 1 | 2 | 3 | 5;

export interface CrossSessionSourceSession {
  date: string;
  candles: readonly Candle[];
  /**
   * Opt-in only. When true, this session's trailing 5-minute bucket is
   * discarded instead of throwing when naturally incomplete (the current/
   * forming target session). Every existing caller omits this field, so
   * default behaviour (strict 5m aggregation) is unchanged.
   */
  allowIncompleteTrailingFiveMinuteBucket?: boolean;
}
export interface CrossSessionEntryFrame { minutes: CrossSessionEntryTimeframe; candles: Candle[]; allCandles: Candle[]; ema15: Map<number, number>; ema35: Map<number, number>; rsi14: Map<number, number>; }
export interface CrossSessionRegimePoint { availableAt: Date; regime: AdaptivePrimaryMarketRegime | undefined; }
export interface CrossSessionReadiness { at0915: boolean; at0920: boolean; at0930: boolean; }
export interface CrossSessionPreparedSession { date: string; oneMinute: Candle[]; frames: Record<CrossSessionEntryTimeframe, CrossSessionEntryFrame>; regimePoints: CrossSessionRegimePoint[]; readiness: CrossSessionReadiness; }

const timeframeWarmupBars: Record<CrossSessionEntryTimeframe, number> = { 1: 250, 2: 125, 3: 84, 5: crossSessionWarmupFiveMinuteBars };

export function prepareCrossSessionIndicatorWarmup(
  source: readonly CrossSessionSourceSession[],
  aggregator: CandleTimeframeAggregatorService,
  engine: IndicatorEngineService,
  regimeService: AdaptiveMarketRegimeService,
): CrossSessionPreparedSession[] {
  const sessions = source.map((entry) => ({ date: entry.date, frames: createBaseFrames(entry.candles, aggregator, entry.allowIncompleteTrailingFiveMinuteBucket === true) }));
  return sessions.map((target, targetIndex) => {
    const prior = sessions.slice(0, targetIndex);
    const frames = ([1, 2, 3, 5] as const).reduce((result, minutes) => {
      const warmup = prior.flatMap((session) => session.frames[minutes]).slice(-timeframeWarmupBars[minutes]);
      result[minutes] = createEntryFrame([...warmup, ...target.frames[minutes]], target.frames[minutes], minutes, engine);
      return result;
    }, {} as Record<CrossSessionEntryTimeframe, CrossSessionEntryFrame>);
    const regimeIndicators = engine.calculate(frames[5].allCandles, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 }] });
    const ema15 = scalarMap(regimeIndicators, IndicatorType.EMA, 15); const ema35 = scalarMap(regimeIndicators, IndicatorType.EMA, 35); const rsi14 = scalarMap(regimeIndicators, IndicatorType.RSI, 14); const adx14 = adxMap(regimeIndicators); const atr14 = scalarMap(regimeIndicators, IndicatorType.ATR, 14);
    const regimePoints = frames[5].allCandles.map((candle) => {
      const key = candle.timestamp.getTime(); const adx = adx14.get(key); const fast = ema15.get(key); const slow = ema35.get(key); const rsi = rsi14.get(key); const atr = atr14.get(key);
      return { availableAt: new Date(key + 5 * 60_000), regime: fast === undefined || slow === undefined || rsi === undefined || !adx || atr === undefined ? undefined : regimeService.classify({ timestamp: candle.timestamp, close: candle.close, ema15: fast, ema35: slow, rsi14: rsi, adx14: adx.adx, atr14: atr }).primaryRegime };
    });
    const prepared: CrossSessionPreparedSession = { date: target.date, oneMinute: cloneCandles(target.frames[1]), frames, regimePoints, readiness: { at0915: false, at0920: false, at0930: false } };
    prepared.readiness = { at0915: isReadyAt(prepared, target.frames[1][0].timestamp), at0920: isReadyAt(prepared, new Date(target.frames[1][0].timestamp.getTime() + 5 * 60_000)), at0930: isReadyAt(prepared, new Date(target.frames[1][0].timestamp.getTime() + 15 * 60_000)) };
    assertNoFutureWarmup(prepared);
    return prepared;
  });
}

/**
 * Restricts the sessions that are research targets after indicator preparation.
 * Keeping this separate from preparation preserves each target's warm-up from
 * earlier completed trading sessions.
 */
export function filterCrossSessionResearchTargets(
  sessions: readonly CrossSessionPreparedSession[],
  endDate: string | undefined,
): CrossSessionPreparedSession[] {
  return endDate === undefined ? [...sessions] : sessions.filter((session) => session.date <= endDate);
}

export function isReadyAt(session: CrossSessionPreparedSession, timestamp: Date): boolean {
  const regimeReady = session.regimePoints.some((point) => point.availableAt.getTime() <= timestamp.getTime() && point.regime !== undefined);
  return regimeReady && ([1, 2, 3, 5] as const).every((minutes) => session.frames[minutes].allCandles.some((candle) => candle.timestamp.getTime() + minutes * 60_000 <= timestamp.getTime() && session.frames[minutes].ema15.has(candle.timestamp.getTime()) && session.frames[minutes].ema35.has(candle.timestamp.getTime()) && session.frames[minutes].rsi14.has(candle.timestamp.getTime())));
}

export function assertNoFutureWarmup(session: CrossSessionPreparedSession): void {
  const targetStart = session.oneMinute[0]?.timestamp.getTime();
  if (targetStart === undefined) throw new Error('A target session requires one-minute candles.');
  ([1, 2, 3, 5] as const).forEach((minutes) => {
    session.frames[minutes].allCandles.filter((candle) => candle.timestamp.getTime() < targetStart).forEach((candle) => {
      if (candle.timestamp.getTime() >= targetStart) throw new Error('Warm-up candles must precede the target session.');
    });
  });
}

export function isCooldownEligible(lastSignalTimestamp: number | undefined, timestamp: number, cooldownMinutes: number): boolean {
  return lastSignalTimestamp === undefined || timestamp - lastSignalTimestamp >= cooldownMinutes * 60_000;
}

export function sameIstTradingDate<T extends { candleTime: Date }>(candles: readonly T[], timestamp: Date): T[] {
  const date = marketDate(timestamp);
  return candles.filter((candle) => marketDate(candle.candleTime) === date);
}

function createBaseFrames(candles: readonly Candle[], aggregator: CandleTimeframeAggregatorService, allowIncompleteTrailingFiveMinuteBucket = false): Record<CrossSessionEntryTimeframe, Candle[]> {
  const oneMinute = cloneCandles(candles).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const fiveMinuteOptions = allowIncompleteTrailingFiveMinuteBucket ? { incompleteTrailingBucket: 'discard' as const } : {};
  return { 1: oneMinute, 2: aggregateAnchored(oneMinute, 2), 3: aggregateAnchored(oneMinute, 3), 5: aggregator.aggregate(oneMinute, '5m', fiveMinuteOptions) };
}
function aggregateAnchored(oneMinute: readonly Candle[], minutes: 2 | 3): Candle[] { const result: Candle[] = []; for (let index = 0; index + minutes <= oneMinute.length; index += minutes) { const slice = oneMinute.slice(index, index + minutes); result.push({ timestamp: new Date(slice[0].timestamp.getTime()), open: slice[0].open, high: Math.max(...slice.map((candle) => candle.high)), low: Math.min(...slice.map((candle) => candle.low)), close: slice[slice.length - 1].close, volume: slice.reduce((total, candle) => total + candle.volume, 0), openInterest: slice[slice.length - 1].openInterest }); } return result; }
function createEntryFrame(allCandles: Candle[], targetCandles: Candle[], minutes: CrossSessionEntryTimeframe, engine: IndicatorEngineService): CrossSessionEntryFrame { const results = engine.calculate(allCandles, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }] }); return { minutes, candles: cloneCandles(targetCandles), allCandles: cloneCandles(allCandles), ema15: scalarMap(results, IndicatorType.EMA, 15), ema35: scalarMap(results, IndicatorType.EMA, 35), rsi14: scalarMap(results, IndicatorType.RSI, 14) }; }
function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period); if (!indicator) throw new Error(`Missing ${type}${period}.`); const values = new Map<number, number>(); indicator.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); }); return values; }
function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> { const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14); if (!indicator) throw new Error('Missing ADX14.'); const values = new Map<number, AdxValue>(); indicator.result.values.forEach((entry) => { if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date }); }); return values; }
function cloneCandles(candles: readonly Candle[]): Candle[] { return candles.map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp.getTime()) })); }
function marketDate(timestamp: Date): string { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
