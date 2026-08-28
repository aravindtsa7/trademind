import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { SessionWindow, validateSessionWindows } from './exchange-calendar.types';

/**
 * Exactly the content that determines a coverage version's semantic identity
 * (task section 5/10: "deterministic normalized source-bundle identity" /
 * "compute deterministic SHA-256 semantic/source-bundle checksum"). Reuses
 * the existing B-F5 `canonicalManifestJson`/`sha256Hex` primitives
 * (`dataset-manifest-canonical-json.ts`) rather than introducing a second
 * canonical-JSON implementation -- same determinism guarantees (sorted
 * object keys, explicit `bigint`/`Date`/`undefined` handling) apply here.
 *
 * `canonicalizeCoverageContent` sorts source documents, days, and windows
 * before hashing, so caller input order never perturbs the checksum.
 */
export interface NormalizedSourceDocumentContent {
  readonly documentReference: string;
  readonly documentType: string;
  readonly contentChecksumSha256: string;
  readonly referenceUrl: string | null;
}

export interface NormalizedCalendarDayContent {
  readonly tradingDate: string; // YYYY-MM-DD
  readonly classification: string;
  readonly reason: string | null;
  readonly sourceDocumentReference: string | null;
  readonly windows: readonly SessionWindow[];
}

export interface NormalizedCoverageContent {
  readonly exchange: string;
  readonly segment: string;
  readonly calendarYear: number;
  readonly coverageFrom: string; // YYYY-MM-DD
  readonly coverageTo: string; // YYYY-MM-DD
  readonly version: number;
  readonly sourceAuthority: string;
  readonly sourceDocuments: readonly NormalizedSourceDocumentContent[];
  readonly days: readonly NormalizedCalendarDayContent[];
}

function sortedSourceDocuments(documents: readonly NormalizedSourceDocumentContent[]): NormalizedSourceDocumentContent[] {
  return [...documents].sort((left, right) => (left.documentReference < right.documentReference ? -1 : left.documentReference > right.documentReference ? 1 : 0));
}

function sortedDays(days: readonly NormalizedCalendarDayContent[]): NormalizedCalendarDayContent[] {
  return [...days]
    .map((day) => ({ ...day, windows: validateSessionWindows(day.windows) }))
    .sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : 0));
}

/**
 * Produces the canonical, order-independent form of a coverage's content
 * (source documents sorted by `documentReference`, days sorted by
 * `tradingDate`, each day's windows sorted by `windowIndex`). This is the
 * ONLY form ever hashed -- callers must not hash caller-supplied array order
 * directly.
 */
export function canonicalizeCoverageContent(content: NormalizedCoverageContent): NormalizedCoverageContent {
  return {
    ...content,
    sourceDocuments: sortedSourceDocuments(content.sourceDocuments),
    days: sortedDays(content.days),
  };
}

interface SemanticCoverageContent {
  readonly exchange: string;
  readonly segment: string;
  readonly calendarYear: number;
  readonly coverageFrom: string;
  readonly coverageTo: string;
  readonly version: number;
  readonly sourceAuthority: string;
  readonly sourceDocuments: ReadonlyArray<{
    readonly documentReference: string;
    readonly documentType: string;
    readonly contentChecksumSha256: string;
  }>;
  readonly days: ReadonlyArray<{
    readonly tradingDate: string;
    readonly classification: string;
    readonly sourceDocumentReference: string | null;
    readonly windows: readonly SessionWindow[];
  }>;
}

/**
 * `referenceUrl` is navigation metadata and may move without changing source
 * identity. Human `reason` text is observability-only prose, so it is also
 * excluded; authoritative date classification and supporting document bytes
 * carry the semantic identity instead.
 */
function semanticCoverageContent(content: NormalizedCoverageContent): SemanticCoverageContent {
  const canonical = canonicalizeCoverageContent(content);
  return {
    exchange: canonical.exchange,
    segment: canonical.segment,
    calendarYear: canonical.calendarYear,
    coverageFrom: canonical.coverageFrom,
    coverageTo: canonical.coverageTo,
    version: canonical.version,
    sourceAuthority: canonical.sourceAuthority,
    sourceDocuments: canonical.sourceDocuments.map((document) => ({
      documentReference: document.documentReference,
      documentType: document.documentType,
      contentChecksumSha256: document.contentChecksumSha256,
    })),
    days: canonical.days.map((day) => ({
      tradingDate: day.tradingDate,
      classification: day.classification,
      sourceDocumentReference: day.sourceDocumentReference,
      windows: day.windows,
    })),
  };
}

/**
 * Deterministic SHA-256 source-bundle checksum for one coverage version
 * (task section 5/10). Content-addressed identity: identical semantic
 * content -> identical checksum regardless of input array order (task
 * section 10.U/V/W); any semantic difference (a changed date, a changed
 * classification, a changed window boundary, a changed document reference or
 * document content hash) -> a different checksum. Navigation URL and human
 * reason prose are explicitly excluded by `semanticCoverageContent`.
 */
export function computeCoverageSourceBundleChecksum(content: NormalizedCoverageContent): string {
  return sha256Hex(canonicalManifestJson(semanticCoverageContent(content)));
}
