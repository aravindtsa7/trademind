import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import logger from '../core/logger/logger';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { v7AuthorizedOptionSessions, validateV7AuthorizedResponse } from './helpers/v7-authorized-option-cache-fill';

dotenv.config(); logger.silent = true;
const artifact = resolve(process.cwd(), 'artifacts', 'v7-option-impulse', 'authorized-fill-report.json');

async function run(): Promise<void> {
  if (process.env.V7_NIFTY_CACHE_FILL_AUTHORIZED !== 'true') throw new Error('Set V7_NIFTY_CACHE_FILL_AUTHORIZED=true to execute this exact 46-session guarded fill.');
  if (v7AuthorizedOptionSessions.length !== 46 || new Set(v7AuthorizedOptionSessions.map((item) => `${item.instrumentKey}\u0000${item.tradingDate}`)).size !== 46) throw new Error('V7 authorization list must contain exactly 46 unique sessions.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env.');
  const repository = new HistoricalOptionCandleRepository(); const preloader = new HistoricalOptionResearchPreloaderService(new HistoricalCandleRepository(), repository, new HistoricalOptionCandleCacheService(repository, new UpstoxExpiredOptionCandleClient(token)), true);
  const before = await preloader.inspectLocalOptionSessions(v7AuthorizedOptionSessions); const unexpectedExisting = before.sessions.filter((entry) => entry.locallyAvailableCandleCount !== 0);
  if (unexpectedExisting.length > 0) throw new Error(`Refusing V7 fill because an authorized session is not empty: ${JSON.stringify(unexpectedExisting)}.`);
  const remote = new UpstoxExpiredOptionCandleClient(token); const completed: unknown[] = [];
  for (const request of v7AuthorizedOptionSessions) {
    let downloaded: Awaited<ReturnType<UpstoxExpiredOptionCandleClient['fetchCandles']>> = [];
    try {
      downloaded = await remote.fetchCandles(request.instrumentKey, request.tradingDate, request.tradingDate);
      const validation = validateV7AuthorizedResponse(request, downloaded);
      if (!validation.valid) {
        const failed = { direction: request.direction, instrumentKey: request.instrumentKey, tradingDate: request.tradingDate, fetchedRowCount: validation.rowCount, firstTimestamp: validation.firstTimestamp, lastTimestamp: validation.lastTimestamp, anomaly: validation.anomaly };
        write({ authorizedRequests: v7AuthorizedOptionSessions, remoteFetchesAttempted: completed.length + 1, successfullyStored: completed, failed, normalized: 0, unexpectedFetches: 0, phase2Allowed: false });
        console.error('V7 AUTHORIZED FILL STOPPED', failed); throw new Error(`V7 unauthorized response shape: ${JSON.stringify(failed)}.`);
      }
      // The cache validates again before writing. This wrapper prevents a second remote fetch.
      const cache = new HistoricalOptionCandleCacheService(repository, { fetchCandles: async () => downloaded } as unknown as UpstoxExpiredOptionCandleClient);
      await cache.getCandles(request.instrumentKey, request.tradingDate);
      const result = cache.getSessionResults()[0];
      if (result?.status !== 'downloaded' || result.downloadedCandleCount !== 375 || result.storedCandleCount !== 375) throw new Error(`Unexpected V7 store result: ${JSON.stringify(result)}.`);
      completed.push({ ...request, fetchedRowCount: downloaded.length, storedCandleCount: result.storedCandleCount });
    } catch (error) {
      const failed = { direction: request.direction, instrumentKey: request.instrumentKey, tradingDate: request.tradingDate, fetchedRowCount: downloaded.length, firstTimestamp: downloaded[0]?.candleTime.toISOString(), lastTimestamp: downloaded.at(-1)?.candleTime.toISOString(), anomaly: error instanceof Error ? error.message : String(error) };
      write({ authorizedRequests: v7AuthorizedOptionSessions, remoteFetchesAttempted: completed.length + 1, successfullyStored: completed, failed, normalized: 0, unexpectedFetches: 0, phase2Allowed: false }); console.error('V7 AUTHORIZED FILL STOPPED', failed); throw error;
    }
  }
  const after = await preloader.inspectLocalOptionSessions(v7AuthorizedOptionSessions); const phase2Allowed = after.completeLocalSessions === 46 && after.missingLocalSessions === 0 && after.incompleteLocalSessions === 0;
  write({ authorizedRequests: v7AuthorizedOptionSessions, remoteFetchesAttempted: 46, successfullyStored: completed, failed: [], normalized: 0, unexpectedFetches: 0, finalInspection: after, phase2Allowed });
  console.log('V7 AUTHORIZED FILL COMPLETE', { authorizedRequests: 46, remoteFetchesAttempted: 46, successfullyStored: completed.length, failed: 0, normalized: 0, unexpectedFetches: 0, phase2Allowed });
  if (!phase2Allowed) throw new Error('V7 authorized fill did not produce 46 complete local sessions.');
}
function write(value: unknown): void { mkdirSync(resolve(process.cwd(), 'artifacts', 'v7-option-impulse'), { recursive: true }); writeFileSync(artifact, `${JSON.stringify(value, null, 2)}\n`); }
run().catch((error) => { console.error('V7 authorized NIFTY cache fill failed.', error); process.exitCode = 1; });
