import { HistoricalSourceCandleRow } from '../../domain/canonical-historical-candle';
import { istCalendarDate, istMinuteOfDay } from '../../domain/ist-session-clock';
import { regularSessionWindow } from '../../domain/session-window-expected-minutes.util';
import {
  HistoricalDataProvider,
  HistoricalOptionCandleRangeRequest,
  HistoricalUnderlyingCandleRangeRequest,
} from '../../interfaces/historical-data-provider.interface';
import { HistoricalProviderCapability, HistoricalProviderId } from '../../interfaces/historical-provider-capability.types';
import GrowwUnderlyingHistoricalDataProviderService from './groww-underlying-historical-data-provider.service';

/** Thrown by every validation performed in this file -- never a generic `Error`, so callers/tests can distinguish "operator misconfiguration" from any other failure mode. */
export class GrowwGapRepairExpectedMissingMinuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowwGapRepairExpectedMissingMinuteError';
  }
}

const CANONICAL_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * B-M10 targeted correction: parses `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC`
 * as a canonical `Date.prototype.toISOString()`-shaped UTC string
 * (`YYYY-MM-DDTHH:mm:ss.sssZ` -- no other separator/offset form is accepted,
 * matching this codebase's existing round-trip-validated-timestamp convention
 * e.g. `parseGrowwCandleTimestamp`) and requires it to be exactly
 * minute-aligned (zero seconds, zero milliseconds). Fails closed
 * (`GrowwGapRepairExpectedMissingMinuteError`) on anything else -- this is
 * the FIRST gate the CLI runs, before any provider construction, DB access,
 * or network call.
 */
export function parseExpectedMissingMinuteUtc(raw: string): Date {
  if (!CANONICAL_UTC_TIMESTAMP_PATTERN.test(raw)) {
    throw new GrowwGapRepairExpectedMissingMinuteError(
      `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC must be a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ); received '${raw}'.`
    );
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) {
    throw new GrowwGapRepairExpectedMissingMinuteError(`RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC is not a valid calendar timestamp; received '${raw}'.`);
  }
  if (parsed.getUTCSeconds() !== 0 || parsed.getUTCMilliseconds() !== 0) {
    throw new GrowwGapRepairExpectedMissingMinuteError(`RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC (${raw}) must be exactly minute-aligned (zero seconds, zero milliseconds).`);
  }
  return parsed;
}

/**
 * B-M10 targeted correction: independently validates an operator-authorized
 * "expected missing minute" candidate against the SAME primitive calendar
 * facts `CanonicalSessionProjectorService` itself classifies session rows
 * against (`istCalendarDate`, `istMinuteOfDay`) and the same research-lake
 * consumption-layer regular-session default (`regularSessionWindow`)
 * already used elsewhere in this module -- never a new invented calendar
 * rule (task: "using existing calendar infrastructure").
 *
 * This is a best-effort, DB-free, fail-FAST layer only, run BEFORE any
 * provider/network call. It is deliberately NOT the authoritative
 * certified-session-window check -- that remains
 * `NiftyUnderlyingGapRepairService`'s own calendar-resolved
 * `DatasetHealthValidatorService` revalidation of the FULL merged session
 * (see "INDEPENDENT SAFETY CHECK" in the task and that service's own doc).
 * It intentionally does not resolve a SPECIAL session's actual certified
 * windows (that would require the DB-backed
 * `NiftyUnderlyingIngestionPlannerService`) -- B-M10's sole authorized
 * timestamp targets a confirmed REGULAR trading day (2024-12-12), so the
 * `regularSessionWindow()` default is accurate for this milestone's scope.
 * A future special-session-day repair would need this check broadened via
 * the DB-backed planner, never silently assumed correct here.
 */
export function assertExpectedMissingMinuteWithinRegularSession(expectedMissingMinuteUtc: Date, tradingDate: string): void {
  if (Number.isNaN(expectedMissingMinuteUtc.getTime())) {
    throw new GrowwGapRepairExpectedMissingMinuteError('RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC is not a valid timestamp.');
  }
  if (expectedMissingMinuteUtc.getUTCSeconds() !== 0 || expectedMissingMinuteUtc.getUTCMilliseconds() !== 0) {
    throw new GrowwGapRepairExpectedMissingMinuteError(
      `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC (${expectedMissingMinuteUtc.toISOString()}) must be exactly minute-aligned (zero seconds, zero milliseconds).`
    );
  }
  const calendarDate = istCalendarDate(expectedMissingMinuteUtc);
  if (calendarDate !== tradingDate) {
    throw new GrowwGapRepairExpectedMissingMinuteError(
      `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC (${expectedMissingMinuteUtc.toISOString()}, IST calendar date ${calendarDate}) does not belong to RESEARCH_REPAIR_TRADING_DATE (${tradingDate}).`
    );
  }
  const window = regularSessionWindow();
  const minuteOfDay = istMinuteOfDay(expectedMissingMinuteUtc);
  if (minuteOfDay < window.openMinuteIst || minuteOfDay >= window.closeMinuteIst) {
    throw new GrowwGapRepairExpectedMissingMinuteError(
      `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC (${expectedMissingMinuteUtc.toISOString()}) falls outside the certified regular session window [09:15,15:30) IST.`
    );
  }
}

/**
 * B-M10 targeted correction: a REPAIR-SCOPED candidate-selection wrapper
 * around `GrowwUnderlyingHistoricalDataProviderService`. The general
 * underlying adapter always returns Groww's full, truthful provider session
 * (up to 376 rows for a regular day, including the live-verified 15:30
 * boundary row) -- that adapter is REUSED UNCHANGED here, never modified
 * into a "silently discard most candles" provider (task instruction).
 *
 * This wrapper exists because `NiftyUnderlyingGapRepairService`'s own
 * missing-minute resolution rule (task "SAFE DESIGN -- OPTION C") only ever
 * accepts a secondary/repair response that contains EXACTLY the missing
 * timestamp(s) -- any additional overlapping row at an already-primary-
 * accepted minute is cross-checked for content equality
 * (`candleContentEquals`), and Groww's index candles carry `openInterest =
 * null` where Upstox's carry `0n`, so every such overlap is a genuine,
 * correctly-detected structural conflict under the existing strict content-
 * identity policy (never weakened here). Exposing Groww's full session
 * directly as the repair provider therefore deterministically produces
 * `REPAIR_CONFLICT` on every overlapping minute, exactly as observed in the
 * first real repair attempt. This wrapper narrows the response to ONLY the
 * one explicitly operator-authorized missing timestamp, so
 * `NiftyUnderlyingGapRepairService` (reused completely unchanged) sees
 * exactly the "missing-only secondary response" shape its own K.1
 * integration test already proves resolves cleanly.
 *
 * `providerId` remains `GROWW` -- the returned candle is the untouched,
 * original Groww row (price/volume/OI never modified, never synthesized,
 * never interpolated). `getCapability()` delegates verbatim to the wrapped
 * adapter, since this wrapper changes candidate SELECTION only, never the
 * adapter's own documented capability facts.
 */
export default class GrowwUnderlyingGapRepairProviderService implements HistoricalDataProvider {
  readonly providerId = HistoricalProviderId.GROWW;

  constructor(
    private readonly delegate: GrowwUnderlyingHistoricalDataProviderService,
    private readonly expectedMissingMinuteUtc: Date
  ) {}

  getCapability(): HistoricalProviderCapability {
    return this.delegate.getCapability();
  }

  /**
   * Delegates the normal full-session single-date fetch to
   * `GrowwUnderlyingHistoricalDataProviderService` UNCHANGED (preserving its
   * complete mapping/validation behavior -- asset/instrument/interval/
   * single-date checks, timestamp/OHLC/volume/OI validation, the live-
   * verified 15:30 boundary row included), THEN narrows the result to
   * exactly the one authorized missing timestamp. Fails closed -- before
   * ever calling the delegate -- if `expectedMissingMinuteUtc` does not
   * belong to `request.fromTradingDate` or falls outside the certified
   * regular session window (`assertExpectedMissingMinuteWithinRegularSession`,
   * an independent re-check even though the CLI already validated this once
   * at startup -- defense in depth, never trusting a single validation
   * layer). Fails closed AFTER the delegate call if zero or more than one
   * candle matches the exact timestamp.
   */
  async fetchCompletedUnderlyingRange(
    request: HistoricalUnderlyingCandleRangeRequest
  ): Promise<readonly HistoricalSourceCandleRow[]> {
    assertExpectedMissingMinuteWithinRegularSession(this.expectedMissingMinuteUtc, request.fromTradingDate);

    const fullSessionRows = await this.delegate.fetchCompletedUnderlyingRange(request);

    const matches = fullSessionRows.filter((row) => row.candleTime.getTime() === this.expectedMissingMinuteUtc.getTime());
    if (matches.length === 0) {
      throw new GrowwGapRepairExpectedMissingMinuteError(
        `GrowwUnderlyingGapRepairProviderService: no Groww candle was found at the authorized missing timestamp ${this.expectedMissingMinuteUtc.toISOString()} for ${request.fromTradingDate}. Fail closed -- zero repair candidates.`
      );
    }
    if (matches.length > 1) {
      throw new GrowwGapRepairExpectedMissingMinuteError(
        `GrowwUnderlyingGapRepairProviderService: ${matches.length} Groww candles were found at the authorized missing timestamp ${this.expectedMissingMinuteUtc.toISOString()} for ${request.fromTradingDate}; expected exactly one. Fail closed -- duplicate candidate.`
      );
    }

    // Exactly one candidate, content untouched (price/volume/OI never modified) -- only `sourceIndex`
    // is normalized to 0, since this wrapper now presents a single-row response.
    return [{ ...matches[0], sourceIndex: 0 }];
  }

  /** Intentionally unimplemented: this wrapper is underlying-only, matching the delegate it wraps. */
  async fetchExpiredOptionRange(_request: HistoricalOptionCandleRangeRequest): Promise<readonly HistoricalSourceCandleRow[]> {
    throw new Error('GrowwUnderlyingGapRepairProviderService does not support option candle acquisition; it is underlying-index-only (B-M10).');
  }
}
