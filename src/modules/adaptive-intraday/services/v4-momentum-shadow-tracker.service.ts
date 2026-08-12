import { OptionContract } from '../../options/types';
import { v4MomentumShadowPolicy } from './v4-nifty-momentum-shadow-evaluator.service';

export type V4ShadowExitReason = 'TARGET' | 'STOP_LOSS' | 'TIMEOUT' | 'AMBIGUOUS' | 'UNAVAILABLE';
export interface V4ShadowTradeJournalEntry {
  strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW'; tradingDate: string; signalTimestamp: Date; optionInstrument: string; tradingSymbol: string; strike: number; expiry: Date; referencePremium: number; targetPrice: number; stopPrice: number; exitTimestamp: Date | null; exitReason: V4ShadowExitReason; exitPremium: number | null; grossReturnPercent: number | null; netReturnAt020: number | null; netReturnAt040: number | null; netReturnAt060: number | null;
}
interface OpenShadow { id: string; contract: OptionContract; signalTimestamp: Date; entry: V4ShadowTradeJournalEntry; }

export function assertV4ShadowRuntimeGuards(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.SHADOW_ONLY !== 'true' || environment.PAPER_TRADING_ONLY !== 'true') {
    throw new Error('V4 shadow runtime requires SHADOW_ONLY=true and PAPER_TRADING_ONLY=true.');
  }
}

/** Tracks observable prices only. It intentionally has no order-manager or broker dependency. */
export default class V4MomentumShadowTrackerService {
  private readonly pending = new Map<string, { signalTimestamp: Date; contract: OptionContract }>();
  private readonly open = new Map<string, OpenShadow>();
  private readonly closed: V4ShadowTradeJournalEntry[] = [];
  private nextId = 1;
  private openedCount = 0;

  registerSignal(signalTimestamp: Date, contract: OptionContract): string {
    const id = `v4-shadow-${this.nextId++}`;
    this.pending.set(id, { signalTimestamp: new Date(signalTimestamp.getTime()), contract: cloneContract(contract) });
    return id;
  }

  observePremium(instrumentKey: string, premium: number, timestamp: Date): V4ShadowTradeJournalEntry[] {
    return this.observeRange(instrumentKey, premium, premium, timestamp);
  }
  observeRange(instrumentKey: string, low: number, high: number, timestamp: Date): V4ShadowTradeJournalEntry[] {
    const premium = high;
    if (!Number.isFinite(premium) || premium <= 0) return [];
    const completed: V4ShadowTradeJournalEntry[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.contract.instrumentKey !== instrumentKey) continue;
      this.pending.delete(id);
      const referencePremium = premium; const entry: V4ShadowTradeJournalEntry = { strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW', tradingDate: istDate(pending.signalTimestamp), signalTimestamp: new Date(pending.signalTimestamp.getTime()), optionInstrument: pending.contract.instrumentKey, tradingSymbol: pending.contract.tradingSymbol, strike: pending.contract.strikePrice, expiry: new Date(pending.contract.expiry.getTime()), referencePremium, targetPrice: referencePremium * 1.05, stopPrice: referencePremium * .95, exitTimestamp: null, exitReason: 'UNAVAILABLE', exitPremium: null, grossReturnPercent: null, netReturnAt020: null, netReturnAt040: null, netReturnAt060: null };
      this.open.set(id, { id, contract: pending.contract, signalTimestamp: pending.signalTimestamp, entry }); this.openedCount += 1;
    }
    for (const [id, trade] of this.open) {
      if (trade.contract.instrumentKey !== instrumentKey) continue;
      if (high >= trade.entry.targetPrice && low <= trade.entry.stopPrice) completed.push(this.ambiguous(id, timestamp));
      else if (premium >= trade.entry.targetPrice) completed.push(this.close(id, premium, timestamp, 'TARGET'));
      else if (premium <= trade.entry.stopPrice) completed.push(this.close(id, premium, timestamp, 'STOP_LOSS'));
      else if (timestamp.getTime() >= trade.signalTimestamp.getTime() + v4MomentumShadowPolicy.maximumHoldingMinutes * 60_000) completed.push(this.close(id, premium, timestamp, 'TIMEOUT'));
    }
    return completed;
  }

  advance(now: Date): V4ShadowTradeJournalEntry[] {
    const result: V4ShadowTradeJournalEntry[] = [];
    for (const [id, pending] of this.pending) if (now.getTime() >= pending.signalTimestamp.getTime() + v4MomentumShadowPolicy.maximumHoldingMinutes * 60_000) { this.pending.delete(id); result.push(this.unavailable(pending)); }
    for (const [id, trade] of this.open) if (now.getTime() >= trade.signalTimestamp.getTime() + v4MomentumShadowPolicy.maximumHoldingMinutes * 60_000) result.push(this.close(id, trade.entry.referencePremium, now, 'TIMEOUT'));
    return result;
  }
  /** EOD uses the same TIMEOUT/UNAVAILABLE journal semantics as the regular tracker. */
  closeAtSessionEnd(now: Date): V4ShadowTradeJournalEntry[] {
    const result: V4ShadowTradeJournalEntry[] = [];
    for (const [id, pending] of this.pending) { this.pending.delete(id); result.push(this.unavailable(pending)); }
    for (const [id, trade] of this.open) result.push(this.close(id, trade.entry.referencePremium, now, 'TIMEOUT'));
    return result;
  }
  getOpenCount(): number { return this.open.size + this.pending.size; }
  getOpenedCount(): number { return this.openedCount; }
  getClosed(): readonly V4ShadowTradeJournalEntry[] { return this.closed.map(cloneEntry); }

  private close(id: string, premium: number, timestamp: Date, exitReason: Exclude<V4ShadowExitReason, 'UNAVAILABLE' | 'AMBIGUOUS'>): V4ShadowTradeJournalEntry {
    const trade = this.open.get(id); if (!trade) throw new Error('Shadow tracker cannot close an unknown trade.'); this.open.delete(id);
    const gross = (premium - trade.entry.referencePremium) / trade.entry.referencePremium * 100;
    const entry = { ...trade.entry, exitTimestamp: new Date(timestamp.getTime()), exitReason, exitPremium: premium, grossReturnPercent: gross, netReturnAt020: gross - .2, netReturnAt040: gross - .4, netReturnAt060: gross - .6 } as V4ShadowTradeJournalEntry;
    this.closed.push(entry); return cloneEntry(entry);
  }
  private unavailable(pending: { signalTimestamp: Date; contract: OptionContract }): V4ShadowTradeJournalEntry {
    const entry: V4ShadowTradeJournalEntry = { strategyId: 'V4_NIFTY_MOMENTUM_PE_SHADOW', tradingDate: istDate(pending.signalTimestamp), signalTimestamp: new Date(pending.signalTimestamp.getTime()), optionInstrument: pending.contract.instrumentKey, tradingSymbol: pending.contract.tradingSymbol, strike: pending.contract.strikePrice, expiry: new Date(pending.contract.expiry.getTime()), referencePremium: 0, targetPrice: 0, stopPrice: 0, exitTimestamp: null, exitReason: 'UNAVAILABLE', exitPremium: null, grossReturnPercent: null, netReturnAt020: null, netReturnAt040: null, netReturnAt060: null };
    this.closed.push(entry); return cloneEntry(entry);
  }
  private ambiguous(id: string, timestamp: Date): V4ShadowTradeJournalEntry {
    const trade = this.open.get(id); if (!trade) throw new Error('Shadow tracker cannot mark an unknown trade ambiguous.'); this.open.delete(id);
    const entry: V4ShadowTradeJournalEntry = { ...trade.entry, exitTimestamp: new Date(timestamp.getTime()), exitReason: 'AMBIGUOUS', exitPremium: null, grossReturnPercent: null, netReturnAt020: null, netReturnAt040: null, netReturnAt060: null };
    this.closed.push(entry); return cloneEntry(entry);
  }
}
function istDate(value: Date): string { const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; }
function cloneContract(value: OptionContract): OptionContract { return { ...value, expiry: new Date(value.expiry.getTime()) }; }
function cloneEntry(value: V4ShadowTradeJournalEntry): V4ShadowTradeJournalEntry { return { ...value, signalTimestamp: new Date(value.signalTimestamp.getTime()), expiry: new Date(value.expiry.getTime()), exitTimestamp: value.exitTimestamp ? new Date(value.exitTimestamp.getTime()) : null }; }
