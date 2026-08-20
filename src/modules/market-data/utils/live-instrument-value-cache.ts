import { isCurrentLiveGeneration } from './live-generation';

export interface LiveInstrumentValue<T> {
  readonly value: T;
  readonly generationId: number;
}

/** Stores a per-instrument observation only for the active live generation. */
export function cacheCurrentLiveInstrumentValue<T>(
  cache: Map<string, LiveInstrumentValue<T>>,
  instrumentKey: string,
  value: T,
  eventGenerationId: unknown,
  activeGenerationId: unknown,
): boolean {
  if (!instrumentKey || !isCurrentLiveGeneration(eventGenerationId, activeGenerationId)) return false;
  cache.set(instrumentKey, { value, generationId: eventGenerationId });
  return true;
}

/** A reconnect makes prior values immediately unreadable, even before a new value arrives. */
export function getCurrentLiveInstrumentValue<T>(
  cache: ReadonlyMap<string, LiveInstrumentValue<T>>,
  instrumentKey: string,
  activeGenerationId: unknown,
): T | undefined {
  const cached = cache.get(instrumentKey);
  return cached && isCurrentLiveGeneration(cached.generationId, activeGenerationId)
    ? cached.value
    : undefined;
}
