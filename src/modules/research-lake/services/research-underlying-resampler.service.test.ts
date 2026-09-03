import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { ImputationReason, ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { ResearchCandleQuality } from '../domain/research-underlying-resampled-candle.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import HistoricalCandleResamplerService, { ResampleSessionRequest } from './historical-candle-resampler.service';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestDatasetKind,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { ResolvedResearchRowSourceKind, ResolvedResearchSessionRow } from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplerService, {
  ResearchResampleSessionRequest,
  ResearchUnderlyingResamplerMissingMinuteError,
  ResearchUnderlyingResamplerSourceFamilyMismatchError,
  ResearchUnderlyingResamplerUnresampleableTierError,
} from './research-underlying-resampler.service';

const resampler = new ResearchUnderlyingResamplerService();
const b7Resampler = new HistoricalCandleResamplerService();
const TRADING_DATE = '2022-03-07';
const SOURCE_ASSEMBLY_CHECKSUM = '8'.repeat(64);
const SOURCE_CONTENT_CHECKSUM = 'c'.repeat(64);
const REGULAR_WINDOW = regularSessionWindow();

function dayStartMs(tradingDate: string): number {
  return new Date(`${tradingDate}T00:00:00+05:30`).getTime();
}

function timeAtMinute(tradingDate: string, minuteOfDay: number): Date {
  return new Date(dayStartMs(tradingDate) + minuteOfDay * 60_000);
}

function realCanonicalRow(tradingDate: string, minuteOfDay: number, overrides: Partial<ResolvedResearchSessionRow> = {}): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: null,
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL },
    ...overrides,
  };
}

function derivedObservedRow(tradingDate: string, minuteOfDay: number, overrides: Partial<ResolvedResearchSessionRow> = {}): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: String(1000 + minuteOfDay),
    openInterest: String(500 + minuteOfDay),
    availableAt: new Date(candleTime.getTime() + 60_000).toISOString(),
    provenance: { sourceKind: ResolvedResearchRowSourceKind.DERIVED, derivedRowProvenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: 'a'.repeat(64) } },
    ...overrides,
  };
}

function derivedImputedRow(tradingDate: string, minuteOfDay: number, availableAtIso: string, overrides: Partial<ResolvedResearchSessionRow> = {}): ResolvedResearchSessionRow {
  const candleTime = timeAtMinute(tradingDate, minuteOfDay);
  const price = 100 + minuteOfDay;
  return {
    candleTime: candleTime.toISOString(),
    open: String(price),
    high: String(price),
    low: String(price),
    close: String(price),
    volume: '0',
    openInterest: null,
    availableAt: availableAtIso,
    provenance: {
      sourceKind: ResolvedResearchRowSourceKind.DERIVED,
      derivedRowProvenance: {
        kind: ResearchRowProvenanceKind.IMPUTED,
        method: 'LINEAR_BOUNDARY_INTERPOLATION',
        policyVersion: 1,
        authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
        reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
        leftAnchor: { candleTime: timeAtMinute(tradingDate, minuteOfDay - 1).toISOString(), field: 'CLOSE', contentChecksum: 'b'.repeat(64) },
        rightAnchor: { candleTime: timeAtMinute(tradingDate, minuteOfDay + 4).toISOString(), field: 'OPEN', contentChecksum: 'c'.repeat(64) },
        sourceSnapshotChecksum: 'a'.repeat(64),
      },
    },
    ...overrides,
  };
}

function fullRealCanonicalSession(tradingDate: string = TRADING_DATE, windows: readonly SessionWindow[] = [REGULAR_WINDOW]): ResolvedResearchSessionRow[] {
  const rows: ResolvedResearchSessionRow[] = [];
  for (const window of windows) {
    for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) rows.push(realCanonicalRow(tradingDate, minute));
  }
  return rows;
}

/** The exact March-7-shaped fixture the task locks in: 372 OBSERVED + 3 IMPUTED (10:22/10:23/10:24 IST, minute-of-day 622/623/624), every imputed row's `availableAt` = 10:26 IST (minute-of-day 626). */
const IMPUTED_MINUTES = [622, 623, 624];
function march7ShapedSession(tradingDate: string = TRADING_DATE): ResolvedResearchSessionRow[] {
  const availableAtIso = timeAtMinute(tradingDate, 626).toISOString();
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) {
    rows.push(IMPUTED_MINUTES.includes(minute) ? derivedImputedRow(tradingDate, minute, availableAtIso) : derivedObservedRow(tradingDate, minute));
  }
  return rows;
}

function baseRequest(overrides: Partial<ResearchResampleSessionRequest> = {}): ResearchResampleSessionRequest {
  return {
    sourceAssemblyChecksum: SOURCE_ASSEMBLY_CHECKSUM,
    tradingDate: TRADING_DATE,
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    sourceContentChecksum: SOURCE_CONTENT_CHECKSUM,
    targetTimeframe: ResampleTargetTimeframe.TWO_MINUTE,
    sessionWindows: [REGULAR_WINDOW],
    sourceRows: fullRealCanonicalSession(),
    ...overrides,
  };
}

function march7Request(targetTimeframe: ResampleTargetTimeframe, overrides: Partial<ResearchResampleSessionRequest> = {}): ResearchResampleSessionRequest {
  return baseRequest({
    targetTimeframe,
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    sourceRows: march7ShapedSession(),
    ...overrides,
  });
}

// ============================================================================
// 1. Only 2m/3m/5m accepted
// ============================================================================

test('only 2m/3m/5m target timeframes are accepted -- an unsupported value fails closed', () => {
  assert.throws(() => resampler.resampleSession(baseRequest({ targetTimeframe: 'not-a-real-timeframe' as never as ResampleTargetTimeframe })));
});

// ============================================================================
// 2. Input rows order-independent
// ============================================================================

test('input row order does not affect output candles or checksum', () => {
  const rows = fullRealCanonicalSession();
  const shuffled = [...rows].reverse();
  const a = resampler.resampleSession(baseRequest({ sourceRows: rows }));
  const b = resampler.resampleSession(baseRequest({ sourceRows: shuffled }));
  assert.equal(a.descriptor.researchDerivedContentChecksum, b.descriptor.researchDerivedContentChecksum);
  assert.equal(a.candles.length, b.candles.length);
});

// ============================================================================
// 3/4/5/6. duplicate / cross-date / outside-window / closed-gap fail closed
// ============================================================================

test('duplicate source minute fails closed', () => {
  const rows = fullRealCanonicalSession();
  assert.throws(() => resampler.resampleSession(baseRequest({ sourceRows: [...rows, rows[0]] })), /duplicate source minute/);
});

test('cross-date row fails closed', () => {
  const rows = fullRealCanonicalSession();
  const badRow = { ...rows[0], candleTime: new Date(dayStartMs('2022-03-08') + REGULAR_WINDOW.openMinuteIst * 60_000).toISOString() };
  assert.throws(() => resampler.resampleSession(baseRequest({ sourceRows: [...rows.slice(1), badRow] })), /cross-date row/);
});

test('row outside the declared session window fails closed', () => {
  const rows = fullRealCanonicalSession();
  const outside = realCanonicalRow(TRADING_DATE, REGULAR_WINDOW.closeMinuteIst + 5);
  assert.throws(() => resampler.resampleSession(baseRequest({ sourceRows: [...rows, outside] })), /post-market row|outside every declared/);
});

test('row inside a closed gap between two disjoint windows fails closed', () => {
  const windows: readonly SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const rows = fullRealCanonicalSession(TRADING_DATE, windows);
  const gapRow = realCanonicalRow(TRADING_DATE, 650);
  assert.throws(() => resampler.resampleSession(baseRequest({ sessionWindows: windows, sourceRows: [...rows, gapRow] })), /closed gap between two disjoint windows/);
});

// ============================================================================
// 7. Missing expected source minute fails closed
// ============================================================================

test('missing an expected source minute fails closed (no INCOMPLETE return path)', () => {
  const rows = fullRealCanonicalSession().filter((row) => row.candleTime !== timeAtMinute(TRADING_DATE, 700).toISOString());
  assert.throws(() => resampler.resampleSession(baseRequest({ sourceRows: rows })), ResearchUnderlyingResamplerMissingMinuteError);
});

// ============================================================================
// 8/9. Source-family mismatch fails closed
// ============================================================================

test('a DERIVED row inside a tier 1/2 (real canonical) selection fails closed', () => {
  const rows = fullRealCanonicalSession();
  const mixed = rows.map((row, index) => (index === 10 ? derivedObservedRow(TRADING_DATE, REGULAR_WINDOW.openMinuteIst + 10) : row));
  assert.throws(() => resampler.resampleSession(baseRequest({ sourceRows: mixed })), ResearchUnderlyingResamplerSourceFamilyMismatchError);
});

test('a REAL_CANONICAL row inside a tier 3 (derived) selection fails closed', () => {
  const rows = march7ShapedSession();
  const mixed = rows.map((row, index) => (index === 10 ? realCanonicalRow(TRADING_DATE, REGULAR_WINDOW.openMinuteIst + 10) : row));
  assert.throws(() => resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE, { sourceRows: mixed })), ResearchUnderlyingResamplerSourceFamilyMismatchError);
});

test('an unresampleable precedence tier (UNAVAILABLE) fails closed', () => {
  assert.throws(
    () => resampler.resampleSession(baseRequest({ sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE as never })),
    ResearchUnderlyingResamplerUnresampleableTierError
  );
});

// ============================================================================
// 10/11/12/13. OHLC / volume / OI exact aggregation
// ============================================================================

test('OHLC aggregation: open=first, high=max, low=min, close=last', () => {
  const { candles } = resampler.resampleSession(baseRequest({ targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE }));
  const firstCandle = candles[0];
  // constituents are minutes 555..559 -- open comes from minute 555, close from minute 559.
  assert.equal(firstCandle.open.toString(), '655'); // open of minute 555 = 100+555
  assert.equal(firstCandle.close.toString(), '660'); // close of minute 559 = (100+559)+1
  assert.equal(firstCandle.high.toString(), '661'); // max(high) = minute 559's high = (100+559)+2
  assert.equal(firstCandle.low.toString(), '654'); // min(low) = minute 555's low = (100+555)-1
});

test('volume is an exact bigint sum over every constituent', () => {
  const { candles } = resampler.resampleSession(baseRequest({ targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE }));
  const expected = [555, 556, 557, 558, 559].reduce((sum, minute) => sum + BigInt(1000 + minute), 0n);
  assert.equal(candles[0].volume, expected);
});

test('openInterest is the FINAL constituent only -- never summed/averaged', () => {
  const { candles } = resampler.resampleSession(baseRequest({ targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE, sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION, sourceRows: (() => {
    const rows: ResolvedResearchSessionRow[] = [];
    for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) rows.push(derivedObservedRow(TRADING_DATE, minute));
    return rows;
  })() }));
  const firstCandle = candles[0];
  assert.equal(firstCandle.openInterest, BigInt(500 + 559));
});

test('null final-constituent OI stays null -- no forward-fill from an earlier non-null value', () => {
  const rows: ResolvedResearchSessionRow[] = [];
  for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) {
    rows.push(derivedObservedRow(TRADING_DATE, minute, minute === 559 ? { openInterest: null } : {}));
  }
  const { candles } = resampler.resampleSession(
    baseRequest({ targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE, sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION, sourceRows: rows })
  );
  assert.equal(candles[0].openInterest, null);
});

// ============================================================================
// 14/15/16/17. availableAt = max(constituent availableAt) + checksum determinism
// ============================================================================

test('availableAt = MAX(constituent availableAt), not bucketEnd + 1 minute, when a constituent is delayed', () => {
  const rows = fullRealCanonicalSession();
  const delayedAt = timeAtMinute(TRADING_DATE, 999).toISOString(); // an artificial, far-future delay
  const withDelay = rows.map((row) => (row.candleTime === timeAtMinute(TRADING_DATE, 556).toISOString() ? { ...row, availableAt: delayedAt } : row));
  const { candles } = resampler.resampleSession(baseRequest({ targetTimeframe: ResampleTargetTimeframe.FIVE_MINUTE, sourceRows: withDelay }));
  assert.equal(candles[0].availableAt.toISOString(), delayedAt);
});

test('changing only availableAt on one row changes the researchDerivedContentChecksum', () => {
  const rows = march7ShapedSession();
  const base = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE, { sourceRows: rows }));
  const laterAvailableAt = timeAtMinute(TRADING_DATE, 700).toISOString();
  const mutated = rows.map((row) => (row.candleTime === timeAtMinute(TRADING_DATE, 622).toISOString() ? { ...row, availableAt: laterAvailableAt } : row));
  const changed = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE, { sourceRows: mutated }));
  assert.notEqual(base.descriptor.researchDerivedContentChecksum, changed.descriptor.researchDerivedContentChecksum);
});

test('changing only provenance (OBSERVED -> IMPUTED, identical OHLCV/availableAt) changes the checksum', () => {
  const observedOnly = (() => {
    const rows: ResolvedResearchSessionRow[] = [];
    for (let minute = REGULAR_WINDOW.openMinuteIst; minute < REGULAR_WINDOW.closeMinuteIst; minute += 1) rows.push(derivedObservedRow(TRADING_DATE, minute));
    return rows;
  })();
  const base = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE, { sourceRows: observedOnly }));

  const targetMinute = 622;
  const targetRow = observedOnly.find((row) => row.candleTime === timeAtMinute(TRADING_DATE, targetMinute).toISOString())!;
  const swapped = observedOnly.map((row) =>
    row === targetRow
      ? derivedImputedRow(TRADING_DATE, targetMinute, targetRow.availableAt, { open: targetRow.open, high: targetRow.high, low: targetRow.low, close: targetRow.close, volume: targetRow.volume, openInterest: targetRow.openInterest })
      : row
  );
  const changed = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE, { sourceRows: swapped }));
  assert.notEqual(base.descriptor.researchDerivedContentChecksum, changed.descriptor.researchDerivedContentChecksum);
});

test('input permutation produces the identical researchDerivedContentChecksum', () => {
  const rows = march7ShapedSession();
  const a = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE, { sourceRows: rows }));
  const b = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE, { sourceRows: [...rows].sort(() => 0.5 - Math.random()) }));
  assert.equal(a.descriptor.researchDerivedContentChecksum, b.descriptor.researchDerivedContentChecksum);
});

test('changing sourceAssemblyChecksum changes the researchDerivedContentChecksum', () => {
  const rows = march7ShapedSession();
  const a = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE, { sourceRows: rows, sourceAssemblyChecksum: '1'.repeat(64) }));
  const b = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE, { sourceRows: rows, sourceAssemblyChecksum: '2'.repeat(64) }));
  assert.notEqual(a.descriptor.researchDerivedContentChecksum, b.descriptor.researchDerivedContentChecksum);
});

// ============================================================================
// 18/19/20/21/22/23. All-real B-F7 parity + bucket/window rules
// ============================================================================

function b7Identity(overrides: Partial<UnderlyingSessionIdentity> = {}): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: TRADING_DATE, ...overrides };
}

function b7Row(minuteOfDay: number): PersistedManifestCandleRow {
  const price = 100 + minuteOfDay;
  return {
    candleTime: timeAtMinute(TRADING_DATE, minuteOfDay),
    open: new Prisma.Decimal(price),
    high: new Prisma.Decimal(price + 2),
    low: new Prisma.Decimal(price - 1),
    close: new Prisma.Decimal(price + 1),
    volume: BigInt(1000 + minuteOfDay),
    openInterest: null,
  };
}

function b7Rows(windows: readonly SessionWindow[]): PersistedManifestCandleRow[] {
  const rows: PersistedManifestCandleRow[] = [];
  for (const window of windows) for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) rows.push(b7Row(minute));
  return rows;
}

function b7Checksum(rows: readonly PersistedManifestCandleRow[]): string {
  return computeSessionContentChecksum({
    identity: b7Identity(),
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    candles: rows.map(toManifestCandleContent),
  });
}

function runB7(windows: readonly SessionWindow[], targetTimeframe: ResampleTargetTimeframe) {
  const rows = b7Rows(windows);
  const request: ResampleSessionRequest = {
    targetTimeframe,
    tradingDate: TRADING_DATE,
    sourceDatasetKind: ManifestDatasetKind.UNDERLYING_1M,
    sourceSessionIdentity: b7Identity(),
    sourceSessionContentChecksum: b7Checksum(rows),
    sessionWindows: windows,
    sourceRows: rows,
  };
  return b7Resampler.resampleSession(request);
}

function runResearch(windows: readonly SessionWindow[], targetTimeframe: ResampleTargetTimeframe) {
  return resampler.resampleSession(baseRequest({ targetTimeframe, sessionWindows: windows, sourceRows: fullRealCanonicalSession(TRADING_DATE, windows) }));
}

for (const timeframe of [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE, ResampleTargetTimeframe.FIVE_MINUTE]) {
  test(`all-real ${timeframe} regular-session parity with B-F7: identical bucket boundaries/OHLCV/OI/availableAt/counts`, () => {
    const b7 = runB7([REGULAR_WINDOW], timeframe);
    const research = runResearch([REGULAR_WINDOW], timeframe);
    assert.equal(research.candles.length, b7.candles.length);
    assert.equal(research.descriptor.outputCandleCount, b7.descriptor.completeBucketCount);
    assert.equal(research.descriptor.structuralTrailingRowCount, b7.descriptor.excludedTrailingRowCount);
    for (let i = 0; i < b7.candles.length; i += 1) {
      const bc = b7.candles[i];
      const rc = research.candles[i];
      assert.equal(rc.bucketStart.getTime(), bc.bucketStart.getTime());
      assert.equal(rc.bucketEnd.getTime(), bc.bucketEnd.getTime());
      assert.equal(rc.availableAt.getTime(), bc.availableAt.getTime());
      assert.equal(rc.open.toString(), bc.open.toString());
      assert.equal(rc.high.toString(), bc.high.toString());
      assert.equal(rc.low.toString(), bc.low.toString());
      assert.equal(rc.close.toString(), bc.close.toString());
      assert.equal(rc.volume, bc.volume);
      assert.equal(rc.openInterest, bc.openInterest);
      assert.equal(rc.quality, ResearchCandleQuality.REAL_CANONICAL_ONLY);
    }
  });
}

const MULTI_WINDOWS: readonly SessionWindow[] = [
  { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
  { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
];

test('multi-window special-session parity with B-F7 (5m): 9 + 12 = 21 buckets, identical boundaries, never bridges the closed gap', () => {
  const b7 = runB7(MULTI_WINDOWS, ResampleTargetTimeframe.FIVE_MINUTE);
  const research = runResearch(MULTI_WINDOWS, ResampleTargetTimeframe.FIVE_MINUTE);
  assert.equal(research.candles.length, 21);
  assert.equal(research.candles.length, b7.candles.length);
  for (let i = 0; i < b7.candles.length; i += 1) {
    assert.equal(research.candles[i].bucketStart.getTime(), b7.candles[i].bucketStart.getTime());
    assert.equal(research.candles[i].bucketEnd.getTime(), b7.candles[i].bucketEnd.getTime());
  }
  // No candle's constituent minutes ever span the closed [600, 690) gap.
  for (const candle of research.candles) {
    assert.ok(candle.bucketEnd.getTime() < timeAtMinute(TRADING_DATE, 600).getTime() || candle.bucketStart.getTime() >= timeAtMinute(TRADING_DATE, 690).getTime());
  }
});

test('a bucket never crosses a session-window boundary (2m over multi-window)', () => {
  const research = runResearch(MULTI_WINDOWS, ResampleTargetTimeframe.TWO_MINUTE);
  for (const candle of research.candles) {
    const inWindow0 = candle.bucketStart.getTime() >= timeAtMinute(TRADING_DATE, 555).getTime() && candle.bucketEnd.getTime() < timeAtMinute(TRADING_DATE, 600).getTime();
    const inWindow1 = candle.bucketStart.getTime() >= timeAtMinute(TRADING_DATE, 690).getTime() && candle.bucketEnd.getTime() < timeAtMinute(TRADING_DATE, 750).getTime();
    assert.ok(inWindow0 || inWindow1);
  }
});

test('structural trailing remainder (2m regular session, 1 minute) is reported as structural, never as missing data', () => {
  const research = runResearch([REGULAR_WINDOW], ResampleTargetTimeframe.TWO_MINUTE);
  assert.equal(research.descriptor.structuralTrailingRowCount, 1);
  assert.equal(research.descriptor.missingSourceMinuteCount, 0);
  assert.equal(research.descriptor.outputCandleCount, 187);
});

// ============================================================================
// 25-35. March-7 exact structural + no-lookahead proofs
// ============================================================================

test('March-7-shaped fixture resolves 375 rows: 372 OBSERVED + 3 IMPUTED', () => {
  const rows = march7ShapedSession();
  assert.equal(rows.length, 375);
  const imputed = rows.filter((row) => row.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.IMPUTED);
  const observed = rows.filter((row) => row.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.OBSERVED);
  assert.equal(imputed.length, 3);
  assert.equal(observed.length, 372);
});

test('March-7 2m output count = 187, structural trailing = 1, candlesContainingImputation = 2', () => {
  const { descriptor } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  assert.equal(descriptor.outputCandleCount, 187);
  assert.equal(descriptor.structuralTrailingRowCount, 1);
  assert.equal(descriptor.candlesContainingImputation, 2);
  assert.equal(descriptor.derivedImputedConstituentRowCount, 3);
  assert.equal(descriptor.derivedObservedConstituentRowCount, 372);
});

test('March-7 3m output count = 125, structural trailing = 0, candlesContainingImputation = 2', () => {
  const { descriptor } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE));
  assert.equal(descriptor.outputCandleCount, 125);
  assert.equal(descriptor.structuralTrailingRowCount, 0);
  assert.equal(descriptor.candlesContainingImputation, 2);
});

test('March-7 5m output count = 75, structural trailing = 0, candlesContainingImputation = 1', () => {
  const { descriptor } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.FIVE_MINUTE));
  assert.equal(descriptor.outputCandleCount, 75);
  assert.equal(descriptor.structuralTrailingRowCount, 0);
  assert.equal(descriptor.candlesContainingImputation, 1);
});

test('March-7 2m 10:21-10:22 bucket availableAt = 10:26 IST', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 621).getTime())!;
  assert.ok(bucket);
  assert.equal(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 626).getTime());
  assert.equal(bucket.quality, ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION);
});

test('March-7 2m 10:23-10:24 bucket availableAt = 10:26 IST', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 623).getTime())!;
  assert.ok(bucket);
  assert.equal(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 626).getTime());
  assert.equal(bucket.quality, ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION);
});

test('March-7 3m 10:21-10:23 bucket availableAt = 10:26 IST', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 621).getTime())!;
  assert.ok(bucket);
  assert.equal(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 626).getTime());
});

test('March-7 3m 10:24-10:26 bucket availableAt = 10:27 IST -- MAX(10:26 imputation delay, 10:27 normal completion), NEVER 10:26', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.THREE_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 624).getTime())!;
  assert.ok(bucket);
  assert.equal(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 627).getTime());
  assert.notEqual(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 626).getTime());
  assert.equal(bucket.quality, ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION);
});

test('March-7 5m 10:20-10:24 bucket availableAt = 10:26 IST', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.FIVE_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 620).getTime())!;
  assert.ok(bucket);
  assert.equal(bucket.availableAt.getTime(), timeAtMinute(TRADING_DATE, 626).getTime());
  assert.equal(bucket.quality, ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION);
});

test('March-7 affected bucket whose FINAL constituent is imputed never forward-fills OI -- stays null', () => {
  // 2m bucket [622,623] and [623(actually 623-624)]: build a bucket whose final constituent minute is imputed and check OI null.
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 623).getTime())!; // constituents 623(imputed),624(imputed)
  assert.ok(bucket);
  assert.equal(bucket.openInterest, null);
});

test('a bucket built entirely from DERIVED OBSERVED rows (no imputation) is classified DERIVED_OBSERVED_ONLY, not REAL_CANONICAL_ONLY', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  const untouchedBucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 555).getTime())!;
  assert.ok(untouchedBucket);
  assert.equal(untouchedBucket.quality, ResearchCandleQuality.DERIVED_OBSERVED_ONLY);
});

test('imputed candle constituent lineage carries the exact B-M7.1 authorization/reason/anchor provenance', () => {
  const { candles } = resampler.resampleSession(march7Request(ResampleTargetTimeframe.TWO_MINUTE));
  const bucket = candles.find((c) => c.bucketStart.getTime() === timeAtMinute(TRADING_DATE, 621).getTime())!;
  const imputedEntry = bucket.constituents.find((c) => c.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && c.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.IMPUTED)!;
  assert.ok(imputedEntry);
  const provenance = imputedEntry.provenance as Extract<typeof imputedEntry.provenance, { sourceKind: ResolvedResearchRowSourceKind.DERIVED }>;
  const derived = provenance.derivedRowProvenance as Extract<typeof provenance.derivedRowProvenance, { kind: ResearchRowProvenanceKind.IMPUTED }>;
  assert.equal(derived.authorizationId, 'NIFTY_2022_03_07_INDEX_GAP_V1');
  assert.equal(derived.reason, ImputationReason.INDEX_BROADCAST_DATA_GAP);
  assert.ok(derived.leftAnchor.candleTime);
  assert.ok(derived.rightAnchor.candleTime);
});
