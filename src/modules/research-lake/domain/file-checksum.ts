import { createHash } from 'crypto';

/**
 * SHA-256 hex digest of exact file/buffer BYTES -- proves PHYSICAL byte
 * identity (task section 8), structurally distinct from
 * `sha256Hex`/`canonicalManifestJson` in `dataset-manifest-canonical-json.ts`,
 * which hash a deterministic JSON *string* representation of structured
 * content, never raw bytes. No existing repo utility hashes raw file bytes
 * (every other `createHash('sha256')` call site hashes a JSON-serialized
 * value) -- this is a new, minimal, B-F6-scoped primitive rather than a
 * repurposed JSON-content hasher.
 *
 * Whole-buffer (not streamed): a single canonical trading session's Parquet
 * file is small (one session's candles, SNAPPY-compressed), so loading it
 * fully into memory to hash is within the repo's own "session-level bounded
 * processing is sufficient" convention (task section 25) -- no multi-year
 * file is ever hashed this way.
 */
export function sha256HexOfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
