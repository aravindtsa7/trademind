import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import TickProcessor from '../market-data/processors/tick.processor';
import LiveCandleEventAdapterService from '../market-data/services/live-candle-event-adapter.service';
import LiveCandleBuilderService from '../market-data/services/live-candle-builder.service';
import MarketDataRecoveryCoordinatorService from '../market-data/services/market-data-recovery-coordinator.service';
import { DeterministicReplayClock } from './market-replay-clock';
import { stableReplayJson, withoutMarketReplayRecording } from './market-replay-recorder.service';
import { marketReplaySchemaVersion, MarketReplayEventEnvelope, MarketReplayResult, MarketReplayStrategyOutput } from './market-replay.types';

const defaultNiftyInstrument = 'NSE_INDEX|Nifty 50';
const hash = (value: unknown): string => createHash('sha256').update(stableReplayJson(value)).digest('hex');

export interface ReplayOptions {
  /** FULL_SESSION requires an explicit local warm-up fixture; MID_SESSION_RECOVERY starts from the supplied event checkpoint. */
  initialState?: { mode: 'FULL_SESSION' | 'MID_SESSION_RECOVERY'; warmupFixture?: () => Promise<void> | void };
  /** Backfill fixture; it must be local and deterministic. */
  backfill?: () => Promise<{ ready: boolean; reason: string; missingMinutes: number; duplicateMinutes: number }>;
  /** Injects an existing strategy adapter; no simplified strategy is reimplemented here. */
  onReadyEvaluation?: (event: Readonly<MarketReplayEventEnvelope>) => MarketReplayStrategyOutput | void;
  initialSubscriptions?: readonly string[];
}

/**
 * Zero-network bridge through production TickProcessor, LiveCandleEventAdapter
 * and MarketDataRecoveryCoordinatorService. It intentionally owns no broker,
 * REST, or WebSocket client.
 */
export default class MarketReplayRunnerService {
  private lastOutputTrace: readonly string[] = [];

  async run(events: readonly MarketReplayEventEnvelope[], options: ReplayOptions = {}): Promise<MarketReplayResult> {
    return withoutMarketReplayRecording(() => this.runInternal(events, options));
  }

  private async runInternal(events: readonly MarketReplayEventEnvelope[], options: ReplayOptions = {}): Promise<MarketReplayResult> {
    const frozen = events.map((event) => deepFreeze(structuredClone(event)));
    this.validate(frozen);
    if (options.initialState?.mode === 'FULL_SESSION' && !options.initialState.warmupFixture) {
      throw new Error('FULL_SESSION replay requires an explicit local warm-up fixture.');
    }
    await options.initialState?.warmupFixture?.();

    const clock = new DeterministicReplayClock();
    const bus = new EventEmitter();
    const processor = new TickProcessor(bus);
    const candles = new LiveCandleEventAdapterService(new LiveCandleBuilderService(), bus);
    const output: string[] = [];
    const warnings: string[] = [];
    const eventCounts: Record<string, number> = {};
    const candleCounts: Record<string, number> = {};
    const subscriptions = new Set(options.initialSubscriptions ?? [defaultNiftyInstrument]);
    const seenMarketEventKeys = new Set<string>();
    let activeGeneration = 0;
    let duplicateEvents = 0;
    let outOfOrderEvents = 0;
    let reconnects = 0;
    let eodEvents = 0;
    let v2Evaluations = 0, v2Signals = 0, v4Evaluations = 0, v4Signals = 0, v8Evaluations = 0, v8Signals = 0;
    let riskApprovals = 0, riskDenials = 0, paperOutcomes = 0, shadowOutcomes = 0;
    let lastReceivedMs = Number.NEGATIVE_INFINITY;

    const recovery = new MarketDataRecoveryCoordinatorService({
      backfill: options.backfill ?? (async () => ({ ready: true, reason: 'REPLAY_LOCAL_FIXTURE', missingMinutes: 0, duplicateMinutes: 0 })),
      nowMs: () => clock.now().getTime(),
      onEvent: (type, details) => output.push(`recovery:${type}:${stableReplayJson(details)}`),
    });
    recovery.on('stateChanged', (state, previousState) => output.push(`state:${previousState}:${state}:${recovery.getGenerationId()}`));

    const acceptStrategyOutput = (value: MarketReplayStrategyOutput | void): void => {
      if (!value) return;
      if (value.subscriptionIntent) subscriptions.add(value.subscriptionIntent);
      const evaluations = value.evaluated ?? 0;
      const signals = value.signals ?? 0;
      if (value.strategy === 'V2') { v2Evaluations += evaluations; v2Signals += signals; }
      if (value.strategy === 'V4') { v4Evaluations += evaluations; v4Signals += signals; }
      if (value.strategy === 'V8') { v8Evaluations += evaluations; v8Signals += signals; }
      if (value.riskDecision === 'APPROVED') riskApprovals += 1;
      if (value.riskDecision === 'DENIED') riskDenials += 1;
      if (value.paperOutcome) paperOutcomes += 1;
      if (value.shadowOutcome) shadowOutcomes += 1;
      if (value.portfolioDigest) output.push(`portfolio:${value.portfolioDigest}`);
      if (value.paperFill) output.push(`fill:${stableReplayJson(value.paperFill)}`);
      output.push(`strategy:${stableReplayJson(value)}`);
    };

    candles.start();
    bus.on('market.candle.completed', (candle: { instrumentKey: string; timeframe: string; candleTime: Date; close: number }) => {
      candleCounts[candle.timeframe] = (candleCounts[candle.timeframe] ?? 0) + 1;
      output.push(`candle:${candle.instrumentKey}:${candle.timeframe}:${candle.candleTime.toISOString()}:${candle.close}`);
    });
    bus.on('market.tick', (tick: { instrumentKey: string; timestamp?: string; generationId?: number }) => {
      if (!recovery.isEvaluationReady()) return;
      acceptStrategyOutput(options.onReadyEvaluation?.(deepFreeze({
        schemaVersion: marketReplaySchemaVersion,
        eventId: `derived:${tick.instrumentKey}:${tick.timestamp ?? clock.now().toISOString()}`,
        eventType: 'TICK',
        instrumentKey: tick.instrumentKey,
        sourceTimestamp: tick.timestamp ?? null,
        receivedTimestamp: clock.now().toISOString(),
        sequenceNumber: null,
        connectionGenerationId: tick.generationId ?? null,
        runtimeId: 'replay',
        sessionId: 'replay',
        payload: { generationId: tick.generationId ?? null },
      })));
    });

    for (let index = 0; index < frozen.length; index += 1) {
      const event = frozen[index];
      const receivedAt = new Date(event.receivedTimestamp);
      if (receivedAt.getTime() < lastReceivedMs) {
        outOfOrderEvents += 1;
        output.push(`ignored:out-of-order:${index}:${event.eventId}`);
        continue;
      }
      lastReceivedMs = receivedAt.getTime();
      clock.advanceTo(receivedAt);
      eventCounts[event.eventType] = (eventCounts[event.eventType] ?? 0) + 1;
      output.push(`event:${index}:${event.eventId}:${event.eventType}`);

      const marketKey = `${event.eventType}|${event.instrumentKey ?? ''}|${event.sourceTimestamp ?? ''}|${stableReplayJson(event.payload)}`;
      if ((event.eventType === 'TICK' || event.eventType === 'DEPTH') && seenMarketEventKeys.has(marketKey)) {
        duplicateEvents += 1;
        output.push(`ignored:duplicate:${event.eventId}`);
        continue;
      }
      seenMarketEventKeys.add(marketKey);

      // EOD is session-scoped rather than socket-generation-scoped.
      if (event.eventType === 'EOD') {
        if (eodEvents === 0) { candles.finishSession(); recovery.stop(); eodEvents = 1; }
        else duplicateEvents += 1;
        continue;
      }

      if (event.connectionGenerationId !== null && event.connectionGenerationId < activeGeneration) {
        output.push(`ignored:stale-generation:${event.eventId}:${event.connectionGenerationId}`);
        continue;
      }

      if (event.eventType === 'SUBSCRIPTION_INTENT' || event.eventType === 'SUBSCRIPTION_RESTORED') {
        if (event.instrumentKey) {
          if (subscriptions.has(event.instrumentKey)) duplicateEvents += 1;
          subscriptions.add(event.instrumentKey);
        }
        continue;
      }
      if (event.eventType === 'DISCONNECT') {
        recovery.handleUnexpectedDisconnect({ generationId: event.connectionGenerationId ?? undefined, code: numberOrUndefined(event.payload.code) });
        continue;
      }
      if (event.eventType === 'RECONNECT') {
        reconnects += 1;
        activeGeneration = Math.max(activeGeneration + 1, event.connectionGenerationId ?? 0);
        recovery.handleReconnected({ generationId: activeGeneration });
        await yieldToRecovery();
        continue;
      }
      if (event.eventType === 'BACKFILL_STARTED' || event.eventType === 'BACKFILL_COMPLETED' || event.eventType === 'CONNECTION_STATE') continue;
      if (event.eventType === 'FRESH_TICK_READY') {
        recovery.handleLiveTick(receivedAt, event.connectionGenerationId ?? activeGeneration);
        continue;
      }
      if (event.eventType === 'TICK') {
        if (!event.instrumentKey || !subscriptions.has(event.instrumentKey)) {
          warnings.push(`UNSUBSCRIBED_EVENT:${event.instrumentKey ?? 'unknown'}`);
          output.push(`ignored:unsubscribed:${event.instrumentKey ?? 'unknown'}`);
          continue;
        }
        const generationId = event.connectionGenerationId ?? activeGeneration;
        recovery.handleLiveTick(receivedAt, generationId);
        processor.process({
          type: 'live_feed',
          currentTs: event.sourceTimestamp ?? event.receivedTimestamp,
          feeds: { [event.instrumentKey]: { ltpc: { ltp: numberOrUndefined(event.payload.ltp) } } },
        } as never, generationId);
        continue;
      }
      if (event.eventType === 'DEPTH') {
        bus.emit('market.depth', {
          instrumentKey: event.instrumentKey,
          timestamp: event.sourceTimestamp ?? event.receivedTimestamp,
          quotes: structuredClone((event.payload.quotes as unknown[] | undefined) ?? []),
          generationId: event.connectionGenerationId ?? activeGeneration,
        });
      }
    }

    candles.finishSession();
    const result: MarketReplayResult = {
      sourceFingerprint: hash(frozen), eventCounts, candleCounts, duplicateEvents, outOfOrderEvents,
      v2Evaluations, v2Signals, v4Evaluations, v4Signals, v8Evaluations, v8Signals,
      riskApprovals, riskDenials, paperOutcomes, shadowOutcomes, reconnects, eodEvents,
      outputDigest: hash(output), dataQualityWarnings: [...new Set(warnings)].sort(),
    };
    this.lastOutputTrace = Object.freeze([...output]);
    return result;
  }

  /** Ephemeral trace for golden verification; it is intentionally not written into compact result artifacts. */
  getLastOutputTrace(): readonly string[] { return [...this.lastOutputTrace]; }

  findFirstDivergence(expected: readonly string[], actual: readonly string[]): MarketReplayResult['firstDivergence'] | undefined {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (expected[index] !== actual[index]) return { eventIndex: index, component: traceComponent(expected[index] ?? actual[index] ?? 'unknown'), expected: expected[index] ?? '[END]', actual: actual[index] ?? '[END]' };
    }
    return undefined;
  }

  load(path: string): readonly MarketReplayEventEnvelope[] {
    try { return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as MarketReplayEventEnvelope); }
    catch (error) { throw new Error(`Replay artifact cannot be loaded: ${error instanceof Error ? error.message : 'unknown'}`); }
  }

  writeResult(session: string, result: MarketReplayResult): string {
    const directory = resolve(process.cwd(), 'artifacts/market-replay-results');
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `${session}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2));
    return path;
  }

  private validate(events: readonly MarketReplayEventEnvelope[]): void {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.schemaVersion !== marketReplaySchemaVersion) throw new Error(`Unsupported replay schema version ${event.schemaVersion}.`);
      if (!event.eventId || ids.has(event.eventId)) throw new Error('Replay artifact contains duplicate or missing eventId.');
      if (!isReplayEventType(event.eventType)) throw new Error(`Replay artifact contains unsupported event type ${String(event.eventType)}.`);
      ids.add(event.eventId);
      if (Number.isNaN(new Date(event.receivedTimestamp).getTime())) throw new Error('Replay artifact contains invalid receivedTimestamp.');
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function yieldToRecovery(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
function isReplayEventType(value: unknown): boolean { return typeof value === 'string' && ['TICK','DEPTH','CONNECTION_STATE','DISCONNECT','RECONNECT','SUBSCRIPTION_RESTORED','SUBSCRIPTION_INTENT','BACKFILL_STARTED','BACKFILL_COMPLETED','FRESH_TICK_READY','EOD'].includes(value); }
function traceComponent(trace: string): string { return trace.split(':', 1)[0] || 'unknown'; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach((entry) => deepFreeze(entry));
  }
  return value;
}
