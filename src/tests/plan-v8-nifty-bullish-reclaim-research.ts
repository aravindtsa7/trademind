import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createV8BullishReclaimConfigs, V8_HOLD_MINUTES, V8_TARGET_STOP_COMBINATIONS, V8_STRATEGY_ID, V8_RECENT_SWING_LOOKBACK } from '../modules/research/v8-nifty-bullish-reclaim/v8-bullish-reclaim.signal';

const configs = createV8BullishReclaimConfigs();
const artifactDirectory = resolve(process.cwd(), 'artifacts', 'v8-nifty-bullish-reclaim');
const plan = {
  strategyId: V8_STRATEGY_ID,
  phase: 'PHASE_1_SIGNAL_ENGINE_AND_EXPERIMENT_PLAN',
  outcomeRunLaunched: false,
  scope: { instrumentKey: 'NSE_INDEX|Nifty 50', startDate: '2026-03-02', endDate: '2026-08-04', sessions: 104, excludeCurrentSession: '2026-08-13' },
  researchValidation: { defaultMode: 'TRAIN_VALIDATION_ONLY', finalHoldoutProtected: true, finalHoldoutAuthorizationRequired: true, holdoutStatus: 'PROTECTED_NOT_ACCESSED' },
  structuralAssumptions: { signalUsesCompletedCandlesOnly: true, reclaimRequiresPriorInteractionCandle: true, recentSwingLookbackCompletedCandles: V8_RECENT_SWING_LOOKBACK, optionDirection: 'CE', optionSelection: 'EXISTING_HISTORICAL_SELECTION_SEMANTICS' },
  grid: { signalConfigurations: configs.length, timeframes: [2, 3], levelFamilies: ['PDH', 'OR15_HIGH', 'OR30_HIGH', 'RECENT_SWING_HIGH'], reclaimBufferAtr: [0, 0.05, 0.1, 0.15], bullishBodyAtr: [0.25, 0.5, 0.75, 1], rsiMinimum: ['NONE', 50, 55, 60], regimeModes: ['ANY_EXCEPT_TREND_DOWN', 'TREND_UP_ONLY', 'NO_REGIME_FILTER'], cooldownMinutes: [5, 10, 15] },
  exits: { targetStopCombinations: V8_TARGET_STOP_COMBINATIONS, holdMinutes: V8_HOLD_MINUTES, policiesPerConfiguration: V8_TARGET_STOP_COMBINATIONS.length * V8_HOLD_MINUTES.length, totalPolicyEvaluations: configs.length * V8_TARGET_STOP_COMBINATIONS.length * V8_HOLD_MINUTES.length, costStressPercent: [0.2, 0.4, 0.6, 0.8, 1] },
  plannedDiagnostics: ['signal counts by split', 'required option-session manifest', 'train/validation metrics', 'walk-forward', 'DSR and multiple-testing diagnostics', 'V2/V4 timestamp overlap'],
};
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(resolve(artifactDirectory, 'phase-1-experiment-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ strategyId: plan.strategyId, configurations: configs.length, policiesPerConfiguration: plan.exits.policiesPerConfiguration, totalPolicyEvaluations: plan.exits.totalPolicyEvaluations, outcomeRunLaunched: false, artifact: 'artifacts/v8-nifty-bullish-reclaim/phase-1-experiment-plan.json' }, null, 2));
