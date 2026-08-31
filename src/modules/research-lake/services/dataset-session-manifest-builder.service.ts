import { Prisma } from '@prisma/client';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import { HistoricalAssetType, HistoricalOptionType } from '../domain/historical-asset.types';
import { CanonicalSessionProjectionOutcome, CanonicalSessionProjectionResult } from '../domain/canonical-session.types';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestCandleContent,
  ManifestDatasetKind,
  OptionSessionIdentity,
  SessionContentIdentity,
  SessionManifest,
  SourceAcquisitionEvidence,
  UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { resolveOptionCandleObservationState } from '../domain/historical-option-candle-observation.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { expectedMinutesForWindows } from '../domain/session-window-expected-minutes.util';
import DatasetHealthValidatorService from './dataset-health-validator.service';

/** Structural shape this builder needs from a persisted `HistoricalCandle`/`HistoricalOptionCandle` row -- deliberately a `Pick`, not the full Prisma model, so this service never depends on fields it does not use (id/createdAt/updatedAt/source/tradingSymbol etc. are irrelevant to manifest content). */
export interface PersistedManifestCandleRow {
  readonly candleTime: Date;
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
}

export interface BuildUnderlyingSessionRequest {
  readonly provider: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly rows: readonly PersistedManifestCandleRow[];
  /**
   * B-F2C: genuine durable retrieval evidence for this exact session, when
   * `DatasetManifestService` found one (see
   * `HistoricalDataRetrievalEvidenceService.findLatestAvailableSessionEvidence`).
   * Omitted (the default, preserving every pre-B-F2C caller's behavior
   * exactly) -- falls back to `UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE`.
   * This builder never fabricates evidence itself; it only ever uses
   * exactly what the caller looked up.
   */
  readonly sourceAcquisitionEvidence?: SourceAcquisitionEvidence;
  /**
   * B-F5 CALENDAR FIX (task invariant A/C): explicit, calendar-authoritative
   * session windows this session's health must be scored against -- REQUIRED
   * by a calendar-aware caller for a SPECIAL_SESSION date (see
   * `ManifestCalendarSessionResolverService`). Omitted (the default,
   * preserving every pre-existing caller's behavior exactly): falls back to
   * the legacy fixed 09:15-15:29 375-row regular-session contract, which is
   * provably identical to the calendar's own REGULAR_SESSION window (see
   * `regularSessionWindow()`).
   */
  readonly sessionWindows?: readonly SessionWindow[];
}

export interface BuildOptionSessionRequest {
  readonly provider: HistoricalProviderId;
  readonly providerContractId: string;
  readonly optionType: HistoricalOptionType;
  readonly strikePrice: Prisma.Decimal | number | string;
  readonly expiry: Date;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly rows: readonly PersistedManifestCandleRow[];
  /** See `BuildUnderlyingSessionRequest.sessionWindows` doc -- identical contract for EXPIRED_OPTION_1M (task invariant B). */
  readonly sessionWindows?: readonly SessionWindow[];
}

/**
 * Builds one `SessionManifest` from already-persisted, already-validated
 * candle rows for exactly one session (task section 9: "should be able to
 * deterministically generate manifests from already persisted validated
 * coverage... do not require a fresh provider API request"). Never calls a
 * provider; never mutates the rows it is given.
 *
 * Reconstructs a synthetic `CanonicalSessionProjectionResult` from the
 * persisted rows (`acceptedRows` = the rows themselves, `excludedRows` = []
 * , `sourceOrderAnomalies` = []) so it can reuse the EXISTING, unmodified
 * `DatasetHealthValidatorService` rather than reimplementing structural
 * health/completeness rules.
 *
 * B-F5 CORRECTION (post-review, root defect): the resulting `DatasetHealthReport`
 * proves the health of the PERSISTED CANONICAL CONTENT only --
 * `persistedCanonicalHealthStatus` in the returned `SessionManifest`. It is
 * NOT, and must never be presented as, the original PROVIDER acquisition
 * health. B-F2/B-F4 never persist excluded rows or source-order-anomaly
 * evidence -- only accepted canonical rows survive into the DB -- so a
 * session whose real raw delivery had pre/post-market rows, duplicates, or
 * out-of-order timestamps that were already excluded before persistence can
 * still legitimately show `persistedCanonicalHealthStatus: HEALTHY` here for
 * the content that remains. `sourceAcquisitionEvidence` is always
 * `UNAVAILABLE_FROM_PERSISTED_STORE` (see `UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE`)
 * -- this builder never fabricates a provider row count, exclusion count,
 * source-order-anomaly count, or source health status; all four stay
 * explicitly unknown rather than being asserted as zero/HEALTHY.
 */
export default class DatasetSessionManifestBuilderService {
  constructor(private readonly validator: DatasetHealthValidatorService = new DatasetHealthValidatorService()) {}

  buildUnderlyingSession(request: BuildUnderlyingSessionRequest): SessionManifest {
    const identity: UnderlyingSessionIdentity = {
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      provider: request.provider,
      instrumentKey: request.instrumentKey,
      timeframe: request.timeframe,
      tradingDate: request.tradingDate,
    };
    return this.build(identity, HistoricalAssetType.NIFTY_INDEX, request.instrumentKey, request.tradingDate, request.rows, null, request.sourceAcquisitionEvidence, request.sessionWindows);
  }

  buildOptionSession(request: BuildOptionSessionRequest): SessionManifest {
    const identity: OptionSessionIdentity = {
      datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
      provider: request.provider,
      providerContractId: request.providerContractId,
      optionType: request.optionType,
      strikePrice: new Prisma.Decimal(request.strikePrice).toString(),
      expiry: request.expiry.toISOString(),
      timeframe: request.timeframe,
      tradingDate: request.tradingDate,
    };
    return this.build(identity, HistoricalAssetType.NIFTY_OPTION, request.providerContractId, request.tradingDate, request.rows, this.countOi(request.rows), undefined, request.sessionWindows);
  }

  private build(
    identity: SessionContentIdentity,
    assetType: HistoricalAssetType,
    instrumentKey: string,
    tradingDate: string,
    rows: readonly PersistedManifestCandleRow[],
    oi: { rowsWithOi: number; rowsWithNullOi: number } | null,
    sourceAcquisitionEvidence?: SourceAcquisitionEvidence,
    sessionWindows?: readonly SessionWindow[]
  ): SessionManifest {
    const sortedRows = [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());

    const candles: ManifestCandleContent[] = sortedRows.map((row) => ({
      candleTime: row.candleTime.toISOString(),
      open: row.open.toString(),
      high: row.high.toString(),
      low: row.low.toString(),
      close: row.close.toString(),
      volume: row.volume.toString(),
      openInterest: row.openInterest === null ? null : row.openInterest.toString(),
    }));

    const projection: CanonicalSessionProjectionResult = {
      outcome: CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED,
      assetType,
      instrumentKey,
      tradingDate,
      sourceRowCount: sortedRows.length,
      acceptedRows: sortedRows.map((row): CanonicalHistoricalCandle => ({
        assetType,
        instrumentKey,
        candleTime: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume,
        openInterest: row.openInterest,
      })),
      excludedRows: [],
      sourceOrderAnomalies: [],
    };

    // B-F5 CALENDAR FIX (task invariant A/C): a non-empty `sessionWindows`
    // means a calendar-aware caller declared this session's REAL windows --
    // score health against exactly those expected minutes (a SPECIAL_SESSION
    // day's real 60-minute window, a multi-window session's disjoint union,
    // ...), never the fixed 375-row default. `undefined`/`[]` preserves the
    // pre-existing default exactly (`DatasetHealthValidatorService.validate`
    // already falls back to the fixed 09:15-15:29 375-row contract when
    // `expectedMinutesIst` is omitted).
    const expectedMinutesIst = sessionWindows && sessionWindows.length > 0 ? expectedMinutesForWindows(sessionWindows) : undefined;
    const report = this.validator.validate(projection, expectedMinutesIst);
    const optionObservationState = identity.datasetKind === ManifestDatasetKind.EXPIRED_OPTION_1M ? resolveOptionCandleObservationState(report) : null;

    const contentChecksum = computeSessionContentChecksum({
      identity,
      canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
      healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
      candles,
    });

    return {
      identity,
      canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
      healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
      contentChecksum,
      canonicalRowCount: sortedRows.length,
      persistedCanonicalHealthStatus: report.status,
      optionObservationState,
      issues: report.issues,
      rowsWithOi: oi?.rowsWithOi ?? null,
      rowsWithNullOi: oi?.rowsWithNullOi ?? null,
      sourceAcquisitionEvidence: sourceAcquisitionEvidence ?? UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE,
      calendarSessionWindows: sessionWindows ?? [],
    };
  }

  private countOi(rows: readonly PersistedManifestCandleRow[]): { rowsWithOi: number; rowsWithNullOi: number } {
    let rowsWithOi = 0;
    let rowsWithNullOi = 0;
    for (const row of rows) {
      if (row.openInterest === null) rowsWithNullOi += 1;
      else rowsWithOi += 1;
    }
    return { rowsWithOi, rowsWithNullOi };
  }
}
