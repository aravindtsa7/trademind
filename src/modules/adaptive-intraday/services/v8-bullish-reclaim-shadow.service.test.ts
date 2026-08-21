import assert from 'node:assert/strict';
import test from 'node:test';
import { Candle } from '../../indicators/types';
import { createV8BullishReclaimConfigs } from '../../research/v8-nifty-bullish-reclaim';
import V8BullishReclaimShadowEvaluatorService, {
  isV8CompleteClosedSession,
  isV8ContiguousFormingSessionPrefix,
  V8RequiredHistoricalSessionError,
  V8TargetSessionIntegrityError,
} from './v8-bullish-reclaim-shadow.service';

const MINUTE = 60_000;
const V8_FROZEN_FINGERPRINT = 'c815f819acd71e98';

function sessionStart(date: string): number {
  return new Date(`${date}T09:15:00+05:30`).getTime();
}

function flatMinutes(date: string, count: number, ohlc: { open: number; high: number; low: number; close: number }): Candle[] {
  const start = sessionStart(date);
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(start + index * MINUTE),
    open: ohlc.open,
    high: ohlc.high,
    low: ohlc.low,
    close: ohlc.close,
    volume: 1,
  }));
}

/** A complete closed session: flat OHLC so the day-high is trivially deterministic. */
function completeClosedSession(date: string, dayHigh: number): Candle[] {
  return flatMinutes(date, 375, { open: dayHigh - 50, high: dayHigh, low: dayHigh - 100, close: dayHigh - 50 });
}

/** Quiet baseline minutes followed by one reclaim pair, forming a non-5m-aligned 42-row forming session. */
function formingSessionWithReclaim(date: string): Candle[] {
  const quiet = flatMinutes(date, 40, { open: 24_000, high: 24_010, low: 23_990, close: 24_000 });
  const start = sessionStart(date);
  const reclaimMinuteOne: Candle = { timestamp: new Date(start + 40 * MINUTE), open: 24_095, high: 24_098, low: 24_090, close: 24_098, volume: 1 };
  const reclaimMinuteTwo: Candle = { timestamp: new Date(start + 41 * MINUTE), open: 24_098, high: 24_132, low: 24_095, close: 24_130, volume: 1 };
  return [...quiet, reclaimMinuteOne, reclaimMinuteTwo];
}

function v8TestConfig() {
  const config = createV8BullishReclaimConfigs().find((value) =>
    value.timeframe === 2
    && value.levelFamily === 'PDH'
    && value.reclaimBufferAtr === 0
    && value.bullishBodyAtr === 0.25
    && value.rsiMinimum === 'NONE'
    && value.regimeMode === 'NO_REGIME_FILTER'
    && value.cooldownMinutes === 5);
  assert.ok(config, 'expected the PDH/NO_REGIME_FILTER/NONE test config to exist in the frozen grid');
  return config;
}

function seed(evaluator: V8BullishReclaimShadowEvaluatorService, candles: readonly Candle[]): void {
  candles.forEach((candle) => evaluator.processCompletedOneMinute(candle));
}

/** Builds raw one-minute rows at arbitrary millisecond offsets from a date's 09:15 IST session start -- for constructing gap/duplicate/misaligned shapes directly. */
function candlesAtOffsets(date: string, offsetsMs: readonly number[]): Candle[] {
  const start = sessionStart(date);
  return offsetsMs.map((offset) => ({
    timestamp: new Date(start + offset),
    open: 24_000, high: 24_010, low: 23_990, close: 24_000, volume: 1,
  }));
}
function minutes(...values: readonly number[]): number[] {
  return values.map((value) => value * MINUTE);
}

// -------------------------------------------------------------------------
// isV8CompleteClosedSession: the V8-local closed-session completeness gate
// -------------------------------------------------------------------------

test('isV8CompleteClosedSession accepts exactly 375 contiguous 09:15-15:29 IST rows', () => {
  assert.equal(isV8CompleteClosedSession(completeClosedSession('2026-08-13', 24_100)), true);
});

test('isV8CompleteClosedSession rejects a 274-row (Aug-18-like) truncated session', () => {
  const truncated = flatMinutes('2026-08-18', 274, { open: 24_050, high: 24_100, low: 24_000, close: 24_050 });
  assert.equal(isV8CompleteClosedSession(truncated), false);
});

test('isV8CompleteClosedSession rejects a 375-row session shifted off the 09:15-15:29 boundary', () => {
  const shifted = flatMinutes('2026-08-13', 375, { open: 24_050, high: 24_100, low: 24_000, close: 24_050 })
    .map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp.getTime() + MINUTE) }));
  assert.equal(isV8CompleteClosedSession(shifted), false);
});

test('isV8CompleteClosedSession rejects a 375-row session with an internal duplicate/gap', () => {
  const rows = completeClosedSession('2026-08-13', 24_100);
  rows[188] = { ...rows[188], timestamp: new Date(rows[187].timestamp.getTime()) };
  assert.equal(isV8CompleteClosedSession(rows), false);
});

test('isV8CompleteClosedSession (HIGH finding) rejects 375 non-minute-aligned rows: 09:15:30 -> 15:29:30', () => {
  const shiftedBySeconds = completeClosedSession('2026-08-13', 24_100)
    .map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp.getTime() + 30_000) }));
  assert.equal(isV8CompleteClosedSession(shiftedBySeconds), false);
});

test('isV8CompleteClosedSession accepts a complete session even when the input array is not pre-sorted', () => {
  const rows = completeClosedSession('2026-08-13', 24_100);
  const shuffled = [...rows].reverse();
  assert.equal(isV8CompleteClosedSession(shuffled), true);
  // interleaved order (not just reversed) exercises the same internal sort path
  const interleaved = rows.filter((_, index) => index % 2 === 0).concat(rows.filter((_, index) => index % 2 === 1));
  assert.equal(isV8CompleteClosedSession(interleaved), true);
});

test('isV8CompleteClosedSession: a wrong/crossing IST session date is not independently constructible for this fixed 375-row/09:15-15:29 window', () => {
  // 09:15 IST plus 374 strict +60,000ms steps spans only 6h14m, which can
  // never cross an IST calendar-day boundary (IST has no DST and a constant
  // +05:30 offset). Given the required first=09:15, last=15:29, and strict
  // 60s-adjacency invariants, a same-IST-date violation is mathematically
  // implied to be unreachable without also violating adjacency/boundaries
  // (already covered by the duplicate/gap and boundary-shift tests above).
  // This is a positive control proving the added same-date guard does not
  // spuriously reject an ordinary, entirely-valid single-date session.
  assert.equal(isV8CompleteClosedSession(completeClosedSession('2026-08-13', 24_100)), true);
});

// -------------------------------------------------------------------------
// checkStartupReadiness: pre-RUNNING fail-closed gate
// -------------------------------------------------------------------------

test('checkStartupReadiness reports not-ready when no prior session is available at all', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  assert.deepEqual(evaluator.checkStartupReadiness('2026-08-14'), { ready: false, reason: 'V8_NO_PRIOR_HISTORICAL_SESSION_AVAILABLE' });
});

test('checkStartupReadiness reports the exact incomplete-date reason for a required-but-incomplete prior session (2026-08-18-like defect)', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, flatMinutes('2026-08-18', 274, { open: 24_050, high: 24_100, low: 24_000, close: 24_050 }));
  seed(evaluator, formingSessionWithReclaim('2026-08-21'));
  assert.deepEqual(evaluator.checkStartupReadiness('2026-08-21'), { ready: false, reason: 'V8_REQUIRED_PRIOR_SESSION_INCOMPLETE:2026-08-18' });
});

test('checkStartupReadiness reports ready once the immediately preceding present session is complete', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  assert.deepEqual(evaluator.checkStartupReadiness('2026-08-14'), { ready: true, reason: 'V8_REQUIRED_HISTORY_READY' });
});

// -------------------------------------------------------------------------
// isV8ContiguousFormingSessionPrefix: BLOCKER 1 -- target/forming session
// raw-source continuity, proven BEFORE any timeframe aggregation runs.
// -------------------------------------------------------------------------

test('A: a valid contiguous partial target (09:15 -> some intraday minute continuously) is accepted', () => {
  // 148 continuous minutes: 09:15 -> 11:42, well short of a full 375-row closed session.
  const continuous = candlesAtOffsets('2026-08-14', Array.from({ length: 148 }, (_, index) => index * MINUTE));
  assert.equal(continuous.length, 148);
  assert.equal(isV8ContiguousFormingSessionPrefix(continuous, '2026-08-14'), true);
});

test('A: an empty target (session has not started yet) is trivially valid', () => {
  assert.equal(isV8ContiguousFormingSessionPrefix([], '2026-08-14'), true);
});

test('B: a target that starts late (09:20 -> ...) is rejected -- no leading gap tolerated', () => {
  const startsLate = candlesAtOffsets('2026-08-14', minutes(5, 6, 7, 8, 9, 10));
  assert.equal(isV8ContiguousFormingSessionPrefix(startsLate, '2026-08-14'), false);
});

test('C: an entire missing 5-minute block (09:15 -> 09:24, then 09:30 -> ...) is rejected before aggregation', () => {
  const missingBlock = candlesAtOffsets('2026-08-14', [...minutes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), ...minutes(15, 16, 17)]);
  assert.equal(isV8ContiguousFormingSessionPrefix(missingBlock, '2026-08-14'), false);
});

test('D: a one-minute interior gap (...10:00, 10:02...) is rejected', () => {
  const interiorGap = candlesAtOffsets('2026-08-14', [...Array.from({ length: 46 }, (_, index) => index * MINUTE), 47 * MINUTE]); // 09:15..10:00 then 10:02 (10:01 missing)
  assert.equal(isV8ContiguousFormingSessionPrefix(interiorGap, '2026-08-14'), false);
});

test('E: a duplicate target minute is rejected', () => {
  const duplicate = candlesAtOffsets('2026-08-14', [...minutes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11)]);
  assert.equal(isV8ContiguousFormingSessionPrefix(duplicate, '2026-08-14'), false);
});

test('F: a non-minute-aligned target (09:15:30, 09:16:30, ...) is rejected', () => {
  const misaligned = candlesAtOffsets('2026-08-14', minutes(0, 1, 2, 3, 4, 5).map((value) => value + 30_000));
  assert.equal(isV8ContiguousFormingSessionPrefix(misaligned, '2026-08-14'), false);
});

test('G: a valid target with a naturally incomplete final 5m bucket passes source-prefix validation', () => {
  // 42 minutes (09:15 -> 09:56) continuously: valid prefix, non-5m-aligned length.
  assert.equal(isV8ContiguousFormingSessionPrefix(formingSessionWithReclaim('2026-08-14'), '2026-08-14'), true);
});

test('a target belonging to the wrong IST date is rejected', () => {
  const wrongDate = candlesAtOffsets('2026-08-14', minutes(0, 1, 2));
  assert.equal(isV8ContiguousFormingSessionPrefix(wrongDate, '2026-08-15'), false);
});

// -- Behavioral (full-evaluator) proofs for BLOCKER 1, not source-text-only --

test('B/behavioral: a target session starting at 09:20 fails closed via the full evaluator (checkStartupReadiness and evaluation)', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, candlesAtOffsets('2026-08-14', minutes(5, 6, 7, 8, 9, 10)));
  assert.deepEqual(evaluator.checkStartupReadiness('2026-08-14'), { ready: false, reason: 'V8_TARGET_SESSION_SOURCE_DISCONTINUOUS:2026-08-14' });
  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: new Date(sessionStart('2026-08-14') + 8 * MINUTE), open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8TargetSessionIntegrityError && error.sessionDate === '2026-08-14',
  );
});

test('C/behavioral: a target session with a wholly missing 5-minute block fails closed via the full evaluator, not merely via the 5m aggregator', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, candlesAtOffsets('2026-08-14', [...minutes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), ...minutes(15, 16, 17)]));
  assert.deepEqual(evaluator.checkStartupReadiness('2026-08-14'), { ready: false, reason: 'V8_TARGET_SESSION_SOURCE_DISCONTINUOUS:2026-08-14' });
  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: new Date(sessionStart('2026-08-14') + 16 * MINUTE), open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8TargetSessionIntegrityError && error.sessionDate === '2026-08-14',
  );
});

test('D/behavioral: a target session with a one-minute interior gap fails closed via the full evaluator', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, candlesAtOffsets('2026-08-14', [...Array.from({ length: 46 }, (_, index) => index * MINUTE), 47 * MINUTE]));
  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: new Date(sessionStart('2026-08-14') + 47 * MINUTE), open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8TargetSessionIntegrityError && error.sessionDate === '2026-08-14',
  );
});

test('F/behavioral: a non-minute-aligned target session fails closed via the full evaluator', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, candlesAtOffsets('2026-08-14', minutes(0, 1, 2, 3, 4, 5).map((value) => value + 30_000)));
  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: new Date(sessionStart('2026-08-14') + 5 * MINUTE + 30_000), open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8TargetSessionIntegrityError && error.sessionDate === '2026-08-14',
  );
});

// -------------------------------------------------------------------------
// evaluateCompletedFrameWithDiagnostics: bounded, fail-closed evaluation
// -------------------------------------------------------------------------

test('A: a complete 375-row prior session is accepted and evaluation does not throw', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);
  assert.doesNotThrow(() => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 }));
});

test('B/G: the frozen PDH-reclaim signal fires from the complete prior day\'s high, with no semantic drift versus the frozen engine\'s own decision fields', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);
  const result = evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 });

  assert.equal(result.evaluation.reason, 'SIGNAL');
  assert.ok(result.signal);
  assert.equal(result.signal?.direction, 'CE');
  assert.equal(result.signal?.structuralLevel, 24_100); // sourced from the complete prior day's high, not fabricated
  assert.equal(result.signal?.timestamp.getTime(), reclaimBucketTimestamp.getTime() + 2 * MINUTE);
  assert.equal(result.evaluation.reclaim, true);
  assert.equal(result.evaluation.regimePass, true);
  assert.equal(result.evaluation.rsiPass, true);
});

test('C: an irrelevant old truncated session (Aug-12-like) outside the required history cannot crash evaluation or influence PDH', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  // Older, truncated, and carries a deliberately wrong "PDH" marker (19,000) that must never be used.
  seed(evaluator, flatMinutes('2026-08-12', 200, { open: 18_950, high: 19_000, low: 18_900, close: 18_950 }));
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);

  let result: ReturnType<V8BullishReclaimShadowEvaluatorService['evaluateCompletedFrameWithDiagnostics']> | undefined;
  assert.doesNotThrow(() => { result = evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 }); });
  assert.equal(result?.signal?.structuralLevel, 24_100);
  assert.notEqual(result?.signal?.structuralLevel, 19_000);
});

test('D: a required-but-incomplete immediate prior session (2026-08-18-like) fails closed and is never substituted with an older complete session', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  // An older COMPLETE session exists further back; it must never be silently substituted.
  seed(evaluator, completeClosedSession('2026-08-11', 19_000));
  seed(evaluator, flatMinutes('2026-08-13', 274, { open: 24_050, high: 24_100, low: 24_000, close: 24_050 }));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);

  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8RequiredHistoricalSessionError
      && error.code === 'REQUIRED_PRIOR_SESSION_INCOMPLETE'
      && error.sessionDate === '2026-08-13',
  );
});

test('D: no prior session present at all fails closed rather than fabricating a PDH', () => {
  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);

  assert.throws(
    () => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 }),
    (error: unknown) => error instanceof V8RequiredHistoricalSessionError && error.code === 'NO_PRIOR_SESSION_AVAILABLE',
  );
});

test('E: a 42-row current/forming target session is never classified as an invalid closed historical session', () => {
  // The exact same 42-row shape that succeeds as a TARGET must fail the 375-row gate if it were required as a PRIOR session.
  const asPrior = flatMinutes('2026-08-13', 42, { open: 24_000, high: 24_010, low: 23_990, close: 24_000 });
  assert.equal(isV8CompleteClosedSession(asPrior), false);

  const evaluator = new V8BullishReclaimShadowEvaluatorService(v8TestConfig());
  seed(evaluator, completeClosedSession('2026-08-13', 24_100));
  seed(evaluator, formingSessionWithReclaim('2026-08-14'));
  assert.equal(evaluator.checkStartupReadiness('2026-08-14').ready, true); // target's own incompleteness never blocks startup
  const reclaimBucketTimestamp = new Date(sessionStart('2026-08-14') + 40 * MINUTE);
  assert.doesNotThrow(() => evaluator.evaluateCompletedFrameWithDiagnostics({ timestamp: reclaimBucketTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 }));
});

// -------------------------------------------------------------------------
// H: frozen strategy fingerprints (V8 unaffected by this fix)
// -------------------------------------------------------------------------

test('H: V8 strategy fingerprint is unaffected by the historical-session safety fix', async () => {
  const { v8FrozenStrategyFingerprint } = await import('../../research/v8-nifty-bullish-reclaim');
  const trainConfig = { timeframe: 2 as const, levelFamily: 'PDH' as const, reclaimBufferAtr: .1 as const, bullishBodyAtr: .25 as const, rsiMinimum: 50 as const, regimeMode: 'NO_REGIME_FILTER' as const, cooldownMinutes: 5 as const };
  const base = { id: 'z', config: trainConfig, policy: { target: 6, stop: 5, hold: 15 }, settledTrades: 32, netAt040: 1, grossMedian: 2, targetRate: 60, stopRate: 30, maxDrawdown: 10, maxLosingStreak: 2 };
  assert.equal(v8FrozenStrategyFingerprint(base), V8_FROZEN_FINGERPRINT);
});
