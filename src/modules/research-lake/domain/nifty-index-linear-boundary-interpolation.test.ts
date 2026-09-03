import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  computeLinearBoundaryInterpolation,
  LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES,
  LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION,
  NiftyIndexAnchorPrecisionError,
} from './nifty-index-linear-boundary-interpolation';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

test('LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION / decimal places are stable, versioned constants', () => {
  assert.equal(LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION, 1);
  assert.equal(LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES, 2);
});

// ---- D: upward movement exact ----

test('upward movement: A=100.00, B=100.03 -- exact 1/3 boundary split', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.03' });
  const [c1, c2, c3] = result.candles;

  assert.equal(c1.open.toFixed(), d('100.00').toFixed());
  assert.equal(c1.close.toFixed(), d('100.01').toFixed()); // 100 + 1/3*0.03 = 100.01 (rounded)
  assert.equal(c2.open.toFixed(), d('100.01').toFixed());
  assert.equal(c2.close.toFixed(), d('100.02').toFixed()); // 100 + 2/3*0.03 = 100.02 (rounded)
  assert.equal(c3.open.toFixed(), d('100.02').toFixed());
  assert.equal(c3.close.toFixed(), d('100.03').toFixed());
});

// ---- D: downward movement exact ----

test('downward movement: A=100.03, B=100.00 -- exact 1/3 boundary split, decreasing', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.03', rightAnchorOpen: '100.00' });
  const [c1, c2, c3] = result.candles;

  assert.equal(c1.open.toFixed(), d('100.03').toFixed());
  assert.equal(c1.close.toFixed(), d('100.02').toFixed());
  assert.equal(c2.open.toFixed(), d('100.02').toFixed());
  assert.equal(c2.close.toFixed(), d('100.01').toFixed());
  assert.equal(c3.open.toFixed(), d('100.01').toFixed());
  assert.equal(c3.close.toFixed(), d('100.00').toFixed());
});

// ---- D: zero-delta exact ----

test('zero delta: A === B -- every synthetic candle is flat at that exact price', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '17250.55', rightAnchorOpen: '17250.55' });
  for (const candle of result.candles) {
    assert.equal(candle.open.toFixed(), d('17250.55').toFixed());
    assert.equal(candle.close.toFixed(), d('17250.55').toFixed());
    assert.equal(candle.high.toFixed(), d('17250.55').toFixed());
    assert.equal(candle.low.toFixed(), d('17250.55').toFixed());
  }
});

// ---- D: continuity across synthetic candle boundaries ----

test('continuity: candle1.close === candle2.open and candle2.close === candle3.open, by construction (same Decimal value)', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '16974.85', rightAnchorOpen: '16980.10' });
  const [c1, c2, c3] = result.candles;
  assert.ok(c1.close.equals(c2.open));
  assert.ok(c2.close.equals(c3.open));
});

test('continuity: candle1.open equals the left anchor, candle3.close equals the right anchor', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '16974.85', rightAnchorOpen: '16980.10' });
  const [c1, , c3] = result.candles;
  assert.equal(c1.open.toFixed(), d('16974.85').toFixed());
  assert.equal(c3.close.toFixed(), d('16980.10').toFixed());
});

// ---- D: high/low correct ----

test('high/low: for an upward candle, high=close and low=open', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.03' });
  for (const candle of result.candles) {
    assert.ok(candle.close.greaterThanOrEqualTo(candle.open));
    assert.equal(candle.high.toFixed(), candle.close.toFixed());
    assert.equal(candle.low.toFixed(), candle.open.toFixed());
  }
});

test('high/low: for a downward candle, high=open and low=close', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.03', rightAnchorOpen: '100.00' });
  for (const candle of result.candles) {
    assert.ok(candle.open.greaterThanOrEqualTo(candle.close));
    assert.equal(candle.high.toFixed(), candle.open.toFixed());
    assert.equal(candle.low.toFixed(), candle.close.toFixed());
  }
});

test('high/low: high is always >= max(open,close) and low is always <= min(open,close)', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '16974.85', rightAnchorOpen: '16980.10' });
  for (const candle of result.candles) {
    assert.ok(candle.high.greaterThanOrEqualTo(candle.open) && candle.high.greaterThanOrEqualTo(candle.close));
    assert.ok(candle.low.lessThanOrEqualTo(candle.open) && candle.low.lessThanOrEqualTo(candle.close));
  }
});

// ---- D: deterministic decimal normalization/rounding ----

test('deterministic rounding: a delta that does not divide evenly by 3 always rounds the SAME way regardless of call count', () => {
  const first = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.01' });
  const second = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.01' });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(first.candles[index].open.toFixed(), second.candles[index].open.toFixed());
    assert.equal(first.candles[index].close.toFixed(), second.candles[index].close.toFixed());
  }
  // 0.01 / 3 = 0.00333... -> rounds to 100.00 (ROUND_HALF_UP at 2dp); 2/3 -> 0.00666... -> rounds to 100.01.
  assert.equal(first.candles[0].close.toFixed(), d('100.00').toFixed());
  assert.equal(first.candles[1].close.toFixed(), d('100.01').toFixed());
});

test('deterministic rounding: results never carry more than 2 decimal places', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '16974.85', rightAnchorOpen: '16980.11' });
  for (const candle of result.candles) {
    for (const value of [candle.open, candle.high, candle.low, candle.close]) {
      assert.equal(value.decimalPlaces() <= 2, true, `expected <= 2 decimal places, got ${value.toFixed()}`);
    }
  }
});

test('inputs given as number/string/Decimal all normalize identically before interpolation', () => {
  const fromNumber = computeLinearBoundaryInterpolation({ leftAnchorClose: 100, rightAnchorOpen: 100.03 });
  const fromString = computeLinearBoundaryInterpolation({ leftAnchorClose: '100', rightAnchorOpen: '100.03' });
  const fromDecimal = computeLinearBoundaryInterpolation({ leftAnchorClose: d('100'), rightAnchorOpen: d('100.03') });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(fromNumber.candles[index].close.toFixed(), fromString.candles[index].close.toFixed());
    assert.equal(fromString.candles[index].close.toFixed(), fromDecimal.candles[index].close.toFixed());
  }
});

// ---- B-M7.1-BLOCKER-02: fail closed on unsupported real-anchor precision ----

function assertPrecisionError(fn: () => unknown, expectedCode: 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION' | 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION'): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof NiftyIndexAnchorPrecisionError, `expected NiftyIndexAnchorPrecisionError, got ${String(error)}`);
    assert.equal((error as NiftyIndexAnchorPrecisionError).code, expectedCode);
    return true;
  });
}

// A. left anchor with >2dp fails closed

test('A. left anchor with 3 decimal places fails closed (never silently rounds a real anchor)', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.123', rightAnchorOpen: '23950.20' }), 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION');
});

test('A2. left anchor 23950.129 (would round UP under HALF_UP) still fails closed -- never silently produces 23950.13', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.129', rightAnchorOpen: '23950.20' }), 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION');
});

// B. right anchor with >2dp fails closed

test('B. right anchor with 3 decimal places fails closed', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.00', rightAnchorOpen: '23950.123' }), 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION');
});

test('B2. right anchor 23950.129 still fails closed', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.00', rightAnchorOpen: '23950.129' }), 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION');
});

// C. both >2dp fail deterministically

test('C. both anchors unsupported precision -- fails deterministically (always the LEFT anchor code, checked first, on repeated calls)', () => {
  const attempt = () => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.123', rightAnchorOpen: '23960.456' });
  assertPrecisionError(attempt, 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION');
  assertPrecisionError(attempt, 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION');
});

// D. 0dp / 1dp / 2dp anchors remain accepted

test('D. 0dp (23950), 1dp (23950.1), and 2dp (23950.12) real anchors are all accepted', () => {
  assert.doesNotThrow(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950', rightAnchorOpen: '23951' }));
  assert.doesNotThrow(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.1', rightAnchorOpen: '23951.2' }));
  assert.doesNotThrow(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.12', rightAnchorOpen: '23951.34' }));
});

test('D2. 23950.10 (trailing zero, semantically 1dp) is accepted -- value equality, never string/format comparison', () => {
  assert.doesNotThrow(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.10', rightAnchorOpen: '23951.00' }));
});

// E. accepted left anchor is preserved exactly as candle1.open

test('E. an accepted 1dp left anchor is preserved exactly, byte-for-byte, as candle1.open', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '23950.1', rightAnchorOpen: '23951.2' });
  assert.equal(result.candles[0].open.toFixed(), d('23950.1').toFixed());
  assert.ok(result.candles[0].open.equals(d('23950.1')));
});

// F. accepted right anchor is preserved exactly as candle3.close

test('F. an accepted 0dp right anchor is preserved exactly, byte-for-byte, as candle3.close', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '23950', rightAnchorOpen: '23951' });
  assert.equal(result.candles[2].close.toFixed(), d('23951').toFixed());
  assert.ok(result.candles[2].close.equals(d('23951')));
});

// G/H/I. upward/downward/flat interpolation remains correct (re-asserted post-correction)

test('G. upward interpolation remains correct after the precision guard', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.03' });
  assert.equal(result.candles[0].close.toFixed(), d('100.01').toFixed());
  assert.equal(result.candles[1].close.toFixed(), d('100.02').toFixed());
  assert.equal(result.candles[2].close.toFixed(), d('100.03').toFixed());
});

test('H. downward interpolation remains correct after the precision guard', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.03', rightAnchorOpen: '100.00' });
  assert.equal(result.candles[0].close.toFixed(), d('100.02').toFixed());
  assert.equal(result.candles[1].close.toFixed(), d('100.01').toFixed());
  assert.equal(result.candles[2].close.toFixed(), d('100.00').toFixed());
});

test('I. flat (zero-delta) interpolation remains correct after the precision guard', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '17250.55', rightAnchorOpen: '17250.55' });
  for (const candle of result.candles) {
    assert.equal(candle.open.toFixed(), d('17250.55').toFixed());
    assert.equal(candle.close.toFixed(), d('17250.55').toFixed());
  }
});

// J. repeating thirds still use the frozen 2dp HALF_UP rule

test('J. a repeating-third delta (0.01) still resolves via the frozen 2dp HALF_UP rule on the INTERIOR boundaries only', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: '100.01' });
  assert.equal(result.candles[0].close.toFixed(), d('100.00').toFixed()); // 0.00333.. -> 100.00
  assert.equal(result.candles[1].close.toFixed(), d('100.01').toFixed()); // 0.00666.. -> 100.01
});

// K. continuity remains exact after rounding

test('K. continuity remains exact: candle1.close=candle2.open and candle2.close=candle3.open, with real (already-2dp) anchors', () => {
  const result = computeLinearBoundaryInterpolation({ leftAnchorClose: '16974.85', rightAnchorOpen: '16980.10' });
  assert.ok(result.candles[0].close.equals(result.candles[1].open));
  assert.ok(result.candles[1].close.equals(result.candles[2].open));
});

// negative/invalid/non-finite anchor acceptance (self-review requirement)

test('a NaN anchor is rejected (non-finite), never silently produces a NaN candle', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: NaN, rightAnchorOpen: '100.00' }), 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION');
});

test('an Infinity anchor is rejected (non-finite)', () => {
  assertPrecisionError(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '100.00', rightAnchorOpen: Infinity }), 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION');
});

test('a negative but exactly-2dp anchor is accepted -- precision, not sign, is what this policy validates', () => {
  assert.doesNotThrow(() => computeLinearBoundaryInterpolation({ leftAnchorClose: '-100.00', rightAnchorOpen: '-99.50' }));
});
