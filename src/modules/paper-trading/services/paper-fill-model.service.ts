import { ExecutionQuoteSnapshot, PaperExecutionFillResult, PaperExecutionFillSummary, PaperExecutionSide } from '../dto/paper-fill-model.dto';

export interface PaperFillModelOptions { maxQuoteAgeMs?: number; maxSpreadPercent?: number; allowLtpFallback?: boolean; executionLatencyMs?: number; }
export interface PaperFillRequest { side: PaperExecutionSide; requestedQuantity: number; quote: ExecutionQuoteSnapshot | undefined; intentTimestamp: Date; }

/** Deterministic execution-quality model. It never creates a market price. */
export default class PaperFillModelService {
  readonly maxQuoteAgeMs: number;
  readonly maxSpreadPercent: number;
  readonly allowLtpFallback: boolean;
  readonly executionLatencyMs: number;

  constructor(options: PaperFillModelOptions = {}) {
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? numberEnv('PAPER_FILL_MAX_QUOTE_AGE_MS', 2_000);
    this.maxSpreadPercent = options.maxSpreadPercent ?? numberEnv('PAPER_MAX_SPREAD_PERCENT', 5);
    this.allowLtpFallback = options.allowLtpFallback ?? process.env.PAPER_FILL_ALLOW_LTP_FALLBACK === 'true';
    this.executionLatencyMs = options.executionLatencyMs ?? numberEnv('PAPER_EXECUTION_LATENCY_MS', 0);
  }

  fill(request: PaperFillRequest): PaperExecutionFillResult {
    if (!Number.isInteger(request.requestedQuantity) || request.requestedQuantity <= 0) throw new Error('requestedQuantity must be a positive integer.');
    const quote = request.quote ?? unavailableQuote();
    const base = (overrides: Partial<PaperExecutionFillResult>): PaperExecutionFillResult => ({ status:'UNAVAILABLE', side:request.side, requestedQuantity:request.requestedQuantity, filledQuantity:0, remainingQuantity:request.requestedQuantity, averageFillPrice:null, worstFillPrice:null, quotedBestPrice:null, levelsConsumed:[], slippageVsBestQuote:null, slippageVsLtp:null, spreadCost:null, depthSlippage:null, totalExecutionSlippage:null, slippagePercent:null, fillQuality:'UNAVAILABLE', quote, ...overrides });
    const eligibleAt = request.intentTimestamp.getTime() + this.executionLatencyMs;
    const sourceAt = quote.sourceTimestamp ? new Date(quote.sourceTimestamp).getTime() : Number.NaN;
    if (this.executionLatencyMs > 0 && (!Number.isFinite(sourceAt) || sourceAt < eligibleAt)) return base({ reason:'LATENCY_NOT_ELIGIBLE' });
    if (quote.dataQuality === 'STALE' || quote.quoteAgeMs === null || quote.quoteAgeMs > this.maxQuoteAgeMs) return base({ reason:'STALE_QUOTE' });
    if (quote.dataQuality === 'CROSSED' || (positive(quote.bestBid) && positive(quote.bestAsk) && quote.bestBid >= quote.bestAsk)) return base({ reason:'CROSSED_MARKET' });
    if (quote.spreadPercent !== null && quote.spreadPercent > this.maxSpreadPercent) return base({ status:'REJECTED', reason:'REJECTED_WIDE_SPREAD', fillQuality:'REJECTED_WIDE_SPREAD' });
    const best = request.side === 'BUY' ? quote.bestAsk : quote.bestBid;
    if (quote.dataQuality === 'LTP_ONLY') {
      if (!this.allowLtpFallback || !positive(quote.ltp)) return base({ reason:'LTP_FALLBACK_DISABLED' });
      return completed(base, request, quote.ltp!, quote.ltp!, 'LTP_ONLY_ESTIMATE', [], quote.ltp!);
    }
    if (!positive(best)) return base({ reason: quote.dataQuality === 'EMPTY' ? 'EMPTY_QUOTE' : 'EMPTY_QUOTE' });
    const levels = quote.depthLevels.map((level, index) => request.side === 'BUY' ? { level:index, price:level.ask, quantity:level.askSize } : { level:index, price:level.bid, quantity:level.bidSize }).filter((level): level is { level:number; price:number; quantity:number } => positive(level.price) && positiveInteger(level.quantity));
    if (levels.length === 0) return completed(base, request, best!, best!, 'TOP_OF_BOOK_ESTIMATE', [], best!);
    let remaining = request.requestedQuantity; const consumed: { level:number; price:number; quantity:number }[] = [];
    for (const level of levels) { if (remaining <= 0) break; const quantity = Math.min(remaining, level.quantity); consumed.push({ level:level.level, price:level.price, quantity }); remaining -= quantity; }
    const filled = request.requestedQuantity - remaining;
    if (filled === 0) return base({ reason:'INSUFFICIENT_DEPTH', fillQuality:'INSUFFICIENT_DEPTH' });
    const average = consumed.reduce((sum, level) => sum + level.price * level.quantity, 0) / filled;
    const worst = consumed[consumed.length - 1].price;
    const result = completed(base, request, average, worst, 'DEPTH_VWAP', consumed, best!);
    return remaining === 0 ? result : { ...result, status:'PARTIALLY_FILLED', reason:'INSUFFICIENT_DEPTH', filledQuantity:filled, remainingQuantity:remaining };
  }

  toSummary(fill: PaperExecutionFillResult): PaperExecutionFillSummary | undefined {
    if ((fill.status !== 'FILLED' && fill.status !== 'PARTIALLY_FILLED') || fill.averageFillPrice === null || fill.worstFillPrice === null || fill.quotedBestPrice === null || fill.slippageVsBestQuote === null || fill.depthSlippage === null || fill.totalExecutionSlippage === null || fill.slippagePercent === null || !['DEPTH_VWAP','TOP_OF_BOOK_ESTIMATE','LTP_ONLY_ESTIMATE'].includes(fill.fillQuality)) return undefined;
    return { status:fill.status, requestedQuantity:fill.requestedQuantity, filledQuantity:fill.filledQuantity, averageFillPrice:fill.averageFillPrice, worstFillPrice:fill.worstFillPrice, quotedBestPrice:fill.quotedBestPrice, fillQuality:fill.fillQuality as PaperExecutionFillSummary['fillQuality'], slippageVsBestQuote:fill.slippageVsBestQuote, slippageVsLtp:fill.slippageVsLtp, spreadCost:fill.spreadCost, depthSlippage:fill.depthSlippage, totalExecutionSlippage:fill.totalExecutionSlippage, slippagePercent:fill.slippagePercent, sourceTimestamp:fill.quote.sourceTimestamp, quoteDataQuality:fill.quote.dataQuality };
  }
}

export class PaperFillUnavailableError extends Error { constructor(public readonly fill: PaperExecutionFillResult) { super(`Paper fill unavailable: ${fill.reason ?? fill.status}`); this.name = 'PaperFillUnavailableError'; } }

function completed(base: (overrides: Partial<PaperExecutionFillResult>) => PaperExecutionFillResult, request: PaperFillRequest, average: number, worst: number, quality: 'DEPTH_VWAP'|'TOP_OF_BOOK_ESTIMATE'|'LTP_ONLY_ESTIMATE', levels: readonly { level:number; price:number; quantity:number }[], best: number): PaperExecutionFillResult {
  const direction = request.side === 'BUY' ? 1 : -1; const ltp = request.quote?.ltp ?? null; const slippageBest = direction * (average - best); const slippageLtp = ltp === null ? null : direction * (average - ltp); const spreadCost = request.quote?.spreadAbsolute === null || request.quote?.spreadAbsolute === undefined ? null : request.quote.spreadAbsolute / 2;
  return base({ status:'FILLED', filledQuantity:request.requestedQuantity, remainingQuantity:0, averageFillPrice:average, worstFillPrice:worst, quotedBestPrice:best, levelsConsumed:levels, slippageVsBestQuote:slippageBest, slippageVsLtp:slippageLtp, spreadCost, depthSlippage:slippageBest, totalExecutionSlippage:slippageLtp ?? slippageBest, slippagePercent: (slippageLtp ?? slippageBest) / average * 100, fillQuality:quality });
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function numberEnv(name: string, fallback: number): number { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) && value >= 0 ? value : fallback; }
function unavailableQuote(): ExecutionQuoteSnapshot { return { instrumentKey:'', sourceTimestamp:null, receivedTimestamp:new Date(0).toISOString(), quoteAgeMs:null, ltp:null, bestBid:null, bestAsk:null, bidSize:null, askSize:null, depthLevels:[], spreadAbsolute:null, spreadPercent:null, connectionGenerationId:null, dataQuality:'UNAVAILABLE' }; }
