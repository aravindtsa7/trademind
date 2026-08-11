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

export default class HistoricalOptionCandleCacheService {
  private readonly inFlight = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  private readonly stats: HistoricalOptionCandleCacheStats = { hits: 0, misses: 0, stored: 0 };

  constructor(private readonly repository: HistoricalOptionCandleRepository, private readonly client: UpstoxExpiredOptionCandleClient) {}

  async getCandles(instrumentKey: string, tradingDate: string, metadata: HistoricalOptionCandleCacheMetadata = {}): Promise<ExpiredOptionCandleDto[]> {
    const key = `${instrumentKey}|1minute|${tradingDate}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.load(instrumentKey, tradingDate, metadata).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  getStats(): HistoricalOptionCandleCacheStats { return { ...this.stats }; }

  private async load(instrumentKey: string, tradingDate: string, metadata: HistoricalOptionCandleCacheMetadata): Promise<ExpiredOptionCandleDto[]> {
    const { from, to } = this.dayBounds(tradingDate);
    const cached = await this.repository.findRange(instrumentKey, '1minute', from, to);
    if (this.isComplete(cached.map((candle) => candle.candleTime), tradingDate)) {
      this.stats.hits += 1;
      return this.toDtos(cached);
    }
    this.stats.misses += 1;
    const downloaded = await this.client.fetchCandles(instrumentKey, tradingDate, tradingDate);
    if (downloaded.length === 0) throw new Error(`Upstox returned no option candles for ${instrumentKey} on ${tradingDate}.`);
    await this.repository.bulkUpsert(downloaded.map((candle) => ({ instrumentKey, timeframe: '1minute', candleTime: candle.candleTime, tradingSymbol: metadata.tradingSymbol, optionType: metadata.optionType, strikePrice: metadata.strikePrice === undefined ? undefined : new Prisma.Decimal(metadata.strikePrice), expiry: metadata.expiry, open: new Prisma.Decimal(candle.open), high: new Prisma.Decimal(candle.high), low: new Prisma.Decimal(candle.low), close: new Prisma.Decimal(candle.close), volume: candle.volume, openInterest: candle.openInterest })));
    this.stats.stored += downloaded.length;
    return this.toDtos(await this.repository.findRange(instrumentKey, '1minute', from, to));
  }

  private dayBounds(tradingDate: string): { from: Date; to: Date } { const from = new Date(`${tradingDate}T00:00:00+05:30`); const to = new Date(`${tradingDate}T23:59:59.999+05:30`); return { from, to }; }
  private isComplete(candles: readonly Date[], tradingDate: string): boolean {
    if (candles.length !== 375) return false;
    const sorted = [...candles].sort((left, right) => left.getTime() - right.getTime());
    const first = this.marketTime(sorted[0]);
    const last = this.marketTime(sorted[sorted.length - 1]);
    return first.date === tradingDate && last.date === tradingDate && first.minute === 9 * 60 + 15 && last.minute === 15 * 60 + 29 && sorted.every((candle, index) => index === 0 || candle.getTime() - sorted[index - 1].getTime() === 60_000);
  }

  private toDtos(candles: Awaited<ReturnType<HistoricalOptionCandleRepository['findRange']>>): ExpiredOptionCandleDto[] {
    return candles.map((candle) => ({ instrumentKey: candle.instrumentKey, candleTime: new Date(candle.candleTime.getTime()), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: candle.volume, openInterest: candle.openInterest ?? undefined }));
  }

  private marketTime(timestamp: Date): { date: string; minute: number } {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }
}
