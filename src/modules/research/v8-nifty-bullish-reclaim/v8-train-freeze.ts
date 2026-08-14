import { strategyFingerprint } from '../../research-validation/services/forward-validation.service';
import { V8BullishReclaimConfig } from './v8-bullish-reclaim.signal';

export interface V8FrozenExitPolicy { target: number; stop: number; hold: number; }

/** The minimum fields required for the predeclared, TRAIN-only V8 selection rule. */
export interface V8TrainSelectionMetric {
  id: string;
  config: V8BullishReclaimConfig;
  policy: V8FrozenExitPolicy;
  settledTrades: number;
  netAt040: number;
  grossMedian: number;
  targetRate: number;
  stopRate: number;
  maxDrawdown: number;
  maxLosingStreak: number;
}

export interface V8FrozenStrategyInputs {
  strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW';
  sourceStrategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE';
  timeframe: number;
  structuralLevelType: string;
  reclaimBufferAtr: number;
  bullishBodyAtr: number;
  rsiGate: string | number;
  regimeGate: string;
  cooldownMinutes: number;
  episodeRearmSemantics: string;
  optionSelectionSemantics: string;
  targetPercent: number;
  stopPercent: number;
  maximumHoldMinutes: number;
  shadowOnly: true;
}

export const V8_TRAIN_FREEZE_SELECTION_POLICY = Object.freeze({
  scope: 'TRAIN_ONLY',
  minimumSettledTrades: 30,
  minimumNetAt040Exclusive: 0,
  minimumNetMedianAt040: 0,
  requireTargetRateGreaterThanStopRate: true,
  // A loss of more than twice the accumulated 0.40%-cost expectancy (with a
  // conservative 50 percentage-point floor for small samples) is a
  // catastrophic concentration for this one-shot freeze.
  maximumDrawdown: 'max(50, 2 * settledTrades * netAt040)',
  ranking: ['netAt040_DESC', 'netMedianAt040_DESC', 'maxDrawdown_ASC', 'maxLosingStreak_ASC', 'settledTrades_DESC', 'id_ASC'],
} as const);

export function assertV8TrainOnlyDates(dates: readonly string[], splitByDate: ReadonlyMap<string, string>): void {
  if (!dates.length) throw new Error('V8 TRAIN-only selection requires at least one requested date.');
  const nonTrain = dates.filter((date) => splitByDate.get(date) !== 'TRAIN');
  if (nonTrain.length) throw new Error(`V8 TRAIN-only selection refused non-TRAIN date(s): ${nonTrain.join(', ')}.`);
}

export function isV8TrainEligible(metric: V8TrainSelectionMetric): boolean {
  const netMedianAt040 = metric.grossMedian - 0.4;
  const drawdownLimit = Math.max(50, 2 * metric.settledTrades * metric.netAt040);
  return metric.settledTrades >= V8_TRAIN_FREEZE_SELECTION_POLICY.minimumSettledTrades
    && metric.netAt040 > 0
    && netMedianAt040 >= V8_TRAIN_FREEZE_SELECTION_POLICY.minimumNetMedianAt040
    && metric.targetRate > metric.stopRate
    && metric.maxDrawdown <= drawdownLimit;
}

export function selectV8TrainOnlyWinner<T extends V8TrainSelectionMetric>(metrics: readonly T[]): T {
  const eligible = metrics.filter(isV8TrainEligible);
  if (!eligible.length) throw new Error('No V8 candidate met the predeclared TRAIN-only freeze eligibility criteria.');
  return [...eligible].sort((left, right) =>
    right.netAt040 - left.netAt040
    || (right.grossMedian - 0.4) - (left.grossMedian - 0.4)
    || left.maxDrawdown - right.maxDrawdown
    || left.maxLosingStreak - right.maxLosingStreak
    || right.settledTrades - left.settledTrades
    || left.id.localeCompare(right.id),
  )[0];
}

export function v8FrozenStrategyInputs(metric: Pick<V8TrainSelectionMetric, 'config' | 'policy'>): V8FrozenStrategyInputs {
  return {
    strategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW',
    sourceStrategyId: 'V8_NIFTY_BULLISH_RECLAIM_CE',
    timeframe: metric.config.timeframe,
    structuralLevelType: metric.config.levelFamily,
    reclaimBufferAtr: metric.config.reclaimBufferAtr,
    bullishBodyAtr: metric.config.bullishBodyAtr,
    rsiGate: metric.config.rsiMinimum,
    regimeGate: metric.config.regimeMode,
    cooldownMinutes: metric.config.cooldownMinutes,
    episodeRearmSemantics: 'PRIOR_COMPLETED_INTERACTION_ARMS; SUBSEQUENT_COMPLETED_BULLISH_RECLAIM_EMITS; COOLDOWN_BLOCK_CONSUMES_EPISODE; SESSION_RESET',
    optionSelectionSemantics: 'EXISTING_DETERMINISTIC_NIFTY_HISTORICAL_NEAR_ATM_CE_SELECTOR',
    targetPercent: metric.policy.target,
    stopPercent: metric.policy.stop,
    maximumHoldMinutes: metric.policy.hold,
    shadowOnly: true,
  };
}

export function v8FrozenStrategyFingerprint(metric: Pick<V8TrainSelectionMetric, 'config' | 'policy'>): string {
  return strategyFingerprint({ ...v8FrozenStrategyInputs(metric) });
}
