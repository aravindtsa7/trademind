import { isCurrentLiveGeneration } from './live-generation';

/**
 * Stores a depth event only when it is proven to belong to the active live
 * connection. Intended for observational caches; executable quote handling
 * remains owned by PaperMarketDataAdapter.
 */
export function cacheCurrentLiveDepth<T extends { instrumentKey?: unknown; generationId?: unknown }>(
  cache: Map<string, T>,
  event: unknown,
  activeGenerationId: unknown,
): boolean {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as T;
  if (typeof candidate.instrumentKey !== 'string'
    || !isCurrentLiveGeneration(candidate.generationId, activeGenerationId)) return false;
  cache.set(candidate.instrumentKey, candidate);
  return true;
}

/**
 * Reads an observational depth entry only while it still belongs to the
 * connection generation that owns the live runtime.  A reconnect retires
 * previously accepted cache entries; callers must wait for a fresh depth.
 */
export function getCurrentLiveDepth<T extends { generationId?: unknown }>(
  cache: ReadonlyMap<string, T>,
  instrumentKey: string,
  activeGenerationId: unknown,
): T | undefined {
  const candidate = cache.get(instrumentKey);
  return candidate && isCurrentLiveGeneration(candidate.generationId, activeGenerationId)
    ? candidate
    : undefined;
}
