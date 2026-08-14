export interface V12DepthLevel {
  bidPrice?: number;
  bidQuantity?: number;
  askPrice?: number;
  askQuantity?: number;
}

export interface V12BookFeatures {
  queueImbalance: number | null;
  depthImbalance: Record<string, number>;
  midPrice: number | null;
  microprice: number | null;
  micropriceMinusMid: number | null;
  spreadAbsolute: number | null;
  spreadPercent: number | null;
  flags: string[];
}

const finitePositive = (value: number | undefined): value is number =>
  Number.isFinite(value) && (value as number) > 0;

/** Pure, non-strategic book calculations. Null means the feed did not provide enough data. */
export function calculateBookFeatures(levels: readonly V12DepthLevel[], wideSpreadPercent = 2): V12BookFeatures {
  const first = levels[0] ?? {};
  const flags: string[] = [];
  if (!finitePositive(first.bidPrice)) flags.push('MISSING_BID');
  if (!finitePositive(first.askPrice)) flags.push('MISSING_ASK');
  if (finitePositive(first.bidPrice) && finitePositive(first.askPrice)) {
    if (first.bidPrice === first.askPrice) flags.push('LOCKED_MARKET');
    if (first.bidPrice > first.askPrice) flags.push('CROSSED_MARKET');
  }
  const denominator = (first.bidQuantity ?? 0) + (first.askQuantity ?? 0);
  const queueImbalance = denominator > 0 && Number.isFinite(denominator)
    ? ((first.bidQuantity ?? 0) - (first.askQuantity ?? 0)) / denominator
    : null;
  const midPrice = finitePositive(first.bidPrice) && finitePositive(first.askPrice)
    ? (first.bidPrice + first.askPrice) / 2 : null;
  const microprice = denominator > 0 && finitePositive(first.bidPrice) && finitePositive(first.askPrice)
    ? ((first.askPrice * (first.bidQuantity ?? 0)) + (first.bidPrice * (first.askQuantity ?? 0))) / denominator : null;
  const spreadAbsolute = finitePositive(first.bidPrice) && finitePositive(first.askPrice)
    ? first.askPrice - first.bidPrice : null;
  const spreadPercent = spreadAbsolute !== null && midPrice && midPrice > 0 ? (spreadAbsolute / midPrice) * 100 : null;
  if (spreadPercent !== null && spreadPercent > wideSpreadPercent) flags.push('WIDE_SPREAD');
  const depthImbalance: Record<string, number> = {};
  for (let count = 1; count <= levels.length; count += 1) {
    const slice = levels.slice(0, count);
    const bid = slice.reduce((sum, level) => sum + (finitePositive(level.bidQuantity) ? level.bidQuantity : 0), 0);
    const ask = slice.reduce((sum, level) => sum + (finitePositive(level.askQuantity) ? level.askQuantity : 0), 0);
    if (bid + ask > 0) depthImbalance[String(count)] = (bid - ask) / (bid + ask);
  }
  return { queueImbalance, depthImbalance, midPrice, microprice, micropriceMinusMid: microprice !== null && midPrice !== null ? microprice - midPrice : null, spreadAbsolute, spreadPercent, flags };
}

export interface V12AggregationInput {
  eventId: string; timestampMs: number; instrumentKey: string; queueImbalance: number | null;
  spreadPercent: number | null; ltp: number | null; underlyingSpot: number | null;
}
export interface V12Aggregate {
  instrumentKey: string; windowSeconds: number; windowStart: string; windowEnd: string; updateCount: number;
  meanImbalance: number | null; medianImbalance: number | null; finalImbalance: number | null;
  maxAbsoluteImbalance: number | null; imbalanceChange: number | null; sameSignPersistencePercent: number | null;
  meanSpreadPercent: number | null; p90SpreadPercent: number | null; underlyingReturnPercent: number | null; optionReturnPercent: number | null;
}
export interface V12CrossOptionObservation { expiry: string; strike: number; optionType: 'CE'|'PE'; timestampMs: number; queueImbalance: number | null; spreadPercent: number | null; }
export function calculateCrossSurfaceFeatures(ce: V12CrossOptionObservation | undefined, pe: V12CrossOptionObservation | undefined, nowMs: number, maximumAgeMs: number): { ceImbalance:number|null; peImbalance:number|null; ceMinusPe:number|null; relativeDepthPressure:number|null; ceSpreadPercent:number|null; peSpreadPercent:number|null } | null {
  if (!ce || !pe || ce.optionType !== 'CE' || pe.optionType !== 'PE' || ce.expiry !== pe.expiry || ce.strike !== pe.strike || nowMs-ce.timestampMs>maximumAgeMs || nowMs-pe.timestampMs>maximumAgeMs) return null;
  const difference = ce.queueImbalance !== null && pe.queueImbalance !== null ? ce.queueImbalance-pe.queueImbalance : null;
  return {ceImbalance:ce.queueImbalance,peImbalance:pe.queueImbalance,ceMinusPe:difference,relativeDepthPressure:difference,ceSpreadPercent:ce.spreadPercent,peSpreadPercent:pe.spreadPercent};
}
const percentile = (values: number[], probability: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const index = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
};
const returnPercent = (first: number | null, last: number | null): number | null => first && last && first > 0 ? ((last - first) / first) * 100 : null;

/** Buffers at most one open fixed window per instrument/window size and never uses a later update. */
export class CausalWindowAggregator {
  private readonly buckets = new Map<string, V12AggregationInput[]>();
  constructor(private readonly windowSeconds: number) {}
  push(input: V12AggregationInput): V12Aggregate[] {
    const size = this.windowSeconds * 1000; const start = Math.floor(input.timestampMs / size) * size;
    const key = `${input.instrumentKey}|${start}`; const completed: V12Aggregate[] = [];
    for (const [existing, values] of this.buckets) {
      const [instrument, existingStart] = existing.split('|');
      if (instrument === input.instrumentKey && Number(existingStart) < start) { completed.push(this.finish(values)); this.buckets.delete(existing); }
    }
    const values = this.buckets.get(key) ?? []; values.push(input); this.buckets.set(key, values); return completed;
  }
  flush(): V12Aggregate[] { const values = [...this.buckets.values()].map((bucket) => this.finish(bucket)); this.buckets.clear(); return values; }
  private finish(values: V12AggregationInput[]): V12Aggregate {
    const ordered = [...values].sort((a, b) => a.timestampMs - b.timestampMs || a.eventId.localeCompare(b.eventId));
    const imbalances = ordered.map((item) => item.queueImbalance).filter((value): value is number => value !== null);
    const spreads = ordered.map((item) => item.spreadPercent).filter((value): value is number => value !== null);
    const first = ordered[0]; const last = ordered[ordered.length - 1]; const firstImbalance = imbalances[0] ?? null; const finalImbalance = imbalances.at(-1) ?? null;
    const finalSign = finalImbalance === null ? 0 : Math.sign(finalImbalance);
    const persistence = imbalances.length && finalSign ? (imbalances.filter((value) => Math.sign(value) === finalSign).length / imbalances.length) * 100 : null;
    return { instrumentKey: first.instrumentKey, windowSeconds: this.windowSeconds, windowStart: new Date(Math.floor(first.timestampMs / (this.windowSeconds * 1000)) * this.windowSeconds * 1000).toISOString(), windowEnd: new Date((Math.floor(first.timestampMs / (this.windowSeconds * 1000)) + 1) * this.windowSeconds * 1000).toISOString(), updateCount: ordered.length, meanImbalance: imbalances.length ? imbalances.reduce((a,b)=>a+b,0)/imbalances.length : null, medianImbalance: percentile(imbalances, .5), finalImbalance, maxAbsoluteImbalance: imbalances.length ? Math.max(...imbalances.map(Math.abs)) : null, imbalanceChange: firstImbalance !== null && finalImbalance !== null ? finalImbalance-firstImbalance : null, sameSignPersistencePercent: persistence, meanSpreadPercent: spreads.length ? spreads.reduce((a,b)=>a+b,0)/spreads.length : null, p90SpreadPercent: percentile(spreads,.9), underlyingReturnPercent: returnPercent(first.underlyingSpot,last.underlyingSpot), optionReturnPercent: returnPercent(first.ltp,last.ltp) };
  }
}

export function redactSensitiveText(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, '$1[REDACTED]').replace(/bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redactSensitiveText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, key.toLowerCase() === 'authorization' ? '[REDACTED]' : redactSensitiveText(child)]));
  return value;
}
