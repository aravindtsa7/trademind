import axios, { AxiosInstance } from 'axios';
import logger from '../../../core/logger/logger';
import {
  UpstoxHistoricalCandleApiResponseDto,
  UpstoxHistoricalCandleDto,
  UpstoxHistoricalCandleRow,
} from '../dto/upstox-historical-candle.dto';

const intradayCandleBaseUrl = 'https://api.upstox.com/v3/historical-candle/intraday';

/**
 * Current-trading-day candles must use Upstox's intraday endpoint.  The
 * date-range historical endpoint intentionally serves completed dates only.
 */
export default class UpstoxIntradayCandleClient {
  private readonly axios: AxiosInstance;

  constructor(private readonly accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim()) {
    if (!accessToken) {
      throw new Error('UPSTOX_ACCESS_TOKEN is required for current-day intraday candle backfill.');
    }
    this.axios = axios.create({ timeout: 10_000 });
  }

  async fetchCurrentDayOneMinuteCandles(instrumentKey: string): Promise<UpstoxHistoricalCandleDto[]> {
    const startedAt = Date.now();
    const url = `${intradayCandleBaseUrl}/${encodeURIComponent(instrumentKey)}/minutes/1`;

    try {
      logger.info('Requesting Upstox current-day one-minute intraday candles', { instrumentKey });
      const response = await this.axios.get<UpstoxHistoricalCandleApiResponseDto>(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
      });
      const candles = this.validateResponse(response.data).map((candle) => this.mapCandle(candle));
      logger.info('Upstox current-day one-minute intraday candles received', {
        instrumentKey,
        candleCount: candles.length,
        durationMs: Date.now() - startedAt,
      });
      return candles;
    } catch (error) {
      logger.error('Failed to fetch Upstox current-day one-minute intraday candles', {
        instrumentKey,
        url,
        durationMs: Date.now() - startedAt,
        ...(axios.isAxiosError(error) ? { httpStatus: error.response?.status, responseData: error.response?.data } : {}),
        error,
      });
      throw error;
    }
  }

  private validateResponse(response: unknown): UpstoxHistoricalCandleRow[] {
    if (!response || typeof response !== 'object') throw new Error('Upstox intraday candle response is invalid.');
    const payload = response as Partial<UpstoxHistoricalCandleApiResponseDto>;
    if (payload.status !== 'success' || !payload.data || !Array.isArray(payload.data.candles)) {
      throw new Error('Upstox intraday candle response did not contain candle data.');
    }
    payload.data.candles.forEach((candle) => this.validateCandleRow(candle));
    return payload.data.candles;
  }

  private validateCandleRow(candle: unknown): asserts candle is UpstoxHistoricalCandleRow {
    if (!Array.isArray(candle) || candle.length < 6) throw new Error('Upstox intraday candle row is invalid.');
    const [candleTime, open, high, low, close, volume, openInterest] = candle;
    if (
      typeof candleTime !== 'string' ||
      Number.isNaN(new Date(candleTime).getTime()) ||
      !this.isFiniteNumber(open) || !this.isFiniteNumber(high) || !this.isFiniteNumber(low) || !this.isFiniteNumber(close) ||
      !this.isIntegerNumber(volume) || (openInterest !== undefined && !this.isIntegerNumber(openInterest)) ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)
    ) throw new Error('Upstox intraday candle row contains invalid values.');
  }

  private mapCandle([candleTime, open, high, low, close, volume, openInterest]: UpstoxHistoricalCandleRow): UpstoxHistoricalCandleDto {
    return { candleTime: new Date(candleTime), open, high, low, close, volume: BigInt(volume), openInterest: openInterest === undefined ? undefined : BigInt(openInterest) };
  }

  private isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
  private isIntegerNumber(value: unknown): value is number { return this.isFiniteNumber(value) && Number.isInteger(value); }
}
