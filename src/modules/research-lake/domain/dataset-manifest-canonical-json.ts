import { createHash } from 'crypto';

/**
 * Deterministic canonical JSON serialization for dataset-manifest content
 * hashing (task B-F5). Deliberately a NEW, small, research-lake-scoped
 * primitive rather than a reuse of either existing canonical-JSON+SHA-256
 * pattern already in the repo:
 *
 *  - `strategyFingerprint`/`sortObject` (`research-validation/services/forward-validation.service.ts`)
 *    round-trips through a plain-object tree and `JSON.stringify`, which
 *    cannot represent `bigint` at all (`JSON.stringify` throws on a bare
 *    bigint) and silently mishandles `Date` (falls through to
 *    `Object.entries`, serializing it as `{}`). That function also backs the
 *    frozen V2/V4/V8 fingerprints -- it is not touched here.
 *  - `stableReplayJson`/`replayEventId` (`market-replay/market-replay-recorder.service.ts`)
 *    IS `Date`-safe but still not `bigint`-safe, and belongs to the live
 *    market-replay recording path (out of scope for research-lake work).
 *
 * Dataset-manifest content (candle `volume`/`openInterest`) is `bigint` by
 * domain contract (`CanonicalHistoricalCandle`), so a canonicalizer that
 * silently drops or throws on `bigint` cannot be used unmodified. Rather
 * than edit either protected/out-of-scope module, this file follows the
 * SAME established convention (SHA-256 digest over a deterministically
 * key-sorted JSON string) with `bigint` handled explicitly.
 *
 * Determinism guarantees:
 *  - object keys are sorted (`Array.prototype.sort`, ordinal/code-unit
 *    comparison -- never locale-dependent `localeCompare`)
 *  - array element order is preserved as given (callers sort arrays
 *    themselves before serializing, since element order is sometimes
 *    itself semantic content, e.g. candle order)
 *  - `bigint` serializes via `.toString()` (never through `JSON.stringify`,
 *    which throws on a bare bigint)
 *  - `Date` serializes via `.toISOString()` (UTC, host-timezone-independent)
 *  - `undefined` is never silently treated as `null` or dropped -- an
 *    `undefined` field or array element is a caller bug (manifest identity
 *    content must always use explicit `null` for "no value"), so this
 *    throws rather than silently producing a different hash than the
 *    caller expects.
 */
export function canonicalManifestJson(value: unknown): string {
  if (value === undefined) {
    throw new Error('canonicalManifestJson: undefined is not a valid manifest content value; use null for explicit absence.');
  }
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalManifestJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalManifestJson(source[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`canonicalManifestJson: non-finite number ${String(value)} is not valid manifest content.`);
  }
  return JSON.stringify(value);
}

/** SHA-256 hex digest of already-canonicalized content. UTF-8 input, no locale/host dependence. */
export function sha256Hex(canonicalContent: string): string {
  return createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
}
