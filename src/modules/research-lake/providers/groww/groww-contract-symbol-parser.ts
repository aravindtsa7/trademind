import { HistoricalOptionType } from '../../domain/historical-asset.types';

/**
 * Groww historical contract symbols are documented (task B-F3, section 5)
 * as: `EXCHANGE-UNDERLYING-DDMonYY-STRIKE-CE|PE` for an option
 * (`NSE-NIFTY-02Jan25-28500-PE`) or `EXCHANGE-UNDERLYING-DDMonYY-FUT` for a
 * future. This grammar has NOT been confirmed against a live 200 response
 * (the B-F3 live probe could not obtain one -- see the final report); it is
 * parsed exactly as documented, strictly, with no guessing beyond that
 * grammar, and entirely isolated to this file so it can be corrected in one
 * place once real success-response symbols are available.
 */
export enum GrowwSymbolKind {
  OPTION = 'OPTION',
  FUTURE = 'FUTURE',
}

export enum GrowwSymbolParseFailureReason {
  EMPTY_SYMBOL = 'EMPTY_SYMBOL',
  INVALID_SEGMENT_COUNT = 'INVALID_SEGMENT_COUNT',
  EMPTY_SEGMENT = 'EMPTY_SEGMENT',
  WRONG_EXCHANGE = 'WRONG_EXCHANGE',
  WRONG_UNDERLYING = 'WRONG_UNDERLYING',
  MALFORMED_EXPIRY = 'MALFORMED_EXPIRY',
  MALFORMED_STRIKE = 'MALFORMED_STRIKE',
  UNKNOWN_INSTRUMENT_TYPE = 'UNKNOWN_INSTRUMENT_TYPE',
}

export interface ParsedGrowwOptionSymbol {
  readonly kind: GrowwSymbolKind.OPTION;
  readonly rawSymbol: string;
  readonly exchange: string;
  readonly underlyingSymbol: string;
  /** Calendar expiry date only, anchored at 00:00 IST -- see the module doc on point-in-time safety below. */
  readonly expiry: Date;
  readonly strikePrice: number;
  readonly optionType: HistoricalOptionType;
}

export interface ParsedGrowwFutureSymbol {
  readonly kind: GrowwSymbolKind.FUTURE;
  readonly rawSymbol: string;
  readonly exchange: string;
  readonly underlyingSymbol: string;
  readonly expiry: Date;
}

export interface GrowwSymbolParseFailure {
  readonly rawSymbol: string;
  readonly reason: GrowwSymbolParseFailureReason;
  readonly detail: string;
}

export type GrowwSymbolParseResult =
  | { readonly ok: true; readonly value: ParsedGrowwOptionSymbol | ParsedGrowwFutureSymbol }
  | { readonly ok: false; readonly failure: GrowwSymbolParseFailure };

const MONTH_LOOKUP: Readonly<Record<string, number>> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const EXPIRY_SEGMENT_PATTERN = /^(\d{2})([A-Za-z]{3})(\d{2})$/;
const STRIKE_SEGMENT_PATTERN = /^\d+(\.\d+)?$/;

function fail(rawSymbol: string, reason: GrowwSymbolParseFailureReason, detail: string): GrowwSymbolParseResult {
  return { ok: false, failure: { rawSymbol, reason, detail } };
}

/**
 * Parses a `DDMonYY` expiry segment (exact case: 3-letter month with only
 * the first letter capitalized, e.g. `Jan`, matching every documented
 * example) into a real calendar Date. Round-trips through `Date.UTC` and
 * re-checks the components to reject a syntactically-shaped but
 * calendar-invalid date (e.g. `30Feb25`) rather than letting `Date`
 * silently roll it over into March. Two-digit years are interpreted as
 * `2000 + YY` -- correct for any year Groww's documented 2020-onward
 * historical coverage could plausibly use.
 */
function parseExpirySegment(segment: string): Date | null {
  const match = EXPIRY_SEGMENT_PATTERN.exec(segment);
  if (!match) return null;
  const day = Number(match[1]);
  const monthAbbreviation = match[2];
  const month = MONTH_LOOKUP[monthAbbreviation]; // exact-case key lookup: 'Jan' matches, 'JAN'/'jan' do not
  if (!month) return null;
  const year = 2000 + Number(match[3]);

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    return null; // rolled over -- not a real calendar date (e.g. 30Feb)
  }
  // Anchored at 00:00 IST, matching the plain-calendar-date convention
  // used elsewhere in research-lake (tradingDate-anchored Dates); this is
  // a calendar identity only, never a claimed intraday timestamp.
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(`${isoDate}T00:00:00+05:30`);
}

/**
 * Strictly parses one Groww historical contract symbol. Extracts ONLY what
 * the symbol's own grammar encodes/proves -- exchange, underlying, expiry,
 * strikePrice, optionType for an option; exchange, underlying, expiry for a
 * future. Never guesses from partial/ambiguous string slicing: any segment
 * that does not exactly match the documented grammar is rejected with a
 * typed reason rather than coerced.
 *
 * `expected.exchange` / `expected.underlyingSymbol` gate acceptance: a
 * syntactically well-formed symbol for a different exchange/underlying is
 * still rejected (WRONG_EXCHANGE / WRONG_UNDERLYING) rather than silently
 * accepted, since this adapter is scoped to NSE NIFTY only.
 */
export function parseGrowwSymbol(
  rawSymbol: string,
  expected: { readonly exchange: string; readonly underlyingSymbol: string }
): GrowwSymbolParseResult {
  if (typeof rawSymbol !== 'string' || rawSymbol.trim().length === 0) {
    return fail(rawSymbol ?? '', GrowwSymbolParseFailureReason.EMPTY_SYMBOL, 'Symbol was empty or not a string.');
  }

  const segments = rawSymbol.split('-');
  if (segments.some((segment) => segment.length === 0)) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.EMPTY_SEGMENT, 'Symbol contains an empty segment (e.g. a double hyphen).');
  }
  if (segments.length !== 4 && segments.length !== 5) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.INVALID_SEGMENT_COUNT, `Expected 4 segments (future) or 5 (option); got ${segments.length}.`);
  }

  const [exchange, underlyingSymbol, expirySegment, ...rest] = segments;

  if (exchange !== expected.exchange) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.WRONG_EXCHANGE, `Expected exchange '${expected.exchange}'; got '${exchange}'.`);
  }
  if (underlyingSymbol !== expected.underlyingSymbol) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.WRONG_UNDERLYING, `Expected underlying '${expected.underlyingSymbol}'; got '${underlyingSymbol}'.`);
  }

  const expiry = parseExpirySegment(expirySegment);
  if (!expiry) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.MALFORMED_EXPIRY, `'${expirySegment}' is not a valid DDMonYY expiry segment.`);
  }

  if (segments.length === 4) {
    const [instrumentType] = rest;
    if (instrumentType !== 'FUT') {
      return fail(rawSymbol, GrowwSymbolParseFailureReason.UNKNOWN_INSTRUMENT_TYPE, `4-segment symbol's final segment must be 'FUT'; got '${instrumentType}'.`);
    }
    return { ok: true, value: { kind: GrowwSymbolKind.FUTURE, rawSymbol, exchange, underlyingSymbol, expiry } };
  }

  const [strikeSegment, instrumentType] = rest;
  if (instrumentType !== 'CE' && instrumentType !== 'PE') {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.UNKNOWN_INSTRUMENT_TYPE, `5-segment symbol's final segment must be 'CE' or 'PE'; got '${instrumentType}'.`);
  }
  if (!STRIKE_SEGMENT_PATTERN.test(strikeSegment)) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.MALFORMED_STRIKE, `'${strikeSegment}' is not a valid positive numeric strike.`);
  }
  const strikePrice = Number(strikeSegment);
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) {
    return fail(rawSymbol, GrowwSymbolParseFailureReason.MALFORMED_STRIKE, `Parsed strike '${strikePrice}' is not a positive finite number.`);
  }

  return {
    ok: true,
    value: {
      kind: GrowwSymbolKind.OPTION,
      rawSymbol,
      exchange,
      underlyingSymbol,
      expiry,
      strikePrice,
      optionType: instrumentType === 'CE' ? HistoricalOptionType.CE : HistoricalOptionType.PE,
    },
  };
}
