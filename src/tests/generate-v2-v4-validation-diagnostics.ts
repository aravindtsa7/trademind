import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflatedSharpeRatio, ResearchMetricsService, simplifiedPbo } from '../modules/research-validation';

type MatrixRow = {
  date: string;
  settledTrades: number;
  grossDailyReturn: number;
  netDailyReturnByCost: Record<string, number>;
  targetCount: number;
  stopCount: number;
  timeoutCount: number;
  ambiguousCount: number;
  unavailableCount: number;
  tradeReferences: Array<{ outcome: string; returnPercent: number }>;
};
type Matrix = { strategyId: string; family: string; sessions: MatrixRow[]; resultMatrix: { sessions: string[]; configurations: string[]; values: number[][]; costPercent: number } };
type SplitManifest = { sessions: Array<{ tradingDate: string; split: string }> };
const directory = resolve(process.cwd(), 'artifacts', 'research-validation');
const split = JSON.parse(readFileSync(resolve(directory, 'nifty-104-split-v1.json'), 'utf8')) as SplitManifest;
const service = new ResearchMetricsService();

run('v2-session-result-matrix.json', 'v2-chronological-validation-report.json', 'v2-walk-forward-report.json', 'v2-multiple-testing-report.json');
run('v4-session-result-matrix.json', 'v4-chronological-validation-report.json', 'v4-walk-forward-report.json', 'v4-multiple-testing-report.json');

function run(matrixFile: string, chronologicalFile: string, walkForwardFile: string, multipleTestingFile: string): void {
  const matrix = JSON.parse(readFileSync(resolve(directory, matrixFile), 'utf8')) as Matrix;
  const rowsByDate = new Map(matrix.sessions.map((row) => [row.date, row]));
  const splitByDate = new Map(split.sessions.map((row) => [row.tradingDate, row.split]));
  const summarize = (dates: readonly string[]) => service.calculate(dates.flatMap((date) => (rowsByDate.get(date)?.tradeReferences ?? []).map((trade) => ({ tradingDate: date, grossReturn: trade.returnPercent, outcome: normalizeOutcome(trade.outcome) }))), dates.length);
  const datesFor = (name: string) => split.sessions.filter((row) => row.split === name).map((row) => row.tradingDate);
  const train = summarize(datesFor('TRAIN'));
  const validation = summarize(datesFor('VALIDATION'));
  const finalPeriod = summarize(datesFor('FINAL_HOLDOUT'));
  write(chronologicalFile, {
    strategyId: matrix.strategyId,
    status: 'LEGACY_RESEARCH',
    holdoutStatus: 'LEGACY_CONTAMINATED_HOLDOUT',
    splitManifestVersion: 'nifty-104-split-v1',
    TRAIN: train,
    VALIDATION: validation,
    LEGACY_CONTAMINATED_HOLDOUT: finalPeriod,
    degradation: { netAt040Ratio: ratio(train.netByCost.netAt040, validation.netByCost.netAt040), tradesPerSessionRatio: ratio(train.tradesPerSession, validation.tradesPerSession), signConsistentAt040: Math.sign(train.netByCost.netAt040) === Math.sign(validation.netByCost.netAt040) },
    note: 'FINAL_HOLDOUT is reported only as LEGACY_CONTAMINATED_HOLDOUT; it is not clean OOS evidence.'
  });
  const folds = [];
  const ordered = split.sessions.map((row) => row.tradingDate);
  for (let fold = 0; fold < 5; fold += 1) {
    const trainDates = ordered.slice(fold * 10, fold * 10 + 50);
    const validationDates = ordered.slice(fold * 10 + 52, fold * 10 + 62);
    const trainMetrics = summarize(trainDates);
    const validationMetrics = summarize(validationDates);
    folds.push({ fold: fold + 1, trainStart: trainDates[0], trainEnd: trainDates.at(-1), embargoDates: ordered.slice(fold * 10 + 50, fold * 10 + 52), validationStart: validationDates[0], validationEnd: validationDates.at(-1), trainMetrics, validationMetrics, degradation: { netAt040Ratio: ratio(trainMetrics.netByCost.netAt040, validationMetrics.netByCost.netAt040), signConsistentAt040: Math.sign(trainMetrics.netByCost.netAt040) === Math.sign(validationMetrics.netByCost.netAt040), tradeCountPerSessionRatio: ratio(trainMetrics.tradesPerSession, validationMetrics.tradesPerSession) } });
  }
  write(walkForwardFile, { strategyId: matrix.strategyId, method: 'FROZEN_CONFIG_STABILITY', trainWindow: 50, embargo: 2, validationWindow: 10, step: 10, folds });
  const observed = service.calculate(matrix.sessions.flatMap((row) => row.tradeReferences.map((trade) => ({ tradingDate: row.date, grossReturn: trade.returnPercent, outcome: normalizeOutcome(trade.outcome) }))), matrix.sessions.length);
  const trialSensitivity = [1, 10, 100, 1000, matrix.strategyId.startsWith('V2') ? 32_000 : 120_832].map((trials) => ({ trials, dsr: deflatedSharpeRatio({ observedSharpe: observed.sharpeLike, numberOfTrials: trials, sampleLength: Math.max(2, observed.tradeCount) }) }));
  const matrixForPbo = { ...matrix.resultMatrix, configurations: matrix.resultMatrix.configurations, values: matrix.resultMatrix.values };
  write(multipleTestingFile, { strategyId: matrix.strategyId, observedSharpeLike: observed.sharpeLike, trialCountAssumptions: trialSensitivity, dsrInterpretation: risk(trialSensitivity.at(-1)!.dsr), pbo: matrixForPbo.configurations.length < 2 ? { status: 'NOT_ESTIMABLE_FROM_SINGLE_FROZEN_COLUMN', simplifiedPbo: null, note: 'A single frozen candidate cannot estimate selection PBO. Preserve full train result matrices for future families.' } : simplifiedPbo({ version: 'research-result-matrix-v1', ...matrixForPbo }), legacyStatus: 'LEGACY_CONTAMINATED_HOLDOUT', uncertainty: 'Trial breadth is represented as a documented sensitivity range where full historical grids were not persisted.' });
}

function normalizeOutcome(value: string): 'TARGET' | 'STOP_LOSS' | 'TIME_EXIT' | 'AMBIGUOUS' | 'UNAVAILABLE' { return value === 'TARGET' || value === 'STOP_LOSS' || value === 'TIME_EXIT' || value === 'AMBIGUOUS' || value === 'UNAVAILABLE' ? value : 'UNAVAILABLE'; }
function ratio(left: number, right: number): number | null { return right === 0 ? null : Number((left / right).toFixed(4)); }
function risk(dsr: number): 'LOW' | 'MODERATE' | 'HIGH OVERFIT RISK' { return dsr >= .8 ? 'LOW' : dsr >= .5 ? 'MODERATE' : 'HIGH OVERFIT RISK'; }
function write(name: string, value: unknown): void { writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`); }
