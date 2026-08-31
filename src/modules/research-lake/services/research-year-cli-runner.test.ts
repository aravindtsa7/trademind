import assert from 'node:assert/strict';
import test from 'node:test';
import { runResearchYearCli, ResearchYearCliDependencies } from './research-year-cli-runner';
import GrowwOptionCandleAcquisitionService from './groww-option-candle-acquisition.service';
import ResearchYearRunnerService, { ResearchYearRunnerServiceDependencies } from './research-year-runner.service';
import { ResearchYearRunRecord, ResearchYearRunScope, ResearchYearRunStageStatus } from '../domain/research-year-run.types';

/**
 * B-F2-CAL-3-FIX-1 regression coverage: Terra's independent review found
 * `src/tests/research-year-runner.ts` resolved a Groww access token (a real
 * network call, via `GrowwAccessTokenProviderService.getAccessToken()`)
 * BEFORE `ResearchYearRunnerService.run({ dryRun: true })` was ever reached
 * -- so `RESEARCH_DRY_RUN=true` with `RESEARCH_YEAR_SCOPE=OPTIONS`/`ALL`
 * still made a real network call during CLI setup, even though the
 * SERVICE's own dry-run short-circuit (already proven by
 * `research-year-runner.service.test.ts`'s "(K/L)" test) was fully
 * network-free.
 *
 * A test that only calls `ResearchYearRunnerService.run({ dryRun: true })`
 * cannot catch this defect -- it already passed. These tests instead
 * exercise `runResearchYearCli`, the exact pre-run dependency-construction
 * boundary Terra identified, with a THROWING fake for
 * `buildOptionCandleAcquisitionService` (the CLI's Groww token/provider
 * resolution seam) to prove it is never invoked during a dry run, for
 * every scope.
 */

function fixedGitRevision(): string {
  return 'deadbeefcafefeed';
}

function throwingOptionServiceBuilder(callCounter: { count: number }): ResearchYearCliDependencies['buildOptionCandleAcquisitionService'] {
  return async () => {
    callCounter.count += 1;
    throw new Error('NETWORK_CALLED_DURING_YEAR_DRY_RUN');
  };
}

function assertOnlyPlannedOrBlockedOrOutOfScope(record: ResearchYearRunRecord): void {
  for (const stage of record.stages) {
    assert.ok(
      [ResearchYearRunStageStatus.SKIPPED_NOT_IN_SCOPE, ResearchYearRunStageStatus.PLANNED, ResearchYearRunStageStatus.BLOCKED].includes(stage.status),
      `dry-run stage ${stage.stageKind} unexpectedly reached status ${stage.status} -- a dry run must never execute a stage`
    );
  }
}

// ---- A/B/C: dry-run never resolves/constructs the option acquisition dependency, for every scope ----

test('A: YEAR CLI DRY-RUN + UNDERLYING -- zero token/provider resolution, deterministic dry-run result still produced', async () => {
  const counter = { count: 0 };
  const result = await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.UNDERLYING, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: true },
    { buildOptionCandleAcquisitionService: throwingOptionServiceBuilder(counter), resolveGitRevision: fixedGitRevision }
  );

  assert.equal(counter.count, 0);
  assert.equal(result.record.plan.scope, ResearchYearRunScope.UNDERLYING);
  assertOnlyPlannedOrBlockedOrOutOfScope(result.record);
  assert.ok(result.checkpointPath.length > 0);
});

test('B: YEAR CLI DRY-RUN + OPTIONS -- zero Groww token/provider resolution, option acquisition never invoked, dry-run completes truthfully', async () => {
  const counter = { count: 0 };
  const result = await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.OPTIONS, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: true },
    { buildOptionCandleAcquisitionService: throwingOptionServiceBuilder(counter), resolveGitRevision: fixedGitRevision }
  );

  assert.equal(counter.count, 0, 'buildOptionCandleAcquisitionService (Groww token/provider resolution) must never be invoked during a dry run');
  assert.equal(result.record.plan.scope, ResearchYearRunScope.OPTIONS);
  assertOnlyPlannedOrBlockedOrOutOfScope(result.record);
  assert.ok(result.checkpointPath.length > 0);
});

test('C: YEAR CLI DRY-RUN + ALL -- zero Groww token resolution, zero option/underlying acquisition, truthful dry-run plan/result', async () => {
  const counter = { count: 0 };
  const result = await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.ALL, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: true },
    { buildOptionCandleAcquisitionService: throwingOptionServiceBuilder(counter), resolveGitRevision: fixedGitRevision }
  );

  assert.equal(counter.count, 0);
  assert.equal(result.record.plan.scope, ResearchYearRunScope.ALL);
  assertOnlyPlannedOrBlockedOrOutOfScope(result.record);
  // No acquisition stage may report COMPLETED/INCOMPLETE/FAILED for a dry run -- those statuses only ever
  // result from `executeStage` actually running, which the service's dry-run branch returns before reaching.
  for (const stage of result.record.stages) {
    assert.notEqual(stage.status, ResearchYearRunStageStatus.COMPLETED);
    assert.notEqual(stage.status, ResearchYearRunStageStatus.INCOMPLETE);
    assert.notEqual(stage.status, ResearchYearRunStageStatus.FAILED);
  }
  assert.ok(result.checkpointPath.length > 0);
});

// ---- D/E: dryRun=false regression -- the option dependency path must still behave exactly as before ----

const FAKE_RECORD = {
  schemaVersion: 1,
  semanticsVersion: 1,
  plan: { fromDate: '2022-01-01', toDate: '2022-01-10', scope: ResearchYearRunScope.OPTIONS, planSemanticIdentity: 'fake-plan-identity' },
  outcome: 'COMPLETE',
  stages: [],
  startedAt: '2022-01-01T00:00:00.000Z',
  completedAt: '2022-01-01T00:00:01.000Z',
} as unknown as ResearchYearRunRecord;

class FakeRunnerForCli {
  calls: { year: number; fromDate?: string; toDate?: string; scope: ResearchYearRunScope; dryRun?: boolean }[] = [];
  constructor(private readonly record: ResearchYearRunRecord, private readonly checkpointPathValue: string) {}
  async run(request: { year: number; fromDate?: string; toDate?: string; scope: ResearchYearRunScope; dryRun?: boolean }): Promise<ResearchYearRunRecord> {
    this.calls.push(request);
    return this.record;
  }
  checkpointPath(): string {
    return this.checkpointPathValue;
  }
}

test('D: NORMAL OPTIONS NON-DRY REGRESSION -- option-service construction still happens and its result reaches the runner unchanged', async () => {
  let builderCalls = 0;
  let observedScope: ResearchYearRunScope | null = null;
  const fakeOptionService = { marker: 'fake-groww-option-service' } as unknown as GrowwOptionCandleAcquisitionService;
  const fakeRunner = new FakeRunnerForCli(FAKE_RECORD, 'artifacts/fake/options-checkpoint.json');
  const captured: { deps: ResearchYearRunnerServiceDependencies | null } = { deps: null };

  const result = await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.OPTIONS, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: false },
    {
      buildOptionCandleAcquisitionService: async (scope) => {
        builderCalls += 1;
        observedScope = scope;
        return fakeOptionService;
      },
      resolveGitRevision: fixedGitRevision,
      createRunner: (deps: ResearchYearRunnerServiceDependencies) => {
        captured.deps = deps;
        return fakeRunner as unknown as Pick<ResearchYearRunnerService, 'run' | 'checkpointPath'>;
      },
    }
  );

  assert.equal(builderCalls, 1, 'a real (non-dry) OPTIONS run must still construct the option acquisition dependency exactly once');
  assert.equal(observedScope, ResearchYearRunScope.OPTIONS);
  assert.equal(captured.deps?.optionCandleAcquisitionService, fakeOptionService, 'the builder result must reach the runner dependencies unchanged');
  assert.equal(captured.deps?.gitRevision, 'deadbeefcafefeed');
  assert.equal(fakeRunner.calls.length, 1);
  assert.equal(fakeRunner.calls[0].dryRun, false);
  assert.equal(result.record, FAKE_RECORD);
  assert.equal(result.checkpointPath, 'artifacts/fake/options-checkpoint.json');
});

test('E: NORMAL ALL NON-DRY REGRESSION -- required acquisition dependency construction is unchanged for ALL scope', async () => {
  let builderCalls = 0;
  let observedScope: ResearchYearRunScope | null = null;
  const fakeOptionService = { marker: 'fake-groww-option-service' } as unknown as GrowwOptionCandleAcquisitionService;
  const fakeRunner = new FakeRunnerForCli(FAKE_RECORD, 'artifacts/fake/all-checkpoint.json');
  const captured: { deps: ResearchYearRunnerServiceDependencies | null } = { deps: null };

  const result = await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.ALL, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: false },
    {
      buildOptionCandleAcquisitionService: async (scope) => {
        builderCalls += 1;
        observedScope = scope;
        return fakeOptionService;
      },
      resolveGitRevision: fixedGitRevision,
      createRunner: (deps: ResearchYearRunnerServiceDependencies) => {
        captured.deps = deps;
        return fakeRunner as unknown as Pick<ResearchYearRunnerService, 'run' | 'checkpointPath'>;
      },
    }
  );

  assert.equal(builderCalls, 1, 'a real (non-dry) ALL run must still construct the option acquisition dependency exactly once');
  assert.equal(observedScope, ResearchYearRunScope.ALL);
  assert.equal(captured.deps?.optionCandleAcquisitionService, fakeOptionService);
  assert.equal(fakeRunner.calls.length, 1);
  assert.equal(fakeRunner.calls[0].dryRun, false);
  assert.equal(result.record, FAKE_RECORD);
});

test('non-dry UNDERLYING scope still delegates to the option-service builder exactly as before this fix -- scope gating stays the builder\'s own responsibility, only dryRun gating was added', async () => {
  let builderCalls = 0;
  let observedScope: ResearchYearRunScope | null = null;
  const fakeRunner = new FakeRunnerForCli(FAKE_RECORD, 'artifacts/fake/underlying-checkpoint.json');

  await runResearchYearCli(
    { year: 2022, scope: ResearchYearRunScope.UNDERLYING, fromDate: '2022-01-01', toDate: '2022-01-10', dryRun: false },
    {
      buildOptionCandleAcquisitionService: async (scope) => {
        builderCalls += 1;
        observedScope = scope;
        return null; // mirrors the real tryBuildOptionCandleAcquisitionService's own UNDERLYING-scope no-op
      },
      resolveGitRevision: fixedGitRevision,
      createRunner: () => fakeRunner as unknown as Pick<ResearchYearRunnerService, 'run' | 'checkpointPath'>,
    }
  );

  // `runResearchYearCli` only added the dryRun gate; it never re-implements scope gating itself -- that
  // decision is, unchanged, entirely the injected builder's own responsibility (see the real
  // `tryBuildOptionCandleAcquisitionService`, which returns null immediately for UNDERLYING scope).
  assert.equal(builderCalls, 1);
  assert.equal(observedScope, ResearchYearRunScope.UNDERLYING);
});
