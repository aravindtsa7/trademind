import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import NiftyHistoricalContractCatalogAcquisitionService from '../modules/research-lake/services/nifty-historical-contract-catalog.service';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-contract-catalog-acquisition-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Research-only B-F3 entrypoint (contract DISCOVERY/CATALOG only -- no
 * option candle acquisition, that is B-F4). Never wired into `server.ts`
 * or any live startup path. Requires an explicit
 * `RESEARCH_CONTRACT_END_DATE` -- there is no default end date, so running
 * this script without configuring it can never silently kick off an
 * open-ended catalog backfill. `RESEARCH_CONTRACT_START_DATE` may be
 * omitted; the service then defaults it to Groww's documented
 * `earliestDocumentedOptionDiscovery` (2020-01-01).
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_CONTRACT_START_DATE = '2022-01-01'
 *   $env:RESEARCH_CONTRACT_END_DATE = '2022-12-31'
 *   npm run research:nifty-contract-catalog
 *
 * Optional: RESEARCH_DRY_RUN=true fetches/parses from the real Groww API
 * but never writes to the database.
 *
 * REQUIRES a GROWW_ACCESS_TOKEN with Backtesting-API scope configured via
 * .env -- the currently configured token in this environment does NOT have
 * that scope (confirmed via the B-F3 live feasibility probe: every
 * request returns HTTP 403). See the B-F3 final report's live feasibility
 * section before running this against real data.
 */
async function run(): Promise<void> {
  const startDate = process.env.RESEARCH_CONTRACT_START_DATE?.trim();
  const endDate = process.env.RESEARCH_CONTRACT_END_DATE?.trim();
  const dryRun = process.env.RESEARCH_DRY_RUN?.trim().toLowerCase() === 'true';

  if (!endDate) {
    throw new Error(
      "RESEARCH_CONTRACT_END_DATE is required (YYYY-MM-DD). This script never defaults the end date or infers a bulk catalog backfill range on its own."
    );
  }
  if (!DATE_PATTERN.test(endDate)) {
    throw new Error(`RESEARCH_CONTRACT_END_DATE must be YYYY-MM-DD; received '${endDate}'.`);
  }
  if (startDate && !DATE_PATTERN.test(startDate)) {
    throw new Error(`RESEARCH_CONTRACT_START_DATE must be YYYY-MM-DD; received '${startDate}'.`);
  }

  console.log(
    JSON.stringify({
      event: 'research:nifty-contract-catalog starting',
      requestedStartDate: startDate ?? '(defaulting to provider capability start, 2020-01-01)',
      requestedEndDate: endDate,
      dryRun,
    })
  );

  const service = new NiftyHistoricalContractCatalogAcquisitionService();
  const result = await service.acquire({ fromDate: startDate, toDate: endDate, dryRun });

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        provider: result.provider,
        underlyingSymbol: result.underlyingSymbol,
        requestedStartDate: result.requestedStartDate,
        requestedEndDate: result.requestedEndDate,
        dryRun: result.dryRun,
        expiryRequests: result.expiryRequests,
        expiriesReceived: result.expiriesReceived,
        expiriesAccepted: result.expiriesAccepted,
        contractRequests: result.contractRequests,
        contractSymbolsReceived: result.contractSymbolsReceived,
        parsedOptionContracts: result.parsedOptionContracts,
        ignoredFutures: result.ignoredFutures,
        malformedContracts: result.malformedContracts,
        duplicateContracts: result.duplicateContracts,
        metadataComplete: result.metadataComplete,
        metadataIncomplete: result.metadataIncomplete,
        alreadyKnown: result.alreadyKnown,
        newlyDiscovered: result.newlyDiscovered,
        enriched: result.enriched,
        retryCount: result.retryCount,
        rateLimitBackoffCount: result.rateLimitBackoffCount,
        failedExpiryYearCount: result.failedExpiryYears.length,
        failedExpiryYearSample: result.failedExpiryYears.slice(0, 3),
        failedExpiryCount: result.failedExpiries.length,
        artifact: ARTIFACT_PATH,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error('B-F3 NIFTY contract catalog acquisition failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
