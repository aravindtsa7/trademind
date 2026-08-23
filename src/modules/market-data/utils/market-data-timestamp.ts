/**
 * Canonical-ingest provider-forward-skew allowance: how far ahead of
 * `referenceMs` a source timestamp may be and still be accepted as the
 * canonical live source timestamp (see `normalizeMarketDataTimestamp`).
 *
 * This is deliberately 0 (strict fail-closed). MarketDataRecoveryCoordinatorService
 * already documents that broker/local clocks are known to be able to disagree
 * in either direction (see its handleLiveTick clock-domain comment) -- but no
 * vendor contract, SLA, or measured bound in this repository currently
 * justifies any specific positive tolerance, and inventing one (1ms, 100ms,
 * 500ms, 1s, 2s, or otherwise) would be a guess. This constant exists so that
 * if/when a provider contract or measured bound DOES establish a defensible
 * value, there is exactly one place to change it -- never a per-call-site
 * magic number, and never derived from an unrelated quote-freshness threshold
 * (e.g. RISK_MAX_QUOTE_AGE_MS). Provider-contract validation is required
 * before this is ever raised above 0.
 */
export const DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS = 0;

/**
 * Converts an upstream market-data timestamp into the one timestamp contract
 * consumed by live market-data services: a UTC ISO-8601 instant.
 *
 * Numeric input is deliberately restricted to plausible epoch milliseconds.
 * Seconds, microseconds, and malformed values are rejected rather than guessed.
 *
 * `referenceMs`, when supplied, is the caller's own packet-receive/current
 * instant -- never an implicit `Date.now()` -- against which a source
 * timestamp more than `providerForwardSkewToleranceMs` in the future is
 * rejected. `referenceMs` is optional so generic historical/replay parsing
 * (no genuine receive context) keeps accepting any plausible timestamp
 * regardless of today's wall clock. This canonical-ingest tolerance is a
 * distinct concern from executable-quote/portfolio freshness (see
 * PaperMarketDataAdapterService.ageAt, which never applies any tolerance).
 */
export function normalizeMarketDataTimestamp(value: unknown, referenceMs?: number, providerForwardSkewToleranceMs: number = DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  // A malformed tolerance (NaN/Infinity/negative) must never silently widen or
  // collapse the forward-skew boundary -- fail closed exactly like every other
  // malformed input this function already rejects, rather than guessing.
  if (!Number.isFinite(providerForwardSkewToleranceMs) || providerForwardSkewToleranceMs < 0) return undefined;

  let epochMilliseconds: number;
  if (/^\d+$/.test(text)) {
    epochMilliseconds = Number(text);
    if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < Date.UTC(2000, 0, 1) || epochMilliseconds > Date.UTC(2100, 0, 1)) {
      return undefined;
    }
    const date = new Date(epochMilliseconds);
    if (Number.isNaN(date.getTime())) return undefined;
    if (referenceMs !== undefined && epochMilliseconds > referenceMs + providerForwardSkewToleranceMs) return undefined;
    return date.toISOString();
  }

  // Accept only explicit ISO date-time forms; Date.parse accepts many
  // implementation-specific strings which must not become a market-data clock.
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})T.*(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!isoDate) return undefined;
  const year = Number(isoDate[1]);
  const month = Number(isoDate[2]);
  const day = Number(isoDate[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  epochMilliseconds = parsed.getTime();
  if (referenceMs !== undefined && epochMilliseconds > referenceMs + providerForwardSkewToleranceMs) return undefined;
  return parsed.toISOString();
}
