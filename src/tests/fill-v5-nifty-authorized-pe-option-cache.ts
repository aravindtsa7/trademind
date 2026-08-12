import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';

dotenv.config();
logger.silent = true;

const authorizedRequests = [
  { instrumentKey: 'NSE_FO|51323|19-05-2026', tradingDate: '2026-05-13' },
  { instrumentKey: 'NSE_FO|51371|14-07-2026', tradingDate: '2026-07-08' },
] as const;

async function run(): Promise<void> {
  if (process.env.V5_NIFTY_PE_CACHE_FILL_AUTHORIZED !== 'true') {
    throw new Error('Set V5_NIFTY_PE_CACHE_FILL_AUTHORIZED=true to execute this two-session guarded V5 fill.');
  }
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before the guarded V5 fill.');
  const repository = new HistoricalOptionCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(
    new HistoricalCandleRepository(), repository,
    new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token)),
  );
  const before = await preloader.inspectLocalOptionSessions(authorizedRequests);
  const nonEmpty = before.sessions.filter((session) => session.locallyAvailableCandleCount !== 0);
  if (nonEmpty.length > 0) throw new Error(`Guarded V5 fill requires the two authorized sessions to be empty before fetch: ${JSON.stringify(nonEmpty)}.`);

  // This established cache service validates IST date/window, 375 continuous
  // minutes, unique timestamps, valid OHLC, and persisted completeness before
  // its normal upsert. No overfull normalization is authorized here.
  const cache = new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token));
  const outcomes = await Promise.allSettled(authorizedRequests.map((request) => cache.getCandles(request.instrumentKey, request.tradingDate)));
  const results = cache.getSessionResults();
  const after = await preloader.inspectLocalOptionSessions(authorizedRequests);
  const rejected = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
    ? [{ ...authorizedRequests[index], sessionResult: results[index], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
    : []);
  console.log('V5 NIFTY GUARDED PE CACHE FILL', {
    authorizedSessions: authorizedRequests,
    remoteFetchesAttempted: authorizedRequests.length,
    sessionResults: results,
    rejected,
    finalInspection: after,
  });
  if (rejected.length > 0 || after.completeLocalSessions !== authorizedRequests.length || after.incompleteLocalSessions !== 0 || after.missingLocalSessions !== 0) {
    throw new Error('V5 guarded PE fill did not produce exactly two complete local sessions; Phase 2 must not run.');
  }
}

run().catch((error) => {
  console.error('V5 guarded NIFTY PE cache fill failed.', error);
  process.exitCode = 1;
});
