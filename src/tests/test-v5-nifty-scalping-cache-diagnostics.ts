import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import {
  DirectionalOptionSessionRequirement,
  deduplicateDirectionalOptionSessions,
  chooseHistoricalOptionExpiry,
} from './helpers/v3-option-cache-diagnostics';
import {
  assertV5NoLookAhead,
  createV5ScalpingConfigs,
  deduplicateV5Signals,
  generateV5Signals,
  prepareV5IndicatorContext,
  v5ConfigKey,
  V5Direction,
  V5Signal,
} from './helpers/v5-nifty-scalping-signal-generation';

dotenv.config();
logger.silent = true;

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const endDate = requiredEndDate(process.env.RESEARCH_END_DATE ?? '2026-08-04');
const metadataConcurrency = positiveInteger(process.env.RESEARCH_OPTION_METADATA_CONCURRENCY ?? '3');
const artifactsDirectory = resolve(process.cwd(), 'artifacts', 'v5-scalping');

interface PreparedContractSession {
  signal: V5Signal;
  instrumentKey: string;
  tradingDate: string;
  selection: OptionContractSelectionResult;
}

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') {
    throw new Error('V5 Phase 1 diagnostics requires RESEARCH_LOCAL_ONLY=true and must not download option candles.');
  }
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env to resolve authoritative expired option metadata.');

  const underlyingRepository = new HistoricalCandleRepository();
  const optionRepository = new HistoricalOptionCandleRepository();
  // The cache is only supplied to satisfy the preloader constructor.  Phase 1
  // calls inspectLocalOptionSessions only, so the candle client is never used.
  const cache = new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token));
  const preloader = new HistoricalOptionResearchPreloaderService(underlyingRepository, optionRepository, cache, true);
  const engine = new IndicatorEngineService();
  const aggregator = new CandleTimeframeAggregatorService();
  const regimeService = new AdaptiveMarketRegimeService({
    trendStrengthThreshold: 20,
    emaProximityPercent: 0.05,
    highVolatilityThreshold: 0.1,
    lowVolatilityThreshold: 0.05,
  });

  const underlying = await preloader.preloadUnderlying(underlyingInstrumentKey, '1minute');
  const completeSessions = [...underlying.underlyingByDate.entries()]
    .filter(([, candles]) => completeMinuteSession(candles))
    .sort(([left], [right]) => left.localeCompare(right));
  const prepared = prepareCrossSessionIndicatorWarmup(
    completeSessions.map(([date, candles]) => ({ date, candles })),
    aggregator,
    engine,
    regimeService,
  );
  const sessions = filterCrossSessionResearchTargets(prepared, endDate);
  if (sessions.length === 0) throw new Error(`No complete V5 target sessions through ${endDate}.`);

  const configs = createV5ScalpingConfigs();
  const indicators = prepareV5IndicatorContext(sessions, engine);
  const rawByDirection: Record<V5Direction, number> = { CE: 0, PE: 0 };
  const uniqueByTimestamp = new Map<string, V5Signal>();
  const configSummaries: Array<{ configKey: string; direction: V5Direction; signalCount: number }> = [];
  for (const config of configs) {
    const signals = generateV5Signals(sessions, config, indicators);
    assertV5NoLookAhead(signals);
    rawByDirection[config.direction] += signals.length;
    configSummaries.push({ configKey: v5ConfigKey(config), direction: config.direction, signalCount: signals.length });
    signals.forEach((signal) => {
      const key = `${signal.direction}\u0000${signal.timestamp.getTime()}`;
      const existing = uniqueByTimestamp.get(key);
      if (existing && Math.abs(existing.spotPrice - signal.spotPrice) > 1e-9) {
        throw new Error(`V5 signals disagree on spot price for ${signal.direction} at ${signal.timestamp.toISOString()}.`);
      }
      uniqueByTimestamp.set(key, existing ?? signal);
    });
  }
  const uniqueSignals = deduplicateV5Signals([...uniqueByTimestamp.values()]);
  const optionClient = new UpstoxExpiredOptionClient(token);
  const selector = new OptionContractSelectorService();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractCache = new Map<string, Promise<OptionContract[]>>();
  const preparedContracts = await mapConcurrent(uniqueSignals, metadataConcurrency, (signal) =>
    resolveHistoricalContract(signal, optionClient, selector, expiryCache, contractCache),
  );
  const inspection = await preloader.inspectLocalOptionSessions(preparedContracts);
  const localByKey = new Map(inspection.sessions.map((entry) => [sessionKey(entry.instrumentKey, entry.tradingDate), entry]));
  const requirements: DirectionalOptionSessionRequirement[] = preparedContracts.map((entry) => {
    const local = localByKey.get(sessionKey(entry.instrumentKey, entry.tradingDate));
    if (!local) throw new Error(`Missing V5 local option-cache inspection for ${entry.instrumentKey} ${entry.tradingDate}.`);
    return {
      instrumentKey: entry.instrumentKey,
      tradingDate: entry.tradingDate,
      direction: entry.signal.direction,
      locallyAvailableCandleCount: local.locallyAvailableCandleCount,
      completenessState: local.complete ? 'COMPLETE' : local.locallyAvailableCandleCount === 0 ? 'MISSING' : 'INCOMPLETE',
    };
  });
  const global = deduplicateDirectionalOptionSessions(requirements);
  const missing = global.filter((entry) => entry.completenessState === 'MISSING');
  const incomplete = global.filter((entry) => entry.completenessState === 'INCOMPLETE');
  const directionSummary = (direction: V5Direction) => {
    const directionRequirements = deduplicateDirectionalOptionSessions(requirements.filter((entry) => entry.direction === direction));
    return {
      rawSignalsAcrossConfigurations: rawByDirection[direction],
      uniqueSignalTimestamps: uniqueSignals.filter((signal) => signal.direction === direction).length,
      requiredUniqueOptionSessions: directionRequirements.length,
      completeLocalSessions: directionRequirements.filter((entry) => entry.completenessState === 'COMPLETE').length,
      missingLocalSessions: directionRequirements.filter((entry) => entry.completenessState === 'MISSING').length,
      incompleteLocalSessions: directionRequirements.filter((entry) => entry.completenessState === 'INCOMPLETE').length,
    };
  };
  const manifest = {
    schemaVersion: 1,
    researchVersion: 'V5_NIFTY_SCALPING_PHASE_1',
    outcomeResearchRun: false,
    localOnly: true,
    underlyingInstrumentKey,
    targetDateRange: { start: sessions[0].date, end: sessions.at(-1)?.date, targetSessions: sessions.length },
    grid: {
      totalConfigurations: configs.length,
      ceConfigurations: configs.filter((config) => config.direction === 'CE').length,
      peConfigurations: configs.filter((config) => config.direction === 'PE').length,
      dimensions: { timeframe: '2m completed', proximityPercent: [0.05, 0.1, 0.15, 0.2], ceRsiGreaterThan: [50, 55, 60], peRsiLessThan: [50, 45, 40], bodyAtrMinimum: [0.25, 0.5, 0.75], pullbackLookbackBars: [1, 2, 3], confirmation: ['TREND_CLOSE', 'PRIOR_BREAK', 'EMA_RECLAIM'], cooldownMinutes: [0, 2, 3, 5] },
    },
    signals: { CE: directionSummary('CE'), PE: directionSummary('PE'), uniqueDirectionalTimestamps: uniqueSignals.length, noLookAhead: 'PASSED' },
    globalRequiredSessions: global,
    missingSessions: missing,
    incompleteSessions: incomplete,
    selectedContracts: preparedContracts.map((entry) => ({
      direction: entry.signal.direction,
      timestamp: entry.signal.timestamp.toISOString(),
      tradingDate: entry.tradingDate,
      instrumentKey: entry.instrumentKey,
      tradingSymbol: entry.selection.tradingSymbol,
      strikePrice: entry.selection.strikePrice,
      expiry: entry.selection.expiry.toISOString(),
      locallyAvailable: localByKey.get(sessionKey(entry.instrumentKey, entry.tradingDate))?.complete === true,
    })),
  };
  mkdirSync(artifactsDirectory, { recursive: true });
  writeJson('signal-grid-summary.json', { ...manifest.targetDateRange, grid: manifest.grid, signals: manifest.signals, configurations: configSummaries });
  writeJson('required-option-cache-manifest.json', manifest);
  writeJson('phase-1-diagnostics-summary.json', {
    ...manifest.targetDateRange,
    grid: manifest.grid,
    signals: manifest.signals,
    global: {
      requiredUniqueOptionSessions: global.length,
      completeLocalSessions: global.filter((entry) => entry.completenessState === 'COMPLETE').length,
      missingLocalSessions: missing.length,
      incompleteLocalSessions: incomplete.length,
      expectedNewRowsAt375PerMissingSession: missing.length * 375,
      exactRemoteFetchesRequired: missing.length,
      optionCandleDownloads: 0,
    },
  });

  console.log('V5 NIFTY SCALPING PHASE 1 | SIGNAL / LOCAL OPTION-CACHE DIAGNOSTICS');
  console.log('V5 TARGET SESSIONS', manifest.targetDateRange);
  console.log('V5 SIGNAL GRID', manifest.grid);
  console.log('V5 CE', directionSummary('CE'));
  console.log('V5 PE', directionSummary('PE'));
  console.log('V5 GLOBAL OPTION CACHE REQUIREMENTS', {
    uniqueRequiredSessions: global.length,
    completeLocalSessions: global.filter((entry) => entry.completenessState === 'COMPLETE').length,
    incompleteLocalSessions: incomplete.length,
    missingLocalSessions: missing.length,
    expectedNewRowsAt375PerMissingSession: missing.length * 375,
    exactRemoteFetchesRequired: missing.length,
    optionCandleDownloads: 0,
  });
  console.log('V5 ARTIFACTS', { directory: 'artifacts/v5-scalping', files: ['signal-grid-summary.json', 'required-option-cache-manifest.json', 'phase-1-diagnostics-summary.json'] });
  if (missing.length > 0 || incomplete.length > 0) {
    console.log('V5 PHASE 1 STOP: required local option history is incomplete; no outcome research or downloads were run.');
  } else {
    console.log('V5 PHASE 1 COMPLETE: option cache is complete. Outcome research remains a separate Phase 2 action.');
  }
}

async function resolveHistoricalContract(
  signal: V5Signal,
  client: UpstoxExpiredOptionClient,
  selector: OptionContractSelectorService,
  expiryCache: Map<string, Promise<string[]>>,
  contractCache: Map<string, Promise<OptionContract[]>>,
): Promise<PreparedContractSession> {
  const expiries = await cached(expiryCache, underlyingInstrumentKey, () => client.fetchAvailableExpiries(underlyingInstrumentKey));
  const expiry = chooseHistoricalOptionExpiry(expiries, signal.date);
  const contracts = await cached(contractCache, expiry, () => client.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
  const underlying = contracts[0]?.underlying;
  if (!underlying) throw new Error(`Expired NIFTY option metadata has no underlying for expiry ${expiry}.`);
  const selection = selector.select({
    underlying,
    spotPrice: signal.spotPrice,
    signal: signal.direction === 'CE' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE,
    timestamp: signal.timestamp,
    contracts,
  });
  return { signal, instrumentKey: selection.instrumentKey, tradingDate: signal.date, selection };
}

function completeMinuteSession(candles: readonly { timestamp: Date }[]): boolean {
  if (candles.length !== 375) return false;
  const ordered = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const expectedStart = dateAtIstMinute(ordered[0].timestamp, 9 * 60 + 15);
  return ordered[0].timestamp.getTime() === expectedStart &&
    istMinute(ordered[374].timestamp) === 15 * 60 + 29 &&
    ordered.every((candle, index) => index === 0 || candle.timestamp.getTime() - ordered[index - 1].timestamp.getTime() === 60_000);
}

function dateAtIstMinute(date: Date, minute: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((part) => [part.type, part.value]));
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+05:30`).getTime() + minute * 60_000;
}

function istMinute(timestamp: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function sessionKey(instrumentKey: string, tradingDate: string): string { return `${instrumentKey}\u0000${tradingDate}`; }
function writeJson(name: string, value: unknown): void { writeFileSync(resolve(artifactsDirectory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> { const existing = cache.get(key); if (existing) return existing; const pending = create(); cache.set(key, pending); return pending; }
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> { const output = new Array<R>(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next; next += 1; if (index >= items.length) return; output[index] = await mapper(items[index]); } })); return output; }
function requiredEndDate(value: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('RESEARCH_END_DATE must use YYYY-MM-DD.'); return value; }
function positiveInteger(value: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('RESEARCH_OPTION_METADATA_CONCURRENCY must be a positive integer.'); return parsed; }

run().catch((error) => {
  console.error('V5 NIFTY scalping Phase 1 diagnostics failed.', error);
  process.exitCode = 1;
});
