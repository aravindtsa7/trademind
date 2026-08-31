import { HistoricalSourceCandleRow } from './canonical-historical-candle';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

/**
 * B-F2C invariant 3: `HistoricalDataProvider` returns already-parsed/
 * normalized `HistoricalSourceCandleRow[]`, never exact HTTP response
 * bytes -- so this is deliberately NOT named/documented as hashing a raw
 * HTTP body ("rawResponseSha256" would be a false claim). This checksum is
 * computed over the exact `HistoricalSourceCandleRow` semantics available
 * at the Research Lake provider boundary: `sourceIndex` is included (never
 * sorted away) so the checksum also captures the provider's own delivery
 * ORDER -- a source-order anomaly (task `CanonicalSourceOrderAnomaly`)
 * changes this checksum even when the same set of rows is present, which
 * is exactly the "provider content drift" this exists to detect.
 */
export const SOURCE_ROWS_CHECKSUM_VERSION = 1;

interface CanonicalSourceRow {
  readonly sourceIndex: number;
  readonly candleTime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: string;
  readonly openInterest: string | null;
}

interface CanonicalSourceRowsPayload {
  readonly version: number;
  readonly rows: readonly CanonicalSourceRow[];
}

/** Deliberately preserves the given array order (the provider's own delivery order) -- never sorted -- see doc above. */
export function canonicalizeSourceRows(rows: readonly HistoricalSourceCandleRow[]): CanonicalSourceRowsPayload {
  return {
    version: SOURCE_ROWS_CHECKSUM_VERSION,
    rows: rows.map((row) => ({
      sourceIndex: row.sourceIndex,
      candleTime: row.candleTime.toISOString(),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume.toString(),
      openInterest: row.openInterest === null ? null : row.openInterest.toString(),
    })),
  };
}

/**
 * Truthfully named per task invariant 3 -- never `rawResponseSha256`.
 * Deterministic and explicitly versioned; contains no retrieval ID,
 * `retrievedAt`, random UUID, machine path, or secret of any kind.
 */
export function computeSourceRowsSemanticChecksum(rows: readonly HistoricalSourceCandleRow[]): string {
  return sha256Hex(canonicalManifestJson(canonicalizeSourceRows(rows)));
}
