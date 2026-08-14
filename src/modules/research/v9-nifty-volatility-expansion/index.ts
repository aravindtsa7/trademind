import { Candle } from '../../indicators/types';
import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';

export const V9_STRATEGY_ID = 'V9_NIFTY_VOLATILITY_EXPANSION_CONFIRMATION';
export type V9Timeframe = 2 | 3;
export type V9CompressionLookback = 10 | 20;
export type V9CompressionThreshold = 0.8 | 0.9;
export type V9BodyThreshold = 0.75 | 1 | 1.25;
export type V9RangeThreshold = 1 | 1.25;
export type V9BreakoutLookback = 3 | 5;
export type V9RegimeMode = 'NO_REGIME_FILTER' | 'ANY_EXCEPT_OPPOSITE';
export type V9OptionConfirmation = 'RETURN_0.75' | 'RETURN_1.25' | 'BREAKOUT_3';
export type V9Cooldown = 5 | 10;

/** The six body/range combinations are reduced to five to keep the phase-1 grid below 1,000. */
export const V9_BODY_RANGE_PAIRS = [
  [0.75, 1], [1, 1], [1, 1.25], [1.25, 1], [1.25, 1.25],
] as const;

export interface V9Config {
  timeframe: V9Timeframe;
  compressionLookback: V9CompressionLookback;
  compressionThreshold: V9CompressionThreshold;
  expansionBodyThreshold: V9BodyThreshold;
  expansionRangeThreshold: V9RangeThreshold;
  breakoutLookback: V9BreakoutLookback;
  regimeMode: V9RegimeMode;
  optionConfirmation: V9OptionConfirmation;
  cooldownMinutes: V9Cooldown;
}

export interface V9RegimePoint { availableAt: Date; regime: AdaptivePrimaryMarketRegime | undefined; }
export interface V9OptionCandle { timestamp: Date; open: number; high: number; low: number; close: number; instrumentKey: string; }
export interface V9PreparedSession { date: string; frames: Record<V9Timeframe, Candle[]>; regimePoints: V9RegimePoint[]; }
export interface V9IndicatorContext { atrByFrame: ReadonlyMap<V9Timeframe, ReadonlyMap<number, number>>; }
export interface V9OptionResolver { resolve(direction: 'CE' | 'PE', date: string, completedAt: Date): { instrumentKey: string; expiry?: string; strike?: number; } | undefined; candles(instrumentKey: string, date: string): readonly V9OptionCandle[]; }
export interface V9Signal {
  strategyId: typeof V9_STRATEGY_ID; configKey: string; date: string; timestamp: Date; direction: 'CE' | 'PE';
  underlyingTimeframe: V9Timeframe; underlyingClose: number; underlyingBody: number; underlyingRange: number; atr: number;
  compressionRatio: number; breakoutLookback: V9BreakoutLookback; regime?: AdaptivePrimaryMarketRegime; regimeAvailableAt?: Date;
  optionInstrumentKey: string; optionConfirmation: V9OptionConfirmation; optionClose: number; optionReturnPercent: number; optionConfirmationAvailableAt: Date;
  optionBreakoutLevel?: number; cooldownMinutes: V9Cooldown;
}

export function v9ConfigKey(config: V9Config): string { return [V9_STRATEGY_ID, config.timeframe, config.compressionLookback, config.compressionThreshold, config.expansionBodyThreshold, config.expansionRangeThreshold, config.breakoutLookback, config.regimeMode, config.optionConfirmation, config.cooldownMinutes].join('|'); }

export function createV9Configs(): V9Config[] {
  return ([2, 3] as const).flatMap((timeframe) => ([10, 20] as const).flatMap((compressionLookback) => ([0.8, 0.9] as const).flatMap((compressionThreshold) => V9_BODY_RANGE_PAIRS.flatMap(([expansionBodyThreshold, expansionRangeThreshold]) => ([3, 5] as const).flatMap((breakoutLookback) => (['NO_REGIME_FILTER', 'ANY_EXCEPT_OPPOSITE'] as const).flatMap((regimeMode) => (['RETURN_0.75', 'RETURN_1.25', 'BREAKOUT_3'] as const).flatMap((optionConfirmation) => ([5, 10] as const).map((cooldownMinutes) => ({ timeframe, compressionLookback, compressionThreshold, expansionBodyThreshold, expansionRangeThreshold, breakoutLookback, regimeMode, optionConfirmation, cooldownMinutes })))))))));
}

export function generateV9Signals(sessions: readonly V9PreparedSession[], config: V9Config, indicators: V9IndicatorContext, options: V9OptionResolver): V9Signal[] {
  const atr = indicators.atrByFrame.get(config.timeframe); if (!atr) throw new Error(`Missing V9 ATR map for ${config.timeframe}m.`);
  const output: V9Signal[] = [];
  [...sessions].sort((a, b) => a.date.localeCompare(b.date)).forEach((session) => {
    const candles = session.frames[config.timeframe]; let lastSignalAt: number | undefined; let episodeArmed = true;
    candles.forEach((candle, index) => {
      const key = candle.timestamp.getTime(); const completedAt = key + config.timeframe * 60_000; const currentAtr = atr.get(key);
      if (!currentAtr || currentAtr <= 0 || index < Math.max(config.compressionLookback + 3, 16)) return;
      const prior = candles.slice(0, index); const short = averageTrueRange(prior.slice(-3)); const medium = averageTrueRange(prior.slice(-config.compressionLookback));
      if (!short || !medium || short / medium > config.compressionThreshold) return;
      const range = candle.high - candle.low; const body = Math.abs(candle.close - candle.open); if (body < currentAtr * config.expansionBodyThreshold || range < currentAtr * config.expansionRangeThreshold) return;
      const high = Math.max(...prior.slice(-config.breakoutLookback).map((value) => value.high)); const low = Math.min(...prior.slice(-config.breakoutLookback).map((value) => value.low));
      const direction: 'CE' | 'PE' | undefined = candle.close > high ? 'CE' : candle.close < low ? 'PE' : undefined; if (!direction) { episodeArmed = true; return; }
      if (!episodeArmed || (lastSignalAt !== undefined && completedAt - lastSignalAt < config.cooldownMinutes * 60_000)) return;
      const regimePoint = latestRegimeAt(session, completedAt); if (!regimeMatches(config.regimeMode, direction, regimePoint?.regime)) return;
      const contract = options.resolve(direction, session.date, new Date(completedAt)); if (!contract) return;
      const optionRows = options.candles(contract.instrumentKey, session.date); const option = latestCompletedOption(optionRows, completedAt); if (!option) return;
      const optionPrior = optionRows.filter((row) => row.timestamp.getTime() < option.timestamp.getTime()); const optionReturn = optionPrior.at(-1)?.close ? (option.close / optionPrior.at(-1)!.close - 1) * 100 : 0;
      const optionBreakout = optionPrior.length >= 3 ? Math.max(...optionPrior.slice(-3).map((row) => row.high)) : undefined;
      const confirmed = config.optionConfirmation === 'RETURN_0.75' ? optionReturn >= 0.75 : config.optionConfirmation === 'RETURN_1.25' ? optionReturn >= 1.25 : optionBreakout !== undefined && option.close > optionBreakout;
      if (!confirmed) return;
      output.push({ strategyId: V9_STRATEGY_ID, configKey: v9ConfigKey(config), date: session.date, timestamp: new Date(completedAt), direction, underlyingTimeframe: config.timeframe, underlyingClose: candle.close, underlyingBody: body, underlyingRange: range, atr: currentAtr, compressionRatio: short / medium, breakoutLookback: config.breakoutLookback, regime: regimePoint?.regime, regimeAvailableAt: regimePoint?.availableAt, optionInstrumentKey: contract.instrumentKey, optionConfirmation: config.optionConfirmation, optionClose: option.close, optionReturnPercent: optionReturn, optionBreakoutLevel: optionBreakout, optionConfirmationAvailableAt: new Date(((option as any).timestamp ?? (option as any).candleTime).getTime() + 60_000), cooldownMinutes: config.cooldownMinutes });
      lastSignalAt = completedAt; episodeArmed = false;
    });
  });
  return output;
}

export function assertV9NoLookAhead(signals: readonly V9Signal[]): void { signals.forEach((signal) => { if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V9 regime lookahead at ${signal.timestamp.toISOString()}.`); if (signal.optionConfirmationAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V9 option confirmation lookahead at ${signal.timestamp.toISOString()}.`); }); }

function latestCompletedOption(rows: readonly V9OptionCandle[], completedAt: number) { return [...rows].filter((row: any) => (row.timestamp ?? row.candleTime).getTime() + 60_000 <= completedAt).sort((a: any, b: any) => (a.timestamp ?? a.candleTime).getTime() - (b.timestamp ?? b.candleTime).getTime()).at(-1); }
function averageTrueRange(candles: readonly Candle[]): number { if (!candles.length) return 0; return candles.reduce((sum, candle) => sum + candle.high - candle.low, 0) / candles.length; }
function latestRegimeAt(session: V9PreparedSession, timestamp: number) { for (let i = session.regimePoints.length - 1; i >= 0; i -= 1) if (session.regimePoints[i].availableAt.getTime() <= timestamp) return session.regimePoints[i]; return undefined; }
function regimeMatches(mode: V9RegimeMode, direction: 'CE' | 'PE', regime: AdaptivePrimaryMarketRegime | undefined): boolean { if (mode === 'NO_REGIME_FILTER') return true; if (!regime) return false; return direction === 'CE' ? regime !== AdaptivePrimaryMarketRegime.TREND_DOWN : regime !== AdaptivePrimaryMarketRegime.TREND_UP; }
