import { AdaptivePrimaryMarketRegime } from '../../modules/adaptive-intraday/types/adaptive-market-regime.types';
import IndicatorEngineService, { IndicatorEngineResult } from '../../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../modules/indicators/types';
import { CrossSessionPreparedSession, isCooldownEligible } from './cross-session-indicator-warmup';

export type V6Direction = 'CE' | 'PE';
export type V6Confirmation = 'NONE' | 'REVERSAL_CLOSE' | 'PRIOR_HIGH_LOW_RECLAIM' | 'EMA_DIRECTION_RECLAIM';

export interface V6SidewaysConfig {
  timeframe: 2;
  direction: V6Direction;
  ema20DistancePercent: 0.05 | 0.1 | 0.15 | 0.2 | 0.25 | 0.3;
  rsiThreshold: 45 | 40 | 35 | 30 | 55 | 60 | 65 | 70;
  minimumDistanceAtr: 0.25 | 0.5 | 0.75 | 1;
  confirmation: V6Confirmation;
  extremeLookbackBars: 1 | 2 | 3;
  cooldownMinutes: 0 | 2 | 3 | 5 | 10;
}

export interface V6Indicators { ema20: ReadonlyMap<number, number>; rsi14: ReadonlyMap<number, number>; atr14: ReadonlyMap<number, number>; }
export interface V6Signal {
  configKey: string; date: string; timestamp: Date; spotPrice: number; direction: V6Direction;
  regimeAvailableAt: Date; entryCandleStartedAt: Date; extremeCandleStartedAt: Date;
  ema20: number; distancePercent: number; atr14: number; distanceAtr: number; rsi14: number; confirmation: V6Confirmation;
}

export function createV6SidewaysConfigs(): V6SidewaysConfig[] {
  const distances = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3] as const;
  const atr = [0.25, 0.5, 0.75, 1] as const;
  const confirmations = ['NONE', 'REVERSAL_CLOSE', 'PRIOR_HIGH_LOW_RECLAIM', 'EMA_DIRECTION_RECLAIM'] as const;
  const lookback = [1, 2, 3] as const;
  const cooldown = [0, 2, 3, 5, 10] as const;
  const create = (direction: V6Direction, rsi: readonly V6SidewaysConfig['rsiThreshold'][]) => distances.flatMap((ema20DistancePercent) => rsi.flatMap((rsiThreshold) => atr.flatMap((minimumDistanceAtr) => confirmations.flatMap((confirmation) => lookback.flatMap((extremeLookbackBars) => cooldown.map((cooldownMinutes) => ({ timeframe: 2 as const, direction, ema20DistancePercent, rsiThreshold, minimumDistanceAtr, confirmation, extremeLookbackBars, cooldownMinutes })))))));
  return [...create('CE', [45, 40, 35, 30]), ...create('PE', [55, 60, 65, 70])];
}

export function v6ConfigKey(config: V6SidewaysConfig): string { return ['V6_SIDEWAYS_MEAN_REVERSION', '2m', config.direction, config.ema20DistancePercent, config.rsiThreshold, config.minimumDistanceAtr, config.confirmation, config.extremeLookbackBars, config.cooldownMinutes].join('|'); }

export function prepareV6IndicatorContext(sessions: readonly CrossSessionPreparedSession[], engine: IndicatorEngineService): ReadonlyMap<string, V6Indicators> {
  return new Map(sessions.map((session) => [session.date, calculate(engine, session.frames[2].allCandles)]));
}

/**
 * An episode begins when an extreme exists in the configured trailing window
 * and re-arms only after that window contains no qualifying extreme. At most
 * one signal is emitted per episode; cooldown is then applied to the emitted
 * entry timestamps. This makes repeated qualifying candles deterministic.
 */
export function generateV6Signals(sessions: readonly CrossSessionPreparedSession[], config: V6SidewaysConfig, indicators: ReadonlyMap<string, V6Indicators>): V6Signal[] {
  const result: V6Signal[] = [];
  sessions.forEach((session) => {
    const frame = session.frames[2]; const values = indicators.get(session.date); if (!values) throw new Error(`Missing V6 indicators for ${session.date}.`);
    let lastSignalAt: number | undefined; let episodeActive = false;
    frame.candles.forEach((entry, index) => {
      const timestamp = entry.timestamp.getTime() + 2 * 60_000;
      const regime = latestRegime(session, timestamp);
      if (regime?.regime !== AdaptivePrimaryMarketRegime.SIDEWAYS || index + 1 < config.extremeLookbackBars) { episodeActive = false; return; }
      const candidates = frame.candles.slice(index - config.extremeLookbackBars + 1, index + 1)
        .flatMap((candle) => extreme(candle, config, values) === undefined ? [] : [{ candle, data: extreme(candle, config, values)! }]);
      const extremeValue = candidates.at(-1);
      if (!extremeValue) { episodeActive = false; return; }
      if (episodeActive) return;
      const prior = frame.candles.slice(Math.max(0, index - config.extremeLookbackBars), index);
      if (!confirmationMatches(entry, prior, extremeValue.candle, extremeValue.data.ema20, config)) return;
      if (!isCooldownEligible(lastSignalAt, timestamp, config.cooldownMinutes)) return;
      result.push({ configKey: v6ConfigKey(config), date: session.date, timestamp: new Date(timestamp), spotPrice: entry.close, direction: config.direction, regimeAvailableAt: new Date(regime.availableAt.getTime()), entryCandleStartedAt: new Date(entry.timestamp.getTime()), extremeCandleStartedAt: new Date(extremeValue.candle.timestamp.getTime()), ema20: extremeValue.data.ema20, distancePercent: extremeValue.data.distancePercent, atr14: extremeValue.data.atr14, distanceAtr: extremeValue.data.distanceAtr, rsi14: extremeValue.data.rsi14, confirmation: config.confirmation });
      lastSignalAt = timestamp; episodeActive = true;
    });
  });
  return result;
}

export function assertV6NoLookAhead(signals: readonly V6Signal[]): void {
  signals.forEach((signal) => {
    if (signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V6 regime look-ahead at ${signal.timestamp.toISOString()}.`);
    if (signal.entryCandleStartedAt.getTime() + 2 * 60_000 !== signal.timestamp.getTime()) throw new Error(`V6 entry must use a completed 2m candle at ${signal.timestamp.toISOString()}.`);
    if (signal.extremeCandleStartedAt.getTime() > signal.entryCandleStartedAt.getTime()) throw new Error(`V6 extreme look-ahead at ${signal.timestamp.toISOString()}.`);
  });
}

export function deduplicateV6Signals(signals: readonly V6Signal[]): V6Signal[] {
  const result = new Map<string, V6Signal>();
  signals.forEach((signal) => { const key = `${signal.direction}\u0000${signal.timestamp.getTime()}`; const existing = result.get(key); if (existing && Math.abs(existing.spotPrice - signal.spotPrice) > 1e-9) throw new Error(`Conflicting V6 price at ${signal.timestamp.toISOString()}.`); result.set(key, existing ?? signal); });
  return [...result.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.direction.localeCompare(b.direction));
}

function extreme(candle: Candle, config: V6SidewaysConfig, values: V6Indicators) {
  const key = candle.timestamp.getTime(); const ema20 = values.ema20.get(key); const rsi14 = values.rsi14.get(key); const atr14 = values.atr14.get(key);
  if (ema20 === undefined || rsi14 === undefined || atr14 === undefined || atr14 <= 0) return undefined;
  const distance = config.direction === 'CE' ? ema20 - candle.close : candle.close - ema20;
  const distancePercent = distance / ema20 * 100; const distanceAtr = distance / atr14;
  const rsiPass = config.direction === 'CE' ? rsi14 < config.rsiThreshold : rsi14 > config.rsiThreshold;
  return distancePercent >= config.ema20DistancePercent && distanceAtr >= config.minimumDistanceAtr && rsiPass ? { ema20, rsi14, atr14, distancePercent, distanceAtr } : undefined;
}
function confirmationMatches(entry: Candle, prior: readonly Candle[], extremeCandle: Candle, ema20: number, config: V6SidewaysConfig): boolean {
  if (config.confirmation === 'NONE') return entry.timestamp.getTime() === extremeCandle.timestamp.getTime();
  if (config.confirmation === 'REVERSAL_CLOSE') return config.direction === 'CE' ? entry.close > entry.open : entry.close < entry.open;
  if (config.confirmation === 'PRIOR_HIGH_LOW_RECLAIM') { const previous = prior.at(-1); return previous !== undefined && (config.direction === 'CE' ? entry.close > previous.high : entry.close < previous.low); }
  const startDistance = Math.abs(entry.open - ema20); const endDistance = Math.abs(entry.close - ema20);
  return config.direction === 'CE' ? entry.open < ema20 && entry.close > entry.open && endDistance < startDistance : entry.open > ema20 && entry.close < entry.open && endDistance < startDistance;
}
function latestRegime(session: CrossSessionPreparedSession, time: number) { for (let i = session.regimePoints.length - 1; i >= 0; i -= 1) if (session.regimePoints[i].availableAt.getTime() <= time) return session.regimePoints[i]; return undefined; }
function calculate(engine: IndicatorEngineService, candles: readonly Candle[]): V6Indicators { const result = engine.calculate(candles, { indicators: [{ type: IndicatorType.EMA, period: 20 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ATR, period: 14 }] }); return { ema20: scalar(result, IndicatorType.EMA, 20), rsi14: scalar(result, IndicatorType.RSI, 14), atr14: scalar(result, IndicatorType.ATR, 14) }; }
function scalar(result: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const found = result.indicators.find((item) => item.config.type === type && 'period' in item.config && item.config.period === period); if (!found) throw new Error(`Missing V6 ${type}${period}.`); return new Map(found.result.values.flatMap((item) => 'value' in item && typeof item.value === 'number' ? [[item.timestamp.getTime(), item.value] as [number, number]] : [])); }
