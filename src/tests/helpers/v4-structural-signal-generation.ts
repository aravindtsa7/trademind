import { Candle } from '../../modules/indicators/types';
import { AdaptivePrimaryMarketRegime } from '../../modules/adaptive-intraday/types/adaptive-market-regime.types';
import {
  CrossSessionEntryTimeframe,
  CrossSessionPreparedSession,
  isCooldownEligible,
} from './cross-session-indicator-warmup';

export type V4OptionDirection = 'CE' | 'PE';
export type V4Family = 'OPENING_RANGE' | 'VWAP' | 'MOMENTUM_EXPANSION';
export type V4OpeningRangeSetup =
  | 'BREAKOUT_RETEST_UP_CE'
  | 'BREAKOUT_RETEST_DOWN_PE'
  | 'FAILED_BREAKOUT_UP_PE'
  | 'FAILED_BREAKOUT_DOWN_CE';
export type V4VwapConfirmation = 'NONE' | 'RSI_DIRECTIONAL' | 'EMA_DIRECTIONAL';

export interface V4Signal {
  family: V4Family;
  configKey: string;
  date: string;
  timestamp: Date;
  spotPrice: number;
  direction: V4OptionDirection;
  regimeAvailableAt?: Date;
}

export interface V4OpeningRangeConfig {
  family: 'OPENING_RANGE';
  timeframe: CrossSessionEntryTimeframe;
  rangeMinutes: 10 | 15 | 30;
  setup: V4OpeningRangeSetup;
  breakoutBufferPercent: 0 | 0.05 | 0.1;
  retestBufferPercent: 0 | 0.05;
  cooldownMinutes: 0 | 5 | 10;
}

export interface V4VwapConfig {
  family: 'VWAP';
  timeframe: CrossSessionEntryTimeframe;
  proximityPercent: 0.05 | 0.1 | 0.15 | 0.2;
  confirmation: V4VwapConfirmation;
  pullbackMode: 'FIRST_PULLBACK' | 'REPEATED_PULLBACK';
  cooldownMinutes: 0 | 5 | 10;
  direction: V4OptionDirection;
}

export interface V4MomentumConfig {
  family: 'MOMENTUM_EXPANSION';
  timeframe: CrossSessionEntryTimeframe;
  compressionBars: 3 | 5;
  compressionRangeAtr: 1.5 | 2;
  bodyAtr: 0.75 | 1;
  breakoutAtr: 0.1 | 0.25;
  requireVwapAlignment: boolean;
  requirePrimaryRegimeAlignment: boolean;
  cooldownMinutes: 0 | 5;
  direction: V4OptionDirection;
}

export type V4Config = V4OpeningRangeConfig | V4VwapConfig | V4MomentumConfig;
export interface V4ConfigGroups {
  OPENING_RANGE: V4OpeningRangeConfig[];
  VWAP: V4VwapConfig[];
  MOMENTUM_EXPANSION: V4MomentumConfig[];
}

export interface V4IndicatorContext {
  vwapByFrame: ReadonlyMap<CrossSessionEntryTimeframe, ReadonlyMap<number, number>>;
  atr14ByFrame: ReadonlyMap<CrossSessionEntryTimeframe, ReadonlyMap<number, number>>;
}

const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function v4ConfigKey(config: V4Config): string {
  if (config.family === 'OPENING_RANGE') {
    return [config.family, config.rangeMinutes, config.timeframe, config.setup, config.breakoutBufferPercent, config.retestBufferPercent, config.cooldownMinutes].join('|');
  }
  if (config.family === 'VWAP') {
    return [config.family, config.timeframe, config.direction, config.proximityPercent, config.confirmation, config.pullbackMode, config.cooldownMinutes].join('|');
  }
  return [config.family, config.timeframe, config.direction, config.compressionBars, config.compressionRangeAtr, config.bodyAtr, config.breakoutAtr, config.requireVwapAlignment, config.requirePrimaryRegimeAlignment, config.cooldownMinutes].join('|');
}

export function generateV4Signals(
  sessions: readonly CrossSessionPreparedSession[],
  config: V4Config,
  indicators: V4IndicatorContext,
): V4Signal[] {
  if (config.family === 'OPENING_RANGE') return generateOpeningRangeSignals(sessions, config);
  if (config.family === 'VWAP') return generateVwapSignals(sessions, config, indicators.vwapByFrame);
  return generateMomentumSignals(sessions, config, indicators);
}

export function assertV4NoLookAhead(signals: readonly V4Signal[]): void {
  signals.forEach((signal) => {
    if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) {
      throw new Error(`V4 look-ahead detected at ${signal.timestamp.toISOString()}.`);
    }
  });
}

function generateOpeningRangeSignals(sessions: readonly CrossSessionPreparedSession[], config: V4OpeningRangeConfig): V4Signal[] {
  const result: V4Signal[] = [];
  sessions.forEach((session) => {
    const start = session.oneMinute[0]?.timestamp.getTime();
    if (start === undefined) return;
    const range = session.oneMinute.filter((candle) => candle.timestamp.getTime() < start + config.rangeMinutes * 60_000);
    if (range.length !== config.rangeMinutes) return;
    const rangeHigh = Math.max(...range.map((candle) => candle.high));
    const rangeLow = Math.min(...range.map((candle) => candle.low));
    const rangeEnd = start + config.rangeMinutes * 60_000;
    let armed = false;
    let lastSignalAt: number | undefined;
    session.frames[config.timeframe].candles.forEach((candle) => {
      const completedAt = candle.timestamp.getTime() + config.timeframe * 60_000;
      if (completedAt <= rangeEnd) return;
      const breakUp = candle.close >= rangeHigh * (1 + config.breakoutBufferPercent / 100);
      const breakDown = candle.close <= rangeLow * (1 - config.breakoutBufferPercent / 100);
      const retestUp = candle.low <= rangeHigh * (1 + config.retestBufferPercent / 100) && candle.close >= rangeHigh;
      const retestDown = candle.high >= rangeLow * (1 - config.retestBufferPercent / 100) && candle.close <= rangeLow;
      const failedUp = candle.close <= rangeHigh * (1 - config.retestBufferPercent / 100);
      const failedDown = candle.close >= rangeLow * (1 + config.retestBufferPercent / 100);
      const setupMatches =
        (config.setup === 'BREAKOUT_RETEST_UP_CE' && armed && retestUp) ||
        (config.setup === 'BREAKOUT_RETEST_DOWN_PE' && armed && retestDown) ||
        (config.setup === 'FAILED_BREAKOUT_UP_PE' && armed && failedUp) ||
        (config.setup === 'FAILED_BREAKOUT_DOWN_CE' && armed && failedDown);
      const startsBreakout =
        (config.setup === 'BREAKOUT_RETEST_UP_CE' || config.setup === 'FAILED_BREAKOUT_UP_PE') ? breakUp : breakDown;
      if (setupMatches && isCooldownEligible(lastSignalAt, completedAt, config.cooldownMinutes)) {
        result.push(signal(session, config, completedAt, candle.close, directionForOpeningRange(config.setup)));
        lastSignalAt = completedAt;
        armed = false;
      }
      if (startsBreakout) armed = true;
    });
  });
  return result;
}

function generateVwapSignals(
  sessions: readonly CrossSessionPreparedSession[],
  config: V4VwapConfig,
  vwapByFrame: ReadonlyMap<CrossSessionEntryTimeframe, ReadonlyMap<number, number>>,
): V4Signal[] {
  const result: V4Signal[] = [];
  const vwap = vwapByFrame.get(config.timeframe);
  if (!vwap) throw new Error(`Missing VWAP map for ${config.timeframe}m V4 frame.`);
  sessions.forEach((session) => {
    const frame = session.frames[config.timeframe];
    let pullbacks = 0;
    let rearmed = false;
    let lastSignalAt: number | undefined;
    frame.candles.forEach((candle, index) => {
      if (index === 0) return;
      const completedAt = candle.timestamp.getTime() + config.timeframe * 60_000;
      const latestRegime = latestRegimeAt(session, completedAt);
      const currentVwap = vwap.get(candle.timestamp.getTime());
      const previous = frame.candles[index - 1];
      const previousVwap = vwap.get(previous.timestamp.getTime());
      const rsi = frame.rsi14.get(candle.timestamp.getTime());
      const ema15 = frame.ema15.get(candle.timestamp.getTime());
      const ema35 = frame.ema35.get(candle.timestamp.getTime());
      if (currentVwap === undefined || previousVwap === undefined || rsi === undefined || ema15 === undefined || ema35 === undefined) return;
      const bullish = config.direction === 'CE';
      const regimeMatches = latestRegime?.regime === (bullish ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN);
      if (!regimeMatches) return;
      const wasAway = bullish ? previous.close > previousVwap * (1 + config.proximityPercent / 100) : previous.close < previousVwap * (1 - config.proximityPercent / 100);
      if (wasAway) rearmed = true;
      const touchesAndHolds = bullish
        ? candle.low <= currentVwap * (1 + config.proximityPercent / 100) && candle.close >= currentVwap
        : candle.high >= currentVwap * (1 - config.proximityPercent / 100) && candle.close <= currentVwap;
      if (!rearmed || !touchesAndHolds || !confirmationMatches(config.confirmation, bullish, rsi, ema15, ema35)) return;
      if (config.pullbackMode === 'FIRST_PULLBACK' && pullbacks > 0) return;
      if (!isCooldownEligible(lastSignalAt, completedAt, config.cooldownMinutes)) return;
      result.push(signal(session, config, completedAt, candle.close, config.direction, latestRegime?.availableAt));
      pullbacks += 1;
      lastSignalAt = completedAt;
      rearmed = false;
    });
  });
  return result;
}

function generateMomentumSignals(
  sessions: readonly CrossSessionPreparedSession[],
  config: V4MomentumConfig,
  indicators: V4IndicatorContext,
): V4Signal[] {
  const result: V4Signal[] = [];
  const atr = indicators.atr14ByFrame.get(config.timeframe);
  const vwap = indicators.vwapByFrame.get(config.timeframe);
  if (!atr || !vwap) throw new Error(`Missing ATR or VWAP map for ${config.timeframe}m V4 frame.`);
  sessions.forEach((session) => {
    const frame = session.frames[config.timeframe];
    let lastSignalAt: number | undefined;
    frame.candles.forEach((candle, index) => {
      if (index < config.compressionBars) return;
      const completedAt = candle.timestamp.getTime() + config.timeframe * 60_000;
      const atr14 = atr.get(candle.timestamp.getTime());
      const currentVwap = vwap.get(candle.timestamp.getTime());
      if (atr14 === undefined || atr14 <= 0) return;
      const prior = frame.candles.slice(index - config.compressionBars, index);
      const priorHigh = Math.max(...prior.map((value) => value.high));
      const priorLow = Math.min(...prior.map((value) => value.low));
      const compressed = priorHigh - priorLow <= atr14 * config.compressionRangeAtr;
      const body = Math.abs(candle.close - candle.open);
      const bullish = config.direction === 'CE';
      const expansion = bullish
        ? candle.close >= priorHigh + atr14 * config.breakoutAtr && candle.close > candle.open
        : candle.close <= priorLow - atr14 * config.breakoutAtr && candle.close < candle.open;
      const vwapMatches = !config.requireVwapAlignment || (currentVwap !== undefined && (bullish ? candle.close >= currentVwap : candle.close <= currentVwap));
      const latestRegime = latestRegimeAt(session, completedAt);
      const regimeMatches = !config.requirePrimaryRegimeAlignment || latestRegime?.regime === (bullish ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN);
      if (!compressed || body < atr14 * config.bodyAtr || !expansion || !vwapMatches || !regimeMatches || !isCooldownEligible(lastSignalAt, completedAt, config.cooldownMinutes)) return;
      result.push(signal(session, config, completedAt, candle.close, config.direction, latestRegime?.availableAt));
      lastSignalAt = completedAt;
    });
  });
  return result;
}

function confirmationMatches(confirmation: V4VwapConfirmation, bullish: boolean, rsi: number, ema15: number, ema35: number): boolean {
  if (confirmation === 'NONE') return true;
  if (confirmation === 'RSI_DIRECTIONAL') return bullish ? rsi > 50 : rsi < 50;
  return bullish ? ema15 > ema35 : ema15 < ema35;
}

function directionForOpeningRange(setup: V4OpeningRangeSetup): V4OptionDirection {
  return setup === 'BREAKOUT_RETEST_UP_CE' || setup === 'FAILED_BREAKOUT_DOWN_CE' ? 'CE' : 'PE';
}

function latestRegimeAt(session: CrossSessionPreparedSession, timestamp: number) {
  for (let index = session.regimePoints.length - 1; index >= 0; index -= 1) {
    const point = session.regimePoints[index];
    if (point.availableAt.getTime() <= timestamp) return point;
  }
  return undefined;
}

function signal(
  session: CrossSessionPreparedSession,
  config: V4Config,
  timestamp: number,
  spotPrice: number,
  direction: V4OptionDirection,
  regimeAvailableAt?: Date,
): V4Signal {
  return {
    family: config.family,
    configKey: v4ConfigKey(config),
    date: session.date,
    timestamp: new Date(timestamp),
    spotPrice,
    direction,
    regimeAvailableAt,
  };
}

export function v4MarketMinute(timestamp: Date): number {
  const values = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

export function createV4Configs(): V4ConfigGroups {
  const timeframes: CrossSessionEntryTimeframe[] = [1, 2, 3, 5];
  const openingRange: V4OpeningRangeConfig[] = ([10, 15, 30] as const).flatMap((rangeMinutes) =>
    timeframes.flatMap((timeframe) =>
      (['BREAKOUT_RETEST_UP_CE', 'BREAKOUT_RETEST_DOWN_PE', 'FAILED_BREAKOUT_UP_PE', 'FAILED_BREAKOUT_DOWN_CE'] as const).flatMap((setup) =>
        ([0, 0.05, 0.1] as const).flatMap((breakoutBufferPercent) =>
          ([0, 0.05] as const).flatMap((retestBufferPercent) =>
            ([0, 5, 10] as const).map((cooldownMinutes) => ({ family: 'OPENING_RANGE', rangeMinutes, timeframe, setup, breakoutBufferPercent, retestBufferPercent, cooldownMinutes })),
          ),
        ),
      ),
    ),
  );
  const vwap: V4VwapConfig[] = timeframes.flatMap((timeframe) =>
    (['CE', 'PE'] as const).flatMap((direction) =>
      ([0.05, 0.1, 0.15, 0.2] as const).flatMap((proximityPercent) =>
        (['NONE', 'RSI_DIRECTIONAL', 'EMA_DIRECTIONAL'] as const).flatMap((confirmation) =>
          (['FIRST_PULLBACK', 'REPEATED_PULLBACK'] as const).flatMap((pullbackMode) =>
            ([0, 5, 10] as const).map((cooldownMinutes) => ({ family: 'VWAP', timeframe, direction, proximityPercent, confirmation, pullbackMode, cooldownMinutes })),
          ),
        ),
      ),
    ),
  );
  const momentum: V4MomentumConfig[] = timeframes.flatMap((timeframe) =>
    (['CE', 'PE'] as const).flatMap((direction) =>
      ([3, 5] as const).flatMap((compressionBars) =>
        ([1.5, 2] as const).flatMap((compressionRangeAtr) =>
          ([0.75, 1] as const).flatMap((bodyAtr) =>
            ([0.1, 0.25] as const).flatMap((breakoutAtr) =>
              [false, true].flatMap((requireVwapAlignment) =>
                [false, true].flatMap((requirePrimaryRegimeAlignment) =>
                  ([0, 5] as const).map((cooldownMinutes) => ({ family: 'MOMENTUM_EXPANSION', timeframe, direction, compressionBars, compressionRangeAtr, bodyAtr, breakoutAtr, requireVwapAlignment, requirePrimaryRegimeAlignment, cooldownMinutes })),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return { OPENING_RANGE: openingRange, VWAP: vwap, MOMENTUM_EXPANSION: momentum };
}
