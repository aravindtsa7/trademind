import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
import { Candle } from '../../indicators/types';

export const V10_STRATEGY_ID = 'V10_NIFTY_BANKNIFTY_LEAD_LAG';
export type V10Timeframe = 1 | 2 | 3;
export type V10Direction = 'CE' | 'PE';
export type V10RegimeMode = 'NO_REGIME_FILTER' | 'ANY_EXCEPT_OPPOSITE';
export type V10TimeFilter = 'FULL_SESSION' | 'EXCLUDE_FIRST_15M';
export type V10Confirmation = 'DIRECTIONAL_CLOSE' | 'MICRO_BREAK_2';

export interface V10Config {
  timeframe: V10Timeframe;
  bankImpulseLookbackBars: 1 | 2;
  bankImpulseThresholdAtr: .75 | 1 | 1.25;
  niftyLagRatioMaximum: .5 | .75;
  confirmationDelayBars: 0 | 1 | 2;
  confirmation: V10Confirmation;
  regimeMode: V10RegimeMode;
  timeFilter: V10TimeFilter;
  cooldownMinutes: 5 | 10;
}

export interface V10PreparedSession {
  date: string;
  niftyFrames: Record<V10Timeframe, Candle[]>;
  bankFrames: Record<V10Timeframe, Candle[]>;
  niftyRegimePoints: Array<{ availableAt: Date; regime: AdaptivePrimaryMarketRegime | undefined }>;
}
export interface V10Indicators {
  niftyAtrByFrame: ReadonlyMap<V10Timeframe, ReadonlyMap<number, number>>;
  bankAtrByFrame: ReadonlyMap<V10Timeframe, ReadonlyMap<number, number>>;
}
export interface V10Signal {
  strategyId: typeof V10_STRATEGY_ID;
  configKey: string;
  date: string;
  timestamp: Date;
  direction: V10Direction;
  timeframe: V10Timeframe;
  bankImpulseTimestamp: Date;
  bankImpulseCompletedAt: Date;
  bankNormalizedImpulse: number;
  niftyNormalizedMoveBeforeConfirmation: number;
  leadTimeMinutes: number;
  confirmationDelayBars: number;
  confirmation: V10Confirmation;
  regimeMode: V10RegimeMode;
  regime?: AdaptivePrimaryMarketRegime;
  regimeAvailableAt?: Date;
  cooldownMinutes: number;
}

/**
 * Full Cartesian design would be 1,728. Before diagnostics it is reduced to
 * 432 using two predeclared execution-context profiles, not outcome results:
 * (no-regime/full-session/5m) and (any-except-opposite/exclude-first-15m/10m).
 * Every requested level remains represented, while the three operational
 * filters are deliberately not independently crossed in phase 1.
 */
const EXECUTION_CONTEXT_PROFILES: ReadonlyArray<Pick<V10Config, 'regimeMode' | 'timeFilter' | 'cooldownMinutes'>> = [
  { regimeMode: 'NO_REGIME_FILTER', timeFilter: 'FULL_SESSION', cooldownMinutes: 5 },
  { regimeMode: 'ANY_EXCEPT_OPPOSITE', timeFilter: 'EXCLUDE_FIRST_15M', cooldownMinutes: 10 },
];

export function v10TheoreticalConfigurationCount(): number { return 3 * 2 * 3 * 2 * 3 * 2 * 2 * 2 * 2; }
export function v10ConfigKey(config: V10Config): string { return [V10_STRATEGY_ID, config.timeframe, config.bankImpulseLookbackBars, config.bankImpulseThresholdAtr, config.niftyLagRatioMaximum, config.confirmationDelayBars, config.confirmation, config.regimeMode, config.timeFilter, config.cooldownMinutes].join('|'); }
export function createV10Configs(): V10Config[] {
  return ([1, 2, 3] as const).flatMap((timeframe) => ([1, 2] as const).flatMap((bankImpulseLookbackBars) => ([.75, 1, 1.25] as const).flatMap((bankImpulseThresholdAtr) => ([.5, .75] as const).flatMap((niftyLagRatioMaximum) => ([0, 1, 2] as const).flatMap((confirmationDelayBars) => (['DIRECTIONAL_CLOSE', 'MICRO_BREAK_2'] as const).flatMap((confirmation) => EXECUTION_CONTEXT_PROFILES.map((profile) => ({ timeframe, bankImpulseLookbackBars, bankImpulseThresholdAtr, niftyLagRatioMaximum, confirmationDelayBars, confirmation, ...profile }))))))));
}

export function generateV10Signals(sessions: readonly V10PreparedSession[], config: V10Config, indicators: V10Indicators): V10Signal[] {
  const niftyAtr = indicators.niftyAtrByFrame.get(config.timeframe); const bankAtr = indicators.bankAtrByFrame.get(config.timeframe);
  if (!niftyAtr || !bankAtr) throw new Error(`V10 missing ${config.timeframe}m ATR inputs.`);
  const output: V10Signal[] = [];
  [...sessions].sort((left, right) => left.date.localeCompare(right.date)).forEach((session) => {
    const nifty = session.niftyFrames[config.timeframe]; const bank = session.bankFrames[config.timeframe];
    const bankByTimestamp = new Map(bank.map((candle) => [candle.timestamp.getTime(), candle]));
    const lastSignalAt: Partial<Record<V10Direction, number>> = {}; const episodeArmed: Record<V10Direction, boolean> = { CE: true, PE: true };
    nifty.forEach((confirmationCandle, confirmationIndex) => {
      const impulseIndex = confirmationIndex - config.confirmationDelayBars;
      if (impulseIndex < config.bankImpulseLookbackBars || confirmationIndex < 2) return;
      const impulseNifty = nifty[impulseIndex]; const bankImpulse = bankByTimestamp.get(impulseNifty.timestamp.getTime());
      const bankStart = bankByTimestamp.get(nifty[impulseIndex - config.bankImpulseLookbackBars].timestamp.getTime());
      const niftyPreConfirmation = nifty[confirmationIndex - 1];
      const signalCompletedAt = completedAt(confirmationCandle, config.timeframe); const bankCompletedAt = bankImpulse ? completedAt(bankImpulse, config.timeframe) : undefined;
      const bankValue = bankImpulse ? bankAtr.get(bankImpulse.timestamp.getTime()) : undefined; const niftyValue = niftyAtr.get(niftyPreConfirmation.timestamp.getTime());
      if (!bankImpulse || !bankStart || !bankCompletedAt || !bankValue || !niftyValue || bankValue <= 0 || niftyValue <= 0) return;
      if (bankCompletedAt.getTime() > signalCompletedAt.getTime()) throw new Error(`V10 attempted future BANK NIFTY data at ${signalCompletedAt.toISOString()}.`);
      const impulse = (bankImpulse.close - bankStart.close) / bankValue; const direction: V10Direction | undefined = impulse >= config.bankImpulseThresholdAtr ? 'CE' : impulse <= -config.bankImpulseThresholdAtr ? 'PE' : undefined;
      if (!direction) { episodeArmed.CE = true; episodeArmed.PE = true; return; }
      const preMove = (niftyPreConfirmation.close - nifty[impulseIndex - config.bankImpulseLookbackBars].close) / niftyValue;
      if (Math.abs(preMove) >= Math.abs(impulse) * config.niftyLagRatioMaximum) { episodeArmed[direction] = true; return; }
      if (!timeAllowed(signalCompletedAt, config.timeFilter) || !confirm(direction, confirmationCandle, nifty.slice(0, confirmationIndex), niftyAtr.get(confirmationCandle.timestamp.getTime()), config.confirmation)) return;
      const regimePoint = latestRegimeAt(session.niftyRegimePoints, signalCompletedAt); if (!regimeAllowed(config.regimeMode, direction, regimePoint?.regime)) return;
      if (!episodeArmed[direction] || (lastSignalAt[direction] !== undefined && signalCompletedAt.getTime() - lastSignalAt[direction]! < config.cooldownMinutes * 60_000)) return;
      output.push({ strategyId: V10_STRATEGY_ID, configKey: v10ConfigKey(config), date: session.date, timestamp: signalCompletedAt, direction, timeframe: config.timeframe, bankImpulseTimestamp: new Date(bankImpulse.timestamp.getTime()), bankImpulseCompletedAt: bankCompletedAt, bankNormalizedImpulse: impulse, niftyNormalizedMoveBeforeConfirmation: preMove, leadTimeMinutes: (signalCompletedAt.getTime() - bankCompletedAt.getTime()) / 60_000, confirmationDelayBars: config.confirmationDelayBars, confirmation: config.confirmation, regimeMode: config.regimeMode, regime: regimePoint?.regime, regimeAvailableAt: regimePoint?.availableAt, cooldownMinutes: config.cooldownMinutes });
      lastSignalAt[direction] = signalCompletedAt.getTime(); episodeArmed[direction] = false;
    });
  });
  return output;
}

export function assertV10NoLookAhead(signals: readonly V10Signal[]): void {
  signals.forEach((signal) => {
    if (signal.bankImpulseCompletedAt.getTime() > signal.timestamp.getTime()) throw new Error(`V10 BANK NIFTY lookahead at ${signal.timestamp.toISOString()}.`);
    if (signal.regimeAvailableAt && signal.regimeAvailableAt.getTime() > signal.timestamp.getTime()) throw new Error(`V10 regime lookahead at ${signal.timestamp.toISOString()}.`);
    if (signal.leadTimeMinutes < 0) throw new Error(`V10 negative lead time at ${signal.timestamp.toISOString()}.`);
  });
}

function confirm(direction: V10Direction, candle: Candle, prior: readonly Candle[], atr: number | undefined, confirmation: V10Confirmation): boolean {
  if (!atr || atr <= 0) return false;
  if (confirmation === 'DIRECTIONAL_CLOSE') return direction === 'CE' ? candle.close > candle.open && candle.close - candle.open >= atr * .25 : candle.close < candle.open && candle.open - candle.close >= atr * .25;
  const reference = prior.slice(-2); if (reference.length < 2) return false;
  return direction === 'CE' ? candle.close > Math.max(...reference.map((value) => value.high)) : candle.close < Math.min(...reference.map((value) => value.low));
}
function regimeAllowed(mode: V10RegimeMode, direction: V10Direction, regime: AdaptivePrimaryMarketRegime | undefined): boolean { if (mode === 'NO_REGIME_FILTER') return true; if (!regime) return false; return direction === 'CE' ? regime !== AdaptivePrimaryMarketRegime.TREND_DOWN : regime !== AdaptivePrimaryMarketRegime.TREND_UP; }
function latestRegimeAt(points: readonly V10PreparedSession['niftyRegimePoints'][number][], timestamp: Date) { return [...points].reverse().find((point) => point.availableAt.getTime() <= timestamp.getTime()); }
function completedAt(candle: Candle, timeframe: number) { return new Date(candle.timestamp.getTime() + timeframe * 60_000); }
function timeAllowed(timestamp: Date, filter: V10TimeFilter): boolean { if (filter === 'FULL_SESSION') return true; const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value])); return Number(parts.hour) * 60 + Number(parts.minute) >= 570; }
