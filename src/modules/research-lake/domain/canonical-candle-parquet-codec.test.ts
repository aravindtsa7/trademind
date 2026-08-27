import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { parquetMetadataAsync } from 'hyparquet';
import { decodeParquetBufferToManifestCandles, encodeManifestCandlesToParquetBuffer, toManifestCandleContent } from './canonical-candle-parquet-codec';
import { ManifestCandleContent, computeSessionContentChecksum, UnderlyingSessionIdentity, ManifestDatasetKind } from './dataset-manifest.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { PersistedManifestCandleRow } from '../services/dataset-session-manifest-builder.service';

function makeRow(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal('100.500000000000000000000000000000'),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(tradingDate: string, count = 375): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: count }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

const IDENTITY: UnderlyingSessionIdentity = {
  datasetKind: ManifestDatasetKind.UNDERLYING_1M,
  provider: HistoricalProviderId.UPSTOX,
  instrumentKey: 'NSE_INDEX|Nifty 50',
  timeframe: '1minute',
  tradingDate: '2022-01-03',
};

function checksumOf(candles: readonly ManifestCandleContent[]): string {
  return computeSessionContentChecksum({ identity: IDENTITY, canonicalizationVersion: 1, healthSemanticsVersion: 1, candles });
}

test('(A) underlying 375-row Parquet write/read round-trip preserves row count and content', async () => {
  const rows = normalSessionRows('2022-01-03');
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded.length, 375);
  assert.deepEqual(decoded, candles);
});

test('(B) option-session-shaped 375-row Parquet write/read round-trip (same codec, OI populated)', async () => {
  const rows = normalSessionRows('2022-01-03').map((row, index) => ({ ...row, openInterest: BigInt(index) }));
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded.length, 375);
  assert.deepEqual(decoded.map((c) => c.openInterest), candles.map((c) => c.openInterest));
});

test('(C)/(D) B-F5 session contentChecksum is identical before encode and after decode', async () => {
  const rows = normalSessionRows('2022-01-03');
  const candles = rows.map(toManifestCandleContent);
  const before = checksumOf(candles);

  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);
  const after = checksumOf(decoded);

  assert.equal(after, before);
});

test('(E) "100" and a Decimal constructed from "100.000...0" both round-trip through Parquet as exactly the string Prisma.Decimal#toString() produces (no additional Parquet-side normalization)', async () => {
  // Prisma.Decimal (decimal.js) itself normalizes trailing zeros at `.toString()` time --
  // that normalization happens BEFORE this codec ever sees a value (identical to what
  // `DatasetSessionManifestBuilderService.build()` already does, dataset-session-manifest-builder.service.ts:119-124).
  // This test proves Parquet introduces NO additional loss/normalization beyond that pre-existing,
  // out-of-scope Prisma.Decimal characteristic -- it asserts against the actual `.toString()` output, not a hand-typed literal.
  const decimalValue = new Prisma.Decimal('100.000000000000000000000000000000');
  const rows = [makeRow(new Date('2022-01-03T03:45:00.000Z'), { open: decimalValue })];
  const candles = rows.map(toManifestCandleContent);
  assert.equal(candles[0].open, decimalValue.toString()); // sanity: mapping introduces no loss either

  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].open, decimalValue.toString());
});

test('(F) fractional high-precision OHLC is preserved through Parquet exactly as Prisma.Decimal#toString() produced it -- no additional Parquet-side rounding/truncation', async () => {
  const decimalValue = new Prisma.Decimal('17234.123456789012345678901234567890');
  const rows = [makeRow(new Date('2022-01-03T03:45:00.000Z'), { close: decimalValue })];
  const candles = rows.map(toManifestCandleContent);
  const expected = decimalValue.toString(); // whatever Prisma.Decimal itself normalizes to -- Parquet must not narrow it further
  assert.equal(candles[0].close, expected);

  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].close, expected);
});

test('(G) bigint volume beyond Number.MAX_SAFE_INTEGER round-trips exactly', async () => {
  const bigVolume = 9_223_372_036_854_775_800n;
  const rows = [makeRow(new Date('2022-01-03T03:45:00.000Z'), { volume: bigVolume })];
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].volume, bigVolume.toString());
});

test('(H)/(I)/(J) open interest: positive, zero, and null all round-trip distinctly', async () => {
  const rows = [
    makeRow(new Date('2022-01-03T03:45:00.000Z'), { openInterest: 500n }),
    makeRow(new Date('2022-01-03T03:46:00.000Z'), { openInterest: 0n }),
    makeRow(new Date('2022-01-03T03:47:00.000Z'), { openInterest: null }),
  ];
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].openInterest, '500');
  assert.equal(decoded[1].openInterest, '0');
  assert.equal(decoded[2].openInterest, null);
  assert.notEqual(decoded[1].openInterest, decoded[2].openInterest);
});

test('(K) OI null vs OI zero produce distinct session content checksums', () => {
  const nullCandle: ManifestCandleContent = { candleTime: '2022-01-03T03:45:00.000Z', open: '100', high: '100', low: '100', close: '100', volume: '1', openInterest: null };
  const zeroCandle: ManifestCandleContent = { ...nullCandle, openInterest: '0' };

  assert.notEqual(checksumOf([nullCandle]), checksumOf([zeroCandle]));
});

test('(L) first/last candle timestamps are exact after read-back', async () => {
  const rows = normalSessionRows('2022-01-03');
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].candleTime, candles[0].candleTime);
  assert.equal(decoded[decoded.length - 1].candleTime, candles[candles.length - 1].candleTime);
});

test('(M) stored/reconstructed candle instant is independent of host timezone (an IST-expressed instant round-trips to the identical UTC instant)', async () => {
  const istExpressed = new Date('2022-01-03T09:15:00+05:30'); // 03:45:00.000Z
  const rows = [makeRow(istExpressed)];
  const candles = rows.map(toManifestCandleContent);
  assert.equal(candles[0].candleTime, '2022-01-03T03:45:00.000Z');

  const buffer = encodeManifestCandlesToParquetBuffer(candles);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  assert.equal(decoded[0].candleTime, '2022-01-03T03:45:00.000Z');
  assert.equal(new Date(decoded[0].candleTime).getTime(), istExpressed.getTime());
});

test('(AJ) reader returns rows in deterministic ascending candleTime order regardless of write order', async () => {
  const rows = normalSessionRows('2022-01-03');
  const candles = rows.map(toManifestCandleContent);
  const shuffled = [...candles].reverse();
  const buffer = encodeManifestCandlesToParquetBuffer(shuffled);
  const decoded = await decodeParquetBufferToManifestCandles(buffer);

  for (let i = 1; i < decoded.length; i += 1) {
    assert.ok(decoded[i].candleTime > decoded[i - 1].candleTime);
  }
  assert.deepEqual(decoded, candles);
});

test('(9) every column chunk in the production-encoded Parquet buffer actually uses the SNAPPY codec, not merely a ".parquet"-named file with unverified compression', async () => {
  const rows = normalSessionRows('2022-01-03');
  const candles = rows.map(toManifestCandleContent);
  const buffer = encodeManifestCandlesToParquetBuffer(candles); // the exact production codec path (`encodeManifestCandlesToParquetBuffer`), not a hand-rolled writer call

  const metadata = await parquetMetadataAsync(buffer);
  const codecs = metadata.row_groups.flatMap((rowGroup) => rowGroup.columns.map((column) => column.meta_data?.codec));

  assert.ok(codecs.length > 0);
  for (const codec of codecs) {
    assert.equal(codec, 'SNAPPY');
  }
});

test('encode refuses an empty candle set', () => {
  assert.throws(() => encodeManifestCandlesToParquetBuffer([]), /empty/);
});

test('decode rejects a Parquet file with an unsupported schema (missing a required B-F6 column)', async () => {
  const wrongSchemaBuffer = parquetWriteBuffer({
    columnData: [
      { name: 'candleTime', data: [new Date()], type: 'TIMESTAMP', nullable: false },
      { name: 'open', data: ['100'], type: 'STRING', nullable: false },
    ],
  });

  await assert.rejects(() => decodeParquetBufferToManifestCandles(wrongSchemaBuffer), /Unsupported Parquet schema/);
});

test('decode rejects a Parquet file where a required column was made nullable', async () => {
  const wrongSchemaBuffer = parquetWriteBuffer({
    columnData: [
      { name: 'candleTime', data: [new Date()], type: 'TIMESTAMP', nullable: false },
      { name: 'open', data: ['100'], type: 'STRING', nullable: true },
      { name: 'high', data: ['100'], type: 'STRING', nullable: false },
      { name: 'low', data: ['100'], type: 'STRING', nullable: false },
      { name: 'close', data: ['100'], type: 'STRING', nullable: false },
      { name: 'volume', data: [1n], type: 'INT64', nullable: false },
      { name: 'openInterest', data: [1n], type: 'INT64', nullable: true },
    ],
  });

  await assert.rejects(() => decodeParquetBufferToManifestCandles(wrongSchemaBuffer), /Unsupported Parquet schema/);
});
