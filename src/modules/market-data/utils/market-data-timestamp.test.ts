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

// Forward-skew contract: no vendor-contract/measured provider-forward-skew allowance is
// established anywhere in this repository (investigated: MarketDataRecoveryCoordinatorService
// deliberately avoids cross-clock-domain comparison rather than defining one). The default
// canonical-ingest tolerance is therefore exactly 0 -- strict fail-closed -- until that
// provider-contract validation happens elsewhere.
test('the default provider-forward-skew tolerance is exactly zero pending provider-contract validation', () => {
  assert.equal(DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS, 0);
});

test('an explicit non-zero providerForwardSkewToleranceMs is honored only when a caller opts in -- the canonical-ingest boundary is configurable, not hard-coded to zero', () => {
  const referenceMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  // 300ms into the future is rejected by default (tolerance 0)...
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 300), referenceMs), undefined);
  // ...but accepted once a caller explicitly configures a wider tolerance.
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 300), referenceMs, 500), new Date(referenceMs + 300).toISOString());
  // Still rejected once genuinely beyond even a configured tolerance.
  assert.equal(normalizeMarketDataTimestamp(String(referenceMs + 501), referenceMs, 500), undefined);
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
