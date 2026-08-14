import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
import { Candle, IndicatorType } from '../../indicators/types';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { CrossSessionEntryTimeframe, CrossSessionPreparedSession, CrossSessionRegimePoint, isCooldownEligible } from '../../../tests/helpers/cross-session-indicator-warmup';

export const BN_V1_STRATEGY_ID = 'BN_V1_OPENING_RANGE_RETEST';
export type OpeningRange = 'OR15' | 'OR30';
export type RegimeMode = 'NO_REGIME_FILTER' | 'DIRECTION_ALIGNED_ONLY' | 'ANY_EXCEPT_OPPOSITE';
export type BreakoutBufferAtr = 0 | 0.05 | 0.1 | 0.15;
export type RetestToleranceAtr = 0.05 | 0.1 | 0.2 | 0.3;
export type ConfirmationBodyAtr = 0.25 | 0.5 | 0.75;
export type RetestExpiryBars = 3 | 5 | 8;
export type CooldownMinutes = 5 | 10 | 15;

export interface BankNiftyOpeningRangeConfig {
  openingRange: OpeningRange;
  timeframe: CrossSessionEntryTimeframe & (1 | 2 | 3);
  breakoutBufferAtr: BreakoutBufferAtr;
  retestToleranceAtr: RetestToleranceAtr;
  confirmationBodyAtr: ConfirmationBodyAtr;
  regimeMode: RegimeMode;
  retestExpiryBars: RetestExpiryBars;
  cooldownMinutes: CooldownMinutes;
}

export interface BankNiftyOpeningRangeSignal {
  strategyId: typeof BN_V1_STRATEGY_ID;
  configKey: string;
  date: string;
  timestamp: Date;
  direction: 'CE' | 'PE';
  openingRange: OpeningRange;
  level: number;
  spotPrice: number;
  atr14: number;
  bodyAtr: number;
  breakoutTimestamp: Date;
  regime?: AdaptivePrimaryMarketRegime;
  regimeAvailableAt?: Date;
}

export const BN_V1_TARGET_STOP_COMBINATIONS = [{ targetPercent: 4, stopPercent: 4 }, { targetPercent: 5, stopPercent: 5 }, { targetPercent: 6, stopPercent: 5 }] as const;
export const BN_V1_HOLD_MINUTES = [10, 15, 20] as const;

export function configKey(config: BankNiftyOpeningRangeConfig): string { return [BN_V1_STRATEGY_ID, config.openingRange, config.timeframe, config.breakoutBufferAtr, config.retestToleranceAtr, config.confirmationBodyAtr, config.regimeMode, config.retestExpiryBars, config.cooldownMinutes].join('|'); }

export function createConfigs(): BankNiftyOpeningRangeConfig[] {
  const result: BankNiftyOpeningRangeConfig[] = [];
  for (const openingRange of ['OR15', 'OR30'] as const) for (const timeframe of [1, 2, 3] as const) for (const breakoutBufferAtr of [0, 0.05, 0.1, 0.15] as const) for (const retestToleranceAtr of [0.05, 0.1, 0.2, 0.3] as const) for (const confirmationBodyAtr of [0.25, 0.5, 0.75] as const) for (const regimeMode of ['NO_REGIME_FILTER', 'DIRECTION_ALIGNED_ONLY', 'ANY_EXCEPT_OPPOSITE'] as const) for (const retestExpiryBars of [3, 5, 8] as const) for (const cooldownMinutes of [5, 10, 15] as const) result.push({ openingRange, timeframe, breakoutBufferAtr, retestToleranceAtr, confirmationBodyAtr, regimeMode, retestExpiryBars, cooldownMinutes });
  return result;
}

export interface AtrContext { atr14ByFrame: ReadonlyMap<number, ReadonlyMap<number, number>>; regimeBySessionFrame: ReadonlyMap<string, ReadonlyMap<number, CrossSessionRegimePoint | undefined>>; }

export function createAtrContext(sessions: readonly CrossSessionPreparedSession[], engine = new IndicatorEngineService()): AtrContext {
  const maps = ([1, 2, 3] as const).map((timeframe) => {
    const values = new Map<number, number>();
    sessions.forEach((session) => {
      const calculated = engine.calculate(session.frames[timeframe].allCandles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] });
      const indicator = calculated.indicators.find((entry) => entry.config.type === IndicatorType.ATR);
      indicator?.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); });
    });
    return [timeframe, values] as const;
  });
  const regimeBySessionFrame = new Map<string, ReadonlyMap<number, CrossSessionRegimePoint | undefined>>();
  sessions.forEach((session) => ([1, 2, 3] as const).forEach((timeframe) => {
    const points = [...session.regimePoints].sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime());
    let pointIndex = 0;
    const values = new Map<number, CrossSessionRegimePoint | undefined>();
    session.frames[timeframe].candles.forEach((candle) => {
      const completedAt = candle.timestamp.getTime() + timeframe * 60_000;
      while (pointIndex + 1 < points.length && points[pointIndex + 1].availableAt.getTime() <= completedAt) pointIndex += 1;
      values.set(candle.timestamp.getTime(), points[pointIndex]?.availableAt.getTime() <= completedAt ? points[pointIndex] : undefined);
    });
    regimeBySessionFrame.set(`${session.date}|${timeframe}`, values);
  }));
  return { atr14ByFrame: new Map(maps), regimeBySessionFrame };
}

export function generateSignals(sessions: readonly CrossSessionPreparedSession[], config: BankNiftyOpeningRangeConfig, context: AtrContext): BankNiftyOpeningRangeSignal[] {
  const atrMap = context.atr14ByFrame.get(config.timeframe);
  if (!atrMap) throw new Error(`Missing ATR14 map for ${config.timeframe}m.`);
  const result: BankNiftyOpeningRangeSignal[] = [];
  sessions.forEach((session) => {
    const start = session.oneMinute[0]?.timestamp.getTime();
    if (start === undefined) return;
    const rangeMinutes = config.openingRange === 'OR15' ? 15 : 30;
    const rangeEnd = start + rangeMinutes * 60_000;
    const opening = session.oneMinute.filter((candle) => candle.timestamp.getTime() < rangeEnd);
    if (opening.length !== rangeMinutes) return;
    const high = Math.max(...opening.map((candle) => candle.high));
    const low = Math.min(...opening.map((candle) => candle.low));
    const frame = session.frames[config.timeframe].candles;
    let upBreakout: { index: number; timestamp: Date } | undefined;
    let downBreakout: { index: number; timestamp: Date } | undefined;
    let upBlocked = false;
    let downBlocked = false;
    let lastCe: number | undefined;
    let lastPe: number | undefined;
    frame.forEach((candle, index) => {
      const candleStart = candle.timestamp.getTime();
      const completedAt = candleStart + config.timeframe * 60_000;
      if (completedAt <= rangeEnd) return;
      const atr = atrMap.get(candleStart);
      if (atr === undefined || atr <= 0) return;
      const regime = context.regimeBySessionFrame.get(`${session.date}|${config.timeframe}`)?.get(candleStart);
      const bullishRegime = regimeMatches(config.regimeMode, regime?.regime, 'CE');
      const bearishRegime = regimeMatches(config.regimeMode, regime?.regime, 'PE');
      const bodyAtr = Math.abs(candle.close - candle.open) / atr;
      const upBreak = candle.close >= high + atr * config.breakoutBufferAtr;
      const downBreak = candle.close <= low - atr * config.breakoutBufferAtr;
      if (!upBlocked && upBreak && !upBreakout) { upBreakout = { index, timestamp: new Date(completedAt) }; }
      if (!downBlocked && downBreak && !downBreakout) { downBreakout = { index, timestamp: new Date(completedAt) }; }
      if (upBreakout && index - upBreakout.index > config.retestExpiryBars) upBreakout = undefined;
      if (downBreakout && index - downBreakout.index > config.retestExpiryBars) downBreakout = undefined;
      const upRetest = upBreakout && index > upBreakout.index && candle.low <= high + atr * config.retestToleranceAtr && candle.close > high && candle.close > candle.open && bodyAtr >= config.confirmationBodyAtr;
      const downRetest = downBreakout && index > downBreakout.index && candle.high >= low - atr * config.retestToleranceAtr && candle.close < low && candle.close < candle.open && bodyAtr >= config.confirmationBodyAtr;
      if (upRetest && bullishRegime && isCooldownEligible(lastCe, completedAt, config.cooldownMinutes)) {
        const breakout = upBreakout!;
        result.push({ strategyId: BN_V1_STRATEGY_ID, configKey: configKey(config), date: session.date, timestamp: new Date(completedAt), direction: 'CE', openingRange: config.openingRange, level: high, spotPrice: candle.close, atr14: atr, bodyAtr, breakoutTimestamp: breakout.timestamp, regime: regime?.regime, regimeAvailableAt: regime?.availableAt });
        lastCe = completedAt; upBreakout = undefined; upBlocked = true;
      }
      if (downRetest && bearishRegime && isCooldownEligible(lastPe, completedAt, config.cooldownMinutes)) {
        const breakout = downBreakout!;
        result.push({ strategyId: BN_V1_STRATEGY_ID, configKey: configKey(config), date: session.date, timestamp: new Date(completedAt), direction: 'PE', openingRange: config.openingRange, level: low, spotPrice: candle.close, atr14: atr, bodyAtr, breakoutTimestamp: breakout.timestamp, regime: regime?.regime, regimeAvailableAt: regime?.availableAt });
        lastPe = completedAt; downBreakout = undefined; downBlocked = true;
      }
      if (upBlocked && candle.close < high) upBlocked = false;
      if (downBlocked && candle.close > low) downBlocked = false;
    });
  });
  return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export function assertNoLookAhead(signals: readonly BankNiftyOpeningRangeSignal[]): void {
  signals.forEach((signal) => { if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`Regime look-ahead at ${signal.timestamp.toISOString()}`); if (signal.breakoutTimestamp.getTime() >= signal.timestamp.getTime()) throw new Error(`Retest precedes breakout at ${signal.timestamp.toISOString()}`); const minute = marketMinute(signal.timestamp); if (signal.openingRange === 'OR15' && minute < 570) throw new Error(`OR15 signal before 09:30 at ${signal.timestamp.toISOString()}`); if (signal.openingRange === 'OR30' && minute < 585) throw new Error(`OR30 signal before 09:45 at ${signal.timestamp.toISOString()}`); });
}

function regimeMatches(mode: RegimeMode, regime: AdaptivePrimaryMarketRegime | undefined, direction: 'CE' | 'PE'): boolean { if (mode === 'NO_REGIME_FILTER') return true; if (regime === undefined) return false; const aligned = direction === 'CE' ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN; const opposite = direction === 'CE' ? AdaptivePrimaryMarketRegime.TREND_DOWN : AdaptivePrimaryMarketRegime.TREND_UP; return mode === 'DIRECTION_ALIGNED_ONLY' ? regime === aligned : regime !== opposite; }
function marketMinute(timestamp: Date): number { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return Number(p.hour) * 60 + Number(p.minute); }
