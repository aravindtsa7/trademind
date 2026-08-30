import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import { determineNiftyIngestionPlanCliExitCode } from '../modules/research-lake/services/nifty-ingestion-plan-cli-exit-policy.util';
import NiftyUnderlyingAcquisitionService from '../modules/research-lake/services/nifty-underlying-acquisition.service';
import NiftyUnderlyingIngestionPlannerService, { NiftyPlannedDateDisposition } from '../modules/research-lake/services/nifty-underlying-ingestion-planner.service';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-acquisition-result.json`;
/**
 * B-F2-CAL-1 plan-only output. Deliberately named/located as disposable
 * planning evidence, distinct from `ARTIFACT_PATH` above and from canonical
 * validated research-lake datasets -- never write it under
 * `artifacts/research-lake/parquet` or otherwise imply it is validated data.
 */
const PLAN_ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-ingestion-plan.json`;
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
 *
 * Optional: RESEARCH_PLAN_ONLY=true (B-F2-CAL-1) runs a calendar-aware,
 * NETWORK-FREE plan instead: it calls
 * `NiftyUnderlyingIngestionPlannerService.buildPlan(...)` and returns before
 * `NiftyUnderlyingAcquisitionService` is ever constructed -- no Upstox
 * request, no database write. Unlike the acquisition path,
 * `RESEARCH_START_DATE` is REQUIRED in this mode (the planner has no default
 * start date). `RESEARCH_DRY_RUN` is ignored when `RESEARCH_PLAN_ONLY=true`.
 */
async function run(): Promise<void> {
  const startDate = process.env.RESEARCH_START_DATE?.trim();
  const endDate = process.env.RESEARCH_END_DATE?.trim();
  const dryRun = process.env.RESEARCH_DRY_RUN?.trim().toLowerCase() === 'true';
  const planOnly = process.env.RESEARCH_PLAN_ONLY?.trim().toLowerCase() === 'true';

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

  if (planOnly) {
    if (!startDate) {
      throw new Error(
        'RESEARCH_START_DATE is required (YYYY-MM-DD) when RESEARCH_PLAN_ONLY=true: the planner never defaults a start date ' +
          '(task B-F2-CAL-1 section 11 -- no implicit today/current year/five-year range).'
      );
    }

    console.log(JSON.stringify({ event: 'research:nifty-history plan-only starting', requestedStartDate: startDate, requestedEndDate: endDate }));

    const planner = new NiftyUnderlyingIngestionPlannerService();
    const plan = await planner.buildPlan({ fromDate: startDate, toDate: endDate });

    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(PLAN_ARTIFACT_PATH, `${JSON.stringify(plan, null, 2)}\n`);

    console.log(
      JSON.stringify(
        {
          instrumentKey: plan.instrumentKey,
          exchange: plan.exchange,
          calendarSegment: plan.calendarSegment,
          requestedFromDate: plan.requestedFromDate,
          requestedToDate: plan.requestedToDate,
          totalCalendarDateCount: plan.totalCalendarDateCount,
          totalExpectedCandles: plan.totalExpectedCandles,
          regularTradingDateCount: plan.regularTradingDateCount,
          specialSessionDateCount: plan.specialSessionDateCount,
          closedDateCount: plan.closedDateCount,
          blockedDateCount: plan.blockedDateCount,
          hasBlockedDates: plan.hasBlockedDates,
          blockedDates: plan.dates.filter((date) => date.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED).map((date) => date.tradingDate),
          providerRequestChunkCount: plan.providerRequestChunks.length,
          artifact: PLAN_ARTIFACT_PATH,
        },
        null,
        2
      )
    );

    process.exitCode = determineNiftyIngestionPlanCliExitCode(plan);
    if (plan.hasBlockedDates) {
      console.error(
        `B-F2-CAL-1 plan is NOT execution-ready: ${plan.blockedDateCount} date(s) are BLOCKED_UNCERTIFIED ` +
          '(authoritative calendar truth unavailable -- this is never equivalent to a known market holiday).'
      );
    }
    return;
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
