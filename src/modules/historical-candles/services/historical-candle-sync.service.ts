import logger from '../../../core/logger/logger';
import UpstoxHistoricalClient from '../client/upstox-historical.client';
import { HistoricalCandleSyncSummary } from '../dto/historical-candle-sync-summary.dto';
import { UpstoxHistoricalCandleDto } from '../dto/upstox-historical-candle.dto';
import {
  HistoricalCandleUpsertInput,
  default as HistoricalCandleRepository,
} from '../repositories/historical-candle.repository';

const oneMinuteTimeframe = '1minute';
const oneMinuteMs = 60_000;

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
      const latestCandle = await this.repository.findLatest(instrumentKey, oneMinuteTimeframe);
      const missingFrom = this.getMissingFrom(requestedRange.from, latestCandle?.candleTime);

      if (missingFrom <= requestedRange.to) {
        const candles = await this.client.fetchOneMinuteCandles(
          instrumentKey,
          toDate,
          this.formatMarketDate(missingFrom)
        );
        this.validateDownloadedCandles(candles);
        downloaded = candles.length;

        const missingCandles = candles.filter(
          (candle) => candle.candleTime >= missingFrom && candle.candleTime <= requestedRange.to
        );
        const existingCandles = await this.repository.findRange(
          instrumentKey,
          oneMinuteTimeframe,
          missingFrom,
          requestedRange.to
        );
        const existingTimes = new Set(existingCandles.map((candle) => candle.candleTime.getTime()));
        const entities = missingCandles.map((candle) => this.toEntity(instrumentKey, candle));
        const upserts = entities.map((entity) => this.toUpsertInput(entity));

        inserted = entities.filter((entity) => !existingTimes.has(entity.candleTime.getTime())).length;
        updated = entities.length - inserted;

        if (upserts.length > 0) {
          await this.repository.bulkUpsert(upserts);
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

  private createRequestedRange(fromDate: string, toDate: string): { from: Date; to: Date } {
    const from = new Date(`${fromDate}T00:00:00+05:30`);
    const to = new Date(`${toDate}T23:59:59.999+05:30`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new Error('Historical candle sync dates must form a valid ascending range.');
    }

    return { from, to };
  }

  private getMissingFrom(requestedFrom: Date, latestCandleTime: Date | undefined): Date {
    if (!latestCandleTime) {
      return requestedFrom;
    }

    const nextCandleTime = new Date(latestCandleTime.getTime() + oneMinuteMs);
    return nextCandleTime > requestedFrom ? nextCandleTime : requestedFrom;
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
}
