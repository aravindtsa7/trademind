import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandlesPerSession = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const horizons = [5, 10, 15, 30] as const;
const lookbacks = [6, 12, 18] as const;
const proximityThresholds = [0.05, 0.10, 0.15, 0.20, 0.25] as const;
const cooldowns = [0, 5, 10, 15] as const;
const qualityMinimumSampleSize = 30;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Direction = 'CE' | 'PE';
type Horizon = (typeof horizons)[number];

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}

interface SessionAnalysis {
  date: string;
  candles: Candle[];
  primaryRegimes: Array<AdaptivePrimaryMarketRegime | undefined>;
}

interface Opportunity {
  date: string;
  timestamp: Date;
  direction: Direction;
  movements: Partial<Record<Horizon, number>>;
  mfe?: number;
  mae?: number;
}

interface Configuration {
  lookback: number;
  proximityPercent: number;
  cooldownMinutes: number;
}

interface HorizonMetrics {
  positive: number;
  negative: number;
  neutral: number;
  accuracy: number;
  averageMovement: number;
  medianMovement: number;
}

interface TimeBucketMetrics {
  total: number;
  ce: number;
  pe: number;
  accuracy15m: number;
  average15m: number;
}

interface ConfigurationReport {
  config: Configuration;
  opportunities: Opportunity[];
  total: number;
  ce: number;
  pe: number;
  averagePerSession: number;
  medianPerSession: number;
  maximumPerSession: number;
  zeroOpportunitySessions: number;
  horizons: Record<Horizon, HorizonMetrics>;
  averageMfe: number;
  medianMfe: number;
  averageMae: number;
  medianMae: number;
  timeOfDay: Record<string, TimeBucketMetrics>;
}

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } {
  const values = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}

function isCompleteSession(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandlesPerSession) return false;
  const ordered = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = marketDateAndMinute(ordered[0].candleTime);
  const last = marketDateAndMinute(ordered[ordered.length - 1].candleTime);
  return first.minute === marketSessionStartMinute
    && last.minute === marketSessionEndMinute
    && ordered.every((candle, index) => index === 0 || candle.candleTime.getTime() - ordered[index - 1].candleTime.getTime() === 60_000);
}

function toInternalCandle(candle: StoredCandle): Candle {
  const volume = Number(candle.volume);
  const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
  if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
    throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
  }
  return { timestamp: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
}

function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  if (!indicator) throw new Error(`Missing ${type}${period} indicator result.`);
  const values = new Map<number, number>();
  indicator.result.values.forEach((entry) => {
    if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value);
  });
  return values;
}

function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> {
  const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14);
  if (!indicator) throw new Error('Missing ADX14 indicator result.');
  const values = new Map<number, AdxValue>();
  indicator.result.values.forEach((entry) => {
    if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date });
  });
  return values;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function accuracy(values: number[]): number {
  return values.length === 0 ? 0 : (values.filter((value) => value > 0).length / values.length) * 100;
}

function configurationId(config: Configuration): string {
  return `lookback=${config.lookback} proximity=${config.proximityPercent.toFixed(2)}% cooldown=${config.cooldownMinutes}m`;
}

function classifySessions(
  completeSessions: Array<[string, StoredCandle[]]>,
  aggregator: CandleTimeframeAggregatorService,
  engine: IndicatorEngineService,
  regimeService: AdaptiveMarketRegimeService
): SessionAnalysis[] {
  return completeSessions.map(([date, stored]) => {
    const candles = aggregator.aggregate(
      [...stored].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map(toInternalCandle),
      '5m'
    );
    const results = engine.calculate(candles, {
      indicators: [
        { type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 },
        { type: IndicatorType.RSI, period: 14 }, { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 },
      ],
    });
    const ema15 = scalarMap(results, IndicatorType.EMA, 15);
    const ema35 = scalarMap(results, IndicatorType.EMA, 35);
    const rsi14 = scalarMap(results, IndicatorType.RSI, 14);
    const atr14 = scalarMap(results, IndicatorType.ATR, 14);
    const adx14 = adxMap(results);
    const primaryRegimes = candles.map((candle) => {
      const key = candle.timestamp.getTime();
      const fast = ema15.get(key); const slow = ema35.get(key); const rsi = rsi14.get(key); const atr = atr14.get(key); const adx = adx14.get(key);
      if (fast === undefined || slow === undefined || rsi === undefined || atr === undefined || !adx) return undefined;
      return regimeService.classify({ timestamp: candle.timestamp, close: candle.close, ema15: fast, ema35: slow, rsi14: rsi, adx14: adx.adx, atr14: atr }).primaryRegime;
    });
    return { date, candles, primaryRegimes };
  });
}

function evaluateOpportunity(session: SessionAnalysis, index: number, direction: Direction): Opportunity {
  const candle = session.candles[index];
  const movements: Partial<Record<Horizon, number>> = {};
  horizons.forEach((horizon) => {
    const future = session.candles[index + horizon / 5];
    if (future) movements[horizon] = direction === 'CE' ? future.close - candle.close : candle.close - future.close;
  });
  const nextThirtyMinutes = session.candles.slice(index + 1, index + 7);
  const hasThirtyMinuteWindow = nextThirtyMinutes.length === 6;
  const maximumHigh = hasThirtyMinuteWindow ? Math.max(...nextThirtyMinutes.map((value) => value.high)) : undefined;
  const minimumLow = hasThirtyMinuteWindow ? Math.min(...nextThirtyMinutes.map((value) => value.low)) : undefined;
  return {
    date: session.date, timestamp: new Date(candle.timestamp.getTime()), direction, movements,
    mfe: maximumHigh === undefined || minimumLow === undefined ? undefined : Math.max(0, direction === 'CE' ? maximumHigh - candle.close : candle.close - minimumLow),
    mae: maximumHigh === undefined || minimumLow === undefined ? undefined : Math.max(0, direction === 'CE' ? candle.close - minimumLow : maximumHigh - candle.close),
  };
}

function collectOpportunities(sessions: readonly SessionAnalysis[], config: Configuration): Opportunity[] {
  const opportunities: Opportunity[] = [];
  sessions.forEach((session) => {
    let lastCeTimestamp: number | undefined;
    let lastPeTimestamp: number | undefined;
    session.candles.forEach((candle, index) => {
      if (session.primaryRegimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS || index < config.lookback) return;
      const prior = session.candles.slice(index - config.lookback, index);
      const support = Math.min(...prior.map((value) => value.low));
      const resistance = Math.max(...prior.map((value) => value.high));
      const supportDistancePercent = ((candle.close - support) / candle.close) * 100;
      const resistanceDistancePercent = ((resistance - candle.close) / candle.close) * 100;
      const timestamp = candle.timestamp.getTime();
      const cooldownMs = config.cooldownMinutes * 60_000;
      const nearSupport = supportDistancePercent >= 0 && supportDistancePercent <= config.proximityPercent;
      const nearResistance = resistanceDistancePercent >= 0 && resistanceDistancePercent <= config.proximityPercent;
      if (nearSupport && (lastCeTimestamp === undefined || timestamp - lastCeTimestamp >= cooldownMs)) {
        opportunities.push(evaluateOpportunity(session, index, 'CE'));
        lastCeTimestamp = timestamp;
      }
      if (nearResistance && (lastPeTimestamp === undefined || timestamp - lastPeTimestamp >= cooldownMs)) {
        opportunities.push(evaluateOpportunity(session, index, 'PE'));
        lastPeTimestamp = timestamp;
      }
    });
  });
  return opportunities.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function createHorizonMetrics(opportunities: readonly Opportunity[], horizon: Horizon): HorizonMetrics {
  const values = opportunities.flatMap((opportunity) => {
    const value = opportunity.movements[horizon];
    return value === undefined ? [] : [value];
  });
  return {
    positive: values.filter((value) => value > 0).length,
    negative: values.filter((value) => value < 0).length,
    neutral: values.filter((value) => value === 0).length,
    accuracy: accuracy(values), averageMovement: average(values), medianMovement: median(values),
  };
}

function getTimeBucket(timestamp: Date): string {
  const minute = marketDateAndMinute(timestamp).minute;
  if (minute < 10 * 60 + 30) return '09:15-10:30';
  if (minute < 12 * 60) return '10:30-12:00';
  if (minute < 13 * 60 + 30) return '12:00-13:30';
  return '13:30-15:30';
}

function reportFor(config: Configuration, sessions: readonly SessionAnalysis[]): ConfigurationReport {
  const opportunities = collectOpportunities(sessions, config);
  const perSession = new Map(sessions.map((session) => [session.date, 0]));
  opportunities.forEach((opportunity) => perSession.set(opportunity.date, (perSession.get(opportunity.date) ?? 0) + 1));
  const perSessionCounts = Array.from(perSession.values());
  const timeBucketNames = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'];
  const timeOfDay = Object.fromEntries(timeBucketNames.map((bucket) => [bucket, { total: 0, ce: 0, pe: 0, accuracy15m: 0, average15m: 0 }])) as Record<string, TimeBucketMetrics>;
  timeBucketNames.forEach((bucket) => {
    const entries = opportunities.filter((opportunity) => getTimeBucket(opportunity.timestamp) === bucket);
    const fifteenMinuteValues = entries.flatMap((opportunity) => opportunity.movements[15] === undefined ? [] : [opportunity.movements[15] as number]);
    timeOfDay[bucket] = { total: entries.length, ce: entries.filter((entry) => entry.direction === 'CE').length, pe: entries.filter((entry) => entry.direction === 'PE').length, accuracy15m: accuracy(fifteenMinuteValues), average15m: average(fifteenMinuteValues) };
  });
  const mfe = opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe]);
  const mae = opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae]);
  return {
    config, opportunities, total: opportunities.length, ce: opportunities.filter((entry) => entry.direction === 'CE').length, pe: opportunities.filter((entry) => entry.direction === 'PE').length,
    averagePerSession: average(perSessionCounts), medianPerSession: median(perSessionCounts), maximumPerSession: Math.max(0, ...perSessionCounts), zeroOpportunitySessions: perSessionCounts.filter((count) => count === 0).length,
    horizons: { 5: createHorizonMetrics(opportunities, 5), 10: createHorizonMetrics(opportunities, 10), 15: createHorizonMetrics(opportunities, 15), 30: createHorizonMetrics(opportunities, 30) },
    averageMfe: average(mfe), medianMfe: median(mfe), averageMae: average(mae), medianMae: median(mae), timeOfDay,
  };
}

function printReport(report: ConfigurationReport): void {
  console.log(`\n${configurationId(report.config)}`);
  console.log(`opportunities=${report.total} CE=${report.ce} PE=${report.pe} avg/session=${report.averagePerSession.toFixed(2)} median/session=${report.medianPerSession.toFixed(2)} max/session=${report.maximumPerSession} zero-sessions=${report.zeroOpportunitySessions}`);
  horizons.forEach((horizon) => {
    const metrics = report.horizons[horizon];
    console.log(`+${horizon}m: positive=${metrics.positive} negative=${metrics.negative} neutral=${metrics.neutral} accuracy=${metrics.accuracy.toFixed(2)}% avg=${metrics.averageMovement.toFixed(2)} median=${metrics.medianMovement.toFixed(2)}`);
  });
  console.log(`MFE avg=${report.averageMfe.toFixed(2)} median=${report.medianMfe.toFixed(2)} | MAE avg=${report.averageMae.toFixed(2)} median=${report.medianMae.toFixed(2)}`);
  Object.entries(report.timeOfDay).forEach(([bucket, metrics]) => console.log(`${bucket}: opportunities=${metrics.total} CE=${metrics.ce} PE=${metrics.pe} 15m accuracy=${metrics.accuracy15m.toFixed(2)}% avg15m=${metrics.average15m.toFixed(2)}`));
}

function printRanking(title: string, reports: readonly ConfigurationReport[]): void {
  console.log(`\n${title}`);
  reports.slice(0, 10).forEach((report, index) => {
    console.log(`${index + 1}. ${configurationId(report.config)} | avg/session=${report.averagePerSession.toFixed(2)} | total=${report.total} | 15m accuracy=${report.horizons[15].accuracy.toFixed(2)}% | avg15m=${report.horizons[15].averageMovement.toFixed(2)} | MFE=${report.averageMfe.toFixed(2)} | MAE=${report.averageMae.toFixed(2)}`);
  });
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const engine = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });
  logger.info('Starting sideways swing opportunity research', { instrumentKey, sourceTimeframe });

  const stored = await repository.findByInstrumentAndTimeframe(instrumentKey, sourceTimeframe) as StoredCandle[];
  const byDate = new Map<string, StoredCandle[]>();
  stored.forEach((candle) => { const date = marketDateAndMinute(candle.candleTime).date; const session = byDate.get(date) ?? []; session.push(candle); byDate.set(date, session); });
  const completeSessions = Array.from(byDate.entries()).filter(([, candles]) => isCompleteSession(candles)).sort(([left], [right]) => left.localeCompare(right));
  if (completeSessions.length === 0) throw new Error(`No complete NIFTY sessions are stored for ${instrumentKey}.`);
  const sessions = classifySessions(completeSessions, aggregator, engine, regimeService);
  const reports = lookbacks.flatMap((lookback) => proximityThresholds.flatMap((proximityPercent) => cooldowns.map((cooldownMinutes) => reportFor({ lookback, proximityPercent, cooldownMinutes }, sessions))));

  console.log(`Instrument: ${instrumentKey}`);
  console.log(`Complete sessions: ${sessions.length}`);
  console.log(`Regime config: ADX>=20, EMA proximity<=0.05%, high ATR%=0.10%, low ATR%=0.05%`);
  console.log(`Tested configurations: ${reports.length}; quality minimum sample: ${qualityMinimumSampleSize} opportunities.`);
  reports.forEach(printReport);

  const frequencyRanking = [...reports].sort((left, right) => right.averagePerSession - left.averagePerSession || right.total - left.total);
  const qualityRanking = reports.filter((report) => report.total >= qualityMinimumSampleSize).sort((left, right) =>
    right.horizons[15].accuracy - left.horizons[15].accuracy || right.horizons[15].averageMovement - left.horizons[15].averageMovement || right.averageMfe - left.averageMfe || left.averageMae - right.averageMae
  );
  printRanking('FREQUENCY ranking (highest average opportunities/session)', frequencyRanking);
  printRanking(`QUALITY ranking (minimum ${qualityMinimumSampleSize} opportunities)`, qualityRanking);

  [5, 10, 15].forEach((threshold) => {
    console.log(`\nConfigurations with >= ${threshold} opportunities/session`);
    const matches = frequencyRanking.filter((report) => report.averagePerSession >= threshold);
    if (matches.length === 0) console.log('None.');
    else matches.forEach((report) => console.log(`${configurationId(report.config)} | avg/session=${report.averagePerSession.toFixed(2)} | 15m accuracy=${report.horizons[15].accuracy.toFixed(2)}% | avg15m=${report.horizons[15].averageMovement.toFixed(2)} | MFE=${report.averageMfe.toFixed(2)} | MAE=${report.averageMae.toFixed(2)}`));
  });
  logger.info('Sideways swing opportunity research completed', { completeSessions: sessions.length, configurations: reports.length });
}

run().catch((error) => {
  logger.error('Sideways swing opportunity research failed', { error });
  console.error('Sideways swing opportunity research failed.', error);
  process.exitCode = 1;
});
