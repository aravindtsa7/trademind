import { assertExecutable2024PilotManifestComplete } from '../domain/raw-source-executable-pilot-manifest';
import { Proposed2024DraftCalendarMappingOutline, buildProposed2024DraftCalendarMappingOutline } from '../domain/proposed-2024-draft-calendar-mapping';
import { ReviewedRawSourceManifest, validateReviewedRawSourceManifest } from '../domain/raw-source-archive.types';
import RawSourceArchiverService, { RawSourceArchiveRunResult, RawSourceDownloader, evaluatePilotArchiveOutcome } from './nse-raw-source-archiver.service';

/**
 * B-F7A-ARCHIVE-1-FIX-1 Defect B correction (task section 8/25/31.B). Pure
 * orchestration with NO `console`/`process.exit` of its own, so it can be
 * unit-tested directly (task section 30: "a deterministic CLI behavior test
 * or equivalent synthetic harness proving: partial/zero archive cannot exit
 * success"). The actual CLI entrypoint (`src/tests/research-nse-2024-raw-source-archive.ts`)
 * is a thin wrapper around this function: it only prints output and sets
 * `process.exitCode` from the returned `success` flag.
 *
 * Enforces, end-to-end, exactly the FIX-1 acceptance rule: the proposed
 * DRAFT mapping is built and returned ONLY when every one of the 16 pilot
 * entries ended `ARCHIVED_NEW` or `VERIFIED_IDEMPOTENT_EXISTING` -- never for
 * a partial/zero-success run (task section 25: "Only emit/write it after a
 * fully successful 16-source archive run.").
 */
export interface Nse2024PilotArchiveRunOutcome {
  readonly success: boolean;
  readonly runResult: RawSourceArchiveRunResult;
  readonly incompleteReferences: readonly string[];
  /** Non-null ONLY when `success` is `true`. */
  readonly proposedMapping: Proposed2024DraftCalendarMappingOutline | null;
}

export async function runNse2024PilotArchive(deps: { readonly manifest: unknown; readonly downloader: RawSourceDownloader; readonly archiveRoot: string }): Promise<Nse2024PilotArchiveRunOutcome> {
  const manifest: ReviewedRawSourceManifest = validateReviewedRawSourceManifest(deps.manifest);
  assertExecutable2024PilotManifestComplete(manifest);

  const archiver = new RawSourceArchiverService(deps.downloader, deps.archiveRoot);
  const runResult = await archiver.archiveManifest(manifest);
  const outcome = evaluatePilotArchiveOutcome(runResult);

  return {
    success: outcome.success,
    runResult,
    incompleteReferences: outcome.incompleteReferences,
    proposedMapping: outcome.success ? buildProposed2024DraftCalendarMappingOutline(manifest) : null,
  };
}
