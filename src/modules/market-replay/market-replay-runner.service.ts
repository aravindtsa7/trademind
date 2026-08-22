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
    let marketEventsEncountered = 0;
    let marketEventsGenerationMismatch = 0;
    let v2Evaluations = 0, v2Signals = 0, v4Evaluations = 0, v4Signals = 0, v8Evaluations = 0, v8Signals = 0;
    let riskApprovals = 0, riskDenials = 0, paperOutcomes = 0, shadowOutcomes = 0;
    let lastReceivedMs = Number.NEGATIVE_INFINITY;

    const recovery = new MarketDataRecoveryCoordinatorService({
      backfill: options.backfill ?? (async () => ({ ready: true, reason: 'REPLAY_LOCAL_FIXTURE', missingMinutes: 0, duplicateMinutes: 0 })),
      nowMs: () => clock.now().getTime(),
      onEvent: (type, details) => output.push(`recovery:${type}:${stableReplayJson(details)}`),
    });
    recovery.on('stateChanged', (state, previousState) => output.push(`state:${previousState}:${state}:${recovery.getGenerationId()}`));
    // Mirrors the live ConnectionManager's very first 'connected' event:
    // replay has no separate "socket open" event distinct from its first
    // market event, so the initial generation is derived from that market
    // event's own recorded connectionGenerationId and receivedTimestamp --
    // never hard-coded, and never DeterministicReplayClock's default epoch 0.
    // If the artifact instead opens with a recorded DISCONNECT and/or
    // RECONNECT before any market event, seeding here would suppress that
    // recorded recovery episode: the coordinator would reject the (typically
    // generation-0) DISCONNECT as stale against a pre-seeded generation, and
    // treat the RECONNECT that follows it as already-current, silently
    // skipping backfill -- or, for a RECONNECT-first artifact (e.g. a
    // MID_SESSION_RECOVERY slice taken after its DISCONNECT), pre-seed the
    // exact generation the loop's own RECONNECT handler is about to process,
    // which then advances the generation a second time and strands every
    // following recorded-generation tick as "stale". So seeding is skipped
    // entirely whenever either event type precedes the first market event,
    // and the recorded episode is left to drive
    // handleUnexpectedDisconnect/handleReconnected exactly as it would live
    // (see the RECONNECT branch below for the DISCONNECT-less case).
    const firstMarketEventIndex = frozen.findIndex((event) => event.eventType === 'TICK' || event.eventType === 'DEPTH' || event.eventType === 'FRESH_TICK_READY');
    const recoveryEpisodeRecordedBeforeFirstMarketEvent = frozen
      .slice(0, firstMarketEventIndex === -1 ? frozen.length : firstMarketEventIndex)
      .some((event) => event.eventType === 'DISCONNECT' || event.eventType === 'RECONNECT');
    const firstMarketEvent = firstMarketEventIndex === -1 ? undefined : frozen[firstMarketEventIndex];
    // A FRESH_TICK_READY is only ever produced (recordMarketReplayEvent inside
    // MarketDataRecoveryCoordinatorService.handleLiveTick) once the coordinator is already inside
    // a recovery/readiness episode -- it is never evidence of a genuine first connection. So even
    // with no recorded DISCONNECT/RECONNECT ahead of it, a leading FRESH_TICK_READY must not
    // receive the vacuous cold-start continuity below; it drives its own synthetic recovery
    // episode in the main loop instead (see the leading-FRESH_TICK_READY branch there).
    const firstMarketEventIsLeadingFreshTickReady = !recoveryEpisodeRecordedBeforeFirstMarketEvent && firstMarketEvent?.eventType === 'FRESH_TICK_READY';
    const leadingFreshTickReadyIndex = firstMarketEventIsLeadingFreshTickReady ? firstMarketEventIndex : -1;
    if (!recoveryEpisodeRecordedBeforeFirstMarketEvent && firstMarketEvent && !firstMarketEventIsLeadingFreshTickReady) {
      if (isValidReplayGenerationId(firstMarketEvent.connectionGenerationId)) {
        recovery.handleInitialConnected({ generationId: firstMarketEvent.connectionGenerationId, connectedAt: new Date(firstMarketEvent.receivedTimestamp) });
        // Keeps the runner's own stale-generation filter (below, over `activeGeneration`) consistent with the generation just seeded into the coordinator.
        activeGeneration = firstMarketEvent.connectionGenerationId;
      } else {
        // A missing/invalid/sentinel-0 generation on the very first market event cannot seed a trusted generation.
        // Left unseeded, the coordinator never reaches READY, so this must be visible rather than reading as a valid empty session.
        warnings.push(`INVALID_REPLAY_GENERATION:${firstMarketEvent.eventType}:${firstMarketEvent.eventId}`);
      }
    }

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
      const isMarketEvent = event.eventType === 'TICK' || event.eventType === 'DEPTH' || event.eventType === 'FRESH_TICK_READY';
      if (isMarketEvent) marketEventsEncountered += 1;

      // EOD is session-scoped rather than socket-generation-scoped.
      if (event.eventType === 'EOD') {
        if (eodEvents === 0) { candles.finishSession(); recovery.stop(); eodEvents = 1; }
        else duplicateEvents += 1;
        continue;
      }

      // A leading FRESH_TICK_READY (see the pre-loop comment above) drives its own synthetic
      // recovery episode here, exactly like a leading RECONNECT, using its own recorded
      // generation as the source of truth -- never a guessed/derived one. This must run before
      // the generation-mismatch check below so that check sees the generation this event just
      // established, not the pre-loop default of 0.
      if (index === leadingFreshTickReadyIndex) {
        if (!isValidReplayGenerationId(event.connectionGenerationId)) {
          warnings.push(`INVALID_REPLAY_GENERATION:FRESH_TICK_READY:${event.eventId}`);
          output.push(`ignored:invalid-generation:${event.eventId}`);
          continue;
        }
        reconnects += 1;
        if (recovery.getState() !== 'RECONNECTING') recovery.handleUnexpectedDisconnect({});
        activeGeneration = event.connectionGenerationId;
        recovery.handleReconnected({ generationId: activeGeneration });
        await yieldToRecovery();
      }

      // Market events (TICK/DEPTH/FRESH_TICK_READY) must carry an explicitly valid recorded
      // generation before that generation is trusted for anything -- a null/undefined/fractional/
      // non-positive connectionGenerationId must never inherit generation ownership through a
      // `?? activeGeneration` fallback further down. Replay must not fabricate provenance a
      // recorded event never actually carried, the same way a null/invalid RECONNECT or leading
      // FRESH_TICK_READY generation is already rejected above rather than defaulted.
      if (isMarketEvent && !isValidReplayGenerationId(event.connectionGenerationId)) {
        marketEventsGenerationMismatch += 1;
        warnings.push(`INVALID_REPLAY_GENERATION:${event.eventType}:${event.eventId}`);
        output.push(`ignored:invalid-generation:${event.eventId}`);
        continue;
      }
      // Only once the recorded generation is proven valid can it be compared against
      // activeGeneration under the exact strict-equality contract
      // MarketDataRecoveryCoordinatorService.handleLiveTick itself enforces via
      // isCurrentLiveGeneration. A generation-ahead event (no recorded RECONNECT ever established
      // it) is just as invalid as a generation-behind one, and both must be visible -- not just the
      // coarser "less than" case the coordinator's own gate ends up rejecting silently for events
      // this runner's own filter had let through.
      if (isMarketEvent && event.connectionGenerationId !== activeGeneration) {
        marketEventsGenerationMismatch += 1;
        warnings.push(`MARKET_EVENT_GENERATION_MISMATCH:${event.eventType}:${event.eventId}:${event.connectionGenerationId}:${activeGeneration}`);
        output.push(`ignored:generation-mismatch:${event.eventId}:${event.connectionGenerationId}`);
        continue;
      }

      // Non-market, non-RECONNECT events (DISCONNECT/SUBSCRIPTION_*/CONNECTION_STATE/BACKFILL_*)
      // keep the original coarse "recorded generation behind the active one" rejection; RECONNECT
      // has its own full generation-relationship handling below, and market events are handled above.
      if (event.eventType !== 'RECONNECT' && !isMarketEvent && event.connectionGenerationId !== null && event.connectionGenerationId < activeGeneration) {
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
        if (!isValidReplayGenerationId(event.connectionGenerationId)) {
          warnings.push(`INVALID_REPLAY_GENERATION:RECONNECT:${event.eventId}`);
          output.push(`ignored:invalid-generation:${event.eventId}`);
          continue;
        }
        const recordedGeneration = event.connectionGenerationId;
        // The recorded generation is the source of truth -- never activeGeneration + 1. A real
        // recorded RECONNECT is always strictly greater than the generation it supersedes (proven
        // by ConnectionManager's own `generationId += 1` on every successful connect); anything
        // else can only come from a malformed/duplicated/corrupted artifact and must not be allowed
        // to fabricate or silently swallow generation ownership.
        if (recordedGeneration < activeGeneration) {
          warnings.push(`STALE_RECONNECT_GENERATION:${event.eventId}:${recordedGeneration}:${activeGeneration}`);
          output.push(`ignored:stale-reconnect:${event.eventId}:${recordedGeneration}`);
          continue;
        }
        if (recordedGeneration === activeGeneration) {
          warnings.push(`DUPLICATE_RECONNECT_GENERATION:${event.eventId}:${recordedGeneration}`);
          output.push(`ignored:duplicate-reconnect:${event.eventId}:${recordedGeneration}`);
          continue;
        }
        reconnects += 1;
        // A recorded RECONNECT is only ever emitted after a real disconnect
        // (ConnectionManager derives it from `wasReconnecting`), even when
        // that DISCONNECT itself is not present in this artifact -- e.g. a
        // MID_SESSION_RECOVERY slice taken after the disconnect. handleReconnected
        // only takes effect while the coordinator is RECONNECTING, so when no
        // DISCONNECT in this run has moved it there yet, synthesize that
        // transition here so this RECONNECT still starts a real recovery
        // episode (backfill included) at its own recorded generation instead
        // of being pre-empted or silently ignored.
        if (recovery.getState() !== 'RECONNECTING') recovery.handleUnexpectedDisconnect({});
        activeGeneration = recordedGeneration;
        recovery.handleReconnected({ generationId: activeGeneration });
        await yieldToRecovery();
        continue;
      }
      if (event.eventType === 'BACKFILL_STARTED' || event.eventType === 'BACKFILL_COMPLETED' || event.eventType === 'CONNECTION_STATE') continue;
      if (event.eventType === 'FRESH_TICK_READY') {
        // event.connectionGenerationId is already proven valid and === activeGeneration by the
        // validation/equality gate above -- activeGeneration is used directly rather than falling
        // back through `??`, which would let a missing generation silently inherit ownership.
        // receivedAt is this recorded event's own RECEIVE_TIME (see the loop header above); the
        // recorded sourceTimestamp is replayed verbatim rather than reusing receivedAt for it, so
        // deterministic replay never silently collapses the two clock domains into one.
        recovery.handleLiveTick({ sourceTimestamp: event.sourceTimestamp ? new Date(event.sourceTimestamp) : receivedAt, receivedAt, generationId: activeGeneration });
        continue;
      }
      if (event.eventType === 'TICK') {
        if (!event.instrumentKey || !subscriptions.has(event.instrumentKey)) {
          warnings.push(`UNSUBSCRIBED_EVENT:${event.instrumentKey ?? 'unknown'}`);
          output.push(`ignored:unsubscribed:${event.instrumentKey ?? 'unknown'}`);
          continue;
        }
        // See the FRESH_TICK_READY comment above: generation is already proven valid and current.
        recovery.handleLiveTick({ sourceTimestamp: event.sourceTimestamp ? new Date(event.sourceTimestamp) : receivedAt, receivedAt, generationId: activeGeneration });
        processor.process({
          type: 'live_feed',
          currentTs: event.sourceTimestamp ?? event.receivedTimestamp,
          feeds: { [event.instrumentKey]: { ltpc: { ltp: numberOrUndefined(event.payload.ltp) } } },
        } as never, activeGeneration);
        continue;
      }
      if (event.eventType === 'DEPTH') {
        bus.emit('market.depth', {
          instrumentKey: event.instrumentKey,
          timestamp: event.sourceTimestamp ?? event.receivedTimestamp,
          quotes: structuredClone((event.payload.quotes as unknown[] | undefined) ?? []),
          // See the FRESH_TICK_READY comment above: generation is already proven valid and current.
          generationId: activeGeneration,
        });
      }
    }

    // If every market event this artifact recorded was rejected purely for a stale/mismatched
    // generation, the result must not be indistinguishable from a genuinely quiet, valid session.
    // Counts both generation-behind and generation-ahead rejects -- either direction means this
    // artifact's market data never matched a generation this runner ever actually established.
    if (marketEventsEncountered > 0 && marketEventsGenerationMismatch === marketEventsEncountered) {
      warnings.push('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION');
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
// A live connection generation is always assigned by ConnectionManager's `generationId += 1` on
// every successful connect (including the first), so a real RECONNECT/proven-first-market-event
// generation is always a positive integer greater than the 0 "never connected" sentinel, and never
// fractional. Treating 0, a fraction, or a non-finite value as trusted here would let a
// malformed/corrupted artifact silently establish generation ownership.
function isValidReplayGenerationId(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
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
