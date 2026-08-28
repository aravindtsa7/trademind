import assert from 'node:assert/strict';
import test from 'node:test';
import { determineResearchYearRunCliExitCode } from './research-year-run-cli-exit-policy.util';
import {
  ResearchYearRunOutcome,
  ResearchYearRunPlan,
  ResearchYearRunRecord,
  ResearchYearRunScope,
  ResearchYearRunStageKind,
  ResearchYearRunStageResult,
  ResearchYearRunStageStatus,
  RESEARCH_YEAR_RUN_SCHEMA_VERSION,
  RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
} from '../domain/research-year-run.types';

function fakePlan(scope: ResearchYearRunScope = ResearchYearRunScope.UNDERLYING): ResearchYearRunPlan {
  return {
    schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
    semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
    year: 2022,
    fromDate: '2022-01-01',
    toDate: '2022-12-31',
    scope,
    planSemanticIdentity: 'fake',
    stages: [],
  };
}

function stage(stageKind: ResearchYearRunStageKind, status: ResearchYearRunStageStatus): ResearchYearRunStageResult {
  return { stageKind, status, detail: null, acquisitionSummary: null, materialization: null };
}

function fakeRecord(outcome: ResearchYearRunOutcome, stages: ResearchYearRunStageResult[], scope: ResearchYearRunScope = ResearchYearRunScope.UNDERLYING): ResearchYearRunRecord {
  return {
    schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
    semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
    plan: fakePlan(scope),
    outcome,
    stages,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:01:00.000Z',
  };
}

test('(A) a valid UNDERLYING dry-run whose stages are all PLANNED/SKIPPED_NOT_IN_SCOPE exits 0', () => {
  const record = fakeRecord(ResearchYearRunOutcome.INCOMPLETE, [
    stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.PLANNED),
    stage(ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, ResearchYearRunStageStatus.PLANNED),
    stage(ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION, ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE),
    stage(ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION, ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE),
    stage(ResearchYearRunStageKind.OPTION_MATERIALIZATION, ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE),
  ]);
  assert.equal(determineResearchYearRunCliExitCode(record, true), 0);
});

test('(B) an OPTIONS dry-run with the strategy-universe resolver BLOCKED exits non-zero', () => {
  const record = fakeRecord(
    ResearchYearRunOutcome.INCOMPLETE,
    [
      stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE),
      stage(ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE),
      stage(ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION, ResearchYearRunStageStatus.PLANNED),
      stage(ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION, ResearchYearRunStageStatus.BLOCKED),
      stage(ResearchYearRunStageKind.OPTION_MATERIALIZATION, ResearchYearRunStageStatus.BLOCKED),
    ],
    ResearchYearRunScope.OPTIONS
  );
  assert.equal(determineResearchYearRunCliExitCode(record, true), 1);
});

test('(C) an ALL dry-run with the same strategy-universe blocker exits non-zero', () => {
  const record = fakeRecord(
    ResearchYearRunOutcome.INCOMPLETE,
    [
      stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.PLANNED),
      stage(ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, ResearchYearRunStageStatus.PLANNED),
      stage(ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION, ResearchYearRunStageStatus.PLANNED),
      stage(ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION, ResearchYearRunStageStatus.BLOCKED),
      stage(ResearchYearRunStageKind.OPTION_MATERIALIZATION, ResearchYearRunStageStatus.BLOCKED),
    ],
    ResearchYearRunScope.ALL
  );
  assert.equal(determineResearchYearRunCliExitCode(record, true), 1);
});

// (D) invalid current-year same-day toDate is validated by ResearchYearPlanService.buildPlan() BEFORE any
// ResearchYearRunRecord exists -- see research-year-plan.service.test.ts's "(SAFE-END A)" test, and the CLI's
// own top-level `run().catch(() => { process.exitCode = 1; })`. There is no record for this policy function
// to evaluate in that case, so it is proven at the plan-validation layer, not here.

test('(E) a real (non-dry-run) execution with outcome COMPLETE exits 0', () => {
  const record = fakeRecord(ResearchYearRunOutcome.COMPLETE, [stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.COMPLETED)]);
  assert.equal(determineResearchYearRunCliExitCode(record, false), 0);
});

test('(F) a real (non-dry-run) execution with outcome INCOMPLETE exits non-zero', () => {
  const record = fakeRecord(ResearchYearRunOutcome.INCOMPLETE, [stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.INCOMPLETE)]);
  assert.equal(determineResearchYearRunCliExitCode(record, false), 1);
});

test('(G) a real (non-dry-run) execution with outcome FAILED exits non-zero', () => {
  const record = fakeRecord(ResearchYearRunOutcome.FAILED, [
    stage(ResearchYearRunStageKind.UNDERLYING_ACQUISITION, ResearchYearRunStageStatus.COMPLETED),
    stage(ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, ResearchYearRunStageStatus.FAILED),
  ]);
  assert.equal(determineResearchYearRunCliExitCode(record, false), 1);
});

test('a FAILED stage forces a non-zero exit even during a dry-run (defensive -- FAILED is not reachable from a real dry-run today, but the policy must not silently trust it)', () => {
  const record = fakeRecord(ResearchYearRunOutcome.FAILED, [stage(ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION, ResearchYearRunStageStatus.FAILED)]);
  assert.equal(determineResearchYearRunCliExitCode(record, true), 1);
});

test('a dry-run with zero stages at all (defensive) exits 0', () => {
  const record = fakeRecord(ResearchYearRunOutcome.COMPLETE, []);
  assert.equal(determineResearchYearRunCliExitCode(record, true), 0);
});
