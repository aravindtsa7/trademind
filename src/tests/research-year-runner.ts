import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import logger from '../core/logger/logger';
import ResearchYearRunnerService from '../modules/research-lake/services/research-year-runner.service';
import GrowwOptionCandleAcquisitionService from '../modules/research-lake/services/groww-option-candle-acquisition.service';
import GrowwHistoricalClient from '../modules/research-lake/providers/groww/groww-historical-client';
import GrowwOptionHistoricalDataProviderService from '../modules/research-lake/providers/groww/groww-option-historical-data-provider.service';
import GrowwAccessTokenProviderService from '../modules/research-lake/providers/groww/groww-access-token-provider.service';
import { ResearchYearRunScope } from '../modules/research-lake/domain/research-year-run.types';
import { determineResearchYearRunCliExitCode } from '../modules/research-lake/services/research-year-run-cli-exit-policy.util';

dotenv.config();
logger.silent = true;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Research-only B-F8 year/date-range orchestration entrypoint. Never wired
 * into `server.ts` or any live startup path. Composes the already-closed
 * B-F2-B-F7 services via `ResearchYearRunnerService` -- never reimplements
 * acquisition/discovery/canonicalization/checksum/Parquet/resampling logic.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_YEAR = '2022'
 *   $env:RESEARCH_YEAR_SCOPE = 'ALL'
 *   npm run research:year
 *
 *   $env:RESEARCH_YEAR = '2026'
 *   $env:RESEARCH_YEAR_SCOPE = 'ALL'
 *   $env:RESEARCH_YEAR_TO_DATE = '2026-08-27'
 *   npm run research:year
 *
 * Optional:
 *   $env:RESEARCH_YEAR_FROM_DATE = '2022-03-01'   (defaults per ResearchYearPlanService.resolveRange)
 *   $env:RESEARCH_DRY_RUN = 'true'                (default false; true dry-run -- zero side effects)
 *
 * For OPTIONS/ALL scope, `OPTION_CANDLE_ACQUISITION`/`OPTION_MATERIALIZATION`
 * report BLOCKED (see the B-F8 final report's "strategy-universe contract
 * selection path" section) unless a real `RequiredOptionSessionSource` is
 * wired in -- this CLI never invents one. A Groww access token is resolved
 * (mirroring `research-nifty-option-candle-acquisition.ts`) only so the
 * OPTION_CANDLE_ACQUISITION stage CAN run once such a source exists; its
 * absence alone never blocks OPTION_CATALOG_ACQUISITION or the UNDERLYING
 * stages.
 */
async function run(): Promise<void> {
  const yearRaw = process.env.RESEARCH_YEAR?.trim();
  const scopeRaw = process.env.RESEARCH_YEAR_SCOPE?.trim().toUpperCase();
  const fromDate = process.env.RESEARCH_YEAR_FROM_DATE?.trim();
  const toDate = process.env.RESEARCH_YEAR_TO_DATE?.trim();
  const dryRun = process.env.RESEARCH_DRY_RUN?.trim().toLowerCase() === 'true';

  if (!yearRaw || !/^\d{4}$/.test(yearRaw)) {
    throw new Error('RESEARCH_YEAR is required and must be a 4-digit year (e.g. 2022). This script never defaults or infers the year.');
  }
  const year = Number(yearRaw);
  if (!scopeRaw || !(Object.values(ResearchYearRunScope) as string[]).includes(scopeRaw)) {
    throw new Error(`RESEARCH_YEAR_SCOPE is required and must be one of: ${Object.values(ResearchYearRunScope).join(', ')}.`);
  }
  const scope = scopeRaw as ResearchYearRunScope;
  if (fromDate !== undefined && !DATE_PATTERN.test(fromDate)) {
    throw new Error(`RESEARCH_YEAR_FROM_DATE must be YYYY-MM-DD; received '${fromDate}'.`);
  }
  if (toDate !== undefined && !DATE_PATTERN.test(toDate)) {
    throw new Error(`RESEARCH_YEAR_TO_DATE must be YYYY-MM-DD; received '${toDate}'.`);
  }

  const optionCandleAcquisitionService = await tryBuildOptionCandleAcquisitionService(scope);

  const runner = new ResearchYearRunnerService({ optionCandleAcquisitionService, gitRevision: resolveGitRevisionBestEffort() });

  console.log(JSON.stringify({ event: 'research:year starting', year, scope, fromDate: fromDate ?? '(default)', toDate: toDate ?? '(default)', dryRun }));

  const record = await runner.run({ year, fromDate, toDate, scope, dryRun });

  console.log(
    JSON.stringify(
      {
        outcome: record.outcome,
        plan: {
          fromDate: record.plan.fromDate,
          toDate: record.plan.toDate,
          scope: record.plan.scope,
          planSemanticIdentity: record.plan.planSemanticIdentity,
        },
        stages: record.stages.map((stage) => ({
          stageKind: stage.stageKind,
          status: stage.status,
          detail: stage.detail,
          acquisitionSummary: stage.acquisitionSummary,
          materializationInstrumentCount: stage.materialization?.length ?? null,
          materializationSessionCounts: stage.materialization?.map((instrument) => ({
            instrumentDescriptor: instrument.instrumentDescriptor,
            datasetId: instrument.datasetId,
            sessions: instrument.sessions.length,
          })),
        })),
        checkpointPath: runner.checkpointPath(record.plan),
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      },
      null,
      2
    )
  );

  // Exit-code policy (task correction section 4): a dry-run whose only in-scope stages are PLANNED/
  // SKIPPED_NOT_IN_SCOPE is a SUCCESSFUL plan (exit 0) -- dry-run never requires stages to reach COMPLETED.
  // A structurally BLOCKED stage (e.g. the strategy-universe gap) exits non-zero regardless of dryRun,
  // since the dry-run has proven the requested execution plan cannot currently be completed.
  process.exitCode = determineResearchYearRunCliExitCode(record, dryRun);
}

/** Mirrors `research-nifty-option-candle-acquisition.ts`'s token resolution -- only attempted when OPTIONS/ALL scope is actually requested, and never fatal on its own (a missing/invalid token simply leaves the stage BLOCKED rather than crashing an UNDERLYING-only concern). */
async function tryBuildOptionCandleAcquisitionService(scope: ResearchYearRunScope): Promise<GrowwOptionCandleAcquisitionService | null> {
  if (scope !== ResearchYearRunScope.OPTIONS && scope !== ResearchYearRunScope.ALL) return null;
  try {
    const accessToken = await resolveAccessToken();
    const client = new GrowwHistoricalClient(accessToken);
    const provider = new GrowwOptionHistoricalDataProviderService(client);
    return new GrowwOptionCandleAcquisitionService({ provider });
  } catch (error) {
    console.error('research:year could not resolve a Groww access token -- OPTION_CANDLE_ACQUISITION/OPTION_MATERIALIZATION will report BLOCKED.', error instanceof Error ? error.message : error);
    return null;
  }
}

async function resolveAccessToken(): Promise<string> {
  const direct = process.env.GROWW_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  const tokenProvider = new GrowwAccessTokenProviderService();
  return tokenProvider.getAccessToken();
}

/** Matches `research-dataset-manifest-generate.ts`'s own best-effort git revision lookup. */
function resolveGitRevisionBestEffort(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

run().catch((error) => {
  console.error('B-F8 research year run failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
