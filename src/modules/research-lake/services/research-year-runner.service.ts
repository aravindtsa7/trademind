import { join } from 'path';
import { fileExists, readFileBuffer, writeBufferAtomic } from '../domain/atomic-file-writer';
import { istTradingDayUtcBounds } from '../domain/ist-session-clock';
import { DatasetManifest, ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { assertManifestSchemaCompatible } from '../domain/manifest-schema-compatibility.util';
import { ParquetDatasetStorageDescriptor, ParquetExportRunResult, ParquetSessionExportStatus, parquetStorageManifestRelativePath } from '../domain/parquet-storage.types';
import { ResampleSessionStatus, ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import {
  RequiredOptionSessionSource,
  RESEARCH_YEAR_RUN_SCHEMA_VERSION,
  RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
  RESEARCH_YEAR_RUN_STAGE_ORDER,
  ResearchYearRunMaterializationInstrumentOutcome,
  ResearchYearRunMaterializationSessionOutcome,
  ResearchYearRunOutcome,
  ResearchYearRunPlan,
  ResearchYearRunPlanStage,
  ResearchYearRunRecord,
  ResearchYearRunRequest,
  ResearchYearRunResampleOutcome,
  ResearchYearRunStageKind,
  ResearchYearRunStageResult,
  ResearchYearRunStageStatus,
} from '../domain/research-year-run.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { GrowwSymbolKind, parseGrowwSymbol } from '../providers/groww/groww-contract-symbol-parser';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import DatasetManifestService from './dataset-manifest.service';
import GrowwOptionCandleAcquisitionService from './groww-option-candle-acquisition.service';
import ManifestCalendarSessionResolverService from './manifest-calendar-session-resolver.service';
import HistoricalCandleResamplerService from './historical-candle-resampler.service';
import NiftyHistoricalContractCatalogAcquisitionService from './nifty-historical-contract-catalog.service';
import NiftyUnderlyingAcquisitionService, { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-acquisition.service';
import ResearchLakeParquetExportService, { DEFAULT_PARQUET_OUTPUT_ROOT } from './research-lake-parquet-export.service';
import ResearchLakeParquetVerifyService from './research-lake-parquet-verify.service';
import ResearchYearPlanService from './research-year-plan.service';
import ResearchYearRunCheckpointService from './research-year-run-checkpoint.service';

export const DEFAULT_RESEARCH_MANIFEST_ARTIFACT_ROOT = 'artifacts/research-lake/manifests';

/** Fixed, deterministic derived-timeframe order (task section 10) -- never provider/filesystem/object-enumeration order. */
const RESAMPLE_TIMEFRAMES: readonly ResampleTargetTimeframe[] = [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE];

const WRITTEN_STATUSES: ReadonlySet<string> = new Set([ParquetSessionExportStatus.WRITTEN, ParquetSessionExportStatus.SKIPPED_VERIFIED]);

export interface ResearchYearRunnerServiceDependencies {
  readonly now?: () => Date;
  readonly requiredOptionSessionSource?: RequiredOptionSessionSource;
  readonly planService?: ResearchYearPlanService;
  readonly checkpointService?: ResearchYearRunCheckpointService;
  readonly underlyingAcquisitionService?: NiftyUnderlyingAcquisitionService;
  readonly catalogAcquisitionService?: NiftyHistoricalContractCatalogAcquisitionService;
  /**
   * Constructing a real `GrowwOptionCandleAcquisitionService` requires a
   * resolved Groww access token (an async, environment-specific operation --
   * see `research-nifty-option-candle-acquisition.ts`'s `resolveAccessToken`).
   * That resolution deliberately stays the CLI entrypoint's responsibility,
   * not this service's; when omitted, `OPTION_CANDLE_ACQUISITION` (and
   * therefore `OPTION_MATERIALIZATION`) reports `BLOCKED` rather than
   * constructing a provider with a guessed/default token.
   */
  readonly optionCandleAcquisitionService?: GrowwOptionCandleAcquisitionService | null;
  readonly manifestService?: DatasetManifestService;
  /**
   * B-F5 CALENDAR FIX (task invariant A -- GAP 1): the single authoritative
   * source consulted to recover calendar session windows for this run's
   * already-determined `healthyTradingDates`/option `tradingDates` before
   * manifest generation, since neither `NiftyUnderlyingAcquisitionResult`
   * nor `GrowwOptionCandleAcquisitionResult` carries `SessionWindow`
   * information forward past acquisition. Defaults to a real instance
   * (itself defaulting to a real, Prisma-backed calendar resolver). Tests
   * inject a fake/duck-typed resolver so no unit test touches a live
   * database (same pattern as every other dependency here).
   */
  readonly calendarSessionResolverService?: ManifestCalendarSessionResolverService;
  readonly parquetExportService?: ResearchLakeParquetExportService;
  readonly parquetVerifyService?: ResearchLakeParquetVerifyService;
  readonly resamplerService?: HistoricalCandleResamplerService;
  readonly historicalCandleRepository?: HistoricalCandleRepository;
  readonly historicalOptionCandleLakeRepository?: HistoricalOptionCandleLakeRepository;
  readonly gitRevision?: string | null;
  readonly outputRoot?: string;
  readonly manifestArtifactRoot?: string;
}

/**
 * B-F8 deterministic, resumable historical research-lake year/date-range
 * orchestrator. Composes the already-closed B-F2-B-F7 services; never
 * reimplements provider fetching, contract discovery, canonicalization,
 * checksum/manifest logic, Parquet writing, or resampling.
 */
export default class ResearchYearRunnerService {
  private readonly now: () => Date;
  private readonly planService: ResearchYearPlanService;
  private readonly checkpointService: ResearchYearRunCheckpointService;
  private underlyingAcquisitionService: NiftyUnderlyingAcquisitionService | undefined;
  private catalogAcquisitionService: NiftyHistoricalContractCatalogAcquisitionService | undefined;
  private readonly optionCandleAcquisitionService: GrowwOptionCandleAcquisitionService | null;
  private readonly manifestService: DatasetManifestService;
  private readonly calendarSessionResolverService: ManifestCalendarSessionResolverService;
  private readonly parquetExportService: ResearchLakeParquetExportService;
  private readonly parquetVerifyService: ResearchLakeParquetVerifyService;
  private readonly resamplerService: HistoricalCandleResamplerService;
  private readonly historicalCandleRepository: HistoricalCandleRepository;
  private readonly historicalOptionCandleLakeRepository: HistoricalOptionCandleLakeRepository;
  private readonly gitRevision: string | null;
  private readonly outputRoot: string;
  private readonly manifestArtifactRoot: string;

  constructor(dependencies: ResearchYearRunnerServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.planService = dependencies.planService ?? new ResearchYearPlanService({ now: this.now, requiredOptionSessionSource: dependencies.requiredOptionSessionSource });
    this.checkpointService = dependencies.checkpointService ?? new ResearchYearRunCheckpointService();
    this.underlyingAcquisitionService = dependencies.underlyingAcquisitionService;
    this.catalogAcquisitionService = dependencies.catalogAcquisitionService;
    this.optionCandleAcquisitionService = dependencies.optionCandleAcquisitionService ?? null;
    this.historicalCandleRepository = dependencies.historicalCandleRepository ?? new HistoricalCandleRepository();
    this.historicalOptionCandleLakeRepository = dependencies.historicalOptionCandleLakeRepository ?? new HistoricalOptionCandleLakeRepository();
    this.manifestService = dependencies.manifestService ?? new DatasetManifestService({ historicalCandleRepository: this.historicalCandleRepository, historicalOptionCandleLakeRepository: this.historicalOptionCandleLakeRepository });
    this.calendarSessionResolverService = dependencies.calendarSessionResolverService ?? new ManifestCalendarSessionResolverService();
    this.parquetExportService = dependencies.parquetExportService ?? new ResearchLakeParquetExportService({ historicalCandleRepository: this.historicalCandleRepository, historicalOptionCandleLakeRepository: this.historicalOptionCandleLakeRepository });
    this.parquetVerifyService = dependencies.parquetVerifyService ?? new ResearchLakeParquetVerifyService();
    this.resamplerService = dependencies.resamplerService ?? new HistoricalCandleResamplerService();
    this.gitRevision = dependencies.gitRevision ?? null;
    this.outputRoot = dependencies.outputRoot ?? DEFAULT_PARQUET_OUTPUT_ROOT;
    this.manifestArtifactRoot = dependencies.manifestArtifactRoot ?? DEFAULT_RESEARCH_MANIFEST_ARTIFACT_ROOT;
  }

  async buildPlan(request: ResearchYearRunRequest): Promise<ResearchYearRunPlan> {
    return this.planService.buildPlan(request);
  }

  checkpointPath(plan: ResearchYearRunPlan): string {
    return this.checkpointService.checkpointPath(plan);
  }

  async run(request: ResearchYearRunRequest): Promise<ResearchYearRunRecord> {
    const plan = await this.planService.buildPlan(request);
    const startedAt = this.now().toISOString();

    if (request.dryRun) {
      const stages = plan.stages.map((stagePlan) => this.dryRunStageResult(stagePlan));
      return { schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION, semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION, plan, outcome: this.deriveOutcome(stages), stages, startedAt, completedAt: this.now().toISOString() };
    }

    const previous = this.checkpointService.load(plan);
    const stageResults: ResearchYearRunStageResult[] = [];
    let haltedByInvariantFailure = false;

    for (const stageKind of RESEARCH_YEAR_RUN_STAGE_ORDER) {
      const stagePlan = plan.stages.find((entry) => entry.stageKind === stageKind);
      if (!stagePlan) throw new Error(`ResearchYearRunPlan is missing stage ${stageKind}; this cannot happen for a plan built by ResearchYearPlanService.`);

      if (haltedByInvariantFailure) {
        stageResults.push({ stageKind, status: ResearchYearRunStageStatus.PLANNED, detail: 'Not attempted: a prior stage this run failed an invariant/identity/checksum check (fail-closed halt).', acquisitionSummary: null, materialization: null });
        continue;
      }

      let result: ResearchYearRunStageResult;
      try {
        // eslint-disable-next-line no-await-in-loop -- stages have real dependencies (catalog before candles, acquisition before materialization) and must execute in a fixed order
        result = await this.executeStage(stageKind, stagePlan, plan, previous, stageResults);
      } catch (error) {
        result = { stageKind, status: ResearchYearRunStageStatus.FAILED, detail: error instanceof Error ? error.message : String(error), acquisitionSummary: null, materialization: null };
      }
      stageResults.push(result);
      if (result.status === ResearchYearRunStageStatus.FAILED) haltedByInvariantFailure = true;

      this.checkpointService.save({
        schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
        semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
        plan,
        outcome: this.deriveOutcome(stageResults),
        stages: stageResults,
        startedAt,
        completedAt: null,
      });
    }

    const record: ResearchYearRunRecord = {
      schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
      semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
      plan,
      outcome: this.deriveOutcome(stageResults),
      stages: stageResults,
      startedAt,
      completedAt: this.now().toISOString(),
    };
    this.checkpointService.save(record);
    return record;
  }

  private dryRunStageResult(stagePlan: ResearchYearRunPlanStage): ResearchYearRunStageResult {
    if (!stagePlan.inScope) return { stageKind: stagePlan.stageKind, status: ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE, detail: null, acquisitionSummary: null, materialization: null };
    if (stagePlan.blocked) return { stageKind: stagePlan.stageKind, status: ResearchYearRunStageStatus.BLOCKED, detail: stagePlan.blockedReason, acquisitionSummary: null, materialization: null };
    return { stageKind: stagePlan.stageKind, status: ResearchYearRunStageStatus.PLANNED, detail: null, acquisitionSummary: null, materialization: null };
  }

  private deriveOutcome(stages: readonly ResearchYearRunStageResult[]): ResearchYearRunOutcome {
    if (stages.some((stage) => stage.status === ResearchYearRunStageStatus.FAILED)) return ResearchYearRunOutcome.FAILED;
    if (stages.some((stage) => stage.status === ResearchYearRunStageStatus.BLOCKED || stage.status === ResearchYearRunStageStatus.INCOMPLETE || stage.status === ResearchYearRunStageStatus.PLANNED)) {
      return ResearchYearRunOutcome.INCOMPLETE;
    }
    return ResearchYearRunOutcome.COMPLETE;
  }

  private async executeStage(
    stageKind: ResearchYearRunStageKind,
    stagePlan: ResearchYearRunPlanStage,
    plan: ResearchYearRunPlan,
    previous: ResearchYearRunRecord | null,
    stageResultsThisRun: readonly ResearchYearRunStageResult[]
  ): Promise<ResearchYearRunStageResult> {
    if (!stagePlan.inScope) return { stageKind, status: ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE, detail: null, acquisitionSummary: null, materialization: null };
    if (stagePlan.blocked) return { stageKind, status: ResearchYearRunStageStatus.BLOCKED, detail: stagePlan.blockedReason, acquisitionSummary: null, materialization: null };

    switch (stageKind) {
      case ResearchYearRunStageKind.UNDERLYING_ACQUISITION:
        return this.executeUnderlyingAcquisition(plan, stagePlan, previous);
      case ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION: {
        const acquisition = stageResultsThisRun.find((entry) => entry.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
        if (!acquisition || acquisition.status === ResearchYearRunStageStatus.FAILED) {
          return { stageKind, status: ResearchYearRunStageStatus.FAILED, detail: 'Cannot materialize: UNDERLYING_ACQUISITION did not complete successfully this run.', acquisitionSummary: null, materialization: null };
        }
        return this.executeUnderlyingMaterialization(acquisition);
      }
      case ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION:
        return this.executeCatalogAcquisition(plan);
      case ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION:
        return this.executeOptionCandleAcquisition(stagePlan, previous);
      case ResearchYearRunStageKind.OPTION_MATERIALIZATION: {
        const acquisition = stageResultsThisRun.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
        if (!acquisition || acquisition.status === ResearchYearRunStageStatus.FAILED || acquisition.status === ResearchYearRunStageStatus.BLOCKED || !acquisition.acquisitionSummary) {
          return {
            stageKind,
            status: acquisition?.status === ResearchYearRunStageStatus.BLOCKED ? ResearchYearRunStageStatus.BLOCKED : ResearchYearRunStageStatus.FAILED,
            detail: acquisition?.detail ?? 'Cannot materialize: OPTION_CANDLE_ACQUISITION did not produce a usable result this run.',
            acquisitionSummary: null,
            materialization: null,
          };
        }
        return this.executeOptionMaterialization(acquisition);
      }
      default: {
        const exhaustive: never = stageKind;
        throw new Error(`Unhandled ResearchYearRunStageKind: ${String(exhaustive)}`);
      }
    }
  }

  // ---- UNDERLYING ---------------------------------------------------------

  private async executeUnderlyingAcquisition(plan: ResearchYearRunPlan, _stagePlan: ResearchYearRunPlanStage, previous: ResearchYearRunRecord | null): Promise<ResearchYearRunStageResult> {
    const skippableHealthyDates = await this.tryResolveCleanUnderlyingSkip(previous);
    if (skippableHealthyDates) {
      return {
        stageKind: ResearchYearRunStageKind.UNDERLYING_ACQUISITION,
        status: ResearchYearRunStageStatus.COMPLETED,
        detail:
          'Skipped re-acquisition: the prior run\'s UNDERLYING_ACQUISITION was fully COMPLETED with zero concealed unresolvedNoData/incomplete/invalid/failedChunks dates, and its durable output revalidated successfully against the current persisted store and Parquet storage.',
        acquisitionSummary: { healthyTradingDates: skippableHealthyDates, skippedReacquisition: true },
        materialization: null,
      };
    }

    const result = await this.resolveUnderlyingAcquisitionService().acquire({ fromDate: plan.fromDate, toDate: plan.toDate, dryRun: false });
    const healthyTradingDates = [...result.sessions.alreadyComplete, ...result.sessions.newlyCompleted, ...result.sessions.normalizedWithExclusions].sort();
    // `unresolvedNoData` is NEVER treated as a safe exclusion (task correction section 3/3C): B-F2 has no authoritative
    // NSE-holiday/non-trading-day classification, so a candidate weekday with no provider data and no existing DB
    // coverage stays genuinely unresolved -- it must keep this stage (and therefore the overall run) out of COMPLETE.
    // B-F2C: `sourceConflict` dates are NEVER folded into `healthyTradingDates` above (they are a distinct
    // bucket, never NEWLY_COMPLETED/ALREADY_COMPLETE/NORMALIZED_WITH_EXCLUSIONS) and are treated exactly like
    // any other recoverable failure here -- a conflict date must never let this stage (or the overall run)
    // report COMPLETE while `HistoricalCandle` and the incoming provider content still disagree.
    const hasRecoverableFailures =
      result.sessions.incomplete.length > 0 ||
      result.sessions.invalid.length > 0 ||
      result.sessions.unresolvedNoData.length > 0 ||
      result.sessions.sourceConflict.length > 0 ||
      result.failedChunks.length > 0;
    return {
      stageKind: ResearchYearRunStageKind.UNDERLYING_ACQUISITION,
      status: hasRecoverableFailures ? ResearchYearRunStageStatus.INCOMPLETE : ResearchYearRunStageStatus.COMPLETED,
      detail: hasRecoverableFailures
        ? `incomplete=${result.sessions.incomplete.length} invalid=${result.sessions.invalid.length} unresolvedNoData=${result.sessions.unresolvedNoData.length} sourceConflict=${result.sessions.sourceConflict.length} failedChunks=${result.failedChunks.length} -- unresolvedNoData is neither a certified holiday nor a certified session, and sourceConflict means already-persisted content disagreed with the provider and was left unchanged; both are retried on the next run, never silently dropped or treated as healthy.`
        : null,
      acquisitionSummary: {
        healthyTradingDates,
        skippedReacquisition: false,
        alreadyComplete: result.sessions.alreadyComplete.length,
        newlyCompleted: result.sessions.newlyCompleted.length,
        normalizedWithExclusions: result.sessions.normalizedWithExclusions.length,
        incomplete: result.sessions.incomplete.length,
        invalid: result.sessions.invalid.length,
        unresolvedNoData: result.sessions.unresolvedNoData.length,
        sourceConflict: result.sessions.sourceConflict.length,
        failedChunks: result.failedChunks.length,
        retryCount: result.retryCount,
      },
      materialization: null,
    };
  }

  /**
   * Resolves whether UNDERLYING_ACQUISITION can safely skip re-invoking the
   * (provider-calling) B-F2 service this run (task correction section 3D).
   * Deliberately keyed on the PREVIOUS run's own certified-healthy dates
   * (`acquisitionSummary.healthyTradingDates`), never on the full Mon-Fri
   * candidate list -- a real NSE holiday inside the requested range would
   * otherwise never appear as a materialized session and would incorrectly
   * block every future resume attempt forever (the defect this corrects).
   *
   * Returns the previously-certified `healthyTradingDates` ONLY when ALL of
   * the following hold, otherwise returns `null` (never skip):
   *   1. the previous UNDERLYING_ACQUISITION stage itself reported COMPLETED
   *   2. that stage recorded ZERO unresolvedNoData/incomplete/invalid/
   *      failedChunks (task correction section 3D.4: "no unresolved
   *      required dates concealed by the checkpoint")
   *   3. the previous UNDERLYING_MATERIALIZATION stage COMPLETED and its
   *      recorded sessions cover every one of those certified healthy dates
   *      with a WRITTEN/SKIPPED_VERIFIED Parquet session and a
   *      COMPLETE_SESSION resample for every target timeframe
   *   4. that durable output re-verifies fresh against the CURRENT
   *      persisted store and Parquet storage (B-F5/B-F6 VERIFY, task
   *      section 13)
   * (5. the current plan's resolved range matches the previous run's is
   *      structurally guaranteed by the checkpoint path itself already
   *      being scoped to the identical `planSemanticIdentity`.)
   */
  private async tryResolveCleanUnderlyingSkip(previous: ResearchYearRunRecord | null): Promise<string[] | null> {
    const previousAcquisition = previous?.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION) ?? null;
    if (!previousAcquisition || previousAcquisition.status !== ResearchYearRunStageStatus.COMPLETED || !previousAcquisition.acquisitionSummary) return null;

    const summary = previousAcquisition.acquisitionSummary;
    const concealedUnresolvedCount =
      Number(summary.unresolvedNoData ?? 0) +
      Number(summary.incomplete ?? 0) +
      Number(summary.invalid ?? 0) +
      Number(summary.sourceConflict ?? 0) +
      Number(summary.failedChunks ?? 0);
    if (concealedUnresolvedCount > 0) return null;

    const healthyTradingDates = (summary.healthyTradingDates as string[] | undefined) ?? [];
    if (healthyTradingDates.length === 0) return null;

    const previousOutcome = this.previousInstrumentMaterialization(previous, ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, NIFTY_INDEX_INSTRUMENT_KEY);
    if (!previousOutcome?.datasetId || !this.allSessionsWritten(previousOutcome, healthyTradingDates)) return null;
    if (!(await this.tryRevalidateInstrument(ManifestDatasetKind.UNDERLYING_1M, previousOutcome.datasetId))) return null;

    return healthyTradingDates;
  }

  private async executeUnderlyingMaterialization(acquisitionResult: ResearchYearRunStageResult): Promise<ResearchYearRunStageResult> {
    const healthyTradingDates = ((acquisitionResult.acquisitionSummary?.healthyTradingDates as string[] | undefined) ?? []).slice();
    try {
      const outcome = await this.materializeInstrument({
        datasetKind: ManifestDatasetKind.UNDERLYING_1M,
        instrumentDescriptor: NIFTY_INDEX_INSTRUMENT_KEY,
        healthyTradingDates,
        generateManifest: async () => {
          // B-F5 CALENDAR FIX (task invariant A -- GAP 1): recovers the
          // authoritative calendar session windows for these already-determined
          // healthy trading dates so a SPECIAL_SESSION date's manifest health is
          // never scored against the fixed 375-row regular contract. Fails
          // closed (never produces a manifest) if calendar truth for any of
          // these dates is no longer a certified trading session.
          const calendarSessionWindows = await this.calendarSessionResolverService.resolveSessionWindowsForDates(healthyTradingDates);
          return this.manifestService.generateUnderlyingManifest({
            provider: HistoricalProviderId.UPSTOX,
            instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
            timeframe: NIFTY_UNDERLYING_TIMEFRAME,
            tradingDates: healthyTradingDates,
            calendarSessionWindows,
            gitRevision: this.gitRevision,
          });
        },
      });
      const failed = this.hasMaterializationFailures(outcome);
      return {
        stageKind: ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION,
        status: failed ? ResearchYearRunStageStatus.INCOMPLETE : ResearchYearRunStageStatus.COMPLETED,
        detail: failed ? 'One or more sessions failed Parquet export/verification or resampling; see materialization[0].sessions.' : null,
        acquisitionSummary: null,
        materialization: [outcome],
      };
    } catch (error) {
      return { stageKind: ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, status: ResearchYearRunStageStatus.FAILED, detail: error instanceof Error ? error.message : String(error), acquisitionSummary: null, materialization: null };
    }
  }

  // ---- OPTION CATALOG -------------------------------------------------------

  private async executeCatalogAcquisition(plan: ResearchYearRunPlan): Promise<ResearchYearRunStageResult> {
    const result = await this.resolveCatalogAcquisitionService().acquire({ fromDate: plan.fromDate, toDate: plan.toDate, dryRun: false });
    const hasFailures = result.failedExpiryYears.length > 0 || result.failedExpiries.length > 0;
    return {
      stageKind: ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION,
      status: hasFailures ? ResearchYearRunStageStatus.INCOMPLETE : ResearchYearRunStageStatus.COMPLETED,
      detail: hasFailures ? `failedExpiryYears=${result.failedExpiryYears.length} failedExpiries=${result.failedExpiries.length}` : null,
      acquisitionSummary: {
        expiriesAccepted: result.expiriesAccepted,
        parsedOptionContracts: result.parsedOptionContracts,
        newlyDiscovered: result.newlyDiscovered,
        enriched: result.enriched,
        alreadyKnown: result.alreadyKnown,
        metadataComplete: result.metadataComplete,
        metadataIncomplete: result.metadataIncomplete,
        failedExpiryYears: result.failedExpiryYears.length,
        failedExpiries: result.failedExpiries.length,
      },
      materialization: null,
    };
  }

  // ---- OPTION CANDLES -------------------------------------------------------

  private async executeOptionCandleAcquisition(stagePlan: ResearchYearRunPlanStage, previous: ResearchYearRunRecord | null): Promise<ResearchYearRunStageResult> {
    if (!this.optionCandleAcquisitionService) {
      return {
        stageKind: ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION,
        status: ResearchYearRunStageStatus.BLOCKED,
        detail:
          'No GrowwOptionCandleAcquisitionService configured for this run (constructing one requires a resolved Groww access token, which is the CLI entrypoint\'s responsibility). ' +
          'Pass one via ResearchYearRunnerServiceDependencies.optionCandleAcquisitionService.',
        acquisitionSummary: null,
        materialization: null,
      };
    }

    const requiredSessions = stagePlan.requiredOptionSessions ?? [];
    const byContract: Record<string, { healthyTradingDates: string[]; skippedReacquisition: boolean }> = {};
    let anyFailure = false;
    let authenticationStopped = false;

    for (const session of requiredSessions) {
      if (authenticationStopped) continue;

      const previousOutcome = this.previousInstrumentMaterialization(previous, ResearchYearRunStageKind.OPTION_MATERIALIZATION, session.providerContractId);
      if (previousOutcome?.datasetId && this.allSessionsWritten(previousOutcome, session.tradingDates)) {
        // eslint-disable-next-line no-await-in-loop -- one contract's revalidation/acquisition must complete before the next begins, matching B-F2/B-F4's own per-item ordering convention
        const revalidated = await this.tryRevalidateInstrument(ManifestDatasetKind.EXPIRED_OPTION_1M, previousOutcome.datasetId);
        if (revalidated) {
          byContract[session.providerContractId] = { healthyTradingDates: [...session.tradingDates], skippedReacquisition: true };
          continue;
        }
      }

      // B-F5 CALENDAR FIX (Terra HIGH defect correction): the SAME
      // authoritative calendar session windows already resolved for option
      // MANIFEST generation below (`materializeOptionContract`) must also
      // reach OPTION CANDLE ACQUISITION -- `GrowwOptionCandleAcquisitionService.acquire`
      // intentionally falls back to the fixed 375-row regular contract when
      // `calendarSessionWindows` is omitted, so a certified SPECIAL_SESSION
      // date requested here would otherwise be evaluated against the wrong
      // contract and never truthfully progress. Resolved for exactly
      // `session.tradingDates` (the requested set for this contract), fails
      // this stage closed (via the thrown error propagating out of this
      // method to `run()`'s stage try/catch) if any requested date is no
      // longer a certified trading session.
      // eslint-disable-next-line no-await-in-loop
      const calendarSessionWindows = await this.calendarSessionResolverService.resolveSessionWindowsForDates(session.tradingDates);
      // eslint-disable-next-line no-await-in-loop
      const result = await this.optionCandleAcquisitionService.acquire({ providerContractId: session.providerContractId, tradingDates: [...session.tradingDates], calendarSessionWindows, dryRun: false });
      const healthyTradingDates = [...result.sessions.alreadyComplete, ...result.sessions.newlyComplete].sort();
      if (result.sessions.invalid.length > 0 || result.sessions.providerUnavailable.length > 0 || result.authenticationFailed) anyFailure = true;
      if (result.authenticationFailed) authenticationStopped = true;
      byContract[session.providerContractId] = { healthyTradingDates, skippedReacquisition: false };
    }

    if (authenticationStopped) anyFailure = true;

    return {
      stageKind: ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION,
      status: anyFailure ? ResearchYearRunStageStatus.INCOMPLETE : ResearchYearRunStageStatus.COMPLETED,
      detail: anyFailure ? (authenticationStopped ? 'Stopped early: a Groww authentication failure was encountered.' : 'One or more contracts had invalid/provider-unavailable sessions; see acquisitionSummary.byContract.') : null,
      acquisitionSummary: { byContract },
      materialization: null,
    };
  }

  private async executeOptionMaterialization(acquisitionResult: ResearchYearRunStageResult): Promise<ResearchYearRunStageResult> {
    const byContract = (acquisitionResult.acquisitionSummary?.byContract as Record<string, { healthyTradingDates: string[] }> | undefined) ?? {};
    const outcomes: ResearchYearRunMaterializationInstrumentOutcome[] = [];
    try {
      for (const [providerContractId, entry] of Object.entries(byContract)) {
        // eslint-disable-next-line no-await-in-loop -- deterministic per-contract ordering matters for reproducible logging/failure attribution
        const outcome = await this.materializeOptionContract(providerContractId, entry.healthyTradingDates);
        outcomes.push(outcome);
      }
    } catch (error) {
      return { stageKind: ResearchYearRunStageKind.OPTION_MATERIALIZATION, status: ResearchYearRunStageStatus.FAILED, detail: error instanceof Error ? error.message : String(error), acquisitionSummary: null, materialization: outcomes.length > 0 ? outcomes : null };
    }
    const failed = outcomes.some((outcome) => this.hasMaterializationFailures(outcome));
    return {
      stageKind: ResearchYearRunStageKind.OPTION_MATERIALIZATION,
      status: failed ? ResearchYearRunStageStatus.INCOMPLETE : ResearchYearRunStageStatus.COMPLETED,
      detail: failed ? 'One or more contract sessions failed Parquet export/verification or resampling; see materialization[].sessions.' : null,
      acquisitionSummary: null,
      materialization: outcomes,
    };
  }

  private async materializeOptionContract(providerContractId: string, healthyTradingDates: readonly string[]): Promise<ResearchYearRunMaterializationInstrumentOutcome> {
    const dates = [...healthyTradingDates];
    if (dates.length === 0) {
      return { instrumentDescriptor: providerContractId, datasetId: null, datasetChecksum: null, sessions: [], skippedRevalidated: false };
    }
    const parsed = parseGrowwSymbol(providerContractId, { exchange: 'NSE', underlyingSymbol: 'NIFTY' });
    if (!parsed.ok || parsed.value.kind !== GrowwSymbolKind.OPTION) {
      throw new Error(`Cannot materialize '${providerContractId}': not a valid NSE NIFTY option symbol (${!parsed.ok ? parsed.failure.detail : 'parsed as a FUTURE'}).`);
    }
    const optionIdentity = parsed.value;
    return this.materializeInstrument({
      datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
      instrumentDescriptor: providerContractId,
      healthyTradingDates: dates,
      generateManifest: async () => {
        // B-F5 CALENDAR FIX (task invariant A/B -- GAP 1): same authoritative
        // calendar session windows lookup as the underlying path above --
        // EXPIRED_OPTION_1M manifests use the SAME certified calendar truth
        // (task invariant B), never a provider-specific shortcut.
        const calendarSessionWindows = await this.calendarSessionResolverService.resolveSessionWindowsForDates(dates);
        return this.manifestService.generateOptionManifest({
          provider: HistoricalProviderId.GROWW,
          providerContractId,
          optionType: optionIdentity.optionType,
          strikePrice: optionIdentity.strikePrice,
          expiry: optionIdentity.expiry,
          timeframe: '1minute',
          tradingDates: dates,
          calendarSessionWindows,
          gitRevision: this.gitRevision,
        });
      },
    });
  }

  // ---- shared materialization / revalidation primitives ---------------------

  private async materializeInstrument(input: {
    readonly datasetKind: ManifestDatasetKind;
    readonly instrumentDescriptor: string;
    readonly healthyTradingDates: readonly string[];
    readonly generateManifest: () => Promise<DatasetManifest>;
  }): Promise<ResearchYearRunMaterializationInstrumentOutcome> {
    if (input.healthyTradingDates.length === 0) {
      return { instrumentDescriptor: input.instrumentDescriptor, datasetId: null, datasetChecksum: null, sessions: [], skippedRevalidated: false };
    }
    const manifest = await input.generateManifest();
    this.persistManifestArtifact(manifest);
    const exportResult = await this.parquetExportService.exportDataset({ manifest, outputRoot: this.outputRoot });
    const sessions = await this.resampleExportedSessions(manifest, exportResult, input.instrumentDescriptor);
    return { instrumentDescriptor: input.instrumentDescriptor, datasetId: manifest.datasetId, datasetChecksum: manifest.datasetChecksum, sessions, skippedRevalidated: false };
  }

  private async resampleExportedSessions(manifest: DatasetManifest, exportResult: ParquetExportRunResult, instrumentKey: string): Promise<ResearchYearRunMaterializationSessionOutcome[]> {
    const exportByDate = new Map(exportResult.sessions.map((entry) => [entry.tradingDate, entry]));
    const outcomes: ResearchYearRunMaterializationSessionOutcome[] = [];
    for (const session of manifest.sessions) {
      const exportEntry = exportByDate.get(session.identity.tradingDate);
      const parquetStatus = exportEntry?.status ?? 'NOT_ATTEMPTED';
      const resamples: ResearchYearRunResampleOutcome[] = [];
      if (exportEntry && WRITTEN_STATUSES.has(exportEntry.status)) {
        const timeframe = session.identity.timeframe;
        const { start, end } = istTradingDayUtcBounds(session.identity.tradingDate);
        // eslint-disable-next-line no-await-in-loop -- deterministic per-session ordering for reproducible failure attribution, matching DatasetManifestService's own convention
        const rows =
          manifest.datasetKind === ManifestDatasetKind.UNDERLYING_1M
            ? await this.historicalCandleRepository.findRange(instrumentKey, timeframe, start, end)
            : await this.historicalOptionCandleLakeRepository.findRange(instrumentKey, timeframe, start, end);
        for (const targetTimeframe of RESAMPLE_TIMEFRAMES) {
          // B-F7 CALENDAR FIX (task invariant G): the SAME authoritative
          // calendar session windows the B-F5 manifest recorded for this
          // session (`session.calendarSessionWindows`) govern B-F7 bucket
          // anchoring/completeness here too -- a SPECIAL_SESSION date the
          // manifest already certified HEALTHY must never be re-evaluated by
          // the resampler against the fixed regular-session contract.
          const { candles, descriptor } = this.resamplerService.resampleSession({
            targetTimeframe,
            tradingDate: session.identity.tradingDate,
            sourceDatasetKind: manifest.datasetKind,
            sourceSessionIdentity: session.identity,
            sourceSessionContentChecksum: session.contentChecksum,
            sessionWindows: session.calendarSessionWindows,
            sourceRows: rows,
          });
          resamples.push({ targetTimeframe, status: descriptor.status, derivedBucketCount: candles.length, derivedContentChecksum: descriptor.derivedContentChecksum });
        }
      }
      outcomes.push({
        tradingDate: session.identity.tradingDate,
        datasetId: manifest.datasetId,
        datasetChecksum: manifest.datasetChecksum,
        sessionContentChecksum: session.contentChecksum,
        persistedCanonicalHealthStatus: session.persistedCanonicalHealthStatus,
        parquetStatus,
        resamples,
      });
    }
    return outcomes;
  }

  private hasMaterializationFailures(outcome: ResearchYearRunMaterializationInstrumentOutcome): boolean {
    return outcome.sessions.some((session) => !WRITTEN_STATUSES.has(session.parquetStatus) || session.resamples.some((resample) => resample.status !== ResampleSessionStatus.COMPLETE_SESSION));
  }

  private previousInstrumentMaterialization(
    previous: ResearchYearRunRecord | null,
    materializationStageKind: ResearchYearRunStageKind,
    instrumentDescriptor: string
  ): ResearchYearRunMaterializationInstrumentOutcome | null {
    const stage = previous?.stages.find((entry) => entry.stageKind === materializationStageKind) ?? null;
    if (!stage || stage.status !== ResearchYearRunStageStatus.COMPLETED || !stage.materialization) return null;
    return stage.materialization.find((entry) => entry.instrumentDescriptor === instrumentDescriptor) ?? null;
  }

  private allSessionsWritten(outcome: ResearchYearRunMaterializationInstrumentOutcome, requiredDates: readonly string[]): boolean {
    if (requiredDates.length === 0) return false;
    const byDate = new Map(outcome.sessions.map((session) => [session.tradingDate, session]));
    return requiredDates.every((date) => {
      const session = byDate.get(date);
      return session !== undefined && WRITTEN_STATUSES.has(session.parquetStatus) && session.resamples.every((resample) => resample.status === ResampleSessionStatus.COMPLETE_SESSION);
    });
  }

  /**
   * Revalidates a previously-materialized instrument BEFORE trusting a
   * checkpoint's `COMPLETED` marker enough to skip re-acquisition (task
   * section 13): reloads the STORED B-F5 manifest artifact and recomputes
   * its checksums fresh from the CURRENT persisted store
   * (`DatasetManifestService.verifyManifest`), then reloads the STORED B-F6
   * storage descriptor and recomputes physical + logical checksums fresh
   * from the CURRENT Parquet files (`ResearchLakeParquetVerifyService.
   * verifyStorageDescriptor`). A missing artifact, an unparseable artifact, a
   * manifest that fails `assertManifestSchemaCompatible` (B-F2D correction:
   * incompatible/future schema version, or an unknown provenance enum
   * value), or ANY verification mismatch returns `false` -- never a false
   * skip (task section 13/16.T-X).
   */
  private async tryRevalidateInstrument(datasetKind: ManifestDatasetKind, datasetId: string): Promise<boolean> {
    const manifestPath = join(this.manifestArtifactRoot, datasetKind, `${datasetId}.json`);
    if (!fileExists(manifestPath)) return false;
    let storedManifest: DatasetManifest;
    try {
      storedManifest = JSON.parse(readFileBuffer(manifestPath).toString('utf8')) as DatasetManifest;
      // B-F2D CORRECTION (manifest wire-contract versioning): a stored
      // artifact this reader cannot safely interpret (future schema version,
      // unsupported ancient version, unknown provenance enum) must never be
      // trusted enough to skip re-acquisition -- treated identically to an
      // unparseable artifact (fail closed, force real re-acquisition below).
      assertManifestSchemaCompatible(storedManifest);
    } catch {
      return false;
    }
    const manifestVerify = await this.manifestService.verifyManifest(storedManifest);
    if (!manifestVerify.verified) return false;

    const descriptorPath = join(this.outputRoot, parquetStorageManifestRelativePath(storedManifest.datasetKind, storedManifest.datasetChecksum));
    if (!fileExists(descriptorPath)) return false;
    let descriptor: ParquetDatasetStorageDescriptor;
    try {
      descriptor = JSON.parse(readFileBuffer(descriptorPath).toString('utf8')) as ParquetDatasetStorageDescriptor;
    } catch {
      return false;
    }
    const parquetVerify = await this.parquetVerifyService.verifyStorageDescriptor({ descriptor, manifest: storedManifest, storageRoot: this.outputRoot });
    return parquetVerify.verified;
  }

  /**
   * Lazily constructs the default `NiftyUnderlyingAcquisitionService` on
   * first use rather than eagerly in the constructor -- constructing it
   * unconditionally would attempt to build an Upstox-backed provider even
   * for a run whose `scope` never touches the UNDERLYING stage at all.
   */
  private resolveUnderlyingAcquisitionService(): NiftyUnderlyingAcquisitionService {
    if (!this.underlyingAcquisitionService) this.underlyingAcquisitionService = new NiftyUnderlyingAcquisitionService();
    return this.underlyingAcquisitionService;
  }

  /**
   * Lazily constructs the default `NiftyHistoricalContractCatalogAcquisitionService`
   * on first use for the same reason: its default construction chain requires
   * `GROWW_ACCESS_TOKEN` to be configured (`GrowwHistoricalClient`'s
   * constructor), which must never be a precondition for a UNDERLYING-only
   * run. A construction failure here surfaces as this stage's own `FAILED`
   * result (caught by `run()`'s existing per-stage try/catch), never as an
   * unhandled crash of the whole runner.
   */
  private resolveCatalogAcquisitionService(): NiftyHistoricalContractCatalogAcquisitionService {
    if (!this.catalogAcquisitionService) this.catalogAcquisitionService = new NiftyHistoricalContractCatalogAcquisitionService();
    return this.catalogAcquisitionService;
  }

  private persistManifestArtifact(manifest: DatasetManifest): void {
    const path = join(this.manifestArtifactRoot, manifest.datasetKind, `${manifest.datasetId}.json`);
    writeBufferAtomic(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }
}
