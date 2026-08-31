import { Prisma } from '@prisma/client';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

/**
 * B-F2C invariant 5/checksum-rules: stable content identity for one
 * HistoricalCandle logical row, independent of which representation
 * (domain `number`, `Prisma.Decimal`, or a plain numeric string) the
 * caller happens to hold OHLC in. `source` is deliberately EXCLUDED --
 * legacy rows may carry `source='REST'` while new B-F2C evidence
 * identifies the true provider (e.g. UPSTOX) separately, and `source` must
 * never make two otherwise-identical candles compare unequal (task
 * invariant 5/6/12).
 */
export const CANDLE_CONTENT_CHECKSUM_VERSION = 1;

export interface CandleContentValue {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly candleTime: Date;
  readonly open: number | string | Prisma.Decimal;
  readonly high: number | string | Prisma.Decimal;
  readonly low: number | string | Prisma.Decimal;
  readonly close: number | string | Prisma.Decimal;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
}

export interface CanonicalCandleContent {
  readonly version: number;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly candleTime: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly openInterest: string | null;
}

/**
 * Independent from (never imported from/into) `historical-candle.repository.ts`'s
 * `assertPlainDecimal`/`constructCanonicalDecimal` on purpose: this
 * milestone must not touch that repository file (task scope decision --
 * "Do NOT redesign the entire HistoricalCandleRepository"). Both places
 * canonicalize through the SAME underlying `Prisma.Decimal` (decimal.js)
 * library the installed Prisma runtime already depends on, so `100`
 * (`number`), `'100.00'` (`string`), and a `Prisma.Decimal` instance all
 * normalize to the identical canonical string here, exactly as they do
 * there -- this is reusing the one shared decimal library both files
 * already need, not duplicating a hashing algorithm.
 */
function canonicalDecimalString(field: string, value: number | string | Prisma.Decimal): string {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    throw new Error(`historical-candle-content-identity: value for '${field}' cannot be represented as a Prisma.Decimal (malformed decimal input).`);
  }
  if (!decimal.isFinite()) {
    throw new Error(`historical-candle-content-identity: non-finite value for '${field}' (NaN/Infinity is not a valid decimal quantity).`);
  }
  return decimal.toFixed();
}

export function canonicalizeCandleContent(candle: CandleContentValue): CanonicalCandleContent {
  return {
    version: CANDLE_CONTENT_CHECKSUM_VERSION,
    instrumentKey: candle.instrumentKey,
    timeframe: candle.timeframe,
    candleTime: candle.candleTime.toISOString(),
    open: canonicalDecimalString('open', candle.open),
    high: canonicalDecimalString('high', candle.high),
    low: canonicalDecimalString('low', candle.low),
    close: canonicalDecimalString('close', candle.close),
    volume: candle.volume.toString(),
    openInterest: candle.openInterest === null ? null : candle.openInterest.toString(),
  };
}

/** SHA-256 over the canonicalized content -- reuses the existing dataset-manifest canonical-JSON/SHA-256 primitives rather than a new ad-hoc hasher. */
export function computeCandleContentChecksum(candle: CandleContentValue): string {
  return sha256Hex(canonicalManifestJson(canonicalizeCandleContent(candle)));
}

/**
 * Semantic equality per task invariant 5: instrumentKey/timeframe/candleTime/
 * OHLC/volume/openInterest only -- `source` is never compared. Equivalent
 * Decimal representations (a `number`, a differently-formatted numeric
 * string, or a `Prisma.Decimal`) that denote the SAME quantity compare
 * equal, since both sides are canonicalized through the identical
 * `Prisma.Decimal.toFixed()` path before comparison.
 */
export function candleContentEquals(existing: CandleContentValue, incoming: CandleContentValue): boolean {
  return computeCandleContentChecksum(existing) === computeCandleContentChecksum(incoming);
}

/**
 * Deterministic evidence checksum over one session's ACCEPTED canonical
 * candle set (post-projection/validation, pre-persistence) -- sorted by
 * `candleTime` so input order never perturbs it. Distinct from
 * `computeSourceRowsSemanticChecksum` (which hashes the RAW provider
 * delivery, including its order/`sourceIndex`): this hashes what
 * canonicalization decided was acceptable, independent of how the
 * provider originally delivered it.
 */
export function computeCanonicalCandleSetChecksum(candles: readonly CandleContentValue[]): string {
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  return sha256Hex(canonicalManifestJson({ version: CANDLE_CONTENT_CHECKSUM_VERSION, candles: sorted.map((candle) => canonicalizeCandleContent(candle)) }));
}
