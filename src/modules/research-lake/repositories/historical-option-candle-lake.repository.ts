import { HistoricalOptionCandle, Prisma, PrismaClient } from '@prisma/client';
import logger from '../../../core/logger/logger';
import { CanonicalHistoricalCandle } from '../domain/canonical-historical-candle';
import { HistoricalOptionType } from '../domain/historical-asset.types';

const defaultPrismaClient = new PrismaClient();

export interface HistoricalOptionCandleLakeIdentity {
  readonly providerContractId: string;
  readonly optionType: HistoricalOptionType;
  readonly strikePrice: number;
  readonly expiry: Date;
}

/**
 * Additive, research-lake-scoped persistence for B-F4 option candles.
 * Reuses the SAME `HistoricalOptionCandle` table/model the live `options`
 * module already writes (task section 6: "reuse existing infrastructure"),
 * keyed the same way (`instrumentKey`/`timeframe`/`candleTime`) -- but
 * DELIBERATELY does NOT call `HistoricalOptionCandleRepository.bulkUpsert`.
 * That method's `update` clause unconditionally rewrites
 * `tradingSymbol`/`optionType`/`strikePrice`/`expiry` from whatever the
 * newest call happens to pass, on every conflict -- safe for its own
 * Upstox-metadata-is-stable-per-run caller today, but exactly the risk task
 * section 6 flags: "Do NOT let a weaker/newer observation silently rewrite
 * historical contract identity." Modifying that shared method would risk
 * the live/operational `options` module (out of scope; CLAUDE.md forbids
 * altering operational option behavior), so this is a new, additive
 * repository instead -- the "smallest safe additive change" section 6
 * explicitly calls for.
 *
 * Identity fields (`instrumentKey`, `optionType`, `strikePrice`, `expiry`)
 * are written ONLY on first insert and are NEVER included in the `update`
 * clause on conflict -- once persisted, a later run can add/replace OHLCV/
 * OI data for the same candle minute, but can never silently rewrite what
 * contract that minute belongs to. `tradingSymbol` is left `null`: Groww's
 * discovery response never proves the real NSE exchange trading symbol
 * (see `historical-option-contract-catalog.types.ts`), so writing Groww's
 * own raw symbol into that column would misrepresent it as something
 * proven it is not.
 */
export default class HistoricalOptionCandleLakeRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  async findRange(instrumentKey: string, timeframe: string, from: Date, to: Date): Promise<HistoricalOptionCandle[]> {
    return this.execute('find range', () =>
      this.prisma.historicalOptionCandle.findMany({
        where: { instrumentKey, timeframe, candleTime: { gte: from, lte: to } },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  /**
   * Upserts a batch of already-canonicalized, already-validated candles for
   * ONE contract identity. Never called with rows this run has not already
   * run through `CanonicalSessionProjectorService`/`DatasetHealthValidatorService`
   * -- this repository trusts its caller's validation, it does not
   * re-validate OHLC/volume/OI itself (that would duplicate, not reuse, the
   * shared B-F1 validator).
   */
  async upsertCandles(identity: HistoricalOptionCandleLakeIdentity, timeframe: string, candles: readonly CanonicalHistoricalCandle[]): Promise<number> {
    if (candles.length === 0) return 0;
    return this.execute('upsert candles', async () => {
      // Batch (array) `$transaction` form -- matches
      // `HistoricalOptionCandleRepository.bulkUpsert`'s existing style
      // exactly (never the interactive-callback form, which is the only
      // overload that accepts a `timeout` option; the batch overload does
      // not).
      const results = await this.prisma.$transaction(
        candles.map((candle) =>
          this.prisma.historicalOptionCandle.upsert({
            where: {
              instrumentKey_timeframe_candleTime: {
                instrumentKey: identity.providerContractId,
                timeframe,
                candleTime: candle.candleTime,
              },
            },
            create: {
              instrumentKey: identity.providerContractId,
              tradingSymbol: null,
              optionType: identity.optionType,
              strikePrice: new Prisma.Decimal(identity.strikePrice),
              expiry: identity.expiry,
              timeframe,
              candleTime: candle.candleTime,
              open: new Prisma.Decimal(candle.open),
              high: new Prisma.Decimal(candle.high),
              low: new Prisma.Decimal(candle.low),
              close: new Prisma.Decimal(candle.close),
              volume: candle.volume,
              openInterest: candle.openInterest,
            },
            // Identity fields are deliberately absent here -- see class doc.
            update: {
              open: new Prisma.Decimal(candle.open),
              high: new Prisma.Decimal(candle.high),
              low: new Prisma.Decimal(candle.low),
              close: new Prisma.Decimal(candle.close),
              volume: candle.volume,
              openInterest: candle.openInterest,
            },
          })
        )
      );
      return results.length;
    });
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Historical option candle lake repository Prisma request failed', { operation, code: error.code, meta: error.meta, message: error.message });
      } else {
        logger.error('Historical option candle lake repository operation failed', { operation, error });
      }
      throw error;
    }
  }
}
