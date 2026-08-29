import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import logger from '../core/logger/logger';
import manifestJson from '../modules/research-lake/domain/data/nse-2024-source-manifest.json';
import { DEFAULT_RAW_SOURCE_ARCHIVE_ROOT } from '../modules/research-lake/domain';
import NseRawSourceHttpDownloaderService from '../modules/research-lake/services/nse-raw-source-downloader.service';
import { runNse2024PilotArchive } from '../modules/research-lake/services/nse-2024-pilot-archive-runner';

dotenv.config();
logger.silent = true;

/**
 * B-F7A-ARCHIVE-1 developer command: archives the reviewed 2024 pilot raw
 * source set (task section 3/23.N; fail-closed CLI contract corrected under
 * FIX-1 Defect B, task section 8/25). Explicit, opt-in (never run by `npm
 * test`/CI, never wired into `server.ts`). Performs ONLY: manifest
 * validation, live HTTPS GETs to the official NSE host allowlist, and local
 * filesystem writes under the archive root -- it never touches Prisma/MySQL,
 * never calls `ExchangeCalendarImporterService`/`ExchangeCalendarCertificationService`,
 * and never certifies or activates a calendar version.
 *
 * This is a thin wrapper: all real orchestration/decision logic lives in
 * `runNse2024PilotArchive` (`nse-2024-pilot-archive-runner.ts`), which is
 * directly unit-tested (no `console`/`process.exit` of its own) so the
 * fail-closed exit-code contract below is proven deterministically without
 * spawning this script as a subprocess.
 *
 * SUCCESS means every one of the 16 pilot entries ended `ARCHIVED_NEW` or
 * `VERIFIED_IDEMPOTENT_EXISTING` -- ANY entry left `SKIPPED_URL_NOT_REVIEWED`,
 * `FAILED_CONTENT_CHANGED`, or `FAILED_ERROR` makes this script exit
 * non-zero, and the proposed DRAFT mapping (task section 23.O) is written
 * ONLY on that full success (task section 25).
 *
 * Usage (PowerShell):
 *   npm run research:archive:2024-pilot
 *
 * Optional:
 *   $env:RESEARCH_RAW_ARCHIVE_ROOT = 'artifacts/nse-raw-source-archive'   (default)
 */
async function run(): Promise<void> {
  const archiveRoot = process.env.RESEARCH_RAW_ARCHIVE_ROOT?.trim() || DEFAULT_RAW_SOURCE_ARCHIVE_ROOT;

  console.log(JSON.stringify({ event: 'research:archive:2024-pilot starting', archiveRoot }));

  const outcome = await runNse2024PilotArchive({ manifest: manifestJson, downloader: new NseRawSourceHttpDownloaderService(), archiveRoot });

  console.log(
    JSON.stringify(
      {
        success: outcome.success,
        archiveRoot: outcome.runResult.archiveRoot,
        archivedCount: outcome.runResult.archivedCount,
        skippedCount: outcome.runResult.skippedCount,
        failedCount: outcome.runResult.failedCount,
        incompleteReferences: outcome.incompleteReferences,
        entries: outcome.runResult.entries.map((entry) => ({
          reference: entry.reference,
          status: entry.status,
          rawSha256: entry.receipt?.rawSha256 ?? null,
          archiveRelativePath: entry.receipt?.archiveRelativePath ?? null,
          conflict: entry.conflict,
          detail: entry.detail,
        })),
      },
      null,
      2
    )
  );

  if (!outcome.success) {
    console.error(`research:archive:2024-pilot INCOMPLETE -- ${outcome.incompleteReferences.length} reference(s) not archived: [${outcome.incompleteReferences.join(', ')}]. No proposed mapping was written.`);
    process.exitCode = 1;
    return;
  }

  // Proposed DRAFT archive-to-calendar mapping (task section 23.O) -- written
  // ONLY because the run above was fully successful (task section 25);
  // never imported/certified by this script.
  const proposedMappingPath = join(archiveRoot, 'proposed-2024-draft-calendar-mapping.json');
  mkdirSync(dirname(proposedMappingPath), { recursive: true });
  writeFileSync(proposedMappingPath, `${JSON.stringify(outcome.proposedMapping, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ event: 'research:archive:2024-pilot proposed draft mapping written', path: proposedMappingPath }));
}

run().catch((error) => {
  console.error('B-F7A-ARCHIVE-1 archive run failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
