import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService, { HistoricalOptionCandleCacheSessionResult } from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import { GloballyDeduplicatedOptionSessionRequirement } from './helpers/v3-option-cache-diagnostics';

dotenv.config();
logger.silent = true;

interface SensexV3Manifest {
  schemaVersion: number;
  underlyingInstrumentKey: string;
  researchEndDate: string | null;
  uniqueRequiredSessions: number;
  missingSessions: GloballyDeduplicatedOptionSessionRequirement[];
  incompleteSessions: GloballyDeduplicatedOptionSessionRequirement[];
}

const manifestPath = 'artifacts/sensex-v3-global-missing-session-manifest.json';
const defaultConcurrency = 3;
const authorizedNormalizations = [
  { instrumentKey: 'BSE_FO|840209|06-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'BSE_FO|840341|06-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'BSE_FO|840680|06-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'BSE_FO|840267|06-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'BSE_FO|840297|06-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'BSE_FO|840399|06-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'BSE_FO|840446|06-08-2026', tradingDate: '2026-08-04' },
] as const;

function loadManifest(): SensexV3Manifest {
  const requestedPath = process.env.SENSEX_V3_MANIFEST_INPUT_PATH?.trim() || manifestPath;
  const resolvedPath = resolve(process.cwd(), requestedPath);
  const relativePath = relative(process.cwd(), resolvedPath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath))
    throw new Error('SENSEX_V3_MANIFEST_INPUT_PATH must stay inside the repository workspace.');
  const manifest = JSON.parse(readFileSync(resolvedPath, 'utf8')) as SensexV3Manifest;
  if (manifest.schemaVersion !== 1 || manifest.underlyingInstrumentKey !== 'BSE_INDEX|SENSEX')
    throw new Error('The guarded SENSEX fill requires a schemaVersion=1 BSE_INDEX|SENSEX manifest.');
  if (manifest.uniqueRequiredSessions !== 712 || manifest.missingSessions.length !== 712 || manifest.incompleteSessions.length !== 0)
    throw new Error('The guarded SENSEX fill requires the exact 712-session, zero-incomplete manifest from diagnostics.');
  const unique = new Set<string>();
  manifest.missingSessions.forEach((session) => {
    const key = `${session.instrumentKey}\u0000${session.tradingDate}`;
    if (!session.instrumentKey.startsWith('BSE_FO|') || session.directions.length !== 1 || !['CE', 'PE'].includes(session.directions[0]) || session.completenessState !== 'MISSING' || session.locallyAvailableCandleCount !== 0 || unique.has(key))
      throw new Error(`Invalid guarded SENSEX manifest session: ${JSON.stringify(session)}.`);
    unique.add(key);
  });
  return manifest;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      result[index] = await work(items[index]);
    }
  }));
  return result;
}

function resultWithDirection(result: HistoricalOptionCandleCacheSessionResult, sessions: Map<string, GloballyDeduplicatedOptionSessionRequirement>) {
  const source = sessions.get(`${result.instrumentKey}\u0000${result.tradingDate}`);
  return { ...result, direction: source?.directions[0] ?? 'UNKNOWN' };
}

async function run(): Promise<void> {
  if (process.env.SENSEX_V3_CACHE_FILL_AUTHORIZED !== 'true')
    throw new Error('Set SENSEX_V3_CACHE_FILL_AUTHORIZED=true to run this guarded SENSEX fill.');
  const normalizeAuthorized = process.env.SENSEX_V3_NORMALIZE_AUTHORIZED === 'true';
  const concurrency = Number(process.env.SENSEX_V3_CACHE_FILL_CONCURRENCY ?? defaultConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('SENSEX_V3_CACHE_FILL_CONCURRENCY must be an integer from 1 through 4.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running the guarded SENSEX fill.');

  const manifest = loadManifest();
  const sessionsByKey = new Map(manifest.missingSessions.map((session) => [`${session.instrumentKey}\u0000${session.tradingDate}`, session]));
  const requests = manifest.missingSessions.map((session) => ({ instrumentKey: session.instrumentKey, tradingDate: session.tradingDate }));
  const optionRepository = new HistoricalOptionCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(
    new HistoricalCandleRepository(),
    optionRepository,
    new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token)),
  );
  const before = await preloader.inspectLocalOptionSessions(requests);
  const completeBefore = before.sessions.filter((session) => session.complete);
  const incompleteBefore = before.sessions.filter((session) => !session.complete && session.locallyAvailableCandleCount > 0);
  if (incompleteBefore.length > 0)
    throw new Error(`Guarded SENSEX fill refuses to overwrite nonempty incomplete local sessions: ${JSON.stringify(incompleteBefore)}.`);
  const missingRequests = before.sessions.filter((session) => !session.complete).map((session) => ({ instrumentKey: session.instrumentKey, tradingDate: session.tradingDate }));
  if (normalizeAuthorized) {
    const approved = new Set(authorizedNormalizations.map((session) => `${session.instrumentKey}\u0000${session.tradingDate}`));
    const unapproved = missingRequests.filter((session) => !approved.has(`${session.instrumentKey}\u0000${session.tradingDate}`));
    if (unapproved.length > 0 || missingRequests.length > authorizedNormalizations.length)
      throw new Error(`Guarded SENSEX normalization is limited to exactly seven authorized sessions; current unresolved scope differs: ${JSON.stringify(unapproved)}.`);
  }
  const cache = new HistoricalOptionCandleCacheService(
    optionRepository,
    new UpstoxExpiredOptionCandleClient(token),
    normalizeAuthorized ? authorizedNormalizations : [],
  );
  const outcomes = await mapConcurrent(missingRequests, concurrency, async (request) => {
    try {
      await cache.getCandles(request.instrumentKey, request.tradingDate);
      return { request, status: 'fulfilled' as const };
    } catch (error) {
      return { request, status: 'rejected' as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const results = cache.getSessionResults();
  const overfull = results.filter((result) => result.status === 'overfull').map((result) => resultWithDirection(result, sessionsByKey));
  const failed = results.filter((result) => result.status === 'failed').map((result) => resultWithDirection(result, sessionsByKey));
  const invalid = failed.filter((result) => result.error?.includes('incomplete or malformed') || result.error?.includes('returned no option candles'));
  const authentication = failed.filter((result) => result.error?.includes('status code 401') || result.error?.includes('status code 403'));
  const transient = failed.filter((result) => !invalid.includes(result) && !authentication.includes(result));
  const after = await preloader.inspectLocalOptionSessions(requests);
  const finalByKey = new Map(after.sessions.map((session) => [`${session.instrumentKey}\u0000${session.tradingDate}`, session]));
  const byDirection = (direction: 'PE' | 'CE') => manifest.missingSessions
    .filter((session) => session.directions[0] === direction)
    .map((session) => finalByKey.get(`${session.instrumentKey}\u0000${session.tradingDate}`)!)
    .reduce((summary, session) => ({
      required: summary.required + 1,
      complete: summary.complete + Number(session.complete),
      incomplete: summary.incomplete + Number(!session.complete && session.locallyAvailableCandleCount > 0),
      missing: summary.missing + Number(session.locallyAvailableCandleCount === 0),
    }), { required: 0, complete: 0, incomplete: 0, missing: 0 });
  console.log('SENSEX V3 GUARDED CACHE FILL', {
    manifestSessionsRequested: manifest.missingSessions.length,
    sessionsAlreadyCompleteAtExecution: completeBefore.length,
    remoteFetchesAttempted: missingRequests.length,
    validSessionsStored: results.filter((result) => result.status === 'downloaded' || result.status === 'normalized').length,
    normalizedSessions: results.filter((result) => result.status === 'normalized').length,
    newlyStoredCandleRows: results.reduce((total, result) => total + result.storedCandleCount, 0),
    overfullResponses: overfull,
    invalidOrIncompleteResponses: invalid,
    authenticationFailures: authentication,
    transientFailuresAfterRetries: transient,
    rejectedRequests: outcomes.filter((outcome) => outcome.status === 'rejected'),
    remainingMissingSessions: after.missingLocalSessions,
    remainingIncompleteSessions: after.incompleteLocalSessions,
  });
  console.log('SENSEX V3 MANIFEST-ONLY POST-FILL DIAGNOSTICS', {
    pe: byDirection('PE'),
    ce: byDirection('CE'),
    global: {
      required: after.uniqueRequiredSessions,
      complete: after.completeLocalSessions,
      incomplete: after.incompleteLocalSessions,
      missing: after.missingLocalSessions,
      optionCandleDownloads: 0,
    },
  });
  console.log('SENSEX V3 GUARDED CACHE FILL NON-SUCCESS JSON', JSON.stringify({
    overfullResponses: overfull,
    invalidOrIncompleteResponses: invalid,
    authenticationFailures: authentication,
    transientFailuresAfterRetries: transient,
  }));
  if (after.completeLocalSessions !== manifest.missingSessions.length || after.incompleteLocalSessions !== 0 || after.missingLocalSessions !== 0)
    process.exitCode = 1;
}

run().catch((error) => {
  console.error('SENSEX V3 guarded cache fill failed.', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
