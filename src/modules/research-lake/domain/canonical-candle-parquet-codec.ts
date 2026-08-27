import { parquetMetadataAsync, parquetReadObjects, FileMetaData } from 'hyparquet';
import { parquetWriteBuffer, ColumnSource } from 'hyparquet-writer';
import { ManifestCandleContent, sortManifestCandles } from './dataset-manifest.types';
import { PersistedManifestCandleRow } from '../services/dataset-session-manifest-builder.service';
import { ParquetCompressionCodec } from './parquet-storage.types';

/**
 * Maps one already-persisted candle row to the SAME `ManifestCandleContent`
 * shape `DatasetSessionManifestBuilderService.build()` produces
 * (`dataset-session-manifest-builder.service.ts:117-125`) -- exact decimal
 * strings via `Prisma.Decimal#toString()`, exact `bigint#toString()`,
 * `null` preserved distinctly from `'0'`.
 *
 * Deliberately duplicated here (7 lines) rather than importing/reusing that
 * service's private mapping: `DatasetSessionManifestBuilderService` is B-F5,
 * out of scope to modify or export new surface from (task section 1: "B-F5
 * logical identity remains authoritative... B-F6 MUST NOT replace or
 * redefine"). This repo already documents the same deliberate-duplication
 * convention for small, stable mappings (see
 * `research-nifty-option-candle-acquisition.ts`'s `calendarWeekdays` doc).
 */
export function toManifestCandleContent(row: PersistedManifestCandleRow): ManifestCandleContent {
  return {
    candleTime: row.candleTime.toISOString(),
    open: row.open.toString(),
    high: row.high.toString(),
    low: row.low.toString(),
    close: row.close.toString(),
    volume: row.volume.toString(),
    openInterest: row.openInterest === null ? null : row.openInterest.toString(),
  };
}

/** Exact column set/order B-F6 Parquet session files use. Any file whose schema does not match this exactly is rejected fail-closed by `decodeParquetBufferToManifestCandles` (task section 17/20: "reader must reject unsupported storage-schema versions fail-closed"). */
export const PARQUET_CANDLE_COLUMNS = ['candleTime', 'open', 'high', 'low', 'close', 'volume', 'openInterest'] as const;

const REQUIRED_STRING_COLUMNS = ['open', 'high', 'low', 'close'] as const;

/**
 * Encodes one canonical session's candles as a compressed Parquet buffer.
 *
 * Physical type decisions (task section 3/4/5/9):
 *  - `candleTime`: Parquet `TIMESTAMP`/`TIMESTAMP_MILLIS` (INT64 milliseconds
 *    since the UTC epoch) -- a `Date` is already an absolute UTC instant, so
 *    this is timezone-independent by construction; proven exact by a manual
 *    round-trip check (see this module's test suite).
 *  - `open`/`high`/`low`/`close`: UTF-8 decimal STRING, NEVER a Parquet
 *    numeric type. `HistoricalCandle`/`HistoricalOptionCandle` persist these
 *    as MySQL `DECIMAL(65,30)` (`prisma/migrations/20260805102657_.../migration.sql:7-10`);
 *    Parquet's DECIMAL logical type is reliably supported by common writers
 *    only up to ~38 digits of precision, well short of 65. Rather than
 *    silently narrow to a lossy `DOUBLE` or risk an unproven high-precision
 *    DECIMAL encoding, this uses the exact same lossless canonical decimal
 *    string `ManifestCandleContent`/B-F5 already committed to (task section
 *    3: "Losslessness is more important than shaving a few bytes").
 *  - `volume`: Parquet INT64, written/read as a real JS `bigint` (verified:
 *    exact even for values beyond `Number.MAX_SAFE_INTEGER`).
 *  - `openInterest`: Parquet INT64, nullable. `null` round-trips as `null`,
 *    never coerced to `0` (verified).
 *
 * Rejects an empty `candles` array rather than writing a zero-row file: a
 * session with zero canonical rows is not a session B-F6 export policy ever
 * calls this with (see `research-lake-parquet-export.service.ts`'s health
 * gate), and some Parquet writers behave unpredictably when inferring a
 * schema from zero rows.
 */
export function encodeManifestCandlesToParquetBuffer(candles: readonly ManifestCandleContent[]): ArrayBuffer {
  if (candles.length === 0) {
    throw new Error('encodeManifestCandlesToParquetBuffer: refusing to encode an empty candle set -- a canonical session must have at least one row.');
  }
  const sorted = sortManifestCandles(candles);

  const columnData: ColumnSource[] = [
    { name: 'candleTime', data: sorted.map((c) => new Date(c.candleTime)), type: 'TIMESTAMP', nullable: false },
    { name: 'open', data: sorted.map((c) => c.open), type: 'STRING', nullable: false },
    { name: 'high', data: sorted.map((c) => c.high), type: 'STRING', nullable: false },
    { name: 'low', data: sorted.map((c) => c.low), type: 'STRING', nullable: false },
    { name: 'close', data: sorted.map((c) => c.close), type: 'STRING', nullable: false },
    { name: 'volume', data: sorted.map((c) => BigInt(c.volume)), type: 'INT64', nullable: false },
    { name: 'openInterest', data: sorted.map((c) => (c.openInterest === null ? null : BigInt(c.openInterest))), type: 'INT64', nullable: true },
  ];

  return parquetWriteBuffer({ columnData, codec: ParquetCompressionCodec.SNAPPY });
}

/**
 * Validates that `metadata`'s schema is EXACTLY the B-F6 candle schema this
 * module writes -- same column names, same order, same physical/converted
 * types, same nullability. Any deviation (missing column, reordered column,
 * widened/narrowed type, a required column made optional or vice versa)
 * fails closed (task section 17/20/22.R/22.S).
 */
export function assertSupportedParquetCandleSchema(metadata: FileMetaData): void {
  const root = metadata.schema[0];
  if (!root || root.num_children !== PARQUET_CANDLE_COLUMNS.length) {
    throw new Error(`Unsupported Parquet schema: expected ${PARQUET_CANDLE_COLUMNS.length} top-level columns, found ${root?.num_children ?? 'none'}.`);
  }
  const columns = metadata.schema.slice(1, 1 + PARQUET_CANDLE_COLUMNS.length);
  for (let index = 0; index < PARQUET_CANDLE_COLUMNS.length; index += 1) {
    const expectedName = PARQUET_CANDLE_COLUMNS[index];
    const element = columns[index];
    if (!element || element.name !== expectedName) {
      throw new Error(`Unsupported Parquet schema: expected column #${index} to be '${expectedName}', found '${element?.name ?? 'none'}'.`);
    }
    if (expectedName === 'candleTime') {
      if (element.type !== 'INT64' || (element.converted_type !== 'TIMESTAMP_MILLIS' && element.converted_type !== 'TIMESTAMP_MICROS')) {
        throw new Error(`Unsupported Parquet schema: 'candleTime' must be an INT64 timestamp, found type=${String(element.type)} converted_type=${String(element.converted_type)}.`);
      }
      assertRequired(element, expectedName);
    } else if ((REQUIRED_STRING_COLUMNS as readonly string[]).includes(expectedName)) {
      if (element.type !== 'BYTE_ARRAY' || element.converted_type !== 'UTF8') {
        throw new Error(`Unsupported Parquet schema: '${expectedName}' must be a UTF8 BYTE_ARRAY, found type=${String(element.type)} converted_type=${String(element.converted_type)}.`);
      }
      assertRequired(element, expectedName);
    } else if (expectedName === 'volume') {
      if (element.type !== 'INT64') {
        throw new Error(`Unsupported Parquet schema: 'volume' must be INT64, found type=${String(element.type)}.`);
      }
      assertRequired(element, expectedName);
    } else if (expectedName === 'openInterest') {
      if (element.type !== 'INT64') {
        throw new Error(`Unsupported Parquet schema: 'openInterest' must be INT64, found type=${String(element.type)}.`);
      }
      if (element.repetition_type !== 'OPTIONAL') {
        throw new Error(`Unsupported Parquet schema: 'openInterest' must be OPTIONAL (nullable), found repetition_type=${String(element.repetition_type)}.`);
      }
    }
  }
}

function assertRequired(element: { repetition_type?: string }, columnName: string): void {
  if (element.repetition_type !== 'REQUIRED') {
    throw new Error(`Unsupported Parquet schema: '${columnName}' must be REQUIRED (non-nullable), found repetition_type=${String(element.repetition_type)}.`);
  }
}

/**
 * Decodes a Parquet buffer back into `ManifestCandleContent[]`, in
 * deterministic ascending `candleTime` order (task section 14/22.AJ), after
 * validating the schema is exactly the one this module writes. Never
 * exposes hyparquet's raw row/column API to callers -- this is the ONLY
 * function outside this module that should ever call `parquetReadObjects`
 * for B-F6 candle data (task section 14: "keep the abstraction narrow").
 */
export async function decodeParquetBufferToManifestCandles(buffer: ArrayBuffer): Promise<ManifestCandleContent[]> {
  const metadata = await parquetMetadataAsync(buffer);
  assertSupportedParquetCandleSchema(metadata);

  const rows = await parquetReadObjects({ file: buffer });
  const candles: ManifestCandleContent[] = rows.map((row) => {
    const candleTime = row.candleTime as Date;
    const openInterest = row.openInterest as bigint | null;
    return {
      candleTime: candleTime.toISOString(),
      open: row.open as string,
      high: row.high as string,
      low: row.low as string,
      close: row.close as string,
      volume: (row.volume as bigint).toString(),
      openInterest: openInterest === null ? null : openInterest.toString(),
    };
  });
  return sortManifestCandles(candles);
}
