import { isCurrentLiveGeneration } from './live-generation';

/**
 * Owns the generation boundary for a group of live-only caches.  The first
 * accepted event from a new generation clears the whole group synchronously,
 * before the event can read or merge any prior-generation state.
 */
export class LiveGenerationCacheScope {
  private generationId: number | undefined;

  accept(
    eventGenerationId: unknown,
    activeGenerationId: unknown,
    clearPreviousGeneration: () => void,
  ): eventGenerationId is number {
    if (!isCurrentLiveGeneration(eventGenerationId, activeGenerationId)) return false;
    if (this.generationId !== eventGenerationId) {
      clearPreviousGeneration();
      this.generationId = eventGenerationId;
    }
    return true;
  }

  getGenerationId(): number | undefined {
    return this.generationId;
  }
}
