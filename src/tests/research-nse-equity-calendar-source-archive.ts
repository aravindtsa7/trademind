import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import manifest2022 from '../modules/research-lake/domain/data/nse-2022-equity-source-manifest.json';
import manifest2023 from '../modules/research-lake/domain/data/nse-2023-equity-source-manifest.json';
import manifest2024 from '../modules/research-lake/domain/data/nse-2024-equity-source-manifest.json';
import manifest2025 from '../modules/research-lake/domain/data/nse-2025-equity-source-manifest.json';
import manifest2026 from '../modules/research-lake/domain/data/nse-2026-v1-equity-source-manifest.json';
import { DEFAULT_RAW_SOURCE_ARCHIVE_ROOT } from '../modules/research-lake/domain';
import NseRawSourceHttpDownloaderService from '../modules/research-lake/services/nse-raw-source-downloader.service';
import { runReviewedRawSourceArchive } from '../modules/research-lake/services/reviewed-raw-source-archive-runner';

dotenv.config();
logger.silent = true;

/**
 * B-F7A-SOURCE-EVIDENCE-1 developer command: archives the reviewed
 * 2022/2023/2024(EQUITY-subset)/2025/2026(V1) raw source sets -- the exact
 * 22 NSE/EQUITY references required to close the B-F7A-FIXTURES-1 blocker
 * (task section 3). Explicit, opt-in (never run by `npm test`/CI, never
 * wired into `server.ts`). Performs ONLY: manifest validation, live HTTPS
 * GETs to the official NSE host allowlist, and local filesystem writes
 * under the archive root -- it never touches Prisma/MySQL and never
 * imports/certifies a calendar version. Reuses the SAME
 * `ReviewedRawSourceArchiveRunOutcome` orchestration
 * (`reviewed-raw-source-archive-runner.ts`) the 2024 pilot CLI uses, just
 * parameterized per year instead of hardcoded to the 2024 16-doc set -- no
 * second downloader, no second checksum system (task section 5/11).
 *
 * All five years share ONE archive root / ONE receipt index, exactly like
 * the existing 2024 pilot (task section 8: "Do not invent a second archive
 * tree").
 *
 * Usage (PowerShell):
 *   npm run research:archive:equity-calendar-sources
 *
 * Optional:
 *   $env:RESEARCH_RAW_ARCHIVE_ROOT = 'artifacts/nse-raw-source-archive'   (default)
 */
const YEAR_MANIFESTS: ReadonlyArray<{ readonly calendarYear: number; readonly label: string; readonly manifest: unknown; readonly expectedReferences: readonly string[] }> = [
  { calendarYear: 2022, label: '2022 EQUITY manifest', manifest: manifest2022, expectedReferences: manifest2022.entries.map((entry) => entry.reference) },
  { calendarYear: 2023, label: '2023 EQUITY manifest', manifest: manifest2023, expectedReferences: manifest2023.entries.map((entry) => entry.reference) },
  { calendarYear: 2024, label: '2024 EQUITY manifest', manifest: manifest2024, expectedReferences: manifest2024.entries.map((entry) => entry.reference) },
  { calendarYear: 2025, label: '2025 EQUITY manifest', manifest: manifest2025, expectedReferences: manifest2025.entries.map((entry) => entry.reference) },
  { calendarYear: 2026, label: '2026 V1 EQUITY manifest', manifest: manifest2026, expectedReferences: manifest2026.entries.map((entry) => entry.reference) },
];

async function run(): Promise<void> {
  const archiveRoot = process.env.RESEARCH_RAW_ARCHIVE_ROOT?.trim() || DEFAULT_RAW_SOURCE_ARCHIVE_ROOT;
  const downloader = new NseRawSourceHttpDownloaderService();

  console.log(JSON.stringify({ event: 'research:archive:equity-calendar-sources starting', archiveRoot, years: YEAR_MANIFESTS.map((y) => y.calendarYear) }));

  let overallSuccess = true;
  const perYearSummaries: unknown[] = [];

  for (const year of YEAR_MANIFESTS) {
    // eslint-disable-next-line no-await-in-loop -- archiving is sequential by design: all five years share one interprocess lock/receipt index, and sequential attribution keeps a mid-run failure easy to pin to its year.
    const outcome = await runReviewedRawSourceArchive({ manifest: year.manifest, expectedReferences: year.expectedReferences, label: year.label, downloader, archiveRoot });
    overallSuccess = overallSuccess && outcome.success;
    perYearSummaries.push({
      calendarYear: year.calendarYear,
      success: outcome.success,
      archivedCount: outcome.runResult.archivedCount,
      skippedCount: outcome.runResult.skippedCount,
      failedCount: outcome.runResult.failedCount,
      incompleteReferences: outcome.incompleteReferences,
      entries: outcome.runResult.entries.map((entry) => ({
        reference: entry.reference,
        status: entry.status,
        rawSha256: entry.receipt?.rawSha256 ?? null,
        byteLength: entry.receipt?.byteLength ?? null,
        archiveRelativePath: entry.receipt?.archiveRelativePath ?? null,
        conflict: entry.conflict,
        detail: entry.detail,
      })),
    });
  }

  console.log(JSON.stringify({ event: 'research:archive:equity-calendar-sources result', archiveRoot, overallSuccess, years: perYearSummaries }, null, 2));

  if (!overallSuccess) {
    console.error('research:archive:equity-calendar-sources INCOMPLETE -- at least one required reference across 2022-2026 was not archived. See per-year incompleteReferences above.');
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('B-F7A-SOURCE-EVIDENCE-1 equity calendar source archive run failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
