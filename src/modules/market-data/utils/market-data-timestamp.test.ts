import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS, normalizeMarketDataTimestamp } from './market-data-timestamp';

test('normalizes epoch milliseconds and ISO strings to canonical UTC ISO', () => {
  assert.equal(normalizeMarketDataTimestamp('1723618200000'), '2024-08-14T06:50:00.000Z');
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T09:15:00+05:30'), '2026-08-20T03:45:00.000Z');
});

test('rejects invalid, epoch-seconds, and epoch-microseconds without guessing', () => {
  assert.equal(normalizeMarketDataTimestamp('1723618200'), undefined);
  assert.equal(normalizeMarketDataTimestamp('1723618200000000'), undefined);
  assert.equal(normalizeMarketDataTimestamp('not-a-timestamp'), undefined);
  assert.equal(normalizeMarketDataTimestamp('2026-02-30T00:00:00.000Z'), undefined);
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T03:45:00'), undefined);
  assert.equal(normalizeMarketDataTimestamp(undefined), undefined);
});

// B1: a caller-supplied referenceMs is the fail-closed live-canonical-timestamp boundary.
// It is optional and must never be assumed from Date.now() -- omitting it (as generic
// historical/replay parsing does) must keep accepting any plausible timestamp regardless
// of today's wall clock.
test('B1: a future ISO source timestamp is rejected against an explicit referenceMs', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T09:16:00+05:30', referenceMs), undefined); // 1 minute after referenceMs
});

test('B1: a future epoch-millisecond source timestamp is rejected against an explicit referenceMs', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 60_000), referenceMs), undefined);
});

test('B1: a source timestamp exactly equal to referenceMs is valid, never rejected as future', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs), referenceMs), '2026-08-20T03:45:00.000Z');
  assert.equal(normalizeMarketDataTimestamp('2026-08-20T09:15:00+05:30', referenceMs), '2026-08-20T03:45:00.000Z');
});

test('B1: a legitimate past source timestamp remains valid against an explicit referenceMs', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp('1723618200000', referenceMs), '2024-08-14T06:50:00.000Z');
});

test('B1: omitting referenceMs preserves generic historical/replay parsing regardless of today\'s wall clock', () => {
  const farFutureButPlausibleEpoch = Date.UTC(2099, 0, 1);
  assert.equal(normalizeMarketDataTimestamp(String(farFutureButPlausibleEpoch)), new Date(farFutureButPlausibleEpoch).toISOString());
  assert.equal(normalizeMarketDataTimestamp('2099-01-01T00:00:00.000Z'), '2099-01-01T00:00:00.000Z');
});

// Forward-skew contract (A7-H1, 2026-08-24 evidence): a genuinely NTP-synchronized
// Windows host was directly measured to still disagree with independent external time
// by ~116-141ms (Microsoft NTP/Cloudflare/Google stripchart references), and a live V8
// run on that same synchronized host saw rejected Upstox currentTs forwardSkewMs values
// of 85-92ms -- inside that measured range, not evidence of a genuinely future provider
// timestamp. 150ms is the smallest simple bound strictly above the observed maximum
// (~141ms): a bounded host-clock-uncertainty allowance, never an Upstox SLA. A multi-
// second skew (the earlier ~3.3s unhealthy-clock episode) must remain rejected.
test('the default provider-forward-skew tolerance is exactly 150ms -- an evidence-based host-clock-uncertainty allowance, not a provider SLA', () => {
  assert.equal(DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS, 150);
});

test('an explicit non-default providerForwardSkewToleranceMs is honored only when a caller opts in -- the canonical-ingest boundary is configurable, not hard-coded', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  // 300ms into the future is rejected by the default 150ms tolerance...
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 300), referenceMs), undefined);
  // ...but accepted once a caller explicitly configures a wider tolerance.
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 300), referenceMs, 500), new Date(referenceMs + 300).toISOString());
  // Still rejected once genuinely beyond even a configured tolerance.
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 501), referenceMs, 500), undefined);
});

// A7-H1: exact boundary semantics of the new 150ms default -- <=150ms passes, >150ms
// (including a multi-second skew matching the earlier ~3.3s unhealthy-clock episode)
// is still rejected, using the DEFAULT tolerance exactly as production does (no
// explicit third argument).
test('A7-H1: a source timestamp exactly equal to the reference (0ms skew) is accepted under the default tolerance', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs), referenceMs), new Date(referenceMs).toISOString());
});

test('A7-H1: a small positive skew matching the observed live evidence (90ms) is accepted under the default tolerance', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 90), referenceMs), new Date(referenceMs + 90).toISOString());
});

test('A7-H1: a skew of exactly 150ms (the configured bound) is accepted, not rejected', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 150), referenceMs), new Date(referenceMs + 150).toISOString());
});

test('A7-H1: a skew of 151ms -- one millisecond past the configured bound -- is rejected', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 151), referenceMs), undefined);
});

test('A7-H1: a multi-second future timestamp, matching the earlier ~3.3s unhealthy-host-clock episode, remains rejected under the new 150ms bound', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 3_300), referenceMs), undefined);
});

test('A7-H1: an invalid/unparsable timestamp is still rejected regardless of the forward-skew bound', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp('not-a-timestamp', referenceMs), undefined);
});

test('A7-H1: an ordinary past timestamp, well behind the reference, remains accepted under the new default', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs - 60_000), referenceMs), new Date(referenceMs - 60_000).toISOString());
});

// A malformed explicit tolerance must fail closed -- rejected exactly like any other
// malformed input this function already rejects -- never coerced to 0, never treated
// as "no limit".
test('a NaN providerForwardSkewToleranceMs fails closed and rejects even an on-time timestamp', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs), referenceMs, NaN), undefined);
});

test('an Infinity providerForwardSkewToleranceMs fails closed rather than accepting any future timestamp', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 60_000), referenceMs, Infinity), undefined);
});

test('a -Infinity providerForwardSkewToleranceMs fails closed', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs), referenceMs, -Infinity), undefined);
});

test('a negative providerForwardSkewToleranceMs fails closed rather than tightening the boundary into the past', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs), referenceMs, -1), undefined);
});

test('a malformed tolerance rejects even when referenceMs is omitted, since the tolerance itself is invalid input', () => {
  assert.equal(normalizeMarketDataTimestamp('1723618200000', undefined, NaN), undefined);
});
