import axios, { AxiosInstance } from 'axios';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import logger from '../../../core/logger/logger';

const gunzipAsync = promisify(gunzip);
const instrumentMasterUrl =
  'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

interface UpstoxInstrumentMasterRecord {
  weekly?: boolean;
  segment?: string;
  exchange?: string;
  expiry?: number;
  instrument_type?: string;
  underlying_symbol?: string;
  instrument_key?: string;
  lot_size?: number;
  tick_size?: number;
  trading_symbol?: string;
  strike_price?: number;
  isin?: string;
}

export interface UpstoxInstrument {
  weekly?: boolean;
  segment?: string;
  exchange?: string;
  expiry?: number;
  instrumentType?: string;
  underlyingSymbol?: string;
  instrumentKey?: string;
  lotSize?: number;
  tickSize?: number;
  tradingSymbol?: string;
  strikePrice?: number;
  isin?: string;
}

export default class UpstoxInstrumentClient {
  private axios: AxiosInstance;

  constructor() {
    this.axios = axios.create({ timeout: 60_000 });
  }

  async fetchInstrumentMaster(): Promise<UpstoxInstrument[]> {
    try {
      logger.info('Downloading Upstox instrument master', { url: instrumentMasterUrl });

      const compressed = await this.download();
      const decompressed = await this.decompress(compressed);
      const instruments = this.parse(decompressed).map((instrument) => this.mapInstrument(instrument));

      logger.info('Upstox instrument master fetched successfully', {
        instrumentCount: instruments.length,
      });

      return instruments;
    } catch (error) {
      logger.error('Failed to fetch Upstox instrument master', { error });
      throw error;
    }
  }

  private async download(): Promise<Buffer> {
    const response = await this.axios.get<ArrayBuffer>(instrumentMasterUrl, {
      responseType: 'arraybuffer',
      decompress: false,
    });
    const compressed = Buffer.from(response.data);

    logger.info('Upstox instrument master downloaded', { bytes: compressed.length });

    return compressed;
  }

  private async decompress(compressed: Buffer): Promise<Buffer> {
    const decompressed = await gunzipAsync(compressed);

    logger.info('Upstox instrument master decompressed', { bytes: decompressed.length });

    return decompressed;
  }

  private parse(content: Buffer): UpstoxInstrumentMasterRecord[] {
    const parsed: unknown = JSON.parse(content.toString('utf8'));

    if (!Array.isArray(parsed) || !parsed.every(this.isInstrumentMasterRecord)) {
      throw new Error('Upstox instrument master response must be a JSON array of instrument records.');
    }

    logger.info('Upstox instrument master parsed', { instrumentCount: parsed.length });

    return parsed;
  }

  private mapInstrument(instrument: UpstoxInstrumentMasterRecord): UpstoxInstrument {
    return {
      weekly: instrument.weekly,
      segment: instrument.segment,
      exchange: instrument.exchange,
      expiry: instrument.expiry,
      instrumentType: instrument.instrument_type,
      underlyingSymbol: instrument.underlying_symbol,
      instrumentKey: instrument.instrument_key,
      lotSize: instrument.lot_size,
      tickSize: instrument.tick_size,
      tradingSymbol: instrument.trading_symbol,
      strikePrice: instrument.strike_price,
      isin: instrument.isin,
    };
  }

  private isInstrumentMasterRecord(value: unknown): value is UpstoxInstrumentMasterRecord {
    return typeof value === 'object' && value !== null;
  }
}
