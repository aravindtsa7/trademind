import { AdaptivePrimaryMarketRegime } from '../../modules/adaptive-intraday/types/adaptive-market-regime.types';
import IndicatorEngineService, { IndicatorEngineResult } from '../../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../modules/indicators/types';
import { CrossSessionPreparedSession, isCooldownEligible } from './cross-session-indicator-warmup';

export type V7Direction = 'CE' | 'PE';
export type V7RegimeFamily = 'NO_REGIME_FILTER' | 'DIRECTION_ALIGNED_REGIME';
export type V7PremiumConfirmation = 'RETURN_ONLY' | 'BODY_AND_RETURN' | 'BREAKOUT_AND_RETURN' | 'BODY_BREAKOUT_AND_RETURN';

export interface V7UnderlyingProfile {
  id: string;
  bodyAtrMinimum: 0.5 | 0.75 | 1 | 1.25;
  breakoutLookbackBars: 1 | 2 | 3;
  regimeFamily: V7RegimeFamily;
}

export interface V7PremiumProfile {
  id: string;
  confirmation: V7PremiumConfirmation;
  returnPercentMinimum: 0.5 | 1 | 1.5 | 2;
  bodyAtrMinimum?: 0.5 | 0.75 | 1;
  breakoutLookbackBars?: 1 | 2 | 3;
}

export interface V7OptionImpulseConfig {
  timeframe: 1 | 2;
  direction: V7Direction;
  underlying: V7UnderlyingProfile;
  premium: V7PremiumProfile;
  minimumPremium: 50 | 75 | 100 | 125;
  cooldownMinutes: 0 | 1 | 2 | 3 | 5;
}

export interface V7UnderlyingIndicators { atr14: ReadonlyMap<number, number>; }
export interface V7IndicatorContext { byTimeframe: ReadonlyMap<1 | 2, ReadonlyMap<string, V7UnderlyingIndicators>>; }

/** A premium candle's fields are available only at availableAt, never before it. */
export interface V7OptionPremiumFeature {
  instrumentKey: string;
  tradingDate: string;
  candleStartedAt: Date;
  availableAt: Date;
  close: number;
  returnPercent: number;
  atr14: number;
  bodyAtr: number;
  breakout1: boolean;
  breakout2: boolean;
  breakout3: boolean;
}

export interface V7Signal {
  configKey: string;
  date: string;
  timestamp: Date;
  direction: V7Direction;
  spotPrice: number;
  underlyingTimeframe: 1 | 2;
  regimeFamily: V7RegimeFamily;
  premiumConfirmation: V7PremiumConfirmation;
  regime: AdaptivePrimaryMarketRegime | undefined;
  regimeAvailableAt: Date | undefined;
  entryCandleStartedAt: Date;
  underlyingOpen: number;
  underlyingHigh: number;
  underlyingLow: number;
  underlyingClose: number;
  underlyingAtr14: number;
  underlyingBodyAtr: number;
  option: V7OptionPremiumFeature;
}

/** The broadest underlying-only envelope used to determine sessions needed to inspect premium confirmation locally. */
export interface V7UnderlyingCandidate { direction: V7Direction; date: string; timestamp: Date; spotPrice: number; timeframe: 1 | 2; }

/**
 * The exhaustive threshold product has 122,880 non-equivalent configurations.
 * V7 Phase 1 instead uses a transparent pairwise matrix: every requested value
 * and confirmation family is exercised, but not every body/breakout interaction.
 */
export function createV7OptionImpulseConfigs(): V7OptionImpulseConfig[] {
  const timeframes = [1, 2] as const;
  const floors = [50, 75, 100, 125] as const;
  const cooldowns = [0, 1, 2, 3, 5] as const;
  const underlying = underlyingProfiles();
  const premium = premiumProfiles();
  return (['CE', 'PE'] as const).flatMap((direction) => timeframes.flatMap((timeframe) => underlying.flatMap((underlyingProfile) => premium.flatMap((premiumProfile) => floors.flatMap((minimumPremium) => cooldowns.map((cooldownMinutes) => ({ timeframe, direction, underlying: underlyingProfile, premium: premiumProfile, minimumPremium, cooldownMinutes })))))));
}

export function v7ConfigKey(config: V7OptionImpulseConfig): string {
  return ['V7_OPTION_PREMIUM_IMPULSE', `${config.timeframe}m`, config.direction, config.underlying.id, config.premium.id, config.minimumPremium, config.cooldownMinutes].join('|');
}

export function v7GridDesign() {
  const fullPerDirection = 2 * 4 * 3 * 2 * 64 * 4 * 5;
  const selectedPerDirection = 2 * underlyingProfiles().length * premiumProfiles().length * 4 * 5;
  return {
    exhaustiveNonEquivalentConfigurations: fullPerDirection * 2,
    exhaustivePerDirection: fullPerDirection,
    selectedPairwiseConfigurations: selectedPerDirection * 2,
    selectedPairwisePerDirection: selectedPerDirection,
    intentionallyOmittedCrossInteractions: fullPerDirection * 2 - selectedPerDirection * 2,
    mathematicallyEquivalentConfigurationsPruned: 0,
    underlyingProfiles: underlyingProfiles(),
    premiumProfiles: premiumProfiles(),
  };
}

export function prepareV7IndicatorContext(sessions: readonly CrossSessionPreparedSession[], engine: IndicatorEngineService): V7IndicatorContext {
  const frame = (timeframe: 1 | 2) => new Map(sessions.map((session) => [session.date, calculate(engine, session.frames[timeframe].allCandles)]));
  return { byTimeframe: new Map([[1, frame(1)], [2, frame(2)]]) };
}

export function collectV7UnderlyingImpulseCandidates(sessions: readonly CrossSessionPreparedSession[], indicators: V7IndicatorContext): V7UnderlyingCandidate[] {
  const result = new Map<string, V7UnderlyingCandidate>();
  for (const timeframe of [1, 2] as const) {
    for (const session of sessions) {
      const atr = indicators.byTimeframe.get(timeframe)?.get(session.date)?.atr14;
      if (!atr) throw new Error(`Missing V7 ${timeframe}m ATR for ${session.date}.`);
      const candles = session.frames[timeframe].candles;
      candles.forEach((candle, index) => {
        if (index < 1) return;
        const value = atr.get(candle.timestamp.getTime());
        if (value === undefined || value <= 0 || Math.abs(candle.close - candle.open) < value * .5) return;
        const timestamp = new Date(candle.timestamp.getTime() + timeframe * 60_000);
        if (candle.close > candles[index - 1].high) result.set(featureKey('CE', timestamp.getTime()), { direction: 'CE', date: session.date, timestamp, spotPrice: candle.close, timeframe });
        if (candle.close < candles[index - 1].low) result.set(featureKey('PE', timestamp.getTime()), { direction: 'PE', date: session.date, timestamp, spotPrice: candle.close, timeframe });
      });
    }
  }
  return [...result.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.direction.localeCompare(right.direction));
}

export function generateV7Signals(
  sessions: readonly CrossSessionPreparedSession[],
  config: V7OptionImpulseConfig,
  indicators: V7IndicatorContext,
  optionFeatures: ReadonlyMap<string, V7OptionPremiumFeature>,
): V7Signal[] {
  const signals: V7Signal[] = [];
  for (const session of sessions) {
    const values = indicators.byTimeframe.get(config.timeframe)?.get(session.date);
    if (!values) throw new Error(`Missing V7 ${config.timeframe}m indicators for ${session.date}.`);
    const candles = session.frames[config.timeframe].candles;
    let lastSignalAt: number | undefined;
    let episodeActive = false;
    candles.forEach((candle, index) => {
      const timestamp = candle.timestamp.getTime() + config.timeframe * 60_000;
      if (!isRegularSessionCompletion(new Date(timestamp))) return;
      const regime = latestRegime(session, timestamp);
      const atr14 = values.atr14.get(candle.timestamp.getTime());
      const underlyingPass = atr14 !== undefined && atr14 > 0 && index >= config.underlying.breakoutLookbackBars && underlyingImpulse(candle, candles.slice(index - config.underlying.breakoutLookbackBars, index), atr14, config);
      if (!underlyingPass) { episodeActive = false; return; }
      if (!regimePass(regime?.regime, config)) return;
      if (episodeActive) return;
      const option = optionFeatures.get(featureKey(config.direction, timestamp));
      if (!option || option.availableAt.getTime() > timestamp || !premiumPass(option, config)) return;
      if (!isCooldownEligible(lastSignalAt, timestamp, config.cooldownMinutes)) return;
      signals.push({
        configKey: v7ConfigKey(config), date: session.date, timestamp: new Date(timestamp), direction: config.direction,
        spotPrice: candle.close, underlyingTimeframe: config.timeframe, regimeFamily: config.underlying.regimeFamily, premiumConfirmation: config.premium.confirmation, regime: regime?.regime, regimeAvailableAt: regime ? new Date(regime.availableAt.getTime()) : undefined,
        entryCandleStartedAt: new Date(candle.timestamp.getTime()), underlyingOpen: candle.open, underlyingHigh: candle.high,
        underlyingLow: candle.low, underlyingClose: candle.close, underlyingAtr14: atr14!, underlyingBodyAtr: Math.abs(candle.close - candle.open) / atr14!, option,
      });
      lastSignalAt = timestamp;
      // A fired episode rearms only after this configuration's underlying breakout fails.
      episodeActive = true;
    });
  }
  return signals;
}

export function assertV7NoLookAhead(signals: readonly V7Signal[]): void {
  signals.forEach((signal) => {
    if (signal.entryCandleStartedAt.getTime() + timeframeFromKey(signal.configKey) * 60_000 !== signal.timestamp.getTime()) throw new Error(`V7 entry was not a completed candle at ${signal.timestamp.toISOString()}.`);
    if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V7 regime look-ahead at ${signal.timestamp.toISOString()}.`);
    if (signal.option.availableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V7 option-premium look-ahead at ${signal.timestamp.toISOString()}.`);
    if (signal.option.candleStartedAt.getTime() + 60_000 !== signal.option.availableAt.getTime()) throw new Error(`V7 option candle must be one completed minute at ${signal.timestamp.toISOString()}.`);
  });
}

export function featureKey(direction: V7Direction, timestamp: number): string { return `${direction}\u0000${timestamp}`; }

export function deduplicateV7Signals(signals: readonly V7Signal[]): V7Signal[] {
  const unique = new Map<string, V7Signal>();
  signals.forEach((signal) => {
    const key = featureKey(signal.direction, signal.timestamp.getTime());
    const previous = unique.get(key);
    if (previous && Math.abs(previous.spotPrice - signal.spotPrice) > 1e-9) throw new Error(`V7 conflicting spot price at ${signal.timestamp.toISOString()}.`);
    unique.set(key, previous ?? signal);
  });
  return [...unique.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.direction.localeCompare(right.direction));
}

export function buildV7OptionPremiumFeatures(
  direction: V7Direction,
  instrumentKey: string,
  tradingDate: string,
  candles: readonly Candle[],
  engine: IndicatorEngineService,
): V7OptionPremiumFeature[] {
  const atr14 = calculate(engine, candles).atr14;
  return candles.flatMap((candle, index) => {
    const atr = atr14.get(candle.timestamp.getTime());
    const previous = candles[index - 1];
    if (!previous || atr === undefined || atr <= 0 || previous.close <= 0) return [];
    const priorHigh = (count: number) => Math.max(...candles.slice(Math.max(0, index - count), index).map((value) => value.high));
    return [{
      instrumentKey, tradingDate, candleStartedAt: new Date(candle.timestamp.getTime()), availableAt: new Date(candle.timestamp.getTime() + 60_000),
      close: candle.close, returnPercent: (candle.close - previous.close) / previous.close * 100, atr14: atr,
      bodyAtr: Math.abs(candle.close - candle.open) / atr,
      breakout1: index >= 1 && candle.close > priorHigh(1), breakout2: index >= 2 && candle.close > priorHigh(2), breakout3: index >= 3 && candle.close > priorHigh(3),
    }];
  });
}

function underlyingProfiles(): V7UnderlyingProfile[] {
  const pairs: ReadonlyArray<readonly [0.5 | 0.75 | 1 | 1.25, 1 | 2 | 3]> = [[0.5, 1], [0.5, 2], [0.75, 2], [1, 3], [1.25, 3]];
  return (['NO_REGIME_FILTER', 'DIRECTION_ALIGNED_REGIME'] as const).flatMap((regimeFamily) => pairs.map(([bodyAtrMinimum, breakoutLookbackBars]) => ({ id: `${bodyAtrMinimum}ATR_${breakoutLookbackBars}BAR_${regimeFamily}`, bodyAtrMinimum, breakoutLookbackBars, regimeFamily })));
}

function premiumProfiles(): V7PremiumProfile[] {
  return [
    { id: 'RETURN_0.5', confirmation: 'RETURN_ONLY', returnPercentMinimum: .5 },
    { id: 'RETURN_1', confirmation: 'RETURN_ONLY', returnPercentMinimum: 1 },
    { id: 'RETURN_1.5', confirmation: 'RETURN_ONLY', returnPercentMinimum: 1.5 },
    { id: 'RETURN_2', confirmation: 'RETURN_ONLY', returnPercentMinimum: 2 },
    { id: 'BODY_0.5_RETURN_0.5', confirmation: 'BODY_AND_RETURN', bodyAtrMinimum: .5, returnPercentMinimum: .5 },
    { id: 'BODY_0.5_RETURN_1', confirmation: 'BODY_AND_RETURN', bodyAtrMinimum: .5, returnPercentMinimum: 1 },
    { id: 'BODY_0.75_RETURN_1.5', confirmation: 'BODY_AND_RETURN', bodyAtrMinimum: .75, returnPercentMinimum: 1.5 },
    { id: 'BODY_1_RETURN_2', confirmation: 'BODY_AND_RETURN', bodyAtrMinimum: 1, returnPercentMinimum: 2 },
    { id: 'BREAK_1_RETURN_0.5', confirmation: 'BREAKOUT_AND_RETURN', breakoutLookbackBars: 1, returnPercentMinimum: .5 },
    { id: 'BREAK_1_RETURN_1', confirmation: 'BREAKOUT_AND_RETURN', breakoutLookbackBars: 1, returnPercentMinimum: 1 },
    { id: 'BREAK_2_RETURN_1.5', confirmation: 'BREAKOUT_AND_RETURN', breakoutLookbackBars: 2, returnPercentMinimum: 1.5 },
    { id: 'BREAK_3_RETURN_2', confirmation: 'BREAKOUT_AND_RETURN', breakoutLookbackBars: 3, returnPercentMinimum: 2 },
    { id: 'BODY_0.5_BREAK_1_RETURN_0.5', confirmation: 'BODY_BREAKOUT_AND_RETURN', bodyAtrMinimum: .5, breakoutLookbackBars: 1, returnPercentMinimum: .5 },
    { id: 'BODY_0.5_BREAK_1_RETURN_1', confirmation: 'BODY_BREAKOUT_AND_RETURN', bodyAtrMinimum: .5, breakoutLookbackBars: 1, returnPercentMinimum: 1 },
    { id: 'BODY_0.75_BREAK_2_RETURN_1.5', confirmation: 'BODY_BREAKOUT_AND_RETURN', bodyAtrMinimum: .75, breakoutLookbackBars: 2, returnPercentMinimum: 1.5 },
    { id: 'BODY_1_BREAK_3_RETURN_2', confirmation: 'BODY_BREAKOUT_AND_RETURN', bodyAtrMinimum: 1, breakoutLookbackBars: 3, returnPercentMinimum: 2 },
  ];
}

function underlyingImpulse(candle: Candle, previous: readonly Candle[], atr14: number, config: V7OptionImpulseConfig): boolean {
  const bullish = config.direction === 'CE';
  const breaks = bullish ? candle.close > Math.max(...previous.map((value) => value.high)) : candle.close < Math.min(...previous.map((value) => value.low));
  return Math.abs(candle.close - candle.open) >= atr14 * config.underlying.bodyAtrMinimum && breaks;
}
function premiumPass(feature: V7OptionPremiumFeature, config: V7OptionImpulseConfig): boolean {
  if (feature.close < config.minimumPremium || feature.returnPercent < config.premium.returnPercentMinimum) return false;
  if (config.premium.confirmation === 'RETURN_ONLY') return true;
  const body = feature.bodyAtr >= config.premium.bodyAtrMinimum!;
  if (config.premium.confirmation === 'BODY_AND_RETURN') return body;
  const breakout = config.premium.breakoutLookbackBars === 1 ? feature.breakout1 : config.premium.breakoutLookbackBars === 2 ? feature.breakout2 : feature.breakout3;
  return config.premium.confirmation === 'BREAKOUT_AND_RETURN' ? breakout : body && breakout;
}
function regimePass(regime: AdaptivePrimaryMarketRegime | undefined, config: V7OptionImpulseConfig): boolean {
  if (config.underlying.regimeFamily === 'NO_REGIME_FILTER') return true;
  return regime === (config.direction === 'CE' ? AdaptivePrimaryMarketRegime.TREND_UP : AdaptivePrimaryMarketRegime.TREND_DOWN);
}
function latestRegime(session: CrossSessionPreparedSession, timestamp: number) { for (let index = session.regimePoints.length - 1; index >= 0; index -= 1) if (session.regimePoints[index].availableAt.getTime() <= timestamp) return session.regimePoints[index]; return undefined; }
function calculate(engine: IndicatorEngineService, candles: readonly Candle[]): V7UnderlyingIndicators { const result = engine.calculate(candles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }); return { atr14: scalar(result, IndicatorType.ATR, 14) }; }
function scalar(result: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const found = result.indicators.find((item) => item.config.type === type && 'period' in item.config && item.config.period === period); if (!found) throw new Error(`Missing V7 ${type}${period}.`); return new Map(found.result.values.flatMap((item) => 'value' in item && typeof item.value === 'number' ? [[item.timestamp.getTime(), item.value] as [number, number]] : [])); }
function timeframeFromKey(configKey: string): number { const value = configKey.split('|')[1]; return value === '1m' ? 1 : value === '2m' ? 2 : Number.NaN; }
function isRegularSessionCompletion(value: Date): boolean { const dayMillis = 86_400_000; const shifted = ((value.getTime() + 19_800_000) % dayMillis + dayMillis) % dayMillis; const minute = Math.floor(shifted / 60_000); return minute >= 555 && minute <= 929; }
