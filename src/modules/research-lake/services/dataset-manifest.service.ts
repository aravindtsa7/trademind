import { HistoricalOptionType } from '../domain/historical-asset.types';
import { istTradingDayUtcBounds } from '../domain/ist-session-clock';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  DatasetManifest,
  DatasetManifestSessionCounts,
  DatasetManifestVerificationResult,
  HEALTH_SEMANTICS_VERSION,
  ManifestCalendarSessionWindowsByDate,
  ManifestDatasetKind,
  MANIFEST_SCHEMA_VERSION,
  OptionSessionIdentity,
  SessionManifest,
  SessionVerificationResult,
  UnderlyingSessionIdentity,
  assertNoDuplicateSessionIdentities,
  computeDatasetChecksum,
  deriveDatasetId,
} from '../domain/dataset-manifest.types';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import DatasetSessionManifestBuilderService from './dataset-session-manifest-builder.service';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';

export interface GenerateUnderlyingDatasetManifestRequest {
  readonly provider: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  /** Explicit, non-empty, deduplicated list of IST trading dates (`YYYY-MM-DD`). Never defaulted/inferred (task section 13/18: "no default all years"). */
  readonly tradingDates: readonly string[];
  readonly gitRevision?: string | null;
  /**
   * B-F5 CALENDAR FIX (task invariant A/C): explicit, calendar-authoritative
   * session windows, keyed by tradingDate, that a calendar-aware caller (see
   * `ManifestCalendarSessionResolverService`) resolved for this request --
   * REQUIRED for a SPECIAL_SESSION date so it is never scored against the
   * fixed 375-row regular contract. A date absent from this map falls back
   * to that fixed default, which is provably correct for an ordinary
   * REGULAR_SESSION date (see `regularSessionWindow()`); omitting the whole
   * map preserves every pre-existing caller's behavior exactly.
   */
  readonly calendarSessionWindows?: ManifestCalendarSessionWindowsByDate;
}

export interface GenerateOptionDatasetManifestRequest {
  readonly provider: HistoricalProviderId;
  readonly providerContractId: string;
  readonly optionType: HistoricalOptionType;
  readonly strikePrice: number;
  readonly expiry: Date;
  readonly timeframe: string;
  readonly tradingDates: readonly string[];
  readonly gitRevision?: string | null;
  /** See `GenerateUnderlyingDatasetManifestRequest.calendarSessionWindows` doc -- identical contract for EXPIRED_OPTION_1M (task invariant B). */
  readonly calendarSessionWindows?: ManifestCalendarSessionWindowsByDate;
}

export interface DatasetManifestServiceDependencies {
  readonly historicalCandleRepository?: HistoricalCandleRepository;
  readonly historicalOptionCandleLakeRepository?: HistoricalOptionCandleLakeRepository;
  readonly sessionBuilder?: DatasetSessionManifestBuilderService;
  /**
   * B-F2C invariant 13: looked up per underlying session to expose genuine
   * durable retrieval evidence (never fabricated) instead of the
   * unconditional `UNAVAILABLE_FROM_PERSISTED_STORE` every pre-B-F2C
   * manifest reported. Defaults to a real, Prisma-backed
   * `HistoricalDataRetrievalEvidenceService`. Option manifests are
   * unaffected (out of scope for B-F2C -- see `generateOptionManifest`).
   */
  readonly retrievalEvidenceService?: HistoricalDataRetrievalEvidenceService;
}

/**
 * B-F5 GENERATE/VERIFY orchestrator. Reconstructs deterministic dataset
 * manifests entirely from already-persisted, already-validated candle rows
 * (never a fresh provider fetch -- task section 9/15/18). One instance
 * handles both dataset kinds (task section 17): the underlying/option split
 * is expressed through which repository + identity shape is used, never
 * through duplicated orchestration logic.
 */
export default class DatasetManifestService {
  private readonly historicalCandleRepository: HistoricalCandleRepository;
  private readonly historicalOptionCandleLakeRepository: HistoricalOptionCandleLakeRepository;
  private readonly sessionBuilder: DatasetSessionManifestBuilderService;
  private readonly retrievalEvidenceService: HistoricalDataRetrievalEvidenceService;

  constructor(dependencies: DatasetManifestServiceDependencies = {}) {
    this.historicalCandleRepository = dependencies.historicalCandleRepository ?? new HistoricalCandleRepository();
    this.historicalOptionCandleLakeRepository = dependencies.historicalOptionCandleLakeRepository ?? new HistoricalOptionCandleLakeRepository();
    this.sessionBuilder = dependencies.sessionBuilder ?? new DatasetSessionManifestBuilderService();
    this.retrievalEvidenceService = dependencies.retrievalEvidenceService ?? new HistoricalDataRetrievalEvidenceService();
  }

  async generateUnderlyingManifest(request: GenerateUnderlyingDatasetManifestRequest): Promise<DatasetManifest> {
    const tradingDates = this.assertBoundedSortedDates(request.tradingDates);

    const sessions: SessionManifest[] = [];
    for (const tradingDate of tradingDates) {
      const { start, end } = istTradingDayUtcBounds(tradingDate);
      // eslint-disable-next-line no-await-in-loop -- deterministic per-date ordering matters for reproducible logging/failure attribution
      const rows = await this.historicalCandleRepository.findRange(request.instrumentKey, request.timeframe, start, end);
      // B-F2C invariant 13: looked up per date, never fabricated -- a legacy or
      // provider-skipped session genuinely has none, and the builder falls back
      // to UNAVAILABLE_FROM_PERSISTED_STORE when this resolves to `null`.
      // eslint-disable-next-line no-await-in-loop -- see above
      const sourceAcquisitionEvidence = await this.retrievalEvidenceService.findLatestAvailableSessionEvidence(request.instrumentKey, request.timeframe, tradingDate);
      sessions.push(
        this.sessionBuilder.buildUnderlyingSession({
          provider: request.provider,
          instrumentKey: request.instrumentKey,
          timeframe: request.timeframe,
          tradingDate,
          rows,
          sourceAcquisitionEvidence: sourceAcquisitionEvidence ?? undefined,
          sessionWindows: request.calendarSessionWindows?.[tradingDate],
        })
      );
    }

    assertNoDuplicateSessionIdentities(sessions.map((session) => session.identity));

    return this.assembleManifest(ManifestDatasetKind.UNDERLYING_1M, {
      provider: request.provider,
      instrumentDescriptor: request.instrumentKey,
      requestedFromDate: tradingDates[0],
      requestedToDate: tradingDates[tradingDates.length - 1],
      gitRevision: request.gitRevision ?? null,
      requestedCount: request.tradingDates.length,
      sessions,
    });
  }

  async generateOptionManifest(request: GenerateOptionDatasetManifestRequest): Promise<DatasetManifest> {
    const tradingDates = this.assertBoundedSortedDates(request.tradingDates);

    const sessions: SessionManifest[] = [];
    for (const tradingDate of tradingDates) {
      const { start, end } = istTradingDayUtcBounds(tradingDate);
      // eslint-disable-next-line no-await-in-loop -- deterministic per-date ordering matters for reproducible logging/failure attribution
      const rows = await this.historicalOptionCandleLakeRepository.findRange(request.providerContractId, request.timeframe, start, end);
      sessions.push(
        this.sessionBuilder.buildOptionSession({
          provider: request.provider,
          providerContractId: request.providerContractId,
          optionType: request.optionType,
          strikePrice: request.strikePrice,
          expiry: request.expiry,
          timeframe: request.timeframe,
          tradingDate,
          rows,
          sessionWindows: request.calendarSessionWindows?.[tradingDate],
        })
      );
    }

    assertNoDuplicateSessionIdentities(sessions.map((session) => session.identity));

    return this.assembleManifest(ManifestDatasetKind.EXPIRED_OPTION_1M, {
      provider: request.provider,
      instrumentDescriptor: request.providerContractId,
      requestedFromDate: tradingDates[0],
      requestedToDate: tradingDates[tradingDates.length - 1],
      gitRevision: request.gitRevision ?? null,
      requestedCount: request.tradingDates.length,
      sessions,
    });
  }

  /**
   * Recomputes every session in `manifest` fresh from the CURRENT persisted
   * store and compares against the stored manifest -- fail-closed: any
   * checksum mismatch (mutated row, missing row, extra row) is reported,
   * never silently regenerated/overwritten (task section 10/16.R-U).
   */
  async verifyManifest(manifest: DatasetManifest): Promise<DatasetManifestVerificationResult> {
    const sessionResults: SessionVerificationResult[] = [];
    const recomputedInputs: { identity: SessionManifest['identity']; canonicalizationVersion: number; healthSemanticsVersion: number; contentChecksum: string }[] = [];

    for (const original of manifest.sessions) {
      const { start, end } = istTradingDayUtcBounds(original.identity.tradingDate);
      let recomputed: SessionManifest;
      if (original.identity.datasetKind === ManifestDatasetKind.UNDERLYING_1M) {
        const identity = original.identity as UnderlyingSessionIdentity;
        // eslint-disable-next-line no-await-in-loop -- verification must attribute failures to a specific trading date, one date at a time
        const rows = await this.historicalCandleRepository.findRange(identity.instrumentKey, identity.timeframe, start, end);
        // B-F5 CALENDAR FIX: reuses the ORIGINAL manifest's own recorded
        // `calendarSessionWindows` (never a fresh live calendar lookup --
        // verify stays entirely persisted-store/manifest-artifact driven,
        // task section 9/15) so a SPECIAL_SESSION date's health is
        // recomputed against the SAME windows generation used.
        recomputed = this.sessionBuilder.buildUnderlyingSession({
          provider: identity.provider,
          instrumentKey: identity.instrumentKey,
          timeframe: identity.timeframe,
          tradingDate: identity.tradingDate,
          rows,
          sessionWindows: original.calendarSessionWindows,
        });
      } else {
        const identity = original.identity as OptionSessionIdentity;
        // eslint-disable-next-line no-await-in-loop -- see above
        const rows = await this.historicalOptionCandleLakeRepository.findRange(identity.providerContractId, identity.timeframe, start, end);
        recomputed = this.sessionBuilder.buildOptionSession({
          provider: identity.provider,
          providerContractId: identity.providerContractId,
          optionType: identity.optionType,
          strikePrice: identity.strikePrice,
          expiry: new Date(identity.expiry),
          timeframe: identity.timeframe,
          tradingDate: identity.tradingDate,
          rows,
          sessionWindows: original.calendarSessionWindows,
        });
      }

      const matches = recomputed.contentChecksum === original.contentChecksum;
      sessionResults.push({
        tradingDate: original.identity.tradingDate,
        matches,
        originalContentChecksum: original.contentChecksum,
        recomputedContentChecksum: recomputed.contentChecksum,
        originalCanonicalRowCount: original.canonicalRowCount,
        recomputedCanonicalRowCount: recomputed.canonicalRowCount,
        originalPersistedCanonicalHealthStatus: original.persistedCanonicalHealthStatus,
        // Recomputed the same way `generate` computes it -- purely from the CURRENT
        // persisted rows via the unmodified DatasetHealthValidatorService. Never a
        // source-acquisition value: B-F5 has no path to that evidence, so there is
        // nothing here to synthesize as HEALTHY.
        recomputedPersistedCanonicalHealthStatus: recomputed.persistedCanonicalHealthStatus,
      });
      recomputedInputs.push({ identity: recomputed.identity, canonicalizationVersion: recomputed.canonicalizationVersion, healthSemanticsVersion: recomputed.healthSemanticsVersion, contentChecksum: recomputed.contentChecksum });
    }

    const recomputedDatasetChecksum = computeDatasetChecksum(recomputedInputs);
    const datasetChecksumMatches = recomputedDatasetChecksum === manifest.datasetChecksum;
    const mismatchedTradingDates = sessionResults.filter((result) => !result.matches).map((result) => result.tradingDate);

    return {
      verified: datasetChecksumMatches && mismatchedTradingDates.length === 0,
      datasetKind: manifest.datasetKind,
      datasetId: manifest.datasetId,
      originalDatasetChecksum: manifest.datasetChecksum,
      recomputedDatasetChecksum,
      datasetChecksumMatches,
      sessionResults,
      mismatchedTradingDates,
    };
  }

  private assembleManifest(
    datasetKind: ManifestDatasetKind,
    input: {
      provider: HistoricalProviderId;
      instrumentDescriptor: string;
      requestedFromDate: string;
      requestedToDate: string;
      gitRevision: string | null;
      requestedCount: number;
      sessions: readonly SessionManifest[];
    }
  ): DatasetManifest {
    const datasetChecksum = computeDatasetChecksum(
      input.sessions.map((session) => ({ identity: session.identity, canonicalizationVersion: session.canonicalizationVersion, healthSemanticsVersion: session.healthSemanticsVersion, contentChecksum: session.contentChecksum }))
    );
    const sessions = [...input.sessions].sort((left, right) => (left.identity.tradingDate < right.identity.tradingDate ? -1 : left.identity.tradingDate > right.identity.tradingDate ? 1 : 0));

    return {
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      datasetKind,
      canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
      healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
      datasetChecksum,
      datasetId: deriveDatasetId(datasetKind, datasetChecksum),
      provenance: {
        provider: input.provider,
        datasetKind,
        instrumentDescriptor: input.instrumentDescriptor,
        requestedFromDate: input.requestedFromDate,
        requestedToDate: input.requestedToDate,
        acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION',
        gitRevision: input.gitRevision,
      },
      generatedAt: new Date().toISOString(),
      sessions,
      sessionCounts: this.sessionCounts(input.requestedCount, sessions),
    };
  }

  /** Rolls up `sessions[].persistedCanonicalHealthStatus` only -- describes persisted canonical content, never source-acquisition health (task correction). */
  private sessionCounts(requested: number, sessions: readonly SessionManifest[]): DatasetManifestSessionCounts {
    const byPersistedCanonicalHealthStatus = Object.fromEntries(Object.values(DatasetHealthStatus).map((status) => [status, 0])) as Record<DatasetHealthStatus, number>;
    for (const session of sessions) byPersistedCanonicalHealthStatus[session.persistedCanonicalHealthStatus] += 1;

    const healthy = byPersistedCanonicalHealthStatus[DatasetHealthStatus.HEALTHY] + byPersistedCanonicalHealthStatus[DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS];
    const incomplete = byPersistedCanonicalHealthStatus[DatasetHealthStatus.INCOMPLETE];
    const invalid =
      byPersistedCanonicalHealthStatus[DatasetHealthStatus.INVALID] +
      byPersistedCanonicalHealthStatus[DatasetHealthStatus.METADATA_INCOMPLETE] +
      byPersistedCanonicalHealthStatus[DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED] +
      byPersistedCanonicalHealthStatus[DatasetHealthStatus.PROVIDER_UNAVAILABLE];

    return { requested, included: sessions.length, healthy, incomplete, invalid, byPersistedCanonicalHealthStatus };
  }

  private assertBoundedSortedDates(tradingDates: readonly string[]): string[] {
    if (tradingDates.length === 0) {
      throw new Error('DatasetManifestService requires an explicit, non-empty tradingDates list -- it never defaults to a bulk/full-history scan (task section 13/18).');
    }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    for (const date of tradingDates) {
      if (!datePattern.test(date)) throw new Error(`Invalid tradingDate '${date}': expected YYYY-MM-DD.`);
    }
    const unique = new Set(tradingDates);
    if (unique.size !== tradingDates.length) {
      throw new Error('DatasetManifestService requires tradingDates to be free of duplicates -- a duplicate logical session request is rejected, never silently deduplicated.');
    }
    return [...tradingDates].sort();
  }
}
