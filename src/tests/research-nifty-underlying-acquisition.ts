import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import NiftyUnderlyingAcquisitionService from '../modules/research-lake/services/nifty-underlying-acquisition.service';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-acquisition-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Research-only B-F2 entrypoint. Never wired into `server.ts` or any live
 * startup path. Requires an explicit `RESEARCH_END_DATE` -- there is no
 * default end date, so running this script without configuring it can
 * never silently kick off an open-ended "2022-until-now" backfill.
 * `RESEARCH_START_DATE` may be omitted; the service itself then defaults it
 * to the Upstox provider's documented `earliestDocumentedUnderlyingHistory`
 * (2022-01-01), which is still bounded by the required end date.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_START_DATE = '2022-01-01'
 *   $env:RESEARCH_END_DATE = '2022-01-31'
 *   npm run research:nifty-history
 *
 * Optional: RESEARCH_DRY_RUN=true fetches from the real provider but never
 * writes to the database (see NiftyUnderlyingAcquisitionRequest.dryRun).
 */
async function run(): Promise<void> {
  const startDate = process.env.RESEARCH_START_DATE?.trim();
  const endDate = process.env.RESEARCH_END_DATE?.trim();
  const dryRun = process.env.RESEARCH_DRY_RUN?.trim().toLowerCase() === 'true';

  if (!endDate) {
    throw new Error(
      "RESEARCH_END_DATE is required (YYYY-MM-DD). This script never defaults the end date to 'today' or infers a bulk backfill range on its own."
    );
  }
  if (!DATE_PATTERN.test(endDate)) {
    throw new Error(`RESEARCH_END_DATE must be YYYY-MM-DD; received '${endDate}'.`);
  }
  if (startDate && !DATE_PATTERN.test(startDate)) {
    throw new Error(`RESEARCH_START_DATE must be YYYY-MM-DD; received '${startDate}'.`);
  }

  console.log(
    JSON.stringify({
      event: 'research:nifty-history starting',
      requestedStartDate: startDate ?? '(defaulting to provider capability start)',
      requestedEndDate: endDate,
      dryRun,
    })
  );

  const service = new NiftyUnderlyingAcquisitionService();
  const result = await service.acquire({ fromDate: startDate, toDate: endDate, dryRun });

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    ARTIFACT_PATH,
    `${JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`
  );

  console.log(
    JSON.stringify(
      {
        instrumentKey: result.instrumentKey,
        requestedStartDate: result.requestedStartDate,
        requestedEndDate: result.requestedEndDate,
        monthlyChunksAttempted: result.monthlyChunksAttempted,
        monthlyChunksSucceeded: result.monthlyChunksSucceeded,
        monthlyChunksFailed: result.monthlyChunksFailed,
        providerRowsReceived: result.providerRowsReceived,
        canonicalRowsAccepted: result.canonicalRowsAccepted,
        excludedRows: result.excludedRows,
        sessionCounts: {
          alreadyComplete: result.sessions.alreadyComplete.length,
          newlyCompleted: result.sessions.newlyCompleted.length,
          normalizedWithExclusions: result.sessions.normalizedWithExclusions.length,
          incomplete: result.sessions.incomplete.length,
          invalid: result.sessions.invalid.length,
          specialSessionExcluded: result.sessions.specialSessionExcluded.length,
          unresolvedNoData: result.sessions.unresolvedNoData.length,
        },
        retryCount: result.retryCount,
        rateLimitBackoffCount: result.rateLimitBackoffCount,
        failedChunkCount: result.failedChunks.length,
        artifact: ARTIFACT_PATH,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error('B-F2 NIFTY underlying acquisition failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
