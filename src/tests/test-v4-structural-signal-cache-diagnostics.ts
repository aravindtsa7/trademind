import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import {
  DirectionalOptionSessionRequirement,
  deduplicateDirectionalOptionSessions,
  chooseHistoricalOptionExpiry,
} from './helpers/v3-option-cache-diagnostics';
import {
  assertV4NoLookAhead,
  createV4Configs,
  generateV4Signals,
  V4Config,
  V4Family,
  V4OptionDirection,
  V4Signal,
  v4MarketMinute,
} from './helpers/v4-structural-signal-generation';

dotenv.config();
logger.silent = true;

const supportedInstruments = ['NSE_INDEX|Nifty 50', 'BSE_INDEX|SENSEX'] as const;
const requestedInstrument = process.env.V4_UNDERLYING_INSTRUMENT_KEY?.trim();
const instruments = requestedInstrument === undefined || requestedInstrument === ''
  ? supportedInstruments
  : supportedInstruments.filter((instrument) => instrument === requestedInstrument);
const requestedEndDate = parseRequiredEndDate(process.env.RESEARCH_END_DATE ?? '2026-08-04');
const resolutionConcurrency = parsePositiveInteger(process.env.RESEARCH_OPTION_METADATA_CONCURRENCY ?? '3', 'RESEARCH_OPTION_METADATA_CONCURRENCY');

interface PreparedContractSession {
  signal: V4Signal;
  instrumentKey: string;
  tradingDate: string;
}

interface FamilyDiagnostic {
  family: V4Family;
  configurationCount: number;
  uniqueDirectionalTimestamps: number;
  peUniqueTimestamps: number;
  ceUniqueTimestamps: number;
  requiredSessions: DirectionalOptionSessionRequirement[];
}

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') {
    throw new Error('V4 diagnostics requires RESEARCH_LOCAL_ONLY=true. It must never request historical option candles.');
  }
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env to resolve authoritative expired option metadata.');
  if (instruments.length === 0) throw new Error(`V4_UNDERLYING_INSTRUMENT_KEY must be one of: ${supportedInstruments.join(', ')}.`);

  const underlyingRepository = new HistoricalCandleRepository();
  const optionRepository = new HistoricalOptionCandleRepository();
  const optionCache = new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token));
  const preloader = new HistoricalOptionResearchPreloaderService(underlyingRepository, optionRepository, optionCache, true);
  const optionClient = new UpstoxExpiredOptionClient(token);
  const selector = new OptionContractSelectorService();
  const engine = new IndicatorEngineService();
  const aggregator = new CandleTimeframeAggregatorService();
  const regimeService = new AdaptiveMarketRegimeService({
    trendStrengthThreshold: 20,
    emaProximityPercent: 0.05,
    highVolatilityThreshold: 0.1,
    lowVolatilityThreshold: 0.05,
  });
  const configs = createV4Configs();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractCache = new Map<string, Promise<OptionContract[]>>();
  const allRequirements: DirectionalOptionSessionRequirement[] = [];
  const byInstrument: Record<string, FamilyDiagnostic[]> = {};

  console.log('V4 STRUCTURAL SIGNAL / LOCAL OPTION-CACHE DIAGNOSTICS');
  console.log('V4 grids', {
    openingRangeConfigurations: configs.OPENING_RANGE.length,
    vwapConfigurations: configs.VWAP.length,
    momentumExpansionConfigurations: configs.MOMENTUM_EXPANSION.length,
    totalConfigurationsPerInstrument: Object.values(configs).flat().length,
    outcomeResearch: 'NOT RUN',
    optionCandleDownloads: 0,
  });

  for (const underlyingInstrumentKey of instruments) {
    const underlying = await preloader.preloadUnderlying(underlyingInstrumentKey, '1minute');
    const complete = [...underlying.underlyingByDate.entries()]
      .filter(([, candles]) => isCompleteSession(candles))
      .sort(([left], [right]) => left.localeCompare(right));
    const prepared = prepareCrossSessionIndicatorWarmup(
      complete.map(([date, candles]) => ({ date, candles })),
      aggregator,
      engine,
      regimeService,
    );
    const sessions = filterCrossSessionResearchTargets(prepared, requestedEndDate);
    if (sessions.length === 0) throw new Error(`No complete V4 target sessions for ${underlyingInstrumentKey} through ${requestedEndDate}.`);
    const positiveVolumeCandles = complete.flatMap(([, candles]) => candles).filter((candle) => candle.volume > 0).length;
    // VWAP must reset at each IST session. Recalculate per target session, while
    // ATR remains warm-up seeded from the cross-session frame.
    const vwapByFrame = new Map(
      ([1, 2, 3, 5] as const).map((timeframe) => [
        timeframe,
        new Map(sessions.flatMap((session) => scalarValues(engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.VWAP }] }), IndicatorType.VWAP))),
      ]),
    );
    const atr14ByFrame = new Map(
      ([1, 2, 3, 5] as const).map((timeframe) => [
        timeframe,
        new Map(sessions.flatMap((session) => {
          const values = new Map(scalarValues(engine.calculate(session.frames[timeframe].allCandles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }), IndicatorType.ATR, 14));
          return session.frames[timeframe].candles.flatMap((candle) => {
            const value = values.get(candle.timestamp.getTime());
            return value === undefined ? [] : [[candle.timestamp.getTime(), value] as [number, number]];
          });
        })),
      ]),
    );

    console.log(`\n${underlyingInstrumentKey} | targetSessions=${sessions.length} start=${sessions[0].date} end=${sessions.at(-1)?.date}`);
    console.log('V4 DATA AVAILABILITY', {
      underlyingOneMinuteCandles: complete.reduce((total, [, candles]) => total + candles.length, 0),
      positiveVolumeCandles,
      vwap: positiveVolumeCandles === 0 ? 'UNAVAILABLE: all cached index candle volumes are zero; no price-only substitute was used.' : 'AVAILABLE',
    });
    const diagnostics: FamilyDiagnostic[] = [];
    for (const family of ['OPENING_RANGE', 'VWAP', 'MOMENTUM_EXPANSION'] as const) {
      const familyConfigs = configs[family];
      const signals = familyConfigs.flatMap((config) => generateV4Signals(sessions, config, { vwapByFrame, atr14ByFrame }));
      assertV4NoLookAhead(signals);
      const uniqueSignals = deduplicateSignals(signals);
      const preparedContracts = await mapConcurrent(uniqueSignals, resolutionConcurrency, (signal) =>
        prepareContractSession(signal, underlyingInstrumentKey, optionClient, selector, expiryCache, contractCache),
      );
      const inspection = await preloader.inspectLocalOptionSessions(preparedContracts);
      const requirementBySession = new Map(inspection.sessions.map((entry) => [`${entry.instrumentKey}\u0000${entry.tradingDate}`, entry]));
      const requirements = preparedContracts.map((entry) => {
        const local = requirementBySession.get(`${entry.instrumentKey}\u0000${entry.tradingDate}`);
        if (!local) throw new Error(`Missing V4 local-cache inspection for ${entry.instrumentKey} ${entry.tradingDate}.`);
        return {
          instrumentKey: entry.instrumentKey,
          tradingDate: entry.tradingDate,
          direction: entry.signal.direction,
          locallyAvailableCandleCount: local.locallyAvailableCandleCount,
          completenessState: local.complete ? 'COMPLETE' : local.locallyAvailableCandleCount === 0 ? 'MISSING' : 'INCOMPLETE',
        } as DirectionalOptionSessionRequirement;
      });
      const deduplicatedRequirements = deduplicateDirectionalOptionSessions(requirements).flatMap((entry) =>
        entry.directions.map((direction) => ({
          instrumentKey: entry.instrumentKey,
          tradingDate: entry.tradingDate,
          direction,
          locallyAvailableCandleCount: entry.locallyAvailableCandleCount,
          completenessState: entry.completenessState,
        })),
      );
      const diagnostic: FamilyDiagnostic = {
        family,
        configurationCount: familyConfigs.length,
        uniqueDirectionalTimestamps: uniqueSignals.length,
        peUniqueTimestamps: uniqueSignals.filter((signal) => signal.direction === 'PE').length,
        ceUniqueTimestamps: uniqueSignals.filter((signal) => signal.direction === 'CE').length,
        requiredSessions: deduplicatedRequirements,
      };
      diagnostics.push(diagnostic);
      allRequirements.push(...deduplicatedRequirements);
      console.log(`${family}`, {
        configurations: diagnostic.configurationCount,
        uniqueDirectionalTimestamps: diagnostic.uniqueDirectionalTimestamps,
        peUniqueTimestamps: diagnostic.peUniqueTimestamps,
        ceUniqueTimestamps: diagnostic.ceUniqueTimestamps,
        requiredUniqueOptionSessions: deduplicateDirectionalOptionSessions(diagnostic.requiredSessions).length,
        completeLocalSessions: deduplicateDirectionalOptionSessions(diagnostic.requiredSessions).filter((entry) => entry.completenessState === 'COMPLETE').length,
        incompleteLocalSessions: deduplicateDirectionalOptionSessions(diagnostic.requiredSessions).filter((entry) => entry.completenessState === 'INCOMPLETE').length,
        missingLocalSessions: deduplicateDirectionalOptionSessions(diagnostic.requiredSessions).filter((entry) => entry.completenessState === 'MISSING').length,
        noLookAhead: 'PASSED',
      });
    }
    byInstrument[underlyingInstrumentKey] = diagnostics;
  }

  const global = deduplicateDirectionalOptionSessions(allRequirements);
  const missing = global.filter((entry) => entry.completenessState === 'MISSING');
  const incomplete = global.filter((entry) => entry.completenessState === 'INCOMPLETE');
  const manifest = {
    schemaVersion: 1,
    researchVersion: 'V4_STRUCTURAL_DIAGNOSTICS',
    researchEndDate: requestedEndDate,
    localOnly: true,
    outcomeResearchRun: false,
    byInstrument: Object.fromEntries(Object.entries(byInstrument).map(([instrument, diagnostics]) => [instrument, diagnostics.map((diagnostic) => ({
      family: diagnostic.family,
      configurationCount: diagnostic.configurationCount,
      uniqueDirectionalTimestamps: diagnostic.uniqueDirectionalTimestamps,
      requiredSessions: diagnostic.requiredSessions,
    }))])),
    globalRequiredSessions: global,
    missingSessions: missing,
    incompleteSessions: incomplete,
  };
  console.log('\nV4 GLOBAL OPTION CACHE REQUIREMENTS', {
    uniqueRequiredSessions: global.length,
    completeLocalSessions: global.filter((entry) => entry.completenessState === 'COMPLETE').length,
    incompleteLocalSessions: incomplete.length,
    missingLocalSessions: missing.length,
    expectedNewRowsAt375PerMissingSession: missing.length * 375,
    exactRemoteFetchesRequired: missing.length,
    optionCandleDownloads: 0,
  });
  console.log('V4 DATA PREPARATION MANIFEST JSON', JSON.stringify(manifest));
  writeManifestIfRequested(manifest);
}

function writeManifestIfRequested(manifest: unknown): void {
  const requestedPath = process.env.V4_MANIFEST_OUTPUT_PATH?.trim();
  if (!requestedPath) return;
  const outputPath = resolve(process.cwd(), requestedPath);
  const outputRelativePath = relative(process.cwd(), outputPath);
  if (!outputRelativePath || outputRelativePath.startsWith('..') || isAbsolute(outputRelativePath)) {
    throw new Error('V4_MANIFEST_OUTPUT_PATH must stay inside the repository workspace.');
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('V4 DATA PREPARATION MANIFEST WRITTEN', { outputRelativePath });
}

async function prepareContractSession(
  signal: V4Signal,
  underlyingInstrumentKey: string,
  client: UpstoxExpiredOptionClient,
  selector: OptionContractSelectorService,
  expiryCache: Map<string, Promise<string[]>>,
  contractCache: Map<string, Promise<OptionContract[]>>,
): Promise<PreparedContractSession> {
  const expiries = await cached(expiryCache, underlyingInstrumentKey, () => client.fetchAvailableExpiries(underlyingInstrumentKey));
  const expiry = chooseHistoricalOptionExpiry(expiries, signal.date);
  const contracts = await cached(contractCache, `${underlyingInstrumentKey}\u0000${expiry}`, () => client.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
  const underlying = contracts[0]?.underlying;
  if (!underlying) throw new Error(`Expired option metadata has no underlying for ${underlyingInstrumentKey} expiry ${expiry}.`);
  const selection = selector.select({
    underlying,
    spotPrice: signal.spotPrice,
    signal: signal.direction === 'CE' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE,
    timestamp: signal.timestamp,
    contracts,
  });
  return { signal, instrumentKey: selection.instrumentKey, tradingDate: signal.date };
}

function deduplicateSignals(signals: readonly V4Signal[]): V4Signal[] {
  const result = new Map<string, V4Signal>();
  signals.forEach((signal) => {
    const key = `${signal.direction}\u0000${signal.timestamp.getTime()}`;
    const existing = result.get(key);
    if (existing && Math.abs(existing.spotPrice - signal.spotPrice) > 1e-9) {
      throw new Error(`V4 signals disagree on spot price for ${signal.direction} at ${signal.timestamp.toISOString()}.`);
    }
    result.set(key, existing ?? signal);
  });
  return [...result.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.direction.localeCompare(right.direction));
}

function scalarValues(results: IndicatorEngineResult, type: IndicatorType, period?: number): Array<[number, number]> {
  const indicator = results.indicators.find((entry) => entry.config.type === type && (period === undefined || ('period' in entry.config && entry.config.period === period)));
  if (!indicator) throw new Error(`Missing ${type}${period ?? ''} indicator.`);
  return indicator.result.values.flatMap((value) => ('value' in value && typeof value.value === 'number' ? [[value.timestamp.getTime(), value.value] as [number, number]] : []));
}

function isCompleteSession(candles: readonly { timestamp: Date }[]): boolean {
  if (candles.length !== 375) return false;
  const sorted = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  return v4MarketMinute(sorted[0].timestamp) === 9 * 60 + 15 &&
    v4MarketMinute(sorted[374].timestamp) === 15 * 60 + 29 &&
    sorted.every((candle, index) => index === 0 || candle.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === 60_000);
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = create();
  cache.set(key, pending);
  return pending;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      result[index] = await mapper(items[index]);
    }
  }));
  return result;
}

function parseRequiredEndDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('RESEARCH_END_DATE must use YYYY-MM-DD.');
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

run().catch((error) => {
  console.error('V4 structural signal/cache diagnostics failed.', error);
  process.exitCode = 1;
});
