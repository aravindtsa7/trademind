/**
 * Live event consumers must never infer a connection generation.  An event is
 * current only when it carries a finite generation identifier that exactly
 * matches the generation currently owned by the live connection.
 */
export function isCurrentLiveGeneration(
  eventGenerationId: unknown,
  activeGenerationId: unknown,
): eventGenerationId is number {
  return typeof eventGenerationId === 'number'
    && Number.isFinite(eventGenerationId)
    && typeof activeGenerationId === 'number'
    && Number.isFinite(activeGenerationId)
    && eventGenerationId === activeGenerationId;
}
