import axios, { AxiosInstance } from 'axios';
import logger from '../../../core/logger/logger';
import {
  UpstoxHistoricalCandleApiResponseDto,
  UpstoxHistoricalCandleDto,
  UpstoxHistoricalCandleRow,
} from '../dto/upstox-historical-candle.dto';

const historicalCandleBaseUrl = 'https://api.upstox.com/v3/historical-candle';

export default class UpstoxHistoricalClient {
  private axios: AxiosInstance;
  private readonly accessToken?: string;

  constructor(accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim()) {
    this.accessToken = accessToken || undefined;
    this.axios = axios.create({ timeout: 10_000 });
  }

  async fetchOneMinuteCandles(
    instrumentKey: string,
    toDate: string,
    fromDate: string
  ): Promise<UpstoxHistoricalCandleDto[]> {
    const startedAt = Date.now();
    const url = `${historicalCandleBaseUrl}/${encodeURIComponent(
      instrumentKey
    )}/minutes/1/${encodeURIComponent(toDate)}/${encodeURIComponent(fromDate)}`;

    try {
      logger.info('Requesting Upstox one-minute historical candles', {
        instrumentKey,
        fromDate,
        toDate,
      });

      const response = await this.axios.get<UpstoxHistoricalCandleApiResponseDto>(url, {
        headers: {
          Accept: 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
      });
      const candles = this.validateResponse(response.data).map((candle) => this.mapCandle(candle));

      logger.info('Upstox one-minute historical candles received', {
        instrumentKey,
        candleCount: candles.length,
        durationMs: Date.now() - startedAt,
      });

      return candles;
    } catch (error) {
      logger.error('Failed to fetch Upstox one-minute historical candles', {
        instrumentKey,
        fromDate,
        toDate,
        url,
        durationMs: Date.now() - startedAt,
        ...(axios.isAxiosError(error)
          ? {
              httpStatus: error.response?.status,
              responseData: error.response?.data,
            }
          : {}),
        error,
      });
      throw error;
    }
  }

  private validateResponse(response: unknown): UpstoxHistoricalCandleRow[] {
    if (!response || typeof response !== 'object') {
      throw new Error('Upstox historical candle response is invalid.');
    }

    const payload = response as Partial<UpstoxHistoricalCandleApiResponseDto>;
    if (payload.status !== 'success' || !payload.data || !Array.isArray(payload.data.candles)) {
      throw new Error('Upstox historical candle response did not contain candle data.');
    }

    payload.data.candles.forEach((candle) => this.validateCandleRow(candle));

    return payload.data.candles;
  }

  private validateCandleRow(candle: unknown): asserts candle is UpstoxHistoricalCandleRow {
    if (!Array.isArray(candle) || candle.length < 6) {
      throw new Error('Upstox historical candle row is invalid.');
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
      (openInterest !== undefined && !this.isIntegerNumber(openInterest))
    ) {
      throw new Error('Upstox historical candle row contains invalid values.');
    }
  }

  private mapCandle(candle: UpstoxHistoricalCandleRow): UpstoxHistoricalCandleDto {
    const [candleTime, open, high, low, close, volume, openInterest] = candle;

    return {
      candleTime: new Date(candleTime),
      open,
      high,
      low,
      close,
      volume: BigInt(volume),
      openInterest: openInterest === undefined ? undefined : BigInt(openInterest),
    };
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private isIntegerNumber(value: unknown): value is number {
    return this.isFiniteNumber(value) && Number.isInteger(value);
  }
}
