/**
 * Converts an upstream market-data timestamp into the one timestamp contract
 * consumed by live market-data services: a UTC ISO-8601 instant.
 *
 * Numeric input is deliberately restricted to plausible epoch milliseconds.
 * Seconds, microseconds, and malformed values are rejected rather than guessed.
 */
export function normalizeMarketDataTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;

  if (/^\d+$/.test(text)) {
    const epochMilliseconds = Number(text);
    if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < Date.UTC(2000, 0, 1) || epochMilliseconds > Date.UTC(2100, 0, 1)) {
      return undefined;
    }
    const date = new Date(epochMilliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
