import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';

dotenv.config();
logger.silent = true;

const requests = [
  { instrumentKey: 'NSE_FO|45489|10-03-2026', tradingDate: '2026-03-04' },
  { instrumentKey: 'NSE_FO|57752|17-03-2026', tradingDate: '2026-03-12' },
  { instrumentKey: 'NSE_FO|57694|17-03-2026', tradingDate: '2026-03-16' },
  { instrumentKey: 'NSE_FO|41741|12-05-2026', tradingDate: '2026-05-12' },
  { instrumentKey: 'NSE_FO|41739|12-05-2026', tradingDate: '2026-05-12' },
] as const;

async function run(): Promise<void> {
  if (process.env.V3_PE_CACHE_FILL_AUTHORIZED !== 'true')
    throw new Error('Set V3_PE_CACHE_FILL_AUTHORIZED=true to run this guarded five-session fill.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this guarded fill.');

  const optionRepository = new HistoricalOptionCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(
    new HistoricalCandleRepository(),
    optionRepository,
    new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token)),
  );
  const before = await preloader.inspectLocalOptionSessions(requests);
  const nonEmpty = before.sessions.filter((session) => session.locallyAvailableCandleCount !== 0);
  if (nonEmpty.length > 0)
    throw new Error(`Guarded V3 PE fill requires every requested session to be empty before fetch: ${JSON.stringify(nonEmpty)}.`);

  const cache = new HistoricalOptionCandleCacheService(
    optionRepository,
    new UpstoxExpiredOptionCandleClient(token),
  );
  const outcomes = await Promise.allSettled(
    requests.map((request) => cache.getCandles(request.instrumentKey, request.tradingDate)),
  );
  const after = await preloader.inspectLocalOptionSessions(requests);
  const results = cache.getSessionResults();
  console.log('V3 PE GUARDED CACHE FILL', {
    requestedSessions: requests.length,
    requested: requests,
    successfulSessions: results.filter((result) => result.status === 'downloaded').length,
    storedRows: results.reduce((total, result) => total + result.storedCandleCount, 0),
    overfullResponses: results.filter((result) => result.status === 'overfull'),
    failedResponses: results.filter((result) => result.status === 'failed'),
    rejectedPromises: outcomes
      .map((outcome, index) => ({ outcome, request: requests[index] }))
      .filter((entry): entry is { outcome: PromiseRejectedResult; request: (typeof requests)[number] } => entry.outcome.status === 'rejected')
      .map((entry) => ({ ...entry.request, error: entry.outcome.reason instanceof Error ? entry.outcome.reason.message : String(entry.outcome.reason) })),
    finalInspection: after,
  });
  if (after.completeLocalSessions !== requests.length || after.missingLocalSessions !== 0 || after.incompleteLocalSessions !== 0)
    throw new Error('Guarded V3 PE fill did not produce five complete local sessions.');
}

run().catch((error) => {
  console.error('V3 PE guarded cache fill failed.', error);
  process.exitCode = 1;
});
