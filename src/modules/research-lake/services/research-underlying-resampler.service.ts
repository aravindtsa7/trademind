import { Prisma } from '@prisma/client';
import { istCalendarDate, istMinuteOfDay } from '../domain/ist-session-clock';
import { formatMinuteOfDayIst, SessionWindow, validateSessionWindows } from '../domain/exchange-calendar.types';
import { expectedMinutesForWindows } from '../domain/session-window-expected-minutes.util';
import { ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe, resampleBucketMinutes } from '../domain/resampled-candle.types';
import {
  RESEARCH_UNDERLYING_RESAMPLING_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
  ResearchCandleConstituentLineageEntry,
  ResearchCandleQuality,
  ResearchDerivedIdentity,
  ResearchResampleSessionDescriptor,
  ResearchResampleSessionStatus,
  ResearchResampledCandle,
  computeResearchDerivedContentChecksum,
  researchResampledCandleToContent,
} from '../domain/research-underlying-resampled-candle.types';
import { ResolvedResearchRowProvenance, ResolvedResearchRowSourceKind, ResolvedResearchSessionRow } from './research-underlying-1m-session-reader.service';

const MINUTE_MS = 60_000;
const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The only `ResearchSessionSourceSelection` tiers B-M7.3 may ever resample -- `UNAVAILABLE` (tier 4) never reaches this service (task: "tier 4: not resampleable"). */
const RESAMPLEABLE_TIERS: ReadonlySet<ResearchSessionSourcePrecedenceTier> = new Set([
  ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
  ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
  ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
]);

export interface ResearchResampleSessionRequest {
  readonly sourceAssemblyChecksum: string;
  readonly tradingDate: string;
  readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier;
  /** `selection.canonicalContentChecksum` for tier 1/2, `selection.derivedContentChecksum` for tier 3 -- resolved by the caller (never re-derived here, task: "resolve sourceContentChecksum as..."). */
  readonly sourceContentChecksum: string;
  readonly targetTimeframe: ResampleTargetTimeframe;
  /** The exact, calendar-authoritative session windows for this trading date (task: "resolve authoritative calendar windows... never Monday-Friday arithmetic"). REQUIRED and never defaulted -- unlike B-F7's `ResampleSessionRequest.sessionWindows`, an empty/omitted value fails closed rather than silently falling back to the fixed regular-session contract. */
  readonly sessionWindows: readonly SessionWindow[];
  /** Rows resolved via `ResearchUnderlying1mSessionReaderService.resolveSessionRows(...)` ONLY -- this service never reads `HistoricalCandle` or a B-M7.1 artifact directly (task: "Do NOT read HistoricalCandle directly... Do NOT re-read the B-M7.1 artifact directly"). Order-independent (task section 2). */
  readonly sourceRows: readonly ResolvedResearchSessionRow[];
}

export interface ResearchResampleSessionResult {
  /** Sorted ascending by `bucketStart`. Only ever contains buckets whose every expected constituent minute was present -- a session with ANY missing expected minute never reaches this return path (see `ResearchUnderlyingResamplerMissingMinuteError`). */
  readonly candles: readonly ResearchResampledCandle[];
  readonly descriptor: ResearchResampleSessionDescriptor;
}

interface ParsedResearchRow {
  readonly candleTime: Date;
  readonly availableAt: Date;
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
  readonly provenance: ResolvedResearchRowProvenance;
}

interface CandidateBucket {
  readonly expectedConstituentMinutes: readonly number[];
  readonly isFullSessionEligible: boolean;
}

export class ResearchUnderlyingResamplerUnresampleableTierError extends Error {
  constructor(readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier) {
    super(`ResearchUnderlyingResamplerService cannot resample a session at precedence tier '${String(sourcePrecedenceTier)}' -- only HEALTHY_REAL_CANONICAL_SESSION, ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION, and AUTHORIZED_DERIVED_IMPUTED_SESSION are resampleable.`);
    this.name = 'ResearchUnderlyingResamplerUnresampleableTierError';
  }
}

/** Fails closed the entire session (task: "If the B-M7.2 1m reader returns... missing... source rows, B-M7.3 must fail closed. Do NOT produce a 'complete' B-M7.3 session from incomplete source rows"). B-M7.3 deliberately has NO `INCOMPLETE_SOURCE_SESSION` return path the way B-F7 does -- a research session is either fully resampled or this throws. */
export class ResearchUnderlyingResamplerMissingMinuteError extends Error {
  constructor(
    readonly tradingDate: string,
    readonly missingSourceMinuteCount: number
  ) {
    super(`ResearchUnderlyingResamplerService: tradingDate '${tradingDate}' is missing ${missingSourceMinuteCount} expected source minute(s) -- refusing to certify an incomplete B-M7.3 research session. Structural trailing remainder is never counted here (see the resampler's own doc).`);
    this.name = 'ResearchUnderlyingResamplerMissingMinuteError';
  }
}

/** Fails closed (task: "Fail closed if resolved row provenance is structurally inconsistent with the B-M7.2 selection... No mixed canonical/derived source families inside one selected session"). */
export class ResearchUnderlyingResamplerSourceFamilyMismatchError extends Error {
  constructor(
    readonly tradingDate: string,
    readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier,
    readonly candleTime: string,
    readonly actualSourceKind: ResolvedResearchRowSourceKind
  ) {
    super(
      `ResearchUnderlyingResamplerService: tradingDate '${tradingDate}' selected at precedence tier '${String(sourcePrecedenceTier)}' resolved a row at ${candleTime} with source kind '${actualSourceKind}' -- refusing to silently normalize a mixed canonical/derived source family within one session.`
    );
    this.name = 'ResearchUnderlyingResamplerSourceFamilyMismatchError';
  }
}

/**
 * B-M7.3: deterministic, PROVENANCE-AWARE research-layer 1m -> {2m,3m,5m}
 * resampler. A SEPARATE class from B-F7's `HistoricalCandleResamplerService`
 * (`historical-candle-resampler.service.ts`) -- that class's public behavior,
 * output, and semantics version are completely untouched by this milestone.
 *
 * Consumes ONLY `ResolvedResearchSessionRow[]` -- the exact typed output of
 * `ResearchUnderlying1mSessionReaderService.resolveSessionRows(...)` (the
 * ONE B-M7.2 source-resolution boundary) -- never `HistoricalCandle` directly,
 * never a B-M7.1 artifact directly, and never re-implements source
 * precedence (task: "No second source-selection path").
 *
 * CRITICAL NO-LOOKAHEAD RULE (task): every resampled candle's `availableAt`
 * is `MAX(every constituent 1m row's own availableAt)` -- NEVER
 * `bucketEnd + 1 minute` (B-F7's convention) unless that happens to be the
 * max naturally. This is the one rule that differs most from B-F7: a B-M7.1
 * IMPUTED row can become available LATER than its own candle completion
 * (e.g. a 10:22 imputed candle whose real `availableAt` is 10:26, not 10:23).
 *
 * BUCKET/SESSION-WINDOW RULES (identical to B-F7, task: "reuse existing
 * calendar/session helpers and exact aggregation conventions"): each declared
 * `sessionWindows` entry is an independent bucket anchor; a bucket can never
 * cross a session-window boundary or bridge a closed gap; a window's
 * arithmetic trailing remainder is structurally excluded, never fabricated,
 * never counted as missing data.
 *
 * UNLIKE B-F7, this resampler NEVER returns a result for an incomplete source
 * session -- ANY missing expected source minute (task: "missingSourceMinuteCount
 * must be 0... B-M7.3 must fail closed") throws
 * `ResearchUnderlyingResamplerMissingMinuteError` before any bucket is built.
 * A B-M7.2-selected research-ready session is expected to already be
 * complete; this is a defensive fail-closed guard against drifted/corrupted
 * input, never a normal/expected return path.
 */
export default class ResearchUnderlyingResamplerService {
  resampleSession(request: ResearchResampleSessionRequest): ResearchResampleSessionResult {
    if (!RESAMPLEABLE_TIERS.has(request.sourcePrecedenceTier)) {
      throw new ResearchUnderlyingResamplerUnresampleableTierError(request.sourcePrecedenceTier);
    }
    if (!TRADING_DATE_PATTERN.test(request.tradingDate)) {
      throw new Error(`ResearchUnderlyingResamplerService requires tradingDate as 'YYYY-MM-DD'; received '${request.tradingDate}'.`);
    }
    // Reuses `resampleBucketMinutes` verbatim (task: "Supported target timeframes EXACTLY: 2m, 3m, 5m") -- fails closed on anything else.
    const bucketSize = resampleBucketMinutes(request.targetTimeframe);

    if (!request.sessionWindows || request.sessionWindows.length === 0) {
      throw new Error(`ResearchUnderlyingResamplerService requires non-empty, calendar-certified sessionWindows for tradingDate '${request.tradingDate}' -- it never defaults to a fixed regular-session contract.`);
    }
    const sessionWindows = validateSessionWindows(request.sessionWindows);

    const parsedRows = this.validateAndSort(request.sourceRows, request.tradingDate, sessionWindows, request.sourcePrecedenceTier);

    const rowsByMinute = new Map<number, ParsedResearchRow>();
    for (const row of parsedRows) rowsByMinute.set(istMinuteOfDay(row.candleTime), row);

    const expectedMinutesIst = expectedMinutesForWindows(sessionWindows);
    const missingSourceMinuteCount = expectedMinutesIst.filter((minute) => !rowsByMinute.has(minute)).length;
    if (missingSourceMinuteCount > 0) {
      throw new ResearchUnderlyingResamplerMissingMinuteError(request.tradingDate, missingSourceMinuteCount);
    }

    const candidateBuckets = this.buildCandidateBuckets(bucketSize, sessionWindows);

    const candles: ResearchResampledCandle[] = [];
    let structuralTrailingRowCount = 0;
    let candlesContainingImputation = 0;

    for (const bucket of candidateBuckets) {
      // Every expected minute is guaranteed present -- the missing-minute check above already failed closed otherwise.
      const constituents = bucket.expectedConstituentMinutes.map((minute) => rowsByMinute.get(minute) as ParsedResearchRow);

      if (!bucket.isFullSessionEligible) {
        // Legitimate per-window session arithmetic remainder (task: "Never fabricate a partial candle. Never bridge into another window.") -- never data incompleteness.
        structuralTrailingRowCount += constituents.length;
        continue;
      }

      const candle = this.aggregateBucket(constituents);
      candles.push(candle);
      if (candle.quality === ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION) candlesContainingImputation += 1;
    }

    let realCanonicalConstituentRowCount = 0;
    let derivedObservedConstituentRowCount = 0;
    let derivedImputedConstituentRowCount = 0;
    for (const row of parsedRows) {
      if (row.provenance.sourceKind === ResolvedResearchRowSourceKind.REAL_CANONICAL) {
        realCanonicalConstituentRowCount += 1;
      } else if (row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.OBSERVED) {
        derivedObservedConstituentRowCount += 1;
      } else {
        derivedImputedConstituentRowCount += 1;
      }
    }

    const identity: ResearchDerivedIdentity = {
      sourceAssemblyChecksum: request.sourceAssemblyChecksum,
      tradingDate: request.tradingDate,
      sourcePrecedenceTier: request.sourcePrecedenceTier,
      sourceContentChecksum: request.sourceContentChecksum,
      targetTimeframe: request.targetTimeframe,
      researchResamplingSemanticsVersion: RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
      sessionWindows,
    };
    const researchDerivedContentChecksum = computeResearchDerivedContentChecksum({
      identity,
      candles: candles.map(researchResampledCandleToContent),
    });

    const descriptor: ResearchResampleSessionDescriptor = {
      researchResamplingSchemaVersion: RESEARCH_UNDERLYING_RESAMPLING_SCHEMA_VERSION,
      researchResamplingSemanticsVersion: RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
      sourceAssemblyChecksum: request.sourceAssemblyChecksum,
      tradingDate: request.tradingDate,
      sourcePrecedenceTier: request.sourcePrecedenceTier,
      sourceContentChecksum: request.sourceContentChecksum,
      targetTimeframe: request.targetTimeframe,
      sessionWindows,
      sourceRowCount: parsedRows.length,
      expectedSourceMinuteCount: expectedMinutesIst.length,
      outputCandleCount: candles.length,
      structuralTrailingRowCount,
      missingSourceMinuteCount: 0,
      realCanonicalConstituentRowCount,
      derivedObservedConstituentRowCount,
      derivedImputedConstituentRowCount,
      candlesContainingImputation,
      researchDerivedContentChecksum,
      status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
    };

    return { candles, descriptor };
  }

  /**
   * Fails closed on any structurally non-canonical input row -- identical
   * validation contract to B-F7's `validateAndSort` (cross-date, pre/post
   * declared-window bounds, closed-gap-between-windows, non-minute-aligned,
   * duplicate minute) PLUS a research-specific check: every row's
   * `provenance.sourceKind` must match the source family the caller's
   * `sourcePrecedenceTier` implies (tier 1/2 -> REAL_CANONICAL only, tier 3 ->
   * DERIVED only) -- never a silently mixed session (task: "No mixed
   * canonical/derived source families inside one selected session"). Also
   * parses each row's decimal/bigint string fields into exact
   * `Prisma.Decimal`/`bigint` values here, once, so aggregation never touches
   * a raw string or a lossy `Number()` conversion.
   */
  private validateAndSort(
    rows: readonly ResolvedResearchSessionRow[],
    tradingDate: string,
    windows: readonly SessionWindow[],
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier
  ): ParsedResearchRow[] {
    const earliestOpenMinute = windows[0].openMinuteIst;
    const latestCloseMinute = windows[windows.length - 1].closeMinuteIst;
    const expectsRealCanonical = sourcePrecedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION;

    const seenMinutes = new Set<number>();
    const parsed: ParsedResearchRow[] = [];

    for (const row of rows) {
      const candleTime = new Date(row.candleTime);
      const timestamp = candleTime.getTime();
      if (Number.isNaN(timestamp) || timestamp % MINUTE_MS !== 0) {
        throw new Error(`ResearchUnderlyingResamplerService received a non-minute-aligned candleTime: ${row.candleTime}.`);
      }
      if (istCalendarDate(candleTime) !== tradingDate) {
        throw new Error(`ResearchUnderlyingResamplerService received a cross-date row ${row.candleTime}: expected trading date ${tradingDate}.`);
      }
      const minuteOfDay = istMinuteOfDay(candleTime);
      if (minuteOfDay < earliestOpenMinute) {
        throw new Error(`ResearchUnderlyingResamplerService received a pre-market row ${row.candleTime}: before ${formatMinuteOfDayIst(earliestOpenMinute)} IST.`);
      }
      if (minuteOfDay >= latestCloseMinute) {
        throw new Error(`ResearchUnderlyingResamplerService received a post-market row ${row.candleTime}: at or after ${formatMinuteOfDayIst(latestCloseMinute)} IST.`);
      }
      if (!windows.some((window) => minuteOfDay >= window.openMinuteIst && minuteOfDay < window.closeMinuteIst)) {
        throw new Error(
          `ResearchUnderlyingResamplerService received a row ${row.candleTime} outside every declared calendar session window: it falls in a closed gap between two disjoint windows and is never bridged.`
        );
      }
      if (seenMinutes.has(minuteOfDay)) {
        throw new Error(`ResearchUnderlyingResamplerService received a duplicate source minute at ${row.candleTime}.`);
      }
      seenMinutes.add(minuteOfDay);

      const isRealCanonical = row.provenance.sourceKind === ResolvedResearchRowSourceKind.REAL_CANONICAL;
      if (expectsRealCanonical !== isRealCanonical) {
        throw new ResearchUnderlyingResamplerSourceFamilyMismatchError(tradingDate, sourcePrecedenceTier, row.candleTime, row.provenance.sourceKind);
      }

      parsed.push({
        candleTime,
        availableAt: new Date(row.availableAt),
        open: new Prisma.Decimal(row.open),
        high: new Prisma.Decimal(row.high),
        low: new Prisma.Decimal(row.low),
        close: new Prisma.Decimal(row.close),
        volume: BigInt(row.volume),
        openInterest: row.openInterest === null ? null : BigInt(row.openInterest),
        provenance: row.provenance,
      });
    }

    return parsed.sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  }

  /** Byte-for-byte the SAME bucket-walking loop as B-F7's private `buildCandidateBuckets` (each window independently anchored at its own `openMinuteIst`, never crossing into another window) -- duplicated rather than extracted, so B-F7's own file/behavior is never touched by this milestone (task: "A pure internal helper extraction... permitted ONLY IF canonical B-F7 observable output is byte-for-byte unchanged"; direct parity tests prove this bucket walk produces identical bucket boundaries). */
  private buildCandidateBuckets(bucketSize: number, windows: readonly SessionWindow[]): CandidateBucket[] {
    const buckets: CandidateBucket[] = [];
    for (const window of windows) {
      for (let startMinute = window.openMinuteIst; startMinute < window.closeMinuteIst; startMinute += bucketSize) {
        const constituents: number[] = [];
        for (let minute = startMinute; minute < startMinute + bucketSize && minute < window.closeMinuteIst; minute += 1) {
          constituents.push(minute);
        }
        buckets.push({ expectedConstituentMinutes: constituents, isFullSessionEligible: constituents.length === bucketSize });
      }
    }
    return buckets;
  }

  /**
   * OHLCV aggregation -- IDENTICAL formulas to B-F7's `aggregateBucket`
   * (open = first constituent's open, high/low = exact `Prisma.Decimal`
   * max/min, close = last constituent's close, volume = exact bigint sum,
   * openInterest = FINAL constituent's own value, never forward-filled).
   *
   * THE CORE B-M7.3 DIVERGENCE: `availableAt` is `MAX(every constituent's own
   * availableAt)`, computed by walking every constituent (never merely
   * `last.availableAt` / `bucketEnd + 1m`) -- this is what correctly produces
   * 10:27 IST (not 10:26) for the March-7 3m 10:24-10:26 bucket, whose final
   * constituent (10:26) is a NORMAL observed row completing at 10:27, later
   * than the bucket's two earlier imputed-adjacent minutes' own 10:26 delay.
   *
   * `quality` is derived per-bucket from constituent provenance (task:
   * "REAL_CANONICAL_ONLY / DERIVED_OBSERVED_ONLY / CONTAINS_AUTHORIZED_IMPUTATION")
   * -- source-family consistency is already enforced by `validateAndSort`, so
   * every constituent in one bucket shares the same top-level sourceKind
   * family; `CONTAINS_AUTHORIZED_IMPUTATION` wins whenever ANY constituent is
   * a B-M7.1 IMPUTED row.
   */
  private aggregateBucket(constituents: readonly ParsedResearchRow[]): ResearchResampledCandle {
    const sorted = [...constituents].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    let high = first.high;
    let low = first.low;
    let volume = 0n;
    let maxAvailableAt = first.availableAt;
    let allRealCanonical = true;
    let anyImputed = false;
    const lineage: ResearchCandleConstituentLineageEntry[] = [];

    for (const row of sorted) {
      if (row.high.greaterThan(high)) high = row.high;
      if (row.low.lessThan(low)) low = row.low;
      volume += row.volume;
      if (row.availableAt.getTime() > maxAvailableAt.getTime()) maxAvailableAt = row.availableAt;

      if (row.provenance.sourceKind !== ResolvedResearchRowSourceKind.REAL_CANONICAL) {
        allRealCanonical = false;
        if (row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.IMPUTED) anyImputed = true;
      }

      lineage.push({ candleTime: row.candleTime.toISOString(), availableAt: row.availableAt.toISOString(), provenance: row.provenance });
    }

    const quality = anyImputed ? ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION : allRealCanonical ? ResearchCandleQuality.REAL_CANONICAL_ONLY : ResearchCandleQuality.DERIVED_OBSERVED_ONLY;

    return {
      bucketStart: first.candleTime,
      bucketEnd: last.candleTime,
      availableAt: maxAvailableAt,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      openInterest: last.openInterest,
      quality,
      constituents: lineage,
    };
  }
}
