import { join } from 'path';
import { canonicalManifestJson, sha256Hex } from '../domain/dataset-manifest-canonical-json';
import { DatasetManifest, ManifestDatasetKind, deriveDatasetId } from '../domain/dataset-manifest.types';
import { formatMinuteOfDayIst, SessionWindow } from '../domain/exchange-calendar.types';
import { istCalendarDate, istMinuteOfDay } from '../domain/ist-session-clock';
import { expectedMinutesForWindows } from '../domain/session-window-expected-minutes.util';
import { ResearchRowProvenanceKind, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ResearchSessionSourceSelection } from '../domain/research-session-source-selection';
import { readResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, ResearchUnderlyingDatasetAssemblyV1 } from '../domain/research-underlying-assembly.types';
import {
  readResearchUnderlyingResamplingManifest,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_ROOT,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestV1,
} from '../domain/research-underlying-resampling-manifest.types';
import { ResampleTargetTimeframe, resampleBucketMinutes } from '../domain/resampled-candle.types';
import { ResearchResampledCandle } from '../domain/research-underlying-resampled-candle.types';
import { CANONICAL_DATASET_MANIFEST_ARTIFACT_ROOT, readCanonicalDatasetManifestArtifact } from '../domain/canonical-dataset-manifest-artifact-store';
import { fileExists, readFileBuffer } from '../domain/atomic-file-writer';
import { ContentAddressedJsonStoreResult } from '../domain/content-addressed-json-store';
import { ParquetDatasetStorageDescriptor, parquetStorageManifestRelativePath } from '../domain/parquet-storage.types';
import {
  buildResearchUnderlyingYearCertification,
  CertifiedSessionRecord,
  CertifiedSessionTargetRecord,
  March7NoLookaheadProof,
  March7NoLookaheadProofEntry,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT,
  ResearchUnderlyingYearCertificationV1,
  storeResearchUnderlyingYearCertification,
} from '../domain/research-underlying-year-certification.types';
import ResearchUnderlying1mSessionReaderService, { ResolvedResearchSessionRow, ResolvedResearchRowSourceKind } from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResampledSessionReaderService from './research-underlying-resampled-session-reader.service';
import ManifestCalendarSessionResolverService from './manifest-calendar-session-resolver.service';
import ResearchLakeParquetVerifyService, { DEFAULT_PARQUET_OUTPUT_ROOT } from './research-lake-parquet-verify.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';

export type SessionRowsResolver = Pick<ResearchUnderlying1mSessionReaderService, 'resolveSessionRows'>;
export type ResampledSessionReader = Pick<ResearchUnderlyingResampledSessionReaderService, 'readResampledSession'>;
export type CalendarSessionsResolver = Pick<ManifestCalendarSessionResolverService, 'resolveRequestedSessions' | 'resolveSessionWindowsForDates'>;
export type ParquetVerifier = Pick<ResearchLakeParquetVerifyService, 'verifyStorageDescriptor'>;

export interface NiftyUnderlyingResearchCertificationServiceDependencies {
  readonly sessionRowsResolver?: SessionRowsResolver;
  readonly resampledSessionReader?: ResampledSessionReader;
  readonly calendarSessionsResolver?: CalendarSessionsResolver;
  readonly parquetVerifyService?: ParquetVerifier;
  readonly canonicalManifestArtifactRoot?: string;
  readonly parquetOutputRoot?: string;
  readonly sourceAssemblyRoot?: string;
  readonly resamplingManifestRoot?: string;
  readonly certificationArtifactRoot?: string;
  readonly instrumentKey?: string;
  readonly timeframe?: string;
}

export interface CertifyYearRequest {
  readonly year: number;
  readonly expectedCanonicalDatasetChecksum: string;
  readonly sourceAssemblyChecksum: string;
  readonly resamplingManifestChecksum: string;
}

export interface CertifyYearResult {
  readonly certification: ResearchUnderlyingYearCertificationV1;
  readonly canonicalManifest: DatasetManifest;
  readonly sourceAssembly: ResearchUnderlyingDatasetAssemblyV1;
  readonly resamplingManifest: ResearchUnderlyingResamplingManifestV1;
}

/** Fails closed when canonical Parquet physical storage cannot be proven VERIFIED -- the core B-M8B correction (task: "Do NOT allow parquetStorage.status = UNMATERIALIZED to produce overall COMPLETE certification"). */
export class CertificationCanonicalStorageUnverifiedError extends Error {
  constructor(reason: string) {
    super(`NiftyUnderlyingResearchCertificationService: canonical Parquet physical storage is not verified -- ${reason}. Certification can never report COMPLETE without verified physical storage.`);
    this.name = 'CertificationCanonicalStorageUnverifiedError';
  }
}

/** Fails closed when the trusted B-M7.1/B-M7.2/B-M7.3/canonical-manifest/calendar identities do not all cross-link exactly. */
export class CertificationSourceBindingError extends Error {
  constructor(reason: string) {
    super(`NiftyUnderlyingResearchCertificationService: trusted source binding failed -- ${reason}.`);
    this.name = 'CertificationSourceBindingError';
  }
}

/** Fails closed on any 1-minute-level certification violation for one trading date. */
export class CertificationOneMinuteVerificationError extends Error {
  constructor(
    readonly tradingDate: string,
    reason: string
  ) {
    super(`NiftyUnderlyingResearchCertificationService: 1-minute certification failed for tradingDate '${tradingDate}' -- ${reason}.`);
    this.name = 'CertificationOneMinuteVerificationError';
  }
}

function isRealCanonicalRow(row: ResolvedResearchSessionRow): boolean {
  return row.provenance.sourceKind === ResolvedResearchRowSourceKind.REAL_CANONICAL;
}
function isImputedRow(row: ResolvedResearchSessionRow): boolean {
  return row.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.IMPUTED;
}
function isObservedRow(row: ResolvedResearchSessionRow): boolean {
  return row.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && row.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.OBSERVED;
}

interface CandlesForTarget {
  readonly target: ResampleTargetTimeframe;
  readonly candles: readonly ResearchResampledCandle[];
}

/**
 * B-M8B: a SEPARATE, read-only certification boundary (task: "Use a
 * separate read-only certification service... It must NOT use
 * ResearchYearRunnerService"). Never acquires/materializes anything itself
 * -- it only reads and re-verifies ALREADY-TRUSTED artifacts (the canonical
 * manifest artifact, the B-F6 Parquet storage descriptor, the B-M7.1
 * derived artifact transitively via the B-M7.2 1m reader, the B-M7.2
 * assembly, and the B-M7.3 resampling manifest) through their own existing
 * verified read boundaries, and builds ONE compact, content-addressed
 * `ResearchUnderlyingYearCertificationV1` candidate IN MEMORY.
 *
 * REQUIRES verified physical canonical Parquet storage before it will
 * certify anything (task's core B-M8B correction) -- a missing descriptor,
 * or one that fails `ResearchLakeParquetVerifyService.verifyStorageDescriptor`,
 * or whose date set does not EXACTLY equal the B-M7.2 real-canonical
 * (tier 1/2) date set, throws `CertificationCanonicalStorageUnverifiedError`
 * before any 1m/resampling certification work even begins.
 */
export default class NiftyUnderlyingResearchCertificationService {
  private readonly sessionRowsResolver: SessionRowsResolver;
  private readonly resampledSessionReader: ResampledSessionReader;
  private readonly calendarSessionsResolver: CalendarSessionsResolver;
  private readonly parquetVerifyService: ParquetVerifier;
  private readonly canonicalManifestArtifactRoot: string;
  private readonly parquetOutputRoot: string;
  private readonly sourceAssemblyRoot: string;
  private readonly resamplingManifestRoot: string;
  private readonly certificationArtifactRoot: string;
  private readonly instrumentKey: string;
  private readonly timeframe: string;

  constructor(dependencies: NiftyUnderlyingResearchCertificationServiceDependencies = {}) {
    this.sessionRowsResolver = dependencies.sessionRowsResolver ?? new ResearchUnderlying1mSessionReaderService();
    this.resampledSessionReader = dependencies.resampledSessionReader ?? new ResearchUnderlyingResampledSessionReaderService();
    this.calendarSessionsResolver = dependencies.calendarSessionsResolver ?? new ManifestCalendarSessionResolverService();
    this.parquetVerifyService = dependencies.parquetVerifyService ?? new ResearchLakeParquetVerifyService();
    this.canonicalManifestArtifactRoot = dependencies.canonicalManifestArtifactRoot ?? CANONICAL_DATASET_MANIFEST_ARTIFACT_ROOT;
    this.parquetOutputRoot = dependencies.parquetOutputRoot ?? DEFAULT_PARQUET_OUTPUT_ROOT;
    this.sourceAssemblyRoot = dependencies.sourceAssemblyRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
    this.resamplingManifestRoot = dependencies.resamplingManifestRoot ?? RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_ROOT;
    this.certificationArtifactRoot = dependencies.certificationArtifactRoot ?? RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT;
    this.instrumentKey = dependencies.instrumentKey ?? NIFTY_INDEX_INSTRUMENT_KEY;
    this.timeframe = dependencies.timeframe ?? NIFTY_UNDERLYING_TIMEFRAME;
  }

  async certifyYear(request: CertifyYearRequest): Promise<CertifyYearResult> {
    // ---- 1. require exact canonical manifest artifact. ----
    const datasetId = deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, request.expectedCanonicalDatasetChecksum);
    const canonicalManifest = readCanonicalDatasetManifestArtifact(this.canonicalManifestArtifactRoot, ManifestDatasetKind.UNDERLYING_1M, datasetId);
    if (canonicalManifest.datasetChecksum !== request.expectedCanonicalDatasetChecksum) {
      throw new CertificationSourceBindingError(`canonical manifest artifact's own datasetChecksum '${canonicalManifest.datasetChecksum}' does not equal the expected '${request.expectedCanonicalDatasetChecksum}'`);
    }

    // ---- 2. require exact canonical Parquet descriptor/storage VERIFIED. ----
    const descriptorAbsolutePath = join(this.parquetOutputRoot, parquetStorageManifestRelativePath(canonicalManifest.datasetKind, canonicalManifest.datasetChecksum));
    if (!fileExists(descriptorAbsolutePath)) {
      throw new CertificationCanonicalStorageUnverifiedError(`no canonical Parquet storage descriptor exists at '${descriptorAbsolutePath}' -- physical storage is UNMATERIALIZED`);
    }
    const descriptor = JSON.parse(readFileBuffer(descriptorAbsolutePath).toString('utf8')) as ParquetDatasetStorageDescriptor;
    const parquetVerifyResult = await this.parquetVerifyService.verifyStorageDescriptor({ descriptor, manifest: canonicalManifest, storageRoot: this.parquetOutputRoot });
    if (!parquetVerifyResult.verified) {
      throw new CertificationCanonicalStorageUnverifiedError(`ResearchLakeParquetVerifyService did not report verified=true (mismatchedTradingDates=[${parquetVerifyResult.mismatchedTradingDates.join(',')}], datasetLinkageMatches=${parquetVerifyResult.datasetLinkageMatches})`);
    }

    // ---- 3. read exact B-M7.2 assembly. ----
    const sourceAssembly = readResearchUnderlyingDatasetAssembly(this.sourceAssemblyRoot, request.sourceAssemblyChecksum);
    if (sourceAssembly.canonicalManifest.datasetChecksum !== request.expectedCanonicalDatasetChecksum) {
      throw new CertificationSourceBindingError(`B-M7.2 assembly canonicalManifest.datasetChecksum '${sourceAssembly.canonicalManifest.datasetChecksum}' does not equal the expected canonical checksum '${request.expectedCanonicalDatasetChecksum}'`);
    }
    if (sourceAssembly.identity.instrumentKey !== this.instrumentKey || sourceAssembly.identity.timeframe !== this.timeframe || sourceAssembly.identity.year !== request.year) {
      throw new CertificationSourceBindingError('B-M7.2 assembly identity (instrument/timeframe/year) does not match this certification request');
    }

    const realCanonicalDates = new Set(
      sourceAssembly.sessions
        .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION || session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
        .map((session) => session.tradingDate)
    );
    const descriptorDates = new Set(descriptor.sessions.map((session) => session.tradingDate));
    if (!setsEqual(realCanonicalDates, descriptorDates)) {
      throw new CertificationCanonicalStorageUnverifiedError(
        `Parquet storage descriptor date set {${[...descriptorDates].sort((a, b) => a.localeCompare(b)).join(',')}} does not EXACTLY equal the B-M7.2 real-canonical date set {${[...realCanonicalDates].sort((a, b) => a.localeCompare(b)).join(',')}}`
      );
    }

    // ---- 4. read exact B-M7.3 resampling manifest. ----
    const resamplingManifest = readResearchUnderlyingResamplingManifest(this.resamplingManifestRoot, request.resamplingManifestChecksum);
    if (resamplingManifest.sourceAssemblyChecksum !== request.sourceAssemblyChecksum) {
      throw new CertificationSourceBindingError(`B-M7.3 resampling manifest sourceAssemblyChecksum '${resamplingManifest.sourceAssemblyChecksum}' does not equal the expected B-M7.2 assembly checksum '${request.sourceAssemblyChecksum}'`);
    }

    // ---- certified-calendar date-set cross-check. ----
    const { tradingDates: certifiedCalendarDates } = await this.calendarSessionsResolver.resolveRequestedSessions({ fromDate: `${request.year}-01-01`, toDate: `${request.year}-12-31` });
    const assemblyDates = sourceAssembly.sessions.map((session) => session.tradingDate);
    if (!setsEqual(new Set(certifiedCalendarDates), new Set(assemblyDates)) || certifiedCalendarDates.length !== assemblyDates.length) {
      throw new CertificationSourceBindingError('certified calendar trading-date set does not exactly equal the B-M7.2 assembly session date set');
    }

    // ---- 5/6/7. certify all 1m sessions + all (date, target) pairs. ----
    const resampleableSelections = sourceAssembly.sessions.filter((session) => session.precedenceTier !== ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
    const sessions: CertifiedSessionRecord[] = [];
    const tier3RowsByDate = new Map<string, readonly ResolvedResearchSessionRow[]>();
    const candlesByDate = new Map<string, readonly CandlesForTarget[]>();

    for (const selection of resampleableSelections) {
      // eslint-disable-next-line no-await-in-loop -- deterministic per-date ordering matters for reproducible failure attribution
      const { session, candlesForTargets, rows } = await this.certifyOneSession(selection, resamplingManifest, sourceAssembly);
      sessions.push(session);
      candlesByDate.set(selection.tradingDate, candlesForTargets);
      if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
        tier3RowsByDate.set(selection.tradingDate, rows);
      }
    }

    // ---- 8. exact no-lookahead evidence for the authorized-derived date(s). ----
    const march7Proof = this.buildDerivedDateNoLookaheadProof(tier3RowsByDate, candlesByDate);

    const tier3Selection = resampleableSelections.find((selection) => selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
    if (!tier3Selection || tier3Selection.precedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
      throw new CertificationSourceBindingError('expected exactly one authorized-derived (tier 3) B-M7.2 selection to bind B-M7.1 identity into the certification');
    }

    // ---- 9. build certification candidate IN MEMORY (never persisted here). ----
    const certification = buildResearchUnderlyingYearCertification({
      schemaVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
      certificationSemanticsVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
      identity: { instrumentKey: this.instrumentKey, sourceTimeframe: this.timeframe, year: request.year },
      calendar: { expectedSessionCount: certifiedCalendarDates.length },
      canonicalManifest: {
        datasetId: canonicalManifest.datasetId,
        datasetChecksum: canonicalManifest.datasetChecksum,
        manifestSchemaVersion: canonicalManifest.manifestSchemaVersion,
        canonicalizationVersion: canonicalManifest.canonicalizationVersion,
        healthSemanticsVersion: canonicalManifest.healthSemanticsVersion,
      },
      physicalStorage: {
        storageSchemaVersion: descriptor.storageSchemaVersion,
        datasetId: descriptor.datasetId,
        datasetChecksum: descriptor.datasetChecksum,
        datasetKind: descriptor.datasetKind,
        writerFormat: descriptor.writerFormat,
        writerLibrary: descriptor.writerLibrary,
        writerLibraryVersion: descriptor.writerLibraryVersion,
        compressionCodec: descriptor.compressionCodec,
        sessions: descriptor.sessions.map((entry) => ({ tradingDate: entry.tradingDate, sessionContentChecksum: entry.sessionContentChecksum, canonicalRowCount: entry.canonicalRowCount, physicalFileChecksum: entry.physicalFileChecksum })),
      },
      derivedSnapshotChecksum: tier3Selection.sourceSnapshotChecksum,
      derivedSessionChecksum: tier3Selection.derivedContentChecksum,
      sourceAssemblyChecksum: request.sourceAssemblyChecksum,
      resamplingManifestChecksum: request.resamplingManifestChecksum,
      sessions,
      march7Proof,
    });

    return { certification, canonicalManifest, sourceAssembly, resamplingManifest };
  }

  /**
   * Exposed as a SEPARATE step (mirrors B-M7.2/B-M7.3's validate-before-
   * persist discipline) so a locked production caller can build the
   * certification, independently validate its own locked postconditions,
   * and ONLY THEN persist -- never writing an incomplete/incorrect
   * certification into the trusted content-addressed artifact directory.
   */
  persistCertification(certification: ResearchUnderlyingYearCertificationV1): ContentAddressedJsonStoreResult {
    return storeResearchUnderlyingYearCertification(this.certificationArtifactRoot, certification);
  }

  private async certifyOneSession(
    selection: ResearchSessionSourceSelection,
    resamplingManifest: ResearchUnderlyingResamplingManifestV1,
    sourceAssembly: ResearchUnderlyingDatasetAssemblyV1
  ): Promise<{ session: CertifiedSessionRecord; candlesForTargets: readonly CandlesForTarget[]; rows: readonly ResolvedResearchSessionRow[] }> {
    if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
      throw new CertificationOneMinuteVerificationError(selection.tradingDate, 'UNAVAILABLE (tier 4) sessions are never certifiable');
    }
    const tradingDate = selection.tradingDate;

    const resolved = await this.sessionRowsResolver.resolveSessionRows(this.instrumentKey, this.timeframe, selection);
    if (resolved.kind !== 'RESOLVED') {
      throw new CertificationOneMinuteVerificationError(tradingDate, 'the B-M7.2 1m reader returned UNAVAILABLE for a non-UNAVAILABLE selection');
    }
    const rows = resolved.rows;

    const calendarWindows: readonly SessionWindow[] =
      selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION
        ? (await this.calendarSessionsResolver.resolveSessionWindowsForDates([tradingDate]))[tradingDate]
        : selection.calendarSessionWindows;
    if (!calendarWindows || calendarWindows.length === 0) {
      throw new CertificationOneMinuteVerificationError(tradingDate, 'no certified calendar session windows resolved for this date');
    }

    this.certifyOneMinuteRows(selection, rows, calendarWindows);

    const sourceContentChecksum = selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION ? selection.derivedContentChecksum : selection.canonicalContentChecksum;

    const targets: CertifiedSessionTargetRecord[] = [];
    const candlesForTargets: CandlesForTarget[] = [];
    for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
      // eslint-disable-next-line no-await-in-loop -- deterministic per-target ordering matters for reproducible failure attribution
      const { candles, descriptor } = await this.resampledSessionReader.readResampledSession({ manifest: resamplingManifest, sourceAssembly, tradingDate, targetTimeframe: target });
      const noLookaheadVerified = candles.every((candle) => this.auditNoLookahead(candle, target));
      targets.push({
        target,
        researchDerivedContentChecksum: descriptor.researchDerivedContentChecksum,
        outputCandleCount: descriptor.outputCandleCount,
        structuralTrailingRowCount: descriptor.structuralTrailingRowCount,
        candlesContainingImputation: descriptor.candlesContainingImputation,
        noLookaheadVerified,
      });
      candlesForTargets.push({ target, candles });
    }

    const session: CertifiedSessionRecord = {
      tradingDate,
      calendarSessionWindows: calendarWindows,
      sourcePrecedenceTier: selection.precedenceTier,
      sourceContentChecksum,
      sourceRowCount: rows.length,
      realCanonicalRowCount: rows.filter(isRealCanonicalRow).length,
      derivedObservedRowCount: rows.filter(isObservedRow).length,
      derivedImputedRowCount: rows.filter(isImputedRow).length,
      oneMinuteVerificationChecksum: this.computeOneMinuteVerificationChecksum(rows),
      targets,
    };

    return { session, candlesForTargets, rows };
  }

  /**
   * Task: "row timestamps strictly ascending; unique minute timestamps;
   * every row falls inside certified calendar windows; complete exact
   * expected minute set; valid ISO candleTime; valid ISO availableAt;
   * availableAt >= candleTime + 1 minute (derived imputation may be later);
   * source family consistent with B-M7.2 tier. For tier1/tier2: all rows
   * REAL_CANONICAL, availableAt exactly candleTime+1m."
   */
  private certifyOneMinuteRows(selection: ResearchSessionSourceSelection, rows: readonly ResolvedResearchSessionRow[], calendarWindows: readonly SessionWindow[]): void {
    if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) return;
    const tradingDate = selection.tradingDate;
    const expectsRealCanonical = selection.precedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION;

    let previousTimeMs = -Infinity;
    const seenMinutes = new Set<number>();
    for (const row of rows) {
      const candleTime = new Date(row.candleTime);
      const availableAt = new Date(row.availableAt);
      if (Number.isNaN(candleTime.getTime())) throw new CertificationOneMinuteVerificationError(tradingDate, `invalid ISO candleTime '${row.candleTime}'`);
      if (Number.isNaN(availableAt.getTime())) throw new CertificationOneMinuteVerificationError(tradingDate, `invalid ISO availableAt '${row.availableAt}'`);
      if (candleTime.getTime() <= previousTimeMs) throw new CertificationOneMinuteVerificationError(tradingDate, `row timestamps are not strictly ascending at '${row.candleTime}'`);
      previousTimeMs = candleTime.getTime();

      if (istCalendarDate(candleTime) !== tradingDate) throw new CertificationOneMinuteVerificationError(tradingDate, `row ${row.candleTime} is not on the expected IST tradingDate`);
      const minute = istMinuteOfDay(candleTime);
      if (seenMinutes.has(minute)) throw new CertificationOneMinuteVerificationError(tradingDate, `duplicate minute timestamp at '${row.candleTime}'`);
      seenMinutes.add(minute);
      if (!calendarWindows.some((window) => minute >= window.openMinuteIst && minute < window.closeMinuteIst)) {
        throw new CertificationOneMinuteVerificationError(tradingDate, `row ${row.candleTime} falls outside every certified calendar session window`);
      }
      if (availableAt.getTime() < candleTime.getTime() + 60_000) {
        throw new CertificationOneMinuteVerificationError(tradingDate, `availableAt '${row.availableAt}' is earlier than candleTime+1m for '${row.candleTime}'`);
      }

      const rowIsRealCanonical = isRealCanonicalRow(row);
      if (rowIsRealCanonical !== expectsRealCanonical) {
        throw new CertificationOneMinuteVerificationError(tradingDate, `row ${row.candleTime} source family '${row.provenance.sourceKind}' is inconsistent with the selected B-M7.2 tier`);
      }
      if (rowIsRealCanonical && availableAt.getTime() !== candleTime.getTime() + 60_000) {
        throw new CertificationOneMinuteVerificationError(tradingDate, `tier 1/2 row ${row.candleTime} availableAt must equal candleTime+1m exactly, got '${row.availableAt}'`);
      }
    }

    const expectedMinutes = expectedMinutesForWindows(calendarWindows);
    if (seenMinutes.size !== expectedMinutes.length) {
      throw new CertificationOneMinuteVerificationError(tradingDate, `expected ${expectedMinutes.length} minute(s) for the certified calendar windows, resolved ${seenMinutes.size}`);
    }
    for (const minute of expectedMinutes) {
      if (!seenMinutes.has(minute)) {
        throw new CertificationOneMinuteVerificationError(tradingDate, `missing expected minute-of-day ${minute}`);
      }
    }
  }

  /** Compact single-checksum proof that this session's 1m rows were actually walked -- never embeds the raw rows in the stored certification artifact. */
  private computeOneMinuteVerificationChecksum(rows: readonly ResolvedResearchSessionRow[]): string {
    const sorted = [...rows].sort((left, right) => (left.candleTime < right.candleTime ? -1 : left.candleTime > right.candleTime ? 1 : 0));
    const projected = sorted.map((row) => ({
      candleTime: row.candleTime,
      availableAt: row.availableAt,
      sourceKind: row.provenance.sourceKind,
      derivedProvenanceKind: row.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED ? row.provenance.derivedRowProvenance.kind : null,
    }));
    return sha256Hex(canonicalManifestJson(projected));
  }

  /**
   * B-M8 generic no-lookahead certification assertion (task: "Do this as an
   * independent B-M8 certification assertion over returned candles. Do not
   * merely assume B-M7.3 reader already did it"). Requires non-empty,
   * exact-bucket-size constituent lineage AND `availableAt === MAX(every
   * constituent's own availableAt)`.
   */
  private auditNoLookahead(candle: ResearchResampledCandle, target: ResampleTargetTimeframe): boolean {
    const expectedConstituentCount = resampleBucketMinutes(target);
    if (candle.constituents.length === 0 || candle.constituents.length !== expectedConstituentCount) return false;
    const constituentAvailableAtMs = candle.constituents.map((constituent) => new Date(constituent.availableAt).getTime());
    const maxAvailableAtMs = Math.max(...constituentAvailableAtMs);
    if (candle.availableAt.getTime() !== maxAvailableAtMs) return false;
    return constituentAvailableAtMs.every((availableAtMs) => candle.availableAt.getTime() >= availableAtMs);
  }

  /**
   * Task: "Certify exact... 10:22/10:23/10:24 are IMPUTED... [5 exact bucket
   * proofs]." Built generically from whichever date(s) B-M7.2 selected as
   * tier 3 (AUTHORIZED_DERIVED_IMPUTED_SESSION) -- never hardcodes
   * "March 7"; the locked 2022 CLI is the boundary that asserts the EXACT
   * expected date/minutes/anchors (task: "Only locked 2022 CLI asserts
   * exact numbers"). This milestone's locked topology has exactly one such
   * date.
   */
  private buildDerivedDateNoLookaheadProof(tier3RowsByDate: ReadonlyMap<string, readonly ResolvedResearchSessionRow[]>, candlesByDate: ReadonlyMap<string, readonly CandlesForTarget[]>): March7NoLookaheadProof {
    const tier3Dates = [...tier3RowsByDate.keys()];
    if (tier3Dates.length !== 1) {
      throw new CertificationSourceBindingError(`expected exactly one authorized-derived (tier 3) trading date to build the no-lookahead proof, found ${tier3Dates.length}`);
    }
    const tradingDate = tier3Dates[0];
    const rows = tier3RowsByDate.get(tradingDate) as readonly ResolvedResearchSessionRow[];
    const sortedRows = [...rows].sort((left, right) => (left.candleTime < right.candleTime ? -1 : left.candleTime > right.candleTime ? 1 : 0));
    const imputedRows = sortedRows.filter(isImputedRow);
    if (imputedRows.length === 0) {
      throw new CertificationOneMinuteVerificationError(tradingDate, 'the authorized-derived date has zero IMPUTED rows -- cannot build a no-lookahead proof');
    }

    const imputedMinutesIst = imputedRows.map((row) => formatMinuteOfDayIst(istMinuteOfDay(new Date(row.candleTime))));
    const firstImputedTimeMs = new Date(imputedRows[0].candleTime).getTime();
    const lastImputedTimeMs = new Date((imputedRows.at(-1) as ResolvedResearchSessionRow).candleTime).getTime();
    const leftAnchorRow = [...sortedRows].reverse().find((row) => new Date(row.candleTime).getTime() < firstImputedTimeMs);
    const rightAnchorRow = sortedRows.find((row) => new Date(row.candleTime).getTime() > lastImputedTimeMs);
    if (!leftAnchorRow || !rightAnchorRow) {
      throw new CertificationOneMinuteVerificationError(tradingDate, 'could not resolve real left/right anchor rows around the imputed minute block');
    }

    const entries: March7NoLookaheadProofEntry[] = [];
    const candlesForDate = candlesByDate.get(tradingDate) ?? [];
    for (const { target, candles } of candlesForDate) {
      for (const candle of candles) {
        const constituentImputed = candle.constituents.some(
          (constituent) => constituent.provenance.sourceKind === ResolvedResearchRowSourceKind.DERIVED && constituent.provenance.derivedRowProvenance.kind === ResearchRowProvenanceKind.IMPUTED
        );
        if (constituentImputed) {
          entries.push({
            target,
            bucketStartIst: formatMinuteOfDayIst(istMinuteOfDay(candle.bucketStart)),
            expectedAvailableAtIst: formatMinuteOfDayIst(istMinuteOfDay(candle.availableAt)),
            verified: this.auditNoLookahead(candle, target),
          });
        }
      }
    }

    return {
      tradingDate,
      imputedMinutesIst,
      leftRealAnchorIst: formatMinuteOfDayIst(istMinuteOfDay(new Date(leftAnchorRow.candleTime))),
      rightRealAnchorIst: formatMinuteOfDayIst(istMinuteOfDay(new Date(rightAnchorRow.candleTime))),
      entries,
    };
  }
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
