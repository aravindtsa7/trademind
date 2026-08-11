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
const horizons = [5, 10, 15, 30] as const;
const globalCooldowns = [0, 5, 10] as const;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type Horizon = (typeof horizons)[number];
type SignalType = 'BUY_CE' | 'BUY_PE';
type SetupId = 'TREND_UP_CE_PULLBACK' | 'TREND_DOWN_PE_PULLBACK' | 'SIDEWAYS_SUPPORT_RESISTANCE' | 'SIDEWAYS_FALSE_BREAKOUT_PE';
type TimeBucket = '09:15-10:30' | '10:30-12:00' | '12:00-13:30' | '13:30-15:30';

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

interface RawOpportunity {
  tradingDate: string;
  timestamp: Date;
  primaryRegime: AdaptivePrimaryMarketRegime;
  setupId: SetupId;
  signalType: SignalType;
  close: number;
  reasons: string[];
  movements: Partial<Record<Horizon, number>>;
  mfe?: number;
  mae?: number;
}

interface ExecutableOpportunity extends Omit<RawOpportunity, 'setupId' | 'reasons'> {
  setupIds: SetupId[];
  reasons: string[];
}

interface HorizonMetric {
  positive: number;
  negative: number;
  neutral: number;
  accuracy: number;
  average: number;
  median: number;
}

interface QualityMetric {
  count: number;
  horizons: Record<Horizon, HorizonMetric>;
  averageMfe: number;
  medianMfe: number;
  averageMae: number;
  medianMae: number;
}

interface InventoryResult {
  cooldown: number;
  exactDeduped: ExecutableOpportunity[];
  conflicts: ExecutableOpportunity[];
  executable: ExecutableOpportunity[];
  globalCooldownFiltered: number;
}

const timeBuckets: readonly TimeBucket[] = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'];
const setupIds: readonly SetupId[] = ['TREND_UP_CE_PULLBACK', 'TREND_DOWN_PE_PULLBACK', 'SIDEWAYS_SUPPORT_RESISTANCE', 'SIDEWAYS_FALSE_BREAKOUT_PE'];

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

function createRawOpportunity(
  session: Session,
  index: number,
  primaryRegime: AdaptivePrimaryMarketRegime,
  setupId: SetupId,
  signalType: SignalType,
  reasons: string[],
): RawOpportunity {
  const signal = session.candles[index];
  const movements: Partial<Record<Horizon, number>> = {};
  horizons.forEach((horizon) => {
    const future = session.candles[index + horizon / 5];
    if (future) movements[horizon] = signalType === 'BUY_CE' ? future.close - signal.close : signal.close - future.close;
  });
  const futureThirty = session.candles.slice(index + 1, index + 7);
  const hasFullThirtyMinutes = futureThirty.length === 6;
  const upward = signalType === 'BUY_CE';
  return {
    tradingDate: session.date,
    timestamp: new Date(signal.timestamp.getTime()),
    primaryRegime,
    setupId,
    signalType,
    close: signal.close,
    reasons,
    movements,
    mfe: hasFullThirtyMinutes ? Math.max(0, upward
      ? Math.max(...futureThirty.map((candle) => candle.high)) - signal.close
      : signal.close - Math.min(...futureThirty.map((candle) => candle.low))) : undefined,
    mae: hasFullThirtyMinutes ? Math.max(0, upward
      ? signal.close - Math.min(...futureThirty.map((candle) => candle.low))
      : Math.max(...futureThirty.map((candle) => candle.high)) - signal.close) : undefined,
  };
}

function generateTrendUpPullbacks(session: Session): RawOpportunity[] {
  const opportunities: RawOpportunity[] = [];
  let lastTimestamp: number | undefined;
  session.candles.forEach((candle, index) => {
    if (session.regimes[index] !== AdaptivePrimaryMarketRegime.TREND_UP) return;
    const timestamp = candle.timestamp.getTime();
    const ema35 = session.ema35.get(timestamp);
    if (ema35 === undefined) return;
    const lowDistancePercent = Math.abs(candle.low - ema35) / ema35 * 100;
    if (candle.close > ema35 && lowDistancePercent <= 0.20 && (lastTimestamp === undefined || timestamp - lastTimestamp >= 10 * 60_000)) {
      opportunities.push(createRawOpportunity(session, index, AdaptivePrimaryMarketRegime.TREND_UP, 'TREND_UP_CE_PULLBACK', 'BUY_CE', ['TREND_UP', 'EMA35 pullback within 0.20%', 'close above EMA35']));
      lastTimestamp = timestamp;
    }
  });
  return opportunities;
}

function generateTrendDownPullbacks(session: Session): RawOpportunity[] {
  const opportunities: RawOpportunity[] = [];
  session.candles.forEach((candle, index) => {
    if (session.regimes[index] !== AdaptivePrimaryMarketRegime.TREND_DOWN) return;
    const timestamp = candle.timestamp.getTime();
    const ema35 = session.ema35.get(timestamp);
    const rsi = session.rsi14.get(timestamp);
    if (ema35 === undefined || rsi === undefined) return;
    const highDistancePercent = Math.abs(candle.high - ema35) / ema35 * 100;
    if (candle.close < ema35 && highDistancePercent <= 0.20 && rsi < 45) {
      opportunities.push(createRawOpportunity(session, index, AdaptivePrimaryMarketRegime.TREND_DOWN, 'TREND_DOWN_PE_PULLBACK', 'BUY_PE', ['TREND_DOWN', 'EMA35 pullback within 0.20%', 'RSI14 < 45', 'close below EMA35']));
    }
  });
  return opportunities;
}

function generateSidewaysSupportResistance(session: Session): RawOpportunity[] {
  const opportunities: RawOpportunity[] = [];
  let lastCeTimestamp: number | undefined;
  let lastPeTimestamp: number | undefined;
  session.candles.forEach((candle, index) => {
    if (index < 6 || session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS) return;
    const previous = session.candles.slice(index - 6, index);
    const support = Math.min(...previous.map((entry) => entry.low));
    const resistance = Math.max(...previous.map((entry) => entry.high));
    const timestamp = candle.timestamp.getTime();
    const supportDistancePercent = (candle.close - support) / candle.close * 100;
    const resistanceDistancePercent = (resistance - candle.close) / candle.close * 100;
    if (supportDistancePercent >= 0 && supportDistancePercent <= 0.10 && (lastCeTimestamp === undefined || timestamp - lastCeTimestamp >= 10 * 60_000)) {
      opportunities.push(createRawOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_SUPPORT_RESISTANCE', 'BUY_CE', ['SIDEWAYS', 'within 0.10% of 6-candle support']));
      lastCeTimestamp = timestamp;
    }
    if (resistanceDistancePercent >= 0 && resistanceDistancePercent <= 0.10 && (lastPeTimestamp === undefined || timestamp - lastPeTimestamp >= 10 * 60_000)) {
      opportunities.push(createRawOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_SUPPORT_RESISTANCE', 'BUY_PE', ['SIDEWAYS', 'within 0.10% of 6-candle resistance']));
      lastPeTimestamp = timestamp;
    }
  });
  return opportunities;
}

function generateSidewaysFalseBreakoutPe(session: Session): RawOpportunity[] {
  const opportunities: RawOpportunity[] = [];
  let lastTimestamp: number | undefined;
  session.candles.forEach((candle, index) => {
    if (index < 12 || session.regimes[index] !== AdaptivePrimaryMarketRegime.SIDEWAYS) return;
    const recentHigh = Math.max(...session.candles.slice(index - 12, index).map((entry) => entry.high));
    const timestamp = candle.timestamp.getTime();
    if (candle.high > recentHigh && candle.close < recentHigh && (lastTimestamp === undefined || timestamp - lastTimestamp >= 10 * 60_000)) {
      opportunities.push(createRawOpportunity(session, index, AdaptivePrimaryMarketRegime.SIDEWAYS, 'SIDEWAYS_FALSE_BREAKOUT_PE', 'BUY_PE', ['SIDEWAYS', '12-candle upside breakout failed', 'close returned below recent high']));
      lastTimestamp = timestamp;
    }
  });
  return opportunities;
}

function generateRawOpportunities(sessions: readonly Session[]): RawOpportunity[] {
  return sessions.flatMap((session) => [
    ...generateTrendUpPullbacks(session),
    ...generateTrendDownPullbacks(session),
    ...generateSidewaysSupportResistance(session),
    ...generateSidewaysFalseBreakoutPe(session),
  ]).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function mergeExactDuplicates(raw: readonly RawOpportunity[]): ExecutableOpportunity[] {
  const groups = new Map<string, RawOpportunity[]>();
  raw.forEach((opportunity) => {
    const key = `${opportunity.timestamp.getTime()}|${opportunity.signalType}`;
    const values = groups.get(key) ?? [];
    values.push(opportunity);
    groups.set(key, values);
  });
  return Array.from(groups.values()).map((values) => {
    const first = values[0];
    return {
      tradingDate: first.tradingDate,
      timestamp: new Date(first.timestamp.getTime()),
      primaryRegime: first.primaryRegime,
      signalType: first.signalType,
      close: first.close,
      setupIds: Array.from(new Set(values.map((value) => value.setupId))).sort() as SetupId[],
      reasons: Array.from(new Set(values.flatMap((value) => value.reasons))),
      movements: { ...first.movements },
      mfe: first.mfe,
      mae: first.mae,
    };
  }).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function buildInventory(raw: readonly RawOpportunity[], cooldown: number): InventoryResult {
  const exactDeduped = mergeExactDuplicates(raw);
  const timestampGroups = new Map<number, ExecutableOpportunity[]>();
  exactDeduped.forEach((opportunity) => {
    const values = timestampGroups.get(opportunity.timestamp.getTime()) ?? [];
    values.push(opportunity);
    timestampGroups.set(opportunity.timestamp.getTime(), values);
  });
  const conflicts = Array.from(timestampGroups.values()).filter((values) => new Set(values.map((value) => value.signalType)).size > 1).flat();
  const conflictTimestamps = new Set(conflicts.map((opportunity) => opportunity.timestamp.getTime()));
  const candidates = exactDeduped.filter((opportunity) => !conflictTimestamps.has(opportunity.timestamp.getTime()));
  const lastExecutedByDirection = new Map<SignalType, number>();
  let globalCooldownFiltered = 0;
  const executable = candidates.filter((opportunity) => {
    const lastTimestamp = lastExecutedByDirection.get(opportunity.signalType);
    if (lastTimestamp !== undefined && opportunity.timestamp.getTime() - lastTimestamp < cooldown * 60_000) {
      globalCooldownFiltered += 1;
      return false;
    }
    lastExecutedByDirection.set(opportunity.signalType, opportunity.timestamp.getTime());
    return true;
  });
  return { cooldown, exactDeduped, conflicts, executable, globalCooldownFiltered };
}

function horizonMetric(opportunities: readonly ExecutableOpportunity[], horizon: Horizon): HorizonMetric {
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

function quality(opportunities: readonly ExecutableOpportunity[]): QualityMetric {
  return {
    count: opportunities.length,
    horizons: { 5: horizonMetric(opportunities, 5), 10: horizonMetric(opportunities, 10), 15: horizonMetric(opportunities, 15), 30: horizonMetric(opportunities, 30) },
    averageMfe: average(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    medianMfe: median(opportunities.flatMap((opportunity) => opportunity.mfe === undefined ? [] : [opportunity.mfe])),
    averageMae: average(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
    medianMae: median(opportunities.flatMap((opportunity) => opportunity.mae === undefined ? [] : [opportunity.mae])),
  };
}

function bucket(timestamp: Date): TimeBucket {
  const minute = marketDateAndMinute(timestamp).minute;
  if (minute < 10 * 60 + 30) return '09:15-10:30';
  if (minute < 12 * 60) return '10:30-12:00';
  if (minute < 13 * 60 + 30) return '12:00-13:30';
  return '13:30-15:30';
}

function printQuality(label: string, opportunities: readonly ExecutableOpportunity[]): void {
  const metric = quality(opportunities);
  console.log(`${label}: count=${metric.count}`);
  horizons.forEach((horizon) => {
    const result = metric.horizons[horizon];
    console.log(`  +${horizon}m positive=${result.positive} negative=${result.negative} neutral=${result.neutral} accuracy=${result.accuracy.toFixed(2)}% avg=${result.average.toFixed(2)} median=${result.median.toFixed(2)}`);
  });
  console.log(`  MFE avg=${metric.averageMfe.toFixed(2)} median=${metric.medianMfe.toFixed(2)} | MAE avg=${metric.averageMae.toFixed(2)} median=${metric.medianMae.toFixed(2)}`);
}

function printInventoryReport(result: InventoryResult, raw: readonly RawOpportunity[], sessionDates: readonly string[]): void {
  const executable = result.executable;
  const rawExactDuplicatesMerged = raw.length - result.exactDeduped.length;
  const conflictTimestampCount = new Set(result.conflicts.map((opportunity) => opportunity.timestamp.getTime())).size;
  const perSession = sessionDates.map((date) => executable.filter((opportunity) => opportunity.tradingDate === date).length);
  const ce = executable.filter((opportunity) => opportunity.signalType === 'BUY_CE').length;
  const pe = executable.length - ce;
  console.log(`\nGLOBAL SAME-DIRECTION COOLDOWN = ${result.cooldown}m`);
  console.log(`raw opportunities=${raw.length} | exact duplicates merged=${rawExactDuplicatesMerged} | conflicts=${conflictTimestampCount} timestamps / ${result.conflicts.length} directional entries | global cooldown filtered=${result.globalCooldownFiltered}`);
  console.log(`executable=${executable.length} | CE=${ce} PE=${pe} | avg/session=${average(perSession).toFixed(2)} median/session=${median(perSession).toFixed(2)} min/session=${Math.min(...perSession)} max/session=${Math.max(...perSession)} zero=${perSession.filter((value) => value === 0).length}`);
  [5, 10, 15, 20].forEach((minimum) => console.log(`sessions with >=${minimum} executable opportunities=${perSession.filter((value) => value >= minimum).length}`));

  console.log('\nSETUP CONTRIBUTION');
  setupIds.forEach((setupId) => {
    const rawCount = raw.filter((opportunity) => opportunity.setupId === setupId).length;
    const finalContaining = executable.filter((opportunity) => opportunity.setupIds.includes(setupId));
    const exclusive = finalContaining.filter((opportunity) => opportunity.setupIds.length === 1).length;
    const shared = finalContaining.length - exclusive;
    const rawOverlap = raw.filter((opportunity) => opportunity.setupId === setupId && result.exactDeduped.some((merged) => merged.setupIds.includes(setupId) && merged.setupIds.length > 1 && merged.timestamp.getTime() === opportunity.timestamp.getTime() && merged.signalType === opportunity.signalType)).length;
    console.log(`${setupId}: raw=${rawCount} raw-overlap=${rawOverlap} final-containing=${finalContaining.length} exclusive=${exclusive} shared=${shared} final-inventory=${executable.length === 0 ? 0 : finalContaining.length / executable.length * 100.0}%`);
  });

  console.log('\nREGIME CONTRIBUTION');
  [AdaptivePrimaryMarketRegime.TREND_UP, AdaptivePrimaryMarketRegime.TREND_DOWN, AdaptivePrimaryMarketRegime.SIDEWAYS].forEach((regime) => {
    const entries = executable.filter((opportunity) => opportunity.primaryRegime === regime);
    console.log(`${regime}: total=${entries.length} CE=${entries.filter((opportunity) => opportunity.signalType === 'BUY_CE').length} PE=${entries.filter((opportunity) => opportunity.signalType === 'BUY_PE').length}`);
  });

  console.log('\nTIME-OF-DAY DISTRIBUTION');
  timeBuckets.forEach((name) => {
    const entries = executable.filter((opportunity) => bucket(opportunity.timestamp) === name);
    console.log(`${name}: total=${entries.length} CE=${entries.filter((opportunity) => opportunity.signalType === 'BUY_CE').length} PE=${entries.filter((opportunity) => opportunity.signalType === 'BUY_PE').length} opportunities/session=${(entries.length / sessionDates.length).toFixed(2)}`);
  });

  console.log('\nBASIC DIRECTIONAL QUALITY');
  printQuality('OVERALL', executable);
  console.log('\nBy setup (shared final opportunities appear for each contributing setup)');
  setupIds.forEach((setupId) => printQuality(setupId, executable.filter((opportunity) => opportunity.setupIds.includes(setupId))));
  console.log('\nBy regime');
  [AdaptivePrimaryMarketRegime.TREND_UP, AdaptivePrimaryMarketRegime.TREND_DOWN, AdaptivePrimaryMarketRegime.SIDEWAYS].forEach((regime) => printQuality(regime, executable.filter((opportunity) => opportunity.primaryRegime === regime)));
  console.log('\nBy signal direction');
  printQuality('BUY_CE', executable.filter((opportunity) => opportunity.signalType === 'BUY_CE'));
  printQuality('BUY_PE', executable.filter((opportunity) => opportunity.signalType === 'BUY_PE'));
}

async function run(): Promise<void> {
  const repository = new HistoricalCandleRepository();
  const aggregator = new CandleTimeframeAggregatorService();
  const engine = new IndicatorEngineService();
  const regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });
  logger.info('Starting adaptive V2 opportunity inventory research', { instrumentKey, sourceTimeframe });

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
  const raw = generateRawOpportunities(sessions);
  const sessionDates = sessions.map((session) => session.date);

  console.log(`Instrument=${instrumentKey} complete sessions=${sessions.length} raw opportunities=${raw.length}`);
  console.log('Frozen regime: ADX>=20, EMA proximity<=0.05%, ATR high=0.10%, ATR low=0.05%.');
  globalCooldowns.forEach((cooldown) => printInventoryReport(buildInventory(raw, cooldown), raw, sessionDates));

  const primary = buildInventory(raw, 0);
  const perSession = sessionDates.map((date) => primary.executable.filter((opportunity) => opportunity.tradingDate === date).length);
  const exactDuplicatesMerged = raw.length - primary.exactDeduped.length;
  const conflictTimestampCount = new Set(primary.conflicts.map((opportunity) => opportunity.timestamp.getTime())).size;
  const exclusiveBySetup = setupIds.map((setupId) => ({
    setupId,
    count: primary.executable.filter((opportunity) => opportunity.setupIds.length === 1 && opportunity.setupIds[0] === setupId).length,
  })).sort((left, right) => right.count - left.count);
  const regimes = [AdaptivePrimaryMarketRegime.TREND_UP, AdaptivePrimaryMarketRegime.TREND_DOWN, AdaptivePrimaryMarketRegime.SIDEWAYS].map((regime) => ({ regime, count: primary.executable.filter((opportunity) => opportunity.primaryRegime === regime).length })).sort((left, right) => right.count - left.count);
  const overallQuality = quality(primary.executable);
  console.log('\nINVENTORY CONCLUSION (0m global cooldown)');
  console.log(`combined opportunities/session=${average(perSession).toFixed(2)}; >=10 days=${perSession.filter((value) => value >= 10).length}; >=15 days=${perSession.filter((value) => value >= 15).length}; >=20 days=${perSession.filter((value) => value >= 20).length}`);
  console.log(`lost to exact duplicates=${exactDuplicatesMerged}; conflict timestamps=${conflictTimestampCount} (${primary.conflicts.length} directional entries); global cooldown loss=0`);
  console.log(`largest exclusive contributor=${exclusiveBySetup[0]?.setupId ?? 'NONE'} (${exclusiveBySetup[0]?.count ?? 0}); largest regime=${regimes[0]?.regime ?? 'NONE'} (${regimes[0]?.count ?? 0})`);
  console.log(`overall 15m quality: accuracy=${overallQuality.horizons[15].accuracy.toFixed(2)}% avg=${overallQuality.horizons[15].average.toFixed(2)} median=${overallQuality.horizons[15].median.toFixed(2)} MFE=${overallQuality.averageMfe.toFixed(2)} MAE=${overallQuality.averageMae.toFixed(2)}`);
  logger.info('Adaptive V2 opportunity inventory research completed', { completeSessions: sessions.length, rawOpportunities: raw.length });
}

run().catch((error) => {
  logger.error('Adaptive V2 opportunity inventory research failed', { error });
  console.error('Adaptive V2 opportunity inventory research failed.', error);
  process.exitCode = 1;
});
