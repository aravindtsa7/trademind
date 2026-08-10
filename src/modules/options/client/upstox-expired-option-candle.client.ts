import axios, { AxiosInstance } from 'axios';
import logger from '../../../core/logger/logger';
import {
  ExpiredOptionCandleDto,
  UpstoxExpiredOptionCandleApiResponseDto,
  UpstoxExpiredOptionCandleRow,
} from '../dto/upstox-expired-option-candle.dto';

const expiredHistoricalCandleBaseUrl =
  'https://api.upstox.com/v2/expired-instruments/historical-candle';
const supportedInterval = '1minute';

export default class UpstoxExpiredOptionCandleClient {
  private readonly axios: AxiosInstance;
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken.trim();
    if (!this.accessToken) {
      throw new Error('An Upstox OAuth access token is required for expired option candles.');
    }

    this.axios = axios.create({ timeout: 10_000 });
  }

  async fetchCandles(
    instrumentKey: string,
    fromDate: string,
    toDate: string,
    interval: string = supportedInterval
  ): Promise<ExpiredOptionCandleDto[]> {
    this.validateRequest(instrumentKey, fromDate, toDate, interval);

    const startedAt = Date.now();
    const url = `${expiredHistoricalCandleBaseUrl}/${encodeURIComponent(
      instrumentKey
    )}/${interval}/${encodeURIComponent(toDate)}/${encodeURIComponent(fromDate)}`;

    try {
      logger.info('Requesting Upstox expired option candles', {
        instrumentKey,
        fromDate,
        toDate,
        interval,
        url,
      });

      const response = await this.axios.get<UpstoxExpiredOptionCandleApiResponseDto>(url, {
        headers: this.getHeaders(),
      });
      const candles = this.validateResponse(response.data).map((candle) =>
        this.mapCandle(instrumentKey, candle)
      );

      logger.info('Upstox expired option candles received', {
        instrumentKey,
        fromDate,
        toDate,
        interval,
        candleCount: candles.length,
        durationMs: Date.now() - startedAt,
      });

      return candles;
    } catch (error) {
      logger.error('Failed to fetch Upstox expired option candles', {
        instrumentKey,
        fromDate,
        toDate,
        interval,
        url,
        durationMs: Date.now() - startedAt,
        ...(axios.isAxiosError(error)
          ? {
              httpStatus: error.response?.status,
              responseData: error.response?.data,
            }
          : {}),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private validateRequest(
    instrumentKey: string,
    fromDate: string,
    toDate: string,
    interval: string
  ): void {
    if (!instrumentKey.trim()) {
      throw new Error('An expired option instrument key is required.');
    }

    if (interval !== supportedInterval) {
      throw new Error(`Expired option candle interval must be ${supportedInterval}.`);
    }

    if (!this.isValidDateString(fromDate) || !this.isValidDateString(toDate) || fromDate > toDate) {
      throw new Error('Expired option candle dates must form a valid ascending YYYY-MM-DD range.');
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private validateResponse(response: unknown): UpstoxExpiredOptionCandleRow[] {
    if (!response || typeof response !== 'object') {
      throw new Error('Upstox expired option candle response is invalid.');
    }

    const payload = response as Partial<UpstoxExpiredOptionCandleApiResponseDto>;
    if (
      payload.status !== 'success' ||
      !payload.data ||
      !Array.isArray(payload.data.candles) ||
      payload.data.candles.length === 0
    ) {
      throw new Error('Upstox expired option candle response did not contain candles.');
    }

    payload.data.candles.forEach((candle) => this.validateCandleRow(candle));

    return payload.data.candles;
  }

  private validateCandleRow(candle: unknown): asserts candle is UpstoxExpiredOptionCandleRow {
    if (!Array.isArray(candle) || candle.length < 6) {
      throw new Error('Upstox expired option candle row is invalid.');
    }

    const [candleTime, open, high, low, close, volume, openInterest] = candle;
    if (
      typeof candleTime !== 'string' ||
      Number.isNaN(new Date(candleTime).getTime()) ||
      !this.isFiniteNumber(open) ||
      !this.isFiniteNumber(high) ||
      !this.isFiniteNumber(low) ||
      !this.isFiniteNumber(close) ||
      !this.isIntegerNumber(volume) ||
      volume < 0 ||
      (openInterest !== undefined && (!this.isIntegerNumber(openInterest) || openInterest < 0))
    ) {
      throw new Error('Upstox expired option candle row contains invalid values.');
    }
  }

  private mapCandle(
    instrumentKey: string,
    candle: UpstoxExpiredOptionCandleRow
  ): ExpiredOptionCandleDto {
    const [candleTime, open, high, low, close, volume, openInterest] = candle;

    return {
      instrumentKey,
      candleTime: new Date(candleTime),
      open,
      high,
      low,
      close,
      volume: BigInt(volume),
      openInterest: openInterest === undefined ? undefined : BigInt(openInterest),
    };
  }

  private isValidDateString(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private isIntegerNumber(value: unknown): value is number {
    return this.isFiniteNumber(value) && Number.isInteger(value);
  }
}
