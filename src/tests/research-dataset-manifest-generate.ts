import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import DatasetManifestService from '../modules/research-lake/services/dataset-manifest.service';
import ManifestCalendarSessionResolverService, { ManifestRequestedSessions } from '../modules/research-lake/services/manifest-calendar-session-resolver.service';
import { DatasetManifest, ManifestDatasetKind } from '../modules/research-lake/domain/dataset-manifest.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-acquisition.service';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { parseGrowwSymbol } from '../modules/research-lake/providers/groww/groww-contract-symbol-parser';

dotenv.config();
logger.silent = true;

const ARTIFACT_ROOT = 'artifacts/research-lake/manifests';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Deliberate safety cap: B-F5 manifest generation is scoped to an explicit, bounded date range -- never an implicit full-history run (task section 13/18). */
const MAX_DATE_SPAN_DAYS = 92;

/**
 * Research-only B-F5 GENERATE entrypoint. Never wired into `server.ts` or
 * any live startup path. Never calls a provider live -- reconstructs a
 * deterministic dataset manifest entirely from already-persisted candle
 * rows (task section 9/15).
 *
 * Usage (PowerShell), underlying:
 *   $env:RESEARCH_MANIFEST_DATASET_KIND = 'UNDERLYING_1M'
 *   $env:RESEARCH_MANIFEST_START_DATE = '2022-01-03'
 *   $env:RESEARCH_MANIFEST_END_DATE = '2022-01-07'
 *   npm run research:manifest:generate
 *
 * Usage (PowerShell), expired option:
 *   $env:RESEARCH_MANIFEST_DATASET_KIND = 'EXPIRED_OPTION_1M'
 *   $env:RESEARCH_MANIFEST_OPTION_GROWW_SYMBOL = 'NSE-NIFTY-06Jan22-17200-PE'
 *   $env:RESEARCH_MANIFEST_START_DATE = '2022-01-03'
 *   $env:RESEARCH_MANIFEST_END_DATE = '2022-01-06'
 *   npm run research:manifest:generate
 */
async function run(): Promise<void> {
  const datasetKindRaw = process.env.RESEARCH_MANIFEST_DATASET_KIND?.trim();
  const startDate = process.env.RESEARCH_MANIFEST_START_DATE?.trim();
  const endDate = process.env.RESEARCH_MANIFEST_END_DATE?.trim();

  if (datasetKindRaw !== ManifestDatasetKind.UNDERLYING_1M && datasetKindRaw !== ManifestDatasetKind.EXPIRED_OPTION_1M) {
    throw new Error(`RESEARCH_MANIFEST_DATASET_KIND is required and must be '${ManifestDatasetKind.UNDERLYING_1M}' or '${ManifestDatasetKind.EXPIRED_OPTION_1M}'. This script never defaults the dataset kind.`);
  }
  if (!startDate || !DATE_PATTERN.test(startDate)) {
    throw new Error('RESEARCH_MANIFEST_START_DATE is required and must be YYYY-MM-DD. This script never defaults the start date.');
  }
  if (!endDate || !DATE_PATTERN.test(endDate)) {
    throw new Error('RESEARCH_MANIFEST_END_DATE is required and must be YYYY-MM-DD. This script never defaults the end date.');
  }
  if (startDate > endDate) {
    throw new Error(`RESEARCH_MANIFEST_START_DATE (${startDate}) must not be after RESEARCH_MANIFEST_END_DATE (${endDate}).`);
  }

  const spanDays = Math.round((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_DATE_SPAN_DAYS && process.env.RESEARCH_MANIFEST_ALLOW_LARGE_RANGE?.trim().toLowerCase() !== 'true') {
    throw new Error(
      `Requested range ${startDate}..${endDate} spans ${spanDays} day(s), exceeding this CLI's ${MAX_DATE_SPAN_DAYS}-day safety cap. B-F5 is scoped to explicit, bounded manifest generation, never an implicit full-history run (task section 13/18). Set RESEARCH_MANIFEST_ALLOW_LARGE_RANGE=true only for a deliberate, explicitly-authorized larger run.`
    );
  }

  // B-F5 CALENDAR FIX (root-cause correction): requested sessions come from
  // the certified NSE/EQUITY exchange calendar via `ManifestCalendarSessionResolverService`
  // -- never Monday-Friday arithmetic. A certified holiday/exceptional
  // closure/ordinary weekend is simply excluded from `tradingDates`; a
  // certified weekend SPECIAL_SESSION is included with its real windows; any
  // calendar-UNCERTIFIED date in the range fails this run closed before any
  // manifest artifact is written. Reused for BOTH dataset kinds (task
  // invariant B) -- see that service's doc for why EXPIRED_OPTION_1M reuses
  // the same EQUITY-segment calendar truth.
  const calendarResolver = new ManifestCalendarSessionResolverService();
  const { tradingDates, calendarSessionWindows }: ManifestRequestedSessions = await calendarResolver.resolveRequestedSessions({ fromDate: startDate, toDate: endDate });

  const service = new DatasetManifestService();
  const gitRevision = resolveGitRevisionBestEffort();

  console.log(JSON.stringify({ event: 'research:manifest:generate starting', datasetKind: datasetKindRaw, startDate, endDate, requestedSessionCount: tradingDates.length }));

  const manifest =
    datasetKindRaw === ManifestDatasetKind.UNDERLYING_1M
      ? await service.generateUnderlyingManifest({
          provider: (process.env.RESEARCH_MANIFEST_PROVIDER?.trim() as HistoricalProviderId | undefined) ?? HistoricalProviderId.UPSTOX,
          instrumentKey: process.env.RESEARCH_MANIFEST_INSTRUMENT_KEY?.trim() || NIFTY_INDEX_INSTRUMENT_KEY,
          timeframe: process.env.RESEARCH_MANIFEST_TIMEFRAME?.trim() || NIFTY_UNDERLYING_TIMEFRAME,
          tradingDates,
          calendarSessionWindows,
          gitRevision,
        })
      : await generateOptionManifest(service, tradingDates, calendarSessionWindows, gitRevision);

  const artifactPath = `${ARTIFACT_ROOT}/${manifest.datasetKind}/${manifest.datasetId}.json`;
  await mkdir(`${ARTIFACT_ROOT}/${manifest.datasetKind}`, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        datasetId: manifest.datasetId,
        datasetChecksum: manifest.datasetChecksum,
        manifestSchemaVersion: manifest.manifestSchemaVersion,
        canonicalizationVersion: manifest.canonicalizationVersion,
        healthSemanticsVersion: manifest.healthSemanticsVersion,
        sessionsRequested: manifest.sessionCounts.requested,
        sessionsIncluded: manifest.sessionCounts.included,
        sessionsHealthy: manifest.sessionCounts.healthy,
        sessionsIncomplete: manifest.sessionCounts.incomplete,
        sessionsInvalid: manifest.sessionCounts.invalid,
        sessions: manifest.sessions.map((session) => ({
          tradingDate: session.identity.tradingDate,
          rowCount: session.canonicalRowCount,
          // Persisted canonical content health only -- NOT source acquisition health (see dataset-manifest.types.ts SessionManifest doc).
          persistedCanonicalHealthStatus: session.persistedCanonicalHealthStatus,
          sourceAcquisitionEvidenceAvailability: session.sourceAcquisitionEvidence.availability,
          contentChecksum: session.contentChecksum,
        })),
        artifact: artifactPath,
      },
      null,
      2
    )
  );
}

async function generateOptionManifest(
  service: DatasetManifestService,
  tradingDates: readonly string[],
  calendarSessionWindows: ManifestRequestedSessions['calendarSessionWindows'],
  gitRevision: string | null
): Promise<DatasetManifest> {
  const growwSymbol = process.env.RESEARCH_MANIFEST_OPTION_GROWW_SYMBOL?.trim();
  if (!growwSymbol) {
    throw new Error('RESEARCH_MANIFEST_OPTION_GROWW_SYMBOL is required for EXPIRED_OPTION_1M (e.g. NSE-NIFTY-06Jan22-17200-PE). This script never defaults to an implicit contract.');
  }
  const parsed = parseGrowwSymbol(growwSymbol, { exchange: 'NSE', underlyingSymbol: 'NIFTY' });
  if (!parsed.ok || parsed.value.kind !== 'OPTION') {
    throw new Error(`RESEARCH_MANIFEST_OPTION_GROWW_SYMBOL '${growwSymbol}' could not be parsed as an NSE NIFTY option symbol: ${!parsed.ok ? parsed.failure.detail : 'not an option symbol'}.`);
  }

  return service.generateOptionManifest({
    provider: (process.env.RESEARCH_MANIFEST_PROVIDER?.trim() as HistoricalProviderId | undefined) ?? HistoricalProviderId.GROWW,
    providerContractId: growwSymbol,
    optionType: parsed.value.optionType,
    strikePrice: parsed.value.strikePrice,
    expiry: parsed.value.expiry,
    timeframe: process.env.RESEARCH_MANIFEST_TIMEFRAME?.trim() || '1minute',
    tradingDates,
    calendarSessionWindows,
    gitRevision,
  });
}

function resolveGitRevisionBestEffort(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // optional provenance only -- never fatal, never the sole dataset identity (task section 6)
  }
}

run().catch((error) => {
  console.error('B-F5 dataset manifest generation failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
