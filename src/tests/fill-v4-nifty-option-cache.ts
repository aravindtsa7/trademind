import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import logger from '../core/logger/logger';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';

dotenv.config();
logger.silent = true;

const niftyInstrument = 'NSE_INDEX|Nifty 50';
const manifestPath = resolve(process.cwd(), process.env.V4_NIFTY_MANIFEST_PATH?.trim() || 'artifacts/v4-nifty-missing-session-manifest.json');
const concurrency = parsePositiveInteger(process.env.V4_NIFTY_CACHE_FILL_CONCURRENCY ?? '3', 'V4_NIFTY_CACHE_FILL_CONCURRENCY');

interface Requirement {
  instrumentKey: string;
  tradingDate: string;
  directions: Array<'CE' | 'PE'>;
  locallyAvailableCandleCount: number;
  completenessState: 'COMPLETE' | 'MISSING' | 'INCOMPLETE';
}
interface FamilyRequirement { family: 'OPENING_RANGE' | 'MOMENTUM_EXPANSION' | 'VWAP'; requiredSessions: Array<Requirement & { direction?: 'CE' | 'PE' }>; }
interface V4Manifest { localOnly: boolean; outcomeResearchRun: boolean; byInstrument: Record<string, FamilyRequirement[]>; }

async function run(): Promise<void> {
  if (process.env.V4_NIFTY_CACHE_FILL_AUTHORIZED !== 'true') {
    throw new Error('Set V4_NIFTY_CACHE_FILL_AUTHORIZED=true to run this guarded NIFTY-only V4 fill.');
  }
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this guarded fill.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as V4Manifest;
  if (manifest.localOnly !== true || manifest.outcomeResearchRun !== false) throw new Error('The V4 manifest is not a diagnostics-only local-only manifest.');
  const families = manifest.byInstrument[niftyInstrument];
  if (!families) throw new Error(`Manifest does not contain ${niftyInstrument}.`);
  const relevant = families.filter((family) => family.family === 'OPENING_RANGE' || family.family === 'MOMENTUM_EXPANSION');
  if (relevant.length !== 2) throw new Error('Manifest must include exactly Opening Range and Momentum Expansion requirements for NIFTY.');
  const missingByFamily = new Map(relevant.map((family) => [family.family, uniqueMissing(family.requiredSessions)]));
  const openingRange = missingByFamily.get('OPENING_RANGE')!;
  const momentum = missingByFamily.get('MOMENTUM_EXPANSION')!;
  const openingRangeKeys = new Set(openingRange.map(key));
  const momentumKeys = new Set(momentum.map(key));
  const overlap = openingRange.filter((request) => momentumKeys.has(key(request)));
  const requests = unique([...openingRange, ...momentum]);

  console.log('V4 NIFTY GUARDED FILL PLAN', {
    manifestPath,
    openingRangeMissingSessions: openingRange.length,
    momentumExpansionMissingSessions: momentum.length,
    overlapBetweenFamilies: overlap.length,
    globallyUniqueNiftyMissingSessions: requests.length,
    expectedNewRowsAt375PerSession: requests.length * 375,
    constrainedUnderlying: niftyInstrument,
    concurrency,
  });

  const repository = new HistoricalOptionCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(
    new HistoricalCandleRepository(),
    repository,
    new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token)),
  );
  const before = await preloader.inspectLocalOptionSessions(requests);
  const alreadyComplete = before.sessions.filter((session) => session.complete);
  const incomplete = before.sessions.filter((session) => !session.complete && session.locallyAvailableCandleCount > 0);
  if (incomplete.length > 0) {
    throw new Error(`Refusing V4 NIFTY fill because listed missing sessions are now non-empty/incomplete: ${JSON.stringify(incomplete)}.`);
  }
  const fetches = requests.filter((request) => !alreadyComplete.some((session) => session.instrumentKey === request.instrumentKey && session.tradingDate === request.tradingDate));
  const cache = new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token));
  const outcomes = await mapConcurrentSettled(fetches, concurrency, (request) => cache.getCandles(request.instrumentKey, request.tradingDate));
  const results = cache.getSessionResults();
  const after = await preloader.inspectLocalOptionSessions(requests);
  const rejected = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
    ? [{ ...fetches[index], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
    : []);
  console.log('V4 NIFTY GUARDED FILL RESULTS', {
    requestedManifestSessions: requests.length,
    sessionsAlreadyCompleteAtExecution: alreadyComplete.length,
    remoteFetchesAttempted: fetches.length,
    validSessionsStored: results.filter((result) => result.status === 'downloaded').length,
    newlyStoredCandleRows: results.reduce((total, result) => total + result.storedCandleCount, 0),
    overfullResponses: results.filter((result) => result.status === 'overfull'),
    invalidOrIncompleteResponses: results.filter((result) => result.status === 'failed'),
    transientFailuresAfterRetries: rejected,
    finalInspection: after,
  });
  if (after.completeLocalSessions !== requests.length || after.incompleteLocalSessions !== 0 || after.missingLocalSessions !== 0) {
    throw new Error('V4 NIFTY guarded fill is incomplete; inspect the reported non-successful sessions before any outcome research.');
  }
}

function uniqueMissing(requirements: ReadonlyArray<Requirement & { direction?: 'CE' | 'PE' }>): Requirement[] {
  return unique(requirements.filter((request) => request.completenessState === 'MISSING').map((request) => ({
    instrumentKey: request.instrumentKey,
    tradingDate: request.tradingDate,
    directions: request.directions ?? (request.direction === undefined ? [] : [request.direction]),
    locallyAvailableCandleCount: request.locallyAvailableCandleCount,
    completenessState: request.completenessState,
  })));
}
function unique(requests: readonly Requirement[]): Requirement[] {
  return [...new Map(requests.map((request) => [key(request), request])).values()].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate) || left.instrumentKey.localeCompare(right.instrumentKey));
}
function key(request: Pick<Requirement, 'instrumentKey' | 'tradingDate'>): string { return `${request.instrumentKey}\u0000${request.tradingDate}`; }
function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
async function mapConcurrentSettled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = { status: 'fulfilled', value: await work(items[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

run().catch((error) => {
  console.error('V4 NIFTY guarded cache fill failed.', error);
  process.exitCode = 1;
});
