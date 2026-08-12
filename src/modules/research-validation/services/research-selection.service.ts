import { ResearchOutcome, PromotionGateConfig } from '../types/research-validation.types';
import { ResearchMetricsService } from './research-metrics.service';

export interface RankedResearchConfig<T = unknown> {
  id: string;
  config: T;
  outcomes: ResearchOutcome[];
}

export interface TrainSelection<T = unknown> {
  trainMetric: number;
  selected: RankedResearchConfig<T>[];
  selectionCount: number;
}

export function selectTopKFromTrain<T>(
  candidates: readonly RankedResearchConfig<T>[],
  metric: (candidate: RankedResearchConfig<T>) => number,
  topK = 20
): TrainSelection<T> {
  const selected = [...candidates].sort((left, right) => metric(right) - metric(left)).slice(0, topK);
  return { trainMetric: selected[0] ? metric(selected[0]) : 0, selected, selectionCount: candidates.length };
}

export function evaluateSelectedValidation<T>(
  selected: readonly RankedResearchConfig<T>[],
  validationOutcomes: ReadonlyMap<string, readonly ResearchOutcome[]>,
  metricService = new ResearchMetricsService(),
  sessionCount = 1
) {
  return selected.map((candidate) => ({ id: candidate.id, validation: metricService.calculate(validationOutcomes.get(candidate.id) ?? [], sessionCount) }));
}

export type PromotionStage = 'RESEARCH_TO_SHADOW' | 'SHADOW_TO_PAPER' | 'PAPER_TO_LIVE';

export interface PromotionEvidence {
  netAt040: number;
  netAtStricterCost: number;
  medianReturn: number;
  tradeCount: number;
  validationDidNotCollapse: boolean;
  largestMonthContributionPercent?: number;
  maximumDrawdown?: number;
  maxConsecutiveLosses?: number;
  forwardTrades?: number;
  forwardSessions?: number;
  observedCostCaptured?: boolean;
  implementationFailures?: number;
  portfolioRiskManagerPresent?: boolean;
}

export interface PromotionGateResult {
  stage: PromotionStage;
  decision: 'ELIGIBLE_FOR_MANUAL_REVIEW' | 'NOT_ELIGIBLE';
  reasons: string[];
  defaults: PromotionGateConfig;
}

export function evaluatePromotionGate(stage: PromotionStage, evidence: PromotionEvidence, defaults: PromotionGateConfig): PromotionGateResult {
  const reasons: string[] = [];
  if (stage === 'RESEARCH_TO_SHADOW') {
    if (!(evidence.netAt040 > 0)) reasons.push('net expectancy at 0.40% is not positive');
    if (!(evidence.netAtStricterCost > 0)) reasons.push('no positive stricter-cost expectancy');
    if (evidence.medianReturn < 0) reasons.push('median return is materially negative');
    if (evidence.tradeCount < defaults.preferredMinimumTrades) reasons.push('preferred minimum trade count not met');
    if (!evidence.validationDidNotCollapse) reasons.push('validation performance collapsed');
  } else if (stage === 'SHADOW_TO_PAPER') {
    if ((evidence.forwardTrades ?? 0) < defaults.minimumForwardShadowTrades) reasons.push('minimum forward shadow trades not met');
    if ((evidence.forwardSessions ?? 0) < defaults.minimumForwardShadowSessions) reasons.push('minimum forward shadow sessions not met');
    if (!evidence.validationDidNotCollapse) reasons.push('forward behavior is not directionally consistent');
    if (evidence.observedCostCaptured !== true) reasons.push('realized spread/slippage is not captured');
  } else {
    if ((evidence.forwardTrades ?? 0) < defaults.minimumForwardPaperTrades) reasons.push('minimum forward paper trades not met');
    if ((evidence.forwardSessions ?? 0) < defaults.minimumForwardPaperSessions) reasons.push('minimum forward paper sessions not met');
    if (!(evidence.netAt040 > 0)) reasons.push('realized expectancy after observed costs is not positive');
    if (evidence.implementationFailures && evidence.implementationFailures > 0) reasons.push('critical runtime failures present');
    if (evidence.portfolioRiskManagerPresent !== true) reasons.push('portfolio risk manager is not confirmed');
  }
  return { stage, decision: reasons.length ? 'NOT_ELIGIBLE' : 'ELIGIBLE_FOR_MANUAL_REVIEW', reasons, defaults };
}

export const DEFAULT_PROMOTION_GATE_CONFIG: PromotionGateConfig = {
  preferredMinimumTrades: 50,
  minimumForwardShadowTrades: 30,
  minimumForwardShadowSessions: 20,
  minimumForwardPaperTrades: 75,
  minimumForwardPaperSessions: 40,
  minimumStricterCostPercent: 0.6,
};
