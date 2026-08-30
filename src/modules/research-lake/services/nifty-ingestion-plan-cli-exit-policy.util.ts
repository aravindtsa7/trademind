import { NiftyIngestionPlan } from './nifty-underlying-ingestion-planner.service';

/**
 * B-F2-CAL-1 plan-only CLI exit-code policy, kept as a small, separately
 * testable pure function (mirrors `determineResearchYearRunCliExitCode`'s
 * convention -- see `research-year-run-cli-exit-policy.util.ts`).
 *
 * Fail-closed by design (task section 23): a plan is never reported "ready"
 * merely because the command completed without throwing. Any
 * `BLOCKED_UNCERTIFIED` date means authoritative calendar truth is missing
 * for part of the requested range, so the plan cannot be treated as an
 * execution-ready plan -- exit non-zero regardless of how many dates were
 * successfully classified.
 */
export function determineNiftyIngestionPlanCliExitCode(plan: NiftyIngestionPlan): 0 | 1 {
  return plan.hasBlockedDates ? 1 : 0;
}
