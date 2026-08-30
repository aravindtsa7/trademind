/**
 * B-F7A-ARCHIVE-1 RUNTIME retrieval receipt (task section 7/13). Deliberately
 * separate from `ReviewedRawSourceManifestEntry` -- a receipt records what
 * actually happened on ONE archive attempt (raw hash, byte count, HTTP
 * response metadata, wall-clock retrieval time), never reviewed authority
 * metadata. Mixing the two would make the reviewed static manifest
 * nondeterministic (task section 13/17 test 31).
 *
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect A): TWO independently auditable
 * byte identities now exist per receipt:
 *
 *   LAYER A -- TRANSPORT (`rawSha256`/`byteLength`/`archiveRelativePath`,
 *   fields UNCHANGED in name and meaning): the EXACT HTTP response bytes,
 *   always. For a direct-PDF source this already equals the authoritative
 *   document. For a ZIP-wrapped source it is the ZIP envelope itself.
 *
 *   LAYER B -- DOCUMENT (`documentEvidence`, new, nullable): present ONLY
 *   when the transport response was a ZIP envelope that had to be unwrapped
 *   -- the extracted, reference-bound PDF's own byte identity, stored as a
 *   SEPARATE content-addressed blob. `null` means "the document IS the raw
 *   transport bytes" (the common, direct-PDF case) -- this is what avoids
 *   duplicating physical storage for the ~20 sources that were never
 *   wrapped in anything (task section 4: "should not require duplicated
 *   physical blobs merely to represent both layers if transport and
 *   document bytes are identical").
 *
 * `authoritativeDocumentIdentity` is the single place that resolves "which
 * bytes does the calendar fixture's contentChecksumSha256 actually mean" --
 * every caller that needs the DOCUMENT's own identity (never the transport
 * envelope's) must go through it rather than reaching for `rawSha256`
 * directly, so the ambiguity Terra found can never silently reappear.
 */
export interface RawSourceDocumentEvidence {
  readonly documentSha256: string;
  readonly documentByteLength: number;
  readonly documentArchiveRelativePath: string;
  /** The exact ZIP central-directory member name that was extracted (task section 15: proven, never positional/fuzzy). */
  readonly documentMemberName: string;
  /** Always `'application/pdf'` today -- kept as an explicit field (rather than a hardcoded literal at every call site) because the domain model already tracks media type elsewhere (raw `contentType`) and a single unlabeled assumption is exactly the kind of ambiguity this fix removes. */
  readonly documentMediaType: string;
}

/**
 * Audit trail for the ONE-TIME, narrowly-scoped legacy-receipt repair
 * (task section 6/7/8): present ONLY on a receipt that was upgraded from
 * the pre-fix "extracted-PDF-bytes recorded as if they were the raw
 * transport identity" shape. `null` on every receipt that was never
 * affected. This is deliberately a bounded, typed, write-once-by-the-repair-
 * function marker -- NOT a generic mutable "edit history" API (task section
 * 8: "Do not build a generic mutable 'edit receipt' API").
 */
export interface RawSourceReceiptRepairAudit {
  readonly repairedFromLegacyRawSha256: string;
  readonly repairedFromArchiveRelativePath: string;
  readonly repairedAt: string;
  readonly reason: string;
}

export interface RawSourceRetrievalReceipt {
  readonly reference: string;
  readonly requestedUrl: string;
  readonly resolvedFinalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** LAYER A / TRANSPORT: the exact HTTP response bytes' own SHA-256. Never redefined to mean anything else (Terra Defect A). */
  readonly rawSha256: string;
  /** LAYER A / TRANSPORT byte length -- always `bytes.length` of the exact HTTP response body. */
  readonly byteLength: number;
  /** Wall-clock retrieval time -- observability only, never part of any content identity. */
  readonly retrievedAt: string;
  /** LAYER A / TRANSPORT blob locator (content-addressed by `rawSha256`). */
  readonly archiveRelativePath: string;
  /** LAYER B / DOCUMENT evidence, or `null` when the document IS the raw transport bytes (see file doc comment). */
  readonly documentEvidence: RawSourceDocumentEvidence | null;
  /** Non-null only for a receipt produced by the legacy-shape repair path (task section 6-8). */
  readonly repairedFrom: RawSourceReceiptRepairAudit | null;
}

/** The authoritative DOCUMENT's own identity -- what a calendar fixture's `contentChecksumSha256` must equal. Never `receipt.rawSha256` directly when a document layer exists (task section 3/35: "prove it does NOT equal transport hash unless by astronomical coincidence"). */
export function authoritativeDocumentIdentity(receipt: RawSourceRetrievalReceipt): { readonly sha256: string; readonly byteLength: number; readonly archiveRelativePath: string } {
  if (receipt.documentEvidence !== null) {
    return {
      sha256: receipt.documentEvidence.documentSha256,
      byteLength: receipt.documentEvidence.documentByteLength,
      archiveRelativePath: receipt.documentEvidence.documentArchiveRelativePath,
    };
  }
  return { sha256: receipt.rawSha256, byteLength: receipt.byteLength, archiveRelativePath: receipt.archiveRelativePath };
}

/** Reference -> most-recently-accepted receipt for it. Persisted as a single JSON index file by `nse-raw-source-archiver.service.ts` (never a database row -- task section 16). */
export type RawSourceReceiptIndex = Readonly<Record<string, RawSourceRetrievalReceipt>>;

/**
 * Mandatory safety invariant (task section 10): the SAME `reference`
 * retrieved with a DIFFERENT raw (TRANSPORT-layer) SHA-256 than a prior
 * accepted receipt is a hard conflict, never a silent overwrite. This is
 * exactly what makes "same PDF, different ZIP envelope" (B-F7A-SOURCE-
 * EVIDENCE-FIX-1 task section 9 Case B / section 28) observable as
 * transport drift rather than collapsing into ordinary idempotency --
 * `newSha256` here is ALWAYS the freshly retrieved TRANSPORT bytes' hash,
 * never the document layer's. Carries both the existing and the newly
 * observed evidence so a human reviewer has everything needed to decide
 * what happened upstream.
 */
export class RawSourceContentChangedError extends Error {
  constructor(
    public readonly reference: string,
    public readonly existingReceipt: RawSourceRetrievalReceipt,
    public readonly newSha256: string,
    public readonly newRetrievalMetadata: Pick<RawSourceRetrievalReceipt, 'requestedUrl' | 'resolvedFinalUrl' | 'httpStatus' | 'byteLength' | 'retrievedAt'>
  ) {
    super(
      `SOURCE_CONTENT_CHANGED for '${reference}': existing accepted transport hash '${existingReceipt.rawSha256}' (retrieved ${existingReceipt.retrievedAt}) does not match newly retrieved transport hash '${newSha256}' (retrieved ${newRetrievalMetadata.retrievedAt}). Refusing to overwrite prior evidence -- this requires human/source review.`
    );
    this.name = 'RawSourceContentChangedError';
  }
}

/**
 * Case C (task section 9/29): the TRANSPORT layer matched (same raw bytes),
 * but the AUTHORITATIVE DOCUMENT identity re-derived from those bytes does
 * not match what the existing receipt's `documentEvidence` records. Under
 * normal, correct operation this can only happen if extraction is somehow
 * non-deterministic or an existing receipt's document evidence was itself
 * wrong -- either way, this is a hard, fail-closed conflict, never a
 * silent document-blob replacement (task section 29: "No document
 * replacement.").
 */
export class RawSourceDocumentContentChangedError extends Error {
  constructor(
    public readonly reference: string,
    public readonly existingDocumentSha256: string,
    public readonly newDocumentSha256: string
  ) {
    super(
      `DOCUMENT_CONTENT_CHANGED for '${reference}': transport bytes matched the existing accepted receipt, but the re-derived authoritative document hash '${newDocumentSha256}' does not match the existing document hash '${existingDocumentSha256}'. Refusing to replace document evidence -- this requires human/source review.`
    );
    this.name = 'RawSourceDocumentContentChangedError';
  }
}

/**
 * Task section 6/7: a hard conflict raised ONLY by the legacy-zip-receipt
 * repair path, when the freshly re-extracted document hash does not match
 * the document hash the legacy (pre-fix) receipt had recorded under its
 * (mislabeled) `rawSha256`. Neither evidence stream is touched when this is
 * thrown (task section 7: "Do NOT destroy either evidence stream.").
 */
export class RawSourceLegacyReceiptRepairMismatchError extends Error {
  constructor(
    public readonly reference: string,
    public readonly legacyDocumentSha256: string,
    public readonly reacquiredDocumentSha256: string
  ) {
    super(
      `LEGACY_DOCUMENT_MISMATCH for '${reference}': the legacy pre-fix receipt's recorded document hash '${legacyDocumentSha256}' does not match the document hash '${reacquiredDocumentSha256}' freshly extracted from a live reacquisition of the same official URL. Refusing to repair -- this requires human/source review. Neither the legacy nor the newly reacquired evidence was modified.`
    );
    this.name = 'RawSourceLegacyReceiptRepairMismatchError';
  }
}

/**
 * Task section 6: narrowly, structurally recognizes the EXACT pre-fix
 * "extracted-PDF-bytes recorded as if they were the raw transport identity"
 * shape -- recognized by INVARIANT, never by hardcoded reference number. A
 * receipt matches iff it carries NO document-layer evidence (this
 * repository could not yet tell the two layers apart when it was written)
 * AND its own requested/resolved URL indicates the document was actually
 * served from a `.zip` envelope (so `rawSha256` cannot possibly be the
 * exact-HTTP-response-bytes hash the field is supposed to mean). Every
 * other receipt -- any genuine direct-PDF source, or any receipt already
 * carrying real document evidence from this fix onward -- never matches,
 * so this predicate cannot misfire against correct evidence.
 */
export function isLegacyZipDerivedReceipt(receipt: RawSourceRetrievalReceipt): boolean {
  if (receipt.documentEvidence !== null) return false;
  return receipt.requestedUrl.toLowerCase().endsWith('.zip') || receipt.resolvedFinalUrl.toLowerCase().endsWith('.zip');
}

export type RawSourceReceiptReconciliation =
  | { readonly outcome: 'NEW' }
  | { readonly outcome: 'IDEMPOTENT_MATCH'; readonly existingReceipt: RawSourceRetrievalReceipt };

/**
 * Pure decision function (task section 10/17 tests 17-18) operating
 * EXCLUSIVELY on the TRANSPORT layer: given the existing receipt index and
 * a freshly computed TRANSPORT hash for `reference`, decides whether this
 * is a brand-new reference, an idempotent re-archive of already-accepted
 * transport bytes, or a hard `SOURCE_CONTENT_CHANGED` conflict. Has no I/O
 * of its own so it is testable without touching the filesystem/network;
 * `nse-raw-source-archiver.service.ts` is the only caller that combines
 * this with real storage AND the separate document-layer reconciliation
 * (`RawSourceDocumentContentChangedError`) it must also apply on top.
 */
export function reconcileReceiptForArchive(
  reference: string,
  newRawSha256: string,
  existingIndex: RawSourceReceiptIndex,
  newRetrievalMetadata: Pick<RawSourceRetrievalReceipt, 'requestedUrl' | 'resolvedFinalUrl' | 'httpStatus' | 'byteLength' | 'retrievedAt'>
): RawSourceReceiptReconciliation {
  const existingReceipt = existingIndex[reference];
  if (existingReceipt === undefined) return { outcome: 'NEW' };
  if (existingReceipt.rawSha256 === newRawSha256) return { outcome: 'IDEMPOTENT_MATCH', existingReceipt };
  throw new RawSourceContentChangedError(reference, existingReceipt, newRawSha256, newRetrievalMetadata);
}
