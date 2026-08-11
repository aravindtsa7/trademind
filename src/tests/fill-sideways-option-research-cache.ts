import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';

dotenv.config();
interface ManifestSession { instrumentKey: string; tradingDate: string; directions: ('CE' | 'PE')[]; locallyAvailableCandleCount: number; complete: boolean; }
interface Manifest { scopeEndDate: string; missingSessions: ManifestSession[]; }
const manifestPath = process.env.RESEARCH_SIDEWAYS_MANIFEST_PATH ?? '.research-cache-manifests/sideways-2026-08-04.json';
const authorizedNormalizations = [
  { instrumentKey: 'NSE_FO|65871|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65879|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65867|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65872|04-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'NSE_FO|65868|04-08-2026', tradingDate: '2026-08-03' },
  { instrumentKey: 'NSE_FO|65872|04-08-2026', tradingDate: '2026-08-04' },
  { instrumentKey: 'NSE_FO|65880|04-08-2026', tradingDate: '2026-08-04' },
] as const;
async function concurrent<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> { let next = 0; await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => { while (next < items.length) { const index = next++; await work(items[index]); } })); }
async function run(): Promise<void> { const token = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before filling the cache.'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest; const unique = [...new Map(manifest.missingSessions.map((session) => [`${session.instrumentKey}|${session.tradingDate}`, session])).values()]; if (unique.some((session) => session.complete || session.locallyAvailableCandleCount !== 0)) throw new Error('Manifest contains a non-missing session; refusing fill.'); const cache = new HistoricalOptionCandleCacheService(new HistoricalOptionCandleRepository(), new UpstoxExpiredOptionCandleClient(token), authorizedNormalizations); await concurrent(unique, async (session) => { try { await cache.getCandles(session.instrumentKey, session.tradingDate); } catch {} }); const results = cache.getSessionResults(); const unsuccessful = results.filter((result) => result.status === 'overfull' || result.status === 'failed'); const stored = results.filter((result) => result.status === 'downloaded' || result.status === 'normalized'); console.log('SIDEWAYS CACHE FILL RESULTS', JSON.stringify({ manifestPath, requestedManifestSessions: unique.length, alreadyCompleteAtExecution: results.filter((result) => result.status === 'hit').length, remoteFetchesAttempted: results.filter((result) => result.status !== 'hit').length, validSessionsStored: stored.length, normalizedSessions: results.filter((result) => result.status === 'normalized'), overfullResponses: results.filter((result) => result.status === 'overfull'), invalidOrTransientFailures: results.filter((result) => result.status === 'failed'), newlyStoredCandleRows: stored.reduce((sum, result) => sum + result.storedCandleCount, 0), nonSuccessfulWithDirections: unsuccessful.map((result) => ({ ...result, directions: unique.find((session) => session.instrumentKey === result.instrumentKey && session.tradingDate === result.tradingDate)?.directions ?? [] })) })); if (unsuccessful.length > 0) process.exitCode = 1; }
run().catch((error) => { console.error('SIDEWAYS cache fill failed.', error); process.exitCode = 1; });
