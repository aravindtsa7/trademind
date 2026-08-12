import {
  ResearchAccessMode,
  ResearchSessionSplit,
  ResearchSplitManifest,
  ResearchSplitName,
  WalkForwardConfig,
  WalkForwardFold,
} from '../types/research-validation.types';

export const DEFAULT_SPLIT_POLICY = {
  trainSessions: 60,
  embargo1Sessions: 3,
  validationSessions: 20,
  embargo2Sessions: 3,
  finalHoldoutSessions: 18,
} as const;

export const DEFAULT_WALK_FORWARD_CONFIG: WalkForwardConfig = {
  trainWindow: 50,
  validationWindow: 10,
  step: 10,
  embargo: 2,
  mode: 'ROLLING',
};

export class ResearchHoldoutAccessError extends Error {
  constructor(message = 'FINAL_HOLDOUT access is denied. Set RESEARCH_FINAL_HOLDOUT_AUTHORIZED=true for a one-time evaluation.') {
    super(message);
    this.name = 'ResearchHoldoutAccessError';
  }
}

export class ResearchSplitService {
  createManifest(
    dates: readonly string[],
    scope: { instrumentKey: string; startDate?: string; endDate?: string },
    createdAt = new Date('2026-01-01T00:00:00.000Z')
  ): ResearchSplitManifest {
    const ordered = [...new Set(dates)].sort();
    const policy = DEFAULT_SPLIT_POLICY;
    const expected = Object.values(policy).reduce((total, value) => total + value, 0);
    if (ordered.length !== expected) {
      throw new Error(`Research split requires ${expected} sessions; received ${ordered.length}.`);
    }
    const boundaries: Array<[ResearchSplitName, number]> = [
      ['TRAIN', policy.trainSessions],
      ['EMBARGO_1', policy.embargo1Sessions],
      ['VALIDATION', policy.validationSessions],
      ['EMBARGO_2', policy.embargo2Sessions],
      ['FINAL_HOLDOUT', policy.finalHoldoutSessions],
    ];
    const sessions: ResearchSessionSplit[] = [];
    let cursor = 0;
    for (const [split, count] of boundaries) {
      for (let offset = 0; offset < count; offset += 1) {
        sessions.push({ index: cursor, tradingDate: ordered[cursor], split });
        cursor += 1;
      }
    }
    return {
      manifestVersion: 'nifty-104-split-v1',
      createdAt: createdAt.toISOString(),
      scope: {
        instrumentKey: scope.instrumentKey,
        startDate: scope.startDate ?? ordered[0],
        endDate: scope.endDate ?? ordered.at(-1)!,
        sessionCount: ordered.length,
      },
      policy,
      sessions,
    };
  }

  assertOutcomeAccess(
    manifest: ResearchSplitManifest,
    requestedDates: readonly string[],
    mode: ResearchAccessMode,
    authorized = process.env.RESEARCH_FINAL_HOLDOUT_AUTHORIZED === 'true'
  ): void {
    const requested = new Set(requestedDates);
    const byDate = new Map(manifest.sessions.map((session) => [session.tradingDate, session.split]));
    const unknown = [...requested].filter((date) => !byDate.has(date));
    if (unknown.length) throw new Error(`Research request contains dates outside the split manifest: ${unknown.join(', ')}.`);
    if (mode === 'FULL_DIAGNOSTIC_ONLY') throw new Error('FULL_DIAGNOSTIC_ONLY cannot evaluate outcomes.');
    if (mode === 'FINAL_HOLDOUT_ONCE') {
      if (!authorized) throw new ResearchHoldoutAccessError();
      if ([...requested].some((date) => byDate.get(date) !== 'FINAL_HOLDOUT')) throw new Error('FINAL_HOLDOUT_ONCE may request only FINAL_HOLDOUT sessions.');
    }
    if (mode === 'TRAIN_ONLY' && [...requested].some((date) => byDate.get(date) !== 'TRAIN')) {
      throw new Error('TRAIN_ONLY request contains non-training sessions.');
    }
    if (mode === 'VALIDATION_ONLY' && [...requested].some((date) => byDate.get(date) !== 'VALIDATION')) {
      throw new Error('VALIDATION_ONLY request contains non-validation sessions.');
    }
    if (mode === 'TRAIN_VALIDATION_ONLY' && [...requested].some((date) => !['TRAIN', 'VALIDATION'].includes(byDate.get(date)!))) {
      throw new Error('TRAIN_VALIDATION_ONLY request contains embargo or FINAL_HOLDOUT sessions.');
    }
    if (mode !== 'FINAL_HOLDOUT_ONCE' && [...requested].some((date) => byDate.get(date) === 'FINAL_HOLDOUT')) {
      throw new ResearchHoldoutAccessError();
    }
  }

  buildWalkForwardFolds(
    dates: readonly string[],
    config: WalkForwardConfig = DEFAULT_WALK_FORWARD_CONFIG
  ): WalkForwardFold[] {
    const ordered = [...new Set(dates)].sort();
    if (config.trainWindow <= 0 || config.validationWindow <= 0 || config.step <= 0 || config.embargo < 0) {
      throw new Error('Walk-forward windows and step must be positive; embargo cannot be negative.');
    }
    const folds: WalkForwardFold[] = [];
    let validationStart = config.trainWindow + config.embargo;
    let fold = 1;
    while (validationStart + config.validationWindow <= ordered.length) {
      const trainStart = config.mode === 'ROLLING' ? validationStart - config.embargo - config.trainWindow : 0;
      const trainEnd = validationStart - config.embargo;
      const embargoStart = trainEnd;
      const validationEnd = validationStart + config.validationWindow;
      folds.push({
        fold,
        train: ordered.slice(trainStart, trainEnd).map((tradingDate, index) => ({ index: trainStart + index, tradingDate, split: 'TRAIN' })),
        embargo: ordered.slice(embargoStart, validationStart).map((tradingDate, index) => ({ index: embargoStart + index, tradingDate, split: 'EMBARGO_1' })),
        validation: ordered.slice(validationStart, validationEnd).map((tradingDate, index) => ({ index: validationStart + index, tradingDate, split: 'VALIDATION' })),
        configsConsidered: 0,
      });
      validationStart += config.step;
      fold += 1;
    }
    return folds;
  }

  purgeCrossBoundaryOutcomes<T extends { tradingDate: string; resolutionDate?: string }>(
    outcomes: readonly T[],
    allowedDates: ReadonlySet<string>
  ): { kept: T[]; purged: T[] } {
    const kept: T[] = [];
    const purged: T[] = [];
    for (const outcome of outcomes) {
      if (allowedDates.has(outcome.tradingDate) && (!outcome.resolutionDate || allowedDates.has(outcome.resolutionDate))) kept.push(outcome);
      else purged.push(outcome);
    }
    return { kept, purged };
  }
}

export default ResearchSplitService;
