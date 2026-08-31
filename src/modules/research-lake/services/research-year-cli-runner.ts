import { ResearchYearRunRecord, ResearchYearRunScope } from '../domain/research-year-run.types';
import GrowwOptionCandleAcquisitionService from './groww-option-candle-acquisition.service';
import ResearchYearRunnerService, { ResearchYearRunnerServiceDependencies } from './research-year-runner.service';

/**
 * B-F2-CAL-3-FIX-1 (Terra finding): the Research Year CLI
 * (`src/tests/research-year-runner.ts`) used to resolve/construct its
 * `GrowwOptionCandleAcquisitionService` dependency (which, absent
 * `GROWW_ACCESS_TOKEN`, generates a real Groww access token over the
 * network via `GrowwAccessTokenProviderService.getAccessToken()`)
 * UNCONDITIONALLY for `OPTIONS`/`ALL` scope, BEFORE `dryRun` was ever
 * consulted -- so `RESEARCH_DRY_RUN=true` still made a real network call
 * during CLI setup, even though `ResearchYearRunnerService.run({ dryRun:
 * true })` itself was already fully network-free.
 *
 * Pure orchestration, no `console`/`process.exit` of its own (mirrors
 * `runNse2024PilotArchive`'s convention), so the exact dependency-
 * construction boundary Terra found can be unit-tested directly: the
 * `buildOptionCandleAcquisitionService` dependency below is invoked ONLY
 * when `request.dryRun` is `false` -- never for a dry run, regardless of
 * scope. `dryRun=false` behavior (including which scopes need the option
 * service, and how a missing/invalid token is handled) is delegated
 * unchanged to whatever `buildOptionCandleAcquisitionService` the caller
 * supplies (the CLI passes its existing `tryBuildOptionCandleAcquisitionService`
 * verbatim) -- this function never re-implements or weakens that policy.
 */
export interface ResearchYearCliRequest {
  readonly year: number;
  readonly scope: ResearchYearRunScope;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly dryRun: boolean;
}

export interface ResearchYearCliDependencies {
  /**
   * Constructs the option candle acquisition service for a NON-dry-run
   * request (including any Groww access-token resolution/network call it
   * needs to perform). Called ONLY when `dryRun` is `false` -- see
   * `runResearchYearCli`. The CLI's own scope gating (OPTIONS/ALL only)
   * stays inside this function, unchanged.
   */
  readonly buildOptionCandleAcquisitionService: (scope: ResearchYearRunScope) => Promise<GrowwOptionCandleAcquisitionService | null>;
  readonly resolveGitRevision: () => string | null;
  /** Test seam only: defaults to constructing a real `ResearchYearRunnerService`. */
  readonly createRunner?: (dependencies: ResearchYearRunnerServiceDependencies) => Pick<ResearchYearRunnerService, 'run' | 'checkpointPath'>;
}

export interface ResearchYearCliResult {
  readonly record: ResearchYearRunRecord;
  readonly checkpointPath: string;
}

export async function runResearchYearCli(request: ResearchYearCliRequest, dependencies: ResearchYearCliDependencies): Promise<ResearchYearCliResult> {
  // The CAL-3-FIX-1 core correction: the dryRun decision is resolved BEFORE
  // any optional, network-capable dependency is constructed. A dry run
  // never calls `buildOptionCandleAcquisitionService` at all, for ANY
  // scope -- so a Groww access-token resolution/network call can never
  // happen during a dry run's CLI setup.
  const optionCandleAcquisitionService = request.dryRun ? null : await dependencies.buildOptionCandleAcquisitionService(request.scope);
  const gitRevision = dependencies.resolveGitRevision();

  const createRunner = dependencies.createRunner ?? ((deps: ResearchYearRunnerServiceDependencies) => new ResearchYearRunnerService(deps));
  const runner = createRunner({ optionCandleAcquisitionService, gitRevision });

  const record = await runner.run({ year: request.year, fromDate: request.fromDate, toDate: request.toDate, scope: request.scope, dryRun: request.dryRun });
  return { record, checkpointPath: runner.checkpointPath(record.plan) };
}
