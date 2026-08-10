import { ExpiredOptionCandleDto } from './upstox-expired-option-candle.dto';

export type FixedTimeHoldingMinutes = 5 | 15 | 30 | 60;

export interface FixedTimeOptionExitPolicy {
  type: 'FIXED_TIME';
  holdingMinutes: FixedTimeHoldingMinutes;
}

export interface TargetStopOptionExitPolicy {
  type: 'TARGET_STOP';
  targetPercent: number;
  stopLossPercent: number;
  maximumHoldingMinutes: number;
}

export type OptionExitPolicy = FixedTimeOptionExitPolicy | TargetStopOptionExitPolicy;

export type OptionExitReason =
  | 'TIME_EXIT'
  | 'TARGET'
  | 'STOP_LOSS'
  | 'AMBIGUOUS'
  | 'UNAVAILABLE';

export interface OptionExitPolicyEvaluationRequest {
  signalTimestamp: Date;
  entryPremium: number;
  candles: readonly ExpiredOptionCandleDto[];
  exitPolicy: OptionExitPolicy;
}

export interface OptionExitPolicyEvaluationResult {
  signalTimestamp: Date;
  entryPremium: number;
  exitTimestamp: Date | null;
  exitPremium: number | null;
  exitReason: OptionExitReason;
  holdingMinutes: number | null;
  premiumChange: number | null;
  premiumChangePercent: number | null;
  targetPremium?: number;
  stopPremium?: number;
  ambiguous: boolean;
  unavailable: boolean;
}
