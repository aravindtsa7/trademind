import { Candle } from '../../indicators/types';
import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
export type V8EntryTimeframe = 2 | 3;
export interface V8PreparedFrame { candles: Candle[]; rsi14: ReadonlyMap<number, number>; }
export interface V8PreparedRegimePoint { availableAt: Date; regime: AdaptivePrimaryMarketRegime | undefined; }
export interface V8PreparedSession { date: string; oneMinute: Candle[]; frames: Record<V8EntryTimeframe, V8PreparedFrame>; regimePoints: V8PreparedRegimePoint[]; }

export const V8_STRATEGY_ID = 'V8_NIFTY_BULLISH_RECLAIM_CE';
export const V8_RECENT_SWING_LOOKBACK = 10;

export type V8LevelFamily = 'PDH' | 'OR15_HIGH' | 'OR30_HIGH' | 'RECENT_SWING_HIGH';
export type V8RegimeMode = 'ANY_EXCEPT_TREND_DOWN' | 'TREND_UP_ONLY' | 'NO_REGIME_FILTER';
export type V8ReclaimBufferAtr = 0 | 0.05 | 0.1 | 0.15;
export type V8BodyAtr = 0.25 | 0.5 | 0.75 | 1;
export type V8RsiMinimum = 'NONE' | 50 | 55 | 60;
export type V8CooldownMinutes = 5 | 10 | 15;

export interface V8BullishReclaimConfig {
  timeframe: V8EntryTimeframe;
  levelFamily: V8LevelFamily;
  reclaimBufferAtr: V8ReclaimBufferAtr;
  bullishBodyAtr: V8BodyAtr;
  rsiMinimum: V8RsiMinimum;
  regimeMode: V8RegimeMode;
  cooldownMinutes: V8CooldownMinutes;
}

export interface V8IndicatorContext {
  atr14ByFrame: ReadonlyMap<V8EntryTimeframe, ReadonlyMap<number, number>>;
}

export interface V8BullishReclaimSignal {
  strategyId: typeof V8_STRATEGY_ID;
  configKey: string;
  date: string;
  timestamp: Date;
  direction: 'CE';
  levelFamily: V8LevelFamily;
  structuralLevel: number;
  spotPrice: number;
  atr14: number;
  body: number;
  bodyAtr: number;
  reclaimBufferAtr: number;
  rsi14: number | null;
  interactionTimestamp?: Date;
  regime?: AdaptivePrimaryMarketRegime;
  regimeAvailableAt?: Date;
}

/**
 * Read-only explanation of one completed V8 frame.  This mirrors the frozen
 * signal sequence so live shadow observability can explain a non-signal
 * without changing signal generation.
 */
export type V8BullishReclaimEvaluationReason =
  | 'ATR_UNAVAILABLE'
  | 'PDH_UNAVAILABLE'
  | 'STRUCTURAL_LEVEL_UNAVAILABLE'
  | 'REGIME_FILTER_BLOCKED'
  | 'RSI_NOT_ABOVE_THRESHOLD'
  | 'AWAITING_PDH_INTERACTION'
  | 'INTERACTION_ARMED_WAITING_FOR_RECLAIM'
  | 'BULLISH_CLOSE_REQUIRED'
  | 'RECLAIM_THRESHOLD_NOT_MET'
  | 'BULLISH_BODY_BELOW_THRESHOLD'
  | 'COOLDOWN'
  | 'DUPLICATE_COMPLETED_FRAME_SUPPRESSED'
  | 'SIGNAL';

export interface V8BullishReclaimEvaluation {
  date: string;
  candleTimestamp: Date;
  timestamp: Date;
  close: number;
  structuralLevel: number | null;
  atr14: number | null;
  reclaimBufferAtr: number;
  bullishBodyAtr: number;
  rsiMinimum: V8RsiMinimum;
  reclaimThreshold: number | null;
  interaction: boolean | null;
  armedBefore: boolean;
  armedAfter: boolean;
  reclaim: boolean | null;
  body: number;
  bodyAtr: number | null;
  rsi14: number | null;
  rsiPass: boolean;
  regime?: AdaptivePrimaryMarketRegime;
  regimePass: boolean;
  cooldownEligible: boolean | null;
  signal: boolean;
  reason: V8BullishReclaimEvaluationReason;
  signalValue?: V8BullishReclaimSignal;
}

export const V8_TARGET_STOP_COMBINATIONS = [
  { targetPercent: 4, stopPercent: 4 },
  { targetPercent: 5, stopPercent: 5 },
  { targetPercent: 6, stopPercent: 5 },
] as const;
export const V8_HOLD_MINUTES = [10, 15, 20] as const;

export function v8ConfigKey(config: V8BullishReclaimConfig): string {
  return [V8_STRATEGY_ID, config.timeframe, config.levelFamily, config.reclaimBufferAtr, config.bullishBodyAtr, config.rsiMinimum, config.regimeMode, config.cooldownMinutes].join('|');
}

export function createV8BullishReclaimConfigs(): V8BullishReclaimConfig[] {
  return ([2, 3] as const).flatMap((timeframe) =>
    (['PDH', 'OR15_HIGH', 'OR30_HIGH', 'RECENT_SWING_HIGH'] as const).flatMap((levelFamily) =>
      ([0, 0.05, 0.1, 0.15] as const).flatMap((reclaimBufferAtr) =>
        ([0.25, 0.5, 0.75, 1] as const).flatMap((bullishBodyAtr) =>
          (['NONE', 50, 55, 60] as const).flatMap((rsiMinimum) =>
            (['ANY_EXCEPT_TREND_DOWN', 'TREND_UP_ONLY', 'NO_REGIME_FILTER'] as const).flatMap((regimeMode) =>
              ([5, 10, 15] as const).map((cooldownMinutes) => ({ timeframe, levelFamily, reclaimBufferAtr, bullishBodyAtr, rsiMinimum, regimeMode, cooldownMinutes })),
            ),
          ),
        ),
      ),
    ),
  );
}

export function generateV8BullishReclaimSignals(
  sessions: readonly V8PreparedSession[],
  config: V8BullishReclaimConfig,
  indicators: V8IndicatorContext,
): V8BullishReclaimSignal[] {
  return evaluateV8BullishReclaimFrames(sessions, config, indicators)
    .flatMap((evaluation) => evaluation.signalValue ? [evaluation.signalValue] : []);
}

/**
 * Evaluates the exact frozen sequence and exposes diagnostic state for every
 * completed frame.  `generateV8BullishReclaimSignals` remains the canonical
 * signal API and is derived directly from this result.
 */
export function evaluateV8BullishReclaimFrames(
  sessions: readonly V8PreparedSession[],
  config: V8BullishReclaimConfig,
  indicators: V8IndicatorContext,
): V8BullishReclaimEvaluation[] {
  const atr = indicators.atr14ByFrame.get(config.timeframe);
  if (!atr) throw new Error(`Missing ATR14 map for V8 ${config.timeframe}m frame.`);
  const ordered = [...sessions].sort((left, right) => left.date.localeCompare(right.date));
  const previousDayHigh = buildPreviousDayHighMap(ordered);
  const evaluations: V8BullishReclaimEvaluation[] = [];

  ordered.forEach((session) => {
    const frame = session.frames[config.timeframe];
    const levels = buildV8StructuralLevels(session, config.timeframe, config.levelFamily, previousDayHigh.get(session.date));
    let armed = false;
    let armedAt: number | undefined;
    let lastSignalAt: number | undefined;

    frame.candles.forEach((candle, index) => {
      const key = candle.timestamp.getTime();
      const completedAt = key + config.timeframe * 60_000;
      const currentAtr = atr.get(key);
      const base = {
        date: session.date,
        candleTimestamp: new Date(candle.timestamp.getTime()),
        timestamp: new Date(completedAt),
        close: candle.close,
        reclaimBufferAtr: config.reclaimBufferAtr,
        bullishBodyAtr: config.bullishBodyAtr,
        rsiMinimum: config.rsiMinimum,
        body: Math.abs(candle.close - candle.open),
      };
      if (currentAtr === undefined || currentAtr <= 0) {
        evaluations.push({ ...base, structuralLevel: null, atr14: null, reclaimThreshold: null, interaction: null, armedBefore: armed, armedAfter: armed, reclaim: null, bodyAtr: null, rsi14: null, rsiPass: false, regimePass: false, cooldownEligible: null, signal: false, reason: 'ATR_UNAVAILABLE' });
        return;
      }
      const level = levels.get(key);
      if (level === undefined || !Number.isFinite(level)) {
        evaluations.push({ ...base, structuralLevel: null, atr14: currentAtr, reclaimThreshold: null, interaction: null, armedBefore: armed, armedAfter: armed, reclaim: null, bodyAtr: base.body / currentAtr, rsi14: null, rsiPass: false, regimePass: false, cooldownEligible: null, signal: false, reason: config.levelFamily === 'PDH' ? 'PDH_UNAVAILABLE' : 'STRUCTURAL_LEVEL_UNAVAILABLE' });
        return;
      }
      const regime = latestRegimeAt(session, completedAt);
      const regimePass = regimeMatches(config.regimeMode, regime?.regime);
      const rsi = readRsi(session, config.timeframe, key);
      const rsiPass = rsiMatches(config.rsiMinimum, rsi);
      const reclaimThreshold = level + currentAtr * config.reclaimBufferAtr;
      const interaction = candle.low <= reclaimThreshold && candle.close <= reclaimThreshold;
      const reclaim = candle.close > candle.open && candle.close >= reclaimThreshold;
      const bodyAtr = base.body / currentAtr;
      const common = { ...base, structuralLevel: level, atr14: currentAtr, reclaimThreshold, interaction, bodyAtr, rsi14: rsi ?? null, rsiPass, regime: regime?.regime, regimePass };
      if (!regimePass) {
        evaluations.push({ ...common, armedBefore: armed, armedAfter: armed, reclaim, cooldownEligible: null, signal: false, reason: 'REGIME_FILTER_BLOCKED' });
        return;
      }
      if (!rsiPass) {
        evaluations.push({ ...common, armedBefore: armed, armedAfter: armed, reclaim, cooldownEligible: null, signal: false, reason: 'RSI_NOT_ABOVE_THRESHOLD' });
        return;
      }
      const bullishConfirmation = reclaim && base.body >= currentAtr * config.bullishBodyAtr;
      const wasArmed = armed;
      if (interaction && !armed) { armed = true; armedAt = key; }
      if (!wasArmed) {
        evaluations.push({ ...common, armedBefore: false, armedAfter: armed, reclaim, cooldownEligible: null, signal: false, reason: interaction ? 'INTERACTION_ARMED_WAITING_FOR_RECLAIM' : (config.levelFamily === 'PDH' ? 'AWAITING_PDH_INTERACTION' : 'STRUCTURAL_LEVEL_UNAVAILABLE') });
        return;
      }
      if (!bullishConfirmation) {
        const reason: V8BullishReclaimEvaluationReason = candle.close <= candle.open
          ? 'BULLISH_CLOSE_REQUIRED'
          : candle.close < reclaimThreshold
            ? 'RECLAIM_THRESHOLD_NOT_MET'
            : 'BULLISH_BODY_BELOW_THRESHOLD';
        evaluations.push({ ...common, armedBefore: true, armedAfter: armed, reclaim, cooldownEligible: null, signal: false, reason });
        return;
      }
      if (!isCooldownEligible(lastSignalAt, completedAt, config.cooldownMinutes)) {
        // A cooldown-blocked reclaim consumes the episode; a later signal needs
        // a fresh interaction/re-arm rather than replaying the same reclaim.
        armed = false;
        evaluations.push({ ...common, armedBefore: true, armedAfter: false, reclaim, cooldownEligible: false, signal: false, reason: 'COOLDOWN' });
        return;
      }

      const signal: V8BullishReclaimSignal = {
        strategyId: V8_STRATEGY_ID,
        configKey: v8ConfigKey(config),
        date: session.date,
        timestamp: new Date(completedAt),
        direction: 'CE',
        levelFamily: config.levelFamily,
        structuralLevel: level,
        spotPrice: candle.close,
        atr14: currentAtr,
        body: Math.abs(candle.close - candle.open),
        bodyAtr: Math.abs(candle.close - candle.open) / currentAtr,
        reclaimBufferAtr: config.reclaimBufferAtr,
        rsi14: rsi ?? null,
        interactionTimestamp: armedAt === undefined ? undefined : new Date(armedAt),
        regime: regime?.regime,
        regimeAvailableAt: regime?.availableAt,
      };
      lastSignalAt = completedAt;
      armed = false;
      armedAt = undefined;
      evaluations.push({ ...common, armedBefore: true, armedAfter: false, reclaim, cooldownEligible: true, signal: true, reason: 'SIGNAL', signalValue: signal });
    });
  });
  return evaluations;
}

export function assertV8NoLookAhead(signals: readonly V8BullishReclaimSignal[]): void {
  signals.forEach((signal) => {
    if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V8 look-ahead detected at ${signal.timestamp.toISOString()}.`);
  });
}

function buildPreviousDayHighMap(sessions: readonly V8PreparedSession[]): Map<string, number> {
  const result = new Map<string, number>();
  let previousHigh: number | undefined;
  sessions.forEach((session) => {
    if (previousHigh !== undefined) result.set(session.date, previousHigh);
    const dayHigh = Math.max(...session.oneMinute.map((candle) => candle.high));
    if (Number.isFinite(dayHigh)) previousHigh = dayHigh;
  });
  return result;
}

export function buildV8StructuralLevels(session: V8PreparedSession, timeframe: V8EntryTimeframe, family: V8LevelFamily, pdh?: number): Map<number, number> {
  const result = new Map<number, number>();
  const candles = session.frames[timeframe].candles;
  if (family === 'PDH') {
    candles.forEach((candle) => { if (pdh !== undefined) result.set(candle.timestamp.getTime(), pdh); });
    return result;
  }
  if (family === 'OR15_HIGH' || family === 'OR30_HIGH') {
    const minutes = family === 'OR15_HIGH' ? 15 : 30;
    const start = session.oneMinute[0]?.timestamp.getTime();
    if (start === undefined || session.oneMinute.length < minutes) return result;
    const rangeEnd = start + minutes * 60_000;
    const high = Math.max(...session.oneMinute.filter((candle) => candle.timestamp.getTime() < rangeEnd).map((candle) => candle.high));
    candles.forEach((candle) => { if (candle.timestamp.getTime() + timeframe * 60_000 > rangeEnd) result.set(candle.timestamp.getTime(), high); });
    return result;
  }
  const all = candles;
  all.forEach((candle, index) => {
    const prior = all.filter((value) => value.timestamp.getTime() < candle.timestamp.getTime()).slice(-V8_RECENT_SWING_LOOKBACK);
    if (prior.length >= V8_RECENT_SWING_LOOKBACK) result.set(candle.timestamp.getTime(), Math.max(...prior.map((value) => value.high)));
  });
  return result;
}

function readRsi(session: V8PreparedSession, timeframe: V8EntryTimeframe, timestamp: number): number | undefined {
  return session.frames[timeframe].rsi14.get(timestamp);
}

function rsiMatches(minimum: V8RsiMinimum, rsi: number | undefined): boolean {
  return minimum === 'NONE' || (rsi !== undefined && rsi > minimum);
}

function regimeMatches(mode: V8RegimeMode, regime: AdaptivePrimaryMarketRegime | undefined): boolean {
  if (mode === 'NO_REGIME_FILTER') return true;
  if (regime === undefined) return false;
  return mode === 'TREND_UP_ONLY' ? regime === AdaptivePrimaryMarketRegime.TREND_UP : regime !== AdaptivePrimaryMarketRegime.TREND_DOWN;
}

function latestRegimeAt(session: V8PreparedSession, timestamp: number) {
  for (let index = session.regimePoints.length - 1; index >= 0; index -= 1) {
    if (session.regimePoints[index].availableAt.getTime() <= timestamp) return session.regimePoints[index];
  }
  return undefined;
}

function isCooldownEligible(lastSignalTimestamp: number | undefined, timestamp: number, cooldownMinutes: number): boolean {
  return lastSignalTimestamp === undefined || timestamp - lastSignalTimestamp >= cooldownMinutes * 60_000;
}
