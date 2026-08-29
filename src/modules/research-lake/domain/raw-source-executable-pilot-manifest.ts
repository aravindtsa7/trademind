import { ReviewedRawSourceManifest, RawSourceUrlReviewStatus, assertExact2024PilotReferenceSet } from './raw-source-archive.types';
import { validateRawSourceLifecycleGraph } from './raw-source-lifecycle-graph';
import { assertUrlBindsToReference, RawSourceUrlBindingError } from './raw-source-manifest-url-binding';

/**
 * B-F7A-ARCHIVE-1-FIX-1 (task section 7/31.A/E). The GENERIC schema
 * validator (`validateReviewedRawSourceManifest` in `raw-source-archive.types.ts`)
 * intentionally still accepts an entry with `urlReviewStatus:
 * PENDING_OFFICIAL_URL_ASSIGNMENT` -- that stays valid for a future,
 * legitimately-incomplete DRAFT manifest under active review. This module
 * is the SEPARATE, STRICTER gate the production 2024 pilot CLI must pass
 * before it is allowed to attempt any live archiving: a "REVIEWED EXECUTABLE
 * PILOT MANIFEST" cannot contain a single `PENDING_OFFICIAL_URL_ASSIGNMENT`
 * entry, a URL/reference mismatch, or a missing `primaryDepartment`.
 */
export type ExecutablePilotManifestErrorCode = 'ENTRY_NOT_REVIEWED' | 'URL_REFERENCE_MISMATCH' | 'MISSING_PRIMARY_DEPARTMENT';

export class ExecutablePilotManifestValidationError extends Error {
  constructor(public readonly code: ExecutablePilotManifestErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ExecutablePilotManifestValidationError';
  }
}

/**
 * Fails closed unless `manifest` is a complete, executable 2024 pilot
 * manifest: exactly the 16 accepted references (task section 3/7), every
 * entry `REVIEWED` with a non-null `sourceUrl` that is provably bound to its
 * own `reference` (task section 20), every entry carrying a non-null
 * `primaryDepartment`, and a lifecycle graph that validates. Callers
 * (the archive CLI) MUST call this before attempting to archive anything --
 * `validateReviewedRawSourceManifest`'s generic schema pass alone is not
 * sufficient authorization to run a live archive (task section 7).
 */
export function assertExecutable2024PilotManifestComplete(manifest: ReviewedRawSourceManifest): void {
  assertExact2024PilotReferenceSet(manifest);
  validateRawSourceLifecycleGraph(manifest.entries);

  for (const entry of manifest.entries) {
    if (entry.urlReviewStatus !== RawSourceUrlReviewStatus.REVIEWED || entry.sourceUrl === null) {
      throw new ExecutablePilotManifestValidationError(
        'ENTRY_NOT_REVIEWED',
        `Entry '${entry.reference}' has urlReviewStatus '${entry.urlReviewStatus}' -- the executable 2024 pilot manifest requires every entry to be REVIEWED with a non-null sourceUrl.`
      );
    }
    try {
      assertUrlBindsToReference(entry.reference, entry.sourceUrl);
    } catch (error) {
      if (error instanceof RawSourceUrlBindingError) {
        throw new ExecutablePilotManifestValidationError('URL_REFERENCE_MISMATCH', `Entry '${entry.reference}': ${error.message}`, error);
      }
      throw error;
    }
    if (entry.primaryDepartment === null || entry.primaryDepartment.trim().length === 0) {
      throw new ExecutablePilotManifestValidationError('MISSING_PRIMARY_DEPARTMENT', `Entry '${entry.reference}' has no primaryDepartment -- the executable 2024 pilot manifest requires one for every entry.`);
    }
  }
}
