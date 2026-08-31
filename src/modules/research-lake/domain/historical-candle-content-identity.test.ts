import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  CandleContentValue,
  candleContentEquals,
  computeCandleContentChecksum,
  computeCanonicalCandleSetChecksum,
} from './historical-candle-content-identity';

const BASE_TIME = new Date('2024-01-19T03:45:00.000Z');

function baseCandle(overrides: Partial<CandleContentValue> = {}): CandleContentValue {
  return {
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    candleTime: BASE_TIME,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

// ---- B-F2C invariant 5: representation equivalence (number/string/Decimal) ----

test('candleContentEquals: a number, a formatted string, and a Prisma.Decimal denoting the same quantity all compare equal', () => {
  const asNumber = baseCandle({ open: 100 });
  const asString = baseCandle({ open: '100.00' });
  const asDecimal = baseCandle({ open: new Prisma.Decimal('100.000000') });

  assert.equal(candleContentEquals(asNumber, asString), true);
  assert.equal(candleContentEquals(asNumber, asDecimal), true);
  assert.equal(candleContentEquals(asString, asDecimal), true);
});

test('computeCandleContentChecksum: identical content produces the identical checksum regardless of decimal representation', () => {
  const asNumber = computeCandleContentChecksum(baseCandle({ close: 100.5 }));
  const asString = computeCandleContentChecksum(baseCandle({ close: '100.5' }));
  const asDecimal = computeCandleContentChecksum(baseCandle({ close: new Prisma.Decimal('100.50') }));
  assert.equal(asNumber, asString);
  assert.equal(asNumber, asDecimal);
});

// ---- B-F2C invariant 7: any OHLC/volume/OI difference is a conflict ----

test('candleContentEquals: an open-price difference is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ open: 100 }), baseCandle({ open: 100.01 })), false);
});

test('candleContentEquals: a high-price difference is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ high: 101 }), baseCandle({ high: 101.5 })), false);
});

test('candleContentEquals: a low-price difference is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ low: 99 }), baseCandle({ low: 98.5 })), false);
});

test('candleContentEquals: a close-price difference is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ close: 100.5 }), baseCandle({ close: 100.6 })), false);
});

test('candleContentEquals: a volume difference is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ volume: 1_000n }), baseCandle({ volume: 1_001n })), false);
});

test('candleContentEquals: openInterest null vs a real value is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ openInterest: null }), baseCandle({ openInterest: 500n })), false);
});

test('candleContentEquals: openInterest value vs a DIFFERENT value is NOT equal', () => {
  assert.equal(candleContentEquals(baseCandle({ openInterest: 500n }), baseCandle({ openInterest: 600n })), false);
});

test('candleContentEquals: openInterest null vs null is equal (both explicitly "no OI")', () => {
  assert.equal(candleContentEquals(baseCandle({ openInterest: null }), baseCandle({ openInterest: null })), true);
});

test('candleContentEquals: openInterest value vs the SAME value is equal', () => {
  assert.equal(candleContentEquals(baseCandle({ openInterest: 500n }), baseCandle({ openInterest: 500n })), true);
});

test('candleContentEquals: a candleTime difference is NOT equal (different logical key entirely)', () => {
  assert.equal(candleContentEquals(baseCandle(), baseCandle({ candleTime: new Date(BASE_TIME.getTime() + 60_000) })), false);
});

// ---- B-F2C invariant 12: `source` is not a field of CandleContentValue at all -- structurally cannot leak into comparison ----

test('candleContentEquals: otherwise-identical content is equal regardless of any external legacy-vs-provider source labeling (CandleContentValue has no source field to compare)', () => {
  // Two candles built from what would be a legacy 'REST'-labeled row and a fresh UPSTOX-provider row --
  // `source` never appears in `CandleContentValue` at all, so there is nothing here that could make it matter.
  const legacy = baseCandle();
  const freshFromProvider = baseCandle();
  assert.equal(candleContentEquals(legacy, freshFromProvider), true);
});

// ---- computeCanonicalCandleSetChecksum: order-independent, deterministic ----

test('computeCanonicalCandleSetChecksum: candles given in a different order produce the SAME checksum (internally sorted by candleTime)', () => {
  const a = baseCandle({ candleTime: BASE_TIME });
  const b = baseCandle({ candleTime: new Date(BASE_TIME.getTime() + 60_000), open: 105 });
  const forward = computeCanonicalCandleSetChecksum([a, b]);
  const reversed = computeCanonicalCandleSetChecksum([b, a]);
  assert.equal(forward, reversed);
});

test('computeCanonicalCandleSetChecksum: a different candle set produces a different checksum', () => {
  const a = baseCandle({ candleTime: BASE_TIME });
  const b = baseCandle({ candleTime: new Date(BASE_TIME.getTime() + 60_000), open: 105 });
  const bDrifted = { ...b, open: 999 };
  assert.notEqual(computeCanonicalCandleSetChecksum([a, b]), computeCanonicalCandleSetChecksum([a, bDrifted]));
});
