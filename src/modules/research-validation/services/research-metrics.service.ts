import { ResearchMetricResult, ResearchOutcome } from '../types/research-validation.types';

export const DEFAULT_COST_SCENARIOS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;

export class ResearchMetricsService {
  calculate(
    outcomes: readonly ResearchOutcome[],
    sessionCount: number,
    costs: readonly number[] = DEFAULT_COST_SCENARIOS
  ): ResearchMetricResult {
    const settled = outcomes.filter((outcome) => outcome.outcome !== 'AMBIGUOUS' && outcome.outcome !== 'UNAVAILABLE');
    const gross = settled.map((outcome) => outcome.grossReturn);
    const averageGrossReturn = average(gross);
    const standardDeviation = sampleStandardDeviation(gross);
    const downsideDeviation = Math.sqrt(average(gross.filter((value) => value < 0).map((value) => value ** 2)));
    const netByCost: Record<string, number> = {};
    costs.forEach((cost) => { netByCost[costKey(cost)] = round(averageGrossReturn - cost); });
    const byDay = new Map<string, number>();
    settled.forEach((outcome) => byDay.set(outcome.tradingDate, (byDay.get(outcome.tradingDate) ?? 0) + outcome.grossReturn));
    return {
      tradeCount: outcomes.length,
      sessionCount,
      tradesPerSession: round(outcomes.length / Math.max(1, sessionCount)),
      averageGrossReturn: round(averageGrossReturn),
      medianReturn: round(median(gross)),
      standardDeviation: round(standardDeviation),
      downsideDeviation: round(downsideDeviation),
      sharpeLike: round(sharpeLike(gross)),
      sortinoLike: round(sortinoLike(gross, downsideDeviation)),
      maximumDrawdown: round(maximumDrawdown(gross)),
      maxConsecutiveLosses: maxConsecutive(gross, (value) => value < 0),
      profitableDayPercentage: round([...byDay.values()].filter((value) => value > 0).length / Math.max(1, byDay.size) * 100),
      targetRate: rate(outcomes.filter((outcome) => outcome.outcome === 'TARGET').length, outcomes.length),
      stopRate: rate(outcomes.filter((outcome) => outcome.outcome === 'STOP_LOSS').length, outcomes.length),
      timeoutRate: rate(outcomes.filter((outcome) => outcome.outcome === 'TIME_EXIT').length, outcomes.length),
      ambiguousRate: rate(outcomes.filter((outcome) => outcome.outcome === 'AMBIGUOUS').length, outcomes.length),
      unavailableRate: rate(outcomes.filter((outcome) => outcome.outcome === 'UNAVAILABLE').length, outcomes.length),
      netByCost,
    };
  }
}

export function costKey(cost: number): string {
  return `netAt${Math.round(cost * 100).toString().padStart(3, '0')}`;
}

export function average(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function maximumDrawdown(returns: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  returns.forEach((value) => { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); });
  return drawdown;
}

function downside(values: readonly number[]): number { return Math.sqrt(average(values.filter((value) => value < 0).map((value) => value ** 2))); }
function sharpeLike(values: readonly number[]): number { const deviation = sampleStandardDeviation(values); return deviation ? average(values) / deviation * Math.sqrt(values.length) : 0; }
function sortinoLike(values: readonly number[], deviation = downside(values)): number { return deviation ? average(values) / deviation * Math.sqrt(values.length) : 0; }
function maxConsecutive(values: readonly number[], predicate: (value: number) => boolean): number { let current = 0; let maximum = 0; values.forEach((value) => { current = predicate(value) ? current + 1 : 0; maximum = Math.max(maximum, current); }); return maximum; }
function rate(value: number, total: number): number { return round(value / Math.max(1, total) * 100); }
function round(value: number): number { return Number(value.toFixed(4)); }

export default ResearchMetricsService;
