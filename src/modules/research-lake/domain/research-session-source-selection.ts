import { DatasetHealthStatus } from './dataset-health.types';
import { SessionContentIdentity, SessionManifest, SourceAcquisitionEvidenceAvailability, SourceAcquisitionProvenanceComposition } from './dataset-manifest.types';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { SessionWindow } from './exchange-calendar.types';
import { TrustedDerivedSessionLookupOutcome } from './trusted-authorized-derived-session-registry';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

/**
 * B-M7.2: the ONE central function every source-precedence decision in this
 * milestone (and every future consumer, e.g. B-M7.3) must go through --
 * never scattered per-caller conditions (task: "Source precedence must be
 * ONE central function"). Implements the existing, already-accepted
 * `ResearchSessionSourcePrecedenceTier` ordering (tier 1 > 2 > 3 > 4)
 * end-to-end for exactly one trading date's session.
 */
export const RESEARCH_SESSION_SOURCE_SELECTION_SEMANTICS_VERSION = 2;

/**
 * A canonical session counts as "research-usable real content" only when its
 * PERSISTED CONTENT is structurally complete under its declared calendar
 * session windows -- never merely because DB rows happen to exist (task:
 * "Do not convert an INCOMPLETE/INVALID/PROVIDER_UNAVAILABLE session into
 * tier 1"). Matches `DatasetManifestService.sessionCounts`'s own `healthy`
 * rollup (`HEALTHY` + `NORMALIZED_WITH_EXCLUSIONS`) -- never a new,
 * competing definition of "healthy".
 */
export const COMPLETE_CANONICAL_HEALTH_STATUSES: ReadonlySet<DatasetHealthStatus> = new Set([DatasetHealthStatus.HEALTHY, DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS]);

/** Truthful discriminant for a tier-2 selection's own repair attribution (BLOCKER-01/task correction: "strengthen the discriminated union minimally" rather than collapsing both cases into one loose nullable object). */
export enum ResearchSessionCompositeRepairProvenanceKind {
  FULLY_PROVENANCED = 'FULLY_PROVENANCED',
  UNKNOWN_LEGACY_REPAIR_PROVENANCE = 'UNKNOWN_LEGACY_REPAIR_PROVENANCE',
}

/**
 * HIGH-02 CORRECTION: carries ONLY stable, semantic repair facts -- NEVER
 * `primaryRetrievalId`/`repairRetrievalId`/`repairEvidenceId` (random
 * `HistoricalDataRetrievalSession`/`HistoricalCandleRepairEvidence` DB row
 * UUIDs). Two canonical sessions that are semantically identical repair
 * composites but were persisted under different retrieval/evidence UUIDs
 * MUST produce byte-identical selections here (task: "Two otherwise
 * identical fully-provenanced composite canonical selections... MUST
 * produce byte-identical B-M7.2 semantic selections").
 */
export interface FullyProvenancedResearchCompositeRepair {
  readonly kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED;
  readonly primaryProvider: HistoricalProviderId;
  readonly repairProvider: HistoricalProviderId;
  readonly repairedMinuteCount: number;
  readonly repairPolicyVersion: number;
}

/** The known-composite-but-unattributed-legacy case -- deliberately carries NO fabricated repair detail (task: "do NOT fabricate compositeRepair"). */
export interface UnknownLegacyResearchCompositeRepair {
  readonly kind: ResearchSessionCompositeRepairProvenanceKind.UNKNOWN_LEGACY_REPAIR_PROVENANCE;
}

export type ResearchSessionCompositeRepairProvenance = FullyProvenancedResearchCompositeRepair | UnknownLegacyResearchCompositeRepair;

/**
 * B-M7.2-BLOCKER-03 CORRECTION: every tier-1/tier-2 selection now carries
 * enough STABLE manifest identity (never candle payloads -- task: "Do NOT
 * embed the canonical candle payload") for `ResearchUnderlying1mSessionReaderService`
 * to independently reconstruct + re-verify the CURRENT persisted canonical
 * content against exactly what was selected here, rather than trusting
 * whatever rows currently happen to exist in `HistoricalCandle`. Every field
 * below is copied VERBATIM from the already-generated `SessionManifest` --
 * never re-derived/fabricated here.
 */
export interface RealCanonicalSessionSourceSelection {
  readonly precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION;
  readonly tradingDate: string;
  readonly persistedCanonicalHealthStatus: DatasetHealthStatus;
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly calendarSessionWindows: readonly SessionWindow[];
  readonly canonicalContentChecksum: string;
  readonly canonicalRowCount: number;
}

export interface CompositeRepairedCanonicalSessionSourceSelection {
  readonly precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION;
  readonly tradingDate: string;
  readonly persistedCanonicalHealthStatus: DatasetHealthStatus;
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly calendarSessionWindows: readonly SessionWindow[];
  readonly canonicalContentChecksum: string;
  readonly canonicalRowCount: number;
  /**
   * Never `null` -- always exactly one of the two truthful, UUID-free
   * variants above (see `ResearchSessionCompositeRepairProvenanceKind`'s own
   * doc for why a nullable `compositeRepair` was replaced with this
   * discriminated union).
   */
  readonly repairProvenance: ResearchSessionCompositeRepairProvenance;
}

export interface AuthorizedDerivedImputedSessionSourceSelection {
  readonly precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION;
  readonly tradingDate: string;
  readonly authorizationId: string;
  readonly derivedContentChecksum: string;
  readonly derivedArtifactRelativePath: string;
  readonly sourceSnapshotChecksum: string;
  /** The REAL provider that supplied the underlying snapshot's real observed rows -- describes the SNAPSHOT's origin only, never the imputed rows' own origin (matches `DerivedImputedResearchSessionV1.sourceSnapshotProviderId`'s own doc; never claims Upstox produced the synthetic rows). */
  readonly sourceSnapshotProviderId: string;
  readonly realRowCount: number;
  readonly imputedRowCount: number;
}

export enum ResearchSessionUnavailableReason {
  /** Canonical content for this date is not complete, and no derived artifact is authorized for it at all (never even attempted). */
  CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED = 'CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED',
  /** An authorization exists for this date, but no artifact has been captured (real capture not yet run) -- the ordinary, expected state before an operator-authorized B-M7.1 capture. */
  CANONICAL_INCOMPLETE_DERIVED_NOT_YET_CAPTURED = 'CANONICAL_INCOMPLETE_DERIVED_NOT_YET_CAPTURED',
  /**
   * BLOCKER-01: canonical content is structurally COMPLETE, but its
   * durable acquisition evidence is `UNAVAILABLE_FROM_PERSISTED_STORE` (the
   * placeholder default -- "no composite repair evidence is being asserted
   * here", NEVER proof of pure-primary provenance) and no authorized
   * derived source exists for this date either. Distinct from
   * `CANONICAL_INCOMPLETE_*` -- the canonical CONTENT is fine, only its
   * PROVENANCE cannot be proven.
   */
  CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED = 'CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED',
  /** Same as above, but an authorization exists for this date and simply has not been captured yet. */
  CANONICAL_PROVENANCE_UNAVAILABLE_DERIVED_NOT_YET_CAPTURED = 'CANONICAL_PROVENANCE_UNAVAILABLE_DERIVED_NOT_YET_CAPTURED',
}

export interface UnavailableSessionSourceSelection {
  readonly precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE;
  readonly tradingDate: string;
  readonly persistedCanonicalHealthStatus: DatasetHealthStatus;
  readonly reason: ResearchSessionUnavailableReason;
}

export type ResearchSessionSourceSelection =
  | RealCanonicalSessionSourceSelection
  | CompositeRepairedCanonicalSessionSourceSelection
  | AuthorizedDerivedImputedSessionSourceSelection
  | UnavailableSessionSourceSelection;

export type ResearchSessionSourceSelectionInvariantViolationCode =
  /** `provenanceComposition` is `COMPOSITE_REPAIRED`/`UNKNOWN_LEGACY_REPAIR_PROVENANCE` (a composite-repair CLAIM) but `sourceAcquisitionEvidence.availability` is NOT `AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE` -- a composite claim can never stand without positive durable evidence backing it (the ONLY value the shared `UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE` placeholder ever pairs with `PRIMARY_ONLY`, so this combination is structurally impossible from correctly-constructed evidence and signals real data corruption). */
  | 'COMPOSITE_CLAIM_WITHOUT_POSITIVE_EVIDENCE'
  /** `provenanceComposition === COMPOSITE_REPAIRED` but `compositeRepair` is `null` -- a fully-provenanced composite claim must carry its repair details (task: "fail closed as an invariant violation"). */
  | 'COMPOSITE_REPAIRED_WITHOUT_DETAILS';

/**
 * B-M7.2-BLOCKER-01/HIGH-02 CORRECTION: a canonical session's
 * `sourceAcquisitionEvidence` claims a composite-repair provenance
 * (`COMPOSITE_REPAIRED`/`UNKNOWN_LEGACY_REPAIR_PROVENANCE`) that is
 * internally inconsistent -- either asserted without positive durable
 * evidence backing it, or `COMPOSITE_REPAIRED` with no `compositeRepair`
 * detail. This is a genuine manifest data-integrity defect, never silently
 * downgraded/reclassified -- it propagates out of `selectResearchSessionSource`
 * (and therefore out of the whole B-M7.2 assembly) uncaught, exactly like
 * `TrustedDerivedSessionIntegrityError` does for a corrupted trusted derived
 * artifact.
 */
export class ResearchSessionSourceSelectionInvariantViolationError extends Error {
  constructor(
    readonly tradingDate: string,
    readonly code: ResearchSessionSourceSelectionInvariantViolationCode,
    detail: string
  ) {
    super(`B-M7.2 source selection for tradingDate '${tradingDate}' failed a manifest-evidence invariant (${code}): ${detail}`);
    this.name = 'ResearchSessionSourceSelectionInvariantViolationError';
  }
}

export interface SelectResearchSessionSourceInput {
  /** The exact canonical `SessionManifest` for this trading date, from an already-generated, already-schema-checked `DatasetManifest` -- never re-derived here. */
  readonly canonicalSession: SessionManifest;
  /**
   * BLOCKER-01/BLOCKER-03 CORRECTION: a LAZY lookup -- `selectResearchSessionSource`
   * itself decides whether canonical content already qualifies for tier 1/2
   * (task: "REAL CANONICAL wins. Derived is ignored for selection.") and, if
   * so, NEVER invokes this callback at all. This keeps that skip decision
   * inside the ONE central precedence function rather than duplicated in
   * every caller (the exact bug this correction fixes: a caller-side
   * pre-check based on health status ALONE previously skipped the derived
   * lookup even for a complete-but-unproven-primary session that should have
   * fallen through to tier 3). A corrupted-but-irrelevant derived artifact
   * registered for a date whose canonical content already resolves to tier
   * 1/2 therefore still never fails the assembly.
   */
  readonly resolveDerivedLookup: () => TrustedDerivedSessionLookupOutcome;
}

interface QualifiedRealCanonicalSelection {
  readonly selection: RealCanonicalSessionSourceSelection | CompositeRepairedCanonicalSessionSourceSelection;
}

function canonicalManifestFacts(canonicalSession: SessionManifest) {
  return {
    tradingDate: canonicalSession.identity.tradingDate,
    persistedCanonicalHealthStatus: canonicalSession.persistedCanonicalHealthStatus,
    identity: canonicalSession.identity,
    canonicalizationVersion: canonicalSession.canonicalizationVersion,
    healthSemanticsVersion: canonicalSession.healthSemanticsVersion,
    calendarSessionWindows: canonicalSession.calendarSessionWindows,
    canonicalContentChecksum: canonicalSession.contentChecksum,
    canonicalRowCount: canonicalSession.canonicalRowCount,
  };
}

/**
 * Classifies a STRUCTURALLY COMPLETE canonical session (caller already
 * proved `COMPLETE_CANONICAL_HEALTH_STATUSES.has(persistedCanonicalHealthStatus)`)
 * into tier 1, tier 2, or "does not qualify" (`null` -- falls through to
 * tier 3/4). Never called for an incomplete/invalid/provider-unavailable
 * session. Throws `ResearchSessionSourceSelectionInvariantViolationError`
 * for an internally-inconsistent composite claim (see that error's own doc).
 */
function classifyCompleteCanonicalSession(canonicalSession: SessionManifest): QualifiedRealCanonicalSelection | null {
  const evidence = canonicalSession.sourceAcquisitionEvidence;
  const hasPositiveEvidence = evidence.availability === SourceAcquisitionEvidenceAvailability.AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE;
  const facts = canonicalManifestFacts(canonicalSession);

  if (evidence.provenanceComposition === SourceAcquisitionProvenanceComposition.PRIMARY_ONLY) {
    if (!hasPositiveEvidence) {
      // BLOCKER-01: `PRIMARY_ONLY` is this codebase's placeholder default whenever no
      // durable evidence exists at all -- "no composite repair evidence is being
      // asserted here", NEVER "proven pure-primary". Complete CONTENT still exists,
      // but tier 1's proven-pure-primary claim requires positive durable evidence
      // too. Falls through to tier 3/4, never tier 1.
      return null;
    }
    return {
      selection: {
        precedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
        ...facts,
      },
    };
  }

  // COMPOSITE_REPAIRED or UNKNOWN_LEGACY_REPAIR_PROVENANCE: both are composite
  // CLAIMS that must be backed by positive durable evidence -- never merely
  // asserted (task: "a composite claim without positive durable evidence
  // backing it is a manifest data-integrity violation").
  if (!hasPositiveEvidence) {
    throw new ResearchSessionSourceSelectionInvariantViolationError(
      facts.tradingDate,
      'COMPOSITE_CLAIM_WITHOUT_POSITIVE_EVIDENCE',
      `sourceAcquisitionEvidence.provenanceComposition is '${evidence.provenanceComposition}' but availability is '${evidence.availability}', not AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE.`
    );
  }

  if (evidence.provenanceComposition === SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED) {
    if (evidence.compositeRepair === null) {
      throw new ResearchSessionSourceSelectionInvariantViolationError(
        facts.tradingDate,
        'COMPOSITE_REPAIRED_WITHOUT_DETAILS',
        `sourceAcquisitionEvidence.provenanceComposition is COMPOSITE_REPAIRED but compositeRepair is null.`
      );
    }
    return {
      selection: {
        precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
        ...facts,
        repairProvenance: {
          kind: ResearchSessionCompositeRepairProvenanceKind.FULLY_PROVENANCED,
          primaryProvider: evidence.compositeRepair.primaryProvider,
          repairProvider: evidence.compositeRepair.repairProvider,
          repairedMinuteCount: evidence.compositeRepair.repairedMinuteCount,
          repairPolicyVersion: evidence.compositeRepair.repairPolicyVersion,
        },
      },
    };
  }

  // UNKNOWN_LEGACY_REPAIR_PROVENANCE, positive evidence already confirmed above:
  // REPAIR_ACCEPTED evidence genuinely exists (this session IS a known repair
  // composite) but exact provider/policy attribution is unrecoverable -- never
  // labeled PRIMARY_ONLY, never labeled fully-provenanced COMPOSITE_REPAIRED,
  // never fabricated.
  return {
    selection: {
      precedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION,
      ...facts,
      repairProvenance: { kind: ResearchSessionCompositeRepairProvenanceKind.UNKNOWN_LEGACY_REPAIR_PROVENANCE },
    },
  };
}

/**
 * Selects exactly ONE research source for one trading date, implementing
 * `ResearchSessionSourcePrecedenceTier`'s tier 1 > 2 > 3 > 4 ordering:
 *
 *  1. Canonical content is COMPLETE (`HEALTHY`/`NORMALIZED_WITH_EXCLUSIONS`),
 *     its provenance is `PRIMARY_ONLY`, AND its durable evidence
 *     `availability` is `AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE` (POSITIVE
 *     proof, never the `UNAVAILABLE_FROM_PERSISTED_STORE` placeholder) ->
 *     tier 1 (BLOCKER-01 correction).
 *  2. Canonical content is COMPLETE, its provenance is a KNOWN composite
 *     (`COMPOSITE_REPAIRED` or `UNKNOWN_LEGACY_REPAIR_PROVENANCE`), AND its
 *     durable evidence availability is positive -> tier 2. A composite claim
 *     asserted WITHOUT positive evidence, or `COMPOSITE_REPAIRED` with no
 *     `compositeRepair` detail, is a data-integrity violation that throws
 *     `ResearchSessionSourceSelectionInvariantViolationError` -- never
 *     silently reclassified. Never tier 1 either way.
 *  3. Canonical content did NOT qualify for tier 1/2 above (either genuinely
 *     incomplete/invalid/provider-unavailable, OR complete but with
 *     unavailable/unproven provenance), but a trusted, fully-verified
 *     authorized derived session exists for this exact date -> tier 3. The
 *     derived lookup is invoked LAZILY -- ONLY reached when canonical did not
 *     already qualify above (see `SelectResearchSessionSourceInput.resolveDerivedLookup`'s
 *     own doc).
 *  4. Otherwise -> tier 4 (`UNAVAILABLE`), carrying a machine-readable reason
 *     that distinguishes "content incomplete" from "content complete but
 *     provenance unavailable" (BLOCKER-01).
 *
 * Pure and synchronous (aside from the caller-supplied `resolveDerivedLookup`
 * callback, itself required to be synchronous and side-effect-free beyond
 * read-only artifact verification) -- never calls a provider, never touches
 * the DB directly, never mutates `canonicalSession`. A corrupted-but-authorized
 * derived artifact must NEVER reach this function as an `AVAILABLE` outcome --
 * `lookupTrustedAuthorizedDerivedSession` throws before returning one, and
 * that throw must propagate out of the caller unconverted (task: "A trusted
 * authorized source that exists but fails integrity should make assembly
 * FAIL").
 */
export function selectResearchSessionSource(input: SelectResearchSessionSourceInput): ResearchSessionSourceSelection {
  const { canonicalSession, resolveDerivedLookup } = input;
  const tradingDate = canonicalSession.identity.tradingDate;
  const canonicalContentComplete = COMPLETE_CANONICAL_HEALTH_STATUSES.has(canonicalSession.persistedCanonicalHealthStatus);

  if (canonicalContentComplete) {
    const qualified = classifyCompleteCanonicalSession(canonicalSession);
    if (qualified) return qualified.selection;
  }

  const derivedLookup = resolveDerivedLookup();

  if (derivedLookup.kind === 'AVAILABLE') {
    const session = derivedLookup.session;
    return {
      precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
      tradingDate,
      authorizationId: session.authorizationId,
      derivedContentChecksum: session.derivedContentChecksum,
      derivedArtifactRelativePath: derivedLookup.relativePath,
      sourceSnapshotChecksum: session.sourceSnapshotChecksum,
      sourceSnapshotProviderId: session.sourceSnapshotProviderId,
      realRowCount: session.realRowCount,
      imputedRowCount: session.imputedRowCount,
    };
  }

  const notYetCaptured = derivedLookup.kind === 'NOT_YET_CAPTURED';
  return {
    precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE,
    tradingDate,
    persistedCanonicalHealthStatus: canonicalSession.persistedCanonicalHealthStatus,
    reason: canonicalContentComplete
      ? notYetCaptured
        ? ResearchSessionUnavailableReason.CANONICAL_PROVENANCE_UNAVAILABLE_DERIVED_NOT_YET_CAPTURED
        : ResearchSessionUnavailableReason.CANONICAL_PROVENANCE_UNAVAILABLE_NO_AUTHORIZED_DERIVED
      : notYetCaptured
        ? ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_DERIVED_NOT_YET_CAPTURED
        : ResearchSessionUnavailableReason.CANONICAL_INCOMPLETE_NO_AUTHORIZED_DERIVED,
  };
}
