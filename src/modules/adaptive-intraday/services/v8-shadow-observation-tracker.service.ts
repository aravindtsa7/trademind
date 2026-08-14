import { OptionContract } from '../../options/types';
import { estimateEntry, estimateExit, executionComparison, ForwardExitReason, NormalizedQuote } from '../../research-validation';

export interface V8ShadowObservation { signalId: string; signalTimestamp: Date; contract: OptionContract; theoreticalEntry: number | null; executableEntry: number | null; entrySource: string; entryQuote: NormalizedQuote; target: number | null; stop: number | null; }
export interface V8ShadowResolution { observation: V8ShadowObservation; reason: ForwardExitReason; timestamp: Date; theoreticalExit: number | null; executableExit: number | null; exitSource: string; exitQuote: NormalizedQuote; }
/** Orderless-only state machine: it never imports an order manager or broker client. */
export default class V8ShadowObservationTracker {
  private readonly pending = new Map<string, { signalTimestamp: Date; contract: OptionContract }>(); private readonly open = new Map<string, V8ShadowObservation>();
  constructor(private readonly policy: { target: number; stop: number; hold: number }) {}
  register(signalId: string, signalTimestamp: Date, contract: OptionContract): void { if (!this.pending.has(signalId) && !this.open.has(signalId)) this.pending.set(signalId, { signalTimestamp: new Date(signalTimestamp), contract: { ...contract, expiry: new Date(contract.expiry) } }); }
  observe(signalId: string, instrumentKey: string, low: number, high: number, quote: NormalizedQuote, at: Date): V8ShadowResolution[] {
    const pending = this.pending.get(signalId); if (pending && pending.contract.instrumentKey === instrumentKey) { const theoretical = quote.ltp; const estimated = estimateEntry(quote); if (theoretical !== null) { this.pending.delete(signalId); this.open.set(signalId, { signalId, signalTimestamp: pending.signalTimestamp, contract: pending.contract, theoreticalEntry: theoretical, executableEntry: estimated.price, entrySource: estimated.source, entryQuote: quote, target: theoretical * (1 + this.policy.target / 100), stop: theoretical * (1 - this.policy.stop / 100) }); } }
    const value = this.open.get(signalId); if (!value || value.contract.instrumentKey !== instrumentKey) return [];
    if (high >= value.target! && low <= value.stop!) return [this.close(signalId, 'AMBIGUOUS', at, null, quote)];
    if (high >= value.target!) return [this.close(signalId, 'TARGET', at, quote.ltp, quote)];
    if (low <= value.stop!) return [this.close(signalId, 'STOP', at, quote.ltp, quote)];
    if (at.getTime() >= value.signalTimestamp.getTime() + this.policy.hold * 60_000) return [this.close(signalId, 'TIMEOUT', at, quote.ltp, quote)];
    return [];
  }
  closeAtEod(at: Date, quote?: NormalizedQuote): V8ShadowResolution[] { const result: V8ShadowResolution[] = []; for (const [id] of this.pending) { const pending = this.pending.get(id)!; this.pending.delete(id); result.push({ observation: { signalId: id, signalTimestamp: pending.signalTimestamp, contract: pending.contract, theoreticalEntry: null, executableEntry: null, entrySource: 'UNAVAILABLE', entryQuote: unavailableQuote(), target: null, stop: null }, reason: 'UNAVAILABLE', timestamp: at, theoreticalExit: null, executableExit: null, exitSource: 'UNAVAILABLE', exitQuote: quote ?? unavailableQuote() }); } for (const [id, trade] of this.open) result.push(this.close(id, 'EOD', at, quote?.ltp ?? trade.theoreticalEntry, quote ?? unavailableQuote())); return result; }
  getOpenCount(): number { return this.pending.size + this.open.size; }
  getObservation(signalId: string): V8ShadowObservation | undefined { const value = this.open.get(signalId); return value ? { ...value, signalTimestamp: new Date(value.signalTimestamp), contract: { ...value.contract, expiry: new Date(value.contract.expiry) }, entryQuote: { ...value.entryQuote } } : undefined; }
  private close(id: string, reason: ForwardExitReason, timestamp: Date, theoreticalExit: number | null, quote: NormalizedQuote): V8ShadowResolution { const observation = this.open.get(id)!; this.open.delete(id); const estimated = estimateExit(quote); return { observation, reason, timestamp, theoreticalExit, executableExit: estimated.price, exitSource: estimated.source, exitQuote: quote }; }
}
function unavailableQuote(): NormalizedQuote { return { ltp: null, bid: null, ask: null, spreadAbsolute: null, spreadPercent: null, quoteAgeMilliseconds: null, quality: 'UNAVAILABLE' }; }
