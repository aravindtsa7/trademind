import assert from 'node:assert/strict';
import test from 'node:test';
import ResearchYearPlanService, { UnavailableRequiredOptionSessionSource } from './research-year-plan.service';
import { RequiredOptionSession, RequiredOptionSessionSource, ResearchYearRunPlanBlockedCode, ResearchYearRunScope, ResearchYearRunStageKind, RESEARCH_YEAR_RUN_STAGE_ORDER } from '../domain/research-year-run.types';

const CLOCK_2026_08_28 = () => new Date('2026-08-28T10:00:00+05:30');

function underlyingOnly(overrides: Partial<Parameters<ResearchYearPlanService['buildPlan']>[0]> = {}) {
  return { year: 2022, scope: ResearchYearRunScope.UNDERLYING, ...overrides };
}

// ---- A/B/C/D/E: year/date resolution -------------------------------------

test('(A) a past year without an explicit range resolves Jan-01..Dec-31', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022 }));
  assert.equal(plan.fromDate, '2022-01-01');
  assert.equal(plan.toDate, '2022-12-31');
});

test('(B) the current calendar year without an explicit toDate is rejected before any side effects', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2026 })), /requires an explicit toDate for the current calendar year/);
});

test('(C) the current calendar year with an explicit, safe (not-in-the-future) toDate succeeds in planning', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2026, toDate: '2026-08-27' }));
  assert.equal(plan.fromDate, '2026-01-01');
  assert.equal(plan.toDate, '2026-08-27');
});

// ---- CURRENT-YEAR SAFE-END (task correction section 1) --------------------
// A trading day's complete Upstox 1m historical data is reliably usable only
// from the NEXT MORNING -- so for the current calendar year, toDate must be
// STRICTLY EARLIER than today's IST calendar date. toDate === todayIst is
// rejected exactly like toDate > todayIst; only toDate <= yesterday is safe.

test('(SAFE-END A) current-year toDate === todayIst is rejected BEFORE any side effect', async () => {
  const calls: unknown[] = [];
  class SpyingSource implements RequiredOptionSessionSource {
    async resolve(range: unknown): Promise<readonly RequiredOptionSession[]> {
      calls.push(range);
      return [];
    }
  }
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new SpyingSource() });
  await assert.rejects(
    () => service.buildPlan({ year: 2026, scope: ResearchYearRunScope.ALL, toDate: '2026-08-28' }),
    /intentionally excluded because prior-day historical availability is the safe boundary/
  );
  assert.equal(calls.length, 0, 'a rejected same-day toDate must never reach the RequiredOptionSessionSource (or any other side effect)');
});

test('(SAFE-END B) current-year toDate > todayIst is rejected', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(
    () => service.buildPlan(underlyingOnly({ year: 2026, toDate: '2026-09-01' })),
    /intentionally excluded because prior-day historical availability is the safe boundary/
  );
});

test('(SAFE-END C) current-year toDate === yesterday\'s IST calendar date is accepted for planning', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2026, toDate: '2026-08-27' }));
  assert.equal(plan.toDate, '2026-08-27');
});

test('(SAFE-END D) current-year with a missing toDate is rejected', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2026 })), /requires an explicit toDate for the current calendar year/);
});

test('(SAFE-END E) past-year default behavior is unchanged by the safe-end correction', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022 }));
  assert.equal(plan.fromDate, '2022-01-01');
  assert.equal(plan.toDate, '2022-12-31');
});

test('(SAFE-END F) no hardcoded "2026" in production logic -- the safe-end boundary tracks whatever the injected clock reports as "today"', async () => {
  const service = new ResearchYearPlanService({ now: () => new Date('2031-03-15T10:00:00+05:30') });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2031, toDate: '2031-03-15' })), /intentionally excluded/);
  const plan = await service.buildPlan(underlyingOnly({ year: 2031, toDate: '2031-03-14' }));
  assert.equal(plan.toDate, '2031-03-14');
});

test('(D) fromDate/toDate must belong to the requested year', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2022, fromDate: '2021-12-15', toDate: '2022-01-15' })), /belong to the requested year/);
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-12-15', toDate: '2023-01-15' })), /belong to the requested year/);
});

test('(E) fromDate must not be after toDate', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-06-01', toDate: '2022-01-01' })), /fromDate .* <= toDate/);
});

test('a future year is rejected', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  await assert.rejects(() => service.buildPlan(underlyingOnly({ year: 2027 })), /rejects a future year/);
});

// ---- F/G: deterministic identity ------------------------------------------

test('(F) an identical request produces an identical semantic plan identity', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const planA = await service.buildPlan(underlyingOnly({ year: 2022 }));
  const planB = await service.buildPlan(underlyingOnly({ year: 2022 }));
  assert.equal(planA.planSemanticIdentity, planB.planSemanticIdentity);
});

test('(G) timestamps/durations never affect semantic identity -- two different injected clocks produce the same identity for a past year', async () => {
  const serviceA = new ResearchYearPlanService({ now: () => new Date('2026-08-28T09:00:00+05:30') });
  const serviceB = new ResearchYearPlanService({ now: () => new Date('2030-01-01T00:00:00+05:30') });
  const planA = await serviceA.buildPlan(underlyingOnly({ year: 2022 }));
  const planB = await serviceB.buildPlan(underlyingOnly({ year: 2022 }));
  assert.equal(planA.planSemanticIdentity, planB.planSemanticIdentity);
});

test('a different scope produces a different semantic identity', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const planUnderlying = await service.buildPlan(underlyingOnly({ year: 2022 }));
  const planAll = await service.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.ALL }));
  assert.notEqual(planUnderlying.planSemanticIdentity, planAll.planSemanticIdentity);
});

// ---- H/I: deterministic stage/date order -----------------------------------

test('(H) stage order is always the fixed RESEARCH_YEAR_RUN_STAGE_ORDER constant, regardless of scope', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.ALL }));
  assert.deepEqual(plan.stages.map((stage) => stage.stageKind), RESEARCH_YEAR_RUN_STAGE_ORDER);
});

test('(I) candidate dates are deterministic ascending weekdays, independent of any provider/input order', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-01-01', toDate: '2022-01-10' }));
  const stage = plan.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.UNDERLYING_ACQUISITION);
  assert.deepEqual(stage?.underlyingCandidateDates, ['2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06', '2022-01-07', '2022-01-10']);
  const sorted = [...(stage?.underlyingCandidateDates ?? [])].sort();
  assert.deepEqual(stage?.underlyingCandidateDates, sorted);
});

// ---- J: deterministic contract order ---------------------------------------

class FakeRequiredOptionSessionSource implements RequiredOptionSessionSource {
  constructor(private readonly sessions: readonly RequiredOptionSession[]) {}
  async resolve(): Promise<readonly RequiredOptionSession[]> {
    return this.sessions;
  }
}

test('(J) required option sessions are sorted by parsed contract identity, independent of source order', async () => {
  const shuffled: RequiredOptionSession[] = [
    { providerContractId: 'NSE-NIFTY-13Feb22-17500-CE', tradingDates: ['2022-02-01'] },
    { providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03'] },
    { providerContractId: 'NSE-NIFTY-06Jan22-17200-CE', tradingDates: ['2022-01-03'] },
  ];
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new FakeRequiredOptionSessionSource(shuffled) });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  const stage = plan.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
  assert.deepEqual(
    stage?.requiredOptionSessions?.map((session) => session.providerContractId),
    ['NSE-NIFTY-06Jan22-17200-CE', 'NSE-NIFTY-06Jan22-17200-PE', 'NSE-NIFTY-13Feb22-17500-CE']
  );
  assert.equal(stage?.blocked, false);
});

test('a reversed source order still produces the identical plan identity as the original order', async () => {
  const sessions: RequiredOptionSession[] = [
    { providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03', '2022-01-04'] },
    { providerContractId: 'NSE-NIFTY-13Feb22-17500-CE', tradingDates: ['2022-02-01'] },
  ];
  const serviceForward = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new FakeRequiredOptionSessionSource(sessions) });
  const serviceReversed = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new FakeRequiredOptionSessionSource([...sessions].reverse()) });
  const planForward = await serviceForward.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  const planReversed = await serviceReversed.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  assert.equal(planForward.planSemanticIdentity, planReversed.planSemanticIdentity);
});

// ---- section 7: strategy-universe blocker ----------------------------------

test('OPTIONS scope with the default UnavailableRequiredOptionSessionSource reports OPTION_CANDLE_ACQUISITION and OPTION_MATERIALIZATION as blocked, never fabricating a contract list', async () => {
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const plan = await service.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  const candleStage = plan.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
  const materializationStage = plan.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_MATERIALIZATION);
  assert.equal(candleStage?.blocked, true);
  assert.equal(candleStage?.blockedCode, ResearchYearRunPlanBlockedCode.REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE);
  assert.match(candleStage?.blockedReason ?? '', /STRATEGY-UNIVERSE BLOCKER/);
  assert.equal(candleStage?.requiredOptionSessions, null);
  assert.equal(materializationStage?.blocked, true);
  assert.equal(materializationStage?.blockedCode, ResearchYearRunPlanBlockedCode.REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE);
  // The catalog stage never depends on the strategy universe -- it is never blocked.
  const catalogStage = plan.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION);
  assert.equal(catalogStage?.blocked, false);
  assert.equal(catalogStage?.inScope, true);
});

test('UNDERLYING-only scope never consults the RequiredOptionSessionSource at all', async () => {
  let resolveCalls = 0;
  class CountingSource implements RequiredOptionSessionSource {
    async resolve(): Promise<readonly RequiredOptionSession[]> {
      resolveCalls += 1;
      return [];
    }
  }
  const service = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new CountingSource() });
  await service.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.UNDERLYING }));
  assert.equal(resolveCalls, 0);
});

test('UnavailableRequiredOptionSessionSource always throws with a descriptive message', async () => {
  await assert.rejects(() => new UnavailableRequiredOptionSessionSource().resolve(), /STRATEGY-UNIVERSE BLOCKER/);
});

// ---- DETERMINISTIC PLAN IDENTITY vs diagnostic text (task correction section 2) ----

class DynamicMessageBlockingSource implements RequiredOptionSessionSource {
  constructor(private readonly message: string) {}
  async resolve(): Promise<readonly RequiredOptionSession[]> {
    throw new Error(this.message);
  }
}

test('(IDENTITY-ADVERSARIAL) two runs whose RequiredOptionSessionSource throws DIFFERENT dynamic diagnostic text for the same semantic block produce the IDENTICAL planSemanticIdentity and checkpoint-path-relevant fields, with an identical deterministic blockedCode', async () => {
  const serviceRun1 = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new DynamicMessageBlockingSource('resolver unavailable at 12:00 path=C:\\foo') });
  const serviceRun2 = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: new DynamicMessageBlockingSource('resolver unavailable at 13:00 path=D:\\bar') });

  const planRun1 = await serviceRun1.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.ALL }));
  const planRun2 = await serviceRun2.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.ALL }));

  assert.equal(planRun1.planSemanticIdentity, planRun2.planSemanticIdentity, 'diagnostic wording must never perturb planSemanticIdentity');

  const candleStage1 = planRun1.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
  const candleStage2 = planRun2.stages.find((entry) => entry.stageKind === ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION);
  assert.equal(candleStage1?.blockedCode, ResearchYearRunPlanBlockedCode.REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE);
  assert.equal(candleStage1?.blockedCode, candleStage2?.blockedCode, 'the deterministic blockedCode must be identical across both runs');
  // The diagnostic text is legitimately free to differ -- it is observability only, never identity.
  assert.notEqual(candleStage1?.blockedReason, candleStage2?.blockedReason);
});

test('(IDENTITY-ADVERSARIAL) changing an actual semantic input (date range, scope, or required option sessions) still changes planSemanticIdentity', async () => {
  const baseService = new ResearchYearPlanService({ now: CLOCK_2026_08_28 });
  const basePlan = await baseService.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-01-01', toDate: '2022-01-31' }));

  const differentRangePlan = await baseService.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-01-01', toDate: '2022-02-28' }));
  assert.notEqual(basePlan.planSemanticIdentity, differentRangePlan.planSemanticIdentity);

  const differentScopePlan = await baseService.buildPlan(underlyingOnly({ year: 2022, fromDate: '2022-01-01', toDate: '2022-01-31', scope: ResearchYearRunScope.ALL }));
  assert.notEqual(basePlan.planSemanticIdentity, differentScopePlan.planSemanticIdentity);

  const sourceA = new FakeRequiredOptionSessionSource([{ providerContractId: 'NSE-NIFTY-06Jan22-17200-PE', tradingDates: ['2022-01-03'] }]);
  const sourceB = new FakeRequiredOptionSessionSource([{ providerContractId: 'NSE-NIFTY-06Jan22-17200-CE', tradingDates: ['2022-01-03'] }]);
  const serviceA = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: sourceA });
  const serviceB = new ResearchYearPlanService({ now: CLOCK_2026_08_28, requiredOptionSessionSource: sourceB });
  const planA = await serviceA.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  const planB = await serviceB.buildPlan(underlyingOnly({ year: 2022, scope: ResearchYearRunScope.OPTIONS }));
  assert.notEqual(planA.planSemanticIdentity, planB.planSemanticIdentity, 'a genuinely different required option session must still change identity');
});
