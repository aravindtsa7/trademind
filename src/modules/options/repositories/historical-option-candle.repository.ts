import { HistoricalOptionCandle, Prisma, PrismaClient } from '@prisma/client';
import logger from '../../../core/logger/logger';

const prisma = new PrismaClient();

export default class HistoricalOptionCandleRepository {
  async findRange(instrumentKey: string, timeframe: string, from: Date, to: Date): Promise<HistoricalOptionCandle[]> {
    return this.execute('find range', () => prisma.historicalOptionCandle.findMany({ where: { instrumentKey, timeframe, candleTime: { gte: from, lte: to } }, orderBy: { candleTime: 'asc' } }));
  }

  async findByInstrumentKeysAndRange(instrumentKeys: readonly string[], timeframe: string, from: Date, to: Date): Promise<HistoricalOptionCandle[]> {
    if (instrumentKeys.length === 0) return [];
    return this.execute('find by instrument keys and range', () => prisma.historicalOptionCandle.findMany({ where: { instrumentKey: { in: [...instrumentKeys] }, timeframe, candleTime: { gte: from, lte: to } }, orderBy: [{ instrumentKey: 'asc' }, { candleTime: 'asc' }] }));
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
