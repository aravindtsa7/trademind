/**
 * Canonical-ingest provider-forward-skew allowance: how far ahead of
 * `referenceMs` a source timestamp may be and still be accepted as the
 * canonical live source timestamp (see `normalizeMarketDataTimestamp`).
 *
 * This is a bounded HOST-CLOCK-UNCERTAINTY allowance, NOT an Upstox provider
 * SLA and NOT permission for an arbitrarily future provider timestamp. It
 * exists because a genuinely NTP-synchronized Windows host was directly
 * measured (2026-08-24) to still disagree with independent external time by a
 * consistent, bounded amount:
 *
 *   - Windows Time reported successful sync (Leap Indicator 0, source
 *     40.81.94.65,0x8) immediately beforehand.
 *   - Direct stripchart measurement against three independent NTP references
 *     nonetheless showed the local clock ~116-141ms BEHIND external time
 *     (Microsoft NTP ~121-137ms, Cloudflare ~116-120ms, Google ~121-135ms).
 *   - During that same synchronized-host live run, rejected Upstox
 *     `currentTs` values showed forwardSkewMs of 85-92ms against the (then
 *     strict 0ms) tolerance -- squarely inside the independently-measured
 *     clock-uncertainty range, not evidence that Upstox itself publishes
 *     future timestamps.
 *   - By contrast, an earlier genuinely UNHEALTHY host clock was ~3.3
 *     SECONDS slow -- a multi-second skew, orders of magnitude beyond any
 *     plausible NTP-synchronized uncertainty, and must remain rejected.
 *
 * 150ms is therefore the smallest simple round bound strictly above the
 * observed synchronized-host maximum (~141ms), not a derived or vendor-quoted
 * figure. It absorbs ordinary NTP-synchronized clock uncertainty while still
 * rejecting any multi-second-class skew (a genuinely unhealthy/unsynchronized
 * host clock, or a truly future provider timestamp). This constant exists so
 * there is exactly one place to change it -- never a per-call-site magic
 * number, and never derived from an unrelated quote-freshness threshold (e.g.
 * RISK_MAX_QUOTE_AGE_MS). Raising it further requires new evidence, exactly
 * as this 0ms -> 150ms change did.
 */
export const DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS = 150;

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
