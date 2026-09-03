import { assertManifestSchemaCompatible } from '../domain/manifest-schema-compatibility.util';
import { DatasetManifest, SessionManifest } from '../domain/dataset-manifest.types';
import { ContentAddressedJsonStoreResult } from '../domain/content-addressed-json-store';
import {
  buildResearchUnderlyingDatasetAssembly,
  RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
  RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT,
  ResearchUnderlyingDatasetAssemblyV1,
  storeResearchUnderlyingDatasetAssembly,
} from '../domain/research-underlying-assembly.types';
import { ResearchSessionSourceSelection, selectResearchSessionSource } from '../domain/research-session-source-selection';
import { lookupTrustedAuthorizedDerivedSession, TrustedDerivedSessionLookupOutcome } from '../domain/trusted-authorized-derived-session-registry';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import DatasetManifestService, { GenerateUnderlyingDatasetManifestRequest } from './dataset-manifest.service';
import ManifestCalendarSessionResolverService, { ManifestRequestedSessions } from './manifest-calendar-session-resolver.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';

export interface AssembleNiftyUnderlyingResearchYearRequest {
  /** Required, four-digit integer. Never defaulted/inferred. */
  readonly year: number;
}

/** Duck-typed dependency seams -- a fake only ever needs to implement the ONE method this service actually calls (mirrors B-M7.1's own fake-service testing convention). */
export type UnderlyingManifestGenerator = Pick<DatasetManifestService, 'generateUnderlyingManifest'>;
export type RequestedSessionsResolver = Pick<ManifestCalendarSessionResolverService, 'resolveRequestedSessions'>;

export interface NiftyUnderlyingResearchAssemblyServiceDependencies {
  readonly manifestService?: UnderlyingManifestGenerator;
  readonly calendarSessionResolverService?: RequestedSessionsResolver;
  /** Root the trusted derived artifact is read from. Defaults to the shared Research Lake artifact root -- the SAME root B-M7.1 writes under. */
  readonly derivedArtifactRoot?: string;
  /** Root the B-M7.2 assembly artifact itself is written under. */
  readonly archiveRoot?: string;
  /** `false` skips writing the assembly artifact to disk -- the full in-memory result is still returned either way. Defaults to `true`. */
  readonly persistArtifactsToDisk?: boolean;
  readonly provider?: HistoricalProviderId;
  readonly instrumentKey?: string;
  readonly timeframe?: string;
  readonly gitRevision?: string | null;
}

export interface NiftyUnderlyingResearchAssemblyResult {
  readonly assembly: ResearchUnderlyingDatasetAssemblyV1;
  /** The canonical manifest this assembly was built from -- read-only reconstruction from the persisted store via the existing, UNMODIFIED `DatasetManifestService`. Never mutated by this service (task: "canonical manifest must be input, not rewritten"). */
  readonly canonicalManifest: DatasetManifest;
  readonly assemblyStorage: ContentAddressedJsonStoreResult | null;
}

/**
 * B-M7.2: deterministic 2022 (or any requested year's) NIFTY underlying
 * RESEARCH assembly orchestrator. Composes, but never reimplements, the
 * already-accepted B-F5 canonical manifest generation
 * (`DatasetManifestService`), B-F5 calendar truth
 * (`ManifestCalendarSessionResolverService`), and B-M7.1 authorized-derived
 * artifact reading (`lookupTrustedAuthorizedDerivedSession`). Every
 * precedence decision routes through the ONE central
 * `selectResearchSessionSource` function -- never scattered here.
 *
 * Zero provider calls, zero DB writes, zero canonical mutation: the ONLY
 * I/O this service performs is (a) the SAME read-only persisted-store
 * reconstruction `DatasetManifestService`/`research-dataset-manifest-generate.ts`
 * already perform for canonical manifest generation, (b) a read-only
 * calendar-certification lookup, (c) a read-only, content-addressed-
 * self-verifying read of the ONE allowlisted B-M7.1 derived artifact, and
 * (d) an idempotent content-addressed WRITE of its own new B-M7.2 assembly
 * artifact (skippable via `persistArtifactsToDisk: false`).
 */
export default class NiftyUnderlyingResearchAssemblyService {
  private readonly manifestService: UnderlyingManifestGenerator;
  private readonly calendarSessionResolverService: RequestedSessionsResolver;
  private readonly derivedArtifactRoot: string;
  private readonly archiveRoot: string;
  private readonly persistArtifactsToDisk: boolean;
  private readonly provider: HistoricalProviderId;
  private readonly instrumentKey: string;
  private readonly timeframe: string;
  private readonly gitRevision: string | null;

  constructor(dependencies: NiftyUnderlyingResearchAssemblyServiceDependencies = {}) {
    this.manifestService = dependencies.manifestService ?? new DatasetManifestService();
    this.calendarSessionResolverService = dependencies.calendarSessionResolverService ?? new ManifestCalendarSessionResolverService();
    this.derivedArtifactRoot = dependencies.derivedArtifactRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
    this.archiveRoot = dependencies.archiveRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
    this.persistArtifactsToDisk = dependencies.persistArtifactsToDisk ?? true;
    this.provider = dependencies.provider ?? HistoricalProviderId.UPSTOX;
    this.instrumentKey = dependencies.instrumentKey ?? NIFTY_INDEX_INSTRUMENT_KEY;
    this.timeframe = dependencies.timeframe ?? NIFTY_UNDERLYING_TIMEFRAME;
    this.gitRevision = dependencies.gitRevision ?? null;
  }

  async assembleYear(request: AssembleNiftyUnderlyingResearchYearRequest): Promise<NiftyUnderlyingResearchAssemblyResult> {
    const { year } = request;
    if (!Number.isInteger(year) || year < 2000) {
      throw new Error(`NiftyUnderlyingResearchAssemblyService requires an integer year >= 2000; received '${String(year)}'.`);
    }
    const fromDate = `${year}-01-01`;
    const toDate = `${year}-12-31`;

    // ---- Step 1: the certified 2022 (or requested year) trading-session set -- NEVER hardcoded, always read fresh from the authoritative calendar/manifest path B-F5 already trusts. ----
    const requested: ManifestRequestedSessions = await this.calendarSessionResolverService.resolveRequestedSessions({ fromDate, toDate });

    // ---- Step 2: canonical manifest -- consumed as INPUT via the existing, unmodified DatasetManifestService (read-only reconstruction from the persisted store, never a fresh provider fetch). ----
    const generateRequest: GenerateUnderlyingDatasetManifestRequest = {
      provider: this.provider,
      instrumentKey: this.instrumentKey,
      timeframe: this.timeframe,
      tradingDates: requested.tradingDates,
      calendarSessionWindows: requested.calendarSessionWindows,
      gitRevision: this.gitRevision,
    };
    const canonicalManifest = await this.manifestService.generateUnderlyingManifest(generateRequest);
    // Same centralized guard every other manifest-consuming boundary in this codebase calls before interpreting sessions/provenance.
    assertManifestSchemaCompatible(canonicalManifest);

    const canonicalByDate = new Map(canonicalManifest.sessions.map((session) => [session.identity.tradingDate, session]));

    // ---- Step 3: per-date source selection through the ONE central precedence function. ----
    const sessions: ResearchSessionSourceSelection[] = requested.tradingDates.map((tradingDate) => {
      const canonicalSession = canonicalByDate.get(tradingDate);
      if (!canonicalSession) {
        throw new Error(
          `NiftyUnderlyingResearchAssemblyService invariant violated: certified trading date '${tradingDate}' is missing from the freshly-generated canonical manifest -- DatasetManifestService.generateUnderlyingManifest always produces exactly one session per requested date.`
        );
      }
      return selectResearchSessionSource({ canonicalSession, resolveDerivedLookup: () => this.resolveDerivedLookup(canonicalSession) });
    });

    const assembly = buildResearchUnderlyingDatasetAssembly({
      schemaVersion: RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION,
      assemblySemanticsVersion: RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION,
      identity: { instrumentKey: this.instrumentKey, timeframe: this.timeframe, year },
      canonicalManifest: {
        datasetKind: canonicalManifest.datasetKind,
        datasetId: canonicalManifest.datasetId,
        datasetChecksum: canonicalManifest.datasetChecksum,
        manifestSchemaVersion: canonicalManifest.manifestSchemaVersion,
        canonicalizationVersion: canonicalManifest.canonicalizationVersion,
        healthSemanticsVersion: canonicalManifest.healthSemanticsVersion,
      },
      sessions,
    });

    const assemblyStorage = this.persistArtifactsToDisk ? this.persistAssembly(assembly) : null;

    return { assembly, canonicalManifest, assemblyStorage };
  }

  /**
   * BLOCKER-04 CORRECTION: exposed as a SEPARATE public step (rather than
   * always happening inside `assembleYear`) so a locked production caller
   * (the B-M7.2 2022 CLI) can build the assembly, independently validate its
   * own locked postconditions, and ONLY THEN persist -- never writing an
   * incomplete/incorrect assembly into the trusted content-addressed
   * artifact directory before that validation runs. `assembleYear` itself
   * still calls this directly whenever `persistArtifactsToDisk` (the
   * default) is `true`, preserving every existing non-CLI caller's behavior
   * exactly.
   */
  persistAssembly(assembly: ResearchUnderlyingDatasetAssemblyV1): ContentAddressedJsonStoreResult {
    return storeResearchUnderlyingDatasetAssembly(this.archiveRoot, assembly);
  }

  /**
   * BLOCKER-01/BLOCKER-03 CORRECTION: no longer short-circuits based on
   * canonical health status alone -- `selectResearchSessionSource` itself now
   * owns the decision of whether a derived lookup is even needed (it is
   * invoked lazily, only when canonical content did not already qualify for
   * tier 1/2). Health-status-complete-but-unproven-provenance sessions can
   * therefore still correctly fall through to a genuinely authorized derived
   * source, while a corrupted/mismatched derived artifact registered for a
   * date whose canonical content already resolves to tier 1/2 still never
   * fails the assembly (this callback is simply never invoked for that date).
   */
  private resolveDerivedLookup(canonicalSession: SessionManifest): TrustedDerivedSessionLookupOutcome {
    // This service only ever generates UNDERLYING_1M manifests (via `generateUnderlyingManifest`), so
    // `this.instrumentKey`/`this.timeframe` (the service's own locked identity) are used directly rather
    // than narrowing `canonicalSession.identity`'s `SessionContentIdentity` union (which also covers
    // EXPIRED_OPTION_1M, out of scope here).
    return lookupTrustedAuthorizedDerivedSession(this.derivedArtifactRoot, this.instrumentKey, this.timeframe, canonicalSession.identity.tradingDate);
  }
}
