import { Candle } from '../../indicators/types';
import { ExpiredOptionCandleDto } from './upstox-expired-option-candle.dto';
import { HistoricalOptionCandleCacheMetadata } from '../services/historical-option-candle-cache.service';

export interface HistoricalOptionResearchSessionRequest { instrumentKey: string; tradingDate: string; metadata?: HistoricalOptionCandleCacheMetadata; }
export interface HistoricalOptionResearchPreloadStats { underlyingRowsLoaded: number; optionSessionsLoadedFromMySql: number; optionCandlesLoadedFromMySql: number; upstoxMissingSessionDownloads: number; newlyStoredOptionCandles: number; inMemoryLookupHits: number; dbFallbackHits: number; preloadDurationMs: number; researchDurationMs: number; totalDurationMs: number; }
export interface HistoricalOptionResearchDataset { underlyingByDate: ReadonlyMap<string, readonly Candle[]>; underlyingByTimestamp: ReadonlyMap<number, Candle>; }
export type PreloadedOptionCandles = readonly ExpiredOptionCandleDto[];
