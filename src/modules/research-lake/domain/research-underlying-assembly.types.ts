import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { ManifestDatasetKind } from './dataset-manifest.types';
import { contentAddressedJsonRelativePath, ContentAddressedJsonStoreResult, readContentAddressedJson, storeContentAddressedJson } from './content-addressed-json-store';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResearchSessionSourceSelection } from './research-session-source-selection';

/**
 * B-M7.2: the deterministic, content-addressed RESEARCH-LAYER overlay
 * artifact for one instrument/timeframe/year. Deliberately SEPARATE from
 * `DatasetManifest` (task: "Do NOT modify DatasetManifest / canonical
 * manifest schema to embed synthetic research data... Create a SEPARATE
 * research-layer artifact") -- the canonical manifest this artifact
 * references remains completely untouched, and a consumer can never confuse
 * "canonical session is healthy" with "research layer has an authorized
 * derived replacement for an incomplete canonical session": every session
 * selection below carries its own explicit `precedenceTier`.
 *
 * Never embeds candle payloads (task: "no duplicate 247-session candle
 * payload") -- each selection carries only stable identifiers/checksums;
 * actual 1-minute rows are resolved on demand via
 * `ResearchUnderlying1mSessionReaderService` (the read boundary a future
 * B-M7.3 consumes).
 */
export const RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION = 1;
export const RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION = 1;

export const RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT = 'artifacts/research-lake';
export const RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_SUBDIR = 'research-underlying-assemblies';

export interface ResearchUnderlyingDatasetAssemblyIdentity {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly year: number;
}

/**
 * The exact canonical `DatasetManifest` this assembly was built from --
 * reference only (task: "the overlay must retain the canonical manifest's
 * datasetChecksum / dataset identity as a source reference"). `B-M7.2`
 * never rewrites or embeds the canonical manifest's own session content
 * here; a consumer that needs to re-verify canonical truth re-reads/re-
 * generates the canonical manifest itself via the existing, unmodified
 * `DatasetManifestService`.
 */
export interface CanonicalManifestReference {
  readonly datasetKind: ManifestDatasetKind;
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly manifestSchemaVersion: number;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
}

export interface ResearchUnderlyingDatasetAssemblySessionCounts {
  readonly expectedSessions: number;
  readonly researchReadySessions: number;
  readonly realCanonicalSessions: number;
  readonly compositeRepairedSessions: number;
  readonly authorizedDerivedSessions: number;
  readonly unavailableSessions: number;
}

/**
 * HIGH-06 CORRECTION: this artifact carries NO wall-clock/run-varying field
 * at all -- not even one excluded from `assemblyContentChecksum`. A field
 * merely excluded from the CHECKSUM is not enough: the generic
 * content-addressed store (`storeContentAddressedJson`) only ever verifies
 * an EXISTING file's checksum on conflict, it never diffs byte-for-byte
 * against a caller's fresh candidate bytes -- so a `generatedAt`-bearing
 * artifact would silently keep whichever wall-clock value the FIRST writer
 * happened to persist, while every later semantically-identical build's own
 * in-memory `generatedAt` differs from what is actually on disk. That is not
 * a genuinely deterministic content-addressed artifact. `sessionCounts` is
 * the ONE exception to "every field is identity material" -- it remains
 * outside the checksum ONLY because it is fully, deterministically derived
 * from `sessions` (same `sessions` -> same `sessionCounts`, always) and the
 * specialized reader (`readResearchUnderlyingDatasetAssembly`)
 * independently re-derives and verifies it on every read (HIGH-05) -- it is
 * never a wall-clock/run-varying value like `generatedAt` was.
 */
export interface ResearchUnderlyingDatasetAssemblyV1 {
  readonly schemaVersion: number;
  readonly assemblySemanticsVersion: number;
  readonly identity: ResearchUnderlyingDatasetAssemblyIdentity;
  readonly canonicalManifest: CanonicalManifestReference;
  /** Ascending by `tradingDate` -- deterministic, never DB/filesystem/input-array enumeration order. Exactly one entry per certified expected trading session. */
  readonly sessions: readonly ResearchSessionSourceSelection[];
  readonly sessionCounts: ResearchUnderlyingDatasetAssemblySessionCounts;
  readonly assemblyContentChecksum: string;
}

/** Exactly the content that determines `assemblyContentChecksum` -- IDENTITY MATERIAL only. `sessionCounts` (fully derivable from `sessions`, re-verified on every read -- see `ResearchUnderlyingDatasetAssemblyV1`'s own doc) is the one field deliberately excluded, matching `DatasetManifest.datasetChecksum`'s own separation of identity vs. observability material. */
export type ResearchUnderlyingDatasetAssemblyContentPayload = Pick<ResearchUnderlyingDatasetAssemblyV1, 'schemaVersion' | 'assemblySemanticsVersion' | 'identity' | 'canonicalManifest' | 'sessions'>;

export function sortSelectionsByTradingDate(sessions: readonly ResearchSessionSourceSelection[]): ResearchSessionSourceSelection[] {
  return [...sessions].sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : 0));
}

/**
 * Fails closed if two or more selections describe the same logical trading
 * date (task: "duplicate logical trading-date selection fails closed").
 * Never silently deduplicates or picks one. Structurally unreachable today
 * (the certified calendar session list this milestone requests from is
 * itself deduplicated), but kept as an explicit defensive guard -- mirrors
 * this codebase's own `assertNoDuplicateSessionIdentities` convention.
 */
export function assertNoDuplicateTradingDateSelections(sessions: readonly ResearchSessionSourceSelection[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.tradingDate)) {
      throw new Error(`B-M7.2 research assembly: duplicate trading-date selection for '${session.tradingDate}' -- refusing to silently deduplicate.`);
    }
    seen.add(session.tradingDate);
  }
}

/**
 * Content-addressed assembly checksum (task: "Same canonical manifest +
 * selected source set + derived artifact + semantics versions must always
 * produce the SAME assembly checksum regardless of DB iteration order,
 * input array order, filesystem enumeration order, process time, or machine
 * path"). Sessions are sorted before hashing so caller-supplied ordering
 * never perturbs identity; changing any material selected session's
 * checksum/source changes this checksum (every selection variant's own
 * checksum/identity fields are part of the hashed payload). No random UUID,
 * wall-clock timestamp, or machine path ever enters this payload.
 */
export function computeResearchUnderlyingAssemblyChecksum(payload: ResearchUnderlyingDatasetAssemblyContentPayload): string {
  const sorted: ResearchUnderlyingDatasetAssemblyContentPayload = { ...payload, sessions: sortSelectionsByTradingDate(payload.sessions) };
  return sha256Hex(canonicalManifestJson(sorted));
}

/**
 * HIGH-05 CORRECTION: the ONE pure count-derivation function, used both when
 * BUILDING an assembly and when READING one back (see
 * `readResearchUnderlyingDatasetAssembly`) -- `sessionCounts` can therefore
 * never silently drift from the actual `sessions` array between the two.
 */
export function deriveResearchUnderlyingAssemblySessionCounts(sessions: readonly ResearchSessionSourceSelection[]): ResearchUnderlyingDatasetAssemblySessionCounts {
  let realCanonicalSessions = 0;
  let compositeRepairedSessions = 0;
  let authorizedDerivedSessions = 0;
  let unavailableSessions = 0;
  for (const session of sessions) {
    switch (session.precedenceTier) {
      case ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION:
        realCanonicalSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION:
        compositeRepairedSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION:
        authorizedDerivedSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.UNAVAILABLE:
        unavailableSessions += 1;
        break;
      default: {
        const exhaustive: never = session;
        throw new Error(`Unhandled ResearchSessionSourceSelection: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return {
    expectedSessions: sessions.length,
    researchReadySessions: realCanonicalSessions + compositeRepairedSessions + authorizedDerivedSessions,
    realCanonicalSessions,
    compositeRepairedSessions,
    authorizedDerivedSessions,
    unavailableSessions,
  };
}

export interface BuildResearchUnderlyingDatasetAssemblyInput {
  readonly schemaVersion: number;
  readonly assemblySemanticsVersion: number;
  readonly identity: ResearchUnderlyingDatasetAssemblyIdentity;
  readonly canonicalManifest: CanonicalManifestReference;
  readonly sessions: readonly ResearchSessionSourceSelection[];
}

export function buildResearchUnderlyingDatasetAssembly(input: BuildResearchUnderlyingDatasetAssemblyInput): ResearchUnderlyingDatasetAssemblyV1 {
  assertNoDuplicateTradingDateSelections(input.sessions);
  const sessions = sortSelectionsByTradingDate(input.sessions);
  const payload: ResearchUnderlyingDatasetAssemblyContentPayload = {
    schemaVersion: input.schemaVersion,
    assemblySemanticsVersion: input.assemblySemanticsVersion,
    identity: input.identity,
    canonicalManifest: input.canonicalManifest,
    sessions,
  };
  const assemblyContentChecksum = computeResearchUnderlyingAssemblyChecksum(payload);
  return { ...payload, sessionCounts: deriveResearchUnderlyingAssemblySessionCounts(sessions), assemblyContentChecksum };
}

export function researchUnderlyingDatasetAssemblyRelativePath(assemblyContentChecksum: string): string {
  return contentAddressedJsonRelativePath(RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_SUBDIR, assemblyContentChecksum);
}

/** Idempotent: an existing assembly at the same checksum-derived path is verified, never blindly overwritten (matches `storeDerivedImputedResearchSession`'s own contract). */
export function storeResearchUnderlyingDatasetAssembly(root: string, assembly: ResearchUnderlyingDatasetAssemblyV1): ContentAddressedJsonStoreResult {
  return storeContentAddressedJson(
    root,
    RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_SUBDIR,
    assembly.assemblyContentChecksum,
    assembly,
    (parsed) => computeResearchUnderlyingAssemblyChecksum(stripAssemblyChecksum(parsed))
  );
}

/** Thrown when a stored B-M7.2 assembly artifact fails ANY read-time integrity check -- see `readResearchUnderlyingDatasetAssembly`'s own doc for why this must never be silently normalized/overwritten. */
export class ResearchUnderlyingAssemblyIntegrityError extends Error {
  constructor(
    readonly assemblyContentChecksum: string,
    readonly violations: readonly string[]
  ) {
    super(
      `B-M7.2 research assembly at checksum '${assemblyContentChecksum}' failed read-time integrity verification: ${violations.join('; ')}. Refusing to trust a stored artifact whose fields no longer match its own recomputed content.`
    );
    this.name = 'ResearchUnderlyingAssemblyIntegrityError';
  }
}

function sessionCountsEqual(left: ResearchUnderlyingDatasetAssemblySessionCounts, right: ResearchUnderlyingDatasetAssemblySessionCounts): boolean {
  return (
    left.expectedSessions === right.expectedSessions &&
    left.researchReadySessions === right.researchReadySessions &&
    left.realCanonicalSessions === right.realCanonicalSessions &&
    left.compositeRepairedSessions === right.compositeRepairedSessions &&
    left.authorizedDerivedSessions === right.authorizedDerivedSessions &&
    left.unavailableSessions === right.unavailableSessions
  );
}

/**
 * HIGH-05 CORRECTION: reading a stored assembly now independently
 * re-verifies it rather than trusting the parsed JSON's own fields --
 * `sessionCounts` is deliberately NOT part of `assemblyContentChecksum`
 * (see `ResearchUnderlyingDatasetAssemblyContentPayload`'s own doc), so a
 * generic content-addressed checksum match alone can NEVER prove
 * `sessionCounts` still agrees with `sessions`. Every check below fails
 * closed -- a mismatch throws `ResearchUnderlyingAssemblyIntegrityError`,
 * never a silent normalize/overwrite:
 *  1. `schemaVersion`/`assemblySemanticsVersion` are the currently-supported
 *     values this reader understands.
 *  2. The IDENTITY MATERIAL (`schemaVersion`, `assemblySemanticsVersion`,
 *     `identity`, `canonicalManifest`, `sessions`) re-hashes to EXACTLY the
 *     requested content-addressed `assemblyContentChecksum`, and the
 *     artifact's own self-declared `assemblyContentChecksum` field agrees.
 *  3. `sessions` contains no duplicate `tradingDate` (mirrors
 *     `assertNoDuplicateTradingDateSelections`, defensively re-applied here
 *     too since this is a boundary reading arbitrary on-disk JSON).
 *  4. `sessionCounts` recomputed fresh from `sessions` via
 *     `deriveResearchUnderlyingAssemblySessionCounts` matches the STORED
 *     `sessionCounts` field-for-field -- catching exactly the tamper case
 *     `assemblyContentChecksum` alone cannot (`sessions` genuinely unchanged,
 *     `sessionCounts` silently edited).
 */
export function readResearchUnderlyingDatasetAssembly(root: string, assemblyContentChecksum: string): ResearchUnderlyingDatasetAssemblyV1 {
  const parsed = readContentAddressedJson<ResearchUnderlyingDatasetAssemblyV1>(root, RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_SUBDIR, assemblyContentChecksum);
  const violations: string[] = [];

  if (parsed.schemaVersion !== RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION) {
    violations.push(`schemaVersion ${parsed.schemaVersion} is not the supported ${RESEARCH_UNDERLYING_ASSEMBLY_SCHEMA_VERSION}`);
  }
  if (parsed.assemblySemanticsVersion !== RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION) {
    violations.push(`assemblySemanticsVersion ${parsed.assemblySemanticsVersion} is not the supported ${RESEARCH_UNDERLYING_ASSEMBLY_SEMANTICS_VERSION}`);
  }

  const recomputedChecksum = computeResearchUnderlyingAssemblyChecksum(stripAssemblyChecksum(parsed));
  if (recomputedChecksum !== assemblyContentChecksum || parsed.assemblyContentChecksum !== assemblyContentChecksum) {
    violations.push(`recomputed assemblyContentChecksum '${recomputedChecksum}' (self-declared '${parsed.assemblyContentChecksum}') does not match the requested content-addressed checksum '${assemblyContentChecksum}'`);
  }

  try {
    assertNoDuplicateTradingDateSelections(parsed.sessions);
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  const recomputedCounts = deriveResearchUnderlyingAssemblySessionCounts(parsed.sessions);
  if (!sessionCountsEqual(recomputedCounts, parsed.sessionCounts)) {
    violations.push(`stored sessionCounts ${JSON.stringify(parsed.sessionCounts)} does not match recomputed counts ${JSON.stringify(recomputedCounts)}`);
  }

  if (violations.length > 0) {
    throw new ResearchUnderlyingAssemblyIntegrityError(assemblyContentChecksum, violations);
  }

  return parsed;
}

function stripAssemblyChecksum(assembly: ResearchUnderlyingDatasetAssemblyV1): ResearchUnderlyingDatasetAssemblyContentPayload {
  return {
    schemaVersion: assembly.schemaVersion,
    assemblySemanticsVersion: assembly.assemblySemanticsVersion,
    identity: assembly.identity,
    canonicalManifest: assembly.canonicalManifest,
    sessions: assembly.sessions,
  };
}
