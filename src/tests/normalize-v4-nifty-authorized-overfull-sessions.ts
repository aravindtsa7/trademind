import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import { v4NiftyAuthorizedOverfullNormalizations } from './helpers/v4-nifty-authorized-overfull-normalizations';

dotenv.config();
logger.silent = true;

async function run(): Promise<void> {
  if (process.env.V4_NIFTY_NORMALIZE_AUTHORIZED_OVERFULL !== 'true') {
    throw new Error('Set V4_NIFTY_NORMALIZE_AUTHORIZED_OVERFULL=true to run this exact two-session guarded normalization.');
  }
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running guarded normalization.');
  const repository = new HistoricalOptionCandleRepository();
  const preloader = new HistoricalOptionResearchPreloaderService(
    new HistoricalCandleRepository(),
    repository,
    new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token)),
  );
  const before = await preloader.inspectLocalOptionSessions(v4NiftyAuthorizedOverfullNormalizations);
  const invalidLocalState = before.sessions.filter((session) => !session.complete && session.locallyAvailableCandleCount !== 0);
  if (invalidLocalState.length > 0) throw new Error(`Refusing normalization because an authorized session has non-empty incomplete local data: ${JSON.stringify(invalidLocalState)}.`);
  const toFetch = before.sessions
    .filter((session) => !session.complete)
    .map((session) => ({ instrumentKey: session.instrumentKey, tradingDate: session.tradingDate }));
  const cache = new HistoricalOptionCandleCacheService(
    repository,
    new UpstoxExpiredOptionCandleClient(token),
    v4NiftyAuthorizedOverfullNormalizations,
  );
  const outcomes = await Promise.allSettled(toFetch.map((session) => cache.getCandles(session.instrumentKey, session.tradingDate)));
  const results = cache.getSessionResults();
  const after = await preloader.inspectLocalOptionSessions(v4NiftyAuthorizedOverfullNormalizations);
  console.log('V4 NIFTY AUTHORIZED OVERFULL NORMALIZATION', {
    authorizedSessions: v4NiftyAuthorizedOverfullNormalizations,
    sessionsAlreadyCompleteAtExecution: before.completeLocalSessions,
    normalizedStoredSessions: results.filter((result) => result.status === 'normalized').length,
    newlyStoredRows: results.reduce((total, result) => total + result.storedCandleCount, 0),
    excludedRows: results.reduce((total, result) => total + (result.excludedCandleCount ?? 0), 0),
    rejectedSessions: outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ ...toFetch[index], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
      : []),
    sessionResults: results,
    finalInspection: after,
  });
  if (after.completeLocalSessions !== v4NiftyAuthorizedOverfullNormalizations.length || after.missingLocalSessions !== 0 || after.incompleteLocalSessions !== 0) {
    throw new Error('Authorized V4 NIFTY normalization did not produce two complete local sessions.');
  }
}

run().catch((error) => {
  console.error('V4 NIFTY authorized overfull normalization failed.', error);
  process.exitCode = 1;
});
