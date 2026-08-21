import logger from '../../../core/logger/logger';
import UpstoxHistoricalClient from '../client/upstox-historical.client';
import { HistoricalCandleSyncSummary } from '../dto/historical-candle-sync-summary.dto';
import { UpstoxHistoricalCandleDto } from '../dto/upstox-historical-candle.dto';
import {
  HistoricalCandleUpsertInput,
  default as HistoricalCandleRepository,
} from '../repositories/historical-candle.repository';
import { isCompleteHistoricalSession } from '../utils/historical-session-completeness.util';

const oneMinuteTimeframe = '1minute';

interface HistoricalCandleRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

export interface HistoricalCandleSyncOptions {
  /**
   * An explicit, caller-supplied list of known trading dates (YYYY-MM-DD,
   * IST) to reconcile against the historical session completeness contract
   * (375 rows, 09:15-15:29 IST, minute-aligned, exact 60,000ms continuity).
   * This repository has no NSE holiday calendar, so this list is never
   * inferred from the requested date range -- omitting it (the default)
   * leaves `sync()`'s existing leading/trailing coverage-bookend behavior
   * completely unchanged. Dates outside [fromDate, toDate] are ignored.
   */
  tradingDates?: readonly string[];
}

/** Fail-closed signal: a requested trading session was still incomplete after a reconciliation fetch + persist. Never silently reported as a successful sync. */
export class HistoricalCandleReconciliationIncompleteError extends Error {
  constructor(public readonly date: string, public readonly rowCountAfterFetch: number) {
    super(
      `Historical candle session for ${date} remains incomplete after reconciliation fetch and persistence (rowCount=${rowCountAfterFetch}, expected 375 complete/contiguous/minute-aligned rows for 09:15-15:29 IST).`
    );
    this.name = 'HistoricalCandleReconciliationIncompleteError';
  }
}

interface HistoricalCandleEntity {
  instrumentKey: string;
  timeframe: string;
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  openInterest?: bigint;
  source: string;
}

export default class HistoricalCandleSyncService {
  private repository = new HistoricalCandleRepository();
  private client = new UpstoxHistoricalClient();

  async plan(instrumentKey: string, fromDate: string, toDate: string): Promise<{
    instrumentKey: string;
    timeframe: string;
    fromDate: string;
    toDate: string;
    existingRowCount: number;
    chunks: Array<{ fromDate: string; toDate: string }>;
  }> {
    const requestedRange = this.createRequestedRange(fromDate, toDate);
    const existingCandles = await this.repository.findRange(
      instrumentKey,
      oneMinuteTimeframe,
      requestedRange.from,
      requestedRange.to
    );
    const chunks = this.getMissingRanges(requestedRange, existingCandles).flatMap((range) =>
      this.splitIntoMonthlyChunks(range)
    );
    return {
      instrumentKey,
      timeframe: oneMinuteTimeframe,
      fromDate,
      toDate,
      existingRowCount: existingCandles.length,
      chunks: chunks.map((chunk) => ({ fromDate: chunk.fromDate, toDate: chunk.toDate })),
    };
  }

  async sync(
    instrumentKey: string,
    fromDate: string,
    toDate: string,
    options?: HistoricalCandleSyncOptions
  ): Promise<HistoricalCandleSyncSummary> {
    const startedAt = new Date();
    let syncLogId: string | undefined;
    let downloaded = 0;
    let inserted = 0;
    let updated = 0;
    let reconciledDates: string[] | undefined;
    let skippedCompleteDates: string[] | undefined;

    try {
      const syncLog = await this.repository.createSyncLog({
        instrumentKey,
        timeframe: oneMinuteTimeframe,
        startedAt,
        status: 'RUNNING',
      });
      syncLogId = syncLog.id;

      logger.info('Starting historical candle sync', {
        syncLogId,
        instrumentKey,
        timeframe: oneMinuteTimeframe,
        fromDate,
        toDate,
        tradingDates: options?.tradingDates,
      });

      const requestedRange = this.createRequestedRange(fromDate, toDate);

      if (options?.tradingDates && options.tradingDates.length > 0) {
        const result = await this.reconcileKnownTradingDates(
          instrumentKey,
          requestedRange,
          options.tradingDates,
          syncLogId
        );
        downloaded = result.downloaded;
        inserted = result.inserted;
        updated = result.updated;
        reconciledDates = result.reconciledDates;
        skippedCompleteDates = result.skippedCompleteDates;
      } else {
        const existingCandles = await this.repository.findRange(
          instrumentKey,
          oneMinuteTimeframe,
          requestedRange.from,
          requestedRange.to
        );
        const missingRanges = this.getMissingRanges(requestedRange, existingCandles);
        const existingTimes = new Set(existingCandles.map((candle) => candle.candleTime.getTime()));

        if (missingRanges.length > 0) {
          const downloadedCandles = new Map<number, UpstoxHistoricalCandleDto>();

          for (const missingRange of missingRanges) {
            logger.info('Synchronizing missing historical candle range', {
              syncLogId,
              instrumentKey,
              timeframe: oneMinuteTimeframe,
              fromDate: missingRange.fromDate,
              toDate: missingRange.toDate,
            });

            for (const chunk of this.splitIntoMonthlyChunks(missingRange)) {
              logger.info('Synchronizing historical candle request chunk', {
                syncLogId,
                instrumentKey,
                timeframe: oneMinuteTimeframe,
                fromDate: chunk.fromDate,
                toDate: chunk.toDate,
              });

              const candles = await this.fetchChunkWithRetry(instrumentKey, chunk);
              this.validateDownloadedCandles(candles);
              downloaded += candles.length;

              candles.forEach((candle) => {
                if (candle.candleTime >= chunk.from && candle.candleTime <= chunk.to) {
                  downloadedCandles.set(candle.candleTime.getTime(), candle);
                }
              });
            }
          }

          const entities = Array.from(downloadedCandles.values()).map((candle) =>
            this.toEntity(instrumentKey, candle)
          );
          const upserts = entities.map((entity) => this.toUpsertInput(entity));
          const insertedEntities = entities.filter(
            (entity) => !existingTimes.has(entity.candleTime.getTime())
          );

          inserted += insertedEntities.length;
          updated += entities.length - insertedEntities.length;

          if (upserts.length > 0) {
            await this.repository.bulkUpsert(upserts);
            entities.forEach((entity) => existingTimes.add(entity.candleTime.getTime()));
          }

          logger.info('Historical candles synchronized', {
            syncLogId,
            instrumentKey,
            downloaded,
            inserted,
            updated,
          });
        } else {
          logger.info('Historical candle sync found no missing range', {
            syncLogId,
            instrumentKey,
            timeframe: oneMinuteTimeframe,
          });
        }
      }

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const summary: HistoricalCandleSyncSummary = {
        instrumentKey,
        timeframe: oneMinuteTimeframe,
        startedAt,
        completedAt,
        durationMs,
        downloaded,
        inserted,
        updated,
        ...(reconciledDates ? { reconciledDates } : {}),
        ...(skippedCompleteDates ? { skippedCompleteDates } : {}),
      };

      await this.repository.updateSyncLog(syncLogId, {
        completedAt,
        downloaded,
        inserted,
        updated,
        durationMs,
        status: 'COMPLETED',
      });

      logger.info('Historical candle sync completed', { syncLogId, ...summary });

      return summary;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const errorMessage = error instanceof Error ? error.message : 'Unknown historical candle sync error';

      logger.error('Historical candle sync failed', {
        syncLogId,
        instrumentKey,
        error,
      });

      if (syncLogId) {
        try {
          await this.repository.updateSyncLog(syncLogId, {
            completedAt,
            downloaded,
            inserted,
            updated,
            durationMs,
            status: 'FAILED',
            errorMessage,
          });
        } catch (logError) {
          logger.error('Failed to update historical candle sync failure log', {
            syncLogId,
            error: logError,
          });
        }
      }

      throw error;
    }
  }

  private createRequestedRange(fromDate: string, toDate: string): HistoricalCandleRange {
    const from = new Date(`${fromDate}T00:00:00+05:30`);
    const to = new Date(`${toDate}T23:59:59.999+05:30`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new Error('Historical candle sync dates must form a valid ascending range.');
    }

    return { from, to, fromDate, toDate };
  }

  /**
   * Completeness-aware reconciliation for an explicit, caller-supplied set
   * of known trading dates -- entirely separate from `getMissingRanges`
   * (which only reasons about the requested range's leading/trailing
   * coverage bookends and cannot see an interior missing/partial date; see
   * the class-level defect this addresses). For each candidate date this
   * re-reads the currently stored rows, checks them against the historical
   * session completeness contract (`isCompleteHistoricalSession`), and
   * skips the broker fetch entirely for a date that is already complete.
   * For a missing/partial/gapped/duplicate date it fetches the full
   * authoritative day from the broker and reuses the existing atomic
   * `HistoricalCandleRepository.bulkUpsert` path -- never a delete -- so an
   * existing valid row can only ever be refreshed to the authoritative
   * value or left untouched, never removed. After persistence it re-reads
   * the date from the repository (not from the in-memory fetch result) and
   * requires the contract to hold; if it still does not, this throws
   * `HistoricalCandleReconciliationIncompleteError` rather than reporting
   * that date as reconciled, so the caller's `sync()` fails closed and the
   * sync log is marked FAILED (see the try/catch in `sync()`).
   */
  private async reconcileKnownTradingDates(
    instrumentKey: string,
    requestedRange: HistoricalCandleRange,
    tradingDates: readonly string[],
    syncLogId: string | undefined
  ): Promise<{
    downloaded: number;
    inserted: number;
    updated: number;
    reconciledDates: string[];
    skippedCompleteDates: string[];
  }> {
    const candidateDates = [...new Set(tradingDates)]
      .filter((date) => date >= requestedRange.fromDate && date <= requestedRange.toDate)
      .sort();

    let downloaded = 0;
    let inserted = 0;
    let updated = 0;
    const reconciledDates: string[] = [];
    const skippedCompleteDates: string[] = [];

    for (const date of candidateDates) {
      const dayRange = this.createRequestedRange(date, date);
      const existing = await this.repository.findRange(
        instrumentKey,
        oneMinuteTimeframe,
        dayRange.from,
        dayRange.to
      );

      if (isCompleteHistoricalSession(existing)) {
        logger.info('Historical candle session already complete; skipping reconciliation fetch', {
          syncLogId,
          instrumentKey,
          timeframe: oneMinuteTimeframe,
          date,
        });
        skippedCompleteDates.push(date);
        continue;
      }

      logger.info('Reconciling incomplete/missing historical candle session', {
        syncLogId,
        instrumentKey,
        timeframe: oneMinuteTimeframe,
        date,
        existingRowCount: existing.length,
      });

      const existingTimes = new Set(existing.map((candle) => candle.candleTime.getTime()));
      const fetched = await this.fetchChunkWithRetry(instrumentKey, dayRange);
      this.validateDownloadedCandles(fetched);
      downloaded += fetched.length;

      const inRange = fetched.filter(
        (candle) => candle.candleTime >= dayRange.from && candle.candleTime <= dayRange.to
      );
      const entities = inRange.map((candle) => this.toEntity(instrumentKey, candle));
      const upserts = entities.map((entity) => this.toUpsertInput(entity));
      const insertedEntities = entities.filter((entity) => !existingTimes.has(entity.candleTime.getTime()));

      inserted += insertedEntities.length;
      updated += entities.length - insertedEntities.length;

      if (upserts.length > 0) {
        await this.repository.bulkUpsert(upserts);
      }

      const verification = await this.repository.findRange(
        instrumentKey,
        oneMinuteTimeframe,
        dayRange.from,
        dayRange.to
      );

      if (!isCompleteHistoricalSession(verification)) {
        throw new HistoricalCandleReconciliationIncompleteError(date, verification.length);
      }

      logger.info('Historical candle session reconciled to completeness', {
        syncLogId,
        instrumentKey,
        timeframe: oneMinuteTimeframe,
        date,
        rowCount: verification.length,
      });
      reconciledDates.push(date);
    }

    return { downloaded, inserted, updated, reconciledDates, skippedCompleteDates };
  }

  private getMissingRanges(
    requestedRange: HistoricalCandleRange,
    existingCandles: Array<{ candleTime: Date }>
  ): HistoricalCandleRange[] {
    if (existingCandles.length === 0) {
      return [requestedRange];
    }

    const firstExistingDate = this.formatMarketDate(existingCandles[0].candleTime);
    const lastExistingDate = this.formatMarketDate(
      existingCandles[existingCandles.length - 1].candleTime
    );
    const missingRanges: HistoricalCandleRange[] = [];

    if (requestedRange.fromDate < firstExistingDate) {
      missingRanges.push(
        this.createRequestedRange(
          requestedRange.fromDate,
          this.shiftMarketDate(firstExistingDate, -1)
        )
      );
    }

    if (lastExistingDate < requestedRange.toDate) {
      missingRanges.push(
        this.createRequestedRange(
          this.shiftMarketDate(lastExistingDate, 1),
          requestedRange.toDate
        )
      );
    }

    return missingRanges;
  }

  private splitIntoMonthlyChunks(range: HistoricalCandleRange): HistoricalCandleRange[] {
    const chunks: HistoricalCandleRange[] = [];
    let chunkFromDate = range.fromDate;

    while (chunkFromDate <= range.toDate) {
      const monthEndDate = this.getMarketMonthEndDate(chunkFromDate);
      const chunkToDate = monthEndDate < range.toDate ? monthEndDate : range.toDate;

      chunks.push(this.createRequestedRange(chunkFromDate, chunkToDate));
      chunkFromDate = this.shiftMarketDate(chunkToDate, 1);
    }

    return chunks;
  }

  private getMarketMonthEndDate(date: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
      throw new Error('Historical candle sync dates must use YYYY-MM-DD format.');
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
  }

  private validateDownloadedCandles(candles: UpstoxHistoricalCandleDto[]): void {
    candles.forEach((candle) => {
      if (
        Number.isNaN(candle.candleTime.getTime()) ||
        !Number.isFinite(candle.open) ||
        !Number.isFinite(candle.high) ||
        !Number.isFinite(candle.low) ||
        !Number.isFinite(candle.close) ||
        candle.volume < 0n ||
        (candle.openInterest !== undefined && candle.openInterest < 0n)
      ) {
        throw new Error('Downloaded historical candle contains invalid values.');
      }
    });
  }

  private async fetchChunkWithRetry(
    instrumentKey: string,
    chunk: HistoricalCandleRange
  ): Promise<UpstoxHistoricalCandleDto[]> {
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.fetchOneMinuteCandles(instrumentKey, chunk.toDate, chunk.fromDate);
      } catch (error) {
        failure = error;
        if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw failure;
  }

  private toEntity(
    instrumentKey: string,
    candle: UpstoxHistoricalCandleDto
  ): HistoricalCandleEntity {
    return {
      instrumentKey,
      timeframe: oneMinuteTimeframe,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      openInterest: candle.openInterest,
      source: 'REST',
    };
  }

  private toUpsertInput(entity: HistoricalCandleEntity): HistoricalCandleUpsertInput {
    const { instrumentKey, timeframe, candleTime, ...candleData } = entity;

    return {
      create: {
        instrumentKey,
        timeframe,
        candleTime,
        ...candleData,
      },
      update: candleData,
    };
  }

  private formatMarketDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
  }

  private shiftMarketDate(date: string, days: number): string {
    const shiftedDate = new Date(`${date}T00:00:00.000Z`);
    shiftedDate.setUTCDate(shiftedDate.getUTCDate() + days);

    return shiftedDate.toISOString().slice(0, 10);
  }
}
