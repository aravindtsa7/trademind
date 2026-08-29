/**
 * B-F7A-ARCHIVE-1 RUNTIME retrieval receipt (task section 7/13). Deliberately
 * separate from `ReviewedRawSourceManifestEntry` -- a receipt records what
 * actually happened on ONE archive attempt (raw hash, byte count, HTTP
 * response metadata, wall-clock retrieval time), never reviewed authority
 * metadata. Mixing the two would make the reviewed static manifest
 * nondeterministic (task section 13/17 test 31).
 */
export interface RawSourceRetrievalReceipt {
  readonly reference: string;
  readonly requestedUrl: string;
  readonly resolvedFinalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly rawSha256: string;
  readonly byteLength: number;
  /** Wall-clock retrieval time -- observability only, never part of any content identity. */
  readonly retrievedAt: string;
  readonly archiveRelativePath: string;
}

/** Reference -> most-recently-accepted receipt for it. Persisted as a single JSON index file by `nse-raw-source-archiver.service.ts` (never a database row -- task section 16). */
export type RawSourceReceiptIndex = Readonly<Record<string, RawSourceRetrievalReceipt>>;

/**
 * Mandatory safety invariant (task section 10): the SAME `reference`
 * retrieved with a DIFFERENT raw SHA-256 than a prior accepted receipt is a
 * hard conflict, never a silent overwrite. Carries both the existing and the
 * newly observed evidence so a human reviewer has everything needed to
 * decide what happened upstream.
 */
export class RawSourceContentChangedError extends Error {
  constructor(
    public readonly reference: string,
    public readonly existingReceipt: RawSourceRetrievalReceipt,
    public readonly newSha256: string,
    public readonly newRetrievalMetadata: Pick<RawSourceRetrievalReceipt, 'requestedUrl' | 'resolvedFinalUrl' | 'httpStatus' | 'byteLength' | 'retrievedAt'>
  ) {
    super(
      `SOURCE_CONTENT_CHANGED for '${reference}': existing accepted hash '${existingReceipt.rawSha256}' (retrieved ${existingReceipt.retrievedAt}) does not match newly retrieved hash '${newSha256}' (retrieved ${newRetrievalMetadata.retrievedAt}). Refusing to overwrite prior evidence -- this requires human/source review.`
    );
    this.name = 'RawSourceContentChangedError';
  }
}

export type RawSourceReceiptReconciliation =
  | { readonly outcome: 'NEW' }
  | { readonly outcome: 'IDEMPOTENT_MATCH'; readonly existingReceipt: RawSourceRetrievalReceipt };

/**
 * Pure decision function (task section 10/17 tests 17-18): given the
 * existing receipt index and a freshly computed hash for `reference`,
 * decides whether this is a brand-new reference, an idempotent re-archive of
 * already-accepted bytes, or a hard `SOURCE_CONTENT_CHANGED` conflict. Has no
 * I/O of its own so it is testable without touching the filesystem/network;
 * `nse-raw-source-archiver.service.ts` is the only caller that combines this
 * with real storage.
 */
export function reconcileReceiptForArchive(
  reference: string,
  newSha256: string,
  existingIndex: RawSourceReceiptIndex,
  newRetrievalMetadata: Pick<RawSourceRetrievalReceipt, 'requestedUrl' | 'resolvedFinalUrl' | 'httpStatus' | 'byteLength' | 'retrievedAt'>
): RawSourceReceiptReconciliation {
  const existingReceipt = existingIndex[reference];
  if (existingReceipt === undefined) return { outcome: 'NEW' };
  if (existingReceipt.rawSha256 === newSha256) return { outcome: 'IDEMPOTENT_MATCH', existingReceipt };
  throw new RawSourceContentChangedError(reference, existingReceipt, newSha256, newRetrievalMetadata);
}
