import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import GrowwOptionCandleAcquisitionService from '../modules/research-lake/services/groww-option-candle-acquisition.service';
import GrowwHistoricalClient from '../modules/research-lake/providers/groww/groww-historical-client';
import GrowwOptionHistoricalDataProviderService from '../modules/research-lake/providers/groww/groww-option-historical-data-provider.service';
import GrowwAccessTokenProviderService from '../modules/research-lake/providers/groww/groww-access-token-provider.service';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-option-candle-acquisition-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Deliberate safety cap: this CLI is scoped to strategy-required contracts/sessions, never an implicit full-history backfill (task B-F4 section 5). */
const MAX_DATE_SPAN_DAYS = 31;

/**
 * Research-only B-F4 entrypoint (single-contract, explicit-date-range
 * option candle acquisition -- never a full option chain, never an
 * implicit/default date range). Never wired into `server.ts` or any live
 * startup path.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_OPTION_GROWW_SYMBOL = 'NSE-NIFTY-06Jan22-17200-PE'
 *   $env:RESEARCH_OPTION_START_DATE = '2022-01-03'
 *   $env:RESEARCH_OPTION_END_DATE = '2022-01-03'
 *   $env:RESEARCH_DRY_RUN = 'true'
 *   npm run research:nifty-option-candles
 *
 * Requires EITHER `GROWW_ACCESS_TOKEN` directly, OR both `GROWW_API_KEY`
 * and `GROWW_API_SECRET` (used only to generate a token in memory via the
 * approval flow -- never persisted; see `GrowwAccessTokenProviderService`).
 */
async function run(): Promise<void> {
  const growwSymbol = process.env.RESEARCH_OPTION_GROWW_SYMBOL?.trim();
  const startDate = process.env.RESEARCH_OPTION_START_DATE?.trim();
  const endDate = process.env.RESEARCH_OPTION_END_DATE?.trim();
  const dryRun = process.env.RESEARCH_DRY_RUN?.trim().toLowerCase() !== 'false'; // defaults to dry-run-safe unless explicitly disabled

  if (!growwSymbol) {
    throw new Error('RESEARCH_OPTION_GROWW_SYMBOL is required (e.g. NSE-NIFTY-06Jan22-17200-PE). This script never defaults to an implicit contract.');
  }
  if (!startDate || !DATE_PATTERN.test(startDate)) {
    throw new Error('RESEARCH_OPTION_START_DATE is required and must be YYYY-MM-DD. This script never defaults the start date.');
  }
  if (!endDate || !DATE_PATTERN.test(endDate)) {
    throw new Error('RESEARCH_OPTION_END_DATE is required and must be YYYY-MM-DD. This script never defaults the end date.');
  }
  if (startDate > endDate) {
    throw new Error(`RESEARCH_OPTION_START_DATE (${startDate}) must not be after RESEARCH_OPTION_END_DATE (${endDate}).`);
  }

  const tradingDates = calendarWeekdays(startDate, endDate);
  const spanDays = Math.round((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_DATE_SPAN_DAYS && process.env.RESEARCH_OPTION_ALLOW_LARGE_RANGE?.trim().toLowerCase() !== 'true') {
    throw new Error(
      `Requested range ${startDate}..${endDate} spans ${spanDays} day(s), exceeding this CLI's ${MAX_DATE_SPAN_DAYS}-day safety cap. B-F4 is scoped to strategy-required contracts/sessions, never an implicit full-history backfill (task section 5). Set RESEARCH_OPTION_ALLOW_LARGE_RANGE=true only for a deliberate, explicitly-authorized larger run.`
    );
  }

  const accessToken = await resolveAccessToken();
  const client = new GrowwHistoricalClient(accessToken);
  const provider = new GrowwOptionHistoricalDataProviderService(client);
  const service = new GrowwOptionCandleAcquisitionService({ provider });

  console.log(JSON.stringify({ event: 'research:nifty-option-candles starting', growwSymbol, startDate, endDate, requestedSessionCount: tradingDates.length, dryRun }));

  const result = await service.acquire({ providerContractId: growwSymbol, tradingDates, dryRun });

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(result, bigintReplacer, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        provider: result.provider,
        providerContractId: result.providerContractId,
        requestedSessions: result.requestedSessions,
        dryRun: result.dryRun,
        requests: result.requests,
        providerRows: result.providerRows,
        canonicalRows: result.canonicalRows,
        excludedRows: result.excludedRows,
        sessions: result.sessions,
        oi: result.oi,
        retries: result.retries,
        rateLimitBackoffs: result.rateLimitBackoffs,
        authenticationFailed: result.authenticationFailed,
        failedSessionCount: result.failedSessions.length,
        failedSessionSample: result.failedSessions.slice(0, 3),
        artifact: ARTIFACT_PATH,
      },
      bigintReplacer,
      2
    )
  );
}

async function resolveAccessToken(): Promise<string> {
  const direct = process.env.GROWW_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  const tokenProvider = new GrowwAccessTokenProviderService();
  return tokenProvider.getAccessToken();
}

/** Independently implemented (never imported from `banknifty-data-audit.ts`, matching the same "additive-only" boundary `nifty-underlying-acquisition.service.ts` already documents for reusing that helper via import rather than duplicating it -- here it is duplicated deliberately to keep this standalone research CLI free of a cross-module import into `research` for a two-line date helper). */
function calendarWeekdays(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let cursor = new Date(`${startDate}T00:00:00Z`); cursor <= new Date(`${endDate}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

run().catch((error) => {
  console.error('B-F4 NIFTY option candle acquisition failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
