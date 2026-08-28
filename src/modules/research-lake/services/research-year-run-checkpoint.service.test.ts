import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ResearchYearRunCheckpointService from './research-year-run-checkpoint.service';
import { ResearchYearRunOutcome, ResearchYearRunPlan, ResearchYearRunRecord, ResearchYearRunScope, ResearchYearRunStageStatus, RESEARCH_YEAR_RUN_SCHEMA_VERSION, RESEARCH_YEAR_RUN_SEMANTICS_VERSION } from '../domain/research-year-run.types';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf8-checkpoint-'));
}

function fakePlan(overrides: Partial<ResearchYearRunPlan> = {}): ResearchYearRunPlan {
  return {
    schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
    semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
    year: 2022,
    fromDate: '2022-01-01',
    toDate: '2022-12-31',
    scope: ResearchYearRunScope.UNDERLYING,
    planSemanticIdentity: 'abc123',
    stages: [],
    ...overrides,
  };
}

function fakeRecord(plan: ResearchYearRunPlan): ResearchYearRunRecord {
  return {
    schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
    semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
    plan,
    outcome: ResearchYearRunOutcome.COMPLETE,
    stages: [],
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:01:00.000Z',
  };
}

test('load() returns null when no checkpoint exists yet for this exact plan identity', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    assert.equal(service.load(fakePlan()), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save() then load() round-trips the exact record, and the checkpoint path is deterministic given identical plan identity', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    const plan = fakePlan();
    const record = fakeRecord(plan);
    service.save(record);

    const pathA = service.checkpointPath(plan);
    const pathB = service.checkpointPath(fakePlan());
    assert.equal(pathA, pathB);
    assert.ok(existsSync(pathA));

    const loaded = service.load(plan);
    assert.deepEqual(loaded, record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different planSemanticIdentity resolves to a different checkpoint path (collision-safe)', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    const pathA = service.checkpointPath(fakePlan({ planSemanticIdentity: 'aaa' }));
    const pathB = service.checkpointPath(fakePlan({ planSemanticIdentity: 'bbb' }));
    assert.notEqual(pathA, pathB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(Y) an atomic checkpoint write leaves no stray temp file behind on success', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    const plan = fakePlan();
    service.save(fakeRecord(plan));
    const directory = join(root, plan.scope);
    const leftover = readdirSync(directory).filter((entry) => entry.endsWith('.tmp'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(Z/AA) a second save() overwrites the checkpoint atomically -- no stray temp file, and the final content always matches the LAST successful save', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    const plan = fakePlan();
    const first = fakeRecord(plan);
    const second: ResearchYearRunRecord = { ...fakeRecord(plan), outcome: ResearchYearRunOutcome.INCOMPLETE };
    service.save(first);
    service.save(second);
    const loaded = service.load(plan);
    assert.equal(loaded?.outcome, ResearchYearRunOutcome.INCOMPLETE);
    const directory = join(root, plan.scope);
    const leftover = readdirSync(directory).filter((entry) => entry.endsWith('.tmp'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run record loaded back preserves stage status enums exactly (round-trip fidelity for resume logic)', () => {
  const root = tempDir();
  try {
    const service = new ResearchYearRunCheckpointService(root);
    const plan = fakePlan();
    const record: ResearchYearRunRecord = {
      ...fakeRecord(plan),
      stages: [{ stageKind: plan.stages[0]?.stageKind ?? ('UNDERLYING_ACQUISITION' as never), status: ResearchYearRunStageStatus.COMPLETED, detail: null, acquisitionSummary: { healthyTradingDates: ['2022-01-03'] }, materialization: null }],
    };
    service.save(record);
    const loaded = service.load(plan);
    assert.equal(loaded?.stages[0]?.status, ResearchYearRunStageStatus.COMPLETED);
    assert.deepEqual(loaded?.stages[0]?.acquisitionSummary, { healthyTradingDates: ['2022-01-03'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
