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
const lookbacks = [6, 12, 18] as const;
const cooldowns = [0, 5, 10, 15] as const;
const horizons = [5, 10, 15, 30] as const;
const qualityMinimumSampleSize = 30;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Lookback = (typeof lookbacks)[number];
type Direction = 'CE' | 'PE';
type Horizon = (typeof horizons)[number];
type RejectionStrength = 'BASIC' | 'CLOSE_BACK_0_05' | 'CLOSE_BACK_0_10';
type RsiFilter = 'NO_RSI_FILTER' | 'RSI_45_55' | 'RSI_40_60' | 'RSI_35_65';

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
  rsi14: Map<number, number>;
}

interface Config {
  lookback: Lookback;
  rejectionStrength: RejectionStrength;
  rsiFilter: RsiFilter;
  cooldown: number;
}

interface Opportunity {
  date: string;
  timestamp: Date;
  direction: Direction;
  close: number;
  rangeBoundary: number;
  wickPercent: number;
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
  ce: number;
  pe: number;
  accuracy15: number;
  average15: number;
}

interface Report {
  config: Config;
  opportunities: Opportunity[];
  perSession: number[];
  horizons: Record<Horizon, HorizonMetric>;
  averageWickPercent: number;
  medianWickPercent: number;
  averageMfe: number;
  medianMfe: number;
  averageMae: number;
  medianMae: number;
  time: Record<string, TimeMetric>;
}

const rejectionStrengths: readonly RejectionStrength[] = ['BASIC', 'CLOSE_BACK_0_05', 'CLOSE_BACK_0_10'];
const rsiFilters: readonly RsiFilter[] = ['NO_RSI_FILTER', 'RSI_45_55', 'RSI_40_60', 'RSI_35_65'];
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
    return { date, candles, regimes, rsi14 };
  });
}

function passesRsiFilter(filter: RsiFilter, direction: Direction, rsi: number): boolean {
  if (filter === 'NO_RSI_FILTER') return true;
  const [lower, upper] = filter === 'RSI_45_55' ? [45, 55] : filter === 'RSI_40_60' ? [40, 60] : [35, 65];
  return direction === 'CE' ? rsi <= lower : rsi >= upper;
}

function meetsRejectionStrength(close: number, boundary: number, direction: Direction, strength: RejectionStrength): boolean {
  if (strength === 'BASIC') return direction === 'CE' ? close > boundary : close < boundary;
  const offset = strength === 'CLOSE_BACK_0_05' ? 0.0005 : 0.001;
  return direction === 'CE' ? close >= boundary * (1 + offset) : close <= boundary * (1 - offset);
}

function calculateWickPercent(candle: Candle, direction: Direction): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const wick = direction === 'CE' ? Math.min(candle.open, candle.close) - candle.low : candle.high - Math.max(candle.open, candle.close);
  return (Math.max(0, wick) / range) * 100;
}

function evaluateOpportunity(session: Session, index: number, direction: Direction, rangeBoundary: number): Opportunity {
  const signal = session.candles[index];
  const movements: Partial<Record<Horizon, number>> = {};
  horizons.forEach((horizon) => {
    const future = session.candles[index + horizon / 5];
    if (future) movements[horizon] = direction === 'CE' ? future.close - signal.close : signal.close - future.close;
  });
  const futureThirty = session.candles.slice(index + 1, index + 7);
  const hasFullThirtyMinutes = futureThirty.length === 6;
  return {
    date: session.date,
    timestamp: new Date(signal.timestamp.getTime()),
    direction,
    close: signal.close,
    rangeBoundary,
    wickPercent: calculateWickPercent(signal, direction),
    movements,
    mfe: hasFullThirtyMinutes ? Math.max(0, direction === 'CE'
      ? Math.max(...futureThirty.map((candle) => candle.high)) - signal.close
      : signal.close - Math.min(...futureThirty.map((candle) => candle.low))) : undefined,
    mae: hasFullThirtyMinutes ? Math.max(0, direction === 'CE'
      ? signal.close - Math.min(...futureThirty.map((candle) => candle.low))
      : Math.max(...futureThirty.map((candle) => candle.high)) - signal.close) : undefined,
  };
}

function collect(sessions: readonly Session[], config: Config): Opportunity[] {
  const opportunities: Opportunity[] = [];
  sessions.forEach((session) => {
    let lastCeTimestamp: number | undefined;
    let lastPeTimestamp: number | undefined;
    session.candles.forEach((candle, index) => {
      if (index < config.lookback || session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS) return;
      const rsi = session.rsi14.get(candle.timestamp.getTime());
      if (rsi === undefined) return;
      const previous = session.candles.slice(index - config.lookback, index);
      const recentHigh = Math.max(...previous.map((entry) => entry.high));
      const recentLow = Math.min(...previous.map((entry) => entry.low));
      const timestamp = candle.timestamp.getTime();
      const cooldownMs = config.cooldown * 60_000;

      const failedDownsideBreak = candle.low < recentLow
        && meetsRejectionStrength(candle.close, recentLow, 'CE', config.rejectionStrength)
        && passesRsiFilter(config.rsiFilter, 'CE', rsi);
      if (failedDownsideBreak && (lastCeTimestamp === undefined || timestamp - lastCeTimestamp >= cooldownMs)) {
        opportunities.push(evaluateOpportunity(session, index, 'CE', recentLow));
        lastCeTimestamp = timestamp;
      }

      const failedUpsideBreak = candle.high > recentHigh
        && meetsRejectionStrength(candle.close, recentHigh, 'PE', config.rejectionStrength)
        && passesRsiFilter(config.rsiFilter, 'PE', rsi);
      if (failedUpsideBreak && (lastPeTimestamp === undefined || timestamp - lastPeTimestamp >= cooldownMs)) {
        opportunities.push(evaluateOpportunity(session, index, 'PE', recentHigh));
        lastPeTimestamp = timestamp;
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
    accuracy: values.length === 0 ? 0 : (values.filter((value) => value > 0).length / values.length) * 100,
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
  const time = Object.fromEntries(timeBuckets.map((name) => [name, { total: 0, ce: 0, pe: 0, accuracy15: 0, average15: 0 }])) as Record<string, TimeMetric>;
  timeBuckets.forEach((name) => {
    const entries = opportunities.filter((opportunity) => bucket(opportunity.timestamp) === name);
    const metric = horizonMetric(entries, 15);
    time[name] = {
      total: entries.length,
      ce: entries.filter((entry) => entry.direction === 'CE').length,
      pe: entries.filter((entry) => entry.direction === 'PE').length,
      accuracy15: metric.accuracy,
      average15: metric.average,
    };
  });
  return {
    config,
    opportunities,
    perSession,
    horizons: { 5: horizonMetric(opportunities, 5), 10: horizonMetric(opportunities, 10), 15: horizonMetric(opportunities, 15), 30: horizonMetric(opportunities, 30) },
    averageWickPercent: average(opportunities.map((opportunity) => opportunity.wickPercent)),
    medianWickPercent: median(opportunities.map((opportunity) => opportunity.wickPercent)),
    averageMfe: average(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    medianMfe: median(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    averageMae: average(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
    medianMae: median(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
    time,
  };
}

function configName(config: Config): string {
  return `lookback=${config.lookback} (${config.lookback * 5}m) ${config.rejectionStrength} ${config.rsiFilter} cooldown=${config.cooldown}m`;
}

function printReport(report: Report): void {
  const ce = report.opportunities.filter((opportunity) => opportunity.direction === 'CE').length;
  const pe = report.opportunities.length - ce;
  console.log(`${configName(report.config)} | total=${report.opportunities.length} CE=${ce} PE=${pe} avg/session=${average(report.perSession).toFixed(2)} median/session=${median(report.perSession).toFixed(2)} max/session=${Math.max(0, ...report.perSession)} zero=${report.perSession.filter((value) => value === 0).length} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} | wick=${report.averageWickPercent.toFixed(2)}% MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`);
}

function printDetailed(label: string, report: Report): void {
  console.log(`\n${label}: ${configName(report.config)} | sample=${report.opportunities.length}`);
  horizons.forEach((horizon) => {
    const metric = report.horizons[horizon];
    console.log(`+${horizon}m positive=${metric.positive} negative=${metric.negative} neutral=${metric.neutral} accuracy=${metric.accuracy.toFixed(2)}% avg=${metric.average.toFixed(2)} median=${metric.median.toFixed(2)}`);
  });
  (['CE', 'PE'] as const).forEach((direction) => {
    const opportunities = report.opportunities.filter((opportunity) => opportunity.direction === direction);
    const metric = horizonMetric(opportunities, 15);
    console.log(`${direction} at +15m: opportunities=${opportunities.length} accuracy=${metric.accuracy.toFixed(2)}% avg=${metric.average.toFixed(2)} median=${metric.median.toFixed(2)}`);
  });
  console.log(`Wick avg=${report.averageWickPercent.toFixed(2)}% median=${report.medianWickPercent.toFixed(2)}% | MFE avg=${report.averageMfe.toFixed(2)} median=${report.medianMfe.toFixed(2)} | MAE avg=${report.averageMae.toFixed(2)} median=${report.medianMae.toFixed(2)}`);
  Object.entries(report.time).forEach(([name, metric]) => console.log(`${name}: opportunities=${metric.total} CE=${metric.ce} PE=${metric.pe} 15m=${metric.accuracy15.toFixed(2)}% avg15=${metric.average15.toFixed(2)}`));
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const engine = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });
  logger.info('Starting sideways false-breakout reversal research', { instrumentKey, sourceTimeframe });

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
  const reports = lookbacks.flatMap((lookback) => rejectionStrengths.flatMap((rejectionStrength) => rsiFilters.flatMap((rsiFilter) => cooldowns.map((cooldown) => createReport({ lookback, rejectionStrength, rsiFilter, cooldown }, sessions)))));

  console.log(`Instrument=${instrumentKey} complete sessions=${sessions.length} configurations=${reports.length}`);
  console.log('Frozen regime: ADX>=20, EMA proximity<=0.05%, ATR high=0.10%, ATR low=0.05%.');
  console.log('\nAll configuration summaries');
  reports.forEach(printReport);

  const frequency = [...reports].sort((left, right) => average(right.perSession) - average(left.perSession) || right.opportunities.length - left.opportunities.length);
  const rankQuality = (left: Report, right: Report): number => right.horizons[15].accuracy - left.horizons[15].accuracy
    || right.horizons[15].average - left.horizons[15].average
    || right.horizons[15].median - left.horizons[15].median
    || right.averageMfe - left.averageMfe
    || left.averageMae - right.averageMae;
  const quality = reports.filter((report) => report.opportunities.length >= qualityMinimumSampleSize).sort(rankQuality);
  const balanced = reports.filter((report) => average(report.perSession) >= 2 && report.opportunities.length >= qualityMinimumSampleSize).sort(rankQuality);

  console.log('\nFREQUENCY ranking');
  frequency.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)}`));
  console.log(`\nQUALITY ranking (minimum ${qualityMinimumSampleSize} opportunities)`);
  quality.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`));
  console.log('\nBALANCED ranking (>=2 opportunities/session; minimum 30 opportunities)');
  balanced.slice(0, 10).forEach((report, index) => console.log(`${index + 1}. ${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} | 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)} median=${report.horizons[15].median.toFixed(2)} MFE=${report.averageMfe.toFixed(2)} MAE=${report.averageMae.toFixed(2)}`));
  [3, 5, 10].forEach((minimum) => {
    const matches = frequency.filter((report) => average(report.perSession) >= minimum);
    console.log(`\nConfigurations >=${minimum} opportunities/session: ${matches.length}`);
    matches.slice(0, 20).forEach((report) => console.log(`${configName(report.config)} | total=${report.opportunities.length} avg/session=${average(report.perSession).toFixed(2)} 15m=${report.horizons[15].accuracy.toFixed(2)}% avg=${report.horizons[15].average.toFixed(2)}`));
  });
  if (frequency[0]) printDetailed('Highest frequency', frequency[0]);
  if (quality[0]) printDetailed('Highest quality', quality[0]);
  if (balanced[0]) printDetailed('Best balanced', balanced[0]);
  logger.info('Sideways false-breakout reversal research completed', { completeSessions: sessions.length, configurations: reports.length });
}

run().catch((error) => {
  logger.error('Sideways false-breakout reversal research failed', { error });
  console.error('Sideways false-breakout reversal research failed.', error);
  process.exitCode = 1;
});
