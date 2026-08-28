import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ManifestCandleContent, ManifestDatasetKind, UnderlyingSessionIdentity } from './dataset-manifest.types';
import {
  DerivedContentPayload,
  computeDerivedContentChecksum,
  manifestCandleContentToPersistedRow,
  resampleBucketMinutes,
  ResampleTargetTimeframe,
  resampledCandleToManifestContent,
  ResampledCandle,
} from './resampled-candle.types';

function identity(overrides: Partial<UnderlyingSessionIdentity> = {}): UnderlyingSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: '2026-08-03',
    ...overrides,
  };
}

function candle(overrides: Partial<ManifestCandleContent> = {}): ManifestCandleContent {
  return {
    candleTime: '2026-08-03T03:45:00.000Z',
    open: '100.00',
    high: '101.00',
    low: '99.00',
    close: '100.50',
    volume: '1000',
    openInterest: null,
    ...overrides,
  };
}

function payload(overrides: Partial<DerivedContentPayload> = {}): DerivedContentPayload {
  return {
    identity: {
      sourceSessionIdentity: identity(),
      sourceSessionContentChecksum: 'src-checksum',
      resamplingSemanticsVersion: 1,
      targetTimeframeMinutes: 5,
    },
    candles: [candle()],
    ...overrides,
  };
}

test('resampleBucketMinutes returns exact minutes for 2m/3m/5m and fails closed on anything else', () => {
  assert.equal(resampleBucketMinutes(ResampleTargetTimeframe.TWO_MINUTE), 2);
  assert.equal(resampleBucketMinutes(ResampleTargetTimeframe.THREE_MINUTE), 3);
  assert.equal(resampleBucketMinutes(ResampleTargetTimeframe.FIVE_MINUTE), 5);
  assert.throws(() => resampleBucketMinutes('4m' as ResampleTargetTimeframe), /Unsupported B-F7 resample target timeframe/);
});

test('identical derived content -> identical derived checksum', () => {
  assert.equal(computeDerivedContentChecksum(payload()), computeDerivedContentChecksum(payload()));
});

test('candle input order does not affect the derived checksum (sorted internally)', () => {
  const c1 = candle({ candleTime: '2026-08-03T03:45:00.000Z' });
  const c2 = candle({ candleTime: '2026-08-03T03:50:00.000Z' });
  const forward = computeDerivedContentChecksum(payload({ candles: [c1, c2] }));
  const reversed = computeDerivedContentChecksum(payload({ candles: [c2, c1] }));
  assert.equal(forward, reversed);
});

test('(AL) a resamplingSemanticsVersion bump changes the derived checksum for identical candle content', () => {
  const v1 = computeDerivedContentChecksum(payload());
  const v2 = computeDerivedContentChecksum(
    payload({ identity: { ...payload().identity, resamplingSemanticsVersion: 2 } })
  );
  assert.notEqual(v1, v2);
});

test('a targetTimeframeMinutes change alone changes the derived checksum', () => {
  const fiveMinute = computeDerivedContentChecksum(payload());
  const threeMinute = computeDerivedContentChecksum(payload({ identity: { ...payload().identity, targetTimeframeMinutes: 3 } }));
  assert.notEqual(fiveMinute, threeMinute);
});

test('a sourceSessionContentChecksum change alone changes the derived checksum (provenance is identity material)', () => {
  const base = computeDerivedContentChecksum(payload());
  const changed = computeDerivedContentChecksum(payload({ identity: { ...payload().identity, sourceSessionContentChecksum: 'different-src-checksum' } }));
  assert.notEqual(base, changed);
});

test('resampledCandleToManifestContent maps bucketStart as candleTime, and exact decimal/bigint strings', () => {
  const resampled: ResampledCandle = {
    bucketStart: new Date('2026-08-03T03:45:00.000Z'),
    bucketEnd: new Date('2026-08-03T03:49:00.000Z'),
    availableAt: new Date('2026-08-03T03:50:00.000Z'),
    open: new Prisma.Decimal('100.00'),
    high: new Prisma.Decimal('101.5'),
    low: new Prisma.Decimal('99.25'),
    close: new Prisma.Decimal('100.75'),
    volume: 123456789012345678901234567890n,
    openInterest: null,
  };
  const content = resampledCandleToManifestContent(resampled);
  assert.equal(content.candleTime, '2026-08-03T03:45:00.000Z');
  assert.equal(content.open, '100');
  assert.equal(content.high, '101.5');
  assert.equal(content.low, '99.25');
  assert.equal(content.close, '100.75');
  assert.equal(content.volume, '123456789012345678901234567890');
  assert.equal(content.openInterest, null);
});

test('manifestCandleContentToPersistedRow round-trips exact decimal/bigint/null content', () => {
  const content: ManifestCandleContent = {
    candleTime: '2026-08-03T03:45:00.000Z',
    open: '100.000000000000000000000000000001',
    high: '101',
    low: '99',
    close: '100.5',
    volume: '123456789012345678901234567890',
    openInterest: null,
  };
  const row = manifestCandleContentToPersistedRow(content);
  assert.equal(row.candleTime.toISOString(), content.candleTime);
  assert.ok(row.open.equals(new Prisma.Decimal(content.open)));
  assert.equal(row.volume, BigInt(content.volume));
  assert.equal(row.openInterest, null);
});

test('manifestCandleContentToPersistedRow preserves zero OI distinctly from null OI', () => {
  const zero = manifestCandleContentToPersistedRow(candle({ openInterest: '0' }));
  const nullOi = manifestCandleContentToPersistedRow(candle({ openInterest: null }));
  assert.equal(zero.openInterest, 0n);
  assert.equal(nullOi.openInterest, null);
});
