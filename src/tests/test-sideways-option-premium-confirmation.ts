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
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import { OptionContract } from '../modules/options/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

dotenv.config();
// The clients log every cached API request. Keep this research output focused
// on its metrics rather than flooding the integration-test console.
logger.silent = true;

const instrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandlesPerSession = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const supportResistanceLookback = 6;
const proximityPercent = 0.10;
const cooldownMinutes = 10;
const qualityMinimumSampleSize = 30;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Direction = 'CE' | 'PE';
type Rule = 'MOMENTUM' | 'EMA' | 'RSI55' | 'RSI60' | 'BREAKOUT' | 'TWO_CANDLE_MOMENTUM';
type Horizon = 5 | 10 | 15 | 30;

interface StoredCandle { candleTime: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: bigint; openInterest: bigint | null; }
interface Session { date: string; candles: Candle[]; regimes: Array<AdaptivePrimaryMarketRegime | undefined>; }
interface RawOpportunity { date: string; timestamp: Date; direction: Direction; spotPrice: number; }
interface Confirmations { MOMENTUM: boolean; EMA: boolean; RSI55: boolean; RSI60: boolean; BREAKOUT: boolean; TWO_CANDLE_MOMENTUM: boolean; }
interface ResolvedOpportunity extends RawOpportunity { entryPremium: number; premiumCandles5m: Candle[]; premiumCandles1m: ExpiredOptionCandleDto[]; candleIndex: number; confirmations: Confirmations; }
interface ConfirmationConfiguration { name: string; rules: readonly Rule[]; }
interface HorizonMetric { positive: number; negative: number; positivePercent: number; averagePercent: number; medianPercent: number; }
interface Report { config: ConfirmationConfiguration; confirmed: ResolvedOpportunity[]; perSession: number[]; horizons: Record<Horizon, HorizonMetric>; avgMfe: number; medianMfe: number; avgMae: number; medianMae: number; target: number; stop: number; time: number; ambiguous: number; evaluatedExits: number; rawAverageReturn: number; medianReturn: number; timeBuckets: Record<string, { total: number; ce: number; pe: number; accuracy15m: number; average15m: number }>; }

const configurations: readonly ConfirmationConfiguration[] = [
  { name: 'RAW_SIDEWAYS', rules: [] },
  { name: 'PREMIUM_MOMENTUM', rules: ['MOMENTUM'] },
  { name: 'PREMIUM_EMA5_GT_EMA10', rules: ['EMA'] },
  { name: 'PREMIUM_RSI7_GT_55', rules: ['RSI55'] },
  { name: 'PREMIUM_RSI7_GT_60', rules: ['RSI60'] },
  { name: 'PREMIUM_BREAKOUT', rules: ['BREAKOUT'] },
  { name: 'TWO_CANDLE_MOMENTUM', rules: ['TWO_CANDLE_MOMENTUM'] },
  { name: 'MOMENTUM_AND_EMA', rules: ['MOMENTUM', 'EMA'] },
  { name: 'MOMENTUM_AND_RSI55', rules: ['MOMENTUM', 'RSI55'] },
  { name: 'MOMENTUM_AND_RSI60', rules: ['MOMENTUM', 'RSI60'] },
  { name: 'EMA_AND_RSI55', rules: ['EMA', 'RSI55'] },
  { name: 'EMA_AND_RSI60', rules: ['EMA', 'RSI60'] },
  { name: 'MOMENTUM_EMA_RSI55', rules: ['MOMENTUM', 'EMA', 'RSI55'] },
  { name: 'MOMENTUM_EMA_RSI60', rules: ['MOMENTUM', 'EMA', 'RSI60'] },
  { name: 'MOMENTUM_EMA_BREAKOUT', rules: ['MOMENTUM', 'EMA', 'BREAKOUT'] },
  { name: 'ALL_WITH_RSI55', rules: ['MOMENTUM', 'EMA', 'RSI55', 'BREAKOUT', 'TWO_CANDLE_MOMENTUM'] },
  { name: 'ALL_WITH_RSI60', rules: ['MOMENTUM', 'EMA', 'RSI60', 'BREAKOUT', 'TWO_CANDLE_MOMENTUM'] },
];

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } { const values = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])); return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) }; }
function isCompleteSession(candles: StoredCandle[]): boolean { if (candles.length !== expectedOneMinuteCandlesPerSession) return false; const sorted = [...candles].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime()); const first = marketDateAndMinute(sorted[0].candleTime); const last = marketDateAndMinute(sorted[sorted.length - 1].candleTime); return first.minute === marketSessionStartMinute && last.minute === marketSessionEndMinute && sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000); }
function toCandle(candle: StoredCandle): Candle { const volume = Number(candle.volume); const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest); if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored volume or open interest exceeds JavaScript safe-integer precision.'); return { timestamp: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest }; }
function median(values: readonly number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> { const existing = cache.get(key); if (existing) return existing; const value = create(); cache.set(key, value); return value; }
async function mapWithConcurrency<T, TResult>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<TResult>): Promise<TResult[]> { const results: TResult[] = []; let nextIndex = 0; const runWorker = async (): Promise<void> => { while (nextIndex < items.length) { const index = nextIndex; nextIndex += 1; results[index] = await worker(items[index]); } }; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker)); return results; }

function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> { const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period); if (!indicator) throw new Error(`Missing ${type}${period}.`); const values = new Map<number, number>(); indicator.result.values.forEach((entry) => { if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value); }); return values; }
function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> { const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14); if (!indicator) throw new Error('Missing ADX14.'); const values = new Map<number, AdxValue>(); indicator.result.values.forEach((entry) => { if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date }); }); return values; }

function classifySessions(sessions: Array<[string, StoredCandle[]]>, aggregator: CandleTimeframeAggregatorService, engine: IndicatorEngineService, regimes: AdaptiveMarketRegimeService): Session[] {
  return sessions.map(([date, stored]) => {
    const candles = aggregator.aggregate([...stored].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime()).map(toCandle), '5m');
    const result = engine.calculate(candles, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 }] });
    const ema15 = scalarMap(result, IndicatorType.EMA, 15); const ema35 = scalarMap(result, IndicatorType.EMA, 35); const rsi14 = scalarMap(result, IndicatorType.RSI, 14); const adx14 = adxMap(result); const atr14 = scalarMap(result, IndicatorType.ATR, 14);
    const primary = candles.map((candle) => { const key = candle.timestamp.getTime(); const fast = ema15.get(key); const slow = ema35.get(key); const rsi = rsi14.get(key); const adx = adx14.get(key); const atr = atr14.get(key); return fast === undefined || slow === undefined || rsi === undefined || !adx || atr === undefined ? undefined : regimes.classify({ timestamp: candle.timestamp, close: candle.close, ema15: fast, ema35: slow, rsi14: rsi, adx14: adx.adx, atr14: atr }).primaryRegime; });
    return { date, candles, regimes: primary };
  });
}

function rawOpportunities(sessions: readonly Session[]): RawOpportunity[] {
  const opportunities: RawOpportunity[] = [];
  sessions.forEach((session) => {
    let lastCe: number | undefined; let lastPe: number | undefined;
    session.candles.forEach((candle, index) => {
      if (session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS || index < supportResistanceLookback) return;
      const prior = session.candles.slice(index - supportResistanceLookback, index);
      const support = Math.min(...prior.map((value) => value.low)); const resistance = Math.max(...prior.map((value) => value.high));
      const supportDistance = ((candle.close - support) / candle.close) * 100; const resistanceDistance = ((resistance - candle.close) / candle.close) * 100; const timestamp = candle.timestamp.getTime();
      if (supportDistance >= 0 && supportDistance <= proximityPercent && (lastCe === undefined || timestamp - lastCe >= cooldownMinutes * 60_000)) { opportunities.push({ date: session.date, timestamp: new Date(timestamp), direction: 'CE', spotPrice: candle.close }); lastCe = timestamp; }
      if (resistanceDistance >= 0 && resistanceDistance <= proximityPercent && (lastPe === undefined || timestamp - lastPe >= cooldownMinutes * 60_000)) { opportunities.push({ date: session.date, timestamp: new Date(timestamp), direction: 'PE', spotPrice: candle.close }); lastPe = timestamp; }
    });
  });
  return opportunities.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function optionCandleToInternal(candle: ExpiredOptionCandleDto): Candle { const volume = Number(candle.volume); if (!Number.isSafeInteger(volume)) throw new Error('Option candle volume exceeds JavaScript safe-integer precision.'); return { timestamp: new Date(candle.candleTime.getTime()), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume, openInterest: candle.openInterest === undefined ? undefined : Number(candle.openInterest) }; }
function chooseExpiry(expiries: readonly string[], date: string): string { const expiry = [...expiries].filter((value) => value >= date).sort()[0]; if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`); return expiry; }
function premiumConfirmations(candles: readonly Candle[], index: number, engine: IndicatorEngineService): Confirmations { const current = candles[index]; const previous = candles[index - 1]; const twoBack = candles[index - 2]; const priorThree = candles.slice(index - 3, index); const indicatorResult = engine.calculate(candles.slice(0, index + 1), { indicators: [{ type: IndicatorType.EMA, period: 5 }, { type: IndicatorType.EMA, period: 10 }, { type: IndicatorType.RSI, period: 7 }] }); const ema5 = scalarMap(indicatorResult, IndicatorType.EMA, 5).get(current.timestamp.getTime()); const ema10 = scalarMap(indicatorResult, IndicatorType.EMA, 10).get(current.timestamp.getTime()); const rsi7 = scalarMap(indicatorResult, IndicatorType.RSI, 7).get(current.timestamp.getTime()); return { MOMENTUM: previous !== undefined && current.close > previous.close, EMA: ema5 !== undefined && ema10 !== undefined && ema5 > ema10, RSI55: rsi7 !== undefined && rsi7 > 55, RSI60: rsi7 !== undefined && rsi7 > 60, BREAKOUT: priorThree.length === 3 && current.close > Math.max(...priorThree.map((value) => value.close)), TWO_CANDLE_MOMENTUM: previous !== undefined && twoBack !== undefined && current.close > previous.close && previous.close > twoBack.close }; }
function horizonReturns(record: ResolvedOpportunity, horizon: Horizon): number | undefined { const future = record.premiumCandles5m[record.candleIndex + horizon / 5]; return future ? ((future.close - record.entryPremium) / record.entryPremium) * 100 : undefined; }
function excursions(record: ResolvedOpportunity): { mfe?: number; mae?: number } { const future = record.premiumCandles5m.slice(record.candleIndex + 1, record.candleIndex + 7); if (future.length !== 6) return {}; return { mfe: ((Math.max(...future.map((candle) => candle.high)) - record.entryPremium) / record.entryPremium) * 100, mae: ((record.entryPremium - Math.min(...future.map((candle) => candle.low))) / record.entryPremium) * 100 }; }
function timeBucket(timestamp: Date): string { const minute = marketDateAndMinute(timestamp).minute; if (minute < 10 * 60 + 30) return '09:15-10:30'; if (minute < 12 * 60) return '10:30-12:00'; if (minute < 13 * 60 + 30) return '12:00-13:30'; return '13:30-15:30'; }

function createReport(config: ConfirmationConfiguration, resolved: readonly ResolvedOpportunity[], sessionDates: readonly string[], exitEvaluator: OptionExitPolicyEvaluatorService): Report {
  const confirmed = resolved.filter((record) => config.rules.every((rule) => record.confirmations[rule]));
  const perSession = sessionDates.map((date) => confirmed.filter((record) => record.date === date).length);
  const horizons = ([5, 10, 15, 30] as const).reduce((output, horizon) => { const values = confirmed.flatMap((record) => { const value = horizonReturns(record, horizon); return value === undefined ? [] : [value]; }); output[horizon] = { positive: values.filter((value) => value > 0).length, negative: values.filter((value) => value < 0).length, positivePercent: values.length === 0 ? 0 : (values.filter((value) => value > 0).length / values.length) * 100, averagePercent: average(values), medianPercent: median(values) }; return output; }, {} as Record<Horizon, HorizonMetric>);
  const mfe = confirmed.flatMap((record) => excursions(record).mfe === undefined ? [] : [excursions(record).mfe as number]); const mae = confirmed.flatMap((record) => excursions(record).mae === undefined ? [] : [excursions(record).mae as number]);
  let target = 0; let stop = 0; let time = 0; let ambiguous = 0; const returns: number[] = [];
  confirmed.forEach((record) => { const exit = exitEvaluator.evaluate({ signalTimestamp: record.timestamp, entryPremium: record.entryPremium, candles: record.premiumCandles1m, exitPolicy: { type: 'TARGET_STOP', targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 } }); if (exit.exitReason === 'TARGET') target += 1; else if (exit.exitReason === 'STOP_LOSS') stop += 1; else if (exit.exitReason === 'TIME_EXIT') time += 1; else if (exit.exitReason === 'AMBIGUOUS') ambiguous += 1; if (!exit.unavailable && !exit.ambiguous && exit.premiumChangePercent !== null) returns.push(exit.premiumChangePercent); });
  const buckets = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30']; const timeBuckets = Object.fromEntries(buckets.map((bucket) => [bucket, { total: 0, ce: 0, pe: 0, accuracy15m: 0, average15m: 0 }])) as Report['timeBuckets']; buckets.forEach((bucket) => { const rows = confirmed.filter((record) => timeBucket(record.timestamp) === bucket); const values = rows.flatMap((record) => { const value = horizonReturns(record, 15); return value === undefined ? [] : [value]; }); timeBuckets[bucket] = { total: rows.length, ce: rows.filter((record) => record.direction === 'CE').length, pe: rows.filter((record) => record.direction === 'PE').length, accuracy15m: values.length === 0 ? 0 : (values.filter((value) => value > 0).length / values.length) * 100, average15m: average(values) }; });
  return { config, confirmed, perSession, horizons, avgMfe: average(mfe), medianMfe: median(mfe), avgMae: average(mae), medianMae: median(mae), target, stop, time, ambiguous, evaluatedExits: returns.length, rawAverageReturn: average(returns), medianReturn: median(returns), timeBuckets };
}

function printReport(report: Report, rawCount: number): void { console.log(`\n${report.config.name}`); console.log(`raw sideways opportunities=${rawCount} confirmed=${report.confirmed.length} confirmation rate=${rawCount === 0 ? '0.00' : ((report.confirmed.length / rawCount) * 100).toFixed(2)}% avg/session=${average(report.perSession).toFixed(2)} median/session=${median(report.perSession).toFixed(2)}`); ([5, 10, 15, 30] as const).forEach((horizon) => { const metric = report.horizons[horizon]; console.log(`+${horizon}m: positive=${metric.positive} negative=${metric.negative} positive=${metric.positivePercent.toFixed(2)}% avg=${metric.averagePercent.toFixed(2)}% median=${metric.medianPercent.toFixed(2)}%`); }); console.log(`30m MFE avg=${report.avgMfe.toFixed(2)}% median=${report.medianMfe.toFixed(2)}% | MAE avg=${report.avgMae.toFixed(2)}% median=${report.medianMae.toFixed(2)}%`); console.log(`exit policy: evaluated=${report.evaluatedExits} target=${report.target} stop=${report.stop} time=${report.time} ambiguous=${report.ambiguous} raw avg return=${report.rawAverageReturn.toFixed(2)}% median=${report.medianReturn.toFixed(2)}%`); Object.entries(report.timeBuckets).forEach(([bucket, value]) => console.log(`${bucket}: opportunities=${value.total} CE=${value.ce} PE=${value.pe} 15m positive=${value.accuracy15m.toFixed(2)}% avg15m=${value.average15m.toFixed(2)}%`)); }

async function run(): Promise<void> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration research.');
  const repository = new HistoricalCandleRepository(); const aggregator = new CandleTimeframeAggregatorService(); const engine = new IndicatorEngineService(); const regimes = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 }); const optionClient = new UpstoxExpiredOptionClient(token); const optionCandleClient = new UpstoxExpiredOptionCandleClient(token); const selector = new OptionContractSelectorService(); const exitEvaluator = new OptionExitPolicyEvaluatorService();
  logger.info('Starting sideways option premium confirmation research', { instrumentKey, supportResistanceLookback, proximityPercent, cooldownMinutes });
  const stored = await repository.findByInstrumentAndTimeframe(instrumentKey, sourceTimeframe) as StoredCandle[]; const byDate = new Map<string, StoredCandle[]>(); stored.forEach((candle) => { const date = marketDateAndMinute(candle.candleTime).date; const values = byDate.get(date) ?? []; values.push(candle); byDate.set(date, values); }); const complete = Array.from(byDate.entries()).filter(([, candles]) => isCompleteSession(candles)).sort(([a], [b]) => a.localeCompare(b)); if (complete.length === 0) throw new Error('No complete NIFTY sessions are stored.');
  const sessions = classifySessions(complete, aggregator, engine, regimes); const raw = rawOpportunities(sessions); if (raw.length === 0) throw new Error('No raw SIDEWAYS opportunities were found.');
  const expiryCache = new Map<string, Promise<string[]>>(); const contractCache = new Map<string, Promise<OptionContract[]>>(); const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>(); const aggregatedCache = new Map<string, Candle[]>();
  const resolutionResults = await mapWithConcurrency(raw, 4, async (opportunity): Promise<{ resolved?: ResolvedOpportunity; failure?: { opportunity: RawOpportunity; message: string } }> => {
    try {
      const expiries = await getOrCreate(expiryCache, instrumentKey, () => optionClient.fetchAvailableExpiries(instrumentKey)); const expiry = chooseExpiry(expiries, opportunity.date); const contracts = await getOrCreate(contractCache, `${instrumentKey}|${expiry}`, () => optionClient.fetchExpiredOptionContracts(instrumentKey, expiry)); const underlying = contracts[0]?.underlying; if (!underlying) throw new Error('Expired option contract response has no underlying.'); const selection = selector.select({ underlying, spotPrice: opportunity.spotPrice, signal: opportunity.direction === 'CE' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE, timestamp: opportunity.timestamp, contracts });
      const cacheKey = `${selection.instrumentKey}|${opportunity.date}`; const oneMinute = await getOrCreate(candleCache, cacheKey, () => optionCandleClient.fetchCandles(selection.instrumentKey, opportunity.date, opportunity.date)); let fiveMinute = aggregatedCache.get(cacheKey); if (!fiveMinute) { fiveMinute = aggregator.aggregate(oneMinute.map(optionCandleToInternal), '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' }); aggregatedCache.set(cacheKey, fiveMinute); }
      const candleIndex = fiveMinute.findIndex((candle) => candle.timestamp.getTime() === opportunity.timestamp.getTime()); if (candleIndex < 0) throw new Error('Option premium 5-minute candle is not aligned to the SIDEWAYS opportunity timestamp.'); const entry = fiveMinute[candleIndex]; return { resolved: { ...opportunity, entryPremium: entry.close, premiumCandles5m: fiveMinute, premiumCandles1m: oneMinute, candleIndex, confirmations: premiumConfirmations(fiveMinute, candleIndex, engine) } };
    } catch (error) { return { failure: { opportunity, message: error instanceof Error ? error.message : 'Unknown option-data failure.' } }; }
  });
  const resolved = resolutionResults.flatMap((result) => result.resolved === undefined ? [] : [result.resolved]); const failures = resolutionResults.flatMap((result) => result.failure === undefined ? [] : [result.failure]);
  if (resolved.length === 0) throw new Error('No SIDEWAYS opportunities could be resolved to historical option premium data.');
  console.log(`Instrument: ${instrumentKey} | complete sessions=${sessions.length}`); console.log(`Raw SIDEWAYS opportunities=${raw.length}; resolved option opportunities=${resolved.length}; unavailable=${failures.length}`); console.log(`Fixed configuration: lookback=${supportResistanceLookback}, proximity=${proximityPercent}%, cooldown=${cooldownMinutes}m. Confirmation uses selected ATM ${'CE/PE'} premium only.`);
  const reports = configurations.map((config) => createReport(config, resolved, sessions.map((session) => session.date), exitEvaluator)); reports.forEach((report) => printReport(report, raw.length));
  const ranked = reports.filter((report) => report.confirmed.length >= qualityMinimumSampleSize).sort((a, b) => b.horizons[15].positivePercent - a.horizons[15].positivePercent || b.horizons[15].averagePercent - a.horizons[15].averagePercent || b.horizons[15].medianPercent - a.horizons[15].medianPercent || b.avgMfe - a.avgMfe || a.avgMae - b.avgMae);
  console.log(`\nQUALITY ranking (minimum ${qualityMinimumSampleSize} confirmed opportunities)`); ranked.forEach((report, index) => console.log(`${index + 1}. ${report.config.name} | confirmed=${report.confirmed.length} avg/session=${average(report.perSession).toFixed(2)} | 15m positive=${report.horizons[15].positivePercent.toFixed(2)}% avg=${report.horizons[15].averagePercent.toFixed(2)}% median=${report.horizons[15].medianPercent.toFixed(2)}% | MFE=${report.avgMfe.toFixed(2)}% MAE=${report.avgMae.toFixed(2)}%`));
  [5, 10].forEach((minimum) => { console.log(`\nConfigurations with >=${minimum} confirmed opportunities/session`); const matches = reports.filter((report) => average(report.perSession) >= minimum); if (matches.length === 0) console.log('None.'); else matches.forEach((report) => console.log(`${report.config.name} | avg/session=${average(report.perSession).toFixed(2)} | 15m positive=${report.horizons[15].positivePercent.toFixed(2)}% avg=${report.horizons[15].averagePercent.toFixed(2)}% MFE=${report.avgMfe.toFixed(2)}% MAE=${report.avgMae.toFixed(2)}%`)); });
  if (failures.length > 0) console.log(`\nUnavailable option records: ${failures.length} (retained separately; no fabricated values).`);
  logger.info('Sideways option premium confirmation research completed', { rawOpportunities: raw.length, resolved: resolved.length, failures: failures.length, configurations: reports.length });
}

run().catch((error) => { logger.error('Sideways option premium confirmation research failed', { error }); console.error('Sideways option premium confirmation research failed.', error); process.exitCode = 1; });
