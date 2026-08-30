import { assertExecutableManifestComplete } from '../domain/raw-source-executable-pilot-manifest';
import { ReviewedRawSourceManifest, validateReviewedRawSourceManifest } from '../domain/raw-source-archive.types';
import RawSourceArchiverService, { RawSourceArchiveRunResult, RawSourceDownloader, evaluatePilotArchiveOutcome } from './nse-raw-source-archiver.service';

/**
 * B-F7A-SOURCE-EVIDENCE-1 (task section 11): the GENERIC counterpart of
 * `nse-2024-pilot-archive-runner.ts` -- same fail-closed shape (validate the
 * manifest, assert it is a complete EXECUTABLE manifest for the caller's own
 * expected reference set, then archive under the interprocess lock, then
 * evaluate success), but parameterized by `expectedReferences`/`label`
 * instead of hardcoding the 2024 pilot's 16 references. This is what lets
 * the new 2022/2023/2025/2026 (and a fresh, EQUITY-only 2024) reviewed
 * manifests reuse the SAME archiver/storage/receipt/lock machinery without a
 * second downloader or a second checksum system (task section 5/11).
 *
 * Deliberately does NOT build a proposed draft calendar mapping the way the
 * 2024-pilot-specific runner does -- that step
 * (`buildProposed2024DraftCalendarMappingOutline`) is itself 2024-shaped and
 * out of scope here; this runner's only job is proving the requested source
 * documents are genuinely archived with real, verified checksums.
 */
export interface ReviewedRawSourceArchiveRunOutcome {
  readonly success: boolean;
  readonly runResult: RawSourceArchiveRunResult;
  readonly incompleteReferences: readonly string[];
}

export async function runReviewedRawSourceArchive(deps: {
  readonly manifest: unknown;
  readonly expectedReferences: readonly string[];
  readonly label: string;
  readonly downloader: RawSourceDownloader;
  readonly archiveRoot: string;
}): Promise<ReviewedRawSourceArchiveRunOutcome> {
  const manifest: ReviewedRawSourceManifest = validateReviewedRawSourceManifest(deps.manifest);
  assertExecutableManifestComplete(manifest, deps.expectedReferences, deps.label);

  const archiver = new RawSourceArchiverService(deps.downloader, deps.archiveRoot);
  const runResult = await archiver.archiveManifest(manifest);
  const outcome = evaluatePilotArchiveOutcome(runResult);

  return { success: outcome.success, runResult, incompleteReferences: outcome.incompleteReferences };
}
