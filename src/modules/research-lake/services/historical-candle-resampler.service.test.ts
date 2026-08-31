import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestDatasetKind,
  OptionSessionIdentity,
  SessionContentIdentity,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import { RESAMPLING_SEMANTICS_VERSION, ResampleSessionStatus, ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import HistoricalCandleResamplerService, { ResampleSessionRequest } from './historical-candle-resampler.service';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';

const resampler = new HistoricalCandleResamplerService();
const TRADING_DATE = '2026-08-03';

function sessionIdentity(overrides: Partial<UnderlyingSessionIdentity> = {}): UnderlyingSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
    ...overrides,
  };
}

function optionIdentity(overrides: Partial<OptionSessionIdentity> = {}): OptionSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
    provider: HistoricalProviderId.GROWW,
    providerContractId: 'NSE_FO|NIFTY26AUG18000CE',
    optionType: HistoricalOptionType.CE,
    strikePrice: '18000',
    expiry: new Date('2026-08-27T00:00:00.000Z').toISOString(),
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
    ...overrides,
  };
}

function sessionStartMs(): number {
  return new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
}

function row(minuteOffset: number, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  const price = 100 + minuteOffset;
  return {
    candleTime: new Date(sessionStartMs() + minuteOffset * 60_000),
    open: new Prisma.Decimal(price),
    high: new Prisma.Decimal(price + 2),
    low: new Prisma.Decimal(price - 1),
    close: new Prisma.Decimal(price + 1),
    volume: BigInt(1000 + minuteOffset),
    openInterest: null,
    ...overrides,
  };
}

function fullSession(overrideAt?: (minuteOffset: number) => Partial<PersistedManifestCandleRow>): PersistedManifestCandleRow[] {
  return Array.from({ length: 375 }, (_, index) => row(index, overrideAt ? overrideAt(index) : {}));
}

function computeB5Checksum(
  rows: readonly PersistedManifestCandleRow[],
  identity: SessionContentIdentity = sessionIdentity()
): string {
  return computeSessionContentChecksum({
    identity,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    candles: rows.map(toManifestCandleContent),
  });
}

function baseRequest(
  targetTimeframe: ResampleTargetTimeframe,
  sourceRows: readonly PersistedManifestCandleRow[],
  overrides: Partial<ResampleSessionRequest> = {}
): ResampleSessionRequest {
  const identity = overrides.sourceSessionIdentity ?? sessionIdentity();
  return {
    targetTimeframe,
    tradingDate: overrides.tradingDate ?? TRADING_DATE,
    sourceDatasetKind: overrides.sourceDatasetKind ?? (identity.datasetKind as ManifestDatasetKind),
    sourceSessionIdentity: identity,
    sourceSessionContentChecksum: overrides.sourceSessionContentChecksum ?? computeB5Checksum(sourceRows, identity),
    sourceRows,
    ...overrides,
  };
}

// (A)/(B)/(C) full-session bucket counts
test('(A) 375 clean 1m rows -> exactly 75 complete 5m candles', () => {
  const { candles, descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  assert.equal(candles.length, 75);
  assert.equal(descriptor.completeBucketCount, 75);
  assert.equal(descriptor.partialBucketCount, 0);
  assert.equal(descriptor.excludedTrailingRowCount, 0);
  assert.equal(descriptor.status, ResampleSessionStatus.COMPLETE_SESSION);
});

test('(B) 375 clean 1m rows -> exactly 125 complete 3m candles', () => {
  const { candles, descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, fullSession()));
  assert.equal(candles.length, 125);
  assert.equal(descriptor.completeBucketCount, 125);
  assert.equal(descriptor.partialBucketCount, 0);
  assert.equal(descriptor.excludedTrailingRowCount, 0);
});

test('(C)/(Z) 375 clean 1m rows -> exactly 187 complete 2m candles, lone 15:29 tail excluded (never fabricated as a 2m candle)', () => {
  const { candles, descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));
  assert.equal(candles.length, 187);
  assert.equal(descriptor.completeBucketCount, 187);
  assert.equal(descriptor.partialBucketCount, 0);
  assert.equal(descriptor.excludedTrailingRowCount, 1);
  const lastCandle = candles[candles.length - 1];
  assert.equal(lastCandle.bucketStart.toISOString(), new Date(sessionStartMs() + 372 * 60_000).toISOString()); // 15:27 start
  assert.notEqual(lastCandle.bucketStart.getTime(), new Date(sessionStartMs() + 374 * 60_000).getTime()); // 15:29 never becomes a bucket start
});

// (D)/(E)/(F) first bucket boundaries
test('(D) first 5m bucket = 09:15-09:19 IST (bucketStart/bucketEnd)', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  assert.equal(candles[0].bucketStart.getTime(), sessionStartMs());
  assert.equal(candles[0].bucketEnd.getTime(), sessionStartMs() + 4 * 60_000);
});

test('(E) first 3m bucket = 09:15-09:17 IST', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, fullSession()));
  assert.equal(candles[0].bucketStart.getTime(), sessionStartMs());
  assert.equal(candles[0].bucketEnd.getTime(), sessionStartMs() + 2 * 60_000);
});

test('(F) first 2m bucket = 09:15-09:16 IST', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));
  assert.equal(candles[0].bucketStart.getTime(), sessionStartMs());
  assert.equal(candles[0].bucketEnd.getTime(), sessionStartMs() + 1 * 60_000);
});

// (G)-(K) OHLCV formula, and (L)/(M) same rules apply for 2m/3m
test('(G)-(K)/(L)/(M) OHLCV formula: open=first, high=max, low=min, close=last, volume=exact bigint sum -- identical across 2m/3m/5m', () => {
  for (const timeframe of [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE]) {
    const { candles } = resampler.resampleSession(baseRequest(timeframe, fullSession()));
    const bucketSize = timeframe === ResampleTargetTimeframe.TWO_MINUTE ? 2 : timeframe === ResampleTargetTimeframe.THREE_MINUTE ? 3 : 5;
    const first = candles[0];
    assert.equal(first.open.toString(), '100');
    assert.equal(first.high.toString(), String(100 + (bucketSize - 1) + 2));
    assert.equal(first.low.toString(), '99');
    assert.equal(first.close.toString(), String(100 + (bucketSize - 1) + 1));
    const expectedVolume = Array.from({ length: bucketSize }, (_, index) => BigInt(1000 + index)).reduce((total, value) => total + value, 0n);
    assert.equal(first.volume, expectedVolume);
  }
});

// (N)/(O)/(P)/(Q) option OI rules
test('(N) option OI = final constituent OI (never summed/averaged)', () => {
  const rows = fullSession((index) => ({ openInterest: BigInt(5000 + index) }));
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(candles[0].openInterest, BigInt(5000 + 4)); // last of minutes 0..4
});

test('(O) final constituent OI null -> aggregated OI null', () => {
  const rows = fullSession((index) => ({ openInterest: index === 4 ? null : BigInt(5000 + index) }));
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(candles[0].openInterest, null);
});

test('(P) final constituent OI zero -> aggregated OI zero (not treated as null/missing)', () => {
  const rows = fullSession((index) => ({ openInterest: index === 4 ? 0n : BigInt(5000 + index) }));
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(candles[0].openInterest, 0n);
  assert.notEqual(candles[0].openInterest, null);
});

test('(Q) earlier non-null OI + final null OI -> remains null, no forward fill', () => {
  const rows = fullSession((index) => ({ openInterest: index === 0 ? 12345n : index === 4 ? null : 999n }));
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(candles[0].openInterest, null);
});

test('(R) underlying (all-null OI source) never fabricates OI on any derived candle', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  assert.ok(candles.every((c) => c.openInterest === null));
});

// (S)/(T) input order independence
test('(S) shuffled input -> identical derived checksum/output', () => {
  const rows = fullSession();
  const shuffled = [...rows].sort(() => Math.random() - 0.5);
  const forward = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  const reshuffled = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, shuffled));
  assert.equal(forward.descriptor.derivedContentChecksum, reshuffled.descriptor.derivedContentChecksum);
  assert.deepEqual(forward.candles.map((c) => c.bucketStart.toISOString()), reshuffled.candles.map((c) => c.bucketStart.toISOString()));
});

test('(T) descending input -> identical derived checksum/output', () => {
  const rows = fullSession();
  const descending = [...rows].reverse();
  const forward = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, rows));
  const reversedResult = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, descending));
  assert.equal(forward.descriptor.derivedContentChecksum, reversedResult.descriptor.derivedContentChecksum);
});

// (U) duplicate source minute rejected
test('(U) duplicate source minute is rejected, not arbitrarily resolved', () => {
  const rows = [...fullSession(), row(0, { open: new Prisma.Decimal(999) })];
  assert.throws(() => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows)), /duplicate source minute/i);
});

// (V) missing minute inside a bucket -> no fabrication, section 17 gap safety
test('(V)/(17) gap inside an otherwise-full bucket: 09:15,09:16,09:18 for 3m never fabricates a 09:15-09:17 candle', () => {
  const rows = [row(0), row(1), row(3)]; // minute offset 2 (09:17) missing
  const { candles, descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, rows));
  // The 09:15-09:17 bucket has 2/3 constituents (09:17 missing) -- never fabricated as a candle.
  assert.ok(!candles.some((c) => c.bucketStart.getTime() === sessionStartMs()));
  assert.equal(candles.length, 0);
  assert.equal(descriptor.completeBucketCount, 0);
  // Every one of the 125 structurally-possible 3m buckets in the regular session is
  // accounted for against the fixed canonical session shape (task: never scoped down
  // to only whatever the sparse input happened to cover) -- the 09:15 bucket has a
  // genuine partial gap, every other bucket simply has zero of its 3 constituents,
  // which is equally "not complete" and so also counts as partial, never fabricated.
  assert.equal(descriptor.partialBucketCount, 125);
  assert.equal(descriptor.missingSourceMinuteCount, 375 - 3);
  assert.equal(descriptor.status, ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION);
});

// (W)/(X)/(Y) pre-market / post-market / cross-date rejection
test('(W) pre-market row (before 09:15 IST) is rejected', () => {
  const rows = [...fullSession(), { ...row(0), candleTime: new Date(sessionStartMs() - 60_000) }];
  assert.throws(() => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows)), /pre-market row/i);
});

test('(X) post-market row (after 15:29 IST) is rejected', () => {
  const rows = [...fullSession(), { ...row(0), candleTime: new Date(sessionStartMs() + 375 * 60_000) }];
  assert.throws(() => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows)), /post-market row/i);
});

test('(Y) cross-date row is rejected', () => {
  const rows = [...fullSession(), { ...row(0), candleTime: new Date(`2026-08-04T03:45:00.000Z`) }];
  assert.throws(() => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows)), /cross-date row/i);
});

// (AA)/(AB) final bucket constituent minutes
test('(AA) 3m final bucket includes 15:27, 15:28, 15:29', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, fullSession()));
  const last = candles[candles.length - 1];
  assert.equal(last.bucketStart.toISOString(), new Date(sessionStartMs() + 372 * 60_000).toISOString());
  assert.equal(last.bucketEnd.toISOString(), new Date(sessionStartMs() + 374 * 60_000).toISOString());
});

test('(AB) 5m final bucket includes 15:25..15:29', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  const last = candles[candles.length - 1];
  assert.equal(last.bucketStart.toISOString(), new Date(sessionStartMs() + 370 * 60_000).toISOString());
  assert.equal(last.bucketEnd.toISOString(), new Date(sessionStartMs() + 374 * 60_000).toISOString());
});

// (AC)/(AD) exact decimal handling
test('(AC) exact decimal high/low comparison holds at 30 decimal places', () => {
  const rows = [
    row(0, { high: new Prisma.Decimal('100.000000000000000000000000000001'), low: new Prisma.Decimal('99.000000000000000000000000000001') }),
    row(1, { high: new Prisma.Decimal('100.000000000000000000000000000002'), low: new Prisma.Decimal('99.000000000000000000000000000000') }),
  ];
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, rows));
  assert.equal(candles[0].high.toString(), '100.000000000000000000000000000002');
  assert.equal(candles[0].low.toString(), '99');
});

test('(AD) decimal representation normalization is deterministic: "100"/"100.0"/"100.00" are equivalent inputs', () => {
  const variants = ['100', '100.0', '100.00'];
  const checksums = variants.map((value) => {
    const rows = fullSession((index) => (index === 0 ? { open: new Prisma.Decimal(value) } : {}));
    return resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows)).descriptor.derivedContentChecksum;
  });
  assert.equal(checksums[0], checksums[1]);
  assert.equal(checksums[1], checksums[2]);
});

// (AE) exact bigint volume sum beyond MAX_SAFE_INTEGER
test('(AE) bigint volume sum beyond Number.MAX_SAFE_INTEGER is exact', () => {
  const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
  const rows = fullSession((index) => (index < 5 ? { volume: huge } : {}));
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(candles[0].volume, huge * 5n);
  assert.ok(candles[0].volume > BigInt(Number.MAX_SAFE_INTEGER));
});

// (AF) verified source checksum is preserved in descriptor
test('(AF) verified source B-F5 contentChecksum is preserved in descriptor', () => {
  const rows = fullSession();
  const expectedChecksum = computeB5Checksum(rows);
  const { descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(descriptor.sourceSessionContentChecksum, expectedChecksum);
});

// Source checksum mismatch fail-closed regression tests
test('mismatched source B-F5 checksum fails closed on OHLC mutation', () => {
  const rows = fullSession();
  const originalChecksum = computeB5Checksum(rows);
  const mutatedRows = fullSession((index) => (index === 0 ? { open: new Prisma.Decimal(99999) } : {}));
  assert.throws(
    () => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, mutatedRows, { sourceSessionContentChecksum: originalChecksum })),
    /SOURCE_SESSION_CONTENT_CHECKSUM_MISMATCH/
  );
});

test('mismatched source B-F5 checksum fails closed on volume mutation', () => {
  const rows = fullSession();
  const originalChecksum = computeB5Checksum(rows);
  const mutatedRows = fullSession((index) => (index === 0 ? { volume: 999_999n } : {}));
  assert.throws(
    () => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, mutatedRows, { sourceSessionContentChecksum: originalChecksum })),
    /SOURCE_SESSION_CONTENT_CHECKSUM_MISMATCH/
  );
});

test('mismatched source B-F5 checksum fails closed on option OI mutation', () => {
  const optIdent = optionIdentity();
  const rows = fullSession((index) => ({ openInterest: BigInt(5000 + index) }));
  const originalChecksum = computeB5Checksum(rows, optIdent);
  const mutatedRows = fullSession((index) => ({ openInterest: index === 0 ? 0n : BigInt(5000 + index) }));
  assert.throws(
    () => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, mutatedRows, { sourceSessionIdentity: optIdent, sourceSessionContentChecksum: originalChecksum })),
    /SOURCE_SESSION_CONTENT_CHECKSUM_MISMATCH/
  );
});

test('mismatched source tradingDate in request vs sourceSessionIdentity fails closed', () => {
  const mismatchedIdentity = sessionIdentity({ tradingDate: '2026-08-04' });
  const rows = fullSession();
  assert.throws(
    () => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, { tradingDate: '2026-08-03', sourceSessionIdentity: mismatchedIdentity })),
    /mismatched tradingDate/
  );
});

test('mismatched datasetKind in request vs sourceSessionIdentity fails closed', () => {
  const rows = fullSession();
  assert.throws(
    () => resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, { sourceDatasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M, sourceSessionIdentity: sessionIdentity() })),
    /mismatched datasetKind/
  );
});

// (AG)-(AK) derived checksum sensitivity
test('(AG) a changed OHLC value changes the derived checksum', () => {
  const base = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession())).descriptor.derivedContentChecksum;
  const mutated = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession((index) => (index === 4 ? { close: new Prisma.Decimal(999) } : {})))).descriptor.derivedContentChecksum;
  assert.notEqual(base, mutated);
});

test('(AH) a changed volume changes the derived checksum', () => {
  const base = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession())).descriptor.derivedContentChecksum;
  const mutated = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession((index) => (index === 0 ? { volume: 999_999n } : {})))).descriptor.derivedContentChecksum;
  assert.notEqual(base, mutated);
});

test('(AI)/(AJ) a changed option OI changes the derived checksum, and null OI vs zero OI are distinct', () => {
  const nullOi = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession((index) => (index === 4 ? { openInterest: null } : { openInterest: 1n })))).descriptor.derivedContentChecksum;
  const zeroOi = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession((index) => (index === 4 ? { openInterest: 0n } : { openInterest: 1n })))).descriptor.derivedContentChecksum;
  const nonZeroOi = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession(() => ({ openInterest: 1n })))).descriptor.derivedContentChecksum;
  assert.notEqual(nullOi, zeroOi);
  assert.notEqual(zeroOi, nonZeroOi);
  assert.notEqual(nullOi, nonZeroOi);
});

test('(AK) target timeframe changes derived identity even for the same source rows', () => {
  const fiveMinute = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession())).descriptor.derivedContentChecksum;
  const threeMinute = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, fullSession())).descriptor.derivedContentChecksum;
  assert.notEqual(fiveMinute, threeMinute);
});

// (AS) unsupported timeframe rejected
test('(AS) unsupported target timeframe values fail closed', () => {
  for (const bad of ['0m', '1m', '4m', '10m', '15m', 'abc']) {
    assert.throws(() => resampler.resampleSession(baseRequest(bad as ResampleTargetTimeframe, fullSession())), /Unsupported B-F7 resample target timeframe/);
  }
});

// (AT)/(AU)/(AV) no-lookahead availableAt semantics
test('(AT) 2m availableAt is exactly one minute after bucketEnd (no lookahead)', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));
  const first = candles[0];
  assert.equal(first.availableAt.getTime(), first.bucketEnd.getTime() + 60_000);
  assert.ok(first.availableAt.getTime() > first.bucketStart.getTime());
});

test('(AU) 3m availableAt is exactly one minute after bucketEnd', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.THREE_MINUTE, fullSession()));
  const first = candles[0];
  assert.equal(first.availableAt.getTime(), first.bucketEnd.getTime() + 60_000);
  assert.equal(first.availableAt.toISOString(), new Date(sessionStartMs() + 3 * 60_000).toISOString());
});

test('(AV) 5m availableAt is exactly one minute after bucketEnd (09:15 bucket not usable at 09:15)', () => {
  const { candles } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  const first = candles[0];
  assert.equal(first.availableAt.toISOString(), new Date(sessionStartMs() + 5 * 60_000).toISOString());
  assert.ok(first.availableAt.getTime() > first.bucketStart.getTime());
});

// (AW) incomplete source session never certified complete
test('(AW) an incomplete source session cannot be certified as a fully complete derived session', () => {
  const rows = fullSession().slice(0, 374); // one minute short (missing 15:29)
  const { descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows));
  assert.equal(descriptor.status, ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION);
  assert.equal(descriptor.missingSourceMinuteCount, 1);
});

// (AZ) host timezone independence
test('(AZ) host timezone does not alter bucket boundaries or the derived checksum', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    const kolkata = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));
    process.env.TZ = 'America/New_York';
    const newYork = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));
    process.env.TZ = 'Pacific/Kiritimati';
    const kiritimati = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.TWO_MINUTE, fullSession()));

    assert.equal(kolkata.descriptor.derivedContentChecksum, newYork.descriptor.derivedContentChecksum);
    assert.equal(kolkata.descriptor.derivedContentChecksum, kiritimati.descriptor.derivedContentChecksum);
    assert.deepEqual(kolkata.candles.map((c) => c.bucketStart.toISOString()), newYork.candles.map((c) => c.bucketStart.toISOString()));
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ============================================================================
// B-F7 CALENDAR FIX: calendar-authoritative session-window awareness
// (task invariants A/B/C/D/E/F/I). `HistoricalCandleResamplerService` no
// longer hard-codes a single fixed 09:15-15:29 IST regular-session anchor --
// `ResampleSessionRequest.sessionWindows` (defaulting to
// `[regularSessionWindow()]`) now governs bucket anchoring, partial-bucket
// policy, and completeness for REGULAR and SPECIAL sessions alike.
// ============================================================================

/** 60-minute Muhurat-style special session, entirely outside the fixed 09:15-15:29 regular window (16:45-17:45 IST). */
const MUHURAT_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 };
/** A certified multi-window special session: 45 minutes (09:15-10:00) + a closed gap + 60 minutes (11:30-12:30). */
const MULTI_WINDOWS: readonly SessionWindow[] = [
  { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
  { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
];
/** A single 7-minute window -- deliberately not evenly divisible by 2m/3m/5m, isolating the partial-final-bucket policy from any gap/multi-window concern. */
const SEVEN_MINUTE_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 607 };

function calendarDayStartMs(): number {
  return new Date(`${TRADING_DATE}T00:00:00+05:30`).getTime();
}

/** Builds one canonical row at an explicit IST minute-of-day, independent of the 09:15 regular-session anchor `row()`/`fullSession()` assume. */
function rowAtMinute(minuteOfDay: number, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  const price = 100 + minuteOfDay;
  return {
    candleTime: new Date(calendarDayStartMs() + minuteOfDay * 60_000),
    open: new Prisma.Decimal(price),
    high: new Prisma.Decimal(price + 2),
    low: new Prisma.Decimal(price - 1),
    close: new Prisma.Decimal(price + 1),
    volume: BigInt(1000 + minuteOfDay),
    openInterest: null,
    ...overrides,
  };
}

/** Full canonical rows for every minute in every declared window -- the calendar-declared analogue of `fullSession()`. */
function rowsForWindows(windows: readonly SessionWindow[]): PersistedManifestCandleRow[] {
  const rows: PersistedManifestCandleRow[] = [];
  for (const window of windows) {
    for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) rows.push(rowAtMinute(minute));
  }
  return rows;
}

function calendarRequest(
  targetTimeframe: ResampleTargetTimeframe,
  sourceRows: readonly PersistedManifestCandleRow[],
  sessionWindows: readonly SessionWindow[],
  overrides: Partial<ResampleSessionRequest> = {}
): ResampleSessionRequest {
  return baseRequest(targetTimeframe, sourceRows, { sessionWindows, ...overrides });
}

// Task coverage item 3: special session outside normal market hours accepted, not rejected as pre/post-market.
test('(CAL-1) a Muhurat-style special session (16:45-17:45 IST) is accepted and fully resampled -- never rejected as a pre-market/post-market row', () => {
  const rows = rowsForWindows([MUHURAT_WINDOW]);
  const { candles, descriptor } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, [MUHURAT_WINDOW]));
  assert.equal(descriptor.sourceRowCount, 60);
  assert.equal(candles.length, 12);
  assert.equal(descriptor.completeBucketCount, 12);
  assert.equal(descriptor.partialBucketCount, 0);
  assert.equal(descriptor.excludedTrailingRowCount, 0);
  assert.equal(descriptor.missingSourceMinuteCount, 0);
  assert.equal(descriptor.status, ResampleSessionStatus.COMPLETE_SESSION);
  assert.deepEqual(descriptor.sessionWindows, [MUHURAT_WINDOW]);
  assert.equal(candles[0].bucketStart.getTime(), calendarDayStartMs() + MUHURAT_WINDOW.openMinuteIst * 60_000);
});

// Task coverage items 7/8/9: 2m/3m/5m target timeframe over a special session.
test('(CAL-2) 2m/3m/5m target timeframes all resample a 60-minute special session identically to how they resample a 60-minute regular-session slice', () => {
  for (const [timeframe, expectedBuckets] of [
    [ResampleTargetTimeframe.TWO_MINUTE, 30],
    [ResampleTargetTimeframe.THREE_MINUTE, 20],
    [ResampleTargetTimeframe.FIVE_MINUTE, 12],
  ] as const) {
    const rows = rowsForWindows([MUHURAT_WINDOW]);
    const { candles, descriptor } = resampler.resampleSession(calendarRequest(timeframe, rows, [MUHURAT_WINDOW]));
    assert.equal(candles.length, expectedBuckets);
    assert.equal(descriptor.completeBucketCount, expectedBuckets);
    assert.equal(descriptor.partialBucketCount, 0);
    assert.equal(descriptor.excludedTrailingRowCount, 0);
    assert.equal(descriptor.status, ResampleSessionStatus.COMPLETE_SESSION);
  }
});

// Task coverage item 4: multi-window special session, expected source minutes = 105.
test('(CAL-3) a multi-window special session (45 + 60 = 105 minutes) accepts all declared windows and reports zero missing minutes when fully present', () => {
  const rows = rowsForWindows(MULTI_WINDOWS);
  const { descriptor } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, MULTI_WINDOWS));
  assert.equal(descriptor.sourceRowCount, 105);
  assert.equal(descriptor.missingSourceMinuteCount, 0);
  assert.equal(descriptor.status, ResampleSessionStatus.COMPLETE_SESSION);
});

// Task coverage item 5: multi-window resampling does NOT bridge the closed gap.
test('(CAL-4) multi-window 5m resampling never bridges the closed [600,690) gap: exactly 9 + 12 = 21 buckets, none straddling the gap', () => {
  const rows = rowsForWindows(MULTI_WINDOWS);
  const { candles } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, MULTI_WINDOWS));
  assert.equal(candles.length, 21);
  // Every bucket falls entirely inside window 0 [555,600) or window 1 [690,750) -- never spanning the gap.
  for (const candle of candles) {
    const startMinute = (candle.bucketStart.getTime() - calendarDayStartMs()) / 60_000;
    const endMinute = (candle.bucketEnd.getTime() - calendarDayStartMs()) / 60_000;
    const insideWindow0 = startMinute >= 555 && endMinute < 600;
    const insideWindow1 = startMinute >= 690 && endMinute < 750;
    assert.ok(insideWindow0 || insideWindow1, `bucket [${startMinute},${endMinute}] must fall entirely inside one declared window`);
  }
});

// Task coverage item 6: buckets anchor independently at each window's own open minute.
test('(CAL-5) each window is its own independent bucket anchor: window 1\'s first bucket starts exactly at its own openMinuteIst (690), never continuing a running offset from window 0', () => {
  const rows = rowsForWindows(MULTI_WINDOWS);
  const { candles } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, MULTI_WINDOWS));
  assert.equal(candles[0].bucketStart.getTime(), calendarDayStartMs() + 555 * 60_000);
  // Window 0 (45 min / 5m) contributes exactly 9 complete buckets before window 1 begins.
  const firstWindow1Bucket = candles[9];
  assert.equal(firstWindow1Bucket.bucketStart.getTime(), calendarDayStartMs() + 690 * 60_000);
});

// Task coverage item 10: explicit behavior for a window whose length is not divisible by the target timeframe.
test('(CAL-6) a 7-minute window is not evenly divisible by 3m: 2 complete buckets, the trailing 1-minute remainder is excluded, never fabricated/bridged/borrowed', () => {
  const rows = rowsForWindows([SEVEN_MINUTE_WINDOW]);
  const { candles, descriptor } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.THREE_MINUTE, rows, [SEVEN_MINUTE_WINDOW]));
  assert.equal(candles.length, 2);
  assert.equal(descriptor.completeBucketCount, 2);
  assert.equal(descriptor.partialBucketCount, 0);
  assert.equal(descriptor.excludedTrailingRowCount, 1);
  // The trailing remainder is certified complete (all 7 declared minutes present) -- excludedTrailingRowCount is
  // session-arithmetic, not incompleteness (task invariant C vs D).
  assert.equal(descriptor.missingSourceMinuteCount, 0);
  assert.equal(descriptor.status, ResampleSessionStatus.COMPLETE_SESSION);
  const last = candles[candles.length - 1];
  assert.equal(last.bucketStart.getTime(), calendarDayStartMs() + 603 * 60_000);
  assert.equal(last.bucketEnd.getTime(), calendarDayStartMs() + 605 * 60_000);
});

// Task coverage item 11: missing canonical minute inside a special session fails completeness.
test('(CAL-7) a missing canonical minute inside a special session fails completeness (INCOMPLETE_SOURCE_SESSION), exactly as for a regular session', () => {
  const rows = rowsForWindows([MUHURAT_WINDOW]).filter((row) => row.candleTime.getTime() !== calendarDayStartMs() + 1030 * 60_000);
  const { descriptor } = resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, [MUHURAT_WINDOW]));
  assert.equal(descriptor.status, ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION);
  assert.equal(descriptor.missingSourceMinuteCount, 1);
});

// Task coverage item 12: extra/off-window canonical minute is not silently accepted.
test('(CAL-8) a canonical minute falling in the closed gap between two declared windows is rejected, not silently bridged into a bucket', () => {
  const rows = [...rowsForWindows(MULTI_WINDOWS), rowAtMinute(650)]; // 650 falls in the undeclared [600,690) gap
  assert.throws(
    () => resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, MULTI_WINDOWS)),
    /outside every declared calendar session window/i
  );
});

// Task coverage item 13: duplicate canonical minute inside a special session remains fail-closed.
test('(CAL-9) a duplicate canonical minute inside a special session is rejected, exactly as for a regular session', () => {
  const rows = [...rowsForWindows([MUHURAT_WINDOW]), rowAtMinute(MUHURAT_WINDOW.openMinuteIst, { open: new Prisma.Decimal(999) })];
  assert.throws(() => resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, [MUHURAT_WINDOW])), /duplicate source minute/i);
});

// Task invariant A/I: a malformed (overlapping) sessionWindows declaration fails closed before any row is inspected.
test('(CAL-10) an overlapping/malformed sessionWindows declaration fails closed rather than resampling against a corrupted calendar declaration', () => {
  const overlapping: readonly SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 590, closeMinuteIst: 650 },
  ];
  const rows = rowsForWindows([{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 650 }]);
  assert.throws(() => resampler.resampleSession(calendarRequest(ResampleTargetTimeframe.FIVE_MINUTE, rows, overlapping)), /overlap/i);
});

// Task invariant E: regular-session parity -- an explicit [regularSessionWindow()] declaration must be bit-for-bit
// identical to the pre-existing default (omitted sessionWindows) for every target timeframe.
test('(CAL-11) explicitly passing [regularSessionWindow()] produces a bit-for-bit identical result to omitting sessionWindows entirely', () => {
  for (const timeframe of [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE]) {
    const rows = fullSession();
    const implicit = resampler.resampleSession(baseRequest(timeframe, rows));
    const explicit = resampler.resampleSession(calendarRequest(timeframe, rows, [regularSessionWindow()]));
    assert.deepEqual(implicit.descriptor, explicit.descriptor);
    assert.deepEqual(
      implicit.candles.map((c) => c.bucketStart.toISOString()),
      explicit.candles.map((c) => c.bucketStart.toISOString())
    );
  }
});

// Observability: the descriptor always records which windows governed the result, even when defaulted.
test('(CAL-12) descriptor.sessionWindows defaults to [regularSessionWindow()] when the request omits sessionWindows', () => {
  const { descriptor } = resampler.resampleSession(baseRequest(ResampleTargetTimeframe.FIVE_MINUTE, fullSession()));
  assert.deepEqual(descriptor.sessionWindows, [regularSessionWindow()]);
});

// Task invariant F: RESAMPLING_SEMANTICS_VERSION was bumped for this genuine semantics change.
test('(CAL-13) RESAMPLING_SEMANTICS_VERSION was bumped to 2 for the calendar-authoritative bucket-anchor/completeness semantics change', () => {
  assert.equal(RESAMPLING_SEMANTICS_VERSION, 2);
});
