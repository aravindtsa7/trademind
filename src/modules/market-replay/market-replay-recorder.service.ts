import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { MarketReplayEventEnvelope, MarketReplayEventType, marketReplaySchemaVersion } from './market-replay.types';

/** Stable, deep key ordering makes event IDs portable across process restarts. */
export function stableReplayJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stableReplayJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).filter((key) => source[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableReplayJson(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function replayEventId(event: Omit<MarketReplayEventEnvelope, 'eventId'>): string { return createHash('sha256').update(stableReplayJson(event)).digest('hex').slice(0, 32); }

/** Append-only, best-effort recorder. It never throws into market-data handling. */
export default class MarketReplayRecorderService {
  private readonly seen = new Set<string>();
  private readonly seenContent = new Set<string>();
  constructor(private readonly path: string, private readonly runtimeId: string, private readonly sessionId: string) {
    if (existsSync(path)) readFileSync(path,'utf8').split(/\r?\n/).forEach((line)=>{try{const row=JSON.parse(line) as MarketReplayEventEnvelope;if(typeof row.eventId==='string'){this.seen.add(row.eventId);this.seenContent.add(replayContentKey(row));}}catch{/* corrupt history is reported by replay */}});
  }
  record(eventType: MarketReplayEventType, input: Omit<MarketReplayEventEnvelope, 'schemaVersion'|'eventId'|'eventType'|'runtimeId'|'sessionId'>): void {
    try { const base={schemaVersion:marketReplaySchemaVersion,eventType,instrumentKey:input.instrumentKey ?? null,sourceTimestamp:input.sourceTimestamp ?? null,receivedTimestamp:input.receivedTimestamp,sequenceNumber:input.sequenceNumber ?? null,connectionGenerationId:input.connectionGenerationId ?? null,runtimeId:this.runtimeId,sessionId:this.sessionId,payload:sanitizeReplayPayload(input.payload)}; const event={...base,eventId:replayEventId(base)} satisfies MarketReplayEventEnvelope; const contentKey=replayContentKey(event); if(this.seen.has(event.eventId)||this.seenContent.has(contentKey))return; mkdirSync(dirname(this.path),{recursive:true});appendFileSync(this.path,`${stableReplayJson(event)}\n`,'utf8');this.seen.add(event.eventId);this.seenContent.add(contentKey); } catch (error) { console.error('[MARKET_REPLAY_RECORDING_FAILED]', error instanceof Error ? error.message : 'unknown'); }
  }
}
let configuredRecorder: MarketReplayRecorderService | undefined;
let recordingSuppressionDepth = 0;
export async function withoutMarketReplayRecording<T>(operation: () => Promise<T>): Promise<T> {
  recordingSuppressionDepth += 1;
  try { return await operation(); } finally { recordingSuppressionDepth -= 1; }
}
export function recordMarketReplayEvent(eventType: MarketReplayEventType, input: Omit<MarketReplayEventEnvelope, 'schemaVersion'|'eventId'|'eventType'|'runtimeId'|'sessionId'>): void { if(recordingSuppressionDepth > 0 || process.env.MARKET_REPLAY_RECORD!=='true')return; const session=input.receivedTimestamp.slice(0,10); configuredRecorder ??= new MarketReplayRecorderService(resolve(process.cwd(),'artifacts/market-replay',session,`${process.env.MARKET_REPLAY_RUNTIME_ID ?? 'shared'}.jsonl`),process.env.MARKET_REPLAY_RUNTIME_ID ?? 'shared',session); configuredRecorder.record(eventType,input); }

function replayContentKey(event: Omit<MarketReplayEventEnvelope, 'eventId'|'receivedTimestamp'>): string {
  const { eventId: _eventId, receivedTimestamp: _receivedTimestamp, ...content } = event as MarketReplayEventEnvelope;
  return stableReplayJson(content);
}

function sanitizeReplayPayload(value: unknown, seen = new WeakSet<object>(), depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { value: sanitizeReplayValue(value) };
  if (depth > 8 || seen.has(value as object)) return { value: '[CIRCULAR_OR_DEPTH_LIMIT]' };
  seen.add(value as object);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /authorization|token|secret|password|cookie/i.test(key) ? '[REDACTED]' : sanitizeReplayValue(item, seen, depth + 1);
  }
  return output;
}

function sanitizeReplayValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, 'Bearer [REDACTED]');
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 8 || seen.has(value as object)) return '[CIRCULAR_OR_DEPTH_LIMIT]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sanitizeReplayValue(item, seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = /authorization|token|secret|password|cookie/i.test(key) ? '[REDACTED]' : sanitizeReplayValue(item, seen, depth + 1);
  return output;
}
