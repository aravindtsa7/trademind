/**
 * Groww Backtesting historical CANDLE endpoint shapes (task B-F4, section
 * 1). UNLIKE `groww-historical-api.dto.ts`'s expiries/contracts envelopes
 * (confirmed against a real HTTP 200 in the B-F3 final correction pass),
 * this shape is taken directly from the B-F4 task specification's own
 * documentation -- it has NOT been confirmed against a live response.
 * `GROWW_API_KEY`/`GROWW_API_SECRET` were both unset in the environment
 * this was implemented in, so the mandatory B-F4 section-0 live proof could
 * not run (see the B-F4 final report). Every field below is validated
 * strictly by `GrowwHistoricalClient.fetchOptionCandles`, which fails
 * closed (`GrowwSchemaValidationError`) on anything that does not match --
 * it never silently accepts an alternative shape. Correct this one file
 * (and `parseGrowwCandleTimestamp`) once a real response is available,
 * mirroring the isolation approach already used for
 * `groww-contract-symbol-parser.ts`.
 *
 * Documented envelope:
 *   GET /v1/historical/candles ->
 *   {
 *     status: "SUCCESS",
 *     payload: {
 *       candles: GrowwCandleRow[],
 *       closing_price, start_time, end_time, interval_in_minutes
 *     }
 *   }
 *
 * Each `GrowwCandleRow` is documented as, and LIVE-CONFIRMED to be, an
 * exactly-7-element array:
 *   [timestamp, open, high, low, close, volume, openInterest]
 * For FNO, `openInterest` (the 7th element) is always present in the row;
 * an explicit `null` there means "provider did not supply OI" (see
 * `historical-option-candle-observation` OI-safety notes), but a row with
 * fewer than 7 elements (the 7th missing entirely) or more than 7 is
 * malformed and fails closed -- never coerced to a null-OI 7-element row.
 *
 * TIMESTAMP FORMAT -- LIVE-CONFIRMED (task B-F4 section 0 controlled
 * proof, real HTTP 200 against `NSE-NIFTY-06Jan22-17200-PE`,
 * 2022-01-03): the response timestamp is an offset-less wall-clock string
 * `YYYY-MM-DDTHH:mm:ss` (ISO date/time joined by `T`, e.g.
 * `"2022-01-03T09:15:00"` for the very first row) -- NO UTC offset, NO
 * trailing `Z`. `parseGrowwCandleTimestamp` parses this explicitly as
 * Asia/Kolkata (NEVER host-local time -- see task section 2); it also
 * tolerates a plain-space separator (`YYYY-MM-DD HH:mm:ss`, matching the
 * task spec's own REQUEST query-parameter convention) purely for
 * resilience, since both are unambiguous wall-clock strings under the same
 * IST interpretation.
 */

/** One raw candle row exactly as documented -- never trusted as-is; see `parseGrowwCandleRow`. */
export type GrowwCandleRow = readonly unknown[];

export interface GrowwCandlePayload {
  readonly candles: readonly GrowwCandleRow[];
  readonly closing_price?: unknown;
  readonly start_time?: unknown;
  readonly end_time?: unknown;
  readonly interval_in_minutes?: unknown;
}

/**
 * One candle row after this client's strict validation: real finite
 * numbers, an explicit `Asia/Kolkata`-parsed `Date`, and `openInterest`
 * preserved EXACTLY as the provider supplied it (`null` when absent/null, a
 * non-negative `bigint` when numeric -- never fabricated, never
 * forward-filled, never derived from volume; task section 9).
 *
 * `volume` is a non-negative `bigint` OR `null` -- this is the TRUTHFUL
 * intermediate transport shape needed to support BOTH candle families
 * through the same validated row type, never a weakening of either:
 *
 *  - FNO/option candles (`fetchOptionCandles`): `volume` is REQUIRED, exactly
 *    as before this correction -- a missing/null value still fails closed
 *    with `GrowwSchemaValidationError`. Never `null` in practice for this
 *    family; the `| null` in the type exists only because this interface is
 *    shared, never because option volume may legitimately be absent.
 *  - CASH/underlying candles (`fetchUnderlyingCandles`, B-M11): `volume` MAY
 *    legitimately be an EXPLICIT `null` -- live-confirmed on a real Groww
 *    NSE-NIFTY CASH response (2025-03-25T10:42:00 IST, `[...,null,null]`),
 *    alongside the already-known numeric-zero case (2024-12-12). A row whose
 *    volume (index 5) element is instead MISSING/`undefined` (a sparse row)
 *    is a DIFFERENT, unproven shape and still fails closed -- only the
 *    live-proven explicit-`null` case ever produces `volume: null` here
 *    (Terra-rejected-gate correction: explicit `null` and missing/`undefined`
 *    are never conflated). `GrowwHistoricalClient` itself never normalizes
 *    this `null` to `0n` -- that provider-to-canonical semantic decision
 *    belongs ONLY to `GrowwUnderlyingHistoricalDataProviderService` (see its
 *    own doc), never to this shared transport-validation layer.
 */
export interface GrowwValidatedCandleRow {
  readonly candleTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: bigint | null;
  readonly openInterest: bigint | null;
}

/** LIVE-CONFIRMED primary shape: `YYYY-MM-DDTHH:mm:ss` (`T` separator, no offset). A plain-space separator is also tolerated (see module doc). */
const CANDLE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parses Groww's live-confirmed wall-clock candle timestamp string,
 * anchored explicitly at `+05:30` (Asia/Kolkata) -- never `new
 * Date(rawString)` (which would apply the HOST's local timezone to an
 * offset-less string, exactly the host-local-timezone bug task section 2
 * requires avoiding). Returns `null` (never throws) on anything that does
 * not match the confirmed shape; the caller turns that into a typed,
 * indexed `GrowwSchemaValidationError`.
 */
export function parseGrowwCandleTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const match = CANDLE_TIMESTAMP_PATTERN.exec(raw.trim());
  if (!match) return null;
  const isoLocal = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+05:30`;
  const parsed = new Date(isoLocal);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip check: reject a syntactically-shaped but calendar-invalid
  // wall-clock value (e.g. '2022-13-40 25:70:00' would otherwise silently
  // roll over) -- mirrors the same defensive pattern already used by
  // `groww-contract-symbol-parser.ts`'s expiry-segment parsing.
  const reformatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(parsed)
    .reduce((accumulator, part) => ({ ...accumulator, [part.type]: part.value }), {} as Record<string, string>);
  const roundTripped = `${reformatted.year}-${reformatted.month}-${reformatted.day} ${reformatted.hour}:${reformatted.minute}:${reformatted.second}`;
  // Compared against the CAPTURED GROUPS (normalized with a space), never
  // against `match[0]` directly -- `match[0]` preserves whichever
  // separator (`T` or space) the input actually used, which would falsely
  // fail this check for the live-confirmed `T`-separated shape.
  const normalizedInput = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  if (roundTripped !== normalizedInput) return null;
  return parsed;
}
