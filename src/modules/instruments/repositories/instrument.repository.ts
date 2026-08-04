import { Instrument, InstrumentSyncLog, Prisma, PrismaClient } from '@prisma/client';
import logger from '../../../core/logger/logger';

const prisma = new PrismaClient();

export interface InstrumentBulkUpdate {
  instrumentKey: string;
  data: Prisma.InstrumentUpdateInput;
}

export default class InstrumentRepository {
  async create(data: Prisma.InstrumentCreateInput): Promise<Instrument> {
    return this.execute('create', () => prisma.instrument.create({ data }));
  }

  async update(instrumentKey: string, data: Prisma.InstrumentUpdateInput): Promise<Instrument> {
    return this.execute('update', () =>
      prisma.instrument.update({
        where: { instrumentKey },
        data,
      })
    );
  }

  async upsert(
    data: Prisma.InstrumentCreateInput,
    updateData: Prisma.InstrumentUpdateInput
  ): Promise<Instrument> {
    return this.execute('upsert', () =>
      prisma.instrument.upsert({
        where: { instrumentKey: data.instrumentKey },
        create: data,
        update: updateData,
      })
    );
  }

  async bulkCreate(data: Prisma.InstrumentCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.execute('bulk create', () => prisma.instrument.createMany({ data }));
  }

  async bulkUpdate(updates: InstrumentBulkUpdate[]): Promise<Instrument[]> {
    return this.execute('bulk update', () =>
      prisma.$transaction(
        updates.map(({ instrumentKey, data }) =>
          prisma.instrument.update({
            where: { instrumentKey },
            data,
          })
        )
      )
    );
  }

  async findByInstrumentKey(instrumentKey: string): Promise<Instrument | null> {
    return this.execute('find by instrument key', () =>
      prisma.instrument.findUnique({ where: { instrumentKey } })
    );
  }

  async findByUnderlying(underlyingSymbol: string): Promise<Instrument[]> {
    return this.execute('find by underlying', () =>
      prisma.instrument.findMany({ where: { underlyingSymbol } })
    );
  }

  async findByExpiry(expiry: Date): Promise<Instrument[]> {
    return this.execute('find by expiry', () => prisma.instrument.findMany({ where: { expiry } }));
  }

  async findActive(): Promise<Instrument[]> {
    return this.execute('find active', () => prisma.instrument.findMany({ where: { isActive: true } }));
  }

  async findAll(where?: Prisma.InstrumentWhereInput): Promise<Instrument[]> {
    return this.execute('find all', () => prisma.instrument.findMany({ where }));
  }

  async markInactive(instrumentKeys: string[]): Promise<Prisma.BatchPayload> {
    return this.execute('mark inactive', () =>
      prisma.instrument.updateMany({
        where: { instrumentKey: { in: instrumentKeys } },
        data: { isActive: false },
      })
    );
  }

  async count(where?: Prisma.InstrumentWhereInput): Promise<number> {
    return this.execute('count', () => prisma.instrument.count({ where }));
  }

  async createSyncLog(data: Prisma.InstrumentSyncLogCreateInput): Promise<InstrumentSyncLog> {
    return this.execute('create sync log', () => prisma.instrumentSyncLog.create({ data }));
  }

  async updateSyncLog(
    id: string,
    data: Prisma.InstrumentSyncLogUpdateInput
  ): Promise<InstrumentSyncLog> {
    return this.execute('update sync log', () =>
      prisma.instrumentSyncLog.update({
        where: { id },
        data,
      })
    );
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Instrument repository Prisma request failed', {
          operation,
          code: error.code,
          meta: error.meta,
          message: error.message,
        });
      } else if (error instanceof Prisma.PrismaClientValidationError) {
        logger.error('Instrument repository Prisma validation failed', {
          operation,
          message: error.message,
        });
      } else {
        logger.error('Instrument repository operation failed', { operation, error });
      }

      throw error;
    }
  }
}
