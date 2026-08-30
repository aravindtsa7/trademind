/**
 * B-F7A-ARCHIVE-1: reviewed raw-source manifest domain model.
 *
 * This is a DISTINCT layer from `exchange-calendar.types.ts` /
 * `exchange-calendar-fixture.types.ts` / `exchange-calendar-checksum.ts`.
 * Those model NORMALIZED calendar coverage (`ExchangeCalendarCoverage`,
 * `sourceBundleChecksum`) and are closed B-F7A core. This module instead
 * describes the UPSTREAM evidence layer: which official NSE documents exist,
 * their raw-byte identity, and their lifecycle relationships -- strictly
 * BEFORE any fixture/import/certification step. Nothing here is persisted to
 * Prisma and nothing here is fed into `validateAndNormalizeCoverageFixture`.
 */

export enum RawSourceLifecycleStatus {
  /** The authoritative document for its subject matter -- carries no `withdrawnBy`/`supersededBy`. */
  FINAL = 'FINAL',
  /** Explicitly retracted/replaced by a later document named in `withdrawnBy`. */
  WITHDRAWN = 'WITHDRAWN',
  /** Explicitly superseded (distinct transition from `WITHDRAWN`) by a later document named in `supersededBy`. */
  SUPERSEDED = 'SUPERSEDED',
}

/**
 * What KIND of notice a document is, kept deliberately separate from
 * `RawSourceLifecycleStatus` (task section 8: "model authority role
 * separately from lifecycle status rather than forcing unrelated concepts
 * into one enum"). Distinct from the normalized `SourceDocumentType` in
 * `exchange-calendar.types.ts` -- that enum describes a document's role
 * inside a CERTIFIED coverage bundle; this one describes the raw archive
 * evidence's own subject matter and is never cross-imported.
 */
export enum RawSourceRole {
  ANNUAL_HOLIDAY_CIRCULAR = 'ANNUAL_HOLIDAY_CIRCULAR',
  SPECIAL_SESSION_NOTICE = 'SPECIAL_SESSION_NOTICE',
  SPECIAL_SESSION_UPDATE = 'SPECIAL_SESSION_UPDATE',
  EXCEPTIONAL_CLOSURE_NOTICE = 'EXCEPTIONAL_CLOSURE_NOTICE',
  MUHURAT_TRADING_NOTICE = 'MUHURAT_TRADING_NOTICE',
  /**
   * B-F7A-SOURCE-EVIDENCE-1: a document that CHANGES an already-published
   * annual holiday's date (e.g. `NSE/CMTR/57285`: "in partial modification
   * to Exchange circular... NSE/CMTR/54757... Current Trading Holiday June
   * 28, 2023 / Revised Trading Holiday June 29, 2023"), as distinct from
   * `EXCEPTIONAL_CLOSURE_NOTICE` (which ADDS a new one-off closure day, never
   * moves an existing one). No existing role fit this without
   * mischaracterizing the document -- mirrors `SourceDocumentType.AMENDMENT`
   * already present at the fixture layer for exactly this document kind.
   */
  HOLIDAY_AMENDMENT_NOTICE = 'HOLIDAY_AMENDMENT_NOTICE',
}

export enum RawSourceApplicabilityDomain {
  EQUITY = 'EQUITY',
  EQUITY_DERIVATIVES = 'EQUITY_DERIVATIVES',
}

/**
 * Whether a document's applicability to a domain is stated directly in its
 * own text (`DIRECT`) or only follows through an explicit continuation chain
 * (`INHERITED_BY_CONTINUATION`, task section 15 -- e.g. MSD/60300 and
 * MSD/60318 are "Update" notices in the Jan-20 lineage and never themselves
 * restate the EQUITY/EQUITY_DERIVATIVES scope MSD/59999 established).
 */
export enum RawSourceApplicabilityBasis {
  DIRECT = 'DIRECT',
  INHERITED_BY_CONTINUATION = 'INHERITED_BY_CONTINUATION',
}

export interface RawSourceApplicability {
  readonly domain: RawSourceApplicabilityDomain;
  readonly basis: RawSourceApplicabilityBasis;
}

/**
 * Whether a manifest entry's `sourceUrl` has actually been reviewed and
 * approved for live archiving. `PENDING_OFFICIAL_URL_ASSIGNMENT` exists
 * because this implementation was NOT handed verified per-document official
 * URLs for the 2024 pilot set (only circular reference numbers/dates/
 * subjects) -- task rule "never invent/guess URLs" and CLAUDE.md's "do not
 * invent... schemas" forbid fabricating a plausible-looking
 * nsearchives.nseindia.com path. An entry in this state MUST have
 * `sourceUrl: null`; the archiver fails closed on it rather than ever
 * constructing a guessed URL (see `nse-raw-source-archiver.service.ts`).
 */
export enum RawSourceUrlReviewStatus {
  PENDING_OFFICIAL_URL_ASSIGNMENT = 'PENDING_OFFICIAL_URL_ASSIGNMENT',
  REVIEWED = 'REVIEWED',
}

/**
 * One reviewed entry in the STATIC manifest (task section 13: "STATIC
 * REVIEWED SOURCE DEFINITION", never a runtime retrieval receipt). Every
 * field here is reviewed human metadata, checked into Git, and must produce
 * an identical object on every parse -- no generated timestamps.
 */
export interface ReviewedRawSourceManifestEntry {
  readonly reference: string; // e.g. "NSE/MSD/60340"
  readonly urlReviewStatus: RawSourceUrlReviewStatus;
  /** Official document URL. Must be `null` while `urlReviewStatus` is `PENDING_OFFICIAL_URL_ASSIGNMENT`. */
  readonly sourceUrl: string | null;
  readonly primaryDepartment: string | null;
  readonly circularReference: string;
  readonly publicationDate: string; // YYYY-MM-DD
  readonly subject: string;
  readonly applicableSegments: readonly RawSourceApplicability[];
  readonly sourceRole: RawSourceRole;
  readonly lifecycleStatus: RawSourceLifecycleStatus;
  /** References this document explicitly withdraws (task section 8). Empty unless `lifecycleStatus === FINAL`. */
  readonly withdraws: readonly string[];
  /** The reference that withdrew this document. Non-null iff `lifecycleStatus === WITHDRAWN`. */
  readonly withdrawnBy: string | null;
  readonly supersedes: readonly string[];
  /** Non-null iff `lifecycleStatus === SUPERSEDED`. */
  readonly supersededBy: string | null;
  readonly notes: string | null;
}

export interface ReviewedRawSourceManifest {
  readonly manifestSchemaVersion: number;
  readonly pilotId: string;
  readonly calendarYear: number;
  readonly entries: readonly ReviewedRawSourceManifestEntry[];
}

export const RAW_SOURCE_MANIFEST_SCHEMA_VERSION = 1;

/** The exact 16 accepted 2024 pilot references (task section 4) -- used to prove "all expected source refs present" without silently tolerating a smaller/larger accepted set. */
export const EXPECTED_2024_PILOT_REFERENCES: readonly string[] = [
  'NSE/CMTR/59722',
  'NSE/FAOP/59723',
  'NSE/MSD/59999',
  'NSE/MSD/60300',
  'NSE/MSD/60318',
  'NSE/MSD/60340',
  'NSE/CMTR/60338',
  'NSE/FAOP/60337',
  'NSE/MSD/60677',
  'NSE/CMTR/61518',
  'NSE/FAOP/61517',
  'NSE/MSD/61893',
  'NSE/CMTR/64628',
  'NSE/FAOP/64630',
  'NSE/CMTR/64960',
  'NSE/FAOP/64959',
];

export type RawSourceManifestErrorCode =
  | 'INVALID_MANIFEST_SHAPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_REFERENCE'
  | 'DUPLICATE_REFERENCE'
  | 'INVALID_URL_REVIEW_STATUS'
  | 'PENDING_ENTRY_WITH_URL'
  | 'REVIEWED_ENTRY_WITHOUT_URL'
  | 'INVALID_SOURCE_URL'
  | 'INVALID_CIRCULAR_REFERENCE'
  | 'INVALID_PUBLICATION_DATE'
  | 'INVALID_SUBJECT'
  | 'INVALID_APPLICABILITY'
  | 'INVALID_SOURCE_ROLE'
  | 'INVALID_LIFECYCLE_STATUS';

export class RawSourceManifestValidationError extends Error {
  constructor(public readonly code: RawSourceManifestErrorCode, message: string) {
    super(message);
    this.name = 'RawSourceManifestValidationError';
  }
}

const REFERENCE_PATTERN = /^NSE\/[A-Z]+\/\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidRawSourceReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function fail(code: RawSourceManifestErrorCode, message: string): never {
  throw new RawSourceManifestValidationError(code, message);
}

function validateApplicability(reference: string, applicability: unknown): RawSourceApplicability[] {
  if (!Array.isArray(applicability) || applicability.length === 0) {
    fail('INVALID_APPLICABILITY', `Entry '${reference}': applicableSegments must be a non-empty array.`);
  }
  return (applicability as unknown[]).map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      fail('INVALID_APPLICABILITY', `Entry '${reference}': applicableSegments[${index}] must be an object.`);
    }
    const { domain, basis } = entry as { domain?: unknown; basis?: unknown };
    if (!Object.values(RawSourceApplicabilityDomain).includes(domain as RawSourceApplicabilityDomain)) {
      fail('INVALID_APPLICABILITY', `Entry '${reference}': applicableSegments[${index}].domain '${String(domain)}' is not a recognized RawSourceApplicabilityDomain.`);
    }
    if (!Object.values(RawSourceApplicabilityBasis).includes(basis as RawSourceApplicabilityBasis)) {
      fail('INVALID_APPLICABILITY', `Entry '${reference}': applicableSegments[${index}].basis '${String(basis)}' is not a recognized RawSourceApplicabilityBasis.`);
    }
    return { domain: domain as RawSourceApplicabilityDomain, basis: basis as RawSourceApplicabilityBasis };
  });
}

function validateStringArray(reference: string, label: string, value: unknown): string[] {
  if (!Array.isArray(value)) fail('INVALID_MANIFEST_SHAPE', `Entry '${reference}': ${label} must be an array.`);
  return (value as unknown[]).map((item, index) => {
    if (!isValidRawSourceReference(item)) {
      fail('INVALID_REFERENCE', `Entry '${reference}': ${label}[${index}] '${String(item)}' is not a valid reference.`);
    }
    return item as string;
  });
}

/**
 * Structural + field-level validation of one reviewed manifest entry. Does
 * NOT validate cross-entry lifecycle-graph invariants (dangling refs,
 * inverse consistency, cycles) -- see `validateRawSourceLifecycleGraph` for
 * that pass, which this function's caller (`validateReviewedRawSourceManifest`)
 * always runs afterward over the full entry set.
 */
function validateEntry(raw: unknown): ReviewedRawSourceManifestEntry {
  if (typeof raw !== 'object' || raw === null) fail('INVALID_MANIFEST_SHAPE', 'Manifest entry must be an object.');
  const entry = raw as Record<string, unknown>;

  if (!isValidRawSourceReference(entry.reference)) {
    fail('INVALID_REFERENCE', `'${String(entry.reference)}' is not a valid reference (expected 'NSE/<DEPT>/<digits>').`);
  }
  const reference = entry.reference as string;

  if (!Object.values(RawSourceUrlReviewStatus).includes(entry.urlReviewStatus as RawSourceUrlReviewStatus)) {
    fail('INVALID_URL_REVIEW_STATUS', `Entry '${reference}': '${String(entry.urlReviewStatus)}' is not a recognized RawSourceUrlReviewStatus.`);
  }
  const urlReviewStatus = entry.urlReviewStatus as RawSourceUrlReviewStatus;

  if (urlReviewStatus === RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT && entry.sourceUrl !== null) {
    fail('PENDING_ENTRY_WITH_URL', `Entry '${reference}': urlReviewStatus is PENDING_OFFICIAL_URL_ASSIGNMENT but sourceUrl is not null.`);
  }
  if (urlReviewStatus === RawSourceUrlReviewStatus.REVIEWED) {
    if (typeof entry.sourceUrl !== 'string' || entry.sourceUrl.trim().length === 0) {
      fail('REVIEWED_ENTRY_WITHOUT_URL', `Entry '${reference}': urlReviewStatus is REVIEWED but sourceUrl is missing.`);
    }
  }

  if (entry.primaryDepartment !== null && typeof entry.primaryDepartment !== 'string') {
    fail('INVALID_MANIFEST_SHAPE', `Entry '${reference}': primaryDepartment must be a string or null.`);
  }
  if (typeof entry.circularReference !== 'string' || entry.circularReference.trim().length === 0) {
    fail('INVALID_CIRCULAR_REFERENCE', `Entry '${reference}': circularReference must be a non-empty string.`);
  }
  if (typeof entry.publicationDate !== 'string' || !DATE_PATTERN.test(entry.publicationDate)) {
    fail('INVALID_PUBLICATION_DATE', `Entry '${reference}': publicationDate '${String(entry.publicationDate)}' must be YYYY-MM-DD.`);
  }
  if (typeof entry.subject !== 'string' || entry.subject.trim().length === 0) {
    fail('INVALID_SUBJECT', `Entry '${reference}': subject must be a non-empty string.`);
  }
  if (!Object.values(RawSourceRole).includes(entry.sourceRole as RawSourceRole)) {
    fail('INVALID_SOURCE_ROLE', `Entry '${reference}': '${String(entry.sourceRole)}' is not a recognized RawSourceRole.`);
  }
  if (!Object.values(RawSourceLifecycleStatus).includes(entry.lifecycleStatus as RawSourceLifecycleStatus)) {
    fail('INVALID_LIFECYCLE_STATUS', `Entry '${reference}': '${String(entry.lifecycleStatus)}' is not a recognized RawSourceLifecycleStatus.`);
  }

  const applicableSegments = validateApplicability(reference, entry.applicableSegments);
  const withdraws = validateStringArray(reference, 'withdraws', entry.withdraws ?? []);
  const supersedes = validateStringArray(reference, 'supersedes', entry.supersedes ?? []);

  if (entry.withdrawnBy !== null && !isValidRawSourceReference(entry.withdrawnBy)) {
    fail('INVALID_REFERENCE', `Entry '${reference}': withdrawnBy '${String(entry.withdrawnBy)}' must be null or a valid reference.`);
  }
  if (entry.supersededBy !== null && !isValidRawSourceReference(entry.supersededBy)) {
    fail('INVALID_REFERENCE', `Entry '${reference}': supersededBy '${String(entry.supersededBy)}' must be null or a valid reference.`);
  }
  if (entry.notes !== null && typeof entry.notes !== 'string') {
    fail('INVALID_MANIFEST_SHAPE', `Entry '${reference}': notes must be a string or null.`);
  }

  if (entry.sourceUrl !== null && typeof entry.sourceUrl !== 'string') {
    fail('INVALID_SOURCE_URL', `Entry '${reference}': sourceUrl must be a string or null.`);
  }

  return {
    reference,
    urlReviewStatus,
    sourceUrl: (entry.sourceUrl as string | null) ?? null,
    primaryDepartment: (entry.primaryDepartment as string | null) ?? null,
    circularReference: entry.circularReference,
    publicationDate: entry.publicationDate,
    subject: entry.subject,
    applicableSegments,
    sourceRole: entry.sourceRole as RawSourceRole,
    lifecycleStatus: entry.lifecycleStatus as RawSourceLifecycleStatus,
    withdraws,
    withdrawnBy: (entry.withdrawnBy as string | null) ?? null,
    supersedes,
    supersededBy: (entry.supersededBy as string | null) ?? null,
    notes: (entry.notes as string | null) ?? null,
  };
}

/**
 * Structural + field-level validation of a reviewed manifest. Callers that
 * also need cross-entry lifecycle-graph invariants (task section 8) MUST
 * additionally call `validateRawSourceLifecycleGraph` (this function does
 * not, to keep single-entry field validation independently testable/
 * reusable). Never touches the filesystem/network -- pure, synchronous.
 */
export function validateReviewedRawSourceManifest(raw: unknown): ReviewedRawSourceManifest {
  if (typeof raw !== 'object' || raw === null) fail('INVALID_MANIFEST_SHAPE', 'Manifest must be an object.');
  const manifest = raw as Record<string, unknown>;

  if (manifest.manifestSchemaVersion !== RAW_SOURCE_MANIFEST_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `Unsupported manifestSchemaVersion '${String(manifest.manifestSchemaVersion)}'; expected ${RAW_SOURCE_MANIFEST_SCHEMA_VERSION}.`);
  }
  if (typeof manifest.pilotId !== 'string' || manifest.pilotId.trim().length === 0) {
    fail('INVALID_MANIFEST_SHAPE', 'pilotId must be a non-empty string.');
  }
  if (!Number.isInteger(manifest.calendarYear)) {
    fail('INVALID_MANIFEST_SHAPE', 'calendarYear must be an integer.');
  }
  if (!Array.isArray(manifest.entries)) {
    fail('INVALID_MANIFEST_SHAPE', 'entries must be an array.');
  }

  const entries = (manifest.entries as unknown[]).map((entry) => validateEntry(entry));

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.reference)) {
      fail('DUPLICATE_REFERENCE', `Duplicate reference '${entry.reference}' in manifest.`);
    }
    seen.add(entry.reference);
  }

  return {
    manifestSchemaVersion: RAW_SOURCE_MANIFEST_SCHEMA_VERSION,
    pilotId: manifest.pilotId,
    calendarYear: manifest.calendarYear as number,
    entries,
  };
}

/**
 * B-F7A-SOURCE-EVIDENCE-1 (task section 11): the GENERIC form of "this
 * manifest contains exactly this expected reference set, no more, no
 * fewer" -- extracted so a future reviewed manifest/pilot year can prove
 * its own exact expected reference set without inheriting (or duplicating)
 * the 2024-specific list. `assertExact2024PilotReferenceSet` below is now a
 * thin wrapper over this for the original 2024 pilot; its behavior/error
 * code are unchanged.
 */
export function assertExactReferenceSet(manifest: ReviewedRawSourceManifest, expectedReferences: readonly string[], label: string): void {
  const actual = new Set(manifest.entries.map((entry) => entry.reference));
  const expected = new Set(expectedReferences);

  const missing = [...expected].filter((reference) => !actual.has(reference));
  const unexpected = [...actual].filter((reference) => !expected.has(reference));

  if (missing.length > 0 || unexpected.length > 0) {
    fail('INVALID_MANIFEST_SHAPE', `${label} reference set mismatch. Missing: [${missing.join(', ')}]. Unexpected: [${unexpected.join(', ')}].`);
  }
  if (manifest.entries.length !== expectedReferences.length) {
    fail('INVALID_MANIFEST_SHAPE', `${label}: expected exactly ${expectedReferences.length} entries, got ${manifest.entries.length}.`);
  }
}

/**
 * Fails closed unless `manifest.entries` contains exactly
 * `EXPECTED_2024_PILOT_REFERENCES` -- no more, no fewer (task section 4/17
 * tests 2-4: "exactly 16 source entries exist" / "all expected source refs
 * present"). Kept separate from `validateReviewedRawSourceManifest` so a
 * future pilot year's manifest can reuse the generic schema validator
 * without inheriting the 2024-specific reference list.
 */
export function assertExact2024PilotReferenceSet(manifest: ReviewedRawSourceManifest): void {
  assertExactReferenceSet(manifest, EXPECTED_2024_PILOT_REFERENCES, '2024 pilot manifest');
}
