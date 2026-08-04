import logger from '../../../core/logger/logger';
import UpstoxInstrumentClient, {
  UpstoxInstrument,
} from '../client/upstox-instrument.client';
import { InstrumentSyncSummary } from '../dto/instrument-sync-summary.dto';
import InstrumentRepository from '../repositories/instrument.repository';

const supportedUnderlyings = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
const optionInstrumentTypes = new Set(['CE', 'PE']);

interface SyncInstrumentData {
  instrumentKey: string;
  exchange: string;
  segment: string;
  underlyingSymbol: string;
  tradingSymbol: string;
  instrumentType: string;
  expiry: Date;
  strikePrice: number;
  lotSize: number;
  tickSize: number;
  weekly: boolean;
  isin?: string;
  isActive: boolean;
}

export default class InstrumentSyncService {
  private repository = new InstrumentRepository();
  private client = new UpstoxInstrumentClient();

  async sync(): Promise<InstrumentSyncSummary> {
    const startedAt = new Date();
    const syncLog = await this.repository.createSyncLog({
      startedAt,
      status: 'RUNNING',
    });

    let downloaded = 0;
    let filtered = 0;
    let inserted = 0;
    let updated = 0;
    let inactivated = 0;

    try {
      logger.info('Starting instrument sync', { syncLogId: syncLog.id });

      const instrumentMaster = await this.client.fetchInstrumentMaster();
      this.validateInstrumentMaster(instrumentMaster);
      downloaded = instrumentMaster.length;

      logger.info('Upstox instrument master validated', {
        syncLogId: syncLog.id,
        downloaded,
      });

      const supportedOptions = instrumentMaster.filter((instrument) => this.isSupportedOption(instrument));
      const instruments = supportedOptions.map((instrument) => this.toSyncInstrumentData(instrument));
      filtered = instruments.length;

      if (filtered === 0) {
        throw new Error('No supported option instruments were found in the Upstox instrument master.');
      }

      logger.info('Filtered supported option instruments', {
        syncLogId: syncLog.id,
        filtered,
      });

      const existingInstruments = await this.repository.findAll();
      const existingByInstrumentKey = new Map(
        existingInstruments.map((instrument) => [instrument.instrumentKey, instrument])
      );
      const newInstruments = instruments.filter(
        (instrument) => !existingByInstrumentKey.has(instrument.instrumentKey)
      );
      const existingUpdates = instruments
        .filter((instrument) => existingByInstrumentKey.has(instrument.instrumentKey))
        .map(({ instrumentKey, ...data }) => ({ instrumentKey, data }));

      if (newInstruments.length > 0) {
        const result = await this.repository.bulkCreate(newInstruments);
        inserted = result.count;
      }

      if (existingUpdates.length > 0) {
        await this.repository.bulkUpdate(existingUpdates);
        updated = existingUpdates.length;
      }

      const latestInstrumentKeys = new Set(instruments.map((instrument) => instrument.instrumentKey));
      const staleInstrumentKeys = existingInstruments
        .filter(
          (instrument) =>
            instrument.isActive &&
            this.isSupportedUnderlying(instrument.underlyingSymbol) &&
            this.isOptionInstrumentType(instrument.instrumentType) &&
            !latestInstrumentKeys.has(instrument.instrumentKey)
        )
        .map((instrument) => instrument.instrumentKey);

      if (staleInstrumentKeys.length > 0) {
        const result = await this.repository.markInactive(staleInstrumentKeys);
        inactivated = result.count;
      }

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const summary: InstrumentSyncSummary = {
        startedAt,
        completedAt,
        durationMs,
        downloaded,
        filtered,
        inserted,
        updated,
        inactivated,
      };

      await this.repository.updateSyncLog(syncLog.id, {
        completedAt,
        durationMs,
        downloaded,
        filtered,
        inserted,
        updated,
        inactivated,
        status: 'COMPLETED',
      });

      logger.info('Instrument sync completed', { syncLogId: syncLog.id, ...summary });

      return summary;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const errorMessage = error instanceof Error ? error.message : 'Unknown instrument sync error';

      logger.error('Instrument sync failed', {
        syncLogId: syncLog.id,
        error,
      });

      try {
        await this.repository.updateSyncLog(syncLog.id, {
          completedAt,
          durationMs,
          downloaded,
          filtered,
          inserted,
          updated,
          inactivated,
          status: 'FAILED',
          errorMessage,
        });
      } catch (logError) {
        logger.error('Failed to update instrument sync failure log', {
          syncLogId: syncLog.id,
          error: logError,
        });
      }

      throw error;
    }
  }

  private validateInstrumentMaster(instruments: UpstoxInstrument[]): void {
    if (!Array.isArray(instruments) || instruments.length === 0) {
      throw new Error('Upstox instrument master did not contain any instruments.');
    }
  }

  private isSupportedOption(instrument: UpstoxInstrument): boolean {
    return (
      this.isSupportedUnderlying(instrument.underlyingSymbol) &&
      this.isOptionInstrumentType(instrument.instrumentType)
    );
  }

  private isSupportedUnderlying(underlyingSymbol: string | undefined): boolean {
    return Boolean(underlyingSymbol && supportedUnderlyings.has(underlyingSymbol.toUpperCase()));
  }

  private isOptionInstrumentType(instrumentType: string | undefined): boolean {
    return Boolean(instrumentType && optionInstrumentTypes.has(instrumentType.toUpperCase()));
  }

  private toSyncInstrumentData(instrument: UpstoxInstrument): SyncInstrumentData {
    if (
      !instrument.instrumentKey ||
      !instrument.exchange ||
      !instrument.segment ||
      !instrument.underlyingSymbol ||
      !instrument.tradingSymbol ||
      !instrument.instrumentType ||
      !this.isValidTimestamp(instrument.expiry) ||
      !this.isValidNumber(instrument.strikePrice) ||
      !this.isValidNumber(instrument.lotSize) ||
      !this.isValidNumber(instrument.tickSize)
    ) {
      throw new Error('A supported Upstox option instrument is missing required sync data.');
    }

    return {
      instrumentKey: instrument.instrumentKey,
      exchange: instrument.exchange,
      segment: instrument.segment,
      underlyingSymbol: instrument.underlyingSymbol.toUpperCase(),
      tradingSymbol: instrument.tradingSymbol,
      instrumentType: instrument.instrumentType.toUpperCase(),
      expiry: new Date(instrument.expiry),
      strikePrice: instrument.strikePrice,
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
      weekly: instrument.weekly ?? false,
      isin: instrument.isin,
      isActive: true,
    };
  }

  private isValidTimestamp(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
  }

  private isValidNumber(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }
}
