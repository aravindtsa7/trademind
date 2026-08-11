import { HistoricalOptionCandle, Prisma, PrismaClient } from '@prisma/client';
import logger from '../../../core/logger/logger';

const prisma = new PrismaClient();
const sessionBatchSize = 100;

export interface HistoricalOptionCandleSessionRange { instrumentKey: string; tradingDate: string; }

export default class HistoricalOptionCandleRepository {
  async findRange(instrumentKey: string, timeframe: string, from: Date, to: Date): Promise<HistoricalOptionCandle[]> {
    return this.execute('find range', () => prisma.historicalOptionCandle.findMany({ where: { instrumentKey, timeframe, candleTime: { gte: from, lte: to } }, orderBy: { candleTime: 'asc' } }));
  }

  async findByInstrumentDateSessions(sessions: readonly HistoricalOptionCandleSessionRange[], timeframe: string): Promise<HistoricalOptionCandle[]> {
    if (sessions.length === 0) return [];
    const unique = Array.from(new Map(sessions.map((session) => [`${session.instrumentKey}|${session.tradingDate}`, session])).values());
    const rows = await Promise.all(Array.from({ length: Math.ceil(unique.length / sessionBatchSize) }, (_, index) => {
      const batch = unique.slice(index * sessionBatchSize, (index + 1) * sessionBatchSize);
      return this.execute('find by instrument date sessions', () => prisma.historicalOptionCandle.findMany({
        where: {
          timeframe,
          OR: batch.map((session) => ({ instrumentKey: session.instrumentKey, candleTime: { gte: dayStart(session.tradingDate), lte: dayEnd(session.tradingDate) } })),
        },
        orderBy: [{ instrumentKey: 'asc' }, { candleTime: 'asc' }],
      }));
    }));
    return rows.flat();
  }

  async bulkUpsert(inputs: Prisma.HistoricalOptionCandleCreateInput[]): Promise<HistoricalOptionCandle[]> {
    return this.execute('bulk upsert', () => prisma.$transaction(inputs.map((input) => prisma.historicalOptionCandle.upsert({ where: { instrumentKey_timeframe_candleTime: { instrumentKey: input.instrumentKey, timeframe: input.timeframe, candleTime: input.candleTime } }, create: input, update: { tradingSymbol: input.tradingSymbol, optionType: input.optionType, strikePrice: input.strikePrice, expiry: input.expiry, open: input.open, high: input.high, low: input.low, close: input.close, volume: input.volume, openInterest: input.openInterest } }))));
  }

  async count(): Promise<number> { return this.execute('count', () => prisma.historicalOptionCandle.count()); }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      logger.error('Historical option candle repository operation failed', { operation, error });
      throw error;
    }
  }
}

function dayStart(tradingDate: string): Date { return new Date(`${tradingDate}T00:00:00+05:30`); }
function dayEnd(tradingDate: string): Date { return new Date(`${tradingDate}T23:59:59.999+05:30`); }
