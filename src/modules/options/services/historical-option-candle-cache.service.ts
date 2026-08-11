import { Prisma } from '@prisma/client';
import { ExpiredOptionCandleDto } from '../dto/upstox-expired-option-candle.dto';
import UpstoxExpiredOptionCandleClient from '../client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../repositories/historical-option-candle.repository';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface HistoricalOptionCandleCacheMetadata { tradingSymbol?: string; optionType?: string; strikePrice?: number; expiry?: Date; }
export interface HistoricalOptionCandleCacheStats { hits: number; misses: number; stored: number; }
export interface HistoricalOptionCandleCacheAuthorizedOverfullNormalization { instrumentKey: string; tradingDate: string; }
export interface HistoricalOptionCandleCacheSessionResult { instrumentKey: string; tradingDate: string; status: 'hit' | 'downloaded' | 'normalized' | 'overfull' | 'failed'; downloadedCandleCount: number; storedCandleCount: number; excludedCandleCount?: number; extraCandleTimes?: string[]; error?: string; }

export default class HistoricalOptionCandleCacheService {
  private readonly inFlight = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  private readonly stats: HistoricalOptionCandleCacheStats = { hits: 0, misses: 0, stored: 0 };
  private readonly sessionResults: HistoricalOptionCandleCacheSessionResult[] = [];

  constructor(private readonly repository: HistoricalOptionCandleRepository, private readonly client: UpstoxExpiredOptionCandleClient, private readonly authorizedOverfullNormalizations: readonly HistoricalOptionCandleCacheAuthorizedOverfullNormalization[] = []) {}

  async getCandles(instrumentKey: string, tradingDate: string, metadata: HistoricalOptionCandleCacheMetadata = {}): Promise<ExpiredOptionCandleDto[]> {
    const key = `${instrumentKey}|1minute|${tradingDate}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.load(instrumentKey, tradingDate, metadata).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  getStats(): HistoricalOptionCandleCacheStats { return { ...this.stats }; }
  getSessionResults(): HistoricalOptionCandleCacheSessionResult[] { return this.sessionResults.map((result) => ({ ...result })); }

  private async load(instrumentKey: string, tradingDate: string, metadata: HistoricalOptionCandleCacheMetadata): Promise<ExpiredOptionCandleDto[]> {
    let downloadedCandleCount = 0;
    let storedCandleCount = 0;
    let sessionResultRecorded = false;
    try {
      const { from, to } = this.dayBounds(tradingDate);
      const cached = await this.repository.findRange(instrumentKey, '1minute', from, to);
      if (this.isComplete(cached.map((candle) => candle.candleTime), tradingDate)) {
        this.stats.hits += 1;
        this.sessionResults.push({ instrumentKey, tradingDate, status: 'hit', downloadedCandleCount: 0, storedCandleCount: 0 });
        return this.toDtos(cached);
      }
      this.stats.misses += 1;
      const downloaded = await this.fetchWithRetry(instrumentKey, tradingDate);
      downloadedCandleCount = downloaded.length;
      if (downloaded.length === 0) throw new Error(`Upstox returned no option candles for ${instrumentKey} on ${tradingDate}.`);
      const validation = this.validateDownloadedSession(downloaded, tradingDate);
      if (validation.status === 'overfull') {
        if (this.isAuthorizedOverfullNormalization(instrumentKey, tradingDate, validation.extraCandleTimes)) {
          const normalized = downloaded.filter((candle) => this.isRegularSessionMinute(candle.candleTime, tradingDate));
          if (normalized.length !== 375) throw new Error(`Authorized normalization produced ${normalized.length} regular-session candles for ${instrumentKey} on ${tradingDate}; expected 375.`);
          return await this.storeValidatedCandles(instrumentKey, tradingDate, metadata, normalized, downloadedCandleCount, validation.extraCandleTimes);
        }
        const error = `Upstox returned 375 valid in-session option candles plus ${validation.extraCandleTimes.length} out-of-session rows for ${instrumentKey} on ${tradingDate}; refusing to store until guarded cleanup is authorized.`;
        this.sessionResults.push({ instrumentKey, tradingDate, status: 'overfull', downloadedCandleCount, storedCandleCount, extraCandleTimes: validation.extraCandleTimes.map((candleTime) => candleTime.toISOString()), error });
        sessionResultRecorded = true;
        throw new Error(error);
      }
      if (validation.status === 'invalid') throw new Error(`Upstox returned incomplete or malformed option candles for ${instrumentKey} on ${tradingDate}; expected 375 continuous valid 1minute candles from 09:15 through 15:29 IST, received ${downloaded.length}.`);
      return await this.storeValidatedCandles(instrumentKey, tradingDate, metadata, downloaded, downloadedCandleCount);
    } catch (error) {
      if (!sessionResultRecorded) this.sessionResults.push({ instrumentKey, tradingDate, status: 'failed', downloadedCandleCount, storedCandleCount, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async storeValidatedCandles(instrumentKey: string, tradingDate: string, metadata: HistoricalOptionCandleCacheMetadata, candles: readonly ExpiredOptionCandleDto[], downloadedCandleCount: number, excludedCandleTimes: readonly Date[] = []): Promise<ExpiredOptionCandleDto[]> {
    const { from, to } = this.dayBounds(tradingDate);
    const stored = await this.repository.bulkUpsert(candles.map((candle) => ({ instrumentKey, timeframe: '1minute', candleTime: candle.candleTime, tradingSymbol: metadata.tradingSymbol, optionType: metadata.optionType, strikePrice: metadata.strikePrice === undefined ? undefined : new Prisma.Decimal(metadata.strikePrice), expiry: metadata.expiry, open: new Prisma.Decimal(candle.open), high: new Prisma.Decimal(candle.high), low: new Prisma.Decimal(candle.low), close: new Prisma.Decimal(candle.close), volume: candle.volume, openInterest: candle.openInterest })));
    this.stats.stored += stored.length;
    const persisted = await this.repository.findRange(instrumentKey, '1minute', from, to);
    if (!this.isComplete(persisted.map((candle) => candle.candleTime), tradingDate)) throw new Error(`Stored option candles are incomplete for ${instrumentKey} on ${tradingDate}; expected 375 continuous 1minute candles from 09:15 through 15:29 IST, found ${persisted.length}.`);
    this.sessionResults.push({ instrumentKey, tradingDate, status: excludedCandleTimes.length === 0 ? 'downloaded' : 'normalized', downloadedCandleCount, storedCandleCount: stored.length, excludedCandleCount: excludedCandleTimes.length || undefined, extraCandleTimes: excludedCandleTimes.length === 0 ? undefined : excludedCandleTimes.map((candleTime) => candleTime.toISOString()) });
    return this.toDtos(persisted);
  }

  private async fetchWithRetry(instrumentKey: string, tradingDate: string): Promise<ExpiredOptionCandleDto[]> { let failure: unknown; for (let attempt = 1; attempt <= 3; attempt += 1) { try { return await this.client.fetchCandles(instrumentKey, tradingDate, tradingDate); } catch (error) { failure = error; if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 500)); } } throw failure; }

  private dayBounds(tradingDate: string): { from: Date; to: Date } { const from = new Date(`${tradingDate}T00:00:00+05:30`); const to = new Date(`${tradingDate}T23:59:59.999+05:30`); return { from, to }; }
  private isComplete(candles: readonly Date[], tradingDate: string): boolean {
    if (candles.length !== 375) return false;
    const sorted = [...candles].sort((left, right) => left.getTime() - right.getTime());
    const first = this.marketTime(sorted[0]);
    const last = this.marketTime(sorted[sorted.length - 1]);
    return first.date === tradingDate && last.date === tradingDate && first.minute === 9 * 60 + 15 && last.minute === 15 * 60 + 29 && sorted.every((candle, index) => index === 0 || candle.getTime() - sorted[index - 1].getTime() === 60_000);
  }

  private validateDownloadedSession(candles: readonly ExpiredOptionCandleDto[], tradingDate: string): { status: 'complete' | 'overfull' | 'invalid'; extraCandleTimes: Date[] } {
    const expectedStart = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
    const expected = new Set(Array.from({ length: 375 }, (_, index) => expectedStart + index * 60_000));
    const timestamps = candles.map((candle) => candle.candleTime.getTime());
    const observed = new Set(timestamps);
    const missing = [...expected].filter((timestamp) => !observed.has(timestamp));
    const extras = [...observed].filter((timestamp) => !expected.has(timestamp)).sort((left, right) => left - right);
    const validOhlc = candles.every((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close) && candle.low <= Math.min(candle.open, candle.close) && candle.high >= Math.max(candle.open, candle.close));
    if (candles.length === 375 && observed.size === 375 && missing.length === 0 && extras.length === 0 && validOhlc) return { status: 'complete', extraCandleTimes: [] };
    const extrasAreSameTradingDate = extras.every((timestamp) => this.marketTime(new Date(timestamp)).date === tradingDate);
    if (observed.size === candles.length && missing.length === 0 && extras.length > 0 && extrasAreSameTradingDate && validOhlc) return { status: 'overfull', extraCandleTimes: extras.map((timestamp) => new Date(timestamp)) };
    return { status: 'invalid', extraCandleTimes: extras.map((timestamp) => new Date(timestamp)) };
  }

  private isAuthorizedOverfullNormalization(instrumentKey: string, tradingDate: string, extraCandleTimes: readonly Date[]): boolean {
    if (!this.authorizedOverfullNormalizations.some((request) => request.instrumentKey === instrumentKey && request.tradingDate === tradingDate)) return false;
    const firstExtra = new Date(`${tradingDate}T15:30:00+05:30`).getTime();
    return extraCandleTimes.length === 10 && extraCandleTimes.every((candleTime, index) => candleTime.getTime() === firstExtra + index * 60_000);
  }

  private isRegularSessionMinute(candleTime: Date, tradingDate: string): boolean {
    const timestamp = candleTime.getTime();
    const first = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
    const last = new Date(`${tradingDate}T15:29:00+05:30`).getTime();
    return timestamp >= first && timestamp <= last && (timestamp - first) % 60_000 === 0;
  }

  private toDtos(candles: Awaited<ReturnType<HistoricalOptionCandleRepository['findRange']>>): ExpiredOptionCandleDto[] {
    return candles.map((candle) => ({ instrumentKey: candle.instrumentKey, candleTime: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: candle.volume, openInterest: candle.openInterest ?? undefined }));
  }

  private marketTime(timestamp: Date): { date: string; minute: number } {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }
}
