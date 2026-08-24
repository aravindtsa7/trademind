import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceBoundaryEvaluationCoverageTracker } from './source-boundary-evaluation-coverage';

const boundary = new Date('2026-08-24T15:30:00+05:30');
const candleTime = new Date('2026-08-24T15:25:00+05:30');

test('NOT_REQUIRED until require() is called', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  assert.equal(tracker.disposition(1), 'NOT_REQUIRED');
  assert.equal(tracker.isSatisfiedFor(1), true);
  assert.equal(tracker.getRecord(), undefined);
});

test('require() establishes REQUIRED_PENDING for the given generation and blocks completion', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  assert.equal(tracker.disposition(1), 'REQUIRED_PENDING');
  assert.equal(tracker.isSatisfiedFor(1), false);
  assert.equal(tracker.getRecord()?.generationId, 1);
  assert.equal(tracker.getRecord()?.requiredBoundary.toISOString(), boundary.toISOString());
});

test('markEvaluated() satisfies the requirement and is sticky against a later markLost()', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  const satisfied = tracker.markEvaluated(1, candleTime, 'SOURCE_RECOVERED_CANDLE_EVALUATED');
  assert.equal(satisfied, true);
  assert.equal(tracker.disposition(1), 'EVALUATED');
  assert.equal(tracker.isSatisfiedFor(1), true);
  assert.equal(tracker.getRecord()?.completedCandleTime?.toISOString(), candleTime.toISOString());

  // A later disconnect/fault trying to mark the SAME generation LOST must never downgrade a genuine success.
  tracker.markLost(1, 'DISCONNECT_AFTER_SUCCESS');
  assert.equal(tracker.disposition(1), 'EVALUATED');
  assert.equal(tracker.isSatisfiedFor(1), true);
});

test('markLost() records failure and keeps coverage unsatisfied', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  tracker.markLost(1, 'RECOVERY_FAILED');
  assert.equal(tracker.disposition(1), 'LOST');
  assert.equal(tracker.isSatisfiedFor(1), false);
  assert.equal(tracker.getRecord()?.reason, 'RECOVERY_FAILED');
});

test('a stale generationId can neither satisfy nor fail a newer generation\'s own requirement', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  // Generation 1 disconnects before resolving; generation 2 reconnects and re-establishes its own requirement.
  tracker.require(2, boundary);
  assert.equal(tracker.disposition(2), 'REQUIRED_PENDING');

  // A late-arriving generation-1 callback must not satisfy generation 2's requirement.
  const staleSatisfied = tracker.markEvaluated(1, candleTime, 'STALE_GENERATION_1_CALLBACK');
  assert.equal(staleSatisfied, false);
  assert.equal(tracker.disposition(2), 'REQUIRED_PENDING');

  // Nor may a stale generation-1 failure report reach into generation 2's own record.
  tracker.markLost(1, 'STALE_GENERATION_1_FAILURE');
  assert.equal(tracker.disposition(2), 'REQUIRED_PENDING');

  // Generation 1's own (now superseded) view is untouched by generation 2's existence.
  assert.equal(tracker.disposition(1), 'NOT_REQUIRED');
});

test('reconnect/new generation cannot inherit EVALUATED from an old generation', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  tracker.markEvaluated(1, candleTime, 'SOURCE_RECOVERED_CANDLE_EVALUATED');
  assert.equal(tracker.isSatisfiedFor(1), true);

  // A brand-new generation re-establishing its own requirement starts fresh, not EVALUATED.
  tracker.require(2, boundary);
  assert.equal(tracker.disposition(2), 'REQUIRED_PENDING');
  assert.equal(tracker.isSatisfiedFor(2), false);
});

test('markEvaluated() is idempotent for repeated calls within the same generation', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  tracker.require(1, boundary);
  assert.equal(tracker.markEvaluated(1, candleTime, 'FIRST'), true);
  assert.equal(tracker.markEvaluated(1, candleTime, 'SECOND'), true);
  // The first successful evaluation's reason/candle time is retained, not silently replaced.
  assert.equal(tracker.getRecord()?.reason, 'FIRST');
});

test('markEvaluated()/markLost() without any require() are safe no-ops', () => {
  const tracker = new SourceBoundaryEvaluationCoverageTracker('paper:v2', 'V2_TREND_DOWN_PE');
  assert.equal(tracker.markEvaluated(1, candleTime, 'NEVER_REQUIRED'), false);
  tracker.markLost(1, 'NEVER_REQUIRED');
  assert.equal(tracker.disposition(1), 'NOT_REQUIRED');
});
