/**
 * B-F7A-ARCHIVE-1-FIX-1 Defect E correction (task section 20). Proves that a
 * manifest entry's declared `reference` and its reviewed `sourceUrl`
 * actually agree, so a reviewer/typo error (e.g. `NSE/MSD/60340` bound to
 * `.../MSD60318.pdf`) is rejected even though both strings independently
 * look valid and the URL is on an approved host.
 *
 * The binding rule itself was supplied directly by the task instructions
 * (not independently discovered/guessed by this implementation): for a
 * reference `NSE/<DEPT>/<NUMBER>`, the expected official basename is
 * `<DEPT><NUMBER>.pdf` under the approved circulars path
 * (`raw-source-url-policy.ts`'s `APPROVED_RAW_SOURCE_HOSTS` /
 * `APPROVED_RAW_SOURCE_PATH_PREFIX`). This module does NOT perform new NSE
 * source discovery -- it only checks that an already-declared reference and
 * an already-declared URL are mutually consistent under that rule.
 *
 * B-F7A-SOURCE-EVIDENCE-1 (task section 4/37): live retrieval proved that a
 * small number of official NSE circulars (confirmed for `NSE/CMTR/57285` and
 * `NSE/CMTR/60338` via NSE's own official circular-search API and by
 * inspecting the archive contents) are published at their approved path as a
 * `.zip` bundle -- the circular PDF plus government-notification annexures
 * -- rather than as a bare PDF. `<DEPT><NUMBER>.zip` is therefore also
 * accepted as a bound basename (still an EXACT match on the same
 * `<DEPT><NUMBER>` stem, never a fuzzy one); `raw-source-zip-envelope.util.ts`
 * is what actually unwraps that envelope and proves the embedded PDF member
 * name against this same rule before any byte is hashed/stored.
 *
 * B-F7A-SOURCE-EVIDENCE-FIX-1 (Terra Defect C correction): binding used to
 * compare only the URL's FINAL path segment against the expected basename,
 * which meant `https://nsearchives.nseindia.com/content/circulars/foo/CMTR57285.zip`
 * (an extra, unapproved intermediate directory) was wrongly accepted --
 * the generic host/path policy (`raw-source-url-policy.ts`) intentionally
 * accepts any path under `/content/circulars/`, but a REVIEWED circular
 * manifest binding is held to a stricter, exact rule: the ENTIRE pathname
 * (after WHATWG `URL` parsing, which already collapses `..`/`.` dot-segments
 * -- verified directly, not assumed) must equal
 * `/content/circulars/<DEPT><NUMBER>.pdf` or `.zip`, with NO intermediate
 * segment. A non-empty query string or fragment on a reviewed manifest URL
 * is also rejected outright -- a reviewed circular's `sourceUrl` has no
 * legitimate reason to carry either, and rejecting them removes any need to
 * reason about whether some downstream cache/rewrite layer might treat one
 * as changing canonical resource identity.
 */
import { APPROVED_RAW_SOURCE_PATH_PREFIX } from './raw-source-url-policy';

const REFERENCE_PATTERN = /^NSE\/([A-Z]+)\/(\d+)$/;

export type RawSourceUrlBindingErrorCode = 'UNRECOGNIZED_REFERENCE_SHAPE' | 'MALFORMED_URL' | 'URL_REFERENCE_MISMATCH' | 'URL_HAS_UNEXPECTED_QUERY_OR_FRAGMENT';

export class RawSourceUrlBindingError extends Error {
  constructor(public readonly code: RawSourceUrlBindingErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceUrlBindingError';
  }
}

/** `NSE/<DEPT>/<NUMBER>` -> `<DEPT><NUMBER>.pdf` (task section 4/20). Does not validate that `reference` is otherwise well-formed beyond matching this shape -- callers validate reference format separately (`isValidRawSourceReference`). */
export function deriveExpectedRawSourceUrlBasename(reference: string): string {
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match) {
    throw new RawSourceUrlBindingError('UNRECOGNIZED_REFERENCE_SHAPE', `'${reference}' does not match the expected 'NSE/<DEPT>/<NUMBER>' shape required to derive an expected URL basename.`);
  }
  const [, department, number] = match;
  return `${department}${number}.pdf`;
}

/** The zip-envelope sibling of `deriveExpectedRawSourceUrlBasename` (task section 4/37) -- same `<DEPT><NUMBER>` stem, `.zip` extension. */
export function deriveExpectedRawSourceZipBasename(reference: string): string {
  return `${deriveExpectedRawSourceUrlBasename(reference).slice(0, -'.pdf'.length)}.zip`;
}

/** The full deterministically-derived official URL for `reference` on the current approved host family. */
export function deriveExpectedRawSourceUrl(reference: string): string {
  return `https://nsearchives.nseindia.com${APPROVED_RAW_SOURCE_PATH_PREFIX}${deriveExpectedRawSourceUrlBasename(reference)}`;
}

/**
 * Fails closed unless `url`'s ENTIRE pathname is EXACTLY
 * `/content/circulars/<DEPT><NUMBER>.pdf` OR `.zip` for `reference` (task
 * section 20: "Reject mismatches... Manifest declares both identity and
 * URL; validator proves they agree."; task section 4/37: a small number of
 * real NSE circulars are published as a `.zip` bundle rather than a bare
 * PDF, so that extension is also an accepted bound path). Case-sensitive,
 * exact FULL-PATH match either way -- never a fuzzy/substring/basename-only
 * comparison (Terra Defect C: a basename-only check let
 * `/content/circulars/foo/CMTR57285.zip` through). WHATWG `URL` parsing
 * normalizes `.`/`..` dot-segments before this comparison ever runs, so a
 * URL like `/content/circulars/../circulars/CMTR57285.zip` is compared in
 * its already-normalized (and, in that example, legitimately equal) form --
 * never a bypass. A non-empty `search`/`hash` on the URL is rejected
 * outright, since a reviewed circular URL has no legitimate reason to carry
 * either. Does not itself enforce the approved-host/HTTPS policy (see
 * `assertApprovedRawSourceUrl` in `raw-source-url-policy.ts` for that,
 * separate and orthogonal, concern); this only proves identity binding.
 */
export function assertUrlBindsToReference(reference: string, url: string): void {
  const expectedPdfPath = `${APPROVED_RAW_SOURCE_PATH_PREFIX}${deriveExpectedRawSourceUrlBasename(reference)}`;
  const expectedZipPath = `${APPROVED_RAW_SOURCE_PATH_PREFIX}${deriveExpectedRawSourceZipBasename(reference)}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RawSourceUrlBindingError('MALFORMED_URL', `'${url}' is not a well-formed absolute URL.`);
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    throw new RawSourceUrlBindingError('URL_HAS_UNEXPECTED_QUERY_OR_FRAGMENT', `'${url}' carries a query string and/or fragment; a reviewed circular URL must be exactly its canonical path with neither.`);
  }

  if (parsed.pathname !== expectedPdfPath && parsed.pathname !== expectedZipPath) {
    throw new RawSourceUrlBindingError(
      'URL_REFERENCE_MISMATCH',
      `Reference '${reference}' expects URL path '${expectedPdfPath}' (or the zip-envelope form '${expectedZipPath}'), but '${url}' has path '${parsed.pathname}'.`
    );
  }
}
