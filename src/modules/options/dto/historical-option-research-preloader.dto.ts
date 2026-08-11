import { Candle } from '../../indicators/types';
import { ExpiredOptionCandleDto } from './upstox-expired-option-candle.dto';
import { HistoricalOptionCandleCacheMetadata } from '../services/historical-option-candle-cache.service';

export interface HistoricalOptionResearchSessionRequest { instrumentKey: string; tradingDate: string; metadata?: HistoricalOptionCandleCacheMetadata; }
export interface HistoricalOptionResearchLocalSessionStatus { instrumentKey: string; tradingDate: string; locallyAvailableCandleCount: number; complete: boolean; }
export interface HistoricalOptionResearchLocalSessionInspection { uniqueRequiredSessions: number; completeLocalSessions: number; incompleteLocalSessions: number; missingLocalSessions: number; sessions: HistoricalOptionResearchLocalSessionStatus[]; }
export interface HistoricalOptionResearchOutOfSessionCleanup { instrumentKey: string; tradingDate: string; removedCandleTimes: Date[]; }
export interface HistoricalOptionResearchPreloadStats { underlyingRowsLoaded: number; uniqueOptionContractDateSessions: number; optionSessionsLoadedFromMySql: number; optionCandlesLoadedFromMySql: number; completeLocalSessions: number; incompleteLocalSessions: number; missingLocalSessions: number; upstoxMissingSessionDownloads: number; newlyStoredOptionCandles: number; inMemoryLookupHits: number; dbFallbackHits: number; bulkPreloadQueryCount: number; bulkPreloadDurationMs: number; preloadDurationMs: number; researchDurationMs: number; totalDurationMs: number; }
export interface HistoricalOptionResearchDataset { underlyingByDate: ReadonlyMap<string, readonly Candle[]>; underlyingByTimestamp: ReadonlyMap<number, Candle>; }
export type PreloadedOptionCandles = readonly ExpiredOptionCandleDto[];
