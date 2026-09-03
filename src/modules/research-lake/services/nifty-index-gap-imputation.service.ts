import {
  CandleContentValue,
  CanonicalHistoricalCandle,
  CanonicalSessionDeclaration,
  computeCandleContentChecksum,
  computeSourceRowsSemanticChecksum,
  DatasetHealthStatus,
  expectedCanonicalTimestamps,
  HistoricalAssetType,
  HistoricalSourceCandleRow,
  istMinuteOfDay,
} from '../domain';
import {
  assertNiftyIndexGapImputationAuthorized,
  LINEAR_BOUNDARY_INTERPOLATION_METHOD,
  NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION,
} from '../domain/nifty-index-gap-imputation-authorization';
import {
  computeLinearBoundaryInterpolation,
  LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION,
  NiftyIndexAnchorPrecisionError,
} from '../domain/nifty-index-linear-boundary-interpolation';
import {
  buildObservedIncompleteSessionSnapshot,
  canonicalHistoricalCandleToManifestContent,
  OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_SCHEMA_VERSION,
  OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_ROOT,
  OBSERVED_SNAPSHOT_QUALIFICATION_SEMANTICS_VERSION,
  ObservedIncompleteSessionSnapshotV1,
  storeObservedIncompleteSessionSnapshot,
} from '../domain/observed-incomplete-session-snapshot.types';
import {
  buildDerivedImputedResearchSession,
  DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
  DerivedImputedResearchSessionV1,
  DerivedResearchSessionRowV1,
  ImputationReason,
  IMPUTATION_SEMANTICS_VERSION,
  ImputedRowProvenance,
  ResearchRowProvenanceKind,
  ResearchSessionSourcePrecedenceTier,
  storeDerivedImputedResearchSession,
} from '../domain/derived-imputed-research-session.types';
import { ContentAddressedJsonStoreResult } from '../domain/content-addressed-json-store';
import { HistoricalDataProvider } from '../interfaces/historical-data-provider.interface';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import DatasetHealthValidatorService from './dataset-health-validator.service';
import HistoricalDataRetrievalEvidenceService, {
  QualifiedIncompleteEvidenceAmbiguousError,
  QualifiedIncompleteEvidenceInvariantError,
  QualifiedIncompleteSessionEvidence,
} from './historical-data-retrieval-evidence.service';
import HistoricalProviderRateLimiterService from './historical-provider-rate-limiter.service';
import { HistoricalProviderRetryOptions, HistoricalProviderRetryStats, withHistoricalProviderRetry } from './historical-provider-retry.util';
import UpstoxHistoricalDataProviderService from '../providers/upstox/upstox-historical-data-provider.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';
import NiftyUnderlyingIngestionPlannerService, { NiftyPlannedDateDisposition } from './nifty-underlying-ingestion-planner.service';
import { UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS } from './nifty-underlying-acquisition.service';

const MINUTE_MS = 60_000;

/**
 * B-M7.1: exactly ONE-DATE, exactly ONE-GAP, explicitly-authorized derived
 * research imputation for the 2022-03-07 NIFTY underlying 1-minute session
 * (task section 1). Wholly separate from `NiftyUnderlyingGapRepairService`
 * (real, multi-provider REPAIR of canonical truth) -- this service NEVER
 * writes `HistoricalCandle`, NEVER writes canonical repair evidence, and
 * NEVER mutates the durable `HistoricalDataRetrieval`/`HistoricalDataRetrievalSession`
 * evidence it reads. It produces a research-only, content-addressed derived
 * dataset that a future year-assembly step may consult at
 * `ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION`
 * (tier 3) -- strictly below a healthy real session (tier 1) or an accepted
 * composite-repaired session (tier 2).
 *
 * Flow for the ONE authorized date (see task sections 3-10 for the exact
 * invariants each step proves; STEP ORDER below matches
 * `buildImputedSession`'s actual code order -- kept in sync deliberately,
 * see the B-M7.1-BLOCKER-02 reordering note on step 4): (1) read-only
 * qualification of the durable terminal INCOMPLETE evidence for 2022-03-07
 * against the locked 375/372 facts; (2) a controlled, zero-write,
 * single-date re-observation via the primary provider, cross-checked
 * byte-for-byte (via `sourceRowsSemanticChecksum`) against that durable
 * evidence -- FAILS CLOSED on any drift, including the provider now
 * returning a complete session; (3) the single allowlisted authorization
 * gate (`assertNiftyIndexGapImputationAuthorized`) -- the ONLY point any
 * synthetic candle may be constructed; (4) deterministic `Prisma.Decimal`
 * boundary interpolation for the 3 missing minutes, which also PROVES both
 * real anchors are already exactly representable at the supported 2dp
 * policy scale -- FAILS CLOSED (never silently rounds a real anchor) on
 * unsupported precision, before anything is built or persisted; (5) only
 * once interpolation has succeeded, an immutable, content-addressed
 * `ObservedIncompleteSessionSnapshotV1` built from the 372 qualified rows;
 * (6) a 375-row derived session assembled in expected-minute order, with
 * explicit per-row OBSERVED/IMPUTED provenance and no-lookahead
 * `availableAt` semantics (task section 9).
 */
export default class NiftyIndexGapImputationService {
  private readonly primaryProvider: HistoricalDataProvider;
  private readonly plannerService: NiftyUnderlyingIngestionPlannerService;
  private readonly projector: CanonicalSessionProjectorService;
  private readonly validator: DatasetHealthValidatorService;
  private readonly retrievalEvidenceService: HistoricalDataRetrievalEvidenceService;
  private readonly primaryRateLimiter: HistoricalProviderRateLimiterService;
  private readonly retryOptions: HistoricalProviderRetryOptions;
  private readonly archiveRoot: string;
  private readonly persistArtifactsToDisk: boolean;

  constructor(dependencies: NiftyIndexGapImputationServiceDependencies = {}) {
    this.primaryProvider = dependencies.primaryProvider ?? new UpstoxHistoricalDataProviderService();
    this.plannerService = dependencies.plannerService ?? new NiftyUnderlyingIngestionPlannerService();
    this.projector = dependencies.projector ?? new CanonicalSessionProjectorService();
    this.validator = dependencies.validator ?? new DatasetHealthValidatorService();
    this.retrievalEvidenceService = dependencies.retrievalEvidenceService ?? new HistoricalDataRetrievalEvidenceService();
    this.primaryRateLimiter = dependencies.primaryRateLimiter ?? new HistoricalProviderRateLimiterService(UPSTOX_HISTORICAL_MIN_REQUEST_INTERVAL_MS);
    this.retryOptions = dependencies.retryOptions ?? {};
    this.archiveRoot = dependencies.archiveRoot ?? OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_ROOT;
    this.persistArtifactsToDisk = dependencies.persistArtifactsToDisk ?? true;
  }

  async buildImputedSession(request: NiftyIndexGapImputationRequest): Promise<NiftyIndexGapImputationResult> {
    const tradingDate = request.tradingDate;
    const authorization = NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION;

    // Cheap, zero-I/O guard BEFORE any DB read or provider call (task section
    // 6): only the one exact allowlisted tradingDate ever proceeds past here.
    if (tradingDate !== authorization.tradingDate) {
      throw new NiftyIndexGapImputationError(
        'DATE_NOT_AUTHORIZED',
        `No gap-imputation authorization exists for tradingDate '${tradingDate}'; only '${authorization.tradingDate}' is authorized (${authorization.authorizationId}).`
      );
    }

    // ---- Step 1 (task section 3): read-only qualification against durable historical evidence ----
    // B-M7.1 CORRECTION (real production reproduction, 2022-03-07): this
    // re-observation is itself an exact single-date request (`fromTradingDate
    // === toTradingDate === tradingDate` below), so its checksum comparison
    // baseline MUST be drawn only from durable evidence produced by an
    // equally exact-scoped parent retrieval -- `SOURCE_ROWS_CHECKSUM_VERSION=1`
    // folds each row's request-array-relative `sourceIndex` into the digest,
    // so a monthly-chunk evidence row for this same trading date is NOT
    // checksum-comparable to this fresh exact-day fetch even when the
    // underlying OHLC content never drifted. See `RequiredRetrievalRange`'s
    // doc in `historical-data-retrieval-evidence.service.ts`.
    let qualified: QualifiedIncompleteSessionEvidence | null;
    try {
      qualified = await this.retrievalEvidenceService.findTerminalIncompleteSessionEvidence({
        expectedProviderId: HistoricalProviderId.UPSTOX,
        instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
        timeframe: NIFTY_UNDERLYING_TIMEFRAME,
        tradingDate,
        requiredRetrievalRange: { fromDate: tradingDate, toDate: tradingDate },
      });
    } catch (error) {
      // Only the two EXPECTED, typed, fail-closed evidence-qualification
      // domain errors are converted here -- never a provider/network error
      // (this call makes no provider call at all), and never any other
      // unexpected error, which is deliberately re-thrown unconverted so it
      // still surfaces as the runner's own UNEXPECTED_ERROR path rather than
      // being misreported as a durable-evidence condition it is not.
      if (error instanceof QualifiedIncompleteEvidenceAmbiguousError) {
        throw new NiftyIndexGapImputationError('DURABLE_EVIDENCE_AMBIGUOUS', error.message, error);
      }
      if (error instanceof QualifiedIncompleteEvidenceInvariantError) {
        throw new NiftyIndexGapImputationError('DURABLE_EVIDENCE_INVARIANT_FAILED', error.message, error);
      }
      throw error;
    }
    if (!qualified) {
      throw new NiftyIndexGapImputationError(
        'NO_DURABLE_INCOMPLETE_EVIDENCE',
        `No terminal INCOMPLETE durable evidence exists for UPSTOX ${NIFTY_INDEX_INSTRUMENT_KEY}/${NIFTY_UNDERLYING_TIMEFRAME}/${tradingDate}; cannot qualify for gap imputation.`
      );
    }
    this.assertLockedQualificationFacts(qualified);

    // ---- Step 2 (task section 4): controlled, single-date, ZERO-WRITE re-observation ----
    const plan = await this.plannerService.buildPlan({ fromDate: tradingDate, toDate: tradingDate });
    if (plan.hasBlockedDates) {
      throw new NiftyIndexGapImputationError('CALENDAR_BLOCKED', `Calendar truth for ${tradingDate} is UNCERTIFIED; gap imputation fails closed before any provider call.`);
    }
    const planned = plan.dates.find((date) => date.tradingDate === tradingDate);
    if (!planned || planned.disposition !== NiftyPlannedDateDisposition.REGULAR_TRADING_DAY) {
      throw new NiftyIndexGapImputationError(
        'CALENDAR_NOT_FETCH_ELIGIBLE',
        `${tradingDate} resolved to calendar disposition ${planned?.disposition ?? 'UNKNOWN'}, not REGULAR_TRADING_DAY; gap imputation does not apply.`
      );
    }

    const retryStats: HistoricalProviderRetryStats = { retryCount: 0, rateLimitBackoffCount: 0 };
    let rawRows: readonly HistoricalSourceCandleRow[];
    try {
      rawRows = await withHistoricalProviderRetry(
        () =>
          this.primaryRateLimiter.schedule(() =>
            this.primaryProvider.fetchCompletedUnderlyingRange({
              assetType: HistoricalAssetType.NIFTY_INDEX,
              instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
              interval: NIFTY_UNDERLYING_TIMEFRAME,
              fromTradingDate: tradingDate,
              toTradingDate: tradingDate,
            })
          ),
        retryStats,
        this.retryOptions
      );
    } catch (error) {
      throw new NiftyIndexGapImputationError(
        'PRIMARY_FETCH_FAILED',
        `The controlled re-observation fetch for ${tradingDate} failed; see 'cause'. This service performs no durable evidence writes of any kind, so no evidence was left behind by this attempt.`,
        error
      );
    }

    const currentSourceRowsSemanticChecksum = computeSourceRowsSemanticChecksum(rawRows);
    if (currentSourceRowsSemanticChecksum !== qualified.sourceRowsSemanticChecksum) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_CHECKSUM_DRIFT',
        `The current re-observation's sourceRowsSemanticChecksum ('${currentSourceRowsSemanticChecksum}') does not match the qualified durable evidence's checksum ('${qualified.sourceRowsSemanticChecksum}') for ${tradingDate}. The provider's content has changed since the original incomplete observation -- failing closed rather than imputing over drifted source data.`
      );
    }

    const projection = this.projector.project({
      assetType: HistoricalAssetType.NIFTY_INDEX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      tradingDate,
      sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
      sessionWindows: planned.sessionWindows,
      sourceRows: rawRows,
    });
    const report = this.validator.validate(projection, planned.expectedMinutesIst);

    if (report.status === DatasetHealthStatus.HEALTHY || report.status === DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_NO_LONGER_INCOMPLETE',
        `The provider now returns a complete session for ${tradingDate} (health=${report.status}); the previously incomplete source has changed. Failing closed for the gap-imputation path -- this milestone never fabricates synthetic candles once real data is available.`
      );
    }
    if (report.status !== DatasetHealthStatus.INCOMPLETE) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_HEALTH_NOT_INCOMPLETE',
        `The current re-observation for ${tradingDate} has health=${report.status}, not INCOMPLETE; gap imputation does not apply to this failure mode.`
      );
    }
    if (report.canonicalRowCount !== qualified.acceptedRowCount) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_ROW_COUNT_MISMATCH',
        `The current re-observation accepted ${report.canonicalRowCount} row(s) for ${tradingDate}; the qualified durable evidence recorded ${qualified.acceptedRowCount}. Failing closed rather than imputing over a different row count.`
      );
    }
    if (report.excludedRowCount !== 0 || projection.sourceOrderAnomalies.length !== 0) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_UNEXPECTED_EXCLUSION',
        `The current re-observation for ${tradingDate} has ${report.excludedRowCount} excluded row(s) and ${projection.sourceOrderAnomalies.length} source-order anomaly(ies); gap imputation requires a clean re-observation with no unexpected exclusion/order anomaly.`
      );
    }

    const expectedTimestamps = expectedCanonicalTimestamps(tradingDate, planned.expectedMinutesIst);
    const acceptedByTime = new Map(projection.acceptedRows.map((row) => [row.candleTime.getTime(), row]));
    const missingTimestamps = expectedTimestamps.filter((timestamp) => !acceptedByTime.has(timestamp.getTime()));
    const missingMinutesIst = missingTimestamps.map((timestamp) => istMinuteOfDay(timestamp)).sort((left, right) => left - right);

    const authorizedMissingSet = [...authorization.missingMinutesIst];
    const missingSetMatches =
      missingMinutesIst.length === authorizedMissingSet.length && missingMinutesIst.every((minute, index) => minute === authorizedMissingSet[index]);
    if (!missingSetMatches) {
      throw new NiftyIndexGapImputationError(
        'SOURCE_MISSING_MINUTE_SET_MISMATCH',
        `The current re-observation for ${tradingDate} is missing minute(s) [${missingMinutesIst.join(', ')}] IST; only the authorized set [${authorizedMissingSet.join(', ')}] is expected. Failing closed.`
      );
    }

    const leftAnchorTimestamp = this.timestampForMinute(expectedTimestamps, planned.expectedMinutesIst, authorization.leftAnchorMinuteIst);
    const rightAnchorTimestamp = this.timestampForMinute(expectedTimestamps, planned.expectedMinutesIst, authorization.rightAnchorMinuteIst);
    const leftAnchorCandle = acceptedByTime.get(leftAnchorTimestamp.getTime());
    const rightAnchorCandle = acceptedByTime.get(rightAnchorTimestamp.getTime());
    // Defensive guards kept even though `missingSetMatches` above already
    // proves 10:21/10:25 are NOT among the missing minutes (the authorized
    // set contains neither), so both lookups are logically guaranteed to hit
    // here -- task section 4 lists "10:21 IST exists as a valid real observed
    // candle"/"10:25 IST exists" as invariants this method must independently
    // prove, so this is stated as an explicit fail-closed check rather than a
    // silent non-null assertion (mirrors this codebase's own established
    // convention, e.g. `HistoricalDataRetrievalEvidenceService.
    // findLatestAvailableSessionEvidence`'s "Defensive null-check kept even
    // though the WHERE clause above already excludes..." guard).
    if (!leftAnchorCandle) {
      throw new NiftyIndexGapImputationError('SOURCE_ANCHOR_MISSING', `The required left-anchor candle at ${leftAnchorTimestamp.toISOString()} (10:21 IST) is missing from the current re-observation for ${tradingDate}.`);
    }
    if (!rightAnchorCandle) {
      throw new NiftyIndexGapImputationError('SOURCE_ANCHOR_MISSING', `The required right-anchor candle at ${rightAnchorTimestamp.toISOString()} (10:25 IST) is missing from the current re-observation for ${tradingDate}.`);
    }

    // ---- Step 3 (task section 6): the ONE explicit authorization gate -- no synthetic candle may be constructed before this passes ----
    assertNiftyIndexGapImputationAuthorized({
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      tradingDate,
      missingMinutesIst,
    });

    // ---- Step 4 (task section 7): deterministic Prisma.Decimal boundary interpolation ----
    // B-M7.1-BLOCKER-02 CORRECTION: this now also PROVES both real anchors
    // are already exactly representable at the supported 2dp policy scale
    // (see `computeLinearBoundaryInterpolation`'s own doc) -- throws
    // `NiftyIndexAnchorPrecisionError`, wrapped below, rather than silently
    // rounding a real anchor. Deliberately placed BEFORE the observed
    // snapshot is built/persisted (moved down from its prior position) so
    // an unsupported-precision failure here leaves NEITHER the snapshot NOR
    // the derived session built or written to disk -- nothing is persisted
    // from a session this milestone cannot faithfully represent.
    let interpolation;
    try {
      interpolation = computeLinearBoundaryInterpolation({
        leftAnchorClose: leftAnchorCandle.close,
        rightAnchorOpen: rightAnchorCandle.open,
      });
    } catch (error) {
      if (error instanceof NiftyIndexAnchorPrecisionError) {
        throw new NiftyIndexGapImputationError('UNSUPPORTED_ANCHOR_PRICE_PRECISION', error.message, error);
      }
      throw error;
    }

    // ---- Step 5 (task section 5): build + optionally persist the immutable observed snapshot ----
    // Only reached once interpolation has already succeeded (see Step 4's
    // doc) -- a real-anchor precision failure can never leave a snapshot
    // artifact behind.
    const snapshotRows = projection.acceptedRows.map(canonicalHistoricalCandleToManifestContent);
    const snapshot = buildObservedIncompleteSessionSnapshot({
      schemaVersion: OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_SCHEMA_VERSION,
      qualificationSemanticsVersion: OBSERVED_SNAPSHOT_QUALIFICATION_SEMANTICS_VERSION,
      identity: { providerId: HistoricalProviderId.UPSTOX, instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, tradingDate },
      sessionWindows: planned.sessionWindows,
      expectedMinuteCount: planned.expectedMinuteCount,
      observedRowCount: projection.acceptedRows.length,
      rows: snapshotRows,
      missingExpectedMinutesIst: missingMinutesIst,
      sourceRowsSemanticChecksum: currentSourceRowsSemanticChecksum,
      durableHistoricalEvidenceSemanticChecksum: qualified.evidenceSemanticChecksum,
    });

    const observedSnapshotStorage = this.persistArtifactsToDisk ? storeObservedIncompleteSessionSnapshot(this.archiveRoot, snapshot) : null;

    // ---- Step 6 (task section 8/9): provenance + no-lookahead availability ----
    const leftAnchorContentChecksum = computeCandleContentChecksum(this.toContentValue(leftAnchorCandle));
    const rightAnchorContentChecksum = computeCandleContentChecksum(this.toContentValue(rightAnchorCandle));
    // The earliest instant the full right-anchor 10:25 candle is known complete (task section 9) -- one minute after ITS OWN candleTime, the SAME "1 minute after this row's own completion" convention every other 1-minute candle in this Research Lake uses. Every imputed row shares this SAME instant, never its own nominal completion time.
    const rightAnchorAvailableAt = new Date(rightAnchorCandle.candleTime.getTime() + MINUTE_MS);

    const imputedProvenanceBase: Omit<ImputedRowProvenance, 'kind'> = {
      method: LINEAR_BOUNDARY_INTERPOLATION_METHOD,
      policyVersion: LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION,
      authorizationId: authorization.authorizationId,
      reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
      leftAnchor: { candleTime: leftAnchorCandle.candleTime.toISOString(), field: 'CLOSE', contentChecksum: leftAnchorContentChecksum },
      rightAnchor: { candleTime: rightAnchorCandle.candleTime.toISOString(), field: 'OPEN', contentChecksum: rightAnchorContentChecksum },
      sourceSnapshotChecksum: snapshot.snapshotContentChecksum,
    };

    const imputedRowsByTimestamp = new Map<number, DerivedResearchSessionRowV1>();
    authorization.missingMinutesIst.forEach((minuteIst, index) => {
      const timestamp = this.timestampForMinute(expectedTimestamps, planned.expectedMinutesIst, minuteIst);
      const ohlc = interpolation.candles[index];
      imputedRowsByTimestamp.set(timestamp.getTime(), {
        candleTime: timestamp.toISOString(),
        open: ohlc.open.toFixed(),
        high: ohlc.high.toFixed(),
        low: ohlc.low.toFixed(),
        close: ohlc.close.toFixed(),
        volume: '0',
        openInterest: null,
        availableAt: rightAnchorAvailableAt.toISOString(),
        provenance: { kind: ResearchRowProvenanceKind.IMPUTED, ...imputedProvenanceBase },
      });
    });

    // ---- Step 7 (task section 10): assemble the 375-row derived session, in expected-minute order, by construction (never sort-after-merge) ----
    const rows: DerivedResearchSessionRowV1[] = expectedTimestamps.map((timestamp) => {
      const imputedRow = imputedRowsByTimestamp.get(timestamp.getTime());
      if (imputedRow) return imputedRow;
      const observedCandle = acceptedByTime.get(timestamp.getTime());
      if (!observedCandle) {
        // Unreachable given the missing-minute-set equality check above (every expected minute is either accepted or in the authorized missing set) -- kept as an explicit fail-closed guard rather than a silent non-null assertion.
        throw new NiftyIndexGapImputationError('SOURCE_MISSING_MINUTE_SET_MISMATCH', `No observed or imputed row is available for expected minute ${timestamp.toISOString()} on ${tradingDate}.`);
      }
      const manifestContent = canonicalHistoricalCandleToManifestContent(observedCandle);
      return {
        ...manifestContent,
        availableAt: new Date(observedCandle.candleTime.getTime() + MINUTE_MS).toISOString(),
        provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: snapshot.snapshotContentChecksum },
      };
    });

    const derivedSession = buildDerivedImputedResearchSession({
      schemaVersion: DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
      imputationSemanticsVersion: IMPUTATION_SEMANTICS_VERSION,
      identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, tradingDate },
      authorizationId: authorization.authorizationId,
      sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
      sourceSnapshotChecksum: snapshot.snapshotContentChecksum,
      rows,
      realRowCount: projection.acceptedRows.length,
      imputedRowCount: authorization.missingMinutesIst.length,
      precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    });

    const derivedSessionStorage = this.persistArtifactsToDisk ? storeDerivedImputedResearchSession(this.archiveRoot, derivedSession) : null;

    return { tradingDate, observedSnapshot: snapshot, derivedSession, observedSnapshotStorage, derivedSessionStorage };
  }

  private assertLockedQualificationFacts(qualified: QualifiedIncompleteSessionEvidence): void {
    const mismatches: string[] = [];
    if (qualified.calendarDisposition !== NiftyPlannedDateDisposition.REGULAR_TRADING_DAY) {
      mismatches.push(`calendarDisposition='${qualified.calendarDisposition}' (expected '${NiftyPlannedDateDisposition.REGULAR_TRADING_DAY}')`);
    }
    if (qualified.expectedMinuteCount !== 375) mismatches.push(`expectedMinuteCount=${qualified.expectedMinuteCount} (expected 375)`);
    if (qualified.providerRowCountForDate !== 372) mismatches.push(`providerRowCountForDate=${qualified.providerRowCountForDate} (expected 372)`);
    if (qualified.acceptedRowCount !== 372) mismatches.push(`acceptedRowCount=${qualified.acceptedRowCount} (expected 372)`);
    if (mismatches.length > 0) {
      throw new NiftyIndexGapImputationError(
        'DURABLE_EVIDENCE_FACTS_MISMATCH',
        `Durable historical evidence for ${qualified.instrumentKey}/${qualified.timeframe}/${qualified.tradingDate} does not support the locked B-M7.1 facts: ${mismatches.join('; ')}.`
      );
    }
  }

  private timestampForMinute(expectedTimestamps: readonly Date[], expectedMinutesIst: readonly number[], minuteIst: number): Date {
    const index = expectedMinutesIst.indexOf(minuteIst);
    if (index === -1) {
      throw new NiftyIndexGapImputationError('DURABLE_EVIDENCE_FACTS_MISMATCH', `Minute ${minuteIst} IST is not part of this trading date's expected minute set.`);
    }
    return expectedTimestamps[index];
  }

  private toContentValue(candle: CanonicalHistoricalCandle): CandleContentValue {
    return {
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      openInterest: candle.openInterest,
    };
  }
}

export type NiftyIndexGapImputationErrorCode =
  | 'DATE_NOT_AUTHORIZED'
  | 'NO_DURABLE_INCOMPLETE_EVIDENCE'
  | 'DURABLE_EVIDENCE_AMBIGUOUS'
  | 'DURABLE_EVIDENCE_INVARIANT_FAILED'
  | 'DURABLE_EVIDENCE_FACTS_MISMATCH'
  | 'CALENDAR_BLOCKED'
  | 'CALENDAR_NOT_FETCH_ELIGIBLE'
  | 'PRIMARY_FETCH_FAILED'
  | 'SOURCE_CHECKSUM_DRIFT'
  | 'SOURCE_NO_LONGER_INCOMPLETE'
  | 'SOURCE_HEALTH_NOT_INCOMPLETE'
  | 'SOURCE_ROW_COUNT_MISMATCH'
  | 'SOURCE_UNEXPECTED_EXCLUSION'
  | 'SOURCE_MISSING_MINUTE_SET_MISMATCH'
  | 'SOURCE_ANCHOR_MISSING'
  | 'UNSUPPORTED_ANCHOR_PRICE_PRECISION';

/** Single typed error class for every B-M7.1 fail-closed stop condition (task sections 4/15) -- `code` is the stable, machine-checkable discriminator; `message` and `cause` carry the human-readable/underlying detail. */
export class NiftyIndexGapImputationError extends Error {
  constructor(readonly code: NiftyIndexGapImputationErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NiftyIndexGapImputationError';
  }
}

export interface NiftyIndexGapImputationServiceDependencies {
  readonly primaryProvider?: HistoricalDataProvider;
  readonly plannerService?: NiftyUnderlyingIngestionPlannerService;
  readonly projector?: CanonicalSessionProjectorService;
  readonly validator?: DatasetHealthValidatorService;
  readonly retrievalEvidenceService?: HistoricalDataRetrievalEvidenceService;
  readonly primaryRateLimiter?: HistoricalProviderRateLimiterService;
  readonly retryOptions?: HistoricalProviderRetryOptions;
  /** Root directory the observed-snapshot/derived-session content-addressed artifacts are written under. Defaults to the repo's own `artifacts/research-lake` root. */
  readonly archiveRoot?: string;
  /** `false` skips writing the snapshot/derived-session artifacts to disk -- the full in-memory result is still returned either way. Defaults to `true`. */
  readonly persistArtifactsToDisk?: boolean;
}

export interface NiftyIndexGapImputationRequest {
  /** Required, YYYY-MM-DD. Must exactly equal the one authorized tradingDate -- see `assertNiftyIndexGapImputationAuthorized`. */
  readonly tradingDate: string;
}

export interface NiftyIndexGapImputationResult {
  readonly tradingDate: string;
  readonly observedSnapshot: ObservedIncompleteSessionSnapshotV1;
  readonly derivedSession: DerivedImputedResearchSessionV1;
  readonly observedSnapshotStorage: ContentAddressedJsonStoreResult | null;
  readonly derivedSessionStorage: ContentAddressedJsonStoreResult | null;
}
