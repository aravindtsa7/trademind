import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestDatasetKind,
  OptionSessionIdentity,
  SessionContentIdentity,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { decodeParquetBufferToManifestCandles, encodeManifestCandlesToParquetBuffer, toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import { manifestCandleContentToPersistedRow, ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import HistoricalCandleResamplerService, { ResampleSessionRequest } from './historical-candle-resampler.service';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';

const resampler = new HistoricalCandleResamplerService();
const TRADING_DATE = '2026-08-03';

function sessionStartMs(): number {
  return new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
}

/** Underlying-shaped fixture: never any OI (task section 13/R). */
function underlyingRows(): PersistedManifestCandleRow[] {
  return Array.from({ length: 375 }, (_, index) => {
    const price = 18000 + index * 0.35;
    return {
      candleTime: new Date(sessionStartMs() + index * 60_000),
      open: new Prisma.Decimal(price.toFixed(2)),
      high: new Prisma.Decimal((price + 3.1).toFixed(2)),
      low: new Prisma.Decimal((price - 1.7).toFixed(2)),
      close: new Prisma.Decimal((price + 0.9).toFixed(2)),
      volume: BigInt(10_000 + index * 7),
      openInterest: null,
    };
  });
}

/** Expired-option-shaped fixture: nullable OI, including a genuine zero and a genuine null (task section 14). */
function optionRows(): PersistedManifestCandleRow[] {
  return Array.from({ length: 375 }, (_, index) => {
    const price = 120 + index * 0.05;
    return {
      candleTime: new Date(sessionStartMs() + index * 60_000),
      open: new Prisma.Decimal(price.toFixed(2)),
      high: new Prisma.Decimal((price + 1.25).toFixed(2)),
      low: new Prisma.Decimal((price - 0.5).toFixed(2)),
      close: new Prisma.Decimal((price + 0.4).toFixed(2)),
      volume: BigInt(500 + index),
      openInterest: index % 37 === 0 ? null : index % 11 === 0 ? 0n : BigInt(200_000 + index * 3),
    };
  });
}

async function roundTripThroughParquet(rows: readonly PersistedManifestCandleRow[]): Promise<PersistedManifestCandleRow[]> {
  const manifestCandles = rows.map((row) => toManifestCandleContent(row));
  const buffer = encodeManifestCandlesToParquetBuffer(manifestCandles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);
  return decoded.map((content) => manifestCandleContentToPersistedRow(content));
}

function underlyingIdentity(): UnderlyingSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
  };
}

function optionIdentity(): OptionSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
    provider: HistoricalProviderId.GROWW,
    providerContractId: 'NSE_FO|NIFTY26AUG18000CE',
    optionType: HistoricalOptionType.CE,
    strikePrice: '18000',
    expiry: new Date('2026-08-27T00:00:00.000Z').toISOString(),
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
  };
}

function computeB5Checksum(rows: readonly PersistedManifestCandleRow[], identity: SessionContentIdentity): string {
  return computeSessionContentChecksum({
    identity,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    candles: rows.map((r) => toManifestCandleContent(r)),
  });
}

function buildRequest(
  timeframe: ResampleTargetTimeframe,
  sourceRows: readonly PersistedManifestCandleRow[],
  identity: UnderlyingSessionIdentity | OptionSessionIdentity,
  sourceDatasetKind: ManifestDatasetKind
): ResampleSessionRequest {
  return {
    targetTimeframe: timeframe,
    tradingDate: TRADING_DATE,
    sourceDatasetKind,
    sourceSessionIdentity: identity,
    sourceSessionContentChecksum: computeB5Checksum(sourceRows, identity),
    sourceRows,
  };
}

async function assertParity(
  timeframe: ResampleTargetTimeframe,
  dbRows: readonly PersistedManifestCandleRow[],
  identity: UnderlyingSessionIdentity | OptionSessionIdentity,
  datasetKind: ManifestDatasetKind
): Promise<void> {
  const parquetRows = await roundTripThroughParquet(dbRows);

  const fromDb = resampler.resampleSession(buildRequest(timeframe, dbRows, identity, datasetKind));
  const fromParquet = resampler.resampleSession(buildRequest(timeframe, parquetRows, identity, datasetKind));

  assert.equal(fromDb.candles.length, fromParquet.candles.length);
  assert.deepEqual(
    fromDb.candles.map((c) => c.bucketStart.toISOString()),
    fromParquet.candles.map((c) => c.bucketStart.toISOString())
  );
  fromDb.candles.forEach((candle, index) => {
    const other = fromParquet.candles[index];
    assert.equal(candle.open.toString(), other.open.toString());
    assert.equal(candle.high.toString(), other.high.toString());
    assert.equal(candle.low.toString(), other.low.toString());
    assert.equal(candle.close.toString(), other.close.toString());
    assert.equal(candle.volume, other.volume);
    assert.equal(candle.openInterest, other.openInterest);
    assert.equal(candle.bucketEnd.getTime(), other.bucketEnd.getTime());
    assert.equal(candle.availableAt.getTime(), other.availableAt.getTime());
  });

  assert.deepEqual(fromDb.descriptor, fromParquet.descriptor);
}

// (AM) DB-shaped vs Parquet round-trip source -> exact same 2m result
test('(AM) DB-shaped source vs Parquet round-trip source -> exact same 2m result (underlying)', async () => {
  await assertParity(ResampleTargetTimeframe.TWO_MINUTE, underlyingRows(), underlyingIdentity(), ManifestDatasetKind.UNDERLYING_1M);
});

// (AN) DB-shaped vs Parquet round-trip source -> exact same 3m result
test('(AN) DB-shaped source vs Parquet round-trip source -> exact same 3m result (expired option, nullable OI)', async () => {
  await assertParity(ResampleTargetTimeframe.THREE_MINUTE, optionRows(), optionIdentity(), ManifestDatasetKind.EXPIRED_OPTION_1M);
});

// (AO) DB-shaped vs Parquet round-trip source -> exact same 5m result
test('(AO) DB-shaped source vs Parquet round-trip source -> exact same 5m result (underlying)', async () => {
  await assertParity(ResampleTargetTimeframe.FIVE_MINUTE, underlyingRows(), underlyingIdentity(), ManifestDatasetKind.UNDERLYING_1M);
});

test('DB-shaped source vs Parquet round-trip source -> exact same 5m result (expired option, nullable OI)', async () => {
  await assertParity(ResampleTargetTimeframe.FIVE_MINUTE, optionRows(), optionIdentity(), ManifestDatasetKind.EXPIRED_OPTION_1M);
});
