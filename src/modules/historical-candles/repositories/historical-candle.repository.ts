import {
  HistoricalCandle,
  HistoricalCandleSyncLog,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import logger from '../../../core/logger/logger';

const prisma = new PrismaClient();

export interface HistoricalCandleUpsertInput {
  create: Prisma.HistoricalCandleCreateInput;
  update: Prisma.HistoricalCandleUpdateInput;
}

export default class HistoricalCandleRepository {
  async create(data: Prisma.HistoricalCandleCreateInput): Promise<HistoricalCandle> {
    return this.execute('create', () => prisma.historicalCandle.create({ data }));
  }

  async update(id: string, data: Prisma.HistoricalCandleUpdateInput): Promise<HistoricalCandle> {
    return this.execute('update', () =>
      prisma.historicalCandle.update({
        where: { id },
        data,
      })
    );
  }

  async upsert(input: HistoricalCandleUpsertInput): Promise<HistoricalCandle> {
    return this.execute('upsert', () => this.createUpsertOperation(input));
  }

  async bulkCreate(data: Prisma.HistoricalCandleCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.execute('bulk create', () => prisma.historicalCandle.createMany({ data }));
  }

  async bulkUpsert(inputs: HistoricalCandleUpsertInput[]): Promise<HistoricalCandle[]> {
    return this.execute('bulk upsert', () =>
      prisma.$transaction(inputs.map((input) => this.createUpsertOperation(input)))
    );
  }

  async findLatest(instrumentKey: string, timeframe: string): Promise<HistoricalCandle | null> {
    return this.execute('find latest', () =>
      prisma.historicalCandle.findFirst({
        where: { instrumentKey, timeframe },
        orderBy: { candleTime: 'desc' },
      })
    );
  }

  async findRange(
    instrumentKey: string,
    timeframe: string,
    startTime: Date,
    endTime: Date
  ): Promise<HistoricalCandle[]> {
    return this.execute('find range', () =>
      prisma.historicalCandle.findMany({
        where: {
          instrumentKey,
          timeframe,
          candleTime: {
            gte: startTime,
            lte: endTime,
          },
        },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async findByInstrument(instrumentKey: string): Promise<HistoricalCandle[]> {
    return this.execute('find by instrument', () =>
      prisma.historicalCandle.findMany({
        where: { instrumentKey },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async findByInstrumentAndTimeframe(
    instrumentKey: string,
    timeframe: string
  ): Promise<HistoricalCandle[]> {
    return this.execute('find by instrument and timeframe', () =>
      prisma.historicalCandle.findMany({
        where: { instrumentKey, timeframe },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async count(where?: Prisma.HistoricalCandleWhereInput): Promise<number> {
    return this.execute('count', () => prisma.historicalCandle.count({ where }));
  }

  async deleteOlderThan(
    candleTime: Date,
    where?: Prisma.HistoricalCandleWhereInput
  ): Promise<Prisma.BatchPayload> {
    return this.execute('delete older than', () =>
      prisma.historicalCandle.deleteMany({
        where: {
          ...where,
          candleTime: {
            lt: candleTime,
          },
        },
      })
    );
  }

  async createSyncLog(
    data: Prisma.HistoricalCandleSyncLogCreateInput
  ): Promise<HistoricalCandleSyncLog> {
    return this.execute('create sync log', () => prisma.historicalCandleSyncLog.create({ data }));
  }

  async updateSyncLog(
    id: string,
    data: Prisma.HistoricalCandleSyncLogUpdateInput
  ): Promise<HistoricalCandleSyncLog> {
    return this.execute('update sync log', () =>
      prisma.historicalCandleSyncLog.update({
        where: { id },
        data,
      })
    );
  }

  private createUpsertOperation(input: HistoricalCandleUpsertInput): Prisma.Prisma__HistoricalCandleClient<HistoricalCandle> {
    const { instrumentKey, timeframe, candleTime } = input.create;

    return prisma.historicalCandle.upsert({
      where: {
        instrumentKey_timeframe_candleTime: {
          instrumentKey,
          timeframe,
          candleTime,
        },
      },
      create: input.create,
      update: input.update,
    });
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Historical candle repository Prisma request failed', {
          operation,
          code: error.code,
          meta: error.meta,
          message: error.message,
        });
      } else if (error instanceof Prisma.PrismaClientValidationError) {
        logger.error('Historical candle repository Prisma validation failed', {
          operation,
          message: error.message,
        });
      } else {
        logger.error('Historical candle repository operation failed', { operation, error });
      }

      throw error;
    }
  }
}
