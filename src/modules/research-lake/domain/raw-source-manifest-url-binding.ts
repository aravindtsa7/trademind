/**
 * B-F7A-ARCHIVE-1-FIX-1 Defect E correction (task section 20). Proves that a
 * manifest entry's declared `reference` and its reviewed `sourceUrl`
 * actually agree, so a reviewer/typo error (e.g. `NSE/MSD/60340` bound to
 * `.../MSD60318.pdf`) is rejected even though both strings independently
 * look valid and the URL is on an approved host.
 *
 * The binding rule itself was supplied directly by the task instructions
 * (not independently discovered/guessed by this implementation): for a
 * reference `NSE/<DEPT>/<NUMBER>`, the expected official PDF basename is
 * `<DEPT><NUMBER>.pdf` under the approved circulars path
 * (`raw-source-url-policy.ts`'s `APPROVED_RAW_SOURCE_HOSTS` /
 * `APPROVED_RAW_SOURCE_PATH_PREFIX`). This module does NOT perform new NSE
 * source discovery -- it only checks that an already-declared reference and
 * an already-declared URL are mutually consistent under that rule.
 */
import { APPROVED_RAW_SOURCE_PATH_PREFIX } from './raw-source-url-policy';

const REFERENCE_PATTERN = /^NSE\/([A-Z]+)\/(\d+)$/;

export type RawSourceUrlBindingErrorCode = 'UNRECOGNIZED_REFERENCE_SHAPE' | 'MALFORMED_URL' | 'URL_REFERENCE_MISMATCH';

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

/** The full deterministically-derived official URL for `reference` on the current approved host family. */
export function deriveExpectedRawSourceUrl(reference: string): string {
  return `https://nsearchives.nseindia.com${APPROVED_RAW_SOURCE_PATH_PREFIX}${deriveExpectedRawSourceUrlBasename(reference)}`;
}

/**
 * Fails closed unless `url`'s final path segment (basename) is EXACTLY the
 * basename `deriveExpectedRawSourceUrlBasename(reference)` expects (task
 * section 20: "Reject mismatches... Manifest declares both identity and
 * URL; validator proves they agree."). Case-sensitive, exact match -- never
 * a fuzzy/substring comparison. Does not itself enforce the approved-host/
 * HTTPS policy (see `assertApprovedRawSourceUrl` in `raw-source-url-policy.ts`
 * for that, separate and orthogonal, concern); this only proves identity
 * binding.
 */
export function assertUrlBindsToReference(reference: string, url: string): void {
  const expectedBasename = deriveExpectedRawSourceUrlBasename(reference);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RawSourceUrlBindingError('MALFORMED_URL', `'${url}' is not a well-formed absolute URL.`);
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const actualBasename = segments[segments.length - 1];

  if (actualBasename !== expectedBasename) {
    throw new RawSourceUrlBindingError(
      'URL_REFERENCE_MISMATCH',
      `Reference '${reference}' expects URL basename '${expectedBasename}', but '${url}' has basename '${String(actualBasename)}'.`
    );
  }
}
