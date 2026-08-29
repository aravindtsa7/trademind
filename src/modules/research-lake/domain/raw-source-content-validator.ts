import { PDFDocument } from 'pdf-lib';

/**
 * B-F7A-ARCHIVE-1 raw-byte content validation (task section 11; strengthened
 * to bounded structural checks under FIX-1 Defect D; strengthened AGAIN
 * under FIX-2 to require actual PDF PARSEABILITY, not just PDF-looking
 * framing -- Terra proved a body shaped like `%PDF-1.7 <padding> %%EOF`
 * with no real object graph/xref/catalog still passed the FIX-1 checks
 * unchanged (TRIVIAL_FAKE_ACCEPTED, HIGH severity: such bytes could be
 * hashed and archived as immutable "official evidence").
 *
 * This module now requires BOTH:
 *   (A) bounded outer-content checks (empty/size/HTML-sniff/header format/
 *       minimum length/trailing %%EOF) -- cheap, run first, reject obvious
 *       garbage before ever paying for a real parse; AND
 *   (B) a REAL PDF PARSE via `pdf-lib`'s `PDFDocument.load` -- the received
 *       bytes must form an actually loadable PDF document (a valid
 *       trailer/xref-derived object graph resolving to a Catalog with a
 *       non-empty Pages tree), not merely start with `%PDF-` and end with
 *       `%%EOF`.
 *
 * Guarantee, stated accurately (task section 3): this is BOUNDED
 * STRUCTURAL + PARSEABILITY VALIDATION. It does NOT prove full semantic/
 * document correctness (page content, fonts, embedded resources, business
 * meaning) -- only that the bytes are a real, loadable PDF document with at
 * least one page. Never inspects the `Content-Type` header.
 *
 * PARSER SELECTION (task section 5): `pdf-lib` (pure JavaScript/TypeScript,
 * no native bindings, no canvas/DOM/worker requirement, MIT-licensed,
 * widely maintained). Chosen over `pdfjs-dist` (browser/rendering-oriented,
 * heavier runtime footprint, historically needs DOM polyfills under Node
 * for anything beyond the most basic use) and over native-binding parsers
 * like `hummus`/`muhammara` (native compilation risk, no build precedent in
 * this repo's existing pure-JS/TS dependency set --
 * `hyparquet`/`hyparquet-writer`/`protobufjs` are all pure JS too). No
 * custom xref/object-stream parser was written -- `pdf-lib` already does
 * real trailer/xref/object-graph resolution reliably.
 *
 * NEVER used to write/repair/reserialize anything here: `PDFDocument.load`
 * is called ONLY to prove parseability; its result is inspected (page
 * count) and then discarded. `.save()` is never called anywhere in this
 * module. `bytes` itself is never mutated -- `pdf-lib` parses into a new,
 * separate in-memory object graph and does not write back into the input
 * buffer (verified empirically and by a dedicated regression test).
 *
 * STRICTNESS (task section 8): loaded with `throwOnInvalidObject: true` --
 * `pdf-lib`'s stricter, non-repair-tolerant mode, so an invalid object
 * encountered during parsing throws rather than being silently dropped.
 * `ignoreEncryption` is left at its default `false`: an encrypted PDF is
 * therefore rejected as unparseable by this validator rather than
 * force-loaded. No evidence was available that real NSE circulars are
 * encrypted (they are public, unauthenticated informational documents), so
 * this is treated as an honest, documented limitation rather than silently
 * working around it.
 */

export type RawSourceContentErrorCode =
  | 'EMPTY_BODY'
  | 'RESPONSE_TOO_LARGE'
  | 'NOT_A_PDF'
  | 'INVALID_PDF_HEADER'
  | 'BODY_TOO_SHORT'
  | 'MISSING_EOF_MARKER'
  | 'HTML_CHALLENGE_PAGE_DETECTED'
  | 'PDF_PARSE_FAILED'
  | 'PDF_ZERO_PAGES';

export class RawSourceContentValidationError extends Error {
  constructor(public readonly code: RawSourceContentErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceContentValidationError';
  }
}

/** Generous bound for a single NSE circular PDF -- large enough for any real circular, small enough to keep memory use bounded (task section 11: "Do not permit unbounded memory consumption"). Also bounds the real-parser's input size (task section 15: "Parser invocation happens only after body-size validation."). */
export const MAX_RAW_SOURCE_BYTES = 25 * 1024 * 1024;

/** Sane lower bound for a real circular PDF (task section 18: "sane minimum document length"). A header-only or near-empty payload can never be a real multi-page NSE circular. Deliberately small/conservative -- this rejects garbage, it does not attempt to estimate a "typical" circular size. */
export const MIN_RAW_PDF_BYTES = 128;

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
/** `%PDF-` followed by a single-digit major/minor version, e.g. `%PDF-1.4`, `%PDF-1.7`, `%PDF-2.0` (task section 18: "PDF header begins with valid `%PDF-x.y`"). */
const PDF_HEADER_PATTERN = /^%PDF-\d\.\d/;
/** How many trailing bytes are searched for the `%%EOF` structural marker. PDFs commonly end with `%%EOF` plus a small amount of trailing whitespace/newlines; a generous window tolerates that without accepting an arbitrarily-truncated document. */
const EOF_SNIFF_WINDOW_BYTES = 2048;
const EOF_MARKER = '%%eof';

/** How many leading bytes are inspected for an HTML/challenge-page signature. A real PDF's magic bytes are always in the first 5 bytes, so any HTML marker seen this early proves the body is not a PDF regardless of its declared Content-Type. */
const HTML_SNIFF_WINDOW_BYTES = 512;
const HTML_MARKERS: readonly string[] = ['<html', '<!doctype html', '<head', '<body', 'access denied', 'are you a human', 'captcha'];

/**
 * Fails closed on: an empty body, a body over `MAX_RAW_SOURCE_BYTES`, a body
 * whose leading bytes look like an HTML/challenge page, a body that does not
 * start with a well-formed `%PDF-x.y` header, a body under
 * `MIN_RAW_PDF_BYTES`, a body with no trailing `%%EOF` marker within the
 * last `EOF_SNIFF_WINDOW_BYTES` bytes, OR -- new in FIX-2 -- a body that a
 * real PDF parser cannot load, or that loads with zero pages. Never
 * inspects the `Content-Type` header. Never reserializes, repairs, or
 * otherwise mutates `bytes` -- this is a read-only validation pass over the
 * exact bytes that will later be hashed; the caller must hash the SAME
 * `bytes` reference passed in here, both before and after this call
 * succeeding, and get an identical digest either way.
 *
 * Now `async` (task section 14): `pdf-lib`'s `PDFDocument.load` is
 * Promise-based. The only production caller (`NseRawSourceHttpDownloaderService.download`)
 * was already `async` and now simply `await`s this call.
 */
export async function assertValidRawPdfBytes(bytes: Buffer): Promise<void> {
  if (bytes.length === 0) {
    throw new RawSourceContentValidationError('EMPTY_BODY', 'Response body is empty.');
  }
  if (bytes.length > MAX_RAW_SOURCE_BYTES) {
    throw new RawSourceContentValidationError('RESPONSE_TOO_LARGE', `Response body is ${bytes.length} bytes, exceeding the ${MAX_RAW_SOURCE_BYTES}-byte limit.`);
  }

  const sniffWindow = bytes.subarray(0, HTML_SNIFF_WINDOW_BYTES).toString('utf8').toLowerCase();
  for (const marker of HTML_MARKERS) {
    if (sniffWindow.includes(marker)) {
      throw new RawSourceContentValidationError('HTML_CHALLENGE_PAGE_DETECTED', `Response body looks like an HTML/challenge page (matched '${marker}'), not a PDF.`);
    }
  }

  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new RawSourceContentValidationError('NOT_A_PDF', `Response body does not start with the PDF magic bytes '%PDF-'.`);
  }
  const header = bytes.subarray(0, 16).toString('ascii');
  if (!PDF_HEADER_PATTERN.test(header)) {
    throw new RawSourceContentValidationError('INVALID_PDF_HEADER', `Response body starts with '%PDF-' but its header '${header}' is not a well-formed '%PDF-x.y' version string.`);
  }
  if (bytes.length < MIN_RAW_PDF_BYTES) {
    throw new RawSourceContentValidationError('BODY_TOO_SHORT', `Response body is ${bytes.length} bytes, under the ${MIN_RAW_PDF_BYTES}-byte minimum for a real PDF document.`);
  }

  const tailWindow = bytes.subarray(Math.max(0, bytes.length - EOF_SNIFF_WINDOW_BYTES)).toString('ascii').toLowerCase();
  if (!tailWindow.includes(EOF_MARKER)) {
    throw new RawSourceContentValidationError('MISSING_EOF_MARKER', `Response body has no '%%EOF' structural marker within its final ${EOF_SNIFF_WINDOW_BYTES} bytes.`);
  }

  // FIX-2: real parser load/parse (task section 6 steps 6-7). Everything
  // above this point is a cheap, pre-parser rejection of obvious garbage;
  // everything from here down is the actual parseability proof Terra's
  // fake needed to defeat. `bytes` (a Buffer, itself a Uint8Array) is
  // passed by reference -- pdf-lib parses it into a new object graph and
  // does not write back into it.
  //
  // `getPageCount()` MUST stay inside this same try/catch: `pdf-lib` can
  // return successfully from `PDFDocument.load` while deferring the actual
  // Root/Pages-tree resolution, so a document like Terra's fake (a %PDF-
  // header/%%EOF pair with no real object graph behind it) only throws
  // once `getPageCount()` walks that tree -- not during `load` itself.
  let pageCount: number;
  try {
    const pdfDoc = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false, ignoreEncryption: false });
    pageCount = pdfDoc.getPageCount();
  } catch (error) {
    throw new RawSourceContentValidationError(
      'PDF_PARSE_FAILED',
      `Response body has plausible PDF framing (header/%%EOF) but could not be loaded as a real PDF document: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`
    );
  }

  if (pageCount < 1) {
    throw new RawSourceContentValidationError('PDF_ZERO_PAGES', 'Response body parsed as a PDF document but reports zero pages; a real NSE circular must have at least one page.');
  }
}
