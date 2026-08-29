/**
 * B-F7A-ARCHIVE-1 official-source URL policy (task section 6/20). Applied
 * BOTH to a manifest entry's reviewed `sourceUrl` and to every redirect hop
 * the downloader follows (task section 6: "Redirects, if allowed, must be
 * revalidated at every hop") -- one shared function so the two call sites
 * can never silently diverge.
 */

export type RawSourceUrlPolicyErrorCode =
  | 'NON_HTTPS_SCHEME'
  | 'HOST_NOT_APPROVED'
  | 'PATH_NOT_APPROVED'
  | 'PRIVATE_OR_LOOPBACK_HOST'
  | 'MALFORMED_URL';

export class RawSourceUrlPolicyError extends Error {
  constructor(public readonly code: RawSourceUrlPolicyErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceUrlPolicyError';
  }
}

/** Current + legacy official NSE circular-PDF hosts (task section 6). */
export const APPROVED_RAW_SOURCE_HOSTS: readonly string[] = ['nsearchives.nseindia.com', 'archives.nseindia.com'];

/** Official documents live under this path family; nothing else on an approved host is trusted (task section 6/20). */
export const APPROVED_RAW_SOURCE_PATH_PREFIX = '/content/circulars/';

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Defense-in-depth SSRF guard, independent of the host allowlist above (task
 * section 6: "no localhost/private-network SSRF target"). Even though
 * `APPROVED_RAW_SOURCE_HOSTS` already excludes any private/loopback name by
 * construction, this function exists so a DNS-rebinding-style hostname that
 * happens to resolve into a private range is still caught if the allowlist
 * is ever loosened, and so the rule is independently unit-testable.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1' || lower === '[::1]') return true;

  const ipv4Match = IPV4_PATTERN.exec(lower);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return false; // not a valid IPv4 literal at all
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

/**
 * Fails closed unless `url` is: a well-formed absolute URL, HTTPS, on an
 * approved host, under the approved path prefix, and not a private/loopback
 * literal (task section 6/20). Never follows redirects itself -- returns the
 * parsed `URL` so a caller can inspect it further (e.g. extract the file
 * name for logging) without re-parsing.
 */
export function assertApprovedRawSourceUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RawSourceUrlPolicyError('MALFORMED_URL', `'${url}' is not a well-formed absolute URL.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new RawSourceUrlPolicyError('NON_HTTPS_SCHEME', `'${url}' must use https: (got '${parsed.protocol}').`);
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new RawSourceUrlPolicyError('PRIVATE_OR_LOOPBACK_HOST', `'${url}' resolves to a private/loopback host, which is never an approved NSE source.`);
  }
  if (!APPROVED_RAW_SOURCE_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new RawSourceUrlPolicyError('HOST_NOT_APPROVED', `'${url}' host '${parsed.hostname}' is not in the approved NSE host allowlist [${APPROVED_RAW_SOURCE_HOSTS.join(', ')}].`);
  }
  if (!parsed.pathname.startsWith(APPROVED_RAW_SOURCE_PATH_PREFIX)) {
    throw new RawSourceUrlPolicyError('PATH_NOT_APPROVED', `'${url}' path '${parsed.pathname}' is not under the approved prefix '${APPROVED_RAW_SOURCE_PATH_PREFIX}'.`);
  }
  return parsed;
}
