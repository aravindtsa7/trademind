import { AdaptivePrimaryMarketRegime } from '../../modules/adaptive-intraday/types/adaptive-market-regime.types';
import IndicatorEngineService, { IndicatorEngineResult } from '../../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../modules/indicators/types';
import { CrossSessionPreparedSession, isCooldownEligible } from './cross-session-indicator-warmup';

export type V5Direction = 'CE' | 'PE';
export type V5Confirmation = 'TREND_CLOSE' | 'PRIOR_BREAK' | 'EMA_RECLAIM';

export interface V5ScalpingConfig {
  timeframe: 2;
  direction: V5Direction;
  ema20ProximityPercent: 0.05 | 0.1 | 0.15 | 0.2;
  rsiThreshold: 50 | 55 | 60 | 45 | 40;
  bodyAtrMinimum: 0.25 | 0.5 | 0.75;
  pullbackLookbackBars: 1 | 2 | 3;
  confirmation: V5Confirmation;
  cooldownMinutes: 0 | 2 | 3 | 5;
}

export interface V5Signal {
  configKey: string;
  date: string;
  timestamp: Date;
  spotPrice: number;
  direction: V5Direction;
  regimeAvailableAt: Date;
  entryCandleStartedAt: Date;
}

export interface V5Indicators { ema20: Map<number, number>; rsi14: Map<number, number>; atr14: Map<number, number>; }

/**
 * Indicator values are invariant across the V5 parameter grid.  Preparing
 * them once keeps Phase 1 signal diagnostics from recalculating EMA/RSI/ATR
 * for every configuration, without changing any candle or signal semantics.
 */
export function prepareV5IndicatorContext(
  sessions: readonly CrossSessionPreparedSession[],
  engine: IndicatorEngineService,
): ReadonlyMap<string, V5Indicators> {
  return new Map(sessions.map((session) => [session.date, v5Indicators(engine, session.frames[2].allCandles)]));
}

export function createV5ScalpingConfigs(): V5ScalpingConfig[] {
  const proximity = [0.05, 0.1, 0.15, 0.2] as const;
  const body = [0.25, 0.5, 0.75] as const;
  const lookback = [1, 2, 3] as const;
  const confirmation = ['TREND_CLOSE', 'PRIOR_BREAK', 'EMA_RECLAIM'] as const;
  const cooldown = [0, 2, 3, 5] as const;
  const byDirection = (direction: V5Direction, rsi: readonly (50 | 55 | 60 | 45 | 40)[]) => proximity.flatMap((ema20ProximityPercent) => rsi.flatMap((rsiThreshold) => body.flatMap((bodyAtrMinimum) => lookback.flatMap((pullbackLookbackBars) => confirmation.flatMap((model) => cooldown.map((cooldownMinutes) => ({ timeframe: 2 as const, direction, ema20ProximityPercent, rsiThreshold, bodyAtrMinimum, pullbackLookbackBars, confirmation: model, cooldownMinutes })))))));
  return [...byDirection('CE', [50, 55, 60]), ...byDirection('PE', [50, 45, 40])];
}

export function v5ConfigKey(config: V5ScalpingConfig): string {
  return ['V5_SCALPING', `${config.timeframe}m`, config.direction, config.ema20ProximityPercent, config.rsiThreshold, config.bodyAtrMinimum, config.pullbackLookbackBars, config.confirmation, config.cooldownMinutes].join('|');
}

export function generateV5Signals(
  sessions: readonly CrossSessionPreparedSession[],
  config: V5ScalpingConfig,
  indicatorsByDate: ReadonlyMap<string, V5Indicators>,
): V5Signal[] {
  const result: V5Signal[] = [];
  for (const session of sessions) {
    const frame = session.frames[2];
    const values = indicatorsByDate.get(session.date);
    if (!values) throw new Error(`Missing prepared V5 indicators for ${session.date}.`);
    let lastSignalAt: number | undefined;
    frame.candles.forEach((candle, index) => {
      if (index < config.pullbackLookbackBars) return;
      const timestamp = candle.timestamp.getTime() + 2 * 60_000;
      const ema20 = values.ema20.get(candle.timestamp.getTime()); const rsi14 = values.rsi14.get(candle.timestamp.getTime()); const atr14 = values.atr14.get(candle.timestamp.getTime());
      const regime = latestRegime(session, timestamp);
      if (ema20 === undefined || rsi14 === undefined || atr14 === undefined || atr14 <= 0 || !regime) return;
      const bullish = config.direction === 'CE';
      if (regime.regime !== (bullish ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN)) return;
      if (bullish ? rsi14 <= config.rsiThreshold : rsi14 >= config.rsiThreshold) return;
      const prior = frame.candles.slice(index - config.pullbackLookbackBars, index);
      const body = Math.abs(candle.close - candle.open);
      const proximity = config.ema20ProximityPercent / 100;
      const pullback = bullish
        ? prior.some((value) => value.low <= ema20 * (1 + proximity)) && prior.every((value) => value.close >= ema20 * (1 - proximity))
        : prior.some((value) => value.high >= ema20 * (1 - proximity)) && prior.every((value) => value.close <= ema20 * (1 + proximity));
      if (!pullback || body < atr14 * config.bodyAtrMinimum || !matchesConfirmation(candle, prior, ema20, bullish, config.confirmation)) return;
      if (!isCooldownEligible(lastSignalAt, timestamp, config.cooldownMinutes)) return;
      result.push({ configKey: v5ConfigKey(config), date: session.date, timestamp: new Date(timestamp), spotPrice: candle.close, direction: config.direction, regimeAvailableAt: new Date(regime.availableAt.getTime()), entryCandleStartedAt: new Date(candle.timestamp.getTime()) });
      lastSignalAt = timestamp;
    });
  }
  return result;
}

export function assertV5NoLookAhead(signals: readonly V5Signal[]): void {
  signals.forEach((signal) => {
    if (signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V5 regime look-ahead at ${signal.timestamp.toISOString()}.`);
    if (signal.entryCandleStartedAt.getTime() + 2 * 60_000 !== signal.timestamp.getTime()) throw new Error(`V5 signal does not use a completed two-minute candle at ${signal.timestamp.toISOString()}.`);
  });
}

export function deduplicateV5Signals(signals: readonly V5Signal[]): V5Signal[] {
  const values = new Map<string, V5Signal>();
  signals.forEach((signal) => {
    const key = `${signal.direction}\u0000${signal.timestamp.getTime()}`; const existing = values.get(key);
    if (existing && Math.abs(existing.spotPrice - signal.spotPrice) > 1e-9) throw new Error(`V5 conflicting spot prices at ${signal.timestamp.toISOString()}.`);
    values.set(key, existing ?? signal);
  });
  return [...values.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.direction.localeCompare(right.direction));
}

function matchesConfirmation(candle: Candle, prior: readonly Candle[], ema20: number, bullish: boolean, confirmation: V5Confirmation): boolean {
  if (confirmation === 'TREND_CLOSE') return bullish ? candle.close > candle.open && candle.close >= ema20 : candle.close < candle.open && candle.close <= ema20;
  if (confirmation === 'PRIOR_BREAK') return bullish ? candle.close > Math.max(...prior.map((value) => value.high)) : candle.close < Math.min(...prior.map((value) => value.low));
  const previous = prior.at(-1)!;
  return bullish ? previous.close <= ema20 && candle.close > ema20 : previous.close >= ema20 && candle.close < ema20;
}
function latestRegime(session: CrossSessionPreparedSession, timestamp: number) { for (let index = session.regimePoints.length - 1; index >= 0; index -= 1) { const point = session.regimePoints[index]; if (point.availableAt.getTime() <= timestamp) return point; } return undefined; }
function v5Indicators(engine: IndicatorEngineService, candles: readonly Candle[]): V5Indicators { const result = engine.calculate(candles, { indicators: [{ type: IndicatorType.EMA, period: 20 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ATR, period: 14 }] }); return { ema20: scalar(result, IndicatorType.EMA, 20), rsi14: scalar(result, IndicatorType.RSI, 14), atr14: scalar(result, IndicatorType.ATR, 14) }; }
function scalar(result: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const indicator = result.indicators.find((value) => value.config.type === type && 'period' in value.config && value.config.period === period); if (!indicator || !('values' in indicator.result)) throw new Error(`Missing V5 ${type}${period}.`); return new Map(indicator.result.values.flatMap((value) => 'value' in value && typeof value.value === 'number' ? [[value.timestamp.getTime(), value.value] as [number, number]] : [])); }
