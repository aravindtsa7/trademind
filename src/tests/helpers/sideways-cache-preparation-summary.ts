export interface SidewaysCacheSession { instrumentKey: string; tradingDate: string; locallyAvailableCandleCount: number; complete: boolean; }
export interface SidewaysCachePreparationSummary { uniqueRequiredSessions: number; uniqueCompleteSessions: number; uniqueMissingSessions: number; ceOnlyMissingSessions: SidewaysCacheSession[]; peOnlyMissingSessions: SidewaysCacheSession[]; sharedDirectionalSessions: Array<SidewaysCacheSession & { directions: ('CE' | 'PE')[] }>; sharedMissingSessions: Array<SidewaysCacheSession & { directions: ('CE' | 'PE')[] }>; remoteSessionFetchesRequired: number; expectedNewCandleRows: number; allMissingSessionsHaveZeroRows: boolean; missingSessions: Array<SidewaysCacheSession & { directions: ('CE' | 'PE')[] }>; }

const key = (session: Pick<SidewaysCacheSession, 'instrumentKey' | 'tradingDate'>) => `${session.instrumentKey}|${session.tradingDate}`;

export function summarizeSidewaysCachePreparation(ceRequired: readonly Pick<SidewaysCacheSession, 'instrumentKey' | 'tradingDate'>[], peRequired: readonly Pick<SidewaysCacheSession, 'instrumentKey' | 'tradingDate'>[], inspected: readonly SidewaysCacheSession[]): SidewaysCachePreparationSummary {
  const directions = new Map<string, Set<'CE' | 'PE'>>();
  ceRequired.forEach((session) => directions.set(key(session), new Set([...(directions.get(key(session)) ?? []), 'CE'])));
  peRequired.forEach((session) => directions.set(key(session), new Set([...(directions.get(key(session)) ?? []), 'PE'])));
  const entries = inspected.filter((session) => directions.has(key(session))).map((session) => ({ ...session, directions: [...directions.get(key(session))!] as ('CE' | 'PE')[] }));
  const missing = entries.filter((session) => !session.complete);
  const shared = entries.filter((session) => session.directions.length === 2);
  return { uniqueRequiredSessions: entries.length, uniqueCompleteSessions: entries.filter((session) => session.complete).length, uniqueMissingSessions: missing.length, ceOnlyMissingSessions: missing.filter((session) => session.directions.length === 1 && session.directions[0] === 'CE'), peOnlyMissingSessions: missing.filter((session) => session.directions.length === 1 && session.directions[0] === 'PE'), sharedDirectionalSessions: shared, sharedMissingSessions: shared.filter((session) => !session.complete), remoteSessionFetchesRequired: missing.length, expectedNewCandleRows: missing.length * 375, allMissingSessionsHaveZeroRows: missing.every((session) => session.locallyAvailableCandleCount === 0), missingSessions: missing };
}
