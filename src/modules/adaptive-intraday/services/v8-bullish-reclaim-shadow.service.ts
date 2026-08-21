import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import AdaptiveMarketRegimeService from './adaptive-market-regime.service';
import { prepareCrossSessionIndicatorWarmup } from '../../../tests/helpers/cross-session-indicator-warmup';
import { evaluateV8BullishReclaimFrames, V8BullishReclaimConfig, V8BullishReclaimEvaluation, V8BullishReclaimSignal, V8IndicatorContext, V8PreparedSession } from '../../research/v8-nifty-bullish-reclaim';

const v8SessionDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const v8SessionMinuteFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const V8_CLOSED_SESSION_ROW_COUNT = 375;
const V8_CLOSED_SESSION_START_MINUTE = 9 * 60 + 15;
const V8_CLOSED_SESSION_END_MINUTE = 15 * 60 + 29;
const V8_MINUTE_MS = 60_000;

/**
 * True only for a timestamp that lands exactly on a one-minute boundary
 * (zero seconds, zero milliseconds). IST is a whole-minute UTC offset
 * (+05:30 = 330 minutes), so this check is timezone-independent: it rejects
 * shapes such as 09:15:30 -> 15:29:30 that would otherwise slip past a
 * count/start/end/adjacency-only check.
 */
function v8IsMinuteAligned(value: Date): boolean {
  const time = value.getTime();
  return Number.isFinite(time) && time % V8_MINUTE_MS === 0;
}

/**
 * Matches the established research convention (see
 * `completeSession`/`isCompleteSession` in the V8 research outcome and
 * signal-distribution scripts): a CLOSED source session is complete only
 * with exactly 375 contiguous, minute-aligned one-minute rows -- all on the
 * same IST session date -- from 09:15 through 15:29 IST. This must be
 * proven independently, before any timeframe aggregation runs.
 */
export function isV8CompleteClosedSession(candles: readonly Candle[]): boolean {
  if (candles.length !== V8_CLOSED_SESSION_ROW_COUNT) return false;
  const sorted = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (!sorted.every((candle) => v8IsMinuteAligned(candle.timestamp))) return false;
  const sessionDate = v8IstDate(sorted[0].timestamp);
  if (!sorted.every((candle) => v8IstDate(candle.timestamp) === sessionDate)) return false;
  if (v8IstMinuteOfDay(sorted[0].timestamp) !== V8_CLOSED_SESSION_START_MINUTE) return false;
  if (v8IstMinuteOfDay(sorted[sorted.length - 1].timestamp) !== V8_CLOSED_SESSION_END_MINUTE) return false;
  return sorted.every((candle, index) => index === 0 || candle.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === V8_MINUTE_MS);
}

/**
 * Validates the current/forming TARGET session's raw one-minute rows as a
 * contiguous, minute-aligned prefix that starts exactly at 09:15 IST. This
 * is deliberately independent of any timeframe aggregator: the 5m
 * aggregator cannot detect a wholly-absent bucket (it only ever sees
 * buckets that have at least one row), and the 2m/3m anchored slicer hides
 * gaps entirely because it slices the array by position, not by timestamp.
 * An empty target (the session has not started yet) is trivially valid.
 * This intentionally does NOT require 375 rows -- the target is allowed to
 * be partial -- it only forbids a structurally corrupted prefix (a leading
 * gap, an interior gap, a wholly missing block, a duplicate minute, or a
 * non-minute-aligned timestamp).
 */
export function isV8ContiguousFormingSessionPrefix(candles: readonly Candle[], targetDate: string): boolean {
  if (candles.length === 0) return true;
  const sorted = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (!sorted.every((candle) => v8IstDate(candle.timestamp) === targetDate)) return false;
  if (!sorted.every((candle) => v8IsMinuteAligned(candle.timestamp))) return false;
  if (v8IstMinuteOfDay(sorted[0].timestamp) !== V8_CLOSED_SESSION_START_MINUTE) return false;
  return sorted.every((candle, index) => index === 0 || candle.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === V8_MINUTE_MS);
}

/** Deterministic fail-closed signal for a missing/incomplete required prior session. */
export type V8RequiredHistoricalSessionErrorCode = 'NO_PRIOR_SESSION_AVAILABLE' | 'REQUIRED_PRIOR_SESSION_INCOMPLETE';
export class V8RequiredHistoricalSessionError extends Error {
  constructor(public readonly code: V8RequiredHistoricalSessionErrorCode, public readonly sessionDate?: string) {
    super(code === 'NO_PRIOR_SESSION_AVAILABLE'
      ? 'V8_NO_PRIOR_HISTORICAL_SESSION_AVAILABLE'
      : `V8_REQUIRED_PRIOR_SESSION_INCOMPLETE:${sessionDate}`);
    this.name = 'V8RequiredHistoricalSessionError';
  }
}

/** Deterministic fail-closed signal for a structurally corrupted (discontinuous) target/forming session. */
export class V8TargetSessionIntegrityError extends Error {
  constructor(public readonly sessionDate: string) {
    super(`V8_TARGET_SESSION_SOURCE_DISCONTINUOUS:${sessionDate}`);
    this.name = 'V8TargetSessionIntegrityError';
  }
}

export interface V8StartupReadiness { ready: boolean; reason: string; }

function v8IstMinuteOfDay(value: Date): number {
  const parts = Object.fromEntries(v8SessionMinuteFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
function v8IstDate(value: Date): string {
  const parts = Object.fromEntries(v8SessionDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Positional PDH semantics: the closest date strictly before `targetDate` that is present in the supplied history. */
function v8FindPriorSessionDate(sessionDates: readonly string[], targetDate: string): string | undefined {
  return sessionDates.filter((date) => date < targetDate).sort().at(-1);
}

/**
 * Converts an arbitrary unknown value into a fixed, safe description for
 * OBSERVABILITY ONLY. Never throws, regardless of how hostile `value` is
 * (including a non-Error object whose own `toString()` throws) -- it always
 * falls back to a fixed string rather than propagating. This is never used
 * to decide whether/how to fault; the original `error` value is always what
 * gets passed to the host fault path.
 */
export function describeV8ErrorSafely(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
    return String(value);
  } catch {
    return '<unprintable error>';
  }
}

/**
 * Observability hooks are permitted to be either synchronous or asynchronous
 * (an implementation typed as returning `void` can still be `async` and
 * return a rejected Promise). Every V8-local best-effort wrapper below
 * therefore always `await`s the hook's result -- this observes a
 * synchronous throw and an asynchronous rejection through the exact same
 * try/catch, so neither can ever escape unobserved.
 */
export type V8ObservabilityHook = (message: string) => void | Promise<void>;
export type V8JournalHook = () => void | Promise<void>;

/** Never throws and never returns a rejected Promise: observability must never be able to affect safety control flow, whether it fails synchronously or asynchronously. */
async function v8BestEffortLog(log: V8ObservabilityHook | undefined, message: string): Promise<void> {
  try {
    await log?.(message);
  } catch {
    // Logging is best-effort only, after the safety transition has already been attempted (or, for the terminal observer, is not safety-critical at all).
  }
}

/** Never throws and never returns a rejected Promise: a journal failure -- sync or async -- and even a failure while reporting that failure, can never affect safety control flow. */
async function v8BestEffortJournal(hooks: { journal: V8JournalHook; log?: V8ObservabilityHook }, description: string): Promise<void> {
  try {
    await hooks.journal();
  } catch (journalError) {
    await v8BestEffortLog(hooks.log, `[V8_EVALUATOR_FAULT_JOURNAL_WRITE_FAILED] ${describeV8ErrorSafely(journalError)} (original failure: ${description})`);
  }
}

/**
 * Routes a completed-candle processing failure through the fail-closed host
 * fault path. `hooks.fault(error)` -- with the ORIGINAL, unnormalized error
 * value -- is the FIRST thing this function does; nothing that can throw or
 * reject (message normalization, `String(error)`, logging, journaling) runs
 * before it. Every observability step (log, journal, journal-failure log)
 * runs strictly AFTER the fault attempt has settled, inside a `finally`
 * block, and each one is individually guaranteed to never throw AND never
 * return a rejected Promise -- an observability failure, synchronous or
 * asynchronous, can never suppress, delay, or replace the fault attempt or
 * its rejection (per JS try/finally semantics, a finally block that itself
 * throws/rejects would otherwise silently replace the try block's
 * rejection, which is exactly why every helper awaited here is
 * unconditionally non-rejecting). If `hooks.fault` itself rejects (e.g.
 * onFault/shutdown fails after StrategyHostLifecycle has already
 * transitioned to FAULTED), that rejection still propagates out of this
 * function once the best-effort observability has run, so the caller's own
 * terminal containment (never an unhandled rejection) still applies.
 * Colocated here (rather than only inline in the live entrypoint) so this
 * exact ordering is directly unit-testable without launching the full live
 * process.
 */
export async function routeV8CompletedCandleFailure(
  error: unknown,
  hooks: { journal: V8JournalHook; fault: (error: unknown) => Promise<void>; log?: V8ObservabilityHook },
): Promise<void> {
  try {
    await hooks.fault(error);
  } finally {
    const description = describeV8ErrorSafely(error);
    await v8BestEffortLog(hooks.log, `[V8_EVALUATOR_FAULT] ${description}`);
    await v8BestEffortJournal(hooks, description);
  }
}

/**
 * Guaranteed-nonthrowing, guaranteed-nonrejecting terminal observer for a
 * Promise that must never become an unhandled rejection (the
 * completed-candle EventEmitter listener's `.catch(...)`). Any failure in
 * the supplied `log` callback itself -- synchronous throw or asynchronous
 * rejection, including a hostile `error` whose formatting would otherwise
 * throw -- is observed and swallowed here via the same best-effort helper
 * used post-fault: observability can never create a second, unobserved
 * rejection on top of the one already being terminated. Callers may safely
 * leave the returned Promise unawaited (it is guaranteed to always
 * resolve), which is what the live EventEmitter wrapper does.
 */
export async function v8ObserveTerminalFailure(error: unknown, log: V8ObservabilityHook): Promise<void> {
  await v8BestEffortLog(log, `[V8_EVALUATOR_FAULT_UNCONTAINED] ${describeV8ErrorSafely(error)}`);
}

export interface V8LiveFrameEvaluation {
  evaluation: V8BullishReclaimEvaluation;
  signal?: V8BullishReclaimSignal;
}

export interface V8LiveCandleEvent {
  instrumentKey?: unknown;
  completed?: unknown;
  candleTime?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
}

/** The live adapter is deliberately fed only completed, valid underlying bars. */
export function isV8CompletedUnderlyingCandleEvent(value: V8LiveCandleEvent, underlyingInstrument: string): boolean {
  return value.instrumentKey === underlyingInstrument
    && value.completed === true
    && value.candleTime instanceof Date
    && !Number.isNaN(value.candleTime.getTime())
    && [value.open, value.high, value.low, value.close].every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/** Runtime-only counters used by concise shadow-status observability. */
export class V8ShadowRuntimeCounters {
  private completed2m = 0;
  private signals = 0;
  private closed = 0;
  markCompleted2m(): void { this.completed2m += 1; }
  markSignal(): void { this.signals += 1; }
  markClosed(): void { this.closed += 1; }
  snapshot(): Readonly<{ completed2m: number; signals: number; closed: number }> {
    return Object.freeze({ completed2m: this.completed2m, signals: this.signals, closed: this.closed });
  }
}

/** Live adapter around the frozen research engine. It only evaluates completed frames. */
export default class V8BullishReclaimShadowEvaluatorService {
  private readonly byMinute = new Map<number, Candle>();
  private readonly emitted = new Set<number>();
  constructor(private readonly config: V8BullishReclaimConfig) {}
  seedHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  recoverHistoricalOneMinute(candles: readonly Candle[]): void { candles.forEach((candle) => this.add(candle)); }
  processCompletedOneMinute(candle: Candle): void { this.add(candle); }
  evaluateCompletedFrame(candle: Candle): V8BullishReclaimSignal | undefined {
    return this.evaluateCompletedFrameWithDiagnostics(candle).signal;
  }
  /**
   * Returns the frozen decision plus a read-only explanation for its completed
   * frame.  Duplicate completed-frame callbacks remain suppressed here rather
   * than leaking through to the shadow runtime.
   */
  evaluateCompletedFrameWithDiagnostics(candle: Candle): V8LiveFrameEvaluation {
    const sessions = this.prepare(v8IstDate(candle.timestamp));
    const indicators = this.indicators(sessions);
    const timestamp = candle.timestamp.getTime() + this.config.timeframe * 60_000;
    const evaluation = evaluateV8BullishReclaimFrames(sessions, this.config, indicators)
      .find((value) => value.timestamp.getTime() === timestamp);
    if (!evaluation) throw new Error(`V8 completed frame has no diagnostic evaluation at ${new Date(timestamp).toISOString()}.`);
    if (!evaluation.signalValue) return { evaluation };
    if (this.emitted.has(timestamp)) {
      return { evaluation: { ...evaluation, signal: false, signalValue: undefined, reason: 'DUPLICATE_COMPLETED_FRAME_SUPPRESSED' } };
    }
    this.emitted.add(timestamp);
    return { evaluation, signal: evaluation.signalValue };
  }
  private add(candle: Candle): void { this.byMinute.set(candle.timestamp.getTime(), { ...candle, timestamp: new Date(candle.timestamp.getTime()) }); }
  /**
   * Startup-time (pre-RUNNING) readiness check. Uses the same source-session
   * completeness rule as evaluation so there is exactly one definition of
   * "complete". `targetDate` may legitimately come from the live entrypoint's
   * wall-clock IST date; this method itself performs no wall-clock reads.
   */
  checkStartupReadiness(targetDate: string): V8StartupReadiness {
    const grouped = this.groupByIstDate();
    const priorDate = v8FindPriorSessionDate([...grouped.keys()], targetDate);
    if (priorDate === undefined) return { ready: false, reason: 'V8_NO_PRIOR_HISTORICAL_SESSION_AVAILABLE' };
    const priorCandles = grouped.get(priorDate) ?? [];
    if (!isV8CompleteClosedSession(priorCandles)) return { ready: false, reason: `V8_REQUIRED_PRIOR_SESSION_INCOMPLETE:${priorDate}` };
    const targetCandles = grouped.get(targetDate) ?? [];
    if (!isV8ContiguousFormingSessionPrefix(targetCandles, targetDate)) return { ready: false, reason: `V8_TARGET_SESSION_SOURCE_DISCONTINUOUS:${targetDate}` };
    return { ready: true, reason: 'V8_REQUIRED_HISTORY_READY' };
  }
  private groupByIstDate(): Map<string, Candle[]> {
    const grouped = new Map<string, Candle[]>();
    [...this.byMinute.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).forEach((candle) => { const key = v8IstDate(candle.timestamp); grouped.set(key, [...(grouped.get(key) ?? []), candle]); });
    return grouped;
  }
  /**
   * Bounds aggregation to exactly the target (forming) session plus its
   * immediately preceding PRESENT session (positional PDH semantics
   * unchanged). One complete prior 375-row session already supplies more
   * than the frozen V8 warm-up requirement in every timeframe (1m/2m/3m/5m
   * warm-up floors of 250/125/84/50 vs. 375/187/125/75 available), so no
   * further historical sessions are ever required. Irrelevant older
   * sessions -- complete or not -- are never touched. A present-but-incomplete
   * required prior session fails closed rather than being discarded or
   * substituted with an older session; a missing prior session fails closed
   * rather than fabricating a PDH. This method cannot detect a missing
   * exchange trading day that has no stored data at all (no NSE holiday
   * calendar exists in this repository); it only reasons about data
   * presence/completeness in the supplied history.
   */
  private prepare(targetDate: string): V8PreparedSession[] {
    const grouped = this.groupByIstDate();
    const targetCandles = grouped.get(targetDate) ?? [];
    const priorDate = v8FindPriorSessionDate([...grouped.keys()], targetDate);
    if (priorDate === undefined) throw new V8RequiredHistoricalSessionError('NO_PRIOR_SESSION_AVAILABLE');
    const priorCandles = grouped.get(priorDate) ?? [];
    if (!isV8CompleteClosedSession(priorCandles)) throw new V8RequiredHistoricalSessionError('REQUIRED_PRIOR_SESSION_INCOMPLETE', priorDate);
    // The target/forming session must not be structurally corrupted (a
    // leading/interior gap, a wholly absent 5m block, a duplicate, or a
    // non-minute-aligned row). It is proven directly against the raw
    // one-minute rows -- BEFORE any timeframe aggregator runs -- because the
    // 5m aggregator cannot see a wholly-missing bucket and the 2m/3m slicer
    // hides gaps by slicing on array position rather than timestamp.
    if (!isV8ContiguousFormingSessionPrefix(targetCandles, targetDate)) throw new V8TargetSessionIntegrityError(targetDate);
    return prepareCrossSessionIndicatorWarmup(
      [
        { date: priorDate, candles: priorCandles },
        { date: targetDate, candles: targetCandles, allowIncompleteTrailingFiveMinuteBucket: true },
      ],
      new CandleTimeframeAggregatorService(),
      new IndicatorEngineService(),
      new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 }),
    ) as V8PreparedSession[];
  }
  private indicators(sessions: readonly V8PreparedSession[]): V8IndicatorContext {
    const engine = new IndicatorEngineService();
    return { atr14ByFrame: new Map(([2, 3] as const).map((timeframe) => { const values = new Map<number, number>(); sessions.forEach((session) => engine.calculate(session.frames[timeframe].candles, { indicators: [{ type: IndicatorType.ATR, period: 14 }] }).indicators.find((item) => item.config.type === IndicatorType.ATR)?.result.values.forEach((item) => { if ('value' in item && typeof item.value === 'number') values.set(item.timestamp.getTime(), item.value); })); return [timeframe, values] as const; })) };
  }
}
