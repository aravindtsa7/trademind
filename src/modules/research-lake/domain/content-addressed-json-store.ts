import { isAbsolute, relative, resolve, sep } from 'path';
import { cleanupTempFile, fileExists, publishVerifiedTempFile, readFileBuffer, writeBufferToTempFile } from './atomic-file-writer';

/**
 * B-M7.1: small, generic content-addressed JSON storage primitive, modeled
 * directly on the EXISTING B-F7A `raw-source-archive-storage.ts` convention
 * (temp-write via the shared `atomic-file-writer` trio, then atomic rename;
 * an existing path is re-verified, never blindly overwritten) -- but for
 * SEMANTIC-content-checksummed JSON (a `canonicalManifestJson`/`sha256Hex`
 * digest over structured content) rather than a raw-byte SHA-256 over an
 * opaque PDF/ZIP blob. Reused by BOTH `ObservedIncompleteSessionSnapshotV1`
 * and `DerivedImputedResearchSessionV1` storage so neither duplicates this
 * write-once/verify-on-conflict logic.
 *
 * B-M7.1-MEDIUM-01 CORRECTION (post-Terra-review): a caller-supplied `subdir`
 * (e.g. `'../something'`) previously flowed straight into `path.join(root,
 * ...)` with no containment check, so a malicious/mistaken subdir could
 * resolve OUTSIDE the configured artifact root. Every entry point below now
 * resolves `root`/`subdir`/the final `<checksum>.json` path via
 * `resolveArtifactFilePath`, which proves containment using
 * FULLY-RESOLVED-ABSOLUTE-PATH `path.relative` comparisons -- NEVER a
 * fragile string-prefix check (`candidate.startsWith(root)`), which
 * `C:\foo-bar` string-prefix-matching `C:\foo` demonstrates is unsafe. This
 * module's B-M7.1 callers only ever pass fixed, safe subdir constants, but
 * this is a newly-introduced GENERIC storage primitive, so containment is
 * enforced here rather than trusted to every future caller.
 */

const HEX64_PATTERN = /^[a-f0-9]{64}$/;

export type ContentAddressedJsonStoreErrorCode = 'INVALID_CHECKSUM' | 'INVALID_SUBDIR' | 'EXISTING_CONTENT_CORRUPTED' | 'CONTENT_NOT_FOUND';

export class ContentAddressedJsonStoreError extends Error {
  constructor(public readonly code: ContentAddressedJsonStoreErrorCode, message: string) {
    super(message);
    this.name = 'ContentAddressedJsonStoreError';
  }
}

/** Cheap, root-independent shape check: `subdir` must be a non-empty, relative path. Full escape-after-normalization containment (which DOES require a root) is proven separately by `resolveArtifactFilePath`. */
function assertRelativeSubdirShape(subdir: string): void {
  if (typeof subdir !== 'string' || subdir.length === 0) {
    throw new ContentAddressedJsonStoreError('INVALID_SUBDIR', `subdir must be a non-empty relative directory path; received ${JSON.stringify(subdir)}.`);
  }
  if (isAbsolute(subdir)) {
    throw new ContentAddressedJsonStoreError('INVALID_SUBDIR', `subdir must be a relative path, never absolute; received '${subdir}'.`);
  }
}

/** Content-addressed, root-relative locator for one JSON document. Always forward-slash, matching `rawSourceBlobRelativePath`'s host-independence convention. Validates `subdir`'s cheap shape (see `assertRelativeSubdirShape`) but NOT full root-containment -- this function has no root to resolve against; callers that have a real root use `resolveArtifactFilePath` for that. */
export function contentAddressedJsonRelativePath(subdir: string, checksum: string): string {
  assertRelativeSubdirShape(subdir);
  if (!HEX64_PATTERN.test(checksum)) {
    throw new ContentAddressedJsonStoreError('INVALID_CHECKSUM', `'${checksum}' is not a lowercase 64-character hex SHA-256 digest.`);
  }
  return `${subdir}/${checksum}.json`;
}

/**
 * Proves `candidateAbsolutePath` resolves strictly BENEATH `resolvedRoot`
 * (both already-resolved absolute paths) via `path.relative` -- never a
 * `startsWith` string check. A relative result of `''` (candidate resolves
 * to the root itself), `'..'`, anything starting with `'..' + path.sep`, or
 * an absolute relative result (a different drive on Windows) all mean "not
 * strictly contained" -- fails closed. A path that syntactically contains
 * `'..'` but still resolves inside root after normalization (e.g.
 * `'safe/nested/../other'` -> `'safe/other'`) is allowed -- this checks the
 * RESOLVED result, exactly like the real filesystem would, never the raw
 * string.
 */
function assertStrictlyContained(resolvedRoot: string, candidateAbsolutePath: string, label: string): void {
  const relativeToRoot = relative(resolvedRoot, candidateAbsolutePath);
  const escapesOrIsRootItself = relativeToRoot === '' || relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot);
  if (escapesOrIsRootItself) {
    throw new ContentAddressedJsonStoreError(
      'INVALID_SUBDIR',
      `${label} '${candidateAbsolutePath}' must resolve to a path strictly beneath artifact root '${resolvedRoot}' (never the root itself, and never outside it).`
    );
  }
}

interface ResolvedArtifactFilePath {
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * B-M7.1-MEDIUM-01: the single choke point every store/read entry point
 * below goes through. Resolves and validates in three steps (never trusts
 * any one alone): (1) the subdir alone must resolve to a genuine directory
 * strictly beneath `root` (rejects `'.'`/`''`/`'..'`/an escaping relative
 * path/an absolute path); (2) the final `<subdir>/<checksum>.json` relative
 * path is constructed only from that already-validated subdir; (3) the
 * fully-resolved final file path is independently RE-verified against
 * `root` as a defensive final check, even though the checksum segment
 * itself cannot introduce traversal (`HEX64_PATTERN` admits no `/`, `.`, or
 * path separator).
 */
function resolveArtifactFilePath(root: string, subdir: string, checksum: string): ResolvedArtifactFilePath {
  assertRelativeSubdirShape(subdir);
  const resolvedRoot = resolve(root);

  const candidateDir = resolve(resolvedRoot, subdir);
  assertStrictlyContained(resolvedRoot, candidateDir, 'subdir');

  const relativePath = contentAddressedJsonRelativePath(subdir, checksum);
  const absolutePath = resolve(resolvedRoot, relativePath);
  assertStrictlyContained(resolvedRoot, absolutePath, 'resolved artifact path');

  return { relativePath, absolutePath };
}

export interface ContentAddressedJsonStoreResult {
  readonly relativePath: string;
  readonly absolutePath: string;
  /** `false` when content already existed at this content-addressed path and verified as an idempotent match. */
  readonly wasNewlyWritten: boolean;
}

/**
 * Atomically stores `content` at the content-addressed path for `checksum`,
 * strictly beneath `root` (B-M7.1-MEDIUM-01: `subdir` can never escape
 * `root` -- see `resolveArtifactFilePath`). `checksum` MUST already equal
 * `recomputeChecksum(content)` -- callers compute it once (via their own
 * domain checksum function) and pass it in, mirroring `storeRawSourceBlob`'s
 * "caller proves the digest, this function never re-derives it independently
 * for the NEW-write path" contract.
 *
 * If a document already exists at the target path, it is read back, parsed,
 * and RE-HASHED via the caller-supplied `recomputeChecksum` -- proving the
 * on-disk content is still self-consistent with its own content-addressed
 * name, never merely trusting a `checksum`-shaped field inside the stored
 * JSON. A mismatch is a hard failure (corruption, a partial prior write that
 * somehow reached the final path, or manual tampering) -- NEVER silently
 * overwritten, exactly like `storeRawSourceBlob`.
 */
export function storeContentAddressedJson<T>(
  root: string,
  subdir: string,
  checksum: string,
  content: T,
  recomputeChecksum: (parsed: T) => string
): ContentAddressedJsonStoreResult {
  const { relativePath, absolutePath } = resolveArtifactFilePath(root, subdir, checksum);

  if (fileExists(absolutePath)) {
    const existing = JSON.parse(readFileBuffer(absolutePath).toString('utf8')) as T;
    const existingChecksum = recomputeChecksum(existing);
    if (existingChecksum !== checksum) {
      throw new ContentAddressedJsonStoreError(
        'EXISTING_CONTENT_CORRUPTED',
        `Existing content at '${absolutePath}' re-hashes to '${existingChecksum}', not its own content-addressed name '${checksum}'. Refusing to overwrite.`
      );
    }
    return { relativePath, absolutePath, wasNewlyWritten: false };
  }

  const buffer = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
  const temporaryPath = writeBufferToTempFile(absolutePath, buffer);
  try {
    publishVerifiedTempFile(temporaryPath, absolutePath);
  } catch (error) {
    cleanupTempFile(temporaryPath);
    throw error;
  }
  return { relativePath, absolutePath, wasNewlyWritten: true };
}

/** Reads back and JSON-parses a document at its content-addressed path, strictly beneath `root` (B-M7.1-MEDIUM-01). Does NOT re-verify the checksum itself -- callers that need that guarantee call `recomputeChecksum` on the result themselves (mirrors `storeContentAddressedJson`'s own verification, kept as an explicit caller step here rather than a hidden one, since not every read needs re-verification). */
export function readContentAddressedJson<T>(root: string, subdir: string, checksum: string): T {
  const { absolutePath } = resolveArtifactFilePath(root, subdir, checksum);
  if (!fileExists(absolutePath)) {
    throw new ContentAddressedJsonStoreError('CONTENT_NOT_FOUND', `No content exists at '${absolutePath}'.`);
  }
  return JSON.parse(readFileBuffer(absolutePath).toString('utf8')) as T;
}
