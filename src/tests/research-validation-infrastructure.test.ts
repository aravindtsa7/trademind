import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  ResearchHoldoutAccessError,
  ResearchMetricsService,
  PersistentHoldoutLedgerService,
  HoldoutAlreadyConsumedError,
  ResearchLedgerError,
  ResearchSplitService,
  deflatedSharpeRatio,
  evaluatePromotionGate,
  evaluateSelectedValidation,
  resultMatrix,
  selectTopKFromTrain,
  simplifiedPbo,
} from '../modules/research-validation';

const dates = Array.from({ length: 104 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 2, 2 + index));
  return date.toISOString().slice(0, 10);
});

test('chronological split has exact counts, ordered dates, and no overlap', () => {
  const manifest = new ResearchSplitService().createManifest(dates, { instrumentKey: 'NSE_INDEX|Nifty 50' });
  assert.deepEqual(manifest.sessions.slice(0, 3).map((session) => session.split), ['TRAIN', 'TRAIN', 'TRAIN']);
  assert.equal(manifest.sessions.filter((session) => session.split === 'TRAIN').length, 60);
  assert.equal(manifest.sessions.filter((session) => session.split === 'EMBARGO_1').length, 3);
  assert.equal(manifest.sessions.filter((session) => session.split === 'VALIDATION').length, 20);
  assert.equal(manifest.sessions.filter((session) => session.split === 'EMBARGO_2').length, 3);
  assert.equal(manifest.sessions.filter((session) => session.split === 'FINAL_HOLDOUT').length, 18);
  assert.deepEqual(manifest.sessions.map((session) => session.tradingDate), [...manifest.sessions].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate)).map((session) => session.tradingDate));
  assert.equal(new Set(manifest.sessions.map((session) => session.tradingDate)).size, 104);
});

test('holdout is denied by default and requires explicit authorization', () => {
  const service = new ResearchSplitService();
  const manifest = service.createManifest(dates, { instrumentKey: 'NSE_INDEX|Nifty 50' });
  const holdout = manifest.sessions.filter((session) => session.split === 'FINAL_HOLDOUT').map((session) => session.tradingDate);
  assert.throws(() => service.assertOutcomeAccess(manifest, holdout, 'FINAL_HOLDOUT_ONCE', false), ResearchHoldoutAccessError);
  assert.doesNotThrow(() => service.assertOutcomeAccess(manifest, holdout, 'FINAL_HOLDOUT_ONCE', true));
  assert.throws(() => service.assertOutcomeAccess(manifest, holdout, 'TRAIN_VALIDATION_ONLY'));
});

test('walk-forward rolling and expanding folds preserve chronology and embargo', () => {
  const service = new ResearchSplitService();
  const rolling = service.buildWalkForwardFolds(dates);
  const expanding = service.buildWalkForwardFolds(dates, { trainWindow: 50, validationWindow: 10, step: 10, embargo: 2, mode: 'EXPANDING' });
  assert.equal(rolling.length, 5);
  assert.equal(expanding.length, 5);
  rolling.forEach((fold) => {
    assert.equal(fold.train.length, 50);
    assert.equal(fold.embargo.length, 2);
    assert.equal(fold.validation.length, 10);
    assert.ok(fold.train.at(-1)!.tradingDate < fold.embargo[0].tradingDate);
    assert.ok(fold.embargo.at(-1)!.tradingDate < fold.validation[0].tradingDate);
  });
  assert.ok(expanding[1].train.length > expanding[0].train.length);
});

test('cross-boundary outcomes are purged', () => {
  const service = new ResearchSplitService();
  const allowed = new Set(['2026-03-02']);
  const result = service.purgeCrossBoundaryOutcomes([
    { tradingDate: '2026-03-02', resolutionDate: '2026-03-02' },
    { tradingDate: '2026-03-02', resolutionDate: '2026-03-03' },
  ], allowed);
  assert.equal(result.kept.length, 1);
  assert.equal(result.purged.length, 1);
});

test('metrics include cost stress, dispersion, drawdown, and streaks', () => {
  const result = new ResearchMetricsService().calculate([
    { tradingDate: '2026-03-02', grossReturn: 2, outcome: 'TARGET' },
    { tradingDate: '2026-03-02', grossReturn: -1, outcome: 'STOP_LOSS' },
    { tradingDate: '2026-03-03', grossReturn: 3, outcome: 'TIME_EXIT' },
    { tradingDate: '2026-03-04', grossReturn: 0, outcome: 'AMBIGUOUS' },
  ], 3);
  assert.equal(result.tradeCount, 4);
  assert.equal(result.netByCost.netAt040, 0.9333);
  assert.ok(result.standardDeviation > 0);
  assert.ok(result.maximumDrawdown >= 0);
  assert.equal(result.targetRate, 25);
  assert.equal(result.ambiguousRate, 25);
});

test('selection evaluates only train-selected top K', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, config: {}, outcomes: [] }));
  const selected = selectTopKFromTrain(candidates, (candidate) => Number(candidate.id.slice(1)), 20);
  assert.equal(selected.selectionCount, 30);
  assert.equal(selected.selected.length, 20);
  assert.equal(selected.selected[0].id, 'c29');
  const validation = evaluateSelectedValidation(selected.selected, new Map([['c29', [{ tradingDate: dates[0], grossReturn: 1 }]]]), undefined, 1);
  assert.equal(validation.length, 20);
});

test('result matrix and simplified PBO are deterministic diagnostics', () => {
  const matrix = resultMatrix(['a', 'b', 'c', 'd'], ['x', 'y'], new Map([
    ['a', new Map([['x', 1], ['y', 0]])], ['b', new Map([['x', 1], ['y', 0]])],
    ['c', new Map([['x', 0], ['y', 1]])], ['d', new Map([['x', 0], ['y', 1]])],
  ]), 0.4);
  assert.deepEqual(matrix.values, [[1, 0], [1, 0], [0, 1], [0, 1]]);
  const pbo = simplifiedPbo(matrix);
  assert.equal(pbo.method, 'SIMPLIFIED_CPCV');
  assert.equal(pbo.evaluatedCombinations, 2);
  assert.ok(pbo.pbo >= 0 && pbo.pbo <= 1);
});

test('deflated Sharpe is bounded and promotion gates remain manual-review only', () => {
  const dsr = deflatedSharpeRatio({ observedSharpe: 1, numberOfTrials: 100, sampleLength: 100 });
  assert.ok(dsr >= 0 && dsr <= 1);
  const gate = evaluatePromotionGate('RESEARCH_TO_SHADOW', { netAt040: 1, netAtStricterCost: .2, medianReturn: 1, tradeCount: 60, validationDidNotCollapse: true }, DEFAULT_PROMOTION_GATE_CONFIG);
  assert.equal(gate.decision, 'ELIGIBLE_FOR_MANUAL_REVIEW');
  assert.equal(gate.stage, 'RESEARCH_TO_SHADOW');
});

function temporaryLedger() {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-validation-'));
  const path = join(directory, 'research-ledger.json');
  writeFileSync(path, JSON.stringify({ version: 'test', entries: [{ strategyId: 'TEST', family: 'TEST', researchStatus: 'RESEARCH', splitManifestVersion: 'test', finalHoldoutStatus: 'UNTOUCHED' }] }));
  return { directory, path };
}

test('persistent holdout consumption survives reload and blocks a second attempt', async () => {
  const { directory, path } = temporaryLedger();
  try {
    const first = new PersistentHoldoutLedgerService(path);
    await assert.rejects(() => first.consumeOnce('TEST', 'runner', () => 1, false), ResearchLedgerError);
    assert.equal(await first.consumeOnce('TEST', 'runner', () => 42, true), 42);
    const reloaded = new PersistentHoldoutLedgerService(path);
    assert.equal(reloaded.get('TEST').finalHoldoutStatus, 'CONSUMED');
    await assert.rejects(() => reloaded.consumeOnce('TEST', 'runner2', () => 0, true), HoldoutAlreadyConsumedError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent consumers cannot both consume the same holdout', async () => {
  const { directory, path } = temporaryLedger();
  try {
    const ledger = new PersistentHoldoutLedgerService(path);
    const results = await Promise.allSettled([
      ledger.consumeOnce('TEST', 'one', async () => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); return 'one'; }, true),
      ledger.consumeOnce('TEST', 'two', () => 'two', true),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(new PersistentHoldoutLedgerService(path).get('TEST').finalHoldoutStatus, 'CONSUMED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing and malformed ledgers fail closed', () => {
  const { directory, path } = temporaryLedger();
  try {
    writeFileSync(path, '{not-json');
    assert.throws(() => new PersistentHoldoutLedgerService(path).read(), ResearchLedgerError);
    rmSync(path, { force: true });
    assert.throws(() => new PersistentHoldoutLedgerService(path).read(), ResearchLedgerError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('diagnostic and validation modes cannot access holdout and frozen state purging is explicit', () => {
  const service = new ResearchSplitService();
  const manifest = service.createManifest(dates, { instrumentKey: 'NSE_INDEX|Nifty 50' });
  const holdout = manifest.sessions.filter((session) => session.split === 'FINAL_HOLDOUT').map((session) => session.tradingDate);
  assert.throws(() => service.assertOutcomeAccess(manifest, holdout, 'FULL_DIAGNOSTIC_ONLY'));
  assert.throws(() => service.assertOutcomeAccess(manifest, holdout, 'TRAIN_VALIDATION_ONLY'));
  const purged = service.purgeCrossBoundaryOutcomes([{ tradingDate: holdout[0], resolutionDate: dates[dates.indexOf(holdout[0]) + 1] }], new Set(holdout));
  assert.equal(purged.purged.length, 0);
});
