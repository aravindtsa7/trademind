import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { AdxValue } from '../modules/indicators/indicators/adx.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandlesPerSession = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const proximities = [0.05, 0.10, 0.15, 0.20, 0.25] as const;
const cooldowns = [0, 5, 10, 15] as const;
const horizons = [5, 10, 15, 30] as const;
const qualityMinimumSampleSize = 30;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Setup = 'PULLBACK_EMA15' | 'PULLBACK_EMA35' | 'CONTINUATION_3' | 'CONTINUATION_6';
type Proximity = (typeof proximities)[number];
type Horizon = (typeof horizons)[number];
type RsiFilter = 'NO_RSI_FILTER' | 'RSI_LT_50' | 'RSI_LT_45' | 'RSI_LT_40' | 'RSI_LT_35';

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}

interface Session {
  date: string;
  candles: Candle[];
  regimes: Array<AdaptivePrimaryMarketRegime | undefined>;
  ema15: Map<number, number>;
  ema35: Map<number, number>;
  rsi14: Map<number, number>;
}

interface Config {
  setup: Setup;
  proximity?: Proximity;
  rsiFilter: RsiFilter;
  cooldown: number;
}

interface Opportunity {
  date: string;
  timestamp: Date;
  setup: Setup;
  close: number;
  movements: Partial<Record<Horizon, number>>;
  mfe?: number;
  mae?: number;
}

interface HorizonMetric {
  positive: number;
  negative: number;
  neutral: number;
  accuracy: number;
  average: number;
  median: number;
}

interface TimeMetric {
  total: number;
  accuracy15: number;
  average15: number;
}

interface Report {
  config: Config;
  opportunities: Opportunity[];
  perSession: number[];
  horizons: Record<Horizon, HorizonMetric>;
  averageMfe: number;
  medianMfe: number;
  averageMae: number;
  medianMae: number;
  time: Record<string, TimeMetric>;
}

const pullbackSetups: readonly Setup[] = ['PULLBACK_EMA15', 'PULLBACK_EMA35'];
const continuationSetups: readonly Setup[] = ['CONTINUATION_3', 'CONTINUATION_6'];
const rsiFilters: readonly RsiFilter[] = ['NO_RSI_FILTER', 'RSI_LT_50', 'RSI_LT_45', 'RSI_LT_40', 'RSI_LT_35'];
const timeBuckets = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'] as const;

function marketDateAndMinute(timestamp: Date): { date: string; minute: number } {
  const parts = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
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

function toCandle(candle: StoredCandle): Candle {
  const volume = Number(candle.volume);
  const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
  if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
    throw new Error('Stored volume or open interest exceeds JavaScript safe-integer precision.');
  }
  return {
    timestamp: new Date(candle.candleTime.getTime()),
    open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest,
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function scalarMap(results: IndicatorEngineResult, type: IndicatorType, period: number): Map<number, number> {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  if (!indicator) throw new Error(`Missing ${type}${period}.`);
  const values = new Map<number, number>();
  indicator.result.values.forEach((entry) => {
    if ('value' in entry && typeof entry.value === 'number') values.set(entry.timestamp.getTime(), entry.value);
  });
  return values;
}

function adxMap(results: IndicatorEngineResult): Map<number, AdxValue> {
  const indicator = results.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14);
  if (!indicator) throw new Error('Missing ADX14.');
  const values = new Map<number, AdxValue>();
  indicator.result.values.forEach((entry) => {
    if ('adx' in entry && 'plusDI' in entry && 'minusDI' in entry) values.set(entry.timestamp.getTime(), entry as AdxValue & { timestamp: Date });
  });
  return values;
}

function prepareSessions(
  rawSessions: Array<[string, StoredCandle[]]>,
  aggregator: CandleTimeframeAggregatorService,
  engine: IndicatorEngineService,
  regimeService: AdaptiveMarketRegimeService,
): Session[] {
  return rawSessions.map(([date, stored]) => {
    const candles = aggregator.aggregate(
      [...stored].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map(toCandle),
      '5m',
    );
    const indicators = engine.calculate(candles, {
      indicators: [
        { type: IndicatorType.EMA, period: 15 },
        { type: IndicatorType.EMA, period: 35 },
        { type: IndicatorType.RSI, period: 14 },
        { type: IndicatorType.ADX, period: 14 },
        { type: IndicatorType.ATR, period: 14 },
      ],
    });
    const ema15 = scalarMap(indicators, IndicatorType.EMA, 15);
    const ema35 = scalarMap(indicators, IndicatorType.EMA, 35);
    const rsi14 = scalarMap(indicators, IndicatorType.RSI, 14);
    const adx14 = adxMap(indicators);
    const atr14 = scalarMap(indicators, IndicatorType.ATR, 14);
    const regimes = candles.map((candle) => {
      const key = candle.timestamp.getTime();
      const fast = ema15.get(key);
      const slow = ema35.get(key);
      const rsi = rsi14.get(key);
      const adx = adx14.get(key);
      const atr = atr14.get(key);
      if (fast === undefined || slow === undefined || rsi === undefined || !adx || atr === undefined) return undefined;
      return regimeService.classify({ timestamp: candle.timestamp, close: candle.close, ema15: fast, ema35: slow, rsi14: rsi, adx14: adx.adx, atr14: atr }).primaryRegime;
    });
    return { date, candles, regimes, ema15, ema35, rsi14 };
  });
}

function rsiThreshold(filter: RsiFilter): number | undefined {
  if (filter === 'NO_RSI_FILTER') return undefined;
  return Number(filter.replace('RSI_LT_', ''));
}

function evaluateOpportunity(session: Session, index: number, setup: Setup): Opportunity {
  const signal = session.candles[index];
  const movements: Partial<Record<Horizon, number>> = {};
  horizons.forEach((horizon) => {
    const future = session.candles[index + horizon / 5];
    if (future) movements[horizon] = signal.close - future.close;
  });
  const futureThirty = session.candles.slice(index + 1, index + 7);
  const hasFullThirtyMinutes = futureThirty.length === 6;
  return {
    date: session.date,
    timestamp: new Date(signal.timestamp.getTime()),
    setup,
    close: signal.close,
    movements,
    mfe: hasFullThirtyMinutes ? Math.max(0, signal.close - Math.min(...futureThirty.map((candle) => candle.low))) : undefined,
    mae: hasFullThirtyMinutes ? Math.max(0, Math.max(...futureThirty.map((candle) => candle.high)) - signal.close) : undefined,
  };
}

function isPullbackOpportunity(session: Session, index: number, config: Config, ema15: number, ema35: number): boolean {
  if (config.proximity === undefined || !pullbackSetups.includes(config.setup)) return false;
  const candle = session.candles[index];
  const anchor = config.setup === 'PULLBACK_EMA15' ? ema15 : ema35;
  const distancePercent = Math.abs(candle.high - anchor) / anchor * 100;
  return candle.close < ema35 && distancePercent <= config.proximity && candle.close < anchor;
}

function isContinuationOpportunity(session: Session, index: number, config: Config): boolean {
  if (!continuationSetups.includes(config.setup)) return false;
  const lookback = config.setup === 'CONTINUATION_3' ? 3 : 6;
  if (index < lookback) return false;
  const recentLow = Math.min(...session.candles.slice(index - lookback, index).map((candle) => candle.low));
  return session.candles[index].close < recentLow;
}

function collect(sessions: readonly Session[], config: Config): Opportunity[] {
  const opportunities: Opportunity[] = [];
  sessions.forEach((session) => {
    let lastOpportunityTimestamp: number | undefined;
    session.candles.forEach((candle, index) => {
      if (session.regimes[index] !== AdaptivePrimaryMarketRegime.TREND_DOWN) return;
      const timestamp = candle.timestamp.getTime();
      const ema15 = session.ema15.get(timestamp);
      const ema35 = session.ema35.get(timestamp);
      const rsi = session.rsi14.get(timestamp);
      if (ema15 === undefined || ema35 === undefined || rsi === undefined) return;
      const threshold = rsiThreshold(config.rsiFilter);
      if (threshold !== undefined && rsi >= threshold) return;
      const setupMatches = isPullbackOpportunity(session, index, config, ema15, ema35) || isContinuationOpportunity(session, index, config);
      const cooldownMs = config.cooldown * 60_000;
      if (setupMatches && (lastOpportunityTimestamp === undefined || timestamp - lastOpportunityTimestamp >= cooldownMs)) {
        opportunities.push(evaluateOpportunity(session, index, config.setup));
        lastOpportunityTimestamp = timestamp;
      }
    });
  });
  return opportunities.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function horizonMetric(opportunities: readonly Opportunity[], horizon: Horizon): HorizonMetric {
  const values = opportunities.flatMap((opportunity) => opportunity.movements[horizon] === undefined ? [] : [opportunity.movements[horizon] as number]);
  return {
    positive: values.filter((value) => value > 0).length,
    negative: values.filter((value) => value < 0).length,
    neutral: values.filter((value) => value === 0).length,
    accuracy: values.length === 0 ? 0 : values.filter((value) => value > 0).length / values.length * 100,
    average: average(values),
    median: median(values),
  };
}

function bucket(timestamp: Date): string {
  const minute = marketDateAndMinute(timestamp).minute;
  if (minute < 10 * 60 + 30) return '09:15-10:30';
  if (minute < 12 * 60) return '10:30-12:00';
  if (minute < 13 * 60 + 30) return '12:00-13:30';
  return '13:30-15:30';
}

function createReport(config: Config, sessions: readonly Session[]): Report {
  const opportunities = collect(sessions, config);
  const perSession = sessions.map((session) => opportunities.filter((opportunity) => opportunity.date === session.date).length);
  const time = Object.fromEntries(timeBuckets.map((name) => [name, { total: 0, accuracy15: 0, average15: 0 }])) as Record<string, TimeMetric>;
  timeBuckets.forEach((name) => {
    const entries = opportunities.filter((opportunity) => bucket(opportunity.timestamp) === name);
    const metric = horizonMetric(entries, 15);
    time[name] = { total: entries.length, accuracy15: metric.accuracy, average15: metric.average };
  });
  return {
    config,
    opportunities,
    perSession,
    horizons: { 5: horizonMetric(opportunities, 5), 10: horizonMetric(opportunities, 10), 15: horizonMetric(opportunities, 15), 30: horizonMetric(opportunities, 30) },
    averageMfe: average(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    medianMfe: median(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    averageMae: average(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
    medianMae: median(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
    time,
  };
}

function configName(config: Config): string {
  const proximity = config.proximity === undefined ? '' : ` proximity=${config.proximity.toFixed(2)}%`;
  return `${config.setup}${proximity} ${config.rsiFilter} cooldown=${config.cooldown}m`;
}

function printReport(report: Report): void {
  console.log(`${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} median/session=${median(report.perSession).toFixed(2)} max/session=${Math.max(0, ...report.perSession)} zero=${report.perSession.filter((value) => value === 0).length} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} | MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`);
}

function printDetailed(label: string, report: Report): void {
  console.log(`\n${label}: ${configName(report.config)} | sample=${report.opportunities.length}`);
  horizons.forEach((horizon) => {
    const metric = report.horizons[horizon];
    console.log(`+${horizon}m positive=${metric.positive} negative=${metric.negative} neutral=${metric.neutral} accuracy=${metric.accuracy.toFixed(2)}% avg=${metric.average.toFixed(2)} median=${metric.median.toFixed(2)}`);
  });
  console.log(`MFE avg=${report.averageMfe.toFixed(2)} median=${report.medianMfe.toFixed(2)} | MAE avg=${report.averageMae.toFixed(2)} median=${report.medianMae.toFixed(2)}`);
  Object.entries(report.time).forEach(([name, metric]) => console.log(`${name}: opportunities=${metric.total} 15m=${metric.accuracy15.toFixed(2)}% avg15=${metric.average15.toFixed(2)}`));
}

function rankQuality(left: Report, right: Report): number {
  return right.horizons[15].accuracy - left.horizons[15].accuracy
    || right.horizons[15].average - left.horizons[15].average
    || right.horizons[15].median - left.horizons[15].median
    || right.averageMfe - left.averageMfe
    || left.averageMae - right.averageMae;
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const engine = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });
  logger.info('Starting TREND_DOWN PE opportunity research', { instrumentKey, sourceTimeframe });

  const stored = await repository.findByInstrumentAndTimeframe(instrumentKey, sourceTimeframe) as StoredCandle[];
  const grouped = new Map<string, StoredCandle[]>();
  stored.forEach((candle) => {
    const date = marketDateAndMinute(candle.candleTime).date;
    const candles = grouped.get(date) ?? [];
    candles.push(candle);
    grouped.set(date, candles);
  });
  const complete = Array.from(grouped.entries()).filter(([, candles]) => isCompleteSession(candles)).sort(([left], [right]) => left.localeCompare(right));
  if (complete.length === 0) throw new Error('No complete NIFTY sessions are stored.');

  const sessions = prepareSessions(complete, aggregator, engine, regimeService);
  const pullbackReports = pullbackSetups.flatMap((setup) => proximities.flatMap((proximity) => rsiFilters.flatMap((rsiFilter) => cooldowns.map((cooldown) => createReport({ setup, proximity, rsiFilter, cooldown }, sessions)))));
  const continuationReports = continuationSetups.flatMap((setup) => rsiFilters.flatMap((rsiFilter) => cooldowns.map((cooldown) => createReport({ setup, rsiFilter, cooldown }, sessions))));
  const reports = [...pullbackReports, ...continuationReports];

  console.log(`Instrument=${instrumentKey} complete sessions=${sessions.length} configurations=${reports.length}`);
  console.log('Frozen regime: ADX>=20, EMA proximity<=0.05%, ATR high=0.10%, ATR low=0.05%.');
  console.log('\nAll configuration summaries');
  reports.forEach(printReport);

  const frequency = [...reports].sort((left, right) => average(right.perSession) - average(left.perSession) || right.opportunities.length - left.opportunities.length);
  const quality = reports.filter((report) => report.opportunities.length >= qualityMinimumSampleSize).sort(rankQuality);
  const balanced = reports.filter((report) => average(report.perSession) >= 2 && report.opportunities.length >= qualityMinimumSampleSize).sort(rankQuality);
  console.log('\nFREQUENCY ranking');
  frequency.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)}`));
  console.log(`\nQUALITY ranking (minimum ${qualityMinimumSampleSize} opportunities)`);
  quality.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`));
  console.log('\nBALANCED ranking (>=2 opportunities/session; minimum 30 opportunities)');
  balanced.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`));
  console.log('\nSETUP SPLIT');
  (['PULLBACK_EMA15', 'PULLBACK_EMA35', 'CONTINUATION_3', 'CONTINUATION_6'] as const).forEach((setup) => {
    const matching = reports.filter((report) => report.config.setup === setup);
    const topFrequency = [...matching].sort((left, right) => average(right.perSession) - average(left.perSession))[0];
    const topQuality = matching.filter((report) => report.opportunities.length >= qualityMinimumSampleSize).sort(rankQuality)[0];
    if (topFrequency) console.log(`${setup} frequency: ${configName(topFrequency.config)} | sample=${topFrequency.opportunities.length} avg/session=${average(topFrequency.perSession).toFixed(2)} 15m=${topFrequency.horizons[15].accuracy.toFixed(2)}% avg=${topFrequency.horizons[15].average.toFixed(2)}`);
    if (topQuality) console.log(`${setup} quality: ${configName(topQuality.config)} | sample=${topQuality.opportunities.length} avg/session=${average(topQuality.perSession).toFixed(2)} 15m=${topQuality.horizons[15].accuracy.toFixed(2)}% avg=${topQuality.horizons[15].average.toFixed(2)}`);
  });
  [3, 5, 10].forEach((minimum) => {
    const matches = frequency.filter((report) => average(report.perSession) >= minimum);
    console.log(`\nConfigurations >=${minimum} opportunities/session: ${matches.length}`);
    matches.slice(0, 20).forEach((report) => console.log(`${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)}`));
  });
  if (frequency[0]) printDetailed('Highest frequency', frequency[0]);
  if (quality[0]) printDetailed('Highest quality', quality[0]);
  if (balanced[0]) printDetailed('Best balanced', balanced[0]);
  logger.info('TREND_DOWN PE opportunity research completed', { completeSessions: sessions.length, configurations: reports.length });
}

run().catch((error) => {
  logger.error('TREND_DOWN PE opportunity research failed', { error });
  console.error('TREND_DOWN PE opportunity research failed.', error);
  process.exitCode = 1;
});
