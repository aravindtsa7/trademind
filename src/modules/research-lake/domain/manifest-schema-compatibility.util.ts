import { DatasetManifest, MANIFEST_SCHEMA_VERSION, SourceAcquisitionProvenanceComposition } from './dataset-manifest.types';

/**
 * B-F2D CORRECTION (Terra re-review HIGH-2, "MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION
 * revokes previously documented v1/v3 readability without a proven
 * compatibility/deprecation policy"): the previous pass set MIN_SUPPORTED to
 * 4 by assumption. This is the reconstructed, EVIDENCE-BASED compatibility
 * matrix for every `DatasetManifest` wire version that has ever existed in
 * this repository, derived from the actual committed shape of
 * `dataset-manifest.types.ts` at each `MANIFEST_SCHEMA_VERSION` bump (git
 * commits 8dd72c8 "add deterministic dataset manifests" = v1, 077f6fa "add
 * durable acquisition evidence" = v2, 584d46b "make calendar semantics end
 * to end" = v3) plus the uncommitted v3->v4 (B-F8 composite-repair
 * provenance) and v4->v5 (this correction's own UNKNOWN_LEGACY_REPAIR_PROVENANCE)
 * bumps, never assumed from the current v5 shape:
 *
 * ---------------------------------------------------------------------------
 * v1 (8dd72c8): the original B-F5 shape.
 *   DatasetManifest: manifestSchemaVersion, datasetKind, canonicalizationVersion,
 *     healthSemanticsVersion, datasetChecksum, datasetId, provenance,
 *     generatedAt, sessions, sessionCounts. (Identical top-level field set to
 *     every later version -- no top-level field has ever been added/removed.)
 *   SessionManifest: identity, canonicalizationVersion, healthSemanticsVersion,
 *     contentChecksum, canonicalRowCount, persistedCanonicalHealthStatus,
 *     optionObservationState, issues, rowsWithOi, rowsWithNullOi,
 *     sourceAcquisitionEvidence. NO `calendarSessionWindows` field at all
 *     (introduced at v3 -- see below).
 *   SourceAcquisitionEvidence: {availability, providerRowCount, excludedRowCount,
 *     sourceOrderAnomalyCount, sourceHealthStatus} ONLY -- no `provider`, no
 *     `evidenceSemanticChecksum`, no `provenanceComposition`, no
 *     `compositeRepair`. `SourceAcquisitionEvidenceAvailability` had exactly
 *     one value: UNAVAILABLE_FROM_PERSISTED_STORE.
 *   provenanceComposition: DOES NOT EXIST as a concept at v1.
 *
 * v2 (077f6fa, "Bumped 1 -> 2 for B-F2C"): SourceAcquisitionEvidence gains
 *   `provider` and `evidenceSemanticChecksum` (both nullable, observability
 *   only). `SourceAcquisitionEvidenceAvailability` gains
 *   AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE. SessionManifest shape is
 *   otherwise unchanged from v1 -- still no `calendarSessionWindows`.
 *   The v1->v2 bump's own doc comment states: "Existing schema-version-1
 *   manifest artifacts remain fully readable" -- this correction upholds
 *   that claim rather than silently overturning it.
 *   provenanceComposition: STILL DOES NOT EXIST at v2.
 *
 * v3 (584d46b = current HEAD, "Bumped 2 -> 3 for B-F5 CALENDAR FIX"):
 *   SessionManifest gains `calendarSessionWindows: readonly SessionWindow[]`
 *   (required field, `[]` when no calendar declaration was supplied at
 *   generation time -- NEVER absent in a genuine v3 artifact, unlike v1/v2
 *   where the field never existed at all). SourceAcquisitionEvidence is
 *   otherwise unchanged from v2.
 *   provenanceComposition: STILL DOES NOT EXIST at v3.
 *
 * v4 (uncommitted, B-F8 "Bumped 3 -> 4"): SourceAcquisitionEvidence gains
 *   `provenanceComposition` (REQUIRED, non-nullable) and `compositeRepair`
 *   (REQUIRED, nullable). Introduces `SourceAcquisitionProvenanceComposition`
 *   with exactly {PRIMARY_ONLY, COMPOSITE_REPAIRED}.
 *
 * v5 (this correction's own prior pass, "Bumped 4 -> 5" for the manifest
 *   wire-contract HIGH): `SourceAcquisitionProvenanceComposition` gains
 *   UNKNOWN_LEGACY_REPAIR_PROVENANCE. No other field shape change from v4.
 * ---------------------------------------------------------------------------
 *
 * WHETHER CURRENT (v5) CODE CAN TRUTHFULLY INTERPRET EACH VERSION -- traced
 * from the ACTUAL consumers, not assumed:
 *   - `DatasetManifestService.verifyManifest` recomputes a session's
 *     checksum via `DatasetSessionManifestBuilderService.build`, which reads
 *     `sessionWindows` (originally `original.calendarSessionWindows`) as an
 *     OPTIONAL parameter: `undefined` falls back to the fixed 375-row
 *     regular-session default (`dataset-session-manifest-builder.service.ts`:
 *     "`undefined`/`[]` preserves the pre-existing default exactly"). A v1/v2
 *     artifact's `original.calendarSessionWindows` is `undefined` (the field
 *     never existed) -- which reproduces EXACTLY how a v1/v2 manifest was
 *     truthfully generated in the first place (before the v3 calendar fix
 *     existed at all). This is not a coincidence to rely on blindly, but it
 *     is independently proven by the v1/v2/v3 compatibility tests in
 *     `manifest-schema-compatibility.util.test.ts` and the resume tests in
 *     `research-year-runner.service.test.ts`.
 *   - `verifyManifest` NEVER reads `sourceAcquisitionEvidence`/
 *     `provenanceComposition` for any recomputation or comparison decision --
 *     grep-verified across `dataset-manifest.service.ts`. This field is pure
 *     observability for EVERY version, so its absence (v1-v3) or presence
 *     (v4+) never affects verify/resume correctness.
 *   - `ResearchLakeParquetExportService.exportDataset` /
 *     `ResearchLakeParquetVerifyService.verifyStorageDescriptor` only ever
 *     read `identity`, `contentChecksum`, `canonicalRowCount`, and
 *     `persistedCanonicalHealthStatus` off a session (grep-verified) -- all
 *     four have existed, unchanged in shape, since v1.
 * Conclusion: v1 through v5 are ALL genuinely, provably safe for current
 * code to consume. There is no evidence basis for rejecting v1-v3, so this
 * correction does NOT invoke the fail-closed deprecation design (only
 * warranted if actual code/history proved a version unsafe to read) --
 * MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION restores the full documented range.
 */
export const MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

/**
 * `SourceAcquisitionEvidence.provenanceComposition` did not exist before
 * this schema version (see the compatibility matrix above -- verified
 * directly against the committed v1/v2/v3 shape, not assumed from v5). A
 * genuine v1/v2/v3 artifact's `sourceAcquisitionEvidence` object has no
 * `provenanceComposition` KEY AT ALL; this is never required/validated for
 * those versions, and its absence is never (mis)interpreted as
 * `PRIMARY_ONLY` or `UNKNOWN_LEGACY_REPAIR_PROVENANCE` -- both would be
 * fabrication. It is simply not a concept that version's contract has.
 */
export const PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION = 4;

export type ManifestSchemaCompatibilityErrorCode =
  | 'MISSING_OR_INVALID_SCHEMA_VERSION'
  | 'FUTURE_SCHEMA_VERSION'
  | 'UNSUPPORTED_ANCIENT_SCHEMA_VERSION'
  | 'MISSING_OR_INVALID_SESSIONS'
  | 'EMPTY_SESSIONS'
  | 'INVALID_PROVENANCE_COMPOSITION';

export class ManifestSchemaCompatibilityError extends Error {
  constructor(
    public readonly code: ManifestSchemaCompatibilityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ManifestSchemaCompatibilityError';
  }
}

function fail(code: ManifestSchemaCompatibilityErrorCode, message: string): never {
  throw new ManifestSchemaCompatibilityError(code, message);
}

/** Exactly the `SourceAcquisitionProvenanceComposition` values a schema-v4 manifest artifact may truthfully contain. `UNKNOWN_LEGACY_REPAIR_PROVENANCE` is a v5-only value -- current code never emits it into a v4 artifact (see `MANIFEST_SCHEMA_VERSION`'s doc), and a v4 artifact that somehow contains it is contract-invalid. */
const V4_ALLOWED_PROVENANCE_COMPOSITIONS: ReadonlySet<string> = new Set([SourceAcquisitionProvenanceComposition.PRIMARY_ONLY, SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED]);

/** Every `SourceAcquisitionProvenanceComposition` value a schema-v5 manifest artifact may contain. */
const V5_ALLOWED_PROVENANCE_COMPOSITIONS: ReadonlySet<string> = new Set([
  SourceAcquisitionProvenanceComposition.PRIMARY_ONLY,
  SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED,
  SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE,
]);

/**
 * `version` is guaranteed by `assertManifestSchemaCompatible`'s own prior
 * checks to be an integer in
 * `[PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION]`
 * by the time this is called (callers only invoke it for
 * `version >= PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION`, and any
 * version above `MANIFEST_SCHEMA_VERSION` was already rejected as
 * FUTURE_SCHEMA_VERSION). The empty-set fallback is an explicit fail-closed
 * default, kept rather than relying on that invariant holding forever by
 * assumption -- it also correctly fails closed if a THIRD provenance-bearing
 * version is ever introduced between 4 and 5 without updating this function.
 */
function allowedProvenanceCompositionsForVersion(version: number): ReadonlySet<string> {
  if (version === MANIFEST_SCHEMA_VERSION) return V5_ALLOWED_PROVENANCE_COMPOSITIONS;
  if (version === PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION) return V4_ALLOWED_PROVENANCE_COMPOSITIONS;
  return new Set();
}

/**
 * ONE centralized manifest schema-compatibility guard (B-F2D correction).
 * Every boundary that accepts a `DatasetManifest` artifact from OUTSIDE the
 * in-process call that just generated it (a `JSON.parse`'d file, a
 * checkpoint/resume path, any CLI-supplied manifest path, or ANY public
 * service method whose caller might not have validated first) MUST call
 * this as its FIRST semantic operation, before interpreting `sessions`/
 * `sourceAcquisitionEvidence` in any way. Wired into:
 *   - `DatasetManifestService.verifyManifest`
 *   - `ResearchLakeParquetExportService.exportDataset`
 *   - `ResearchLakeParquetVerifyService.verifyStorageDescriptor`
 *   - the 3 manifest-consuming CLI scripts (research-dataset-manifest-verify,
 *     research-parquet-verify, research-parquet-export)
 *   - `ResearchYearRunnerService.tryRevalidateInstrument` (checkpoint/resume)
 * Public service methods defend themselves directly rather than trusting a
 * caller to have validated first (Terra HIGH-1: "Public service boundaries
 * must defend themselves") -- never rely on CLI callers, year-runner, or
 * TypeScript's `as DatasetManifest` cast alone.
 *
 * Fail-closed policy:
 *   - missing/non-integer `manifestSchemaVersion`             -> reject
 *   - `manifestSchemaVersion` > current `MANIFEST_SCHEMA_VERSION` -> reject
 *     (a future, unknown contract)
 *   - `manifestSchemaVersion` < `MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION` -> reject
 *   - missing / `null` / non-array `sessions`                  -> reject
 *     (a required runtime field for every supported version -- never
 *     silently treated as `[]`)
 *   - a present-but-empty `sessions: []`                       -> reject
 *     (current generation can never legitimately produce zero sessions --
 *     see `EMPTY_SESSIONS`'s own message -- so this is a structurally
 *     impossible, not merely unusual, artifact shape)
 *   - for `manifestSchemaVersion >= PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION`:
 *     a session's `provenanceComposition` outside the allowed set for its
 *     OWN declared version                                     -> reject
 *   - for `manifestSchemaVersion < PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION`:
 *     `provenanceComposition` is never required/validated -- that schema
 *     genuinely never had this field (see the compatibility matrix above)
 *
 * Never trusts TypeScript's `as DatasetManifest` cast: every field read here
 * is treated as `unknown` at runtime. Never mutates or "upgrades" the
 * manifest object -- this function only ever accepts (returns normally) or
 * rejects (throws `ManifestSchemaCompatibilityError`).
 */
export function assertManifestSchemaCompatible(manifest: DatasetManifest): void {
  const raw = manifest as unknown as { manifestSchemaVersion?: unknown; sessions?: unknown } | null | undefined;
  const version = raw?.manifestSchemaVersion;

  if (typeof version !== 'number' || !Number.isInteger(version)) {
    fail('MISSING_OR_INVALID_SCHEMA_VERSION', `Manifest artifact is missing a valid integer manifestSchemaVersion (got ${JSON.stringify(version)}). Rejecting fail-closed rather than guessing at its contract.`);
  }
  if (version > MANIFEST_SCHEMA_VERSION) {
    fail(
      'FUTURE_SCHEMA_VERSION',
      `Manifest schema version ${version} is newer than this reader supports (current ${MANIFEST_SCHEMA_VERSION}). Rejecting fail-closed before interpreting sessions/provenance -- this reader has no basis to assume it understands a future contract.`
    );
  }
  if (version < MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_ANCIENT_SCHEMA_VERSION',
      `Manifest schema version ${version} predates this reader's minimum supported version ${MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION}. Rejecting fail-closed rather than guessing at an unknown contract.`
    );
  }

  // B-F2D CORRECTION (Terra re-review MEDIUM): `sessions` is a REQUIRED
  // runtime field for every supported version -- missing/null/non-array is a
  // structurally invalid artifact, never silently coerced into `[]`.
  const sessionsRaw = raw?.sessions;
  if (!Array.isArray(sessionsRaw)) {
    fail('MISSING_OR_INVALID_SESSIONS', `Manifest artifact is missing a valid sessions array (got ${JSON.stringify(sessionsRaw)}). Rejecting fail-closed rather than silently treating this as zero sessions.`);
  }
  // B-F2D CORRECTION: distinct from the check above -- `sessions` is present
  // and genuinely an array, but empty. Current DatasetManifest generation
  // (`DatasetManifestService.assertBoundedSortedDates`) has never been able
  // to produce this: it rejects an empty tradingDates request before
  // building anything, and every accepted request pushes exactly one session
  // per requested date, so `sessions.length` has always been `>= 1` for
  // every artifact any version of this codebase has ever generated. An
  // explicit `sessions: []` is therefore rejected fail-closed as an artifact
  // shape production code cannot create, not silently accepted as "an empty
  // dataset".
  if (sessionsRaw.length === 0) {
    fail(
      'EMPTY_SESSIONS',
      'Manifest artifact has an explicitly empty sessions array. Current DatasetManifest generation can never legitimately produce zero sessions -- rejecting fail-closed rather than accepting an artifact shape production code cannot create.'
    );
  }

  if (version >= PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION) {
    const allowedProvenanceCompositions = allowedProvenanceCompositionsForVersion(version);
    for (const session of sessionsRaw) {
      const provenanceComposition = (session as { sourceAcquisitionEvidence?: { provenanceComposition?: unknown } } | null)?.sourceAcquisitionEvidence?.provenanceComposition;
      if (typeof provenanceComposition !== 'string' || !allowedProvenanceCompositions.has(provenanceComposition)) {
        fail(
          'INVALID_PROVENANCE_COMPOSITION',
          `Session sourceAcquisitionEvidence.provenanceComposition ${JSON.stringify(provenanceComposition)} is not a value schema v${version} may contain. Rejecting fail-closed rather than silently coercing an unknown enum value or fabricating PRIMARY_ONLY.`
        );
      }
    }
  }
  // versions < PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION: this
  // field did not exist in that schema (see the compatibility matrix above)
  // -- absence is exactly what a genuine historical artifact looks like,
  // never validated/required here, never fabricated into one either.
}
