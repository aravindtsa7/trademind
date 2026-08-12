export type ResearchSplitName =
  | 'TRAIN'
  | 'EMBARGO_1'
  | 'VALIDATION'
  | 'EMBARGO_2'
  | 'FINAL_HOLDOUT';

export type ResearchAccessMode =
  | 'TRAIN_ONLY'
  | 'VALIDATION_ONLY'
  | 'TRAIN_VALIDATION_ONLY'
  | 'FINAL_HOLDOUT_ONCE'
  | 'FULL_DIAGNOSTIC_ONLY';

export type WalkForwardWindowMode = 'ROLLING' | 'EXPANDING';

export interface ResearchSessionSplit {
  index: number;
  tradingDate: string;
  split: ResearchSplitName;
}

export interface ResearchSplitManifest {
  manifestVersion: string;
  createdAt: string;
  scope: { instrumentKey: string; startDate: string; endDate: string; sessionCount: number };
  policy: {
    trainSessions: number;
    embargo1Sessions: number;
    validationSessions: number;
    embargo2Sessions: number;
    finalHoldoutSessions: number;
  };
  sessions: ResearchSessionSplit[];
}

export interface WalkForwardConfig {
  trainWindow: number;
  validationWindow: number;
  step: number;
  embargo: number;
  mode: WalkForwardWindowMode;
}

export interface WalkForwardFold {
  fold: number;
  train: ResearchSessionSplit[];
  embargo: ResearchSessionSplit[];
  validation: ResearchSessionSplit[];
  configsConsidered: number;
  selectedConfig?: string;
  validationResult?: unknown;
}

export interface ResearchOutcome {
  tradingDate: string;
  grossReturn: number;
  outcome?: 'TARGET' | 'STOP_LOSS' | 'TIME_EXIT' | 'AMBIGUOUS' | 'UNAVAILABLE';
}

export interface ResearchMetricResult {
  tradeCount: number;
  sessionCount: number;
  tradesPerSession: number;
  averageGrossReturn: number;
  medianReturn: number;
  standardDeviation: number;
  downsideDeviation: number;
  sharpeLike: number;
  sortinoLike: number;
  maximumDrawdown: number;
  maxConsecutiveLosses: number;
  profitableDayPercentage: number;
  targetRate: number;
  stopRate: number;
  timeoutRate: number;
  ambiguousRate: number;
  unavailableRate: number;
  netByCost: Record<string, number>;
}

export interface ResearchResultMatrix {
  version: string;
  sessions: string[];
  configurations: string[];
  values: number[][];
  costPercent: number;
}

export interface PromotionGateConfig {
  preferredMinimumTrades: number;
  minimumForwardShadowTrades: number;
  minimumForwardShadowSessions: number;
  minimumForwardPaperTrades: number;
  minimumForwardPaperSessions: number;
  minimumStricterCostPercent: number;
  maximumLosingStreak?: number;
  maximumDrawdown?: number;
}
