import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  ResearchSplitService,
  deflatedSharpeRatio,
  evaluatePromotionGate,
  simplifiedPbo,
} from '../modules/research-validation';

const root = resolve(process.cwd(), 'artifacts', 'research-validation');
const source = resolve(process.cwd(), 'artifacts', 'v7-option-impulse', 'required-option-cache-manifest.json');
const v7SummaryPath = resolve(process.cwd(), 'artifacts', 'v7-option-impulse', 'final-v7-research-summary.json');
const v4SummaryPath = resolve(process.cwd(), 'artifacts', 'nifty-v4-structural-outcomes-2026-08-04.txt');
const manifestSource = JSON.parse(readFileSync(source, 'utf8')) as { globalRequiredSessions: Array<{ tradingDate: string }> };
const dates = [...new Set(manifestSource.globalRequiredSessions.map((row) => row.tradingDate))].sort();
const splitService = new ResearchSplitService();
const split = splitService.createManifest(dates, { instrumentKey: 'NSE_INDEX|Nifty 50', startDate: '2026-03-02', endDate: '2026-08-04' }, new Date());
const folds = splitService.buildWalkForwardFolds(dates);
const v7Summary = JSON.parse(readFileSync(v7SummaryPath, 'utf8')) as { configurations: { total: number }; policiesPerConfiguration: number; CE: { bestBalanced?: { netAt040: number; grossMedian: number; trades: number } }; PE: { bestBalanced?: { netAt040: number; grossMedian: number; trades: number } } };

mkdirSync(root, { recursive: true });
write('nifty-104-split-v1.json', split);
write('walk-forward-folds.json', { version: 'walk-forward-v1', defaults: { trainWindow: 50, validationWindow: 10, step: 10, embargo: 2, mode: 'ROLLING' }, folds });
write('v2-validation-report.json', {
  status: 'LEGACY_RESEARCH_SUMMARY_ONLY',
  holdoutStatus: 'LEGACY_CONTAMINATED_HOLDOUT',
  strategyId: 'V2_TREND_DOWN_PE',
  frozenConfiguration: '5m|EMA35 proximity 0.20%|RSI<35|cooldown 10m|+5/-5/15m',
  scope: split.scope,
  splitCounts: counts(split),
  historicalReference: { resolvedTrades: 103, targetRate: 61.8, stopRate: 38.2, averagePolicyReturn: 1.18 },
  trainValidationHoldout: 'NOT_RECOMPUTED: existing V2 artifacts do not persist a session-by-configuration outcome matrix.',
  note: 'This is not an out-of-sample result. The 104 sessions were already used during V2 discovery.'
});
write('v4-validation-report.json', {
  status: 'LEGACY_RESEARCH_SUMMARY_ONLY',
  holdoutStatus: 'LEGACY_CONTAMINATED_HOLDOUT',
  strategyId: 'V4_NIFTY_STRUCTURAL_FAMILIES',
  scope: split.scope,
  splitCounts: counts(split),
  sourceArtifact: v4SummaryPath,
  historicalReference: { openingRangeConfigs: 864, momentumConfigs: 1024, uniqueDirectionalSignalTimestamps: 14685, unresolvedOptionEntries: 43 },
  trainValidationHoldout: 'NOT_RECOMPUTED: the legacy V4 artifact is a full-scope summary without daily result matrices.',
  note: 'This is not an out-of-sample result. The 104 sessions were already used during V4 discovery.'
});
write('selection-bias-report.json', {
  version: 'selection-bias-v1',
  legacyFamilies: ['V2', 'V4'],
  v7Reference: { configurations: v7Summary.configurations.total, policies: v7Summary.policiesPerConfiguration, totalPolicyEvaluations: v7Summary.configurations.total * v7Summary.policiesPerConfiguration },
  protocol: { trainMetricDeclared: true, validationTopK: 20, validationMayNotSelectReplacement: true },
  limitation: 'Legacy artifacts do not contain a complete session-by-configuration matrix; no retroactive PBO/DSR claim is made.'
});
write('multiple-testing-report.json', {
  version: 'multiple-testing-v1',
  deflatedSharpeRatio: { status: 'IMPLEMENTED', formula: 'Bailey/Lopez de Prado-style expected-max-Sharpe adjustment; normal approximation; kurtosis is excess-adjusted.' },
  pbo: { status: 'IMPLEMENTED', method: 'SIMPLIFIED_CPCV', note: 'Two chronological half-splits; diagnostic only.' },
  retroactiveApplication: 'NOT_RUN: legacy session return matrices are not persisted.',
  V2: 'LEGACY_CONTAMINATED_HOLDOUT',
  V4: 'LEGACY_CONTAMINATED_HOLDOUT',
  V7: { bestBalancedCE: v7Summary.CE.bestBalanced, bestBalancedPE: v7Summary.PE.bestBalanced }
});
const gate = evaluatePromotionGate('RESEARCH_TO_SHADOW', {
  netAt040: v7Summary.CE.bestBalanced?.netAt040 ?? 0,
  netAtStricterCost: 0,
  medianReturn: v7Summary.CE.bestBalanced?.grossMedian ?? 0,
  tradeCount: v7Summary.CE.bestBalanced?.trades ?? 0,
  validationDidNotCollapse: false,
}, DEFAULT_PROMOTION_GATE_CONFIG);
write('promotion-gate-report.json', { version: 'promotion-gates-v1', defaults: DEFAULT_PROMOTION_GATE_CONFIG, V7_CE_DIAGNOSTIC: gate, note: 'Gates produce manual-review eligibility only; they never approve live deployment.' });
write('research-ledger.json', {
  version: 'research-ledger-v1',
  rules: { futureFamilies: 'V8+', finalHoldoutOneTime: true, failedHoldoutCannotBeRetuned: true },
  entries: [
    ledgerEntry('V2_TREND_DOWN_PE', 'V2', 'PAPER', 500, 64),
    ledgerEntry('V4_NIFTY_MOMENTUM_PE_SHADOW', 'V4', 'SHADOW', 1888, 64),
    ledgerEntry('V5_NIFTY_SCALPING', 'V5', 'REJECTED_WEAK', 2592, 5),
    ledgerEntry('V6_NIFTY_SIDEWAYS_MEAN_REVERSION', 'V6', 'REJECTED_WEAK', 11520, 5),
    ledgerEntry('V7_NIFTY_OPTION_IMPULSE', 'V7', 'REJECTED_WEAK', v7Summary.configurations.total, v7Summary.policiesPerConfiguration),
  ]
});
write('methodology.md', `# TradeMind research validation methodology\n\n## Split policy\n\nThe 104 chronological NIFTY sessions are divided into TRAIN (60), EMBARGO_1 (3), VALIDATION (20), EMBARGO_2 (3), and FINAL_HOLDOUT (18). Embargo sessions are excluded from outcome selection.\n\n## Holdout protection\n\nNormal modes are TRAIN_ONLY, VALIDATION_ONLY, TRAIN_VALIDATION_ONLY, and FULL_DIAGNOSTIC_ONLY. FINAL_HOLDOUT_ONCE requires RESEARCH_FINAL_HOLDOUT_AUTHORIZED=true and is intended to be consumed once. A final holdout already inspected by an earlier research effort is labeled LEGACY_CONTAMINATED_HOLDOUT.\n\n## Walk-forward\n\nThe default rolling fold uses 50 training sessions, a two-session embargo, 10 validation sessions, and a ten-session step. Expanding windows are supported. Configuration selection occurs only on the training window; validation receives only the bounded top-K.\n\n## Purging\n\nOutcomes whose entry or resolution date crosses a split boundary are purged. Cooldown, open-position, and strategy state are reset at split boundaries unless a strategy explicitly documents a prior-session warm-up requirement. Indicator warm-up may use prior training data, but never future validation bars.\n\n## Multiple testing\n\nThe framework provides a Deflated Sharpe Ratio approximation and a simplified chronological CPCV/PBO diagnostic. Both require session-by-configuration returns and are reported as diagnostics, not guarantees of statistical significance.\n\n## Promotion\n\nPromotion gates are configurable defaults and return ELIGIBLE_FOR_MANUAL_REVIEW or NOT_ELIGIBLE. No gate automatically approves live trading.\n\n## Legacy versus future\n\nV2, V4, V5, V6, and V7 were researched on the full 104-session history. Their final holdout is therefore not pristine. Future V8+ development must use TRAIN, accept/reject on VALIDATION, and consume FINAL_HOLDOUT only once. A failed holdout cannot be tuned and retested against that same holdout.\n`);
write('validation-hardening-summary.json', {
  version: 'research-validation-hardening-v1',
  persistentHoldout: { implemented: true, atomicWrite: true, lockFile: true, secondAccessDenied: true, corruptLedgerFailsClosed: true },
  matrices: { V2: 'v2-session-result-matrix.json', V4: 'v4-session-result-matrix.json' },
  diagnostics: { V2: ['v2-chronological-validation-report.json', 'v2-walk-forward-report.json', 'v2-multiple-testing-report.json'], V4: ['v4-chronological-validation-report.json', 'v4-walk-forward-report.json', 'v4-multiple-testing-report.json'] },
  holdoutPolicy: 'V2/V4/V5/V6/V7 are LEGACY_CONTAMINATED; no clean OOS claim is made.',
  marketDataFetched: 0,
  runtimesStarted: 0,
});

function counts(manifest: typeof split) { return Object.fromEntries(['TRAIN', 'EMBARGO_1', 'VALIDATION', 'EMBARGO_2', 'FINAL_HOLDOUT'].map((name) => [name, manifest.sessions.filter((session) => session.split === name).length])); }
function ledgerEntry(strategyId: string, family: string, researchStatus: string, configCount: number, policyCount: number) {
  return { strategyId, family, researchStatus, splitManifestVersion: split.manifestVersion, finalHoldoutStatus: 'LEGACY_CONTAMINATED', firstAuthorizedAt: undefined, consumedAt: undefined, consumedByRunner: undefined, notes: `Legacy full-scope research; configs=${configCount}, policies=${policyCount}, scope=${split.scope.startDate}..${split.scope.endDate}. Artifact paths are in artifacts/research-validation.` };
}
function write(name: string, value: unknown) { writeFileSync(resolve(root, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
