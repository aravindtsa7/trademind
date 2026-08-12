export type V3ResearchDirection = 'UP' | 'DOWN';
export type OptionDirection = 'CE' | 'PE';
export type LocalCompletenessState = 'COMPLETE' | 'MISSING' | 'INCOMPLETE';

export interface DirectionalOptionSessionRequirement {
  instrumentKey: string;
  tradingDate: string;
  direction: OptionDirection;
  locallyAvailableCandleCount: number;
  completenessState: LocalCompletenessState;
}

export interface GloballyDeduplicatedOptionSessionRequirement {
  instrumentKey: string;
  tradingDate: string;
  directions: OptionDirection[];
  locallyAvailableCandleCount: number;
  completenessState: LocalCompletenessState;
}

export function chooseHistoricalOptionExpiry(expiries: readonly string[], signalDate: string): string {
  const expiry = expiries.filter((candidate) => candidate >= signalDate).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry exists on or after ${signalDate}.`);
  return expiry;
}

export function optionDirectionForResearch(direction: V3ResearchDirection): OptionDirection {
  return direction === 'UP' ? 'CE' : 'PE';
}

export function deduplicateDirectionalOptionSessions(
  requirements: readonly DirectionalOptionSessionRequirement[],
): GloballyDeduplicatedOptionSessionRequirement[] {
  const result = new Map<string, GloballyDeduplicatedOptionSessionRequirement>();
  requirements.forEach((requirement) => {
    const key = `${requirement.instrumentKey}\u0000${requirement.tradingDate}`;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, {
        instrumentKey: requirement.instrumentKey,
        tradingDate: requirement.tradingDate,
        directions: [requirement.direction],
        locallyAvailableCandleCount: requirement.locallyAvailableCandleCount,
        completenessState: requirement.completenessState,
      });
      return;
    }
    if (!existing.directions.includes(requirement.direction)) existing.directions.push(requirement.direction);
    if (
      existing.locallyAvailableCandleCount !== requirement.locallyAvailableCandleCount ||
      existing.completenessState !== requirement.completenessState
    ) {
      throw new Error(`Conflicting local option-cache inspection for instrumentKey=${requirement.instrumentKey} tradingDate=${requirement.tradingDate}.`);
    }
  });
  return [...result.values()].sort(
    (left, right) =>
      left.tradingDate.localeCompare(right.tradingDate) ||
      left.instrumentKey.localeCompare(right.instrumentKey),
  );
}
