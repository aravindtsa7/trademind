import { ResearchYearRunOutcome, ResearchYearRunRecord, ResearchYearRunStageStatus } from '../domain/research-year-run.types';

/**
 * B-F8 CLI exit-code policy (task correction section 4), kept as a small,
 * separately-testable pure function rather than buried inline in the CLI's
 * `run()` -- deliberately NOT `if (!dryRun && outcome !== COMPLETE) exit 1`,
 * which would let a structurally BLOCKED plan report success merely because
 * it was a dry run.
 *
 * Rules:
 *   - ANY `FAILED` stage (an invariant/identity/checksum violation) -> 1,
 *     dry-run or not: a dry-run never reaches `FAILED` today (it never
 *     executes), but the check is unconditional so this policy stays
 *     correct if that ever changes.
 *   - ANY `BLOCKED` stage -> 1, dry-run or not: a dry-run that PROVES the
 *     requested execution plan cannot currently be completed (task section
 *     7's strategy-universe gap, or a missing Groww provider) must never
 *     exit 0 merely because nothing was actually executed.
 *   - A dry-run with no FAILED/BLOCKED stage -> 0: every in-scope stage is
 *     `PLANNED` (or out-of-scope stages are `SKIPPED_NOT_IN_SCOPE`) --
 *     successfully proving a valid, executable plan is itself success, and
 *     dry-run intentionally never requires stages to reach `COMPLETED`.
 *   - A real execution -> 0 iff `record.outcome === COMPLETE`.
 *
 * Invalid input / a `ResearchYearPlanService`/`ResearchYearRunnerService`
 * exception is NOT this function's concern -- the CLI's own top-level
 * `run().catch()` already sets a non-zero exit code for any thrown error
 * before a `ResearchYearRunRecord` even exists to pass in here.
 */
export function determineResearchYearRunCliExitCode(record: ResearchYearRunRecord, dryRun: boolean): 0 | 1 {
  if (record.stages.some((stage) => stage.status === ResearchYearRunStageStatus.FAILED)) return 1;
  if (record.stages.some((stage) => stage.status === ResearchYearRunStageStatus.BLOCKED)) return 1;
  if (dryRun) return 0;
  return record.outcome === ResearchYearRunOutcome.COMPLETE ? 0 : 1;
}
