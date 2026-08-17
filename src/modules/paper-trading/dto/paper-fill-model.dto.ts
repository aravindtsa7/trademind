export type ExecutionQuoteDataQuality = 'FRESH_DEPTH' | 'FRESH_TOP_OF_BOOK' | 'LTP_ONLY' | 'STALE' | 'CROSSED' | 'EMPTY' | 'UNAVAILABLE';
export type PaperFillStatus = 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'UNAVAILABLE' | 'REJECTED';
export type PaperFillQuality = 'DEPTH_VWAP' | 'TOP_OF_BOOK_ESTIMATE' | 'LTP_ONLY_ESTIMATE' | 'INSUFFICIENT_DEPTH' | 'UNAVAILABLE' | 'REJECTED_WIDE_SPREAD';
export type PaperExecutionSide = 'BUY' | 'SELL';

export interface ExecutionDepthLevel {
  bid?: number;
  bidSize?: number;
  ask?: number;
  askSize?: number;
}

/** Immutable observation of exchange data; it contains no inferred prices. */
export interface ExecutionQuoteSnapshot {
  /** Deterministic identifier for this immutable market observation. */
  snapshotId?: string;
  instrumentKey: string;
  sourceTimestamp: string | null;
  receivedTimestamp: string;
  quoteAgeMs: number | null;
  ltpSourceTimestamp?: string | null;
  ltpReceivedTimestamp?: string | null;
  ltpAgeMs?: number | null;
  bidSourceTimestamp?: string | null;
  bidReceivedTimestamp?: string | null;
  bidAgeMs?: number | null;
  askSourceTimestamp?: string | null;
  askReceivedTimestamp?: string | null;
  askAgeMs?: number | null;
  depthSourceTimestamp?: string | null;
  depthReceivedTimestamp?: string | null;
  depthAgeMs?: number | null;
  ltp: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  depthLevels: readonly ExecutionDepthLevel[];
  spreadAbsolute: number | null;
  spreadPercent: number | null;
  connectionGenerationId: number | null;
  dataQuality: ExecutionQuoteDataQuality;
}

export interface PaperExecutionFillResult {
  status: PaperFillStatus;
  reason?: 'LATENCY_NOT_ELIGIBLE' | 'STALE_QUOTE' | 'CROSSED_MARKET' | 'EMPTY_QUOTE' | 'LTP_FALLBACK_DISABLED' | 'REJECTED_WIDE_SPREAD' | 'INSUFFICIENT_DEPTH';
  side: PaperExecutionSide;
  requestedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  averageFillPrice: number | null;
  worstFillPrice: number | null;
  quotedBestPrice: number | null;
  levelsConsumed: readonly { level: number; price: number; quantity: number }[];
  slippageVsBestQuote: number | null;
  slippageVsLtp: number | null;
  spreadCost: number | null;
  depthSlippage: number | null;
  totalExecutionSlippage: number | null;
  slippagePercent: number | null;
  fillQuality: PaperFillQuality;
  quote: ExecutionQuoteSnapshot;
}

export interface PaperExecutionFillSummary {
  status: Extract<PaperFillStatus, 'FILLED' | 'PARTIALLY_FILLED'>;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice: number;
  worstFillPrice: number;
  quotedBestPrice: number;
  fillQuality: Extract<PaperFillQuality, 'DEPTH_VWAP' | 'TOP_OF_BOOK_ESTIMATE' | 'LTP_ONLY_ESTIMATE'>;
  slippageVsBestQuote: number;
  slippageVsLtp: number | null;
  spreadCost: number | null;
  depthSlippage: number;
  totalExecutionSlippage: number;
  slippagePercent: number;
  sourceTimestamp: string | null;
  quoteDataQuality: ExecutionQuoteDataQuality;
}
