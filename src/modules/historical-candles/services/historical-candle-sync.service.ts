import logger from '../../../core/logger/logger';
import UpstoxHistoricalClient from '../client/upstox-historical.client';
import { HistoricalCandleSyncSummary } from '../dto/historical-candle-sync-summary.dto';
import { UpstoxHistoricalCandleDto } from '../dto/upstox-historical-candle.dto';
import {
  HistoricalCandleUpsertInput,
  default as HistoricalCandleRepository,
} from '../repositories/historical-candle.repository';

const oneMinuteTimeframe = '1minute';

interface HistoricalCandleRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
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

  async sync(
    instrumentKey: string,
    fromDate: string,
    toDate: string
  ): Promise<HistoricalCandleSyncSummary> {
    const startedAt = new Date();
    let syncLogId: string | undefined;
    let downloaded = 0;
    let inserted = 0;
    let updated = 0;

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
      });

      const requestedRange = this.createRequestedRange(fromDate, toDate);
      const existingCandles = await this.repository.findRange(
        instrumentKey,
        oneMinuteTimeframe,
        requestedRange.from,
        requestedRange.to
      );
      const missingRanges = this.getMissingRanges(requestedRange, existingCandles);
      const existingTimes = new Set(existingCandles.map((candle) => candle.candleTime.getTime()));

      if (missingRanges.length > 0) {
        for (const missingRange of missingRanges) {
          logger.info('Synchronizing missing historical candle range', {
            syncLogId,
            instrumentKey,
            timeframe: oneMinuteTimeframe,
            fromDate: missingRange.fromDate,
            toDate: missingRange.toDate,
          });

          const candles = await this.client.fetchOneMinuteCandles(
            instrumentKey,
            missingRange.toDate,
            missingRange.fromDate
          );
          this.validateDownloadedCandles(candles);
          downloaded += candles.length;

          const uniqueCandles = new Map<number, UpstoxHistoricalCandleDto>();
          candles.forEach((candle) => {
            if (candle.candleTime >= missingRange.from && candle.candleTime <= missingRange.to) {
              uniqueCandles.set(candle.candleTime.getTime(), candle);
            }
          });

          const entities = Array.from(uniqueCandles.values()).map((candle) =>
            this.toEntity(instrumentKey, candle)
          );
          const upserts = entities.map((entity) => this.toUpsertInput(entity));

          inserted += entities.filter((entity) => !existingTimes.has(entity.candleTime.getTime())).length;
          updated += entities.length - entities.filter(
            (entity) => !existingTimes.has(entity.candleTime.getTime())
          ).length;

          if (upserts.length > 0) {
            await this.repository.bulkUpsert(upserts);
            entities.forEach((entity) => existingTimes.add(entity.candleTime.getTime()));
          }
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
