import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ExecutionQuoteQuality = 'BID_ASK' | 'LTP_ONLY' | 'STALE_QUOTE' | 'UNAVAILABLE';
export type EntryPriceSource = 'ASK' | 'BID' | 'ESTIMATED_LTP' | 'UNAVAILABLE';
export type ForwardExitReason = 'TARGET' | 'STOP' | 'TIMEOUT' | 'EOD' | 'AMBIGUOUS' | 'UNAVAILABLE';

export interface QuoteSnapshot {
  ltp?: number;
  bid?: number;
  ask?: number;
  bidQuantity?: number;
  askQuantity?: number;
  timestamp?: string | Date;
}

export interface NormalizedQuote {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  spreadAbsolute: number | null;
  spreadPercent: number | null;
  quoteAgeMilliseconds: number | null;
  quality: ExecutionQuoteQuality;
}

export interface ForwardJournalRecord {
  recordType: 'SESSION' | 'SIGNAL' | 'ENTRY' | 'EXIT' | 'SUMMARY';
  tradingDate: string;
  strategyId: string;
  fingerprint: string;
  runtimeStartedAt?: string;
  warmupReadyAt?: string;
  marketDataHealthy?: boolean;
  sessionCompleted?: boolean;
  eodReason?: string;
  signalId?: string;
  signalTimestampIst?: string;
  signalTimestampUtc?: string;
  underlyingInstrument?: string;
  underlyingClose?: number;
  regime?: string;
  indicators?: Record<string, number | string | boolean | null>;
  selectedOptionInstrument?: string;
  optionType?: 'CE' | 'PE';
  strike?: number;
  expiry?: string;
  signalReason?: string;
  theoreticalEntryPrice?: number | null;
  executableEntryPrice?: number | null;
  entryPriceSource?: EntryPriceSource;
  estimatedEntrySlippage?: number | null;
  estimatedEntrySlippagePct?: number | null;
  theoreticalExitPrice?: number | null;
  executableExitPrice?: number | null;
  exitPriceSource?: EntryPriceSource;
  estimatedExitSlippage?: number | null;
  estimatedExitSlippagePct?: number | null;
  exitReason?: ForwardExitReason;
  theoreticalReturn?: number | null;
  executableEstimatedReturn?: number | null;
  totalEstimatedSlippage?: number | null;
  totalExecutionFrictionPercent?: number | null;
  executionQuoteQuality?: ExecutionQuoteQuality;
  quote?: NormalizedQuote;
  flags?: string[];
  warnings?: string[];
  errors?: string[];
  signals?: number;
  resolvedTrades?: number;
  unresolvedTrades?: number;
  target?: number;
  stop?: number;
  timeout?: number;
  eod?: number;
  averageTheoretical?: number;
  averageExecutable?: number;
  averageFriction?: number;
  staleQuoteCount?: number;
  bidAskCoveragePct?: number;
  status?: string;
}

export function strategyFingerprint(parameters: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortObject(parameters));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function normalizeQuote(snapshot: QuoteSnapshot, observedAt: Date, staleThresholdMilliseconds = 2_000): NormalizedQuote {
  const ltp = finite(snapshot.ltp) ? snapshot.ltp! : null;
  const bid = finite(snapshot.bid) ? snapshot.bid! : null;
  const ask = finite(snapshot.ask) ? snapshot.ask! : null;
  const quoteTimestamp = snapshot.timestamp ? new Date(snapshot.timestamp).getTime() : NaN;
  const age = Number.isFinite(quoteTimestamp) ? Math.max(0, observedAt.getTime() - quoteTimestamp) : null;
  const stale = age !== null && age > staleThresholdMilliseconds;
  const quality: ExecutionQuoteQuality = stale ? 'STALE_QUOTE' : bid !== null && ask !== null ? 'BID_ASK' : ltp !== null ? 'LTP_ONLY' : 'UNAVAILABLE';
  const spreadAbsolute = bid !== null && ask !== null ? ask - bid : null;
  const spreadPercent = spreadAbsolute !== null && ltp !== null && ltp !== 0 ? spreadAbsolute / ltp * 100 : null;
  return { ltp, bid, ask, spreadAbsolute, spreadPercent, quoteAgeMilliseconds: age, quality };
}

export function estimateEntry(quote: NormalizedQuote): { price: number | null; source: EntryPriceSource } {
  if (quote.quality === 'STALE_QUOTE') return { price: null, source: 'UNAVAILABLE' };
  if (quote.ask !== null) return { price: quote.ask, source: 'ASK' };
  if (quote.ltp !== null) return { price: quote.ltp, source: 'ESTIMATED_LTP' };
  return { price: null, source: 'UNAVAILABLE' };
}

export function estimateExit(quote: NormalizedQuote): { price: number | null; source: EntryPriceSource } {
  if (quote.quality === 'STALE_QUOTE') return { price: null, source: 'UNAVAILABLE' };
  if (quote.bid !== null) return { price: quote.bid, source: 'BID' };
  if (quote.ltp !== null) return { price: quote.ltp, source: 'ESTIMATED_LTP' };
  return { price: null, source: 'UNAVAILABLE' };
}

export function executionComparison(entryTheoretical: number, exitTheoretical: number, entryExecutable: number | null, exitExecutable: number | null) {
  const theoreticalReturn = entryTheoretical > 0 ? (exitTheoretical - entryTheoretical) / entryTheoretical * 100 : null;
  const executableEstimatedReturn = entryExecutable !== null && exitExecutable !== null && entryExecutable > 0 ? (exitExecutable - entryExecutable) / entryExecutable * 100 : null;
  const entrySlippage = entryExecutable !== null ? entryExecutable - entryTheoretical : null;
  const exitSlippage = exitExecutable !== null ? exitTheoretical - exitExecutable : null;
  const total = entrySlippage !== null && exitSlippage !== null ? entrySlippage + exitSlippage : null;
  return { theoreticalReturn, executableEstimatedReturn, entrySlippage, exitSlippage, totalEstimatedSlippage: total, totalExecutionFrictionPercent: theoreticalReturn !== null && executableEstimatedReturn !== null ? theoreticalReturn - executableEstimatedReturn : null };
}

export class ForwardValidationJournal {
  private readonly directory: string;
  constructor(private readonly strategyId: string, private readonly fingerprint: string, directory = resolve(process.cwd(), 'artifacts', 'forward-validation')) { this.directory = directory; }
  append(record: ForwardJournalRecord): void {
    if (record.strategyId !== this.strategyId || record.fingerprint !== this.fingerprint) throw new Error('Forward journal fingerprint/strategy mismatch; refusing to merge observations.');
    const path = this.path(record.tradingDate);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...record, strategyId: this.strategyId, fingerprint: this.fingerprint })}\n`, 'utf8');
  }
  read(tradingDate?: string): ForwardJournalRecord[] {
    const path = tradingDate ? this.path(tradingDate) : resolve(this.directory, this.strategyId, 'journal.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ForwardJournalRecord);
  }
  private path(tradingDate: string): string { return resolve(this.directory, this.strategyId, `${tradingDate}.jsonl`); }
}

function finite(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value); }
function sortObject(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortObject); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortObject(child)])); }

