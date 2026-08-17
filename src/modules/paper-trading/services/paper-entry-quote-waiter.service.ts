export type PaperEntryQuoteWaitReason = 'QUOTE_UNAVAILABLE' | 'STALE_QUOTE' | 'MARKET_DATA_NOT_READY' | 'EOD_BLOCK' | 'KILL_SWITCH_ACTIVE' | 'RUNTIME_DEGRADED';
export interface PaperEntryQuoteSnapshot { ltp?: number; bid?: number; ask?: number; receivedAtMs?: number; crossed?: boolean; }
export interface PaperEntryQuoteWaiterOptions {
  timeoutMs?: number; pollMs?: number; maxQuoteAgeMs?: number; now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
  getSnapshot: (instrumentKey: string) => PaperEntryQuoteSnapshot | undefined;
  abortReason: () => PaperEntryQuoteWaitReason | undefined;
  getExecutionSnapshot?: (instrumentKey: string) => ExecutionQuoteSnapshot | undefined;
}
export class PaperEntryQuoteWaitError extends Error { constructor(public readonly reason: PaperEntryQuoteWaitReason) { super(reason); this.name = 'PaperEntryQuoteWaitError'; } }

/** Bounded quote/depth acquisition after subscription and before risk approval. */
export default class PaperEntryQuoteWaiterService {
  private readonly timeoutMs: number; private readonly pollMs: number; private readonly maxQuoteAgeMs: number; private readonly now: () => number; private readonly sleep: (milliseconds:number)=>Promise<void>;
  constructor(private readonly options: PaperEntryQuoteWaiterOptions) { this.timeoutMs=options.timeoutMs ?? Number(process.env.V2_OPTION_QUOTE_WAIT_MS ?? 2_000); this.pollMs=options.pollMs ?? 25; this.maxQuoteAgeMs=options.maxQuoteAgeMs ?? Number(process.env.RISK_MAX_QUOTE_AGE_MS ?? 2_000); this.now=options.now ?? Date.now; this.sleep=options.sleep ?? ((ms)=>new Promise((resolve)=>setTimeout(resolve,ms))); }
  async waitForFreshQuote(instrumentKey: string): Promise<Required<PaperEntryQuoteSnapshot>> {
    const deadline=this.now()+this.timeoutMs; let sawQuote=false;
    while (this.now() <= deadline) {
      const abort=this.options.abortReason(); if (abort) throw new PaperEntryQuoteWaitError(abort);
      const quote=this.options.getSnapshot(instrumentKey); if (quote) sawQuote=true;
      if (this.isFresh(quote)) return { ltp:quote!.ltp!, bid:quote!.bid!, ask:quote!.ask!, receivedAtMs:quote!.receivedAtMs!, crossed:false };
      await this.sleep(this.pollMs);
    }
    throw new PaperEntryQuoteWaitError(sawQuote ? 'STALE_QUOTE' : 'QUOTE_UNAVAILABLE');
  }
  /**
   * Bounded acquisition for paper execution. It accepts only the canonical
   * bid/ask snapshot that PaperFillModel will later consume.
   */
  async waitForFreshExecutionQuote(instrumentKey: string): Promise<ExecutionQuoteSnapshot> {
    if (!this.options.getExecutionSnapshot) throw new Error('getExecutionSnapshot is required for executable quote waiting.');
    const deadline=this.now()+this.timeoutMs; let sawQuote=false;
    while (this.now() <= deadline) {
      const abort=this.options.abortReason(); if (abort) throw new PaperEntryQuoteWaitError(abort);
      const quote=this.options.getExecutionSnapshot(instrumentKey); if (quote) sawQuote=true;
      if (this.isFreshExecutable(quote)) return quote!;
      await this.sleep(this.pollMs);
    }
    throw new PaperEntryQuoteWaitError(sawQuote ? 'STALE_QUOTE' : 'QUOTE_UNAVAILABLE');
  }
  private isFresh(quote: PaperEntryQuoteSnapshot | undefined): boolean { return Boolean(quote && Number.isFinite(quote.ltp) && (quote.ltp as number)>0 && Number.isFinite(quote.bid) && (quote.bid as number)>0 && Number.isFinite(quote.ask) && (quote.ask as number)>0 && quote.crossed!==true && Number.isFinite(quote.receivedAtMs) && this.now()-(quote.receivedAtMs as number)<=this.maxQuoteAgeMs); }
  private isFreshExecutable(quote: ExecutionQuoteSnapshot | undefined): boolean { return Boolean(quote && Number.isFinite(quote.ltp) && (quote.ltp as number)>0 && Number.isFinite(quote.ltpAgeMs) && (quote.ltpAgeMs as number)<=this.maxQuoteAgeMs && Number.isFinite(quote.bestBid) && (quote.bestBid as number)>0 && Number.isFinite(quote.bestAsk) && (quote.bestAsk as number)>0 && quote.dataQuality !== 'CROSSED' && ['FRESH_DEPTH','FRESH_TOP_OF_BOOK'].includes(quote.dataQuality) && Number.isFinite(quote.quoteAgeMs) && (quote.quoteAgeMs as number)<=this.maxQuoteAgeMs); }
}
import { ExecutionQuoteSnapshot } from '../dto/paper-fill-model.dto';
