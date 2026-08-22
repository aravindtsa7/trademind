import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ExecutionQuoteQuality = 'BID_ASK' | 'LTP_ONLY' | 'STALE_QUOTE' | 'UNAVAILABLE';
export type EntryPriceSource = 'ASK' | 'BID' | 'ESTIMATED_LTP' | 'UNAVAILABLE';
export type ForwardExitReason = 'TARGET' | 'STOP' | 'TIMEOUT' | 'EOD' | 'AMBIGUOUS' | 'UNAVAILABLE';
export type ForwardSessionOutcome = 'VALID_COMPLETED' | 'MANUAL_STOP' | 'INVALID_DATA' | 'FAULTED' | 'RECONCILIATION_REQUIRED';

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
  recordType: 'SESSION' | 'SIGNAL' | 'ENTRY' | 'EXIT' | 'SUMMARY' | 'EVENT';
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
  eventType?: string;
  eventAt?: string;
  details?: Record<string, string | number | boolean | null>;
}

export function strategyFingerprint(parameters: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortObject(parameters));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function uniqueForwardTradingDates(records: readonly Pick<ForwardJournalRecord, 'tradingDate'>[]): string[] {
  return [...new Set(records.map((record) => record.tradingDate))].sort();
}

export function costStressExpectancy(returns: readonly number[], costs: readonly number[] = [.2, .4, .6, .8, 1]): Record<string, number> {
  const average = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  return Object.fromEntries(costs.map((cost) => [`netAt${String(cost).replace('.', '')}`, returns.length ? average - cost : 0]));
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
  constructor(private readonly strategyId: string, private readonly fingerprint: string, directory = resolve(process.cwd(), 'artifacts', 'forward-validation')) {
    this.directory = directory;
    this.assertExistingFingerprints();
  }
  append(record: ForwardJournalRecord): void {
    if (record.strategyId !== this.strategyId || record.fingerprint !== this.fingerprint) throw new Error('Forward journal fingerprint/strategy mismatch; refusing to merge observations.');
    const path = this.path(record.tradingDate);
    mkdirSync(dirname(path), { recursive: true });
    if (record.signalId && (record.recordType === 'SIGNAL' || record.recordType === 'ENTRY' || record.recordType === 'EXIT') && this.hasDuplicateSignalRecord(path, record)) return;
    appendFileSync(path, `${JSON.stringify({ ...record, strategyId: this.strategyId, fingerprint: this.fingerprint })}\n`, 'utf8');
  }
  read(tradingDate?: string): ForwardJournalRecord[] {
    const path = tradingDate ? this.path(tradingDate) : resolve(this.directory, this.strategyId, 'journal.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ForwardJournalRecord);
  }
  hasRecordsForDate(tradingDate: string): boolean {
    return existsSync(this.path(tradingDate));
  }
  appendEvent(tradingDate: string, eventType: string, flags: string[] = [], details?: Record<string, string | number | boolean | null>): void {
    this.append({ recordType: 'EVENT', tradingDate, strategyId: this.strategyId, fingerprint: this.fingerprint, eventType, eventAt: new Date().toISOString(), flags, details });
  }
  private assertExistingFingerprints(): void {
    const strategyDirectory = resolve(this.directory, this.strategyId);
    if (!existsSync(strategyDirectory)) return;
    for (const file of readdirSync(strategyDirectory).filter((value) => value.endsWith('.jsonl'))) {
      const path = resolve(strategyDirectory, file);
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const record = JSON.parse(line) as Partial<ForwardJournalRecord>;
        if (record.strategyId === this.strategyId && record.fingerprint && record.fingerprint !== this.fingerprint) {
          throw new Error('Forward journal fingerprint mismatch; refusing to merge observations.');
        }
      }
    }
  }
  private hasDuplicateSignalRecord(path: string, record: ForwardJournalRecord): boolean {
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
      const existing = JSON.parse(line) as Partial<ForwardJournalRecord>;
      return existing.recordType === record.recordType && existing.signalId === record.signalId;
    });
  }
  private path(tradingDate: string): string { return resolve(this.directory, this.strategyId, `${tradingDate}.jsonl`); }
}

function finite(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value); }
function sortObject(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortObject); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortObject(child)])); }

export function resolveSessionOutcome(options: {
  reason?: string;
  reconciliationRequired?: boolean;
  durableExitDrained?: boolean;
  invalidData?: boolean;
  startupDataBlocked?: boolean;
}): {
  status: ForwardSessionOutcome;
  sessionCompleted: boolean;
} {
  // Precedence 1: Reconciliation uncertainty has highest precedence.
  if (options.durableExitDrained === false || options.reconciliationRequired === true) {
    return { status: 'RECONCILIATION_REQUIRED', sessionCompleted: false };
  }
  const reason = options.reason ?? '';
  // Precedence 2: Explicit runtime/host FAULTED signal.
  if (reason === 'FAULTED') {
    return { status: 'FAULTED', sessionCompleted: false };
  }
  // Precedence 3: Explicit startup/warmup data or readiness blocker.
  if (options.invalidData === true || options.startupDataBlocked === true || reason === 'INVALID_DATA') {
    return { status: 'INVALID_DATA', sessionCompleted: false };
  }
  // Precedence 4: Explicit recognized manual stop signals.
  if (
    reason === 'SIGINT' ||
    reason === 'SIGTERM' ||
    reason === 'MANUAL_STOP' ||
    reason === 'MANUAL_SHUTDOWN'
  ) {
    return { status: 'MANUAL_STOP', sessionCompleted: false };
  }
  // Precedence 5: Explicit canonical NSE session EOD completion.
  if (
    reason === 'VALID_COMPLETED' ||
    reason === 'EOD' ||
    reason === 'WALL_CLOCK_EOD' ||
    reason === 'MARKET_EOD' ||
    reason === 'EOD_NSE_SESSION_CLOSE' ||
    reason === 'SESSION_END'
  ) {
    return { status: 'VALID_COMPLETED', sessionCompleted: true };
  }
  // Fail-closed fallback: any unrecognized, unknown, or anomalous reason is treated as FAULTED,
  // NOT as an operator manual stop or valid completion.
  return { status: 'FAULTED', sessionCompleted: false };
}

export interface ForwardValidationSummary {
  strategyId: string;
  sessionsObserved: number;
  signals: number;
  resolvedTrades: number;
  unresolvedTrades: number;
  theoreticalExpectancy: number;
  executableEstimatedExpectancy: number;
  spreadSlippageAverage: number;
  spreadSlippageMedian: number;
  spreadSlippageP90: number;
  bidAskCoveragePct: number;
  staleQuotePct: number;
  targetRate: number;
  stopRate: number;
  timeoutRate: number;
  eodRate: number;
  profitableDayPct: number;
  maxDrawdown: number;
  maxLossStreak: number;
  costStress: Record<string, number>;
  infrastructureEventCount: number;
  infrastructureEventTypes: string[];
  dataQualityFlags: string[];
  timeOfDayFriction: Record<string, { count: number; average: number; median: number; p90: number }>;
  premiumBucketFriction: Record<string, { count: number; average: number; median: number; p90: number }>;
  promotionDiagnostic: string;
  excludedDateDiagnostics: {
    manualStopCount: number;
    faultedCount: number;
    invalidDataCount: number;
    reconciliationRequiredCount: number;
    legacyCompletedCount: number;
    duplicateSummaryCount: number;
    missingSummaryCount: number;
  };
}

export function summarizeForwardValidation(strategyId: string, records: readonly ForwardJournalRecord[]): ForwardValidationSummary {
  const summariesByDate = new Map<string, ForwardJournalRecord[]>();
  for (const record of records) {
    if (record.recordType === 'SUMMARY') {
      const list = summariesByDate.get(record.tradingDate) ?? [];
      list.push(record);
      summariesByDate.set(record.tradingDate, list);
    }
  }

  const allDates = [...new Set(records.map((r) => r.tradingDate))].sort();
  const eligibleDates = new Set<string>();
  const manualStopDates = new Set<string>();
  const faultedDates = new Set<string>();
  const invalidDataDates = new Set<string>();
  const reconciliationRequiredDates = new Set<string>();
  const legacyCompletedDates = new Set<string>();
  const duplicateSummaryDates = new Set<string>();
  const missingSummaryDates = new Set<string>();

  for (const date of allDates) {
    const summaries = summariesByDate.get(date) ?? [];
    if (summaries.length === 0) {
      missingSummaryDates.add(date);
    } else if (summaries.length > 1) {
      duplicateSummaryDates.add(date);
    } else {
      const s = summaries[0];
      if (s.status === 'VALID_COMPLETED' && s.sessionCompleted === true) {
        eligibleDates.add(date);
      } else if (s.status === 'COMPLETED') {
        legacyCompletedDates.add(date);
      } else if (s.status === 'MANUAL_STOP') {
        manualStopDates.add(date);
      } else if (s.status === 'FAULTED') {
        faultedDates.add(date);
      } else if (s.status === 'INVALID_DATA') {
        invalidDataDates.add(date);
      } else if (s.status === 'RECONCILIATION_REQUIRED') {
        reconciliationRequiredDates.add(date);
      } else {
        legacyCompletedDates.add(date);
      }
    }
  }

  const eligibleRecords = records.filter((r) => eligibleDates.has(r.tradingDate));
  const signals = eligibleRecords.filter((r) => r.recordType === 'SIGNAL');
  const exits = eligibleRecords.filter((r) => r.recordType === 'EXIT');
  const events = eligibleRecords.filter((r) => r.recordType === 'EVENT');

  const frictions = exits.map((r) => r.totalExecutionFrictionPercent).filter((v): v is number => v !== undefined && Number.isFinite(v));
  const executable = exits.map((r) => r.executableEstimatedReturn).filter((v): v is number => v !== undefined && v !== null && Number.isFinite(v));
  const theoretical = exits.map((r) => r.theoreticalReturn).filter((v): v is number => v !== undefined && v !== null && Number.isFinite(v));

  // Daily-PnL metrics preserve pre-A9 exit/PnL-bearing-day semantics: only eligible dates
  // that actually contain eligible EXIT/PnL evidence participate in the daily-PnL sequence,
  // profitableDayPct denominator, maxDrawdown, and maxLossStreak. Valid zero-trade sessions
  // count in sessionsObserved, but do not dilute daily-PnL metrics with synthetic 0% returns.
  const byDate = new Map<string, number>();
  for (const record of exits) {
    if (record.executableEstimatedReturn !== null && record.executableEstimatedReturn !== undefined && Number.isFinite(record.executableEstimatedReturn)) {
      byDate.set(record.tradingDate, (byDate.get(record.tradingDate) ?? 0) + record.executableEstimatedReturn);
    }
  }

  const sessionsObserved = eligibleDates.size;
  const dateValues = [...byDate.values()];

  return {
    strategyId,
    sessionsObserved,
    signals: signals.length,
    resolvedTrades: exits.filter((r) => r.executableEstimatedReturn !== null && r.executableEstimatedReturn !== undefined).length,
    unresolvedTrades: exits.filter((r) => r.executableEstimatedReturn === null || r.executableEstimatedReturn === undefined).length,
    theoreticalExpectancy: average(theoretical),
    executableEstimatedExpectancy: average(executable),
    spreadSlippageAverage: average(frictions),
    spreadSlippageMedian: median(frictions),
    spreadSlippageP90: percentile(frictions, 0.9),
    bidAskCoveragePct: quoteCoverage(exits),
    staleQuotePct: staleRate(exits),
    targetRate: rate(exits, ['TARGET']),
    stopRate: rate(exits, ['STOP']),
    timeoutRate: rate(exits, ['TIMEOUT']),
    eodRate: rate(exits, ['EOD']),
    profitableDayPct: dateValues.length ? (dateValues.filter((v) => v > 0).length / dateValues.length) * 100 : 0,
    maxDrawdown: maxDrawdown(dateValues),
    maxLossStreak: streak(dateValues.map((v) => v < 0)),
    costStress: costStressExpectancy(theoretical),
    infrastructureEventCount: events.length,
    infrastructureEventTypes: [...new Set(events.map((r) => r.eventType).filter((v): v is string => Boolean(v)))],
    dataQualityFlags: [...new Set(eligibleRecords.flatMap((r) => r.flags ?? []))],
    timeOfDayFriction: bucket(exits, timeBucket),
    premiumBucketFriction: bucket(exits, premiumBucket),
    promotionDiagnostic: promotionDiagnostic(sessionsObserved, exits),
    excludedDateDiagnostics: {
      manualStopCount: manualStopDates.size,
      faultedCount: faultedDates.size,
      invalidDataCount: invalidDataDates.size,
      reconciliationRequiredCount: reconciliationRequiredDates.size,
      legacyCompletedCount: legacyCompletedDates.size,
      duplicateSummaryCount: duplicateSummaryDates.size,
      missingSummaryCount: missingSummaryDates.size,
    },
  };
}

function average(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: readonly number[]): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function percentile(values: readonly number[], p: number): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; }
function rate(records: readonly ForwardJournalRecord[], reasons: readonly string[]): number { return records.length ? (records.filter((r) => reasons.includes(r.exitReason ?? '')).length / records.length) * 100 : 0; }
function quoteCoverage(records: readonly ForwardJournalRecord[]): number { return records.length ? (records.filter((r) => r.executionQuoteQuality === 'BID_ASK').length / records.length) * 100 : 0; }
function staleRate(records: readonly ForwardJournalRecord[]): number { return records.length ? (records.filter((r) => r.executionQuoteQuality === 'STALE_QUOTE' || (r.flags ?? []).includes('STALE_OPTION_QUOTE')).length / records.length) * 100 : 0; }
function maxDrawdown(values: readonly number[]): number { let equity = 0; let peak = 0; let drawdown = 0; values.forEach((value) => { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }); return drawdown; }
function streak(values: readonly boolean[]): number { let current = 0; let best = 0; values.forEach((value) => { current = value ? current + 1 : 0; best = Math.max(best, current); }); return best; }
function timeBucket(record: ForwardJournalRecord): string { const hour = record.signalTimestampIst ? Number(record.signalTimestampIst.slice(11, 13)) * 60 + Number(record.signalTimestampIst.slice(14, 16)) : -1; return hour < 570 ? '09:15-09:30' : hour < 630 ? '09:30-10:30' : hour < 720 ? '10:30-12:00' : hour < 840 ? '12:00-14:00' : hour < 900 ? '14:00-15:00' : '15:00-15:30'; }
function premiumBucket(record: ForwardJournalRecord): string { const value = record.theoreticalEntryPrice ?? -1; return value < 50 ? '<50' : value < 75 ? '50-75' : value < 100 ? '75-100' : value < 125 ? '100-125' : value <= 200 ? '125-200' : '>200'; }
function bucket(records: readonly ForwardJournalRecord[], selector: (record: ForwardJournalRecord) => string): Record<string, { count: number; average: number; median: number; p90: number }> { const groups = new Map<string, number[]>(); records.forEach((record) => { const value = record.totalExecutionFrictionPercent; if (value === undefined || value === null) return; groups.set(selector(record), [...(groups.get(selector(record)) ?? []), value]); }); return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, { count: values.length, average: average(values), median: median(values), p90: percentile(values, 0.9) }])); }
function promotionDiagnostic(validSessionsCount: number, exits: readonly ForwardJournalRecord[]): string { const resolved = exits.filter((r) => r.executableEstimatedReturn !== null && r.executableEstimatedReturn !== undefined).length; if (resolved === 0 && validSessionsCount === 0) return 'NOT_ENOUGH_FORWARD_DATA'; if (resolved === 0) return 'NO_RESOLVED_TRADES'; return resolved >= 30 && validSessionsCount >= 20 ? 'ELIGIBLE_FOR_MANUAL_REVIEW' : 'CONTINUE_FORWARD_VALIDATION'; }
