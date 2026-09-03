import { readResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, ResearchUnderlyingDatasetAssemblyV1 } from '../domain/research-underlying-assembly.types';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION, ResearchResampleSessionDescriptor } from '../domain/research-underlying-resampled-candle.types';
import {
  buildResearchUnderlyingResamplingManifest,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_ROOT,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestSessionEntry,
  ResearchUnderlyingResamplingManifestV1,
  storeResearchUnderlyingResamplingManifest,
} from '../domain/research-underlying-resampling-manifest.types';
import { ContentAddressedJsonStoreResult } from '../domain/content-addressed-json-store';
import ResearchUnderlying1mSessionReaderService from './research-underlying-1m-session-reader.service';
import ManifestCalendarSessionResolverService from './manifest-calendar-session-resolver.service';
import ResearchUnderlyingResamplerService from './research-underlying-resampler.service';

export type SessionRowsResolver = Pick<ResearchUnderlying1mSessionReaderService, 'resolveSessionRows'>;
export type SessionWindowsResolver = Pick<ManifestCalendarSessionResolverService, 'resolveSessionWindowsForDates'>;
export type SessionResampler = Pick<ResearchUnderlyingResamplerService, 'resampleSession'>;

export interface ResearchUnderlyingResamplingManifestBuilderServiceDependencies {
  /** Root the trusted B-M7.2 source assembly is read from -- the SAME root B-M7.2 writes under. */
  readonly sourceAssemblyRoot?: string;
  /** Root this milestone's own year manifest artifact is written under. */
  readonly manifestArtifactRoot?: string;
  readonly sessionRowsResolver?: SessionRowsResolver;
  readonly sessionWindowsResolver?: SessionWindowsResolver;
  readonly sessionResampler?: SessionResampler;
  /** MUST resolve to exactly `RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES` (order-independent) -- defaults to it. Exposed only so a test can prove a wrong target set fails closed (task: "No arbitrary N-minute support"); the locked production CLI never overrides it. */
  readonly targetTimeframes?: readonly ResampleTargetTimeframe[];
}

export interface BuildYearResamplingManifestRequest {
  /** The exact, trusted, committed B-M7.2 source assembly checksum this manifest is built against -- never re-selected/re-derived here (task: "B-M7.3 MUST consume this content-addressed B-M7.2 assembly... MUST NOT implement another source-precedence algorithm"). */
  readonly sourceAssemblyChecksum: string;
}

export interface BuildYearResamplingManifestResult {
  readonly manifest: ResearchUnderlyingResamplingManifestV1;
  /** The exact B-M7.2 assembly this manifest was built from -- read-only, via the existing, unmodified `readResearchUnderlyingDatasetAssembly`. Never mutated here. */
  readonly sourceAssembly: ResearchUnderlyingDatasetAssemblyV1;
}

export class ResearchUnderlyingResamplingTargetTimeframeSetError extends Error {
  constructor(received: readonly ResampleTargetTimeframe[]) {
    super(`B-M7.3 resampling manifest builder requires EXACTLY the target timeframes [${RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.join(',')}] (order-independent); received [${received.join(',')}].`);
    this.name = 'ResearchUnderlyingResamplingTargetTimeframeSetError';
  }
}

/** Fails closed (task: "for tier1/tier2, compare them against the selection.calendarSessionWindows already pinned by B-M7.2 -- mismatch must FAIL CLOSED"). */
export class ResearchUnderlyingResamplingCalendarWindowMismatchError extends Error {
  constructor(readonly tradingDate: string) {
    super(
      `B-M7.3 resampling manifest builder: freshly-resolved certified calendar windows for tradingDate '${tradingDate}' do not match the B-M7.2 selection's own pinned calendarSessionWindows -- refusing to resample against a drifted calendar declaration.`
    );
    this.name = 'ResearchUnderlyingResamplingCalendarWindowMismatchError';
  }
}

function windowsEqual(left: readonly SessionWindow[], right: readonly SessionWindow[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.windowIndex - b.windowIndex);
  const sortedRight = [...right].sort((a, b) => a.windowIndex - b.windowIndex);
  return sortedLeft.every((window, index) => window.windowIndex === sortedRight[index].windowIndex && window.openMinuteIst === sortedRight[index].openMinuteIst && window.closeMinuteIst === sortedRight[index].closeMinuteIst);
}

function isValidTargetTimeframeSet(candidate: readonly ResampleTargetTimeframe[]): boolean {
  if (candidate.length !== RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length) return false;
  const candidateSet = new Set(candidate);
  return RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.every((target) => candidateSet.has(target));
}

/**
 * B-M7.3: deterministic year-level orchestrator --
 * B-M7.2 assembly -> certified calendar windows -> B-M7.2 1m reader ->
 * B-M7.3 provenance-aware resampler (x3 targets) -> compact manifest.
 *
 * Composes, but never reimplements, the already-accepted B-M7.2 source
 * selection (consumed as trusted, read-only input via
 * `readResearchUnderlyingDatasetAssembly`), the B-M7.2 1m read boundary
 * (`ResearchUnderlying1mSessionReaderService.resolveSessionRows`), the
 * certified calendar (`ManifestCalendarSessionResolverService.
 * resolveSessionWindowsForDates`), and the new B-M7.3 resampler
 * (`ResearchUnderlyingResamplerService`). Every precedence decision was
 * already made by B-M7.2 -- this service NEVER re-runs source selection.
 *
 * Zero provider calls, zero DB writes, zero canonical mutation: the only I/O
 * is (a) a read-only content-addressed reconstruction of the trusted B-M7.2
 * assembly, (b) read-only persisted-canonical-store reads via the 1m reader
 * (for tier 1/2 dates only), (c) a read-only, content-addressed-self-
 * verifying read of the B-M7.1 derived artifact (for tier 3 dates only, via
 * the 1m reader), (d) a read-only certified-calendar lookup, and (e) an
 * idempotent content-addressed WRITE of this milestone's own manifest
 * artifact, via the separate `persistManifest` step (never called from
 * `buildYearManifest` itself -- mirrors B-M7.2's BLOCKER-04
 * validate-before-persist discipline).
 */
export default class ResearchUnderlyingResamplingManifestBuilderService {
  private readonly sourceAssemblyRoot: string;
  private readonly manifestArtifactRoot: string;
  private readonly sessionRowsResolver: SessionRowsResolver;
  private readonly sessionWindowsResolver: SessionWindowsResolver;
  private readonly sessionResampler: SessionResampler;
  private readonly targetTimeframes: readonly ResampleTargetTimeframe[];

  constructor(dependencies: ResearchUnderlyingResamplingManifestBuilderServiceDependencies = {}) {
    this.sourceAssemblyRoot = dependencies.sourceAssemblyRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
    this.manifestArtifactRoot = dependencies.manifestArtifactRoot ?? RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_ROOT;
    this.sessionRowsResolver = dependencies.sessionRowsResolver ?? new ResearchUnderlying1mSessionReaderService();
    this.sessionWindowsResolver = dependencies.sessionWindowsResolver ?? new ManifestCalendarSessionResolverService();
    this.sessionResampler = dependencies.sessionResampler ?? new ResearchUnderlyingResamplerService();
    this.targetTimeframes = dependencies.targetTimeframes ?? RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES;
  }

  async buildYearManifest(request: BuildYearResamplingManifestRequest): Promise<BuildYearResamplingManifestResult> {
    if (!isValidTargetTimeframeSet(this.targetTimeframes)) {
      throw new ResearchUnderlyingResamplingTargetTimeframeSetError(this.targetTimeframes);
    }

    const sourceAssembly = readResearchUnderlyingDatasetAssembly(this.sourceAssemblyRoot, request.sourceAssemblyChecksum);

    const resampleableSelections = sourceAssembly.sessions.filter((session) => session.precedenceTier !== ResearchSessionSourcePrecedenceTier.UNAVAILABLE);
    const certifiedWindowsByDate = await this.sessionWindowsResolver.resolveSessionWindowsForDates(resampleableSelections.map((session) => session.tradingDate));

    const sessions: ResearchUnderlyingResamplingManifestSessionEntry[] = [];

    for (const selection of resampleableSelections) {
      const certifiedWindows = certifiedWindowsByDate[selection.tradingDate];
      if (!certifiedWindows) {
        throw new Error(`B-M7.3 resampling manifest builder: no certified calendar session windows resolved for tradingDate '${selection.tradingDate}'.`);
      }

      let sessionWindows: readonly SessionWindow[];
      let sourceContentChecksum: string;
      if (selection.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
        // Tier 3 selections carry no `calendarSessionWindows` of their own (see `AuthorizedDerivedImputedSessionSourceSelection`) -- the freshly-resolved certified windows ARE the resampling window declaration (task: "for tier3 March-7, use the certified calendar windows as the resampling window declaration").
        sessionWindows = certifiedWindows;
        sourceContentChecksum = selection.derivedContentChecksum;
      } else {
        if (!windowsEqual(certifiedWindows, selection.calendarSessionWindows)) {
          throw new ResearchUnderlyingResamplingCalendarWindowMismatchError(selection.tradingDate);
        }
        sessionWindows = selection.calendarSessionWindows;
        sourceContentChecksum = selection.canonicalContentChecksum;
      }

      const resolved = await this.sessionRowsResolver.resolveSessionRows(sourceAssembly.identity.instrumentKey, sourceAssembly.identity.timeframe, selection);
      if (resolved.kind !== 'RESOLVED') {
        throw new Error(`B-M7.3 resampling manifest builder: the B-M7.2 1m reader returned UNAVAILABLE for a non-UNAVAILABLE B-M7.2 selection at tradingDate '${selection.tradingDate}' -- refusing to silently skip a research-ready session.`);
      }

      const targets = {} as Record<ResampleTargetTimeframe, ResearchResampleSessionDescriptor>;
      for (const targetTimeframe of this.targetTimeframes) {
        const { descriptor } = this.sessionResampler.resampleSession({
          sourceAssemblyChecksum: request.sourceAssemblyChecksum,
          tradingDate: selection.tradingDate,
          sourcePrecedenceTier: selection.precedenceTier,
          sourceContentChecksum,
          targetTimeframe,
          sessionWindows,
          sourceRows: resolved.rows,
        });
        targets[targetTimeframe] = descriptor;
      }

      sessions.push({ tradingDate: selection.tradingDate, targets });
    }

    const manifest = buildResearchUnderlyingResamplingManifest({
      schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
      resamplingSemanticsVersion: RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION,
      sourceAssemblyChecksum: request.sourceAssemblyChecksum,
      identity: { instrumentKey: sourceAssembly.identity.instrumentKey, sourceTimeframe: sourceAssembly.identity.timeframe, year: sourceAssembly.identity.year },
      targetTimeframes: this.targetTimeframes,
      sourceSessionCounts: { expectedSessions: sourceAssembly.sessionCounts.expectedSessions, unavailableSessions: sourceAssembly.sessionCounts.unavailableSessions },
      sessions,
    });

    return { manifest, sourceAssembly };
  }

  /**
   * Exposed as a SEPARATE step (mirrors B-M7.2's BLOCKER-04 correction) so a
   * locked production caller (the B-M7.3 2022 CLI) can build the manifest,
   * independently validate its own locked postconditions, and ONLY THEN
   * persist -- never writing an incomplete/incorrect manifest into the
   * trusted content-addressed artifact directory before validation runs.
   */
  persistManifest(manifest: ResearchUnderlyingResamplingManifestV1): ContentAddressedJsonStoreResult {
    return storeResearchUnderlyingResamplingManifest(this.manifestArtifactRoot, manifest);
  }
}
