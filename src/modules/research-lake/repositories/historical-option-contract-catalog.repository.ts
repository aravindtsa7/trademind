import { HistoricalOptionContractCatalog, Prisma, PrismaClient } from '@prisma/client';
import logger from '../../../core/logger/logger';
import { HistoricalContractState } from '../domain/historical-option-identity.types';
import { DiscoveredOptionContractCandidate, resolveCatalogMetadataState } from '../domain/historical-option-contract-catalog.types';

const defaultPrismaClient = new PrismaClient();

export type HistoricalOptionContractCatalogUpsertOutcome = 'INSERTED' | 'ENRICHED' | 'UNCHANGED';

export interface HistoricalOptionContractCatalogUpsertResult {
  readonly providerContractId: string;
  readonly outcome: HistoricalOptionContractCatalogUpsertOutcome;
  readonly metadataState: HistoricalContractState.CATALOG_KNOWN | HistoricalContractState.METADATA_INCOMPLETE;
}

/**
 * Merges newly-discovered evidence with an existing catalog row (if any),
 * per task section 10:
 *   - a nullable field (`exchangeTradingSymbol`/`lotSize`/`tickSize`)
 *     already non-null on the existing row is NEVER replaced -- the first
 *     proven value is authoritative; a later run's differing value (or
 *     `null`) can never downgrade or silently overwrite it.
 *   - a nullable field still `null` on the existing row IS enriched from
 *     the incoming candidate when the incoming value is non-null.
 *   - `discoveredAt` (first-discovery fact) is immutable once set.
 *   - `sourceCatalogAsOf` always advances to this run's acquisition time,
 *     recording that this row was re-confirmed, even when nothing else
 *     about it changed.
 */
function mergeCandidate(
  existing: HistoricalOptionContractCatalog | null,
  incoming: DiscoveredOptionContractCandidate
): DiscoveredOptionContractCandidate {
  if (!existing) return incoming;
  return {
    ...incoming,
    exchangeTradingSymbol: existing.exchangeTradingSymbol ?? incoming.exchangeTradingSymbol,
    lotSize: existing.lotSize ?? incoming.lotSize,
    tickSize: existing.tickSize !== null ? Number(existing.tickSize) : incoming.tickSize,
    discoveredAt: existing.discoveredAt,
  };
}

function hasMaterialChange(existing: HistoricalOptionContractCatalog, merged: DiscoveredOptionContractCandidate): boolean {
  return (
    existing.exchangeTradingSymbol !== merged.exchangeTradingSymbol ||
    existing.lotSize !== merged.lotSize ||
    (existing.tickSize === null ? merged.tickSize !== null : Number(existing.tickSize) !== merged.tickSize)
  );
}

/**
 * Persistence for the B-F3 point-in-time historical option-contract
 * catalog. Deliberately does NOT reuse `HistoricalCandleRepository`'s
 * hand-rolled atomic raw-SQL `INSERT ... ON DUPLICATE KEY UPDATE` path:
 * that exists specifically to close a cross-PROCESS race between
 * independent live/shadow writers hammering the same candle key
 * concurrently (the confirmed V2/V4 P2002 mechanism). B-F3 acquisition is
 * a single-process, offline, batch research workflow -- there is no
 * concurrent-writer race to close here, so Prisma's standard `upsert()`
 * (used per-record inside one batch transaction, matching
 * `HistoricalCandleRepository.bulkUpsert`'s batching style) is the
 * simpler, equally-correct choice for this workload.
 */
export default class HistoricalOptionContractCatalogRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  async findByProviderContractId(provider: string, providerContractId: string): Promise<HistoricalOptionContractCatalog | null> {
    return this.execute('find by provider contract id', () =>
      this.prisma.historicalOptionContractCatalog.findUnique({ where: { provider_providerContractId: { provider, providerContractId } } })
    );
  }

  async findByUnderlyingAndExpiry(underlyingSymbol: string, exchange: string, expiry: Date): Promise<HistoricalOptionContractCatalog[]> {
    return this.execute('find by underlying and expiry', () =>
      this.prisma.historicalOptionContractCatalog.findMany({
        where: { underlyingSymbol, exchange, expiry },
        orderBy: [{ strikePrice: 'asc' }, { optionType: 'asc' }, { providerContractId: 'asc' }],
      })
    );
  }

  /**
   * Idempotent bulk upsert. A rerun with identical candidates is a no-op
   * per row (`UNCHANGED`); a candidate not yet known is inserted
   * (`INSERTED`); a candidate that fills a previously-missing field on an
   * existing row is `ENRICHED`. Never deletes, never downgrades a proven
   * field to null (see `mergeCandidate`).
   */
  async upsertMany(candidates: readonly DiscoveredOptionContractCandidate[]): Promise<HistoricalOptionContractCatalogUpsertResult[]> {
    return this.execute('bulk upsert', () =>
      this.prisma.$transaction(
        async (tx) => {
          const results: HistoricalOptionContractCatalogUpsertResult[] = [];
          for (const candidate of candidates) {
            const existing = await tx.historicalOptionContractCatalog.findUnique({
              where: { provider_providerContractId: { provider: candidate.provider, providerContractId: candidate.providerContractId } },
            });
            const merged = mergeCandidate(existing, candidate);
            const metadataState = resolveCatalogMetadataState(merged);

            if (existing && !hasMaterialChange(existing, merged)) {
              await tx.historicalOptionContractCatalog.update({
                where: { id: existing.id },
                data: { sourceCatalogAsOf: candidate.discoveredAt },
              });
              results.push({ providerContractId: candidate.providerContractId, outcome: 'UNCHANGED', metadataState });
              continue;
            }

            await tx.historicalOptionContractCatalog.upsert({
              where: { provider_providerContractId: { provider: candidate.provider, providerContractId: candidate.providerContractId } },
              create: {
                provider: merged.provider,
                providerContractId: merged.providerContractId,
                underlyingSymbol: merged.underlyingSymbol,
                exchange: merged.exchange,
                expiry: merged.expiry,
                strikePrice: merged.strikePrice,
                optionType: merged.optionType,
                exchangeTradingSymbol: merged.exchangeTradingSymbol,
                lotSize: merged.lotSize,
                tickSize: merged.tickSize === null ? null : new Prisma.Decimal(merged.tickSize),
                metadataState,
                discoveredAt: merged.discoveredAt,
                sourceCatalogAsOf: candidate.discoveredAt,
              },
              update: {
                exchangeTradingSymbol: merged.exchangeTradingSymbol,
                lotSize: merged.lotSize,
                tickSize: merged.tickSize === null ? null : new Prisma.Decimal(merged.tickSize),
                metadataState,
                sourceCatalogAsOf: candidate.discoveredAt,
              },
            });
            results.push({ providerContractId: candidate.providerContractId, outcome: existing ? 'ENRICHED' : 'INSERTED', metadataState });
          }
          return results;
        },
        { timeout: 30_000 }
      )
    );
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Historical option contract catalog repository Prisma request failed', { operation, code: error.code, meta: error.meta, message: error.message });
      } else {
        logger.error('Historical option contract catalog repository operation failed', { operation, error });
      }
      throw error;
    }
  }
}
