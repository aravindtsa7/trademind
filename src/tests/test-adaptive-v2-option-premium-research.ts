import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import { OptionOutcomeDto } from '../modules/options/dto/option-outcome.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionOutcomeEvaluatorService from '../modules/options/services/option-outcome-evaluator.service';
import { OptionContract } from '../modules/options/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

dotenv.config();
// The Upstox clients log individual cached API requests; keep the research output focused on its results.
logger.silent = true;

const instrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandlesPerSession = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const horizons = [5, 10, 15, 30, 60] as const;
const optionResolutionConcurrency = 4;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type OutcomeHorizon = (typeof horizons)[number];
type SignalType = 'BUY_CE' | 'BUY_PE';
type SetupId = 'TREND_UP_CE_PULLBACK' | 'TREND_DOWN_PE_PULLBACK' | 'SIDEWAYS_SUPPORT_RESISTANCE' | 'SIDEWAYS_FALSE_BREAKOUT_PE';
type TimeBucket = '09:15-10:30' | '10:30-12:00' | '12:00-13:30' | '13:30-15:30';

interface StoredCandle { candleTime: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: bigint; openInterest: bigint | null; }
interface Session { date: string; candles: Candle[]; regimes: Array<AdaptivePrimaryMarketRegime | undefined>; ema35: Map<number, number>; rsi14: Map<number, number>; }
interface RawOpportunity { tradingDate: string; timestamp: Date; primaryRegime: AdaptivePrimaryMarketRegime; setupId: SetupId; signalType: SignalType; close: number; reasons: string[]; }
interface ExecutableOpportunity extends Omit<RawOpportunity, 'setupId' | 'reasons'> { setupIds: SetupId[]; reasons: string[]; }
interface ResolvedOpportunity { opportunity: ExecutableOpportunity; outcome: OptionOutcomeDto; at10mPercent: number | null; exit: OptionExitPolicyEvaluationResult; }
interface FailedOpportunity { opportunity: ExecutableOpportunity; error: string; }
interface PercentMetric { positive: number; negative: number; neutral: number; positivePercent: number; averagePercent: number; medianPercent: number; }
interface GroupMetrics { opportunities: number; resolved: number; exits: number; unavailable: number; ambiguous: number; horizons: Record<OutcomeHorizon, PercentMetric>; averageMfePercent: number; averageMaePercent: number; target: number; stop: number; timeExit: number; averageExitPercent: number; medianExitPercent: number; positiveExitPercent: number; bestExitPercent: number; worstExitPercent: number; }

const setupIds: readonly SetupId[] = ['TREND_UP_CE_PULLBACK', 'TREND_DOWN_PE_PULLBACK', 'SIDEWAYS_SUPPORT_RESISTANCE', 'SIDEWAYS_FALSE_BREAKOUT_PE'];
const timeBuckets: readonly TimeBucket[] = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'];

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } { const parts = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }; }
function isCompleteSession(candles: StoredCandle[]): boolean { if (candles.length !== expectedOneMinuteCandlesPerSession) return false; const ordered = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()); const first = marketDateAndMinute(ordered[0].candleTime); const last = marketDateAndMinute(ordered[ordered.length - 1].candleTime); return first.minute === marketSessionStartMinute && last.minute === marketSessionEndMinute && ordered.every((candle, index) => index === 0 || candle.candleTime.getTime() - ordered[index - 1].candleTime.getTime() === 60_000); }
function toCandle(candle: StoredCandle): Candle { const volume = Number(candle.volume); const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest); if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored volume or open interest exceeds JavaScript safe-integer precision.'); return { timestamp: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest }; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]; }
function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period); if (!indicator) throw new Error(`Missing ${type}${period}.`); const values = new Map<number, number>(); indicator.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); }); return values; }
function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> { const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14); if (!indicator) throw new Error('Missing ADX14.'); const values = new Map<number, AdxValue>(); indicator.result.values.forEach((entry) => { if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date }); }); return values; }

function prepareSessions(rawSessions: Array<[string, StoredCandle[]]>, aggregator: CandleTimeframeAggregatorService, engine: IndicatorEngineService, regimeService: AdaptiveMarketRegimeService): Session[] {
  return rawSessions.map(([date, stored]) => {
    const candles = aggregator.aggregate([...stored].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map(toCandle), '5m');
    const indicators = engine.calculate(candles, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 }] });
    const ema15 = scalarMap(indicators, IndicatorType.EMA, 15); const ema35 = scalarMap(indicators, IndicatorType.EMA, 35); const rsi14 = scalarMap(indicators, IndicatorType.RSI, 14); const adx14 = adxMap(indicators); const atr14 = scalarMap(indicators, IndicatorType.ATR, 14);
    const regimes = candles.map((candle) => { const key = candle.timestamp.getTime(); const fast = ema15.get(key); const slow = ema35.get(key); const rsi = rsi14.get(key); const adx = adx14.get(key); const atr = atr14.get(key); return fast === undefined || slow === undefined || rsi === undefined || !adx || atr === undefined ? undefined : regimeService.classify({ timestamp: candle.timestamp, close: candle.close, ema15: fast, ema35: slow, rsi14: rsi, adx14: adx.adx, atr14: atr }).primaryRegime; });
    return { date, candles, regimes, ema35, rsi14 };
  });
}

function createOpportunity(session: Session, index: number, primaryRegime: AdaptivePrimaryMarketRegime, setupId: SetupId, signalType: SignalType, reasons: string[]): RawOpportunity { const candle = session.candles[index]; return { tradingDate: session.date, timestamp: new Date(candle.timestamp.getTime()), primaryRegime, setupId, signalType, close: candle.close, reasons }; }

function trendUpPullbacks(session: Session): RawOpportunity[] { const opportunities: RawOpportunity[] = []; let lastTimestamp: number | undefined; session.candles.forEach((candle, index) => { if (session.regimes[index] !== AdaptivePrimaryMarketRegime.TREND_UP) return; const timestamp = candle.timestamp.getTime(); const ema35 = session.ema35.get(timestamp); if (ema35 === undefined) return; const lowDistance = Math.abs(candle.low - ema35) / ema35 * 100; if (candle.close > ema35 && lowDistance <= 0.20 && (lastTimestamp === undefined || timestamp - lastTimestamp >= 10 * 60_000)) { opportunities.push(createOpportunity(session, index, AdaptivePrimaryMarketRegime.TREND_UP, 'TREND_UP_CE_PULLBACK', 'BUY_CE', ['TREND_UP', 'EMA35 pullback within 0.20%', 'close above EMA35'])); lastTimestamp = timestamp; } }); return opportunities; }
function trendDownPullbacks(session: Session): RawOpportunity[] { const opportunities: RawOpportunity[] = []; session.candles.forEach((candle, index) => { if (session.regimes[index] !== AdaptivePrimaryMarketRegime.TREND_DOWN) return; const timestamp = candle.timestamp.getTime(); const ema35 = session.ema35.get(timestamp); const rsi = session.rsi14.get(timestamp); if (ema35 === undefined || rsi === undefined) return; const highDistance = Math.abs(candle.high - ema35) / ema35 * 100; if (candle.close < ema35 && highDistance <= 0.20 && rsi < 45) opportunities.push(createOpportunity(session, index, AdaptivePrimaryMarketRegime.TREND_DOWN, 'TREND_DOWN_PE_PULLBACK', 'BUY_PE', ['TREND_DOWN', 'EMA35 pullback within 0.20%', 'RSI14 < 45', 'close below EMA35'])); }); return opportunities; }
function sidewaysSupportResistance(session: Session): RawOpportunity[] { const opportunities: RawOpportunity[] = []; let lastCe: number | undefined; let lastPe: number | undefined; session.candles.forEach((candle, index) => { if (index < 6 || session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS) return; const previous = session.candles.slice(index - 6, index); const support = Math.min(...previous.map((entry) => entry.low)); const resistance = Math.max(...previous.map((entry) => entry.high)); const timestamp = candle.timestamp.getTime(); const supportDistance = (candle.close - support) / candle.close * 100; const resistanceDistance = (resistance - candle.close) / candle.close * 100; if (supportDistance >= 0 && supportDistance <= 0.10 && (lastCe === undefined || timestamp - lastCe >= 10 * 60_000)) { opportunities.push(createOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_SUPPORT_RESISTANCE', 'BUY_CE', ['SIDEWAYS', 'within 0.10% of 6-candle support'])); lastCe = timestamp; } if (resistanceDistance >= 0 && resistanceDistance <= 0.10 && (lastPe === undefined || timestamp - lastPe >= 10 * 60_000)) { opportunities.push(createOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_SUPPORT_RESISTANCE', 'BUY_PE', ['SIDEWAYS', 'within 0.10% of 6-candle resistance'])); lastPe = timestamp; } }); return opportunities; }
function sidewaysFalseBreakoutPe(session: Session): RawOpportunity[] { const opportunities: RawOpportunity[] = []; let lastTimestamp: number | undefined; session.candles.forEach((candle, index) => { if (index < 12 || session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS) return; const recentHigh = Math.max(...session.candles.slice(index - 12, index).map((entry) => entry.high)); const timestamp = candle.timestamp.getTime(); if (candle.high > recentHigh && candle.close < recentHigh && (lastTimestamp === undefined || timestamp - lastTimestamp >= 10 * 60_000)) { opportunities.push(createOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_FALSE_BREAKOUT_PE', 'BUY_PE', ['SIDEWAYS', '12-candle upside breakout failed', 'close returned below recent high'])); lastTimestamp = timestamp; } }); return opportunities; }
function generateRaw(sessions: readonly Session[]): RawOpportunity[] { return sessions.flatMap((session) => [...trendUpPullbacks(session), ...trendDownPullbacks(session), ...sidewaysSupportResistance(session), ...sidewaysFalseBreakoutPe(session)]).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); }

function mergeExactDuplicates(raw: readonly RawOpportunity[]): ExecutableOpportunity[] { const groups = new Map<string, RawOpportunity[]>(); raw.forEach((opportunity) => { const key = `${opportunity.timestamp.getTime()}|${opportunity.signalType}`; const values = groups.get(key) ?? []; values.push(opportunity); groups.set(key, values); }); return Array.from(groups.values()).map((values) => { const first = values[0]; return { tradingDate: first.tradingDate, timestamp: new Date(first.timestamp.getTime()), primaryRegime: first.primaryRegime, signalType: first.signalType, close: first.close, setupIds: Array.from(new Set(values.map((value) => value.setupId))).sort() as SetupId[], reasons: Array.from(new Set(values.flatMap((value) => value.reasons))), }; }).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); }
function buildExecutable(raw: readonly RawOpportunity[]): { exactDeduped: ExecutableOpportunity[]; conflicts: ExecutableOpportunity[]; executable: ExecutableOpportunity[] } { const exactDeduped = mergeExactDuplicates(raw); const timestampGroups = new Map<number, ExecutableOpportunity[]>(); exactDeduped.forEach((opportunity) => { const values = timestampGroups.get(opportunity.timestamp.getTime()) ?? []; values.push(opportunity); timestampGroups.set(opportunity.timestamp.getTime(), values); }); const conflicts = Array.from(timestampGroups.values()).filter((values) => new Set(values.map((value) => value.signalType)).size > 1).flat(); const conflictTimestamps = new Set(conflicts.map((opportunity) => opportunity.timestamp.getTime())); const candidates = exactDeduped.filter((opportunity) => !conflictTimestamps.has(opportunity.timestamp.getTime())); const lastByDirection = new Map<SignalType, number>(); const executable = candidates.filter((opportunity) => { const previous = lastByDirection.get(opportunity.signalType); if (previous !== undefined && opportunity.timestamp.getTime() - previous < 5 * 60_000) return false; lastByDirection.set(opportunity.signalType, opportunity.timestamp.getTime()); return true; }); return { exactDeduped, conflicts, executable }; }

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> { const existing = cache.get(key); if (existing) return existing; const pending = create(); cache.set(key, pending); return pending; }
function chooseExpiry(expiries: readonly string[], signalDate: string): string { const expiry = expiries.filter((candidate) => candidate >= signalDate).sort((left, right) => left.localeCompare(right))[0]; if (!expiry) throw new Error(`No expired option expiry exists on or after ${signalDate}.`); return expiry; }
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> { const results = new Array<R>(items.length); let next = 0; const worker = async (): Promise<void> => { while (next < items.length) { const index = next; next += 1; results[index] = await mapper(items[index]); } }; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker())); return results; }

async function resolveOpportunity(
  opportunity: ExecutableOpportunity,
  optionClient: UpstoxExpiredOptionClient,
  candleClient: UpstoxExpiredOptionCandleClient,
  selector: OptionContractSelectorService,
  outcomeEvaluator: OptionOutcomeEvaluatorService,
  exitEvaluator: OptionExitPolicyEvaluatorService,
  expiryCache: Map<string, Promise<string[]>>,
  contractsCache: Map<string, Promise<OptionContract[]>>,
  candleCache: Map<string, Promise<ExpiredOptionCandleDto[]>>,
): Promise<ResolvedOpportunity | FailedOpportunity> {
  try {
    const expiries = await getOrCreate(expiryCache, instrumentKey, () => optionClient.fetchAvailableExpiries(instrumentKey));
    const expiry = chooseExpiry(expiries, opportunity.tradingDate);
    const contracts = await getOrCreate(contractsCache, `${instrumentKey}|${expiry}`, () => optionClient.fetchExpiredOptionContracts(instrumentKey, expiry));
    const underlying = contracts[0]?.underlying;
    if (!underlying) throw new Error('Expired option contract response did not contain an underlying.');
    const signal = opportunity.signalType === 'BUY_CE' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE;
    const selection = selector.select({ underlying, spotPrice: opportunity.close, signal, timestamp: opportunity.timestamp, contracts });
    const selectedContract = contracts.find((contract) => contract.instrumentKey === selection.instrumentKey);
    if (!selectedContract) throw new Error('Selected option contract was not found in the resolved contract list.');
    const candles = await getOrCreate(candleCache, `${selection.instrumentKey}|${opportunity.tradingDate}`, () => candleClient.fetchCandles(selection.instrumentKey, opportunity.tradingDate, opportunity.tradingDate));
    const outcome = outcomeEvaluator.evaluate({ signalTimestamp: opportunity.timestamp, signalType: signal, selectedContract, candles });
    const tenMinuteCandle = candles.find((candle) => candle.candleTime.getTime() === opportunity.timestamp.getTime() + 10 * 60_000);
    const at10mPercent = tenMinuteCandle === undefined ? null : (tenMinuteCandle.close - outcome.entryPremium) / outcome.entryPremium * 100;
    const exit = exitEvaluator.evaluate({ signalTimestamp: opportunity.timestamp, entryPremium: outcome.entryPremium, candles, exitPolicy: { type: 'TARGET_STOP', targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 } });
    return { opportunity, outcome, at10mPercent, exit };
  } catch (error) {
    return { opportunity, error: error instanceof Error ? error.message : 'Unknown option-resolution failure.' };
  }
}

function percentMetric(values: readonly number[]): PercentMetric { const positive = values.filter((value) => value > 0).length; const negative = values.filter((value) => value < 0).length; const neutral = values.filter((value) => value === 0).length; return { positive, negative, neutral, positivePercent: values.length === 0 ? 0 : positive / values.length * 100, averagePercent: average(values), medianPercent: median(values) }; }
function outcomeChange(record: ResolvedOpportunity, horizon: OutcomeHorizon): number | null { if (horizon === 10) return record.at10mPercent; const key = `at${horizon}m` as 'at5m' | 'at15m' | 'at30m' | 'at60m'; return record.outcome[key]?.changePercent ?? null; }
function metrics(opportunities: readonly ExecutableOpportunity[], records: readonly ResolvedOpportunity[], failures: readonly FailedOpportunity[]): GroupMetrics {
  const exits = records.filter((record) => !record.exit.unavailable && !record.exit.ambiguous && record.exit.premiumChangePercent !== null);
  const returns = exits.map((record) => record.exit.premiumChangePercent as number);
  const target = records.filter((record) => record.exit.exitReason === 'TARGET').length;
  const stop = records.filter((record) => record.exit.exitReason === 'STOP_LOSS').length;
  const timeExit = records.filter((record) => record.exit.exitReason === 'TIME_EXIT').length;
  const ambiguous = records.filter((record) => record.exit.ambiguous).length;
  const unavailable = failures.length + records.filter((record) => record.exit.unavailable).length;
  return { opportunities: opportunities.length, resolved: records.length, exits: exits.length, unavailable, ambiguous, horizons: { 5: percentMetric(records.map((record) => outcomeChange(record, 5)).filter((value): value is number => value !== null)), 10: percentMetric(records.map((record) => outcomeChange(record, 10)).filter((value): value is number => value !== null)), 15: percentMetric(records.map((record) => outcomeChange(record, 15)).filter((value): value is number => value !== null)), 30: percentMetric(records.map((record) => outcomeChange(record, 30)).filter((value): value is number => value !== null)), 60: percentMetric(records.map((record) => outcomeChange(record, 60)).filter((value): value is number => value !== null)) }, averageMfePercent: average(records.map((record) => record.outcome.mfePercent)), averageMaePercent: average(records.map((record) => record.outcome.maePercent)), target, stop, timeExit, averageExitPercent: average(returns), medianExitPercent: median(returns), positiveExitPercent: returns.length === 0 ? 0 : returns.filter((value) => value > 0).length / returns.length * 100, bestExitPercent: returns.length === 0 ? 0 : Math.max(...returns), worstExitPercent: returns.length === 0 ? 0 : Math.min(...returns) }; }
function bucket(timestamp: Date): TimeBucket { const minute = marketDateAndMinute(timestamp).minute; if (minute < 10 * 60 + 30) return '09:15-10:30'; if (minute < 12 * 60) return '10:30-12:00'; if (minute < 13 * 60 + 30) return '12:00-13:30'; return '13:30-15:30'; }
function printGroup(label: string, metric: GroupMetrics): void { const horizonSummary = horizons.map((horizon) => { const value = metric.horizons[horizon]; return `${horizon}m positive=${value.positivePercent.toFixed(2)}% avg=${value.averagePercent.toFixed(2)}% median=${value.medianPercent.toFixed(2)}%`; }).join(' | '); const exitRate = metric.exits === 0 ? 0 : 100 / metric.exits; console.log(`${label}: opportunities=${metric.opportunities} resolved=${metric.resolved} exits=${metric.exits} unavailable=${metric.unavailable} ambiguous=${metric.ambiguous}`); console.log(`  premium movement: ${horizonSummary}`); console.log(`  MFE=${metric.averageMfePercent.toFixed(2)}% MAE=${metric.averageMaePercent.toFixed(2)}% | TARGET=${metric.target} (${(metric.target * exitRate).toFixed(2)}%) STOP=${metric.stop} (${(metric.stop * exitRate).toFixed(2)}%) TIME=${metric.timeExit} (${(metric.timeExit * exitRate).toFixed(2)}%)`); console.log(`  exit return: avg=${metric.averageExitPercent.toFixed(2)}% median=${metric.medianExitPercent.toFixed(2)}% positive=${metric.positiveExitPercent.toFixed(2)}% best=${metric.bestExitPercent.toFixed(2)}% worst=${metric.worstExitPercent.toFixed(2)}%`); }
function classify(metric: GroupMetrics): string { if (metric.exits >= 30 && metric.averageExitPercent > 0 && metric.medianExitPercent > 0 && metric.positiveExitPercent >= 50) return 'STRONG CANDIDATE'; if (metric.averageExitPercent < 0 && metric.medianExitPercent < 0) return 'REJECT CANDIDATE'; return 'WEAK CANDIDATE'; }

async function run(): Promise<void> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  const repository = new HistoricalCandleRepository(); const aggregator = new CandleTimeframeAggregatorService(); const engine = new IndicatorEngineService(); const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });
  const optionClient = new UpstoxExpiredOptionClient(token); const candleClient = new UpstoxExpiredOptionCandleClient(token); const selector = new OptionContractSelectorService(); const outcomeEvaluator = new OptionOutcomeEvaluatorService(); const exitEvaluator = new OptionExitPolicyEvaluatorService();
  logger.info('Starting combined V2 historical option premium research', { instrumentKey });
  const stored = await repository.findByInstrumentAndTimeframe(instrumentKey, sourceTimeframe) as StoredCandle[];
  const grouped = new Map<string, StoredCandle[]>(); stored.forEach((candle) => { const date = marketDateAndMinute(candle.candleTime).date; const entries = grouped.get(date) ?? []; entries.push(candle); grouped.set(date, entries); });
  const complete = Array.from(grouped.entries()).filter(([, candles]) => isCompleteSession(candles)).sort(([left], [right]) => left.localeCompare(right));
  if (complete.length === 0) throw new Error('No complete NIFTY sessions are stored.');
  const sessions = prepareSessions(complete, aggregator, engine, regimeService); const raw = generateRaw(sessions); const inventory = buildExecutable(raw); const sessionDates = sessions.map((session) => session.date);
  console.log(`Instrument=${instrumentKey} complete sessions=${sessions.length} raw=${raw.length} exact-merged=${raw.length - inventory.exactDeduped.length} conflicts=${inventory.conflicts.length / 2} executable=${inventory.executable.length} globalCooldown=5m`);
  const expiryCache = new Map<string, Promise<string[]>>(); const contractsCache = new Map<string, Promise<OptionContract[]>>(); const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const resolution = await mapConcurrent(inventory.executable, optionResolutionConcurrency, (opportunity) => resolveOpportunity(opportunity, optionClient, candleClient, selector, outcomeEvaluator, exitEvaluator, expiryCache, contractsCache, candleCache));
  const resolved = resolution.filter((record): record is ResolvedOpportunity => 'outcome' in record); const failures = resolution.filter((record): record is FailedOpportunity => 'error' in record);
  if (resolved.length === 0) throw new Error('No executable V2 opportunity could be resolved to historical option premium candles.');
  console.log('\nOVERALL'); printGroup('Combined V2 inventory', metrics(inventory.executable, resolved, failures)); console.log(`option-resolved opportunities/session=${(resolved.length / sessions.length).toFixed(2)}`);
  console.log('\nBY SETUP'); setupIds.forEach((setupId) => { const opportunities = inventory.executable.filter((opportunity) => opportunity.setupIds.includes(setupId)); const records = resolved.filter((record) => record.opportunity.setupIds.includes(setupId)); const groupFailures = failures.filter((failure) => failure.opportunity.setupIds.includes(setupId)); const group = metrics(opportunities, records, groupFailures); printGroup(setupId, group); });
  console.log('\nBY REGIME'); [AdaptivePrimaryMarketRegime.TREND_UP, AdaptivePrimaryMarketRegime.TREND_DOWN, AdaptivePrimaryMarketRegime.SIDEWAYS].forEach((regime) => { const opportunities = inventory.executable.filter((opportunity) => opportunity.primaryRegime === regime); const records = resolved.filter((record) => record.opportunity.primaryRegime === regime); const groupFailures = failures.filter((failure) => failure.opportunity.primaryRegime === regime); printGroup(regime, metrics(opportunities, records, groupFailures)); });
  console.log('\nBY DIRECTION'); (['BUY_CE', 'BUY_PE'] as const).forEach((direction) => { const opportunities = inventory.executable.filter((opportunity) => opportunity.signalType === direction); const records = resolved.filter((record) => record.opportunity.signalType === direction); const groupFailures = failures.filter((failure) => failure.opportunity.signalType === direction); printGroup(direction, metrics(opportunities, records, groupFailures)); });
  console.log('\nTIME OF DAY'); timeBuckets.forEach((name) => { const opportunities = inventory.executable.filter((opportunity) => bucket(opportunity.timestamp) === name); const records = resolved.filter((record) => bucket(record.opportunity.timestamp) === name); const groupFailures = failures.filter((failure) => bucket(failure.opportunity.timestamp) === name); printGroup(name, metrics(opportunities, records, groupFailures)); });
  console.log('\nFREQUENCY-QUALITY BY SETUP'); setupIds.forEach((setupId) => { const opportunities = inventory.executable.filter((opportunity) => opportunity.setupIds.includes(setupId)); const records = resolved.filter((record) => record.opportunity.setupIds.includes(setupId)); const groupFailures = failures.filter((failure) => failure.opportunity.setupIds.includes(setupId)); const group = metrics(opportunities, records, groupFailures); const perSession = records.length / sessions.length; const levels = [2, 5, 10].filter((level) => perSession >= level); console.log(`${setupId}: evaluated/session=${perSession.toFixed(2)} qualifies=${levels.length === 0 ? 'none' : levels.map((level) => `>=${level}`).join(', ')} | 15m positive=${group.horizons[15].positivePercent.toFixed(2)}% avg=${group.horizons[15].averagePercent.toFixed(2)}% | exit avg=${group.averageExitPercent.toFixed(2)}% median=${group.medianExitPercent.toFixed(2)}%`); });
  console.log('\nPRUNING REPORT'); setupIds.forEach((setupId) => { const opportunities = inventory.executable.filter((opportunity) => opportunity.setupIds.includes(setupId)); const records = resolved.filter((record) => record.opportunity.setupIds.includes(setupId)); const groupFailures = failures.filter((failure) => failure.opportunity.setupIds.includes(setupId)); const group = metrics(opportunities, records, groupFailures); console.log(`${setupId}: ${classify(group)} (resolved=${group.resolved}, evaluated exits=${group.exits}, exit avg=${group.averageExitPercent.toFixed(2)}%, median=${group.medianExitPercent.toFixed(2)}%, positive=${group.positiveExitPercent.toFixed(2)}%)`); });
  if (failures.length > 0) { console.log(`\nUnavailable option opportunities: ${failures.length}`); failures.slice(0, 25).forEach((failure) => console.log(`${failure.opportunity.timestamp.toISOString()} | ${failure.opportunity.signalType} | ${failure.opportunity.setupIds.join('+')} | ${failure.error}`)); }
  logger.info('Combined V2 historical option premium research completed', { raw: raw.length, executable: inventory.executable.length, resolved: resolved.length, failed: failures.length, sessionCount: sessionDates.length });
}

run().catch((error) => { logger.error('Combined V2 historical option premium research failed', { error }); console.error('Combined V2 historical option premium research failed.', error); process.exitCode = 1; });
