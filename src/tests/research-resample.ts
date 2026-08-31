import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { ManifestDatasetKind } from '../modules/research-lake/domain/dataset-manifest.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { istTradingDayUtcBounds } from '../modules/research-lake/domain/ist-session-clock';
import { SessionWindow } from '../modules/research-lake/domain/exchange-calendar.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-acquisition.service';
import { parseGrowwSymbol } from '../modules/research-lake/providers/groww/groww-contract-symbol-parser';
import DatasetSessionManifestBuilderService from '../modules/research-lake/services/dataset-session-manifest-builder.service';
import HistoricalCandleResamplerService from '../modules/research-lake/services/historical-candle-resampler.service';
import ManifestCalendarSessionResolverService from '../modules/research-lake/services/manifest-calendar-session-resolver.service';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../modules/research-lake/repositories/historical-option-candle-lake.repository';

dotenv.config();
logger.silent = true;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TARGET_TIMEFRAMES = new Set(Object.values(ResampleTargetTimeframe));

/**
 * Research-only B-F7 read-only inspection CLI. Never wired into `server.ts`
 * or any live startup path, never calls a provider live -- reads already-
 * persisted canonical 1m rows for exactly ONE explicit session (task section
 * 25/27: no default/bulk run) and reports the deterministic resampling
 * result summary. Never prints the full candle payload.
 *
 * B-F7 CALENDAR FIX: resolves `tradingDate`'s certified calendar session
 * windows via `ManifestCalendarSessionResolverService` (the SAME
 * authoritative source B-F5 manifest generation and B-F8 year-runner
 * materialization already use) before reading rows, so a SPECIAL_SESSION
 * date's health/resampling here match exactly what the rest of the pipeline
 * would produce for it -- and a calendar-UNCERTIFIED/closed `tradingDate`
 * fails this run closed before any DB read.
 *
 * Usage (PowerShell), underlying:
 *   $env:RESEARCH_RESAMPLE_DATASET_KIND = 'UNDERLYING_1M'
 *   $env:RESEARCH_RESAMPLE_TRADING_DATE = '2022-01-03'
 *   $env:RESEARCH_RESAMPLE_TARGET_TIMEFRAME = '5m'
 *   npm run research:resample
 *
 * Usage (PowerShell), expired option:
 *   $env:RESEARCH_RESAMPLE_DATASET_KIND = 'EXPIRED_OPTION_1M'
 *   $env:RESEARCH_RESAMPLE_OPTION_GROWW_SYMBOL = 'NSE-NIFTY-06Jan22-17200-PE'
 *   $env:RESEARCH_RESAMPLE_TRADING_DATE = '2022-01-03'
 *   $env:RESEARCH_RESAMPLE_TARGET_TIMEFRAME = '2m'
 *   npm run research:resample
 */
async function run(): Promise<void> {
  const datasetKindRaw = process.env.RESEARCH_RESAMPLE_DATASET_KIND?.trim();
  const tradingDate = process.env.RESEARCH_RESAMPLE_TRADING_DATE?.trim();
  const targetTimeframeRaw = process.env.RESEARCH_RESAMPLE_TARGET_TIMEFRAME?.trim();

  if (datasetKindRaw !== ManifestDatasetKind.UNDERLYING_1M && datasetKindRaw !== ManifestDatasetKind.EXPIRED_OPTION_1M) {
    throw new Error(`RESEARCH_RESAMPLE_DATASET_KIND is required and must be '${ManifestDatasetKind.UNDERLYING_1M}' or '${ManifestDatasetKind.EXPIRED_OPTION_1M}'. This script never defaults the dataset kind.`);
  }
  if (!tradingDate || !DATE_PATTERN.test(tradingDate)) {
    throw new Error('RESEARCH_RESAMPLE_TRADING_DATE is required and must be YYYY-MM-DD -- exactly one explicit session, never a bounded/default range (task section 25/27).');
  }
  if (!targetTimeframeRaw || !TARGET_TIMEFRAMES.has(targetTimeframeRaw as ResampleTargetTimeframe)) {
    throw new Error(`RESEARCH_RESAMPLE_TARGET_TIMEFRAME is required and must be one of: ${[...TARGET_TIMEFRAMES].join(', ')}.`);
  }
  const targetTimeframe = targetTimeframeRaw as ResampleTargetTimeframe;

  const sessionBuilder = new DatasetSessionManifestBuilderService();
  const resampler = new HistoricalCandleResamplerService();
  const { start, end } = istTradingDayUtcBounds(tradingDate);

  // B-F7 CALENDAR FIX: resolves the SAME certified calendar session windows
  // B-F5 manifest generation/B-F8 year-runner materialization already use
  // (`ManifestCalendarSessionResolverService`) -- never Monday-Friday
  // arithmetic, never the fixed 09:15-15:29 regular default for a certified
  // SPECIAL_SESSION date. Fails this run closed before any DB read if
  // `tradingDate` is calendar-UNCERTIFIED or resolves closed.
  const calendarResolver = new ManifestCalendarSessionResolverService();
  const calendarSessionWindows = await calendarResolver.resolveSessionWindowsForDates([tradingDate]);
  const sessionWindows: readonly SessionWindow[] | undefined = calendarSessionWindows[tradingDate];

  const { sourceDatasetKind, identity, contentChecksum, sourceRows, canonicalRowCount } =
    datasetKindRaw === ManifestDatasetKind.UNDERLYING_1M
      ? await loadUnderlyingSession(sessionBuilder, tradingDate, start, end, sessionWindows)
      : await loadOptionSession(sessionBuilder, tradingDate, start, end, sessionWindows);

  console.log(JSON.stringify({ event: 'research:resample starting', datasetKind: datasetKindRaw, tradingDate, targetTimeframe, sourceRowCount: canonicalRowCount, sessionWindows }));

  const { candles, descriptor } = resampler.resampleSession({
    targetTimeframe,
    tradingDate,
    sourceDatasetKind,
    sourceSessionIdentity: identity,
    sourceSessionContentChecksum: contentChecksum,
    sessionWindows,
    sourceRows,
  });

  console.log(
    JSON.stringify(
      {
        sourceSessionIdentity: identity,
        sourceSessionContentChecksum: descriptor.sourceSessionContentChecksum,
        resamplingSchemaVersion: descriptor.resamplingSchemaVersion,
        resamplingSemanticsVersion: descriptor.resamplingSemanticsVersion,
        targetTimeframeMinutes: descriptor.targetTimeframeMinutes,
        sessionWindows: descriptor.sessionWindows,
        sourceRowCount: descriptor.sourceRowCount,
        derivedBucketCount: candles.length,
        completeBucketCount: descriptor.completeBucketCount,
        partialBucketCount: descriptor.partialBucketCount,
        excludedTrailingRowCount: descriptor.excludedTrailingRowCount,
        missingSourceMinuteCount: descriptor.missingSourceMinuteCount,
        status: descriptor.status,
        derivedContentChecksum: descriptor.derivedContentChecksum,
      },
      null,
      2
    )
  );
}

async function loadUnderlyingSession(sessionBuilder: DatasetSessionManifestBuilderService, tradingDate: string, start: Date, end: Date, sessionWindows: readonly SessionWindow[] | undefined) {
  const instrumentKey = process.env.RESEARCH_RESAMPLE_INSTRUMENT_KEY?.trim() || NIFTY_INDEX_INSTRUMENT_KEY;
  const timeframe = process.env.RESEARCH_RESAMPLE_TIMEFRAME?.trim() || NIFTY_UNDERLYING_TIMEFRAME;
  const provider = (process.env.RESEARCH_RESAMPLE_PROVIDER?.trim() as HistoricalProviderId | undefined) ?? HistoricalProviderId.UPSTOX;

  const repository = new HistoricalCandleRepository();
  const rows = await repository.findRange(instrumentKey, timeframe, start, end);
  const manifest = sessionBuilder.buildUnderlyingSession({ provider, instrumentKey, timeframe, tradingDate, rows, sessionWindows });

  return {
    sourceDatasetKind: ManifestDatasetKind.UNDERLYING_1M,
    identity: manifest.identity,
    contentChecksum: manifest.contentChecksum,
    canonicalRowCount: manifest.canonicalRowCount,
    sourceRows: rows,
  };
}

async function loadOptionSession(sessionBuilder: DatasetSessionManifestBuilderService, tradingDate: string, start: Date, end: Date, sessionWindows: readonly SessionWindow[] | undefined) {
  const growwSymbol = process.env.RESEARCH_RESAMPLE_OPTION_GROWW_SYMBOL?.trim();
  if (!growwSymbol) {
    throw new Error('RESEARCH_RESAMPLE_OPTION_GROWW_SYMBOL is required for EXPIRED_OPTION_1M (e.g. NSE-NIFTY-06Jan22-17200-PE). This script never defaults to an implicit contract.');
  }
  const parsed = parseGrowwSymbol(growwSymbol, { exchange: 'NSE', underlyingSymbol: 'NIFTY' });
  if (!parsed.ok || parsed.value.kind !== 'OPTION') {
    throw new Error(`RESEARCH_RESAMPLE_OPTION_GROWW_SYMBOL '${growwSymbol}' could not be parsed as an NSE NIFTY option symbol: ${!parsed.ok ? parsed.failure.detail : 'not an option symbol'}.`);
  }
  const timeframe = process.env.RESEARCH_RESAMPLE_TIMEFRAME?.trim() || '1minute';
  const provider = (process.env.RESEARCH_RESAMPLE_PROVIDER?.trim() as HistoricalProviderId | undefined) ?? HistoricalProviderId.GROWW;

  const repository = new HistoricalOptionCandleLakeRepository();
  const rows = await repository.findRange(growwSymbol, timeframe, start, end);
  const manifest = sessionBuilder.buildOptionSession({
    provider,
    providerContractId: growwSymbol,
    optionType: parsed.value.optionType,
    strikePrice: parsed.value.strikePrice,
    expiry: parsed.value.expiry,
    timeframe,
    tradingDate,
    rows,
    sessionWindows,
  });

  return {
    sourceDatasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
    identity: manifest.identity,
    contentChecksum: manifest.contentChecksum,
    canonicalRowCount: manifest.canonicalRowCount,
    sourceRows: rows,
  };
}

run().catch((error) => {
  console.error('B-F7 research resampling failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
